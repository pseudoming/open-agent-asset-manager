import type { ProtocolNotificationV1 } from "@oaam/app-server-protocol";
import type {
    CoreResult,
    Sha256Digest,
    StateBackupInventoryV1,
    StateBackupPreparationV1,
    StateBackupPromptPolicyV1,
    StateRestoreActivationV1,
    StateRestorePreparationV1,
    UuidV4,
} from "@oaam/core";
import { describe, expect, it, vi } from "vitest";
import { createStateRecoveryHost } from "../src/production-host";
import { createEphemeralOperationalDiagnosticsForTest } from "../src/operational-diagnostics";
import {
    fakeCoreWith,
    flushHost,
    host,
    initializeRequest,
    recordingSink,
    required,
    testStateResilienceIntegration,
} from "./support/host-test-fixtures";

const BACKUP_ID = "00000000-0000-4000-8000-000000000001" as UuidV4;
const RESTORE_ID = "00000000-0000-4000-8000-000000000002" as UuidV4;
const DIGEST = `sha256:${"a".repeat(64)}` as Sha256Digest;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}` as Sha256Digest;

function complete<T>(value: T): CoreResult<T> {
    return { status: "complete", value, diagnostics: [] };
}

function backupPreparation(): StateBackupPreparationV1 {
    return {
        schemaVersion: 1,
        backupId: BACKUP_ID,
        createdAt: 10,
        destination: {
            destinationKind: "oaam_default",
            directoryPath: "/profile/backups",
            directoryState: "ready",
        },
        outputFileName: "backup.zip",
        encryptionMode: "none",
        sourceFileCount: 1,
        sourceLogicalBytes: 20,
        requiredAvailableBytes: 40,
        availableBytes: 80,
        sourceSnapshotFingerprint: DIGEST,
        destinationFingerprint: OTHER_DIGEST,
        preparationFingerprint: DIGEST,
    };
}

function restorePreparation(): StateRestorePreparationV1 {
    return {
        schemaVersion: 1,
        archivePath: "/selected/backup.zip",
        archiveByteSize: 30,
        archiveContentHash: DIGEST,
        backupId: BACKUP_ID,
        backupCreatedAt: 10,
        encryptionMode: "none",
        sourceFileCount: 1,
        sourceLogicalBytes: 20,
        sourceSnapshotFingerprint: DIGEST,
        manifestFingerprint: OTHER_DIGEST,
        includesDesktopPreferences: true,
        preparationFingerprint: DIGEST,
    };
}

function restoreActivation(): StateRestoreActivationV1 {
    return {
        schemaVersion: 1,
        restoreId: RESTORE_ID,
        backupId: BACKUP_ID,
        activatedAt: 20,
        restoredSourceSnapshotFingerprint: DIGEST,
        displacedState: { state: "preserved", path: "/profile.displaced" },
        restoreTransactionPath: "/profile.restore",
        requiresRestart: true,
        desktopPreferences: new Uint8Array([1, 2, 3]),
    };
}

function inventory(): StateBackupInventoryV1 {
    return {
        schemaVersion: 1,
        entries: [
            {
                schemaVersion: 1,
                backupId: BACKUP_ID,
                createdAt: 10,
                archivePath: "/profile/backups/backup.zip",
                archiveByteSize: 30,
                archiveContentHash: DIGEST,
                manifestFingerprint: OTHER_DIGEST,
                sourceSnapshotFingerprint: DIGEST,
                encryptionMode: "none",
                destinationKind: "oaam_default",
                observation: "available",
            },
        ],
        totalKnownArchiveBytes: 30,
        totalAvailableArchiveBytes: 30,
    };
}

function terminalNotification(
    messages: readonly unknown[],
    operation: string,
): Extract<ProtocolNotificationV1, { readonly method: "operation.terminal" }> {
    const notification = messages.find(
        (message) =>
            typeof message === "object" &&
            message !== null &&
            "method" in message &&
            message.method === "operation.terminal" &&
            "params" in message &&
            typeof message.params === "object" &&
            message.params !== null &&
            "operation" in message.params &&
            message.params.operation === operation,
    );
    return required(notification, `${operation} terminal`) as Extract<
        ProtocolNotificationV1,
        { readonly method: "operation.terminal" }
    >;
}

function terminalValue<T>(messages: readonly unknown[], operation: string): T {
    const outcome = terminalNotification(messages, operation).params.outcome;
    if (outcome.status === "failed" || !("value" in outcome)) throw new TypeError(`${operation} did not return a value`);
    return outcome.value as T;
}

describe("State resilience production Protocol route", () => {
    it("exposes only selected-archive restore while ordinary Core authority is unavailable", async () => {
        const inspectStateRestore = vi.fn(async () => complete(restorePreparation()));
        const activateStateRestore = vi.fn(async (_input, control) => {
            await control.quiesceMutations();
            return complete(restoreActivation());
        });
        const integration = testStateResilienceIntegration({
            inspectStateRestore,
            activateStateRestore,
            applyRestoredDesktopPreferences: async () => undefined,
        });
        const runtime = createStateRecoveryHost(integration, "corrupt_database", createEphemeralOperationalDiagnosticsForTest());
        expect(runtime.startupDisposition).toEqual({ mode: "state_recovery", reason: "corrupt_database" });
        expect(runtime.availableOperations).toEqual([
            "initialize",
            "operation.observe",
            "operation.cancel",
            "diagnostics.health.get",
            "diagnostics.ordinary_log.settings.get",
            "diagnostics.ordinary_log.settings.replace",
            "diagnostics.ordinary_log.clear",
            "diagnostics.support_bundle.inspect",
            "diagnostics.support_bundle.export",
            "state_restore.inspect",
            "state_restore.activate",
        ]);

        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive({ id: "asset-list", method: "asset.list", params: {} });
        connection.receive({ id: "backup-list", method: "state_backup.list", params: {} });
        const archiveToken = connection.registerLocalPathSelection("restore_archive", "/selected/backup.zip");
        connection.receive({
            id: "restore-inspect",
            method: "state_restore.inspect",
            params: {
                source: { sourceKind: "selected_archive", localPathSelectionToken: archiveToken },
            },
        });
        await flushHost();
        await flushHost();

        expect(sink.messages[0]).toMatchObject({
            id: "request-1",
            result: { availableOperations: runtime.availableOperations },
        });
        expect(sink.messages).toEqual(
            expect.arrayContaining([
                {
                    id: "asset-list",
                    error: { code: "protocol.unknown_method", message: "Operation is not installed by this Host." },
                },
                {
                    id: "backup-list",
                    error: { code: "protocol.unknown_method", message: "Operation is not installed by this Host." },
                },
            ]),
        );
        expect(inspectStateRestore).toHaveBeenCalledWith({ archivePath: "/selected/backup.zip" });
        const review = terminalValue<{ restoreReviewToken: string }>(sink.messages, "state_restore.inspect");

        connection.receive({
            id: "restore-activate",
            method: "state_restore.activate",
            params: { restoreReviewToken: review.restoreReviewToken, userActionId: "user-action" },
        });
        await flushHost();
        await flushHost();
        expect(terminalValue<{ requiresRestart: boolean }>(sink.messages, "state_restore.activate")).toMatchObject({
            requiresRestart: true,
        });
        expect(activateStateRestore).toHaveBeenCalledTimes(1);
        await runtime.shutdown();
    });

    it("routes immediate state queries and the full inspect-to-activate review lifecycle", async () => {
        const policy: StateBackupPromptPolicyV1 = {
            configVersion: 1,
            settingId: "state_backup_prompt_policy_v1",
            revision: 0,
            mode: "ask_every_time",
            updatedAt: 0,
            settingFingerprint: DIGEST,
        };
        const inspectStateBackup = vi.fn(() => complete(backupPreparation()));
        const core = fakeCoreWith({
            listStateBackups: () => complete(inventory()),
            getStateBackupPromptPolicy: () => complete(policy),
            inspectStateBackup,
        });
        const inspectStateRestore = vi.fn(async () => complete(restorePreparation()));
        const activateStateRestore = vi.fn(async (_input, control) => {
            await control.quiesceMutations();
            return complete(restoreActivation());
        });
        const applyRestoredDesktopPreferences = vi.fn(async () => undefined);
        const restoreRequiresHostReplacement = vi.fn();
        const integration = testStateResilienceIntegration({
            readDesktopPreferences: async () => new Uint8Array([1, 2, 3]),
            inspectStateRestore,
            activateStateRestore,
            applyRestoredDesktopPreferences,
            restoreRequiresHostReplacement,
        });
        const runtime = host(core, "host-state", integration);
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive({ id: "inventory", method: "state_backup.list", params: {} });
        connection.receive({ id: "policy", method: "state_backup_prompt_policy.get", params: {} });
        connection.receive({
            id: "backup-inspect",
            method: "state_backup.inspect",
            params: { destination: { destinationKind: "oaam_default" }, encryptionMode: "none" },
        });
        await flushHost();
        await flushHost();

        expect(sink.messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: "inventory", result: expect.objectContaining({ status: "complete" }) }),
                expect.objectContaining({ id: "policy", result: expect.objectContaining({ status: "complete" }) }),
                expect.objectContaining({ id: "backup-inspect", result: { operationId: expect.any(String) } }),
            ]),
        );
        expect(terminalValue<{ backupReviewToken: string }>(sink.messages, "state_backup.inspect")).toMatchObject({
            backupReviewToken: expect.any(String),
        });
        expect(inspectStateBackup).toHaveBeenCalledTimes(1);

        const archiveToken = connection.registerLocalPathSelection("restore_archive", "/selected/backup.zip");
        connection.receive({
            id: "restore-inspect",
            method: "state_restore.inspect",
            params: {
                source: { sourceKind: "selected_archive", localPathSelectionToken: archiveToken },
            },
        });
        await flushHost();
        await flushHost();
        const restoreReview = terminalValue<{ restoreReviewToken: string }>(sink.messages, "state_restore.inspect");
        expect(inspectStateRestore).toHaveBeenCalledWith({ archivePath: "/selected/backup.zip" });

        connection.receive({
            id: "restore-activate",
            method: "state_restore.activate",
            params: {
                restoreReviewToken: restoreReview.restoreReviewToken,
                userActionId: "user-action",
            },
        });
        await flushHost();
        await flushHost();
        expect(terminalValue<{ restoredDesktopPreferences: boolean }>(sink.messages, "state_restore.activate")).toMatchObject({
            restoredDesktopPreferences: true,
        });
        expect(applyRestoredDesktopPreferences).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "/profile.restore");
        expect(restoreRequiresHostReplacement).toHaveBeenCalledTimes(1);
        expect(runtime.state).toBe("draining");
        await runtime.shutdown();
    });
});
