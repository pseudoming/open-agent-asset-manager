import * as path from "node:path";
import {
    confirmDurableDirectoryNoFollow,
    durablePublishDirectory,
    durableReplaceFile,
    lockFile,
    SafeFilesystemError,
} from "@oaam/shared/filesystem";
import { inspectStateDatabase, resolveDbPath } from "../persistence/db";
import { StateProfileRecoveryRequiredError } from "../persistence/state-profile";
import type { EpochMillis } from "../types";
import { captureRestoredProfileSource } from "./state-backup-source";
import {
    buildStateRestoreReopenReport,
    serializeStateRestoreReopenReport,
    STATE_RESTORE_REOPEN_REPORT_NAME,
} from "./state-restore-reopen-report";
import { StateRestoreError } from "./state-restore-model";
import {
    blockingStateRestoreTransactions,
    carryForwardRestoreBackupDirectory,
    scanStateRestoreTransactions,
    type StateRestoreTransactionObservation,
    writeStateRestoreMarkerPhase,
} from "./state-restore-transactions";

export interface StateRestoreStartupConfiguration {
    oaamRoot: string;
    databasePath?: string;
}

interface StateRestoreStartupTestConfiguration extends StateRestoreStartupConfiguration {
    now?: () => EpochMillis;
}

export type StateRestoreStartupReconciliation =
    | { state: "none" }
    | { state: "retained_current"; transactionPath: string }
    | { state: "projection_rebuild_required"; transactionPath: string };

/**
 * Converge only the physical restore pointer transition before ordinary Core
 * startup. Projection work remains Core-owned and happens before Host publish.
 */
export function reconcileStateRestoreBeforeStartup(source: StateRestoreStartupConfiguration): StateRestoreStartupReconciliation {
    const configuration = validateStartupConfiguration(source);
    try {
        return reconcileStateRestoreBeforeStartupValidated(configuration);
    } catch (error) {
        throw new StateProfileRecoveryRequiredError({
            reason: "restore_reconciliation",
            databasePath: configuration.databasePath,
            evidencePaths: [
                error instanceof StateRestoreError && error.targetPath.length > 0 ? error.targetPath : configuration.oaamParent,
            ],
            detail: `OAAM state recovery is required because restore reconciliation failed: ${String(error)}`,
            cause: error,
        });
    }
}

/** Test-only deterministic clock; not exported from the package barrel. */
export function reconcileStateRestoreBeforeStartupForTest(
    source: StateRestoreStartupTestConfiguration,
): StateRestoreStartupReconciliation {
    return reconcileStateRestoreBeforeStartupValidated(validateStartupConfiguration(source));
}

function reconcileStateRestoreBeforeStartupValidated(
    configuration: ValidatedStartupConfiguration,
): StateRestoreStartupReconciliation {
    const initial = blockingStateRestoreTransactions(scanStateRestoreTransactions(configuration));
    if (initial.length === 0) return { state: "none" };
    requireRestorableDatabasePath(configuration);
    if (initial.length !== 1) {
        throw reconciliationFailure(
            "restore.multiple_transactions",
            "multiple unresolved State restore transactions require manual support",
            configuration.oaamParent,
        );
    }
    const release = lockFile(configuration.restoreLockPath);
    if (release === null) {
        throw reconciliationFailure(
            "restore.operation_locked",
            "another process owns the State restore lock",
            configuration.restoreLockPath,
            "unavailable",
            true,
        );
    }
    try {
        const current = blockingStateRestoreTransactions(scanStateRestoreTransactions(configuration));
        return reconcileObservedTransaction(
            configuration,
            requireStableTransaction(initial[0] as StateRestoreTransactionObservation, current, configuration.oaamParent),
        );
    } finally {
        release();
    }
}

function requireStableTransaction(
    initial: StateRestoreTransactionObservation,
    current: readonly StateRestoreTransactionObservation[],
    oaamParent: string,
): StateRestoreTransactionObservation {
    if (current.length !== 1 || current[0]?.marker.restoreId !== initial.marker.restoreId) {
        throw reconciliationFailure(
            "restore.transaction_changed",
            "State restore transaction set changed while acquiring the startup lock",
            oaamParent,
            "conflict",
            true,
        );
    }
    return current[0];
}

