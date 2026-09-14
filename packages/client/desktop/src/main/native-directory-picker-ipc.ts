import type { BrowserWindow, Dialog, IpcMain } from "electron";
import {
    INSTALLATION_ROOT_PICK_CHANNEL,
    PROJECT_ROOT_PICK_CHANNEL,
    parseProjectRootPickerSuggestedPath,
    SOURCE_ROOT_PICK_CHANNEL,
} from "../bridge/desktop-bridge";
import type { DesktopMessageId } from "../presentation/localization";
import type { UtilityHostSupervisor } from "./utility-host-supervisor";

export interface NativeDirectoryPickerIpcDependencies {
    readonly ipcMain: Pick<IpcMain, "handle">;
    readonly dialog: Pick<Dialog, "showOpenDialog">;
    readonly supervisor: Pick<UtilityHostSupervisor, "registerLocalPathSelection" | "state">;
    readonly getPrimaryWindow: () => BrowserWindow | null;
    readonly text: (messageId: DesktopMessageId) => string;
}

const PICKERS = Object.freeze([
    {
        channel: PROJECT_ROOT_PICK_CHANNEL,
        selectionKind: "project_root" as const,
        title: "catalog.ui.picker.choose_title" as const,
        button: "catalog.ui.picker.choose_button" as const,
        unavailable: "OAAM project-folder selection is unavailable",
        acceptsSuggestedPath: true,
    },
    {
        channel: SOURCE_ROOT_PICK_CHANNEL,
        selectionKind: "source_root" as const,
        title: "discovery.ui.picker.choose_source_title" as const,
        button: "discovery.ui.picker.choose_source_button" as const,
        unavailable: "OAAM source-folder selection is unavailable",
        acceptsSuggestedPath: false,
    },
    {
        channel: INSTALLATION_ROOT_PICK_CHANNEL,
        selectionKind: "installation_root" as const,
        title: "catalog.ui.target.installation_picker_title" as const,
        button: "catalog.ui.target.installation_picker_button" as const,
        unavailable: "OAAM installation-folder selection is unavailable",
        acceptsSuggestedPath: false,
    },
]);

export function registerNativeDirectoryPickerIpc(dependencies: NativeDirectoryPickerIpcDependencies): void {
    for (const picker of PICKERS) {
        dependencies.ipcMain.handle(picker.channel, async (event, suggestedPath: unknown) => {
            const mainWindow = dependencies.getPrimaryWindow();
            if (mainWindow === null || event.sender !== mainWindow.webContents || dependencies.supervisor.state !== "ready") {
                throw new Error(picker.unavailable);
            }
            const defaultPath = picker.acceptsSuggestedPath ? parseProjectRootPickerSuggestedPath(suggestedPath) : undefined;
            const result = await dependencies.dialog.showOpenDialog(mainWindow, {
                title: dependencies.text(picker.title),
                buttonLabel: dependencies.text(picker.button),
                ...(defaultPath === undefined ? {} : { defaultPath }),
                properties: ["openDirectory"],
            });
            const rootPath = result.filePaths.length === 1 ? result.filePaths[0] : undefined;
            if (result.canceled || rootPath === undefined) return Object.freeze({ status: "cancelled" });
            const localPathSelectionToken = await dependencies.supervisor.registerLocalPathSelection(
                picker.selectionKind,
                rootPath,
            );
            return Object.freeze({ status: "selected", displayPath: rootPath, localPathSelectionToken });
        });
    }
}
