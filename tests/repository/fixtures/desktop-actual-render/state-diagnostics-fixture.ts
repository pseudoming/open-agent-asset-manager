import { type ProtocolDiagnosticV1, type ProtocolOperationName, protocolDiagnosticSchema } from "@oaam/app-server-protocol";
import type { OaamDesktopBridge } from "../../../../packages/client/desktop/src/bridge/desktop-bridge";
import type {
    DesktopApplicationClientApi,
    DesktopLongOperationListener,
} from "../../../../packages/client/desktop/src/renderer/client";

const BACKUP_ID = "88888888-8888-4888-8888-888888888888";
const CREATED_BACKUP_ID = "99999999-9999-4999-8999-999999999999";
const RESTORE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

export const STATE_DIAGNOSTICS_FIXTURE_OPERATIONS: readonly ProtocolOperationName[] = Object.freeze([
    "state_backup.list",
    "state_backup_prompt_policy.get",
    "state_backup_prompt_policy.replace",
    "state_backup.inspect",
    "state_backup.create",
    "state_restore.inspect",
    "state_restore.activate",
    "diagnostics.health.get",
    "diagnostics.ordinary_log.settings.get",
    "diagnostics.ordinary_log.settings.replace",
    "diagnostics.ordinary_log.clear",
    "diagnostics.support_bundle.inspect",
    "diagnostics.support_bundle.export",
    "asset.reindex",
]);

function complete<T>(value: T) {
    return Object.freeze({ status: "complete" as const, value, diagnostics: Object.freeze([]) });
}

function failed(operation: ProtocolDiagnosticV1["operation"], message: string) {
    return Object.freeze({
        status: "failed" as const,
        diagnostics: Object.freeze([
            protocolDiagnosticSchema.parse({
                severity: "error" as const,
                code: "fixture.operation_failed",
                operation,
                causeKind: "internal_error" as const,
                retryable: true,
                suggestedActions: Object.freeze(["retry"] as const),
                message,
            }),
        ]),
    });
}

function recordFixtureAction(name: string): number {
    const key = `oaam${name}`;
    const count = Number.parseInt(document.documentElement.dataset[key] ?? "0", 10) + 1;
    document.documentElement.dataset[key] = String(count);
    return count;
}

function waitForRelease(eventName: string): Promise<void> {
    return new Promise((resolve) => {
        document.addEventListener(eventName, () => resolve(), { once: true });
    });
}

function backupEntry(backupId: string, path: string, createdAt: number) {
    return Object.freeze({
        schemaVersion: 1 as const,
        backupId,
        createdAt,
        archiveDisplayPath: path,
        archiveByteSize: 2_048,
        archiveContentHash: DIGEST_A,
        manifestFingerprint: DIGEST_B,
        sourceSnapshotFingerprint: DIGEST_A,
        encryptionMode: "none" as const,
        destinationKind: "oaam_default" as const,
        observation: "available" as const,
    });
}

const INITIAL_BACKUP = backupEntry(BACKUP_ID, "C:\\OAAM\\backups\\reviewed-state.zip", 10);
const CREATED_BACKUP = backupEntry(CREATED_BACKUP_ID, "C:\\OAAM\\backups\\created-state.zip", 20);

