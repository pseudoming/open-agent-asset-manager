import type { BrowserWindow, Dialog, IpcMain, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
    INSTALLATION_ROOT_PICK_CHANNEL,
    parseInstallationRootPickerResult,
    parseProjectRootPickerResult,
    parseProjectRootPickerSuggestedPath,
    parseSourceRootPickerResult,
    PROJECT_ROOT_PICK_CHANNEL,
    SOURCE_ROOT_PICK_CHANNEL,
} from "../src/bridge/desktop-bridge";
import { registerNativeDirectoryPickerIpc } from "../src/main/native-directory-picker-ipc";
import type { UtilityHostSupervisor } from "../src/main/utility-host-supervisor";

type Handler = (event: { readonly sender: WebContents }, value?: unknown) => Promise<unknown>;

function fixture() {
    const handlers = new Map<string, Handler>();
    const sender = {} as WebContents;
    const window = { webContents: sender } as BrowserWindow;
    const showOpenDialog = vi.fn();
    const registerLocalPathSelection = vi.fn(async (kind: string) => `${kind}-token`);
    const supervisor = {
        state: "ready" as UtilityHostSupervisor["state"],
        registerLocalPathSelection,
    };
    registerNativeDirectoryPickerIpc({
        ipcMain: {
            handle(channel, handler) {
                handlers.set(channel, handler as Handler);
            },
        } as Pick<IpcMain, "handle">,
        dialog: { showOpenDialog } as unknown as Pick<Dialog, "showOpenDialog">,
        supervisor,
        getPrimaryWindow: () => window,
        text: (messageId) => messageId,
    });
    return { handlers, sender, supervisor, showOpenDialog, registerLocalPathSelection };
}

function requiredHandler(handlers: ReadonlyMap<string, Handler>, channel: string): Handler {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`missing Desktop picker handler: ${channel}`);
    return handler;
}

describe("Desktop native directory picker IPC", () => {
    it("registers exact project, source, and installation selections with their own one-shot authority", async () => {
        const { handlers, sender, showOpenDialog, registerLocalPathSelection } = fixture();
        showOpenDialog
            .mockResolvedValueOnce({ canceled: false, filePaths: ["/workspace/project"] })
            .mockResolvedValueOnce({ canceled: true, filePaths: [] })
            .mockResolvedValueOnce({ canceled: false, filePaths: ["/tools/zcode"] });

        await expect(requiredHandler(handlers, PROJECT_ROOT_PICK_CHANNEL)({ sender }, "/workspace")).resolves.toEqual({
            status: "selected",
            displayPath: "/workspace/project",
            localPathSelectionToken: "project_root-token",
        });
        await expect(requiredHandler(handlers, SOURCE_ROOT_PICK_CHANNEL)({ sender })).resolves.toEqual({
            status: "cancelled",
        });
        await expect(requiredHandler(handlers, INSTALLATION_ROOT_PICK_CHANNEL)({ sender })).resolves.toEqual({
            status: "selected",
            displayPath: "/tools/zcode",
            localPathSelectionToken: "installation_root-token",
        });
        expect(showOpenDialog.mock.calls[0]?.[1]).toMatchObject({ defaultPath: "/workspace" });
        expect(showOpenDialog.mock.calls[1]?.[1]).not.toHaveProperty("defaultPath");
        expect(showOpenDialog.mock.calls[2]?.[1]).not.toHaveProperty("defaultPath");
        expect(registerLocalPathSelection.mock.calls).toEqual([
            ["project_root", "/workspace/project"],
            ["installation_root", "/tools/zcode"],
        ]);
    });

    it("fails before opening a dialog for a foreign sender, unavailable Host, or malformed suggestion", async () => {
        const { handlers, sender, supervisor, showOpenDialog } = fixture();
        const project = requiredHandler(handlers, PROJECT_ROOT_PICK_CHANNEL);
        await expect(project({ sender: {} as WebContents }, "/workspace")).rejects.toThrow(
            "OAAM project-folder selection is unavailable",
        );
        supervisor.state = "stopped";
        await expect(requiredHandler(handlers, INSTALLATION_ROOT_PICK_CHANNEL)({ sender })).rejects.toThrow(
            "OAAM installation-folder selection is unavailable",
        );
        supervisor.state = "ready";
        await expect(project({ sender }, " /workspace")).rejects.toThrow("invalid Desktop project-root picker suggestion");
        expect(showOpenDialog).not.toHaveBeenCalled();
    });

    it("parses only exact bounded picker results", () => {
        const selected = {
            status: "selected",
            displayPath: "/tools/claude",
            localPathSelectionToken: "installation-token",
        };
        expect(parseProjectRootPickerResult({ status: "cancelled" })).toEqual({ status: "cancelled" });
        expect(parseSourceRootPickerResult(selected)).toEqual(selected);
        expect(parseInstallationRootPickerResult(selected)).toEqual(selected);
        expect(parseProjectRootPickerSuggestedPath(undefined)).toBeUndefined();
        expect(parseProjectRootPickerSuggestedPath("/workspace/project")).toBe("/workspace/project");
        expect(() => parseInstallationRootPickerResult({ status: "selected", displayPath: "/tools/claude" })).toThrow(
            "invalid Desktop installation-root picker result",
        );
        for (const malformed of [null, 1, "", " /project", "/project ", "bad\0path", "x".repeat(32_768)]) {
            expect(() => parseProjectRootPickerSuggestedPath(malformed)).toThrow(
                "invalid Desktop project-root picker suggestion",
            );
        }
    });
});
