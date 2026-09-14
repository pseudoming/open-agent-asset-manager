import * as path from "node:path";
import {
    confirmDurableDirectoryNoFollow,
    durablePublishDirectory,
    durableReplaceFile,
    readDirectoryEntriesBounded,
    readRegularFileNoFollow,
    SafeFilesystemError,
} from "@oaam/shared/filesystem";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isUuidV4 } from "../foundation/validators";
import {
    buildRestoreMarker,
    isTerminalStateRestoreMarkerPhase,
    RESTORE_DISPLACED_NAME,
    RESTORE_MARKER_NAME,
    RESTORE_STAGED_NAME,
    serializeRestoreMarker,
    StateRestoreError,
    type StateRestoreMarkerPhase,
    type StateRestoreMarkerV1,
    validateStateRestoreMarkerDocument,
} from "./state-restore-model";

const MAXIMUM_RESTORE_PARENT_ENTRIES = 100_000;
const MAXIMUM_RESTORE_MARKER_BYTES = 1024 * 1024;
const MAXIMUM_RESTORE_DISCOVERY_ATTEMPTS = 16;
const PRESERVED_BACKUP_DIRECTORY = "backups";

export interface StateRestoreTransactionObservation {
    transactionName: string;
    transactionPath: string;
    markerPath: string;
    marker: StateRestoreMarkerV1;
}

export function restoreTransactionPrefix(oaamRoot: string): string {
    return `.${path.basename(oaamRoot)}.restore-txn-`;
}

export function scanStateRestoreTransactions(input: {
    oaamRoot: string;
    databasePath: string;
}): StateRestoreTransactionObservation[] {
    const oaamParent = path.dirname(input.oaamRoot);
    const prefix = restoreTransactionPrefix(input.oaamRoot);
    let entries: ReturnType<typeof readDirectoryEntriesBounded>;
    try {
        entries = readRestoreParentEntries(oaamParent);
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return [];
        throw error;
    }
    return entries
        .filter((entry) => entry.name.startsWith(prefix))
        .map((entry) => {
            const transactionPath = path.join(oaamParent, entry.name);
            if (entry.entryKind !== "directory") {
                throw transactionFailure(
                    "restore.transaction_entry_invalid",
                    "State restore transaction entry is not a no-follow directory",
                    transactionPath,
                );
            }
            confirmDurableDirectoryNoFollow(transactionPath);
            const restoreId = entry.name.slice(prefix.length);
            if (!isUuidV4(restoreId)) {
                throw transactionFailure(
                    "restore.transaction_name_invalid",
                    "State restore transaction directory does not carry an exact UUID v4 identity",
                    transactionPath,
                );
            }
            const markerPath = path.join(transactionPath, RESTORE_MARKER_NAME);
            const marker = readStateRestoreMarker(markerPath);
            assertMarkerLocation({
                marker,
                restoreId,
                oaamRoot: input.oaamRoot,
                databasePath: input.databasePath,
                transactionPath,
            });
            return {
                transactionName: entry.name,
                transactionPath,
                markerPath,
                marker,
            };
        })
        .sort((left, right) => compareUtf8Bytes(left.transactionName, right.transactionName));
}

function readRestoreParentEntries(
    oaamParent: string,
    readEntries: typeof readDirectoryEntriesBounded = readDirectoryEntriesBounded,
): ReturnType<typeof readDirectoryEntriesBounded> {
    let attempt = 0;
    for (;;) {
        attempt += 1;
        try {
            return readEntries(oaamParent, MAXIMUM_RESTORE_PARENT_ENTRIES);
        } catch (error) {
            if (
                !(error instanceof SafeFilesystemError) ||
                error.failureKind !== "stale" ||
                attempt === MAXIMUM_RESTORE_DISCOVERY_ATTEMPTS
            ) {
                throw error;
            }
        }
    }
}

export function blockingStateRestoreTransactions(
    transactions: readonly StateRestoreTransactionObservation[],
): StateRestoreTransactionObservation[] {
    return transactions.filter((transaction) => !isTerminalStateRestoreMarkerPhase(transaction.marker.phase));
}

export function writeStateRestoreMarkerPhase(
    observation: StateRestoreTransactionObservation,
    phase: StateRestoreMarkerPhase,
): StateRestoreTransactionObservation {
    const marker = buildRestoreMarker({
        restoreId: observation.marker.restoreId,
        backupId: observation.marker.backupId,
        archiveContentHash: observation.marker.archiveContentHash,
        sourceSnapshotFingerprint: observation.marker.sourceSnapshotFingerprint,
        profileSnapshotFingerprint: observation.marker.profileSnapshotFingerprint,
        oaamRoot: observation.marker.oaamRoot,
        databasePath: observation.marker.databasePath,
        transactionPath: observation.marker.transactionPath,
        stagedPath: observation.marker.stagedPath,
        displacedPath: observation.marker.displacedPath,
        phase,
    });
    durableReplaceFile(observation.markerPath, serializeRestoreMarker(marker));
    return { ...observation, marker };
}

export function carryForwardRestoreBackupDirectory(displacedPath: string, stagedPath: string): void {
    const displacedBackups = path.join(displacedPath, PRESERVED_BACKUP_DIRECTORY);
    try {
        confirmDurableDirectoryNoFollow(displacedBackups);
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return;
        if (error instanceof SafeFilesystemError && error.failureKind === "wrong_entry_type") return;
        throw error;
    }
    durablePublishDirectory(displacedBackups, stagedPath, PRESERVED_BACKUP_DIRECTORY);
}

export function readStateRestoreMarker(markerPath: string): StateRestoreMarkerV1 {
    let parsed: unknown;
    try {
        const bytes = readRegularFileNoFollow(markerPath, MAXIMUM_RESTORE_MARKER_BYTES).bytes;
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (error) {
        throw transactionFailure(
            "restore.marker_unreadable",
            `State restore transaction marker could not be read as strict UTF-8 JSON: ${String(error)}`,
            markerPath,
        );
    }
    return validateStateRestoreMarkerDocument(parsed);
}

function assertMarkerLocation(input: {
    marker: StateRestoreMarkerV1;
    restoreId: string;
    oaamRoot: string;
    databasePath: string;
    transactionPath: string;
}): void {
    if (
        input.marker.restoreId !== input.restoreId ||
        input.marker.oaamRoot !== input.oaamRoot ||
        input.marker.databasePath !== input.databasePath ||
        input.marker.transactionPath !== input.transactionPath ||
        input.marker.stagedPath !== path.join(input.transactionPath, RESTORE_STAGED_NAME) ||
        input.marker.displacedPath !== path.join(input.transactionPath, RESTORE_DISPLACED_NAME)
    ) {
        throw transactionFailure(
            "restore.marker_location_mismatch",
            "State restore transaction marker does not match its exact profile and filesystem location",
            input.transactionPath,
        );
    }
}

function transactionFailure(code: string, message: string, targetPath: string): StateRestoreError {
    return new StateRestoreError(code, message, "verification_failed", false, targetPath);
}

/** @internal Strict transaction-location mechanics exposed only to fault tests. */
export const stateRestoreTransactionInternalsForTest = Object.freeze({
    assertMarkerLocation,
    carryForwardRestoreBackupDirectory,
    readStateRestoreMarker,
    readRestoreParentEntries,
});
