import type { IpcMain, WebContents } from "electron";
import {
    IMPORT_PREVIEW_FILE_REVEAL_CHANNEL,
    type ImportPreviewFileRevealResult,
    parseDesktopImportPreviewFileReference,
} from "../bridge/desktop-bridge";
import type { UtilityHostSupervisor } from "./utility-host-supervisor";

export interface ImportPreviewFileIpcDependencies {
    readonly ipcMain: Pick<IpcMain, "handle">;
    readonly supervisor: Pick<UtilityHostSupervisor, "state" | "resolveImportPreviewFileDirectory">;
    readonly authorizedSender: () => WebContents | undefined;
    readonly openPath: (directoryPath: string) => Promise<string>;
}

export function registerImportPreviewFileIpc(dependencies: ImportPreviewFileIpcDependencies): void {
    dependencies.ipcMain.handle(
        IMPORT_PREVIEW_FILE_REVEAL_CHANNEL,
        async (event, untrustedReference: unknown): Promise<ImportPreviewFileRevealResult> => {
            const authorizedSender = dependencies.authorizedSender();
            if (
                authorizedSender === undefined ||
                event.sender !== authorizedSender ||
                dependencies.supervisor.state !== "ready"
            ) {
                return Object.freeze({ status: "failed", code: "unavailable" });
            }
            try {
                const reference = parseDesktopImportPreviewFileReference(untrustedReference);
                const directoryPath = await dependencies.supervisor.resolveImportPreviewFileDirectory(reference);
                const error = await dependencies.openPath(directoryPath);
                return error === ""
                    ? Object.freeze({ status: "complete" })
                    : Object.freeze({ status: "failed", code: "open_failed" });
            } catch {
                return Object.freeze({ status: "failed", code: "unavailable" });
            }
        },
    );
}
