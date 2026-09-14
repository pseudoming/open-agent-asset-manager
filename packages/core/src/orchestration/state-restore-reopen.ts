import * as path from "node:path";
import { durableReplaceFile, lockFile } from "@oaam/shared/filesystem";
import type { Database } from "better-sqlite3";
import { reindexAssets } from "../catalog/reindex";
import { reindexProjects } from "../catalog/reindex-projects";
import type { VersionDialectRegistryV1 } from "../catalog/version-authority";
import type { EpochMillis, StateRestoreReopenIssueV1, StateRestoreReopenReportV1 } from "../types";
import { scanStateRestoreOrphanEvidence } from "./state-restore-orphans";
import {
    buildStateRestoreReopenReport,
    serializeStateRestoreReopenReport,
    STATE_RESTORE_REOPEN_REPORT_NAME,
} from "./state-restore-reopen-report";
import { StateRestoreError } from "./state-restore-model";
import {
    blockingStateRestoreTransactions,
    scanStateRestoreTransactions,
    type StateRestoreTransactionObservation,
    writeStateRestoreMarkerPhase,
} from "./state-restore-transactions";

export function finalizeStateRestoreReopen(input: {
    db: Database;
    oaamRoot: string;
    databasePath: string;
    assetsRoot: string;
    projectsRoot: string;
    deploymentsRoot: string;
    transactionsRoot: string;
    dialectRegistry: VersionDialectRegistryV1;
    pendingRestore: StateRestoreTransactionObservation;
    now: () => EpochMillis;
}): StateRestoreReopenReportV1 {
    const restoreLockPath = path.join(path.dirname(input.oaamRoot), `.${path.basename(input.oaamRoot)}.restore.lock`);
    const release = lockFile(restoreLockPath);
    if (release === null) {
        throw reopenFailure("restore.operation_locked", "another process owns the State restore lock", restoreLockPath, true);
    }
    try {
        const pending = blockingStateRestoreTransactions(
            scanStateRestoreTransactions({ oaamRoot: input.oaamRoot, databasePath: input.databasePath }),
        );
        const current = pending[0];
        if (
            pending.length !== 1 ||
            current === undefined ||
            current.marker.restoreId !== input.pendingRestore.marker.restoreId ||
            current.marker.phase !== "reprojecting"
        ) {
            throw reopenFailure(
                "restore.transaction_changed",
                "State restore transaction changed before projection rebuild",
                input.pendingRestore.transactionPath,
                true,
            );
        }
        const assetReport = reindexAssets(input.assetsRoot, input.db, {
            includeDeleted: true,
            dialectRegistry: input.dialectRegistry,
        });
        const projectReport = reindexProjects(input.projectsRoot, input.db);
        const issues: StateRestoreReopenIssueV1[] = [...assetReport.diagnostics, ...projectReport.diagnostics].map(
            (diagnostic) => ({
                code: diagnostic.code,
                message: diagnostic.message,
                path: diagnostic.path,
            }),
        );
        const orphanEvidence = scanStateRestoreOrphanEvidence({
            db: input.db,
            deploymentsRoot: input.deploymentsRoot,
            transactionsRoot: input.transactionsRoot,
        });
        const report = buildStateRestoreReopenReport({
            restoreId: current.marker.restoreId,
            backupId: current.marker.backupId,
            outcome: "restored",
            completedAt: requireReopenTime(input.now()),
            projection: {
                state: issues.length === 0 ? "complete" : "partial",
                scannedAssets: assetReport.scannedAssets,
                indexedAssets: assetReport.indexedAssets,
                skippedAssets: assetReport.skippedAssets,
                scannedProjects: projectReport.scannedProjects,
                indexedProjects: projectReport.indexedProjects,
                skippedProjects: projectReport.skippedProjects,
            },
            orphanEvidence,
            issues,
        });
        durableReplaceFile(
            path.join(current.transactionPath, STATE_RESTORE_REOPEN_REPORT_NAME),
            serializeStateRestoreReopenReport(report),
        );
        writeStateRestoreMarkerPhase(current, "reconciled");
        return report;
    } finally {
        release();
    }
}

function requireReopenTime(value: EpochMillis): EpochMillis {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw reopenFailure("restore.clock_invalid", "State restore reopen clock is invalid", "", false);
}

function reopenFailure(code: string, message: string, targetPath: string, retryable: boolean): StateRestoreError {
    return new StateRestoreError(code, message, retryable ? "conflict" : "verification_failed", retryable, targetPath);
}

/** @internal Exact projection-finalization helpers exposed only to fault tests. */
export const stateRestoreReopenInternalsForTest = Object.freeze({
    requireReopenTime,
});
