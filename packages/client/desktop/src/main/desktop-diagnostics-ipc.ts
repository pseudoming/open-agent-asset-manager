import type { BrowserWindow, IpcMain } from "electron";
import {
    DESKTOP_PERFORMANCE_RECORDING_CHANGED_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_DISCARD_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_GET_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_SAVE_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_START_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_STOP_CHANNEL,
    parseDesktopSensitiveCaptureConfirmation,
    parseSupportBundleExportSuggestedFileName,
    SUPPORT_BUNDLE_EXPORT_PICK_CHANNEL,
    type SupportBundleExportPickerResult,
} from "../bridge/desktop-bridge";
import type { DesktopPerformanceRecordingAuthority } from "./performance-recording";

export interface DesktopDiagnosticsIpcDependencies {
    readonly ipcMain: Pick<IpcMain, "handle">;
    readonly getPrimaryWindow: () => BrowserWindow | null;
    readonly hostIsReady: () => boolean;
    readonly performanceRecording: DesktopPerformanceRecordingAuthority;
    readonly pickSupportBundleExportPath: (window: BrowserWindow, suggestedFileName: string) => Promise<string | undefined>;
    readonly registerSupportBundleExportPath: (filePath: string) => Promise<string>;
    readonly pickPerformanceRecordingExportPath: (window: BrowserWindow) => Promise<string | undefined>;
}

function requirePrimaryWindow(
    dependencies: DesktopDiagnosticsIpcDependencies,
    sender: Electron.WebContents,
    operation: string,
): BrowserWindow {
    const window = dependencies.getPrimaryWindow();
    if (window === null || sender !== window.webContents) {
        throw new Error(`OAAM Desktop ${operation} is unavailable`);
    }
    return window;
}

export function registerDesktopDiagnosticsIpc(dependencies: DesktopDiagnosticsIpcDependencies): () => void {
    const unsubscribe = dependencies.performanceRecording.subscribe((snapshot) => {
        dependencies.getPrimaryWindow()?.webContents.send(DESKTOP_PERFORMANCE_RECORDING_CHANGED_CHANNEL, snapshot);
    });

    dependencies.ipcMain.handle(SUPPORT_BUNDLE_EXPORT_PICK_CHANNEL, async (event, requestedFileName: unknown) => {
        const window = requirePrimaryWindow(dependencies, event.sender, "support-bundle export selection");
        if (!dependencies.hostIsReady()) throw new Error("OAAM Desktop support-bundle export selection is unavailable");
        const suggestedFileName = parseSupportBundleExportSuggestedFileName(requestedFileName);
        const filePath = await dependencies.pickSupportBundleExportPath(window, suggestedFileName);
        if (filePath === undefined) return Object.freeze({ status: "cancelled" }) satisfies SupportBundleExportPickerResult;
        const localPathSelectionToken = await dependencies.registerSupportBundleExportPath(filePath);
        return Object.freeze({
            status: "selected",
            displayPath: filePath,
            localPathSelectionToken,
        }) satisfies SupportBundleExportPickerResult;
    });

    dependencies.ipcMain.handle(DESKTOP_PERFORMANCE_RECORDING_GET_CHANNEL, (event) => {
        requirePrimaryWindow(dependencies, event.sender, "performance-recording snapshot");
        return dependencies.performanceRecording.snapshot;
    });

    dependencies.ipcMain.handle(DESKTOP_PERFORMANCE_RECORDING_START_CHANNEL, (event, confirmation: unknown) => {
        requirePrimaryWindow(dependencies, event.sender, "performance-recording start");
        parseDesktopSensitiveCaptureConfirmation(confirmation);
        return dependencies.performanceRecording.start();
    });

    dependencies.ipcMain.handle(DESKTOP_PERFORMANCE_RECORDING_STOP_CHANNEL, (event) => {
        requirePrimaryWindow(dependencies, event.sender, "performance-recording stop");
        return dependencies.performanceRecording.stop();
    });

    dependencies.ipcMain.handle(DESKTOP_PERFORMANCE_RECORDING_SAVE_CHANNEL, async (event) => {
        const window = requirePrimaryWindow(dependencies, event.sender, "performance-recording save");
        const destinationPath = await dependencies.pickPerformanceRecordingExportPath(window);
        if (destinationPath === undefined) return Object.freeze({ status: "cancelled" as const });
        return dependencies.performanceRecording.saveTo(destinationPath);
    });

    dependencies.ipcMain.handle(DESKTOP_PERFORMANCE_RECORDING_DISCARD_CHANNEL, (event) => {
        requirePrimaryWindow(dependencies, event.sender, "performance-recording discard");
        return dependencies.performanceRecording.discard();
    });

    return unsubscribe;
}
