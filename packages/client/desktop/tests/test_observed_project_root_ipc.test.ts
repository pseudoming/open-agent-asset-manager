import type { IpcMain, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
    OBSERVED_PROJECT_ROOT_AUTHORIZE_CHANNEL,
    OBSERVED_PROJECT_ROOT_REVEAL_CHANNEL,
    parseDesktopObservedProjectRootReference,
    parseObservedProjectRootAuthorizationResult,
    parseObservedProjectRootRevealResult,
} from "../src/bridge/desktop-bridge";
import { registerObservedProjectRootIpc } from "../src/main/observed-project-root-ipc";

const REFERENCE = Object.freeze({
    probeToken: "probe-token",
    probeResultRowId: "probe-result-row",
    projectRowId: "project-row",
    sourceRootRowId: "source-root-row",
});

type Handler = (event: { readonly sender: WebContents }, value: unknown) => Promise<unknown>;

function fixture() {
    const handlers = new Map<string, Handler>();
    const sender = {} as WebContents;
    const resolveObservedProjectRoot = vi
        .fn()
        .mockResolvedValueOnce({
            purpose: "registration",
            rootPath: "C:\\work\\project",
            localPathSelectionToken: "project-root-token",
        })
        .mockResolvedValueOnce({ purpose: "reveal", rootPath: "C:\\work\\project" })
        .mockResolvedValueOnce({ purpose: "reveal", rootPath: "C:\\work\\project" });
    const openPath = vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("not found");
    const supervisor = { state: "ready" as const, resolveObservedProjectRoot };
    registerObservedProjectRootIpc({
        ipcMain: {
            handle(channel, handler) {
                handlers.set(channel, handler as Handler);
            },
        } as Pick<IpcMain, "handle">,
        supervisor,
        authorizedSender: () => sender,
        openPath,
    });
    return { handlers, sender, supervisor, resolveObservedProjectRoot, openPath };
}

describe("Desktop observed Project root IPC", () => {
    it("parses only exact observed-root references and finite results", () => {
        expect(parseDesktopObservedProjectRootReference(REFERENCE)).toEqual(REFERENCE);
        expect(
            parseObservedProjectRootAuthorizationResult({
                status: "authorized",
                displayPath: "C:\\work\\project",
                localPathSelectionToken: "token",
            }),
        ).toEqual({
            status: "authorized",
            displayPath: "C:\\work\\project",
            localPathSelectionToken: "token",
        });
        expect(parseObservedProjectRootAuthorizationResult({ status: "failed", code: "unavailable" })).toEqual({
            status: "failed",
            code: "unavailable",
        });
        expect(parseObservedProjectRootRevealResult({ status: "complete" })).toEqual({ status: "complete" });
        expect(parseObservedProjectRootRevealResult({ status: "failed", code: "open_failed" })).toEqual({
            status: "failed",
            code: "open_failed",
        });
        for (const malformed of [
            null,
            { ...REFERENCE, sourceRootRowId: "" },
            { ...REFERENCE, extra: true },
            { probeToken: "probe-token" },
        ]) {
            expect(() => parseDesktopObservedProjectRootReference(malformed)).toThrow(
                "invalid Desktop observed Project root reference",
            );
        }
        for (const malformed of [
            { status: "authorized", displayPath: "", localPathSelectionToken: "token" },
            { status: "failed", code: "open_failed" },
            { status: "failed", code: "unavailable", extra: true },
        ]) {
            expect(() => parseObservedProjectRootAuthorizationResult(malformed)).toThrow(
                "invalid Desktop observed Project root authorization result",
            );
        }
        for (const malformed of [
            { status: "complete", extra: true },
            { status: "failed", code: "foreign" },
            { status: "failed", code: "unavailable", extra: true },
        ]) {
            expect(() => parseObservedProjectRootRevealResult(malformed)).toThrow(
                "invalid Desktop observed Project root reveal result",
            );
        }
    });

    it("authorizes registration and reveals only the exact Host-resolved root", async () => {
        const { handlers, sender, resolveObservedProjectRoot, openPath } = fixture();
        const authorize = handlers.get(OBSERVED_PROJECT_ROOT_AUTHORIZE_CHANNEL);
        const reveal = handlers.get(OBSERVED_PROJECT_ROOT_REVEAL_CHANNEL);
        if (authorize === undefined || reveal === undefined) throw new Error("observed Project root IPC is missing");

        await expect(authorize({ sender }, REFERENCE)).resolves.toEqual({
            status: "authorized",
            displayPath: "C:\\work\\project",
            localPathSelectionToken: "project-root-token",
        });
        await expect(reveal({ sender }, REFERENCE)).resolves.toEqual({ status: "complete" });
        await expect(reveal({ sender }, REFERENCE)).resolves.toEqual({ status: "failed", code: "open_failed" });
        expect(resolveObservedProjectRoot.mock.calls).toEqual([
            ["registration", REFERENCE],
            ["reveal", REFERENCE],
            ["reveal", REFERENCE],
        ]);
        expect(openPath.mock.calls).toEqual([["C:\\work\\project"], ["C:\\work\\project"]]);
    });

    it("fails closed for foreign senders, unavailable Host state, malformed references, and changed purpose", async () => {
        const { handlers, sender, supervisor, resolveObservedProjectRoot, openPath } = fixture();
        const authorize = handlers.get(OBSERVED_PROJECT_ROOT_AUTHORIZE_CHANNEL);
        const reveal = handlers.get(OBSERVED_PROJECT_ROOT_REVEAL_CHANNEL);
        if (authorize === undefined || reveal === undefined) throw new Error("observed Project root IPC is missing");

        await expect(authorize({ sender: {} as WebContents }, REFERENCE)).resolves.toEqual({
            status: "failed",
            code: "unavailable",
        });
        supervisor.state = "stopped" as "ready";
        await expect(reveal({ sender }, REFERENCE)).resolves.toEqual({ status: "failed", code: "unavailable" });
        supervisor.state = "ready";
        await expect(authorize({ sender }, { ...REFERENCE, sourceRootRowId: "" })).resolves.toEqual({
            status: "failed",
            code: "unavailable",
        });
        resolveObservedProjectRoot.mockReset().mockResolvedValueOnce({ purpose: "reveal", rootPath: "C:\\foreign" });
        await expect(authorize({ sender }, REFERENCE)).resolves.toEqual({ status: "failed", code: "unavailable" });
        resolveObservedProjectRoot.mockReset().mockResolvedValueOnce({
            purpose: "registration",
            rootPath: "C:\\foreign",
            localPathSelectionToken: "foreign-token",
        });
        await expect(reveal({ sender }, REFERENCE)).resolves.toEqual({ status: "failed", code: "unavailable" });
        resolveObservedProjectRoot.mockReset().mockRejectedValueOnce(new Error("stale"));
        await expect(reveal({ sender }, REFERENCE)).resolves.toEqual({ status: "failed", code: "unavailable" });
        expect(openPath).not.toHaveBeenCalled();
    });
});
