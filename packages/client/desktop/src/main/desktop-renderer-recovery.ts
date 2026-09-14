import type { BrowserWindow, Dialog } from "electron";
import type { DesktopRendererDiagnosticInput } from "../bridge/desktop-renderer-diagnostics";
import type { DesktopWindowActionDependencies } from "./window-actions";

type RendererRecoveryTextId = "renderer.failure.action" | "renderer.failure.copy" | "renderer.failure.title" | "tray.quit";

interface DesktopRendererRecoveryDependencies {
    readonly isCurrentWindow: () => boolean;
    readonly recordRendererDiagnostic: (input: DesktopRendererDiagnosticInput) => void;
    readonly requestQuit: () => void;
    readonly text: (messageId: RendererRecoveryTextId) => string;
}

interface RenderProcessGoneDetails {
    readonly reason: string;
}

export function createDesktopWindowActionDependencies(
    getPrimaryWindow: () => BrowserWindow | null,
    hidePrimaryWindow: () => boolean,
    requestQuit: () => void,
): DesktopWindowActionDependencies {
    return {
        requestQuit,
        hideToTray() {
            if (!hidePrimaryWindow()) throw new Error("OAAM Desktop primary window is unavailable");
        },
        reloadInterface() {
            const window = getPrimaryWindow();
            if (window === null || window.isDestroyed()) throw new Error("OAAM Desktop primary window is unavailable");
            setImmediate(() => {
                if (!window.isDestroyed()) window.webContents.reloadIgnoringCache();
            });
        },
    };
}

export function installDesktopRendererRecovery(
    window: BrowserWindow,
    dialog: Pick<Dialog, "showMessageBox">,
    dependencies: DesktopRendererRecoveryDependencies,
): () => void {
    let promptActive = false;
    const renderProcessGone = (_event: unknown, details: RenderProcessGoneDetails): void => {
        if (details.reason === "clean-exit" || promptActive || !dependencies.isCurrentWindow() || window.isDestroyed()) return;
        promptActive = true;
        try {
            dependencies.recordRendererDiagnostic(
                Object.freeze({ event: "process_gone", failureKind: "process_gone", surface: "unknown", componentTrail: [] }),
            );
        } catch {
            // A diagnostic receipt cannot block the main-owned recovery surface.
        }
        void dialog
            .showMessageBox(window, {
                type: "error",
                title: dependencies.text("renderer.failure.title"),
                message: dependencies.text("renderer.failure.title"),
                detail: dependencies.text("renderer.failure.copy"),
                buttons: [dependencies.text("renderer.failure.action"), dependencies.text("tray.quit")],
                defaultId: 0,
                cancelId: 1,
                noLink: true,
            })
            .then(({ response }) => {
                if (!dependencies.isCurrentWindow() || window.isDestroyed()) return;
                if (response === 0) window.webContents.reloadIgnoringCache();
                else dependencies.requestQuit();
            })
            .catch(() => undefined)
            .finally(() => {
                promptActive = false;
            });
    };
    window.webContents.on("render-process-gone", renderProcessGone);
    return () => window.webContents.off("render-process-gone", renderProcessGone);
}
