import { describe, expect, it, vi } from "vitest";
import { WINDOW_ACTION_CHANNEL } from "../src/bridge/desktop-bridge";
import { RENDERER_DIAGNOSTIC_CHANNEL } from "../src/bridge/desktop-renderer-diagnostics";
import { registerDesktopWindowRuntimeIpc } from "../src/main/desktop-window-runtime-ipc";

describe("Desktop window runtime IPC", () => {
    it("binds exact-window actions and privacy-bounded Renderer receipts", async () => {
        const handlers = new Map<string, (event: { readonly sender: unknown }, value: unknown) => unknown>();
        const ipcMain = {
            handle: vi.fn((channel: string, handler: (event: { readonly sender: unknown }, value: unknown) => unknown) => {
                handlers.set(channel, handler);
            }),
        };
        const webContents = { undo: vi.fn() };
        const window = { webContents };
        const recordRendererDiagnostic = vi.fn();
        registerDesktopWindowRuntimeIpc({
            ipcMain: ipcMain as never,
            getPrimaryWindow: () => window as never,
            windowActionDependencies: () => ({
                requestQuit: vi.fn(),
                hideToTray: vi.fn(),
                reloadInterface: vi.fn(),
            }),
            supervisor: { recordRendererDiagnostic },
        });

        await handlers.get(WINDOW_ACTION_CHANNEL)?.({ sender: webContents }, "undo");
        expect(webContents.undo).toHaveBeenCalledOnce();
        const receipt = {
            event: "failure",
            failureKind: "render",
            surface: "library",
            componentTrail: ["AssetVersionPanel"],
        } as const;
        handlers.get(RENDERER_DIAGNOSTIC_CHANNEL)?.({ sender: webContents }, receipt);
        expect(recordRendererDiagnostic).toHaveBeenCalledWith(receipt);

        await expect(handlers.get(WINDOW_ACTION_CHANNEL)?.({ sender: {} }, "undo")).rejects.toThrow(/unavailable/u);
        expect(() =>
            handlers.get(RENDERER_DIAGNOSTIC_CHANNEL)?.({ sender: webContents }, { ...receipt, message: "private" }),
        ).toThrow();
    });
});
