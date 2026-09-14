import type { BrowserWindow, Dialog, IpcMain } from "electron";
import type { DesktopPerformanceRecordingAuthority } from "./performance-recording";
import { registerDesktopDiagnosticsIpc } from "./desktop-diagnostics-ipc";

export interface DesktopDiagnosticsRuntimeDependencies {
    readonly ipcMain: Pick<IpcMain, "handle">;
    readonly dialog: Pick<Dialog, "showSaveDialog">;
    readonly getPrimaryWindow: () => BrowserWindow | null;
    readonly hostIsReady: () => boolean;
    readonly performanceRecording: DesktopPerformanceRecordingAuthority;
    readonly registerSupportBundleExportPath: (filePath: string) => Promise<string>;
    readonly text: (messageId: DesktopDiagnosticsDialogMessageId) => string;
    readonly now?: () => Date;
}

export type DesktopDiagnosticsDialogMessageId =
    | "diagnostics.support.export.choose_title"
    | "diagnostics.support.export.choose_button"
    | "diagnostics.performance.save.choose_title"
    | "diagnostics.performance.save.choose_button";

export function installDesktopDiagnosticsRuntime(dependencies: DesktopDiagnosticsRuntimeDependencies): () => void {
    return registerDesktopDiagnosticsIpc({
        ipcMain: dependencies.ipcMain,
        getPrimaryWindow: dependencies.getPrimaryWindow,
        hostIsReady: dependencies.hostIsReady,
        performanceRecording: dependencies.performanceRecording,
        async pickSupportBundleExportPath(window, suggestedFileName) {
            const result = await dependencies.dialog.showSaveDialog(window, {
                title: dependencies.text("diagnostics.support.export.choose_title"),
                buttonLabel: dependencies.text("diagnostics.support.export.choose_button"),
                defaultPath: suggestedFileName,
                filters: [{ name: "ZIP", extensions: ["zip"] }],
            });
            return result.canceled ? undefined : result.filePath;
        },
        registerSupportBundleExportPath: dependencies.registerSupportBundleExportPath,
        async pickPerformanceRecordingExportPath(window) {
            const timestamp = (dependencies.now?.() ?? new Date()).toISOString().replaceAll(":", "-");
            const result = await dependencies.dialog.showSaveDialog(window, {
                title: dependencies.text("diagnostics.performance.save.choose_title"),
                buttonLabel: dependencies.text("diagnostics.performance.save.choose_button"),
                defaultPath: `oaam-performance-trace-${timestamp}.json`,
                filters: [{ name: "JSON", extensions: ["json"] }],
            });
            return result.canceled ? undefined : result.filePath;
        },
    });
}
