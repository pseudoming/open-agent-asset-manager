import type { IpcMain, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
    IMPORT_PREVIEW_FILE_REVEAL_CHANNEL,
    parseDesktopImportPreviewFileReference,
    parseImportPreviewFileRevealResult,
} from "../src/bridge/desktop-bridge";
import { registerImportPreviewFileIpc } from "../src/main/import-preview-file-ipc";

const REFERENCE = Object.freeze({
    previewToken: "preview-token",
    candidateId: "candidate-id",
    logicalPath: "nested/SKILL.md",
});

type Handler = (event: { readonly sender: WebContents }, value: unknown) => Promise<unknown>;

function fixture() {
    const handlers = new Map<string, Handler>();
    const sender = {} as WebContents;
    const resolveImportPreviewFileDirectory = vi.fn(async () => "C:\\work\\skill\\nested");
    const openPath = vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("not found");
    const supervisor = { state: "ready" as const, resolveImportPreviewFileDirectory };
    registerImportPreviewFileIpc({
        ipcMain: {
            handle(channel, handler) {
                handlers.set(channel, handler as Handler);
            },
        } as Pick<IpcMain, "handle">,
        supervisor,
        authorizedSender: () => sender,
        openPath,
    });
    return { handlers, sender, supervisor, resolveImportPreviewFileDirectory, openPath };
}

describe("Desktop import-preview file IPC", () => {
    it("parses only exact opaque references and finite renderer results", () => {
        expect(parseDesktopImportPreviewFileReference(REFERENCE)).toEqual(REFERENCE);
        expect(parseDesktopImportPreviewFileReference({ previewToken: "preview", candidateId: "candidate" })).toEqual({
            previewToken: "preview",
            candidateId: "candidate",
        });
        expect(parseImportPreviewFileRevealResult({ status: "complete" })).toEqual({ status: "complete" });
        expect(parseImportPreviewFileRevealResult({ status: "failed", code: "open_failed" })).toEqual({
            status: "failed",
            code: "open_failed",
        });
        for (const malformed of [
            null,
            { ...REFERENCE, logicalPath: "" },
            { ...REFERENCE, previewToken: " preview-token" },
            { ...REFERENCE, extra: true },
            { previewToken: "preview-token" },
        ]) {
            expect(() => parseDesktopImportPreviewFileReference(malformed)).toThrow(
                "invalid Desktop import-preview file reference",
            );
        }
        for (const malformed of [
            { status: "complete", directoryPath: "C:\\secret" },
            { status: "failed", code: "foreign" },
            { status: "failed", code: "unavailable", extra: true },
        ]) {
            expect(() => parseImportPreviewFileRevealResult(malformed)).toThrow(
                "invalid Desktop import-preview file reveal result",
            );
        }
    });

    it("opens only the Host-resolved directory without returning its path to the renderer", async () => {
        const { handlers, sender, resolveImportPreviewFileDirectory, openPath } = fixture();
        const reveal = handlers.get(IMPORT_PREVIEW_FILE_REVEAL_CHANNEL);
        if (reveal === undefined) throw new Error("import-preview file IPC is missing");

        await expect(reveal({ sender }, REFERENCE)).resolves.toEqual({ status: "complete" });
        await expect(reveal({ sender }, REFERENCE)).resolves.toEqual({ status: "failed", code: "open_failed" });
        expect(resolveImportPreviewFileDirectory).toHaveBeenCalledTimes(2);
        expect(resolveImportPreviewFileDirectory).toHaveBeenNthCalledWith(1, REFERENCE);
        expect(openPath.mock.calls).toEqual([["C:\\work\\skill\\nested"], ["C:\\work\\skill\\nested"]]);
    });

    it("fails closed before path opening for a foreign sender, unavailable Host, malformed input, or stale review", async () => {
        const { handlers, sender, supervisor, resolveImportPreviewFileDirectory, openPath } = fixture();
        const reveal = handlers.get(IMPORT_PREVIEW_FILE_REVEAL_CHANNEL);
        if (reveal === undefined) throw new Error("import-preview file IPC is missing");

        await expect(reveal({ sender: {} as WebContents }, REFERENCE)).resolves.toEqual({
            status: "failed",
            code: "unavailable",
        });
        supervisor.state = "stopped" as "ready";
        await expect(reveal({ sender }, REFERENCE)).resolves.toEqual({ status: "failed", code: "unavailable" });
        supervisor.state = "ready";
        await expect(reveal({ sender }, { ...REFERENCE, extra: true })).resolves.toEqual({
            status: "failed",
            code: "unavailable",
        });
        resolveImportPreviewFileDirectory.mockRejectedValueOnce(new Error("stale"));
        await expect(reveal({ sender }, REFERENCE)).resolves.toEqual({ status: "failed", code: "unavailable" });
        expect(openPath).not.toHaveBeenCalled();
    });
});