interface ValidatedStartupConfiguration {
    oaamRoot: string;
    oaamParent: string;
    databasePath: string;
    databaseRelativePath: string;
    restoreLockPath: string;
    now: () => EpochMillis;
}

function validateStartupConfiguration(source: StateRestoreStartupTestConfiguration): ValidatedStartupConfiguration {
    const oaamRoot = requireCanonicalNonRootPath(source.oaamRoot, "oaamRoot");
    const databasePath = resolveDbPath(source.databasePath);
    const relative = path.relative(oaamRoot, databasePath);
    const oaamParent = path.dirname(oaamRoot);
    return {
        oaamRoot,
        oaamParent,
        databasePath,
        databaseRelativePath: relative,
        restoreLockPath: path.join(oaamParent, `.${path.basename(oaamRoot)}.restore.lock`),
        now: source.now ?? Date.now,
    };
}

function requireRestorableDatabasePath(configuration: ValidatedStartupConfiguration): void {
    const relative = configuration.databaseRelativePath;
    if (
        configuration.databasePath === ":memory:" ||
        relative.length === 0 ||
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        relative.split(path.sep).some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
        ["backups", "cache", "logs"].includes(relative.split(path.sep)[0] as string)
    ) {
        throw reconciliationFailure(
            "restore.database_path_unsupported",
            "State restore reconciliation requires the State DB inside the OAAM profile",
            configuration.databasePath,
            "unsupported",
        );
    }
}

function reconcileObservedTransaction(
    configuration: ValidatedStartupConfiguration,
    observation: StateRestoreTransactionObservation,
): StateRestoreStartupReconciliation {
    const live = directoryState(configuration.oaamRoot);
    const staged = directoryState(observation.marker.stagedPath);
    const displaced = directoryState(observation.marker.displacedPath);
    switch (observation.marker.phase) {
        case "staging":
            return retainUntouchedCurrent(configuration, observation, live, displaced);
        case "candidate_ready":
            if (live === "present" && staged === "present" && displaced === "missing") {
                return retainUntouchedCurrent(configuration, observation, live, displaced);
            }
            if (live === "present" && staged === "missing" && displaced === "missing") {
                verifyProfileFingerprint(
                    configuration.oaamRoot,
                    configuration.databasePath,
                    observation.marker.profileSnapshotFingerprint,
                );
                return beginProjectionRebuild(observation);
            }
            if (live === "missing" && staged === "present" && displaced === "present") {
                return completeStagedActivation(configuration, observation);
            }
            break;
        case "live_displaced":
            if (live === "missing" && staged === "present" && displaced === "present") {
                return completeStagedActivation(configuration, observation);
            }
            if (live === "present" && staged === "missing" && displaced === "present") {
                verifyProfileFingerprint(
                    configuration.oaamRoot,
                    configuration.databasePath,
                    observation.marker.profileSnapshotFingerprint,
                );
                return beginProjectionRebuild(observation);
            }
            break;
        case "activated":
            if (live === "present" && staged === "missing") {
                verifyProfileFingerprint(
                    configuration.oaamRoot,
                    configuration.databasePath,
                    observation.marker.profileSnapshotFingerprint,
                );
                return beginProjectionRebuild(observation);
            }
            break;
        case "reprojecting":
            requireCurrentStateDatabase(configuration.databasePath);
            return { state: "projection_rebuild_required", transactionPath: observation.transactionPath };
        case "aborted":
        case "reconciled":
            return { state: "none" };
    }
    throw reconciliationFailure(
        "restore.physical_state_ambiguous",
        `restore marker phase ${observation.marker.phase} does not match the exact live/staged/displaced state`,
        observation.transactionPath,
    );
}

