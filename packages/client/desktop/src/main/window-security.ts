import type { BrowserWindowConstructorOptions, Session, WebContents } from "electron";
import {
    DEFAULT_DESKTOP_WINDOW_HEIGHT,
    DEFAULT_DESKTOP_WINDOW_WIDTH,
    MINIMUM_DESKTOP_WINDOW_HEIGHT,
    MINIMUM_DESKTOP_WINDOW_WIDTH,
} from "./window-state-store";

export type DesktopWindowPlatform = "win32" | "darwin" | "linux";

export interface DesktopWindowAppearanceTarget {
    setBackgroundColor(color: string): void;
    setTitleBarOverlay(options: { readonly color: string; readonly symbolColor: string; readonly height: number }): void;
}

const DESKTOP_WINDOW_PALETTES = Object.freeze({
    light: Object.freeze({
        backgroundColor: "#f6f4f1",
        titleBarColor: "#eeebe6",
        symbolColor: "#24211d",
    }),
    dark: Object.freeze({
        backgroundColor: "#1c1b19",
        titleBarColor: "#23211f",
        symbolColor: "#f2eee8",
    }),
});

export const DESKTOP_WINDOW_CHROME_HEIGHT = 38;

export function createDesktopWindowOptions(
    preloadPath: string,
    colorScheme: "light" | "dark",
    platform: DesktopWindowPlatform,
): BrowserWindowConstructorOptions {
    const palette = DESKTOP_WINDOW_PALETTES[colorScheme];
    return {
        width: DEFAULT_DESKTOP_WINDOW_WIDTH,
        height: DEFAULT_DESKTOP_WINDOW_HEIGHT,
        useContentSize: true,
        minWidth: MINIMUM_DESKTOP_WINDOW_WIDTH,
        minHeight: MINIMUM_DESKTOP_WINDOW_HEIGHT,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: palette.backgroundColor,
        ...(platform === "win32"
            ? {
                  titleBarStyle: "hidden" as const,
                  titleBarOverlay: {
                      color: palette.titleBarColor,
                      symbolColor: palette.symbolColor,
                      height: DESKTOP_WINDOW_CHROME_HEIGHT,
                  },
              }
            : {}),
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webviewTag: false,
            navigateOnDragDrop: false,
            spellcheck: false,
        },
    };
}

export function applyDesktopWindowAppearance(
    window: DesktopWindowAppearanceTarget,
    colorScheme: "light" | "dark",
    platform: DesktopWindowPlatform,
): void {
    const palette = DESKTOP_WINDOW_PALETTES[colorScheme];
    window.setBackgroundColor(palette.backgroundColor);
    if (platform === "win32") {
        window.setTitleBarOverlay({
            color: palette.titleBarColor,
            symbolColor: palette.symbolColor,
            height: DESKTOP_WINDOW_CHROME_HEIGHT,
        });
    }
}

export function lockDesktopNavigation(webContents: WebContents, entryUrl: string): void {
    webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    webContents.on("will-navigate", (event, targetUrl) => {
        if (targetUrl !== entryUrl) event.preventDefault();
    });
}

export function lockDesktopPermissions(session: Session): void {
    session.setPermissionCheckHandler(() => false);
    session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}
