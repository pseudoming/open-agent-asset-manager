import type { BrowserWindow, Dialog, IpcMain } from "electron";
import {
    ASSET_VERSION_EXPORT_PICK_CHANNEL,
    type AssetVersionExportPickerResult,
    parseAssetVersionExportKind,
    parseAssetVersionExportSuggestedFileName,
} from "../bridge/desktop-bridge";
import type { DesktopMessageId } from "../presentation/localization";
import type { UtilityHostSupervisor } from "./utility-host-supervisor";

export interface AssetVersionExportIpcDependencies {
    readonly ipcMain: Pick<IpcMain, "handle">;
    readonly dialog: Pick<Dialog, "showSaveDialog">;
    readonly supervisor: Pick<UtilityHostSupervisor, "registerLocalPathSelection" | "state">;
    readonly getPrimaryWindow: () => BrowserWindow | null;
    readonly text: (messageId: DesktopMessageId) => string;
}

export function registerAssetVersionExportIpc(dependencies: AssetVersionExportIpcDependencies): void {
    dependencies.ipcMain.handle(
        ASSET_VERSION_EXPORT_PICK_CHANNEL,
        async (event, exportKindValue: unknown, suggestedFileName: unknown): Promise<AssetVersionExportPickerResult> => {
            const window = dependencies.getPrimaryWindow();
            if (window === null || event.sender !== window.webContents || dependencies.supervisor.state !== "ready") {
                throw new Error("OAAM Asset Version export selection is unavailable");
            }
            const exportKind = parseAssetVersionExportKind(exportKindValue);
            const result = await dependencies.dialog.showSaveDialog(window, {
                title: dependencies.text(
                    exportKind === "native_files" ? "library.native_export.choose_title" : "library.export.choose_title",
                ),
                buttonLabel: dependencies.text(
                    exportKind === "native_files" ? "library.native_export.choose_button" : "library.export.choose_button",
                ),
                defaultPath: parseAssetVersionExportSuggestedFileName(suggestedFileName),
                filters: [{ name: "ZIP", extensions: ["zip"] }],
            });
            if (result.canceled || result.filePath === undefined) return Object.freeze({ status: "cancelled" });
            const localPathSelectionToken = await dependencies.supervisor.registerLocalPathSelection(
                exportKind === "native_files" ? "asset_native_export_file" : "asset_export_file",
                result.filePath,
            );
            return Object.freeze({
                status: "selected",
                displayPath: result.filePath,
                localPathSelectionToken,
            });
        },
    );
}
