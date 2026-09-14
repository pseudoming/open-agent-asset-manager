import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { ClientConnectionApi, createClientConnection } from "@oaam/client-framework";
import { describe, expect, it, vi } from "vitest";
import { PACKAGED_STATE_RESILIENCE_PROOF_PORT_SIGNAL } from "../src/bridge/desktop-bridge";
import { type BrowserProtocolPort, MessagePortClientTransport } from "../src/renderer/client";
import {
    PACKAGED_STRONG_BACKUP_PASSWORD,
    installPackagedStateResilienceProofListener,
    provePackagedStateResilience,
    runPackagedStateResilienceProof,
} from "../src/renderer/client/packaged-state-resilience-proof";

const AVAILABLE_OPERATIONS = Object.freeze([
    "asset.list",
    "project.list",
    "deployment.list",
    "state_backup.list",
    "state_backup.inspect",
    "state_backup.create",
    "state_restore.inspect",
    "state_restore.activate",
] as const satisfies readonly ProtocolOperationName[]);
const SUBJECT = Object.freeze({
    projectId: "project",
    assetId: "asset",
    versionId: "version",
    deploymentId: "deployment",
});

function complete(value: unknown) {
    return { status: "complete", value, diagnostics: [] };
}

function failed(code: string) {
    return {
        status: "failed",
        error: { code, message: code },
        diagnostics: [{ severity: "error", code, message: code }],
    };
}

function operation(terminal: unknown) {
    return {
        operationId: "operation",
        operation: "fixture",
        terminal: Promise.resolve(terminal),
        terminalSequence: null,
        subscribeProgress: () => () => undefined,
    };
}

function fixture(options: { readonly recoveryOnly?: boolean; readonly availableBackups?: number } = {}) {
    const entries = Array.from({ length: options.availableBackups ?? 0 }, (_, index) => ({
        backupId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        encryptionMode: "strong_password" as const,
        observation: "available" as const,
    }));
    const reviewModes = new Map<string, "none" | "compatible_password" | "strong_password">();
    let nextBackup = entries.length + 1;
    const request = vi.fn(async (method: string) => {
        switch (method) {
            case "asset.list":
                return complete({
                    assets: [
                        { assetId: "unrelated-asset", projectId: "unrelated-project", currentVersionId: "unrelated-version" },
                        { assetId: SUBJECT.assetId, projectId: SUBJECT.projectId, currentVersionId: SUBJECT.versionId },
                    ],
                });
            case "project.list":
                return complete({
                    projects: [
                        { projectId: "unrelated-project", deleted: false },
                        { projectId: SUBJECT.projectId, deleted: false },
                    ],
                });
            case "deployment.list":
                return complete({
                    deployments: [
                        {
                            deploymentId: "unrelated-deployment",
                            subject: { subjectKind: "project", projectId: "unrelated-project" },
                        },
                        {
                            deploymentId: SUBJECT.deploymentId,
                            subject: { subjectKind: "project", projectId: SUBJECT.projectId },
                        },
                    ],
                });
            case "state_backup.list":
                return complete({
                    schemaVersion: 1,
                    entries: [...entries],
                    totalKnownArchiveBytes: entries.length,
                    totalAvailableArchiveBytes: entries.length,
                });
            default:
                throw new Error(`unexpected request ${method}`);
        }
    });
    const start = vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === "state_backup.inspect") {
            const mode = params.encryptionMode as "none" | "compatible_password" | "strong_password";
            const token = `review:${mode}`;
            reviewModes.set(token, mode);
            return operation(complete({ backupReviewToken: token, encryptionMode: mode }));
        }
        if (method === "state_backup.create") {
            const mode = reviewModes.get(String(params.backupReviewToken));
            if (mode === undefined) return operation(failed("backup.review_missing"));
            const backupId = `00000000-0000-4000-8000-${String(nextBackup).padStart(12, "0")}`;
            nextBackup += 1;
            entries.push({ backupId, encryptionMode: mode, observation: "available" });
            return operation(complete({ backupId, encryptionMode: mode }));
        }
        if (method === "state_restore.inspect") {
            if (params.password !== PACKAGED_STRONG_BACKUP_PASSWORD) {
                return operation(failed("restore.archive_password_invalid"));
            }
            return operation(
                complete({
                    restoreReviewToken: "restore-review",
                    backupId: "00000000-0000-4000-8000-000000000001",
                    encryptionMode: "strong_password",
                }),
            );
        }
        if (method === "state_restore.activate") {
            return operation(
                complete({
                    backupId: "00000000-0000-4000-8000-000000000001",
                    requiresRestart: true,
                }),
            );
        }
        throw new Error(`unexpected long operation ${method}`);
    });
    const availableOperations = options.recoveryOnly
        ? (["state_restore.inspect", "state_restore.activate"] as const)
        : AVAILABLE_OPERATIONS;
    const connection = {
        availableOperations,
        initialize: vi.fn(async () => ({ protocolVersion: 1, availableOperations })),
        request,
        start,
        close: vi.fn(),
    } as unknown as ClientConnectionApi;
    const bridge = {
        performStateBackupFileAction: vi.fn(async (backupId: string, action: string) => {
            if (action !== "trash") return { status: "failed" as const, code: "unavailable" as const };
            const index = entries.findIndex((entry) => entry.backupId === backupId);
            if (index < 0) return { status: "failed" as const, code: "trash_failed" as const };
            entries.splice(index, 1);
            return { status: "complete" as const };
        }),
    };
    return { connection, bridge, entries, request, start };
}

