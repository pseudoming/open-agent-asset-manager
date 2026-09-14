import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopWindowActionDependencies, installDesktopRendererRecovery } from "../src/main/desktop-renderer-recovery";

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function windowFixture() {
    let gone: ((event: unknown, details: { readonly reason: string }) => void) | undefined;
    const webContents = {
        on: vi.fn((event: string, listener: typeof gone) => {
            if (event === "render-process-gone") gone = listener;
        }),
        off: vi.fn(),
        reloadIgnoringCache: vi.fn(),
    };
    const window = { isDestroyed: vi.fn(() => false), webContents };
    return { window, webContents, dispatchGone: (reason: string) => gone?.({}, { reason }) };
}

const text = (messageId: string): string => messageId;

describe("Desktop renderer-process recovery", () => {
    it("offers one main-owned reload after an abnormal renderer exit", async () => {
        const fixture = windowFixture();
        const showMessageBox = vi.fn(async () => ({ response: 0 }));
        const requestQuit = vi.fn();
        const recordRendererDiagnostic = vi.fn();
        installDesktopRendererRecovery(fixture.window as never, { showMessageBox } as never, {
            isCurrentWindow: () => true,
            recordRendererDiagnostic,
            requestQuit,
            text,
        });

        fixture.dispatchGone("crashed");
        await vi.waitFor(() => expect(fixture.webContents.reloadIgnoringCache).toHaveBeenCalledOnce());
        expect(showMessageBox).toHaveBeenCalledOnce();
        expect(recordRendererDiagnostic).toHaveBeenCalledWith({
            event: "process_gone",
            failureKind: "process_gone",
            surface: "unknown",
            componentTrail: [],
        });
        expect(requestQuit).not.toHaveBeenCalled();
    });

    it("ignores clean or stale exits and never stacks recovery prompts", async () => {
        const fixture = windowFixture();
        let resolvePrompt: ((value: { readonly response: number }) => void) | undefined;
        const showMessageBox = vi.fn(() => new Promise<{ readonly response: number }>((resolve) => (resolvePrompt = resolve)));
        let current = true;
        const requestQuit = vi.fn();
        const dispose = installDesktopRendererRecovery(fixture.window as never, { showMessageBox } as never, {
            isCurrentWindow: () => current,
            recordRendererDiagnostic: vi.fn(),
            requestQuit,
            text,
        });

        fixture.dispatchGone("clean-exit");
        current = false;
        fixture.dispatchGone("crashed");
        current = true;
        fixture.dispatchGone("crashed");
        fixture.dispatchGone("oom");
        expect(showMessageBox).toHaveBeenCalledOnce();
        resolvePrompt?.({ response: 1 });
        await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledOnce());
        dispose();
        expect(fixture.webContents.off).toHaveBeenCalledOnce();
    });

    it("schedules a reload only for the exact live primary window", () => {
        vi.useFakeTimers();
        const fixture = windowFixture();
        const dependencies = createDesktopWindowActionDependencies(
            () => fixture.window as never,
            () => true,
            vi.fn(),
        );
        dependencies.reloadInterface();
        expect(fixture.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
        vi.runAllTimers();
        expect(fixture.webContents.reloadIgnoringCache).toHaveBeenCalledOnce();

        const unavailable = createDesktopWindowActionDependencies(
            () => null,
            () => true,
            vi.fn(),
        );
        expect(() => unavailable.reloadInterface()).toThrow(/primary window is unavailable/u);
        const hidden = createDesktopWindowActionDependencies(
            () => fixture.window as never,
            () => false,
            vi.fn(),
        );
        expect(() => hidden.hideToTray()).toThrow(/primary window is unavailable/u);
    });

    it("keeps a rejected native prompt bounded and permits a later exact prompt", async () => {
        const fixture = windowFixture();
        const showMessageBox = vi.fn().mockRejectedValueOnce(new Error("native dialog unavailable"));
        installDesktopRendererRecovery(fixture.window as never, { showMessageBox } as never, {
            isCurrentWindow: () => true,
            recordRendererDiagnostic: vi.fn(),
            requestQuit: vi.fn(),
            text,
        });

        fixture.dispatchGone("crashed");
        await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce());
        await new Promise((resolve) => setTimeout(resolve, 0));
        showMessageBox.mockResolvedValueOnce({ response: 0 });
        fixture.dispatchGone("oom");
        await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledTimes(2));
    });
});