export function createStateDiagnosticsFixtureClient(enabled: boolean): Readonly<Partial<DesktopApplicationClientApi>> {
    if (!enabled) return Object.freeze({});
    let backupCreated = false;
    let activationCount = 0;
    let supportInspectionCount = 0;

    return Object.freeze({
        async listStateBackups() {
            const entries = backupCreated ? Object.freeze([CREATED_BACKUP, INITIAL_BACKUP]) : Object.freeze([INITIAL_BACKUP]);
            return complete({
                schemaVersion: 1 as const,
                entries,
                totalKnownArchiveBytes: entries.length * 2_048,
                totalAvailableArchiveBytes: entries.length * 2_048,
            });
        },
        async getStateBackupPromptPolicy() {
            return complete({
                configVersion: 1 as const,
                settingId: "state_backup_prompt_policy_v1" as const,
                revision: 1,
                mode: "ask_every_time" as const,
                updatedAt: 1,
                settingFingerprint: DIGEST_A,
            });
        },
        async replaceStateBackupPromptPolicy(input) {
            return complete({
                configVersion: 1 as const,
                settingId: "state_backup_prompt_policy_v1" as const,
                revision: 2,
                mode: input.mode,
                userActionEvidenceId: input.userActionId,
                updatedAt: 2,
                settingFingerprint: DIGEST_B,
            });
        },
        async inspectStateBackup(_input, listener?: DesktopLongOperationListener<"state_backup.inspect">) {
            recordFixtureAction("StateBackupInspectionCount");
            listener?.({
                status: "progress",
                operation: "state_backup.inspect",
                operationId: "actual-render-backup-inspect",
                sequence: 1,
                progress: { stage: "inventory", completedUnits: 1, totalUnits: 2 },
            });
            await waitForRelease("oaam-fixture-release-backup-inspect");
            return complete({
                backupReviewToken: "actual-render-backup-review",
                backupId: CREATED_BACKUP_ID,
                createdAt: 20,
                destinationKind: "oaam_default" as const,
                destinationDisplayPath: "C:\\OAAM\\backups",
                destinationState: "ready" as const,
                outputFileName: "created-state.zip",
                encryptionMode: "none" as const,
                sourceFileCount: 4,
                sourceLogicalBytes: 4_096,
                requiredAvailableBytes: 8_192,
                availableBytes: 1_048_576,
                sourceSnapshotFingerprint: DIGEST_A,
            });
        },
        async createStateBackup(_input, listener?: DesktopLongOperationListener<"state_backup.create">) {
            recordFixtureAction("StateBackupCreateCount");
            listener?.({
                status: "progress",
                operation: "state_backup.create",
                operationId: "actual-render-backup-create",
                sequence: 1,
                progress: { stage: "verification", completedUnits: 1, totalUnits: 2 },
            });
            await waitForRelease("oaam-fixture-release-backup-create");
            backupCreated = true;
            return complete({
                schemaVersion: 1 as const,
                backupId: CREATED_BACKUP_ID,
                createdAt: 20,
                archiveDisplayPath: CREATED_BACKUP.archiveDisplayPath,
                archiveByteSize: CREATED_BACKUP.archiveByteSize,
                archiveContentHash: DIGEST_A,
                manifestFingerprint: DIGEST_B,
                sourceSnapshotFingerprint: DIGEST_A,
                encryptionMode: "none" as const,
            });
        },
        async inspectStateRestore(_input, listener?: DesktopLongOperationListener<"state_restore.inspect">) {
            recordFixtureAction("StateRestoreInspectionCount");
            listener?.({
                status: "progress",
                operation: "state_restore.inspect",
                operationId: "actual-render-restore-inspect",
                sequence: 1,
                progress: { stage: "inspection", completedUnits: 1, totalUnits: 1 },
            });
            return complete({
                restoreReviewToken: `actual-render-restore-review-${String(activationCount + 1)}`,
                backupId: BACKUP_ID,
                backupCreatedAt: INITIAL_BACKUP.createdAt,
                archiveDisplayPath: INITIAL_BACKUP.archiveDisplayPath,
                archiveByteSize: INITIAL_BACKUP.archiveByteSize,
                archiveContentHash: DIGEST_A,
                encryptionMode: "none" as const,
                sourceFileCount: 4,
                sourceLogicalBytes: 4_096,
                sourceSnapshotFingerprint: DIGEST_A,
                manifestFingerprint: DIGEST_B,
                includesDesktopPreferences: true,
            });
        },
        async activateStateRestore(_input, listener?: DesktopLongOperationListener<"state_restore.activate">) {
            activationCount += 1;
            recordFixtureAction("StateRestoreActivationCount");
            listener?.({
                status: "progress",
                operation: "state_restore.activate",
                operationId: `actual-render-restore-activate-${String(activationCount)}`,
                sequence: 1,
                progress: { stage: "restart_required", completedUnits: 1, totalUnits: 1 },
            });
            if (activationCount === 1) return failed("restore", "fixture raw State activation failure");
            return complete({
                schemaVersion: 1 as const,
                restoreId: RESTORE_ID,
                backupId: BACKUP_ID,
                activatedAt: 30,
                restoredSourceSnapshotFingerprint: DIGEST_A,
                displacedState: Object.freeze({
                    state: "preserved" as const,
                    displayPath: "C:\\OAAM\\displaced-state",
                }),
                requiresRestart: true,
                restoredDesktopPreferences: true,
            });
        },
        async getDiagnosticsHealth() {
            return complete({
                schemaVersion: 1 as const,
                overallStatus: "healthy" as const,
                host: Object.freeze({ lifecycleState: "ready" as const, startupMode: "normal" as const }),
                ordinaryLog: Object.freeze({
                    state: "active" as const,
                    suspensionReason: "none" as const,
                    retainedBytes: 1_024,
                    maximumBytes: 10 * 1_024 * 1_024,
                    segmentCount: 1,
                }),
            });
        },
        async getOrdinaryLogSettings() {
            return complete({
                schemaVersion: 1 as const,
                enabled: true,
                retentionDays: 7,
                maximumBytes: 10 * 1_024 * 1_024,
            });
        },
        async replaceOrdinaryLogSettings(input) {
            return complete({ schemaVersion: 1 as const, ...input });
        },
        async clearOrdinaryLog() {
            return complete({
                removedSegmentCount: 1,
                removedBytes: 1_024,
                settings: Object.freeze({
                    schemaVersion: 1 as const,
                    enabled: true,
                    retentionDays: 7,
                    maximumBytes: 10 * 1_024 * 1_024,
                }),
            });
        },
        async inspectSupportBundle(_input) {
            supportInspectionCount += 1;
            recordFixtureAction("SupportInspectionCount");
            if (supportInspectionCount > 1) {
                return failed("host", "fixture raw support-bundle failure");
            }
            await waitForRelease("oaam-fixture-release-support-inspect");
            return complete({
                schemaVersion: 1 as const,
                supportBundleReviewToken: "actual-render-support-review",
                mode: "standard" as const,
                createdAt: 40,
                archiveByteLength: 2_048,
                archiveContentHash: DIGEST_A,
                entries: Object.freeze([
                    Object.freeze({
                        archivePath: "README.txt",
                        category: "documentation" as const,
                        byteLength: 128,
                    }),
                    Object.freeze({
                        archivePath: "diagnostics/health.json",
                        category: "health" as const,
                        byteLength: 256,
                    }),
                ]),
                ordinaryLog: Object.freeze({
                    retainedSegmentCount: 1,
                    includedSegmentCount: 1,
                    retainedBytes: 512,
                    includedBytes: 512,
                    truncated: false,
                }),
            });
        },
        async exportSupportBundle() {
            recordFixtureAction("SupportExportCount");
            return complete({
                schemaVersion: 1 as const,
                mode: "standard" as const,
                createdAt: 40,
                archiveByteLength: 2_048,
                archiveContentHash: DIGEST_A,
                entryCount: 2,
            });
        },
        async reindexAssets() {
            return complete({
                scannedAssets: 2,
                indexedAssets: 2,
                skippedAssets: 0,
                diagnostics: Object.freeze([]),
            });
        },
    });
}

