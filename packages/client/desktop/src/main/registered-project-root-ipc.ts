import type { IpcMain, WebContents } from "electron";
import {
    parseDesktopRegisteredProjectId,
    REGISTERED_PROJECT_ROOT_AUTHORIZE_CHANNEL,
    REGISTERED_PROJECT_ROOT_REVEAL_CHANNEL,
    type RegisteredProjectRootAuthorizationResult,
    type RegisteredProjectRootRevealResult,
} from "../bridge/desktop-bridge";
import { registerObservedProjectRootIpc } from "./observed-project-root-ipc";
import type { UtilityHostSupervisor } from "./utility-host-supervisor";

export interface RegisteredProjectRootIpcDependencies {
    readonly ipcMain: Pick<IpcMain, "handle">;
    readonly supervisor: Pick<UtilityHostSupervisor, "state" | "resolveRegisteredProjectRoot">;
    readonly authorizedSender: () => WebContents | undefined;
    readonly openPath: (rootPath: string) => Promise<string>;
}

export interface ProjectRootIpcDependencies {
    readonly ipcMain: Pick<IpcMain, "handle">;
    readonly supervisor: Pick<UtilityHostSupervisor, "state" | "resolveObservedProjectRoot" | "resolveRegisteredProjectRoot">;
    readonly authorizedSender: () => WebContents | undefined;
    readonly openPath: (rootPath: string) => Promise<string>;
}

export function registerProjectRootIpc(dependencies: ProjectRootIpcDependencies): void {
    registerObservedProjectRootIpc(dependencies);
    registerRegisteredProjectRootIpc(dependencies);
}

export function registerRegisteredProjectRootIpc(dependencies: RegisteredProjectRootIpcDependencies): void {
    dependencies.ipcMain.handle(
        REGISTERED_PROJECT_ROOT_AUTHORIZE_CHANNEL,
        async (event, untrustedProjectId: unknown): Promise<RegisteredProjectRootAuthorizationResult> => {
            const authorizedSender = dependencies.authorizedSender();
            if (
                authorizedSender === undefined ||
                event.sender !== authorizedSender ||
                dependencies.supervisor.state !== "ready"
            ) {
                return Object.freeze({ status: "failed", code: "unavailable" });
            }
            try {
                const projectId = parseDesktopRegisteredProjectId(untrustedProjectId);
                const resolved = await dependencies.supervisor.resolveRegisteredProjectRoot("probe", projectId);
                if (resolved.purpose !== "probe") throw new Error("Registered Project root purpose changed");
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
        REGISTERED_PROJECT_ROOT_REVEAL_CHANNEL,
        async (event, untrustedProjectId: unknown): Promise<RegisteredProjectRootRevealResult> => {
            const authorizedSender = dependencies.authorizedSender();
            if (
                authorizedSender === undefined ||
                event.sender !== authorizedSender ||
                dependencies.supervisor.state !== "ready"
            ) {
                return Object.freeze({ status: "failed", code: "unavailable" });
            }
            try {
                const projectId = parseDesktopRegisteredProjectId(untrustedProjectId);
                const resolved = await dependencies.supervisor.resolveRegisteredProjectRoot("reveal", projectId);
                if (resolved.purpose !== "reveal") throw new Error("Registered Project root purpose changed");
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
