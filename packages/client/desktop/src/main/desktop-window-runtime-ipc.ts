import type { BrowserWindow, IpcMain } from "electron";
import { parseDesktopWindowAction, WINDOW_ACTION_CHANNEL } from "../bridge/desktop-bridge";
import { parseDesktopRendererDiagnosticInput, RENDERER_DIAGNOSTIC_CHANNEL } from "../bridge/desktop-renderer-diagnostics";
import type { UtilityHostSupervisor } from "./utility-host-supervisor";
import { type DesktopWindowActionDependencies, performDesktopWindowAction } from "./window-actions";

export function registerDesktopWindowRuntimeIpc(input: {
    readonly ipcMain: Pick<IpcMain, "handle">;
    readonly getPrimaryWindow: () => BrowserWindow | null;
    readonly windowActionDependencies: () => DesktopWindowActionDependencies;
    readonly supervisor: Pick<UtilityHostSupervisor, "recordRendererDiagnostic">;
}): void {
    input.ipcMain.handle(WINDOW_ACTION_CHANNEL, async (event, value: unknown) => {
        const window = input.getPrimaryWindow();
        if (window === null || event.sender !== window.webContents) {
            throw new Error("OAAM Desktop window action is unavailable");
        }
        await performDesktopWindowAction(window, parseDesktopWindowAction(value), input.windowActionDependencies());
    });
    input.ipcMain.handle(RENDERER_DIAGNOSTIC_CHANNEL, (event, value: unknown) => {
        const window = input.getPrimaryWindow();
        if (window === null || event.sender !== window.webContents) {
            throw new Error("OAAM Desktop Renderer diagnostic route is unavailable");
        }
        input.supervisor.recordRendererDiagnostic(parseDesktopRendererDiagnosticInput(value));
    });
}
