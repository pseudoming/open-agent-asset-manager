import { describe, expect, it, vi } from "vitest";
import {
    applyDesktopWindowAppearance,
    createDesktopWindowOptions,
    DESKTOP_WINDOW_CHROME_HEIGHT,
    lockDesktopNavigation,
    lockDesktopPermissions,
} from "../src/main/window-security";

describe("Desktop BrowserWindow security", () => {
    it("uses the reviewed isolated and sandboxed BrowserWindow defaults", () => {
        expect(createDesktopWindowOptions("/app/preload.js", "light", "linux")).toMatchObject({
            show: false,
            autoHideMenuBar: true,
            backgroundColor: "#f6f4f1",
            webPreferences: {
                preload: "/app/preload.js",
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                webviewTag: false,
                navigateOnDragDrop: false,
                spellcheck: false,
            },
        });
        expect(createDesktopWindowOptions("/app/preload.js", "dark", "linux").backgroundColor).toBe("#1c1b19");
    });

    it("uses the native Windows control overlay without disabling the native frame", () => {
        expect(createDesktopWindowOptions("/app/preload.js", "light", "win32")).toMatchObject({
            titleBarStyle: "hidden",
            titleBarOverlay: {
                color: "#eeebe6",
                symbolColor: "#24211d",
                height: DESKTOP_WINDOW_CHROME_HEIGHT,
            },
        });
        expect(createDesktopWindowOptions("/app/preload.js", "light", "win32")).not.toHaveProperty("frame", false);
        expect(createDesktopWindowOptions("/app/preload.js", "light", "darwin")).not.toHaveProperty("titleBarOverlay");
    });

    it("updates both the page background and Windows overlay colors without recreating the window", () => {
        const window = {
            setBackgroundColor: vi.fn(),
            setTitleBarOverlay: vi.fn(),
        };
        applyDesktopWindowAppearance(window, "dark", "win32");
        expect(window.setBackgroundColor).toHaveBeenCalledWith("#1c1b19");
        expect(window.setTitleBarOverlay).toHaveBeenCalledWith({
            color: "#23211f",
            symbolColor: "#f2eee8",
            height: DESKTOP_WINDOW_CHROME_HEIGHT,
        });

        window.setBackgroundColor.mockClear();
        window.setTitleBarOverlay.mockClear();
        applyDesktopWindowAppearance(window, "light", "linux");
        expect(window.setBackgroundColor).toHaveBeenCalledWith("#f6f4f1");
        expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
    });

    it("denies popup creation and prevents navigation away from the packaged entry", () => {
        let navigate: ((event: { preventDefault(): void }, url: string) => void) | undefined;
        const webContents = {
            setWindowOpenHandler: vi.fn(),
            on: vi.fn((_event: string, listener: (event: { preventDefault(): void }, url: string) => void) => {
                navigate = listener;
            }),
        };
        lockDesktopNavigation(webContents as never, "file:///app/index.html");
        expect(webContents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: "deny" });
        const allowed = { preventDefault: vi.fn() };
        navigate?.(allowed, "file:///app/index.html");
        expect(allowed.preventDefault).not.toHaveBeenCalled();
        const forbidden = { preventDefault: vi.fn() };
        navigate?.(forbidden, "https://example.com/");
        expect(forbidden.preventDefault).toHaveBeenCalledOnce();
    });

    it("denies renderer permission checks and requests by default", () => {
        let check: (() => boolean) | undefined;
        let request: ((_webContents: unknown, _permission: string, callback: (allowed: boolean) => void) => void) | undefined;
        const session = {
            setPermissionCheckHandler: vi.fn((handler: () => boolean) => {
                check = handler;
            }),
            setPermissionRequestHandler: vi.fn(
                (handler: (_webContents: unknown, _permission: string, callback: (allowed: boolean) => void) => void) => {
                    request = handler;
                },
            ),
        };
        lockDesktopPermissions(session as never);
        expect(check?.()).toBe(false);
        const callback = vi.fn();
        request?.({}, "media", callback);
        expect(callback).toHaveBeenCalledWith(false);
    });
});
