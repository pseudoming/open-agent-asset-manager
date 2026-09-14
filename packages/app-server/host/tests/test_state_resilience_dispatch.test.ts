import { createProtocolRequest } from "@oaam/app-server-protocol";
import type {
    CoreResult,
    Sha256Digest,
    StateBackupArtifactV1,
    StateBackupInventoryV1,
    StateBackupPreparationV1,
    StateBackupPromptPolicyV1,
    StateRestoreActivationV1,
    StateRestorePreparationV1,
    UuidV4,
} from "@oaam/core";
import { describe, expect, it, vi } from "vitest";
import { HostReviewRecordCapacityError } from "../src/review-record-store";
import { HostReviewRecordUnavailableError, HostReviewRecords } from "../src/review-records";
import {
    dispatchStateResilienceImmediate,
    dispatchStateResilienceLong,
    isStateResilienceImmediateOperation,
    isStateResilienceLongOperation,
    type HostStateResilienceDispatchContext,
    type ImmediateStateResilienceRequest,
    type LongStateResilienceRequest,
} from "../src/state-resilience-dispatch";
import { fakeCoreWith } from "./support/host-test-fixtures";

const BACKUP_ID = "00000000-0000-4000-8000-000000000001" as UuidV4;
const RESTORE_ID = "00000000-0000-4000-8000-000000000002" as UuidV4;
const DIGEST = `sha256:${"a".repeat(64)}` as Sha256Digest;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}` as Sha256Digest;

function complete<T>(value: T): CoreResult<T> {
    return { status: "complete", value, diagnostics: [] };
}

function failed<T>(): CoreResult<T> {
    return {
        status: "failed",
        diagnostics: [
            {
                severity: "error",
                code: "fixture.failed",
                operation: "restore",
                causeKind: "unavailable",
                retryable: false,
                suggestedActions: [],
                message: "fixture failure",
                traceId: "",
                path: "",
                rawSummary: "",
            },
        ],
    };
}

function backupPreparation(
    directoryState: StateBackupPreparationV1["destination"]["directoryState"] = "ready",
): StateBackupPreparationV1 {
    return {
        schemaVersion: 1,
        backupId: BACKUP_ID,
        createdAt: 10,
        destination: {
            destinationKind: "oaam_default",
            directoryPath: "/profile/backups",
            directoryState,
        },
        outputFileName: "oaam-backup.zip",
        encryptionMode: "none",
        sourceFileCount: 3,
        sourceLogicalBytes: 2_048,
        requiredAvailableBytes: 4_096,
        availableBytes: 8_192,
        sourceSnapshotFingerprint: DIGEST,
        destinationFingerprint: OTHER_DIGEST,
        preparationFingerprint: DIGEST,
    };
}

function backupArtifact(): StateBackupArtifactV1 {
    return {
        schemaVersion: 1,
        backupId: BACKUP_ID,
        createdAt: 10,
        archivePath: "/profile/backups/oaam-backup.zip",
        archiveByteSize: 1_024,
        archiveContentHash: DIGEST,
        manifestFingerprint: OTHER_DIGEST,
        sourceSnapshotFingerprint: DIGEST,
        encryptionMode: "none",
    };
}

function backupInventory(
    observation: StateBackupInventoryV1["entries"][number]["observation"] = "available",
): StateBackupInventoryV1 {
    return {
        schemaVersion: 1,
        entries: [
            {
                ...backupArtifact(),
                destinationKind: "oaam_default",
                observation,
            },
        ],
        totalKnownArchiveBytes: 1_024,
        totalAvailableArchiveBytes: observation === "available" ? 1_024 : 0,
    };
}

function restorePreparation(): StateRestorePreparationV1 {
    return {
        schemaVersion: 1,
        archivePath: "/profile/backups/oaam-backup.zip",
        archiveByteSize: 1_024,
        archiveContentHash: DIGEST,
        backupId: BACKUP_ID,
        backupCreatedAt: 10,
        encryptionMode: "none",
        sourceFileCount: 3,
        sourceLogicalBytes: 2_048,
        sourceSnapshotFingerprint: DIGEST,
        manifestFingerprint: OTHER_DIGEST,
        includesDesktopPreferences: true,
        preparationFingerprint: DIGEST,
    };
}

function restoreActivation(
    displacedState: StateRestoreActivationV1["displacedState"] = {
        state: "preserved",
        path: "/profile.displaced",
    },
): StateRestoreActivationV1 {
    return {
        schemaVersion: 1,
        restoreId: RESTORE_ID,
        backupId: BACKUP_ID,
        activatedAt: 20,
        restoredSourceSnapshotFingerprint: DIGEST,
        displacedState,
        restoreTransactionPath: "/profile.restore",
        requiresRestart: true,
        desktopPreferences: new Uint8Array([1, 2, 3]),
    };
}

function immediateRequest(request: ReturnType<typeof createProtocolRequest>): ImmediateStateResilienceRequest {
    return request as ImmediateStateResilienceRequest;
}

function longRequest(request: ReturnType<typeof createProtocolRequest>): LongStateResilienceRequest {
    return request as LongStateResilienceRequest;
}

interface ContextHarness {
    readonly context: HostStateResilienceDispatchContext;
    readonly consume: ReturnType<typeof vi.fn>;
    readonly recordStateBackup: ReturnType<typeof vi.fn>;
    readonly resolveStateBackup: ReturnType<typeof vi.fn>;
    readonly acceptStateBackup: ReturnType<typeof vi.fn>;
    readonly recordStateRestore: ReturnType<typeof vi.fn>;
    readonly resolveStateRestore: ReturnType<typeof vi.fn>;
    readonly acceptStateRestore: ReturnType<typeof vi.fn>;
    readonly readDesktopPreferences: ReturnType<typeof vi.fn>;
    readonly inspectStateRestore: ReturnType<typeof vi.fn>;
    readonly activateStateRestore: ReturnType<typeof vi.fn>;
    readonly applyRestoredDesktopPreferences: ReturnType<typeof vi.fn>;
    readonly restoreRequiresHostReplacement: ReturnType<typeof vi.fn>;
    readonly beginExclusiveRestore: ReturnType<typeof vi.fn>;
    readonly reportProgress: ReturnType<typeof vi.fn>;
    readonly afterTerminalCallbacks: Array<() => void>;
}

function contextHarness(): ContextHarness {
    const consume = vi.fn();
    const recordStateBackup = vi.fn(() => "backup-review-token");
    const resolveStateBackup = vi.fn(() => backupPreparation());
    const acceptStateBackup = vi.fn(() => true);
    const recordStateRestore = vi.fn(() => "restore-review-token");
    const resolveStateRestore = vi.fn(() => restorePreparation());
    const acceptStateRestore = vi.fn(() => true);
    const readDesktopPreferences = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const inspectStateRestore = vi.fn(async () => complete(restorePreparation()));
    const activateStateRestore = vi.fn(async (_input, control) => {
        await control.quiesceMutations();
        return complete(restoreActivation());
    });
    const applyRestoredDesktopPreferences = vi.fn(async () => undefined);
    const restoreRequiresHostReplacement = vi.fn();
    const beginExclusiveRestore = vi.fn(async () => undefined);
    const reportProgress = vi.fn();
    const afterTerminalCallbacks: Array<() => void> = [];
    const context = {
        connectionId: "connection-1",
        pathSelections: { consume },
        reviews: {
            recordStateBackup,
            resolveStateBackup,
            acceptStateBackup,
            recordStateRestore,
            resolveStateRestore,
            acceptStateRestore,
        },
        integration: {
            readDesktopPreferences,
            inspectStateRestore,
            activateStateRestore,
            applyRestoredDesktopPreferences,
            restoreRequiresHostReplacement,
        },
        operation: {
            operationId: "operation-1",
            reportProgress,
            afterTerminal: (callback: () => void) => afterTerminalCallbacks.push(callback),
        },
        beginExclusiveRestore,
    } as unknown as HostStateResilienceDispatchContext;
    return {
        context,
        consume,
        recordStateBackup,
        resolveStateBackup,
        acceptStateBackup,
        recordStateRestore,
        resolveStateRestore,
        acceptStateRestore,
        readDesktopPreferences,
        inspectStateRestore,
        activateStateRestore,
        applyRestoredDesktopPreferences,
        restoreRequiresHostReplacement,
        beginExclusiveRestore,
        reportProgress,
        afterTerminalCallbacks,
    };
}

describe("State resilience Host dispatch", () => {
    it("recognizes exactly the installed immediate and long operations", () => {
        expect(isStateResilienceImmediateOperation("state_backup.list")).toBe(true);
        expect(isStateResilienceImmediateOperation("asset.list")).toBe(false);
        expect(isStateResilienceLongOperation("state_restore.activate")).toBe(true);
        expect(isStateResilienceLongOperation("asset.reindex")).toBe(false);
    });

    it("fails closed if a Core-bound State operation reaches a recovery-only dispatcher", async () => {
        const backupInspect = contextHarness();
        expect(
            await dispatchStateResilienceLong(
                undefined,
                longRequest(
                    createProtocolRequest("1", "state_backup.inspect", {
                        destination: { destinationKind: "oaam_default" },
                        encryptionMode: "none",
                    }),
                ),
                backupInspect.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.state_backup_unavailable" }] });
        expect(backupInspect.readDesktopPreferences).not.toHaveBeenCalled();

        const backupCreate = contextHarness();
        expect(
            await dispatchStateResilienceLong(
                undefined,
                longRequest(
                    createProtocolRequest("2", "state_backup.create", {
                        backupReviewToken: "review",
                        userActionId: "user-action",
                    }),
                ),
                backupCreate.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.state_backup_unavailable" }] });
        expect(backupCreate.resolveStateBackup).not.toHaveBeenCalled();

        const inventoryRestore = contextHarness();
        expect(
            await dispatchStateResilienceLong(
                undefined,
                longRequest(
                    createProtocolRequest("3", "state_restore.inspect", {
                        source: { sourceKind: "inventory_backup", backupId: BACKUP_ID },
                    }),
                ),
                inventoryRestore.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.state_backup_unavailable" }] });
        expect(inventoryRestore.inspectStateRestore).not.toHaveBeenCalled();
    });

    it("routes all immediate operations and preserves policy CAS inputs", () => {
        const initialPolicy: StateBackupPromptPolicyV1 = {
            configVersion: 1,
            settingId: "state_backup_prompt_policy_v1",
            revision: 0,
            mode: "ask_every_time",
            updatedAt: 0,
            settingFingerprint: DIGEST,
        };
        const listStateBackups = vi.fn(() => complete(backupInventory()));
        const getStateBackupPromptPolicy = vi.fn(() => complete(initialPolicy));
        const replaceStateBackupPromptPolicy = vi.fn(() =>
            complete({
                ...initialPolicy,
                revision: 1,
                mode: "back_up_first" as const,
                userActionEvidenceId: "user-action",
                updatedAt: 20,
            }),
        );
        const core = fakeCoreWith({
            listStateBackups,
            getStateBackupPromptPolicy,
            replaceStateBackupPromptPolicy,
        });

        expect(
            dispatchStateResilienceImmediate(core, immediateRequest(createProtocolRequest("1", "state_backup.list", {}))),
        ).toMatchObject({ result: { status: "complete", value: { entries: [{ backupId: BACKUP_ID }] } } });
        expect(
            dispatchStateResilienceImmediate(
                core,
                immediateRequest(createProtocolRequest("2", "state_backup_prompt_policy.get", {})),
            ),
        ).toMatchObject({ result: { value: { mode: "ask_every_time" } } });
        expect(
            dispatchStateResilienceImmediate(
                core,
                immediateRequest(
                    createProtocolRequest("3", "state_backup_prompt_policy.replace", {
                        expectedRevision: 0,
                        expectedSettingFingerprint: "a".repeat(64),
                        mode: "back_up_first",
                        userActionId: "user-action",
                    }),
                ),
            ),
        ).toMatchObject({ result: { value: { revision: 1, mode: "back_up_first" } } });
        expect(replaceStateBackupPromptPolicy).toHaveBeenCalledWith({
            expectedRevision: 0,
            expectedSettingFingerprint: DIGEST,
            mode: "back_up_first",
            userActionId: "user-action",
        });
    });

    it("converts an immediate Core throw to a Host-owned failure", () => {
        const core = fakeCoreWith({
            listStateBackups: () => {
                throw new Error("private failure");
            },
        });
        expect(
            dispatchStateResilienceImmediate(core, immediateRequest(createProtocolRequest("1", "state_backup.list", {}))),
        ).toMatchObject({ result: { status: "failed", diagnostics: [{ code: "host.core_invocation_failed" }] } });
    });

    it("inspects a default backup with transient Desktop preferences and records the review", async () => {
        const harness = contextHarness();
        const inspectStateBackup = vi.fn((_input, observer) => {
            observer.report({ stage: "inventory", completedUnits: 1, totalUnits: 1 });
            return complete(backupPreparation());
        });
        const result = await dispatchStateResilienceLong(
            fakeCoreWith({ inspectStateBackup }),
            longRequest(
                createProtocolRequest("1", "state_backup.inspect", {
                    destination: { destinationKind: "oaam_default" },
                    encryptionMode: "none",
                }),
            ),
            harness.context,
        );

        expect(result).toMatchObject({ status: "complete", value: { backupReviewToken: "backup-review-token" } });
        expect(inspectStateBackup).toHaveBeenCalledWith(
            {
                destination: { destinationKind: "oaam_default" },
                encryptionMode: "none",
                desktopPreferences: new Uint8Array([1, 2, 3]),
            },
            { report: harness.reportProgress },
        );
        expect(harness.recordStateBackup).toHaveBeenCalledWith("connection-1", backupPreparation());
    });

    it("consumes a custom destination once and rejects an unavailable token", async () => {
        const accepted = contextHarness();
        accepted.consume.mockReturnValueOnce("/custom/backups");
        accepted.readDesktopPreferences.mockResolvedValueOnce(undefined);
        const inspectStateBackup = vi.fn(() =>
            complete({
                ...backupPreparation(),
                destination: {
                    destinationKind: "custom_directory" as const,
                    directoryPath: "/custom/backups",
                    directoryState: "ready" as const,
                },
            }),
        );
        const request = longRequest(
            createProtocolRequest("1", "state_backup.inspect", {
                destination: { destinationKind: "custom_directory", localPathSelectionToken: "path-token" },
                encryptionMode: "none",
            }),
        );
        expect(await dispatchStateResilienceLong(fakeCoreWith({ inspectStateBackup }), request, accepted.context)).toMatchObject({
            status: "complete",
        });
        expect(accepted.consume).toHaveBeenCalledWith("path-token", "backup_destination");
        expect(inspectStateBackup).toHaveBeenCalledWith(
            {
                destination: { destinationKind: "custom_directory", directoryPath: "/custom/backups" },
                encryptionMode: "none",
            },
            { report: accepted.reportProgress },
        );

        const rejected = contextHarness();
        rejected.consume.mockReturnValueOnce(null);
        expect(await dispatchStateResilienceLong(fakeCoreWith({ inspectStateBackup }), request, rejected.context)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "host.path_selection_unavailable" }],
        });
        expect(inspectStateBackup).toHaveBeenCalledTimes(1);
    });

    it("creates a reviewed backup, forwards an optional password, and consumes only successful review records", async () => {
        const harness = contextHarness();
        const createStateBackup = vi.fn(async () => complete(backupArtifact()));
        const request = longRequest(
            createProtocolRequest("1", "state_backup.create", {
                backupReviewToken: "review",
                password: "password",
                userActionId: "user-action",
            }),
        );
        expect(await dispatchStateResilienceLong(fakeCoreWith({ createStateBackup }), request, harness.context)).toMatchObject({
            status: "complete",
            value: { backupId: BACKUP_ID },
        });
        expect(createStateBackup).toHaveBeenCalledWith(
            {
                preparation: backupPreparation(),
                desktopPreferences: new Uint8Array([1, 2, 3]),
                password: "password",
                userActionId: "user-action",
            },
            { report: harness.reportProgress },
        );
        expect(harness.acceptStateBackup).toHaveBeenCalledWith("review");

        harness.acceptStateBackup.mockClear();
        harness.readDesktopPreferences.mockResolvedValueOnce(undefined);
        createStateBackup.mockResolvedValueOnce(failed());
        const failedRequest = longRequest(
            createProtocolRequest("2", "state_backup.create", {
                backupReviewToken: "review",
                userActionId: "user-action",
            }),
        );
        expect(
            await dispatchStateResilienceLong(fakeCoreWith({ createStateBackup }), failedRequest, harness.context),
        ).toMatchObject({
            status: "failed",
        });
        expect(harness.acceptStateBackup).not.toHaveBeenCalled();
    });

    it("inspects a selected archive, reports bounded progress, and records the restore review", async () => {
        const harness = contextHarness();
        harness.consume.mockReturnValueOnce("/selected/backup.zip");
        const result = await dispatchStateResilienceLong(
            fakeCoreWith({}),
            longRequest(
                createProtocolRequest("1", "state_restore.inspect", {
                    source: { sourceKind: "selected_archive", localPathSelectionToken: "path-token" },
                    password: "password",
                }),
            ),
            harness.context,
        );

        expect(result).toMatchObject({ status: "complete", value: { restoreReviewToken: "restore-review-token" } });
        expect(harness.consume).toHaveBeenCalledWith("path-token", "restore_archive");
        expect(harness.inspectStateRestore).toHaveBeenCalledWith({
            archivePath: "/selected/backup.zip",
            password: "password",
        });
        expect(harness.reportProgress.mock.calls).toEqual([
            [{ stage: "inspection", completedUnits: 0, totalUnits: 1 }],
            [{ stage: "inspection", completedUnits: 1, totalUnits: 1 }],
        ]);
    });

    it("resolves only an available inventory backup and preserves inventory failures", async () => {
        const available = contextHarness();
        await dispatchStateResilienceLong(
            fakeCoreWith({ listStateBackups: () => complete(backupInventory()) }),
            longRequest(
                createProtocolRequest("1", "state_restore.inspect", {
                    source: { sourceKind: "inventory_backup", backupId: BACKUP_ID },
                }),
            ),
            available.context,
        );
        expect(available.inspectStateRestore).toHaveBeenCalledWith({
            archivePath: "/profile/backups/oaam-backup.zip",
        });

        const missing = contextHarness();
        expect(
            await dispatchStateResilienceLong(
                fakeCoreWith({ listStateBackups: () => complete(backupInventory("missing")) }),
                longRequest(
                    createProtocolRequest("2", "state_restore.inspect", {
                        source: { sourceKind: "inventory_backup", backupId: BACKUP_ID },
                    }),
                ),
                missing.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.state_backup_unavailable" }] });
        expect(missing.inspectStateRestore).not.toHaveBeenCalled();

        const inventoryFailure = contextHarness();
        expect(
            await dispatchStateResilienceLong(
                fakeCoreWith({ listStateBackups: () => failed() }),
                longRequest(
                    createProtocolRequest("3", "state_restore.inspect", {
                        source: { sourceKind: "inventory_backup", backupId: BACKUP_ID },
                    }),
                ),
                inventoryFailure.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "fixture.failed" }] });
    });

    it("does not issue a restore review when an inventory archive changes identity during inspection", async () => {
        const harness = contextHarness();
        harness.inspectStateRestore.mockResolvedValueOnce(
            complete({
                ...restorePreparation(),
                backupCreatedAt: 11,
            }),
        );
        const result = await dispatchStateResilienceLong(
            fakeCoreWith({ listStateBackups: () => complete(backupInventory()) }),
            longRequest(
                createProtocolRequest("1", "state_restore.inspect", {
                    source: { sourceKind: "inventory_backup", backupId: BACKUP_ID },
                }),
            ),
            harness.context,
        );

        expect(result).toMatchObject({ status: "failed", diagnostics: [{ code: "host.state_backup_unavailable" }] });
        expect(harness.recordStateRestore).not.toHaveBeenCalled();
    });

    it("activates a restore only after exclusive quiescence and signals replacement after terminal delivery", async () => {
        const harness = contextHarness();
        const result = await dispatchStateResilienceLong(
            fakeCoreWith({}),
            longRequest(
                createProtocolRequest("1", "state_restore.activate", {
                    restoreReviewToken: "review",
                    password: "password",
                    userActionId: "user-action",
                }),
            ),
            harness.context,
        );

        expect(result).toMatchObject({
            status: "complete",
            value: { restoredDesktopPreferences: true, requiresRestart: true },
        });
        expect(harness.activateStateRestore).toHaveBeenCalledWith(
            {
                preparation: restorePreparation(),
                password: "password",
                userActionId: "user-action",
            },
            { quiesceMutations: expect.any(Function) },
        );
        expect(harness.beginExclusiveRestore).toHaveBeenCalledWith("operation-1");
        expect(harness.applyRestoredDesktopPreferences).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "/profile.restore");
        expect(harness.acceptStateRestore).toHaveBeenCalledWith("review");
        expect(harness.afterTerminalCallbacks).toHaveLength(1);
        harness.afterTerminalCallbacks[0]?.();
        expect(harness.restoreRequiresHostReplacement).toHaveBeenCalledTimes(1);
        expect(harness.reportProgress.mock.calls.map(([progress]) => progress.stage)).toEqual([
            "activation",
            "quiescence",
            "quiescence",
            "activation",
            "restart_required",
        ]);
    });

    it("returns partial when Desktop preferences cannot be applied and complete when none were archived", async () => {
        const preferenceFailure = contextHarness();
        preferenceFailure.applyRestoredDesktopPreferences.mockRejectedValueOnce(new Error("preference failure"));
        expect(
            await dispatchStateResilienceLong(
                fakeCoreWith({}),
                longRequest(
                    createProtocolRequest("1", "state_restore.activate", {
                        restoreReviewToken: "review",
                        userActionId: "user-action",
                    }),
                ),
                preferenceFailure.context,
            ),
        ).toMatchObject({
            status: "partial",
            value: { restoredDesktopPreferences: false },
            diagnostics: [{ code: "restore.desktop_preferences_not_applied" }],
        });

        const withoutPreferences = contextHarness();
        withoutPreferences.activateStateRestore.mockImplementationOnce(async (_input, control) => {
            await control.quiesceMutations();
            const activation = restoreActivation();
            return complete({ ...activation, desktopPreferences: undefined });
        });
        expect(
            await dispatchStateResilienceLong(
                fakeCoreWith({}),
                longRequest(
                    createProtocolRequest("2", "state_restore.activate", {
                        restoreReviewToken: "review",
                        userActionId: "user-action",
                    }),
                ),
                withoutPreferences.context,
            ),
        ).toMatchObject({ status: "complete", value: { restoredDesktopPreferences: false } });
        expect(withoutPreferences.applyRestoredDesktopPreferences).not.toHaveBeenCalled();
    });

    it("preserves failed and partial restore outcomes without consuming failed review authority", async () => {
        const failedHarness = contextHarness();
        failedHarness.activateStateRestore.mockResolvedValueOnce(failed());
        expect(
            await dispatchStateResilienceLong(
                fakeCoreWith({}),
                longRequest(
                    createProtocolRequest("1", "state_restore.activate", {
                        restoreReviewToken: "review",
                        userActionId: "user-action",
                    }),
                ),
                failedHarness.context,
            ),
        ).toMatchObject({ status: "failed" });
        expect(failedHarness.acceptStateRestore).not.toHaveBeenCalled();

        const partialHarness = contextHarness();
        partialHarness.activateStateRestore.mockImplementationOnce(async (_input, control) => {
            await control.quiesceMutations();
            return {
                status: "partial",
                value: restoreActivation(),
                diagnostics: [
                    {
                        severity: "warning",
                        code: "fixture.partial",
                        operation: "restore",
                        causeKind: "partial",
                        retryable: true,
                        suggestedActions: ["retry"],
                        message: "partial",
                        traceId: "",
                        path: "",
                        rawSummary: "",
                    },
                ],
            };
        });
        expect(
            await dispatchStateResilienceLong(
                fakeCoreWith({}),
                longRequest(
                    createProtocolRequest("2", "state_restore.activate", {
                        restoreReviewToken: "review",
                        userActionId: "user-action",
                    }),
                ),
                partialHarness.context,
            ),
        ).toMatchObject({ status: "partial", diagnostics: [{ code: "fixture.partial" }] });
    });

    it("maps review, capacity, path-selection, and unexpected failures to exact Host diagnostics", async () => {
        const reviewFailure = contextHarness();
        reviewFailure.resolveStateBackup.mockImplementationOnce(() => {
            throw new HostReviewRecordUnavailableError("record");
        });
        expect(
            await dispatchStateResilienceLong(
                fakeCoreWith({}),
                longRequest(
                    createProtocolRequest("1", "state_backup.create", {
                        backupReviewToken: "review",
                        userActionId: "user-action",
                    }),
                ),
                reviewFailure.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.review_record_unavailable" }] });

        const capacityFailure = contextHarness();
        capacityFailure.recordStateBackup.mockImplementationOnce(() => {
            throw new HostReviewRecordCapacityError();
        });
        expect(
            await dispatchStateResilienceLong(
                fakeCoreWith({ inspectStateBackup: () => complete(backupPreparation()) }),
                longRequest(
                    createProtocolRequest("2", "state_backup.inspect", {
                        destination: { destinationKind: "oaam_default" },
                        encryptionMode: "none",
                    }),
                ),
                capacityFailure.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.review_record_capacity_exceeded" }] });

        const pathFailure = contextHarness();
        pathFailure.consume.mockReturnValueOnce(null);
        expect(
            await dispatchStateResilienceLong(
                fakeCoreWith({}),
                longRequest(
                    createProtocolRequest("3", "state_restore.inspect", {
                        source: { sourceKind: "selected_archive", localPathSelectionToken: "missing" },
                    }),
                ),
                pathFailure.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.path_selection_unavailable" }] });

        const invocationFailure = contextHarness();
        invocationFailure.readDesktopPreferences.mockRejectedValueOnce(new Error("private failure"));
        expect(
            await dispatchStateResilienceLong(
                fakeCoreWith({ inspectStateBackup: () => complete(backupPreparation()) }),
                longRequest(
                    createProtocolRequest("4", "state_backup.inspect", {
                        destination: { destinationKind: "oaam_default" },
                        encryptionMode: "none",
                    }),
                ),
                invocationFailure.context,
            ),
        ).toMatchObject({ status: "failed", diagnostics: [{ code: "host.core_invocation_failed" }] });
    });

    it("stores, validates, resolves, and accepts exact State review records", () => {
        let storedPayload: unknown;
        const put = vi.fn((input: { payload: unknown }) => {
            storedPayload = input.payload;
            return "review-token";
        });
        const get = vi.fn((_token: string, _kind: string, validate: (value: unknown) => boolean) =>
            validate(storedPayload) ? storedPayload : null,
        );
        const remove = vi.fn(() => true);
        const records = new HostReviewRecords({ put, get, remove } as never, () => "member");

        expect(records.recordStateBackup("connection", backupPreparation())).toBe("review-token");
        expect(records.resolveStateBackup("review-token")).toEqual(backupPreparation());
        expect(records.acceptStateBackup("review-token")).toBe(true);
        expect(put).toHaveBeenLastCalledWith(
            expect.objectContaining({ kind: "state_backup", ownerConnectionId: "connection", replacementKey: "state_backup" }),
        );

        expect(records.recordStateRestore("connection", restorePreparation())).toBe("review-token");
        expect(records.resolveStateRestore("review-token")).toEqual(restorePreparation());
        expect(records.acceptStateRestore("review-token")).toBe(true);
        expect(put).toHaveBeenLastCalledWith(
            expect.objectContaining({ kind: "state_restore", ownerConnectionId: "connection", replacementKey: "state_restore" }),
        );
    });

    it("rejects every malformed State review-record boundary instead of adopting partial payloads", () => {
        let storedPayload: unknown;
        const store = {
            put: vi.fn(),
            get: vi.fn((_token: string, _kind: string, validate: (value: unknown) => boolean) =>
                validate(storedPayload) ? storedPayload : null,
            ),
            remove: vi.fn(),
        };
        const records = new HostReviewRecords(store as never, () => "member");
        const invalidBackupRecords = [
            null,
            { recordKind: "state_backup", preparation: backupPreparation() },
            { recordKind: "state_restore", preparation: backupPreparation(), preparationFingerprint: DIGEST },
            { recordKind: "state_backup", preparation: backupPreparation(), preparationFingerprint: 1 },
            { recordKind: "state_backup", preparation: null, preparationFingerprint: DIGEST },
            {
                recordKind: "state_backup",
                preparation: backupPreparation(),
                preparationFingerprint: OTHER_DIGEST,
            },
        ];
        for (const invalid of invalidBackupRecords) {
            storedPayload = invalid;
            expect(() => records.resolveStateBackup("review")).toThrow(HostReviewRecordUnavailableError);
        }

        const invalidRestoreRecords = [
            null,
            { recordKind: "state_restore", preparation: restorePreparation() },
            { recordKind: "state_backup", preparation: restorePreparation(), preparationFingerprint: DIGEST },
            { recordKind: "state_restore", preparation: restorePreparation(), preparationFingerprint: 1 },
            { recordKind: "state_restore", preparation: null, preparationFingerprint: DIGEST },
            {
                recordKind: "state_restore",
                preparation: restorePreparation(),
                preparationFingerprint: OTHER_DIGEST,
            },
        ];
        for (const invalid of invalidRestoreRecords) {
            storedPayload = invalid;
            expect(() => records.resolveStateRestore("review")).toThrow(HostReviewRecordUnavailableError);
        }
    });
});