function browserPort(): BrowserProtocolPort {
    return {
        postMessage: vi.fn(),
        start: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
}

describe("packaged State resilience renderer proof", () => {
    it("creates all three exact ZIP modes from one nonempty authority and verifies inventory", async () => {
        const value = fixture();
        await expect(
            provePackagedStateResilience(
                value.connection,
                { mode: "backup", subject: SUBJECT },
                value.bridge,
                () => "user-action",
            ),
        ).resolves.toBeUndefined();
        expect(value.entries.map((entry) => entry.encryptionMode)).toEqual(["none", "compatible_password", "strong_password"]);
    });

    it("blocks a wrong password before activating the exact selected strong archive", async () => {
        const wrongPassword = fixture({ recoveryOnly: true });
        const value = fixture({ recoveryOnly: true });
        await expect(
            provePackagedStateResilience(
                value.connection,
                {
                    mode: "restore",
                    wrongPasswordArchiveToken: "wrong-token",
                    archiveToken: "valid-token",
                },
                value.bridge,
                () => "user-action",
                wrongPassword.connection,
            ),
        ).resolves.toBeUndefined();
        expect(wrongPassword.start.mock.calls.map(([method]) => method)).toEqual(["state_restore.inspect"]);
        expect(value.start.mock.calls.map(([method]) => method)).toEqual(["state_restore.inspect", "state_restore.activate"]);
    });

    it("proves restored authority on reopen and retires a disposable backup through the Desktop bridge", async () => {
        const reopened = fixture({ availableBackups: 3 });
        await expect(
            provePackagedStateResilience(reopened.connection, { mode: "reopen", subject: SUBJECT }, reopened.bridge),
        ).resolves.toBeUndefined();

        const trashed = fixture({ availableBackups: 3 });
        await expect(
            provePackagedStateResilience(
                trashed.connection,
                { mode: "trash", subject: SUBJECT },
                trashed.bridge,
                () => "user-action",
            ),
        ).resolves.toBeUndefined();
        expect(trashed.bridge.performStateBackupFileAction).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000004", "trash");
        expect(trashed.entries).toHaveLength(3);
    });

    it("fails closed when the recovery Host exposes ordinary catalog operations instead of the finite restore route", async () => {
        const wrongPassword = fixture({ recoveryOnly: true });
        const value = fixture({ recoveryOnly: true });
        wrongPassword.connection.initialize = vi.fn(async () => ({
            protocolVersion: 1,
            availableOperations: ["asset.list"] as ProtocolOperationName[],
        }));
        await expect(
            provePackagedStateResilience(
                value.connection,
                { mode: "restore", wrongPasswordArchiveToken: "wrong", archiveToken: "valid" },
                value.bridge,
                undefined,
                wrongPassword.connection,
            ),
        ).rejects.toThrow(/available_operations/u);
    });

    it("requires a separate one-shot path authority for the wrong-password counterexample", async () => {
        const value = fixture({ recoveryOnly: true });
        await expect(
            provePackagedStateResilience(
                value.connection,
                { mode: "restore", wrongPasswordArchiveToken: "wrong", archiveToken: "valid" },
                value.bridge,
            ),
        ).rejects.toThrow(/restore_wrong_password/u);
        expect(value.connection.initialize).not.toHaveBeenCalled();
    });

    it("owns one or two MessagePort connections for the exact proof mode and reports listener failure", async () => {
        const reopened = fixture({ availableBackups: 3 });
        const reopenPort = browserPort();
        let requestNumber = 0;
        const reopenFactory = vi.fn((transport, options) => {
            expect(transport).toBeInstanceOf(MessagePortClientTransport);
            expect(options.createRequestId()).toBe(`state-${String(++requestNumber)}`);
            return reopened.connection;
        }) as unknown as typeof createClientConnection;
        await expect(
            runPackagedStateResilienceProof(
                [reopenPort],
                { mode: "reopen", subject: SUBJECT },
                reopened.bridge,
                reopenFactory,
                () => `state-${String(requestNumber + 1)}`,
            ),
        ).resolves.toBeUndefined();
        expect(reopened.connection.close).toHaveBeenCalledOnce();

        const wrongPassword = fixture({ recoveryOnly: true });
        const restored = fixture({ recoveryOnly: true });
        const restoreFactory = vi
            .fn()
            .mockReturnValueOnce(wrongPassword.connection)
            .mockReturnValueOnce(restored.connection) as unknown as typeof createClientConnection;
        await expect(
            runPackagedStateResilienceProof(
                [browserPort(), browserPort()],
                { mode: "restore", wrongPasswordArchiveToken: "wrong", archiveToken: "valid" },
                restored.bridge,
                restoreFactory,
                () => "request",
            ),
        ).resolves.toBeUndefined();
        expect(wrongPassword.connection.close).toHaveBeenCalledOnce();
        expect(restored.connection.close).toHaveBeenCalledOnce();

        await expect(
            runPackagedStateResilienceProof(
                [],
                { mode: "reopen", subject: SUBJECT },
                reopened.bridge,
                reopenFactory,
                () => "request",
            ),
        ).rejects.toThrow(/unexpected/u);

        const listenerFailure = fixture({ availableBackups: 3 });
        const listenerFactory = vi.fn((_transport, options) => {
            options.reportListenerError(new Error("listener failed"));
            options.reportListenerError(new Error("second listener failure"));
            return listenerFailure.connection;
        }) as unknown as typeof createClientConnection;
        await expect(
            runPackagedStateResilienceProof(
                [browserPort()],
                { mode: "reopen", subject: SUBJECT },
                listenerFailure.bridge,
                listenerFactory,
                () => "request",
            ),
        ).rejects.toThrow(/client_listener/u);
        expect(listenerFailure.connection.close).toHaveBeenCalledOnce();
    });

    it("fails closed for an invalid Protocol version and nonempty-State mismatch", async () => {
        const invalidVersion = fixture();
        invalidVersion.connection.initialize = vi.fn(async () => ({
            protocolVersion: 2,
            availableOperations: AVAILABLE_OPERATIONS,
        })) as never;
        await expect(
            provePackagedStateResilience(invalidVersion.connection, { mode: "backup", subject: SUBJECT }, invalidVersion.bridge),
        ).rejects.toThrow(/initialize/u);

        const emptyState = fixture();
        emptyState.connection.request = vi.fn(async (method: string) =>
            method === "asset.list" ? complete({ assets: [] }) : emptyState.request(method),
        ) as never;
        await expect(
            provePackagedStateResilience(emptyState.connection, { mode: "backup", subject: SUBJECT }, emptyState.bridge),
        ).rejects.toThrow(/nonempty_state/u);
    });

    it("routes only exact State proof signals and returns bounded typed evidence", async () => {
        const listeners: Array<(event: MessageEvent<unknown>) => void> = [];
        const browserWindow = {
            addEventListener: vi.fn((_type: string, listener: (event: MessageEvent<unknown>) => void) =>
                listeners.push(listener),
            ),
            removeEventListener: vi.fn(),
        } as unknown as Window;
        const success = fixture({ availableBackups: 3 });
        const failedBackup = fixture();
        failedBackup.start.mockImplementation(async (method: string) =>
            method === "state_backup.inspect" ? operation(failed("backup.inspect_failed")) : operation(failed("unexpected")),
        );
        const createConnection = vi
            .fn()
            .mockReturnValueOnce(success.connection)
            .mockReturnValueOnce(
                failedBackup.connection,
            ) as unknown as typeof import("@oaam/client-framework").createClientConnection;
        const dispose = installPackagedStateResilienceProofListener(
            browserWindow,
            success.bridge,
            createConnection,
            () => "request",
        );
        const receive = listeners[0];
        if (receive === undefined) throw new Error("listener was not installed");

        receive({
            source: {},
            data: { signal: PACKAGED_STATE_RESILIENCE_PROOF_PORT_SIGNAL },
            ports: [],
        } as unknown as MessageEvent);
        receive({ source: browserWindow, data: null, ports: [] } as unknown as MessageEvent);
        receive({ source: browserWindow, data: { signal: "other" }, ports: [] } as unknown as MessageEvent);

        const tooFew = browserPort();
        receive({
            source: browserWindow,
            data: { signal: PACKAGED_STATE_RESILIENCE_PROOF_PORT_SIGNAL },
            ports: [tooFew as MessagePort],
        } as unknown as MessageEvent);
        expect(tooFew.close).toHaveBeenCalledOnce();

        const tooMany = [browserPort(), browserPort(), browserPort(), browserPort()];
        receive({
            source: browserWindow,
            data: { signal: PACKAGED_STATE_RESILIENCE_PROOF_PORT_SIGNAL },
            ports: tooMany as unknown as MessagePort[],
        } as unknown as MessageEvent);
        for (const port of tooMany) expect(port.close).toHaveBeenCalledOnce();

        const malformedProtocol = browserPort();
        const malformedResult = browserPort();
        receive({
            source: browserWindow,
            data: { signal: PACKAGED_STATE_RESILIENCE_PROOF_PORT_SIGNAL, request: { mode: "invalid" } },
            ports: [malformedProtocol as MessagePort, malformedResult as MessagePort],
        } as unknown as MessageEvent);
        await vi.waitFor(() =>
            expect(malformedResult.postMessage).toHaveBeenCalledWith({
                status: "failed",
                step: "unexpected",
                diagnosticCodes: [],
            }),
        );

        const wrongRestoreProtocol = browserPort();
        const wrongRestoreResult = browserPort();
        receive({
            source: browserWindow,
            data: {
                signal: PACKAGED_STATE_RESILIENCE_PROOF_PORT_SIGNAL,
                request: { mode: "restore", wrongPasswordArchiveToken: "wrong", archiveToken: "valid" },
            },
            ports: [wrongRestoreProtocol as MessagePort, wrongRestoreResult as MessagePort],
        } as unknown as MessageEvent);
        await vi.waitFor(() =>
            expect(wrongRestoreResult.postMessage).toHaveBeenCalledWith({
                status: "failed",
                step: "unexpected",
                diagnosticCodes: [],
            }),
        );

        const successProtocol = browserPort();
        const successResult = browserPort();
        receive({
            source: browserWindow,
            data: { signal: PACKAGED_STATE_RESILIENCE_PROOF_PORT_SIGNAL, request: { mode: "reopen", subject: SUBJECT } },
            ports: [successProtocol as MessagePort, successResult as MessagePort],
        } as unknown as MessageEvent);
        await vi.waitFor(() => expect(successResult.postMessage).toHaveBeenCalledWith({ status: "complete" }));
        expect(successResult.close).toHaveBeenCalledOnce();

        const failedProtocol = browserPort();
        const failedResult = browserPort();
        receive({
            source: browserWindow,
            data: { signal: PACKAGED_STATE_RESILIENCE_PROOF_PORT_SIGNAL, request: { mode: "backup", subject: SUBJECT } },
            ports: [failedProtocol as MessagePort, failedResult as MessagePort],
        } as unknown as MessageEvent);
        await vi.waitFor(() =>
            expect(failedResult.postMessage).toHaveBeenCalledWith({
                status: "failed",
                step: "backup_inspect",
                diagnosticCodes: ["backup.inspect_failed"],
            }),
        );
        expect(failedResult.close).toHaveBeenCalledOnce();

        dispose();
        expect(browserWindow.removeEventListener).toHaveBeenCalledOnce();
    });
});