function retainUntouchedCurrent(
    configuration: ValidatedStartupConfiguration,
    observation: StateRestoreTransactionObservation,
    live: "missing" | "present",
    displaced: "missing" | "present",
): StateRestoreStartupReconciliation {
    if (live !== "present" || displaced !== "missing") {
        throw reconciliationFailure(
            "restore.current_state_ambiguous",
            "an incomplete pre-activation restore does not leave one exact untouched live profile",
            observation.transactionPath,
        );
    }
    requireCurrentStateDatabase(configuration.databasePath);
    const report = buildStateRestoreReopenReport({
        restoreId: observation.marker.restoreId,
        backupId: observation.marker.backupId,
        outcome: "retained_current",
        completedAt: requireRestoreTime(configuration.now()),
        projection: { state: "not_run" },
        orphanEvidence: [],
        issues: [
            {
                code: "restore.incomplete_candidate_retained",
                message: "restore stopped before live authority displacement; staged evidence was retained",
                path: observation.transactionPath,
            },
        ],
    });
    durableReplaceFile(
        path.join(observation.transactionPath, STATE_RESTORE_REOPEN_REPORT_NAME),
        serializeStateRestoreReopenReport(report),
    );
    writeStateRestoreMarkerPhase(observation, "aborted");
    return { state: "retained_current", transactionPath: observation.transactionPath };
}

function completeStagedActivation(
    configuration: ValidatedStartupConfiguration,
    observation: StateRestoreTransactionObservation,
): StateRestoreStartupReconciliation {
    const stagedDatabasePath = path.join(observation.marker.stagedPath, configuration.databaseRelativePath);
    verifyProfileFingerprint(observation.marker.stagedPath, stagedDatabasePath, observation.marker.profileSnapshotFingerprint);
    const displaced = writeStateRestoreMarkerPhase(observation, "live_displaced");
    carryForwardRestoreBackupDirectory(displaced.marker.displacedPath, displaced.marker.stagedPath);
    durablePublishDirectory(displaced.marker.stagedPath, configuration.oaamParent, path.basename(configuration.oaamRoot));
    const activated = writeStateRestoreMarkerPhase(displaced, "activated");
    verifyProfileFingerprint(configuration.oaamRoot, configuration.databasePath, activated.marker.profileSnapshotFingerprint);
    return beginProjectionRebuild(activated);
}

function beginProjectionRebuild(observation: StateRestoreTransactionObservation): StateRestoreStartupReconciliation {
    const reprojecting = writeStateRestoreMarkerPhase(observation, "reprojecting");
    return { state: "projection_rebuild_required", transactionPath: reprojecting.transactionPath };
}

function verifyProfileFingerprint(oaamRoot: string, databasePath: string, expected: string): void {
    requireCurrentStateDatabase(databasePath);
    const source = captureRestoredProfileSource({ oaamRoot, databasePath });
    if (source.sourceSnapshotFingerprint !== expected) {
        throw reconciliationFailure(
            "restore.profile_fingerprint_mismatch",
            "restored profile no longer matches the activated backup closure",
            oaamRoot,
        );
    }
}

function requireCurrentStateDatabase(databasePath: string): void {
    if (inspectStateDatabase(databasePath).state === "current") return;
    throw reconciliationFailure(
        "restore.state_database_invalid",
        "restore reconciliation requires one current canonical State DB",
        databasePath,
    );
}

function directoryState(directoryPath: string): "missing" | "present" {
    try {
        confirmDurableDirectoryNoFollow(directoryPath);
        return "present";
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return "missing";
        throw error;
    }
}

function requireCanonicalNonRootPath(value: unknown, label: string): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.includes("\0") ||
        !path.isAbsolute(value) ||
        path.normalize(value) !== value ||
        value === path.parse(value).root ||
        value.endsWith(path.sep)
    ) {
        throw reconciliationFailure(
            "restore.configuration_invalid",
            `${label} must be a canonical non-root absolute path`,
            typeof value === "string" ? value : "",
            "invalid_schema",
        );
    }
    return value;
}

function requireRestoreTime(value: EpochMillis): EpochMillis {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw reconciliationFailure("restore.clock_invalid", "restore reconciliation clock is invalid", "", "internal_error");
}

function reconciliationFailure(
    code: string,
    message: string,
    targetPath: string,
    causeKind: StateRestoreError["causeKind"] = "verification_failed",
    retryable = false,
): StateRestoreError {
    return new StateRestoreError(code, message, causeKind, retryable, targetPath);
}

/** @internal Exact startup-state mechanics exposed only to fault tests. */
export const stateRestoreReconciliationInternalsForTest = Object.freeze({
    beginProjectionRebuild,
    completeStagedActivation,
    directoryState,
    reconcileObservedTransaction,
    requireStableTransaction,
    requireRestorableDatabasePath,
    requireRestoreTime,
    retainUntouchedCurrent,
    validateStartupConfiguration,
    verifyProfileFingerprint,
});
