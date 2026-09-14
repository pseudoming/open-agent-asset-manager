import { describe, expect, it, vi } from "vitest";
import {
    type DesktopSingleInstanceApp,
    DesktopSingleInstanceAuthority,
    type DesktopSingleInstanceWindow,
} from "../src/main/single-instance";

function appFixture(acquired: boolean): {
    readonly app: DesktopSingleInstanceApp;
    readonly requestSingleInstanceLock: ReturnType<typeof vi.fn>;
    readonly quit: ReturnType<typeof vi.fn>;
    secondInstance(): void;
} {
    let listener: (() => void) | undefined;
    const requestSingleInstanceLock = vi.fn(() => acquired);
    const quit = vi.fn();
    return {
        app: {
            requestSingleInstanceLock,
            quit,
            on(_event, nextListener) {
                listener = nextListener;
            },
        },
        requestSingleInstanceLock,
        quit,
        secondInstance() {
            listener?.();
        },
    };
}

function windowFixture(options: { readonly minimized?: boolean; readonly visible?: boolean } = {}): {
    readonly window: DesktopSingleInstanceWindow;
    readonly restore: ReturnType<typeof vi.fn>;
    readonly show: ReturnType<typeof vi.fn>;
    readonly hide: ReturnType<typeof vi.fn>;
    readonly focus: ReturnType<typeof vi.fn>;
} {
    const restore = vi.fn();
    const show = vi.fn();
    const hide = vi.fn();
    const focus = vi.fn();
    return {
        window: {
            isMinimized: () => options.minimized ?? false,
            restore,
            isVisible: () => options.visible ?? true,
            show,
            hide,
            focus,
        },
        restore,
        show,
        hide,
        focus,
    };
}

describe("Desktop single-instance authority", () => {
    it("quits a competing process before registering primary-process behavior", () => {
        const fixture = appFixture(false);
        const secondInstance = vi.fn();
        const authority = new DesktopSingleInstanceAuthority(fixture.app, secondInstance);

        expect(authority.acquire()).toBe(false);
        expect(fixture.requestSingleInstanceLock).toHaveBeenCalledOnce();
        expect(fixture.quit).toHaveBeenCalledOnce();
        fixture.secondInstance();
        expect(secondInstance).not.toHaveBeenCalled();
    });

    it("restores, shows and focuses the primary window for a competing launch", () => {
        const fixture = appFixture(true);
        const secondInstance = vi.fn();
        const authority = new DesktopSingleInstanceAuthority(fixture.app, secondInstance);
        const primary = windowFixture({ minimized: true, visible: false });

        expect(authority.acquire()).toBe(true);
        authority.attachWindow(primary.window);
        fixture.secondInstance();

        expect(secondInstance).toHaveBeenCalledOnce();
        expect(primary.restore).toHaveBeenCalledOnce();
        expect(primary.show).toHaveBeenCalledOnce();
        expect(primary.focus).toHaveBeenCalledOnce();
        expect(primary.focus.mock.invocationCallOrder[0]).toBeLessThan(secondInstance.mock.invocationCallOrder[0] ?? 0);
        expect(fixture.quit).not.toHaveBeenCalled();
    });

    it("delivers an early competing-launch focus request after the primary window exists", () => {
        const fixture = appFixture(true);
        const primaryFocused = vi.fn();
        const authority = new DesktopSingleInstanceAuthority(fixture.app, primaryFocused);
        const primary = windowFixture();

        expect(authority.acquire()).toBe(true);
        fixture.secondInstance();
        expect(primary.focus).not.toHaveBeenCalled();
        expect(primaryFocused).not.toHaveBeenCalled();
        authority.attachWindow(primary.window);
        expect(primary.focus).toHaveBeenCalledOnce();
        expect(primaryFocused).toHaveBeenCalledOnce();

        authority.detachWindow(primary.window);
        fixture.secondInstance();
        const replacement = windowFixture();
        authority.attachWindow(replacement.window);
        expect(replacement.focus).toHaveBeenCalledOnce();
        expect(primaryFocused).toHaveBeenCalledTimes(2);
    });

    it("rejects acquiring the process authority twice", () => {
        const fixture = appFixture(true);
        const authority = new DesktopSingleInstanceAuthority(fixture.app, vi.fn());
        expect(authority.acquire()).toBe(true);
        expect(() => authority.acquire()).toThrow(/only once/u);
    });

    it("does not detach the current window when a stale window closes", () => {
        const fixture = appFixture(true);
        const authority = new DesktopSingleInstanceAuthority(fixture.app, vi.fn());
        const primary = windowFixture();
        const stale = windowFixture();
        expect(authority.acquire()).toBe(true);
        authority.attachWindow(primary.window);
        authority.detachWindow(stale.window);
        fixture.secondInstance();
        expect(primary.focus).toHaveBeenCalledOnce();
    });

    it("shows and focuses the existing primary window without reporting a competing launch", () => {
        const fixture = appFixture(true);
        const competingLaunch = vi.fn();
        const authority = new DesktopSingleInstanceAuthority(fixture.app, competingLaunch);
        const primary = windowFixture({ minimized: true, visible: false });
        expect(authority.showPrimaryWindow()).toBe(false);
        expect(authority.acquire()).toBe(true);
        authority.attachWindow(primary.window);

        expect(authority.showPrimaryWindow()).toBe(true);
        expect(primary.restore).toHaveBeenCalledOnce();
        expect(primary.show).toHaveBeenCalledOnce();
        expect(primary.focus).toHaveBeenCalledOnce();
        expect(competingLaunch).not.toHaveBeenCalled();
    });

    it("hides only an attached primary window that is currently visible", () => {
        const fixture = appFixture(true);
        const authority = new DesktopSingleInstanceAuthority(fixture.app, vi.fn());
        const primary = windowFixture({ visible: true });
        expect(authority.hidePrimaryWindow()).toBe(false);
        expect(authority.acquire()).toBe(true);
        authority.attachWindow(primary.window);

        expect(authority.hidePrimaryWindow()).toBe(true);
        expect(primary.hide).toHaveBeenCalledOnce();
        authority.detachWindow(primary.window);
        expect(authority.hidePrimaryWindow()).toBe(false);

        const hidden = windowFixture({ visible: false });
        authority.attachWindow(hidden.window);
        expect(authority.hidePrimaryWindow()).toBe(false);
        expect(hidden.hide).not.toHaveBeenCalled();
    });
});