export function createStateDiagnosticsFixtureBridge(enabled: boolean): Readonly<Partial<OaamDesktopBridge>> {
    if (!enabled) return Object.freeze({});
    let cacheClearCount = 0;

    return Object.freeze({
        async pickStateBackupDestination() {
            return { status: "cancelled" as const };
        },
        async selectRememberedStateBackupDestination() {
            return { status: "unavailable" as const };
        },
        async pickStateRestoreArchive() {
            return { status: "cancelled" as const };
        },
        async getStateResiliencePreferences() {
            return { schemaVersion: 1 as const };
        },
        async rememberStateBackupDestination() {
            return { schemaVersion: 1 as const };
        },
        async performStateBackupFileAction() {
            return { status: "complete" as const };
        },
        async pickSupportBundleExport() {
            return {
                status: "selected" as const,
                displayPath: "C:\\OAAM\\support\\reviewed-support.zip",
                localPathSelectionToken: "actual-render-support-path",
            };
        },
        async getDesktopMaintenance() {
            return {
                interfaceCache: Object.freeze({ status: "available" as const, byteSize: 2_048 }),
                dataLocations: Object.freeze([
                    Object.freeze({
                        locationId: "oaam_data" as const,
                        status: "available" as const,
                        displayPath: "C:\\OAAM",
                    }),
                    Object.freeze({
                        locationId: "desktop_profile" as const,
                        status: "available" as const,
                        displayPath: "C:\\Users\\Example\\AppData\\Roaming\\OAAM",
                    }),
                    Object.freeze({
                        locationId: "state_backups" as const,
                        status: "available" as const,
                        displayPath: "C:\\OAAM\\backups",
                    }),
                    Object.freeze({
                        locationId: "ordinary_logs" as const,
                        status: "available" as const,
                        displayPath: "C:\\OAAM\\logs",
                    }),
                    Object.freeze({
                        locationId: "interface_cache" as const,
                        status: "available" as const,
                        displayPath: "C:\\OAAM\\cache",
                    }),
                ]),
            };
        },
        async clearDesktopInterfaceCache() {
            cacheClearCount += 1;
            recordFixtureAction("MaintenanceCacheClearCount");
            return cacheClearCount === 1
                ? {
                      status: "complete" as const,
                      interfaceCache: Object.freeze({ status: "available" as const, byteSize: 0 }),
                  }
                : {
                      status: "failed" as const,
                      interfaceCache: Object.freeze({ status: "available" as const, byteSize: 0 }),
                  };
        },
        async performDesktopDataLocationAction() {
            return { status: "complete" as const };
        },
        async restoreDesktopInterfaceDefaults() {
            return {
                status: "complete" as const,
                presentation: "complete" as const,
                windowState: "complete" as const,
            };
        },
    });
}
