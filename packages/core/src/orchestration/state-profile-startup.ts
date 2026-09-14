import * as path from "node:path";
import {
    assertStateProfileStartup,
    StateProfileRecoveryRequiredError,
    type StateProfileStartupClassification,
} from "../persistence/state-profile";
import { resolveDbPath } from "../persistence/db";
import {
    blockingStateRestoreTransactions,
    scanStateRestoreTransactions,
    type StateRestoreTransactionObservation,
} from "./state-restore-transactions";

export type StateProfileRestoreStartupClassification =
    | Exclude<StateProfileStartupClassification, { readonly state: "ready" }>
    | { readonly state: "ready"; readonly pendingRestore?: StateRestoreTransactionObservation };

/**
 * Join the Persistence-owned profile classification with the nearest
 * restore-transaction fact before Core opens a writable database.
 */
export function assertStateProfileRestoreStartup(input: {
    readonly oaamRoot: string;
    readonly databasePath?: string;
}): StateProfileRestoreStartupClassification {
    let profile: StateProfileStartupClassification;
    try {
        profile = assertStateProfileStartup(input);
    } catch (error) {
        if (!(error instanceof StateProfileRecoveryRequiredError) || error.reason !== "missing_database") throw error;
        const pendingRestore = pendingRestoreProjection(input.oaamRoot, error.databasePath);
        if (pendingRestore !== undefined) throwProjectionDatabaseFailure(error.databasePath, pendingRestore);
        throw error;
    }
    if (profile.state === "memory") return profile;
    const databasePath = resolveDbPath(input.databasePath);
    const pendingRestore = pendingRestoreProjection(input.oaamRoot, databasePath);
    if (pendingRestore === undefined) return profile;
    if (profile.state === "ready") return { state: "ready", pendingRestore };
    if (profile.state === "compatible_empty_rebuild") {
        throw new StateProfileRecoveryRequiredError({
            reason: "restore_reconciliation",
            databasePath,
            evidencePaths: [pendingRestore.transactionPath],
            detail: "OAAM state recovery is required because projection rebuild does not have a current State DB",
        });
    }
    throwProjectionDatabaseFailure(databasePath, pendingRestore);
}

function throwProjectionDatabaseFailure(databasePath: string, pendingRestore: StateRestoreTransactionObservation): never {
    throw new StateProfileRecoveryRequiredError({
        reason: "restore_reconciliation",
        databasePath,
        evidencePaths: [pendingRestore.transactionPath],
        detail: "OAAM state recovery is required because projection rebuild lost its State DB",
    });
}

function pendingRestoreProjection(oaamRoot: string, databasePath: string): StateRestoreTransactionObservation | undefined {
    let transactions: StateRestoreTransactionObservation[];
    try {
        transactions = blockingStateRestoreTransactions(scanStateRestoreTransactions({ oaamRoot, databasePath }));
    } catch (error) {
        throw new StateProfileRecoveryRequiredError({
            reason: "restore_reconciliation",
            databasePath,
            evidencePaths: [path.dirname(oaamRoot)],
            detail: `OAAM state recovery is required because the restore transaction inventory is invalid: ${String(error)}`,
            cause: error,
        });
    }
    if (transactions.length === 0) return undefined;
    if (transactions.length === 1 && transactions[0]?.marker.phase === "reprojecting") return transactions[0];
    throw new StateProfileRecoveryRequiredError({
        reason: "restore_reconciliation",
        databasePath,
        evidencePaths: transactions.map((transaction) => transaction.transactionPath),
        detail: "OAAM state recovery is required because a restore transaction has not reached projection rebuild",
    });
}

/** @internal Exact startup composition exposed only to fault tests. */
export const stateProfileRestoreStartupInternalsForTest = Object.freeze({
    pendingRestoreProjection,
});
