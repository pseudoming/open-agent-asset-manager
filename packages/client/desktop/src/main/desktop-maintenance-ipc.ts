import type { BrowserWindow, IpcMain } from "electron";
import {
    DESKTOP_DATA_LOCATION_ACTION_CHANNEL,
    DESKTOP_INTERFACE_CACHE_CLEAR_CHANNEL,
    DESKTOP_INTERFACE_DEFAULTS_RESTORE_CHANNEL,
    DESKTOP_MAINTENANCE_GET_CHANNEL,
    parseDesktopDataLocationAction,
    parseDesktopDataLocationId,
} from "../bridge/desktop-bridge";
import {
    clearDesktopInterfaceCache,
    inspectDesktopMaintenance,
    performDesktopDataLocationAction,
    restoreDesktopInterfaceDefaults,
    type DesktopDataLocationActions,
} from "./desktop-maintenance";

export interface DesktopMaintenanceIpcDependencies {
    readonly ipcMain: Pick<IpcMain, "handle">;
    readonly getPrimaryWindow: () => BrowserWindow | null;
    readonly oaamDataRoot: string;
    readonly desktopProfileRoot: string;
    readonly dataLocationActions: DesktopDataLocationActions;
    readonly restorePresentationDefaults: () => void;
    readonly restoreWindowDefaults: (window: BrowserWindow) => void;
}

function requirePrimaryWindow(
    dependencies: DesktopMaintenanceIpcDependencies,
    sender: Electron.WebContents,
    operation: string,
): BrowserWindow {
    const window = dependencies.getPrimaryWindow();
    if (window === null || sender !== window.webContents) {
        throw new Error(`OAAM Desktop ${operation} is unavailable`);
    }
    return window;
}

export function registerDesktopMaintenanceIpc(dependencies: DesktopMaintenanceIpcDependencies): void {
    dependencies.ipcMain.handle(DESKTOP_MAINTENANCE_GET_CHANNEL, async (event) => {
        const window = requirePrimaryWindow(dependencies, event.sender, "maintenance snapshot");
        return inspectDesktopMaintenance(window.webContents.session, {
            oaamDataRoot: dependencies.oaamDataRoot,
            desktopProfileRoot: dependencies.desktopProfileRoot,
        });
    });

    dependencies.ipcMain.handle(DESKTOP_INTERFACE_CACHE_CLEAR_CHANNEL, async (event) => {
        const window = requirePrimaryWindow(dependencies, event.sender, "interface-cache action");
        return clearDesktopInterfaceCache(window.webContents.session);
    });

    dependencies.ipcMain.handle(
        DESKTOP_DATA_LOCATION_ACTION_CHANNEL,
        async (event, requestedLocation: unknown, requestedAction: unknown) => {
            const window = requirePrimaryWindow(dependencies, event.sender, "data-location action");
            return performDesktopDataLocationAction(
                {
                    oaamDataRoot: dependencies.oaamDataRoot,
                    desktopProfileRoot: dependencies.desktopProfileRoot,
                    interfaceCacheRoot: window.webContents.session.storagePath,
                },
                parseDesktopDataLocationId(requestedLocation),
                parseDesktopDataLocationAction(requestedAction),
                dependencies.dataLocationActions,
            );
        },
    );

    dependencies.ipcMain.handle(DESKTOP_INTERFACE_DEFAULTS_RESTORE_CHANNEL, (event) => {
        const window = requirePrimaryWindow(dependencies, event.sender, "interface-default action");
        return restoreDesktopInterfaceDefaults({
            restoreWindowState: () => dependencies.restoreWindowDefaults(window),
            restorePresentation: dependencies.restorePresentationDefaults,
        });
    });
}
