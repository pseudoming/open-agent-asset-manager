import type { BrowserWindow, Dialog, IpcMain, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { ASSET_VERSION_EXPORT_PICK_CHANNEL } from "../src/bridge/desktop-bridge";
import { registerAssetVersionExportIpc } from "../src/main/asset-version-export-ipc";
import type { UtilityHostSupervisor } from "../src/main/utility-host-supervisor";

type Handler = (event: { readonly sender: WebContents }, exportKind?: unknown, suggestedFileName?: unknown) => Promise<unknown>;

function fixture() {
    const handlers = new Map<string, Handler>();
    const sender = {} as WebContents;
    const window = { webContents: sender } as BrowserWindow;
    const showSaveDialog = vi.fn();
    const registerLocalPathSelection = vi.fn(async (kind: string) => `${kind}-token`);
    const supervisor = {
        state: "ready" as UtilityHostSupervisor["state"],
        registerLocalPathSelection,
    };
    registerAssetVersionExportIpc({
        ipcMain: {
            handle(channel, handler) {
                handlers.set(channel, handler as Handler);
            },
        } as Pick<IpcMain, "handle">,
        dialog: { showSaveDialog } as unknown as Pick<Dialog, "showSaveDialog">,
        supervisor,
        getPrimaryWindow: () => window,
        text: (messageId) => messageId,
    });
    return { handlers, sender, supervisor, showSaveDialog, registerLocalPathSelection };
}

function exportHandler(handlers: ReadonlyMap<string, Handler>): Handler {
    const handler = handlers.get(ASSET_VERSION_EXPORT_PICK_CHANNEL);
    if (handler === undefined) throw new Error("missing Desktop Asset Version export handler");
    return handler;
}

describe("Desktop Asset Version export IPC", () => {
    it("binds each export choice to its exact create-only path authority", async () => {
        const { handlers, sender, showSaveDialog, registerLocalPathSelection } = fixture();
        const handler = exportHandler(handlers);
        showSaveDialog
            .mockResolvedValueOnce({ canceled: false, filePath: "C:\\proof\\original.zip" })
            .mockResolvedValueOnce({ canceled: false, filePath: "C:\\proof\\portable.zip" })
            .mockResolvedValueOnce({ canceled: true });

        await expect(handler({ sender }, "native_files", "asset-original-files.zip")).resolves.toEqual({
            status: "selected",
            displayPath: "C:\\proof\\original.zip",
            localPathSelectionToken: "asset_native_export_file-token",
        });
        await expect(handler({ sender }, "oaam_version_package", "asset-oaam-version.zip")).resolves.toEqual({
            status: "selected",
            displayPath: "C:\\proof\\portable.zip",
            localPathSelectionToken: "asset_export_file-token",
        });
        await expect(handler({ sender }, "native_files", "cancelled.zip")).resolves.toEqual({ status: "cancelled" });

        expect(showSaveDialog.mock.calls[0]?.[1]).toEqual({
            title: "library.native_export.choose_title",
            buttonLabel: "library.native_export.choose_button",
            defaultPath: "asset-original-files.zip",
            filters: [{ name: "ZIP", extensions: ["zip"] }],
        });
        expect(showSaveDialog.mock.calls[1]?.[1]).toEqual({
            title: "library.export.choose_title",
            buttonLabel: "library.export.choose_button",
            defaultPath: "asset-oaam-version.zip",
            filters: [{ name: "ZIP", extensions: ["zip"] }],
        });
        expect(registerLocalPathSelection.mock.calls).toEqual([
            ["asset_native_export_file", "C:\\proof\\original.zip"],
            ["asset_export_file", "C:\\proof\\portable.zip"],
        ]);
    });

    it("fails before opening a dialog for the wrong sender, stopped Host, or malformed input", async () => {
        const { handlers, sender, supervisor, showSaveDialog } = fixture();
        const handler = exportHandler(handlers);

        await expect(handler({ sender: {} as WebContents }, "native_files", "asset.zip")).rejects.toThrow(
            "OAAM Asset Version export selection is unavailable",
        );
        supervisor.state = "stopped";
        await expect(handler({ sender }, "native_files", "asset.zip")).rejects.toThrow(
            "OAAM Asset Version export selection is unavailable",
        );
        supervisor.state = "ready";
        await expect(handler({ sender }, "unknown", "asset.zip")).rejects.toThrow("invalid Desktop Asset Version export kind");
        await expect(handler({ sender }, "native_files", " asset.zip")).rejects.toThrow(
            "invalid Desktop Asset Version export filename",
        );
        expect(showSaveDialog).not.toHaveBeenCalled();
    });
});
