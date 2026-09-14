import type { IpcMain, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
    parseDesktopRegisteredProjectId,
    parseRegisteredProjectRootAuthorizationResult,
    parseRegisteredProjectRootRevealResult,
    REGISTERED_PROJECT_ROOT_AUTHORIZE_CHANNEL,
    REGISTERED_PROJECT_ROOT_REVEAL_CHANNEL,
} from "../src/bridge/desktop-bridge";
import { registerProjectRootIpc } from "../src/main/registered-project-root-ipc";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

type Handler = (event: { readonly sender: WebContents }, value: unknown) => Promise<unknown>;

function fixture() {
    const handlers = new Map<string, Handler>();
    const sender = {} as WebContents;
    const resolveRegisteredProjectRoot = vi
        .fn()
        .mockResolvedValueOnce({
            purpose: "probe",
            rootPath: "C:\\work\\project",
            localPathSelectionToken: "project-root-token",
        })
        .mockResolvedValueOnce({ purpose: "reveal", rootPath: "C:\\work\\project" })
        .mockResolvedValueOnce({ purpose: "reveal", rootPath: "C:\\work\\project" });
    const openPath = vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("not found");
    const supervisor = {
        state: "ready" as const,
        resolveObservedProjectRoot: vi.fn(),
        resolveRegisteredProjectRoot,
    };
    registerProjectRootIpc({
        ipcMain: {
            handle(channel, handler) {
                handlers.set(channel, handler as Handler);
            },
        } as Pick<IpcMain, "handle">,
        supervisor,
        authorizedSender: () => sender,
        openPath,
    });
    return { handlers, sender, supervisor, resolveRegisteredProjectRoot, openPath };
}

describe("Desktop registered Project root IPC", () => {
    it("parses only exact Project ids and finite results", () => {
        expect(parseDesktopRegisteredProjectId(PROJECT_ID)).toBe(PROJECT_ID);
        expect(
            parseRegisteredProjectRootAuthorizationResult({
                status: "authorized",
                displayPath: "C:\\work\\project",
                localPathSelectionToken: "token",
            }),
        ).toEqual({ status: "authorized", displayPath: "C:\\work\\project", localPathSelectionToken: "token" });
        expect(parseRegisteredProjectRootAuthorizationResult({ status: "failed", code: "unavailable" })).toEqual({
            status: "failed",
            code: "unavailable",
        });
        expect(parseRegisteredProjectRootRevealResult({ status: "complete" })).toEqual({ status: "complete" });
        expect(parseRegisteredProjectRootRevealResult({ status: "failed", code: "open_failed" })).toEqual({
            status: "failed",
            code: "open_failed",
        });
        for (const malformed of [null, "", ` ${PROJECT_ID}`, "11111111-1111-1111-8111-111111111111", `${PROJECT_ID}0`]) {
            expect(() => parseDesktopRegisteredProjectId(malformed)).toThrow("invalid Desktop registered Project id");
        }
        expect(() =>
            parseRegisteredProjectRootAuthorizationResult({
                status: "authorized",
                displayPath: "",
                localPathSelectionToken: "token",
            }),
        ).toThrow("invalid Desktop observed Project root authorization result");
        expect(() => parseRegisteredProjectRootRevealResult({ status: "complete", path: "/foreign" })).toThrow(
            "invalid Desktop observed Project root reveal result",
        );
    });

    it("authorizes probing and reveals only the exact Host-resolved registered root", async () => {
        const { handlers, sender, resolveRegisteredProjectRoot, openPath } = fixture();
        const authorize = handlers.get(REGISTERED_PROJECT_ROOT_AUTHORIZE_CHANNEL);
        const reveal = handlers.get(REGISTERED_PROJECT_ROOT_REVEAL_CHANNEL);
        if (authorize === undefined || reveal === undefined) throw new Error("registered Project root IPC is missing");

        await expect(authorize({ sender }, PROJECT_ID)).resolves.toEqual({
            status: "authorized",
            displayPath: "C:\\work\\project",
            localPathSelectionToken: "project-root-token",
        });
        await expect(reveal({ sender }, PROJECT_ID)).resolves.toEqual({ status: "complete" });
        await expect(reveal({ sender }, PROJECT_ID)).resolves.toEqual({ status: "failed", code: "open_failed" });
        expect(resolveRegisteredProjectRoot.mock.calls).toEqual([
            ["probe", PROJECT_ID],
            ["reveal", PROJECT_ID],
            ["reveal", PROJECT_ID],
        ]);
        expect(openPath.mock.calls).toEqual([["C:\\work\\project"], ["C:\\work\\project"]]);
    });

    it("fails closed for foreign senders, unavailable Host state, malformed ids, changed purpose, and stale roots", async () => {
        const { handlers, sender, supervisor, resolveRegisteredProjectRoot, openPath } = fixture();
        const authorize = handlers.get(REGISTERED_PROJECT_ROOT_AUTHORIZE_CHANNEL);
        const reveal = handlers.get(REGISTERED_PROJECT_ROOT_REVEAL_CHANNEL);
        if (authorize === undefined || reveal === undefined) throw new Error("registered Project root IPC is missing");

        await expect(authorize({ sender: {} as WebContents }, PROJECT_ID)).resolves.toEqual({
            status: "failed",
            code: "unavailable",
        });
        supervisor.state = "stopped" as "ready";
        await expect(reveal({ sender }, PROJECT_ID)).resolves.toEqual({ status: "failed", code: "unavailable" });
        supervisor.state = "ready";
        await expect(authorize({ sender }, "not-a-project-id")).resolves.toEqual({ status: "failed", code: "unavailable" });
        resolveRegisteredProjectRoot.mockReset().mockResolvedValueOnce({ purpose: "reveal", rootPath: "C:\\foreign" });
        await expect(authorize({ sender }, PROJECT_ID)).resolves.toEqual({ status: "failed", code: "unavailable" });
        resolveRegisteredProjectRoot.mockReset().mockResolvedValueOnce({
            purpose: "probe",
            rootPath: "C:\\foreign",
            localPathSelectionToken: "foreign-token",
        });
        await expect(reveal({ sender }, PROJECT_ID)).resolves.toEqual({ status: "failed", code: "unavailable" });
        resolveRegisteredProjectRoot.mockReset().mockRejectedValueOnce(new Error("deleted"));
        await expect(reveal({ sender }, PROJECT_ID)).resolves.toEqual({ status: "failed", code: "unavailable" });
        expect(openPath).not.toHaveBeenCalled();
    });
});
