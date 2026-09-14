import type { DesktopWindowAction } from "../bridge/desktop-bridge";

const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 2;
const ZOOM_STEP = 0.1;

export interface DesktopWindowActionWebContents {
    undo(): void;
    redo(): void;
    cut(): void;
    copy(): void;
    paste(): void;
    delete(): void;
    selectAll(): void;
    getZoomFactor(): number;
    setZoomFactor(factor: number): void;
}

export interface DesktopWindowActionTarget {
    readonly webContents: DesktopWindowActionWebContents;
    isFullScreen(): boolean;
    setFullScreen(fullScreen: boolean): void;
}

export interface DesktopWindowActionDependencies {
    requestQuit(): void;
    hideToTray(): void;
    reloadInterface(): void;
}

export interface DesktopWindowShortcutInput {
    readonly type: string;
    readonly key: string;
    readonly control: boolean;
    readonly meta: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
}

function nextZoomFactor(current: number, direction: -1 | 1): number {
    if (!Number.isFinite(current)) throw new Error("Desktop window reported a non-finite zoom factor");
    const stepped = Math.round((current + direction * ZOOM_STEP) * 10) / 10;
    return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, stepped));
}

export function desktopWindowActionFromShortcut(
    input: DesktopWindowShortcutInput,
    platform: "win32" | "darwin" | "linux",
): DesktopWindowAction | undefined {
    if (input.type !== "keyDown" || input.alt) return undefined;
    if (input.key === "F11" && !input.control && !input.meta && !input.shift) return "toggle_full_screen";
    const primaryModifier = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
    if (!primaryModifier) return undefined;
    const key = input.key.toLowerCase();
    if (key === "z") return input.shift ? "redo" : "undo";
    if (key === "y" && !input.shift) return "redo";
    if (input.shift && key !== "+" && key !== "=") return undefined;
    switch (key) {
        case "x":
            return "cut";
        case "c":
            return "copy";
        case "v":
            return "paste";
        case "a":
            return "select_all";
        case "+":
        case "=":
            return "zoom_in";
        case "-":
            return "zoom_out";
        case "0":
            return "zoom_reset";
        default:
            return undefined;
    }
}

export async function performDesktopWindowAction(
    target: DesktopWindowActionTarget,
    action: DesktopWindowAction,
    dependencies: DesktopWindowActionDependencies,
): Promise<void> {
    switch (action) {
        case "quit":
            dependencies.requestQuit();
            return;
        case "hide_to_tray":
            dependencies.hideToTray();
            return;
        case "reload_interface":
            dependencies.reloadInterface();
            return;
        case "undo":
            target.webContents.undo();
            return;
        case "redo":
            target.webContents.redo();
            return;
        case "cut":
            target.webContents.cut();
            return;
        case "copy":
            target.webContents.copy();
            return;
        case "paste":
            target.webContents.paste();
            return;
        case "delete":
            target.webContents.delete();
            return;
        case "select_all":
            target.webContents.selectAll();
            return;
        case "zoom_in":
            target.webContents.setZoomFactor(nextZoomFactor(target.webContents.getZoomFactor(), 1));
            return;
        case "zoom_out":
            target.webContents.setZoomFactor(nextZoomFactor(target.webContents.getZoomFactor(), -1));
            return;
        case "zoom_reset":
            target.webContents.setZoomFactor(1);
            return;
        case "toggle_full_screen": {
            target.setFullScreen(!target.isFullScreen());
            return;
        }
    }
}
