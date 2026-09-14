import type { IpcMain, WebContents } from "electron";
import {
    OBSERVED_PROJECT_ROOT_AUTHORIZE_CHANNEL,
    OBSERVED_PROJECT_ROOT_REVEAL_CHANNEL,
    type ObservedProjectRootAuthorizationResult,
    type ObservedProjectRootRevealResult,
    parseDesktopObservedProjectRootReference,
} from "../bridge/desktop-bridge";
import type { UtilityHostSupervisor } from "./utility-host-supervisor";

export interface ObservedProjectRootIpcDependencies {
    readonly ipcMain: Pick<IpcMain, "handle">;
    readonly supervisor: Pick<UtilityHostSupervisor, "state" | "resolveObservedProjectRoot">;
    readonly authorizedSender: () => WebContents | undefined;
    readonly openPath: (rootPath: string) => Promise<string>;
}

export function registerObservedProjectRootIpc(dependencies: ObservedProjectRootIpcDependencies): void {
    dependencies.ipcMain.handle(
        OBSERVED_PROJECT_ROOT_AUTHORIZE_CHANNEL,
        async (event, untrustedReference: unknown): Promise<ObservedProjectRootAuthorizationResult> => {
            const authorizedSender = dependencies.authorizedSender();
            if (
                authorizedSender === undefined ||
                event.sender !== authorizedSender ||
                dependencies.supervisor.state !== "ready"
            ) {
                return Object.freeze({ status: "failed", code: "unavailable" });
            }
            try {
                const reference = parseDesktopObservedProjectRootReference(untrustedReference);
                const resolved = await dependencies.supervisor.resolveObservedProjectRoot("registration", reference);
                if (resolved.purpose !== "registration") throw new Error("Observed Project root purpose changed");
                return Object.freeze({
                    status: "authorized",
                    displayPath: resolved.rootPath,
                    localPathSelectionToken: resolved.localPathSelectionToken,
                });
            } catch {
                return Object.freeze({ status: "failed", code: "unavailable" });
            }
        },
    );

    dependencies.ipcMain.handle(
        OBSERVED_PROJECT_ROOT_REVEAL_CHANNEL,
        async (event, untrustedReference: unknown): Promise<ObservedProjectRootRevealResult> => {
            const authorizedSender = dependencies.authorizedSender();
            if (
                authorizedSender === undefined ||
                event.sender !== authorizedSender ||
                dependencies.supervisor.state !== "ready"
            ) {
                return Object.freeze({ status: "failed", code: "unavailable" });
            }
            try {
                const reference = parseDesktopObservedProjectRootReference(untrustedReference);
                const resolved = await dependencies.supervisor.resolveObservedProjectRoot("reveal", reference);
                if (resolved.purpose !== "reveal") throw new Error("Observed Project root purpose changed");
                const error = await dependencies.openPath(resolved.rootPath);
                return error === ""
                    ? Object.freeze({ status: "complete" })
                    : Object.freeze({ status: "failed", code: "open_failed" });
            } catch {
                return Object.freeze({ status: "failed", code: "unavailable" });
            }
        },
    );
}
