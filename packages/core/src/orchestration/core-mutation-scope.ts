/** Fail-closed recovery/scope preflight shared by every Phase-21 public mutation. */

import type { Database } from "better-sqlite3";
import { scanActiveJournalReservations, type ActiveJournalReservationScanResult } from "../deployment/deployment-journal";
import {
    reverseAcceptScanBlocksScope,
    scanReverseAcceptReservations,
    type ReverseAcceptReservationScanResult,
    type ReverseAcceptMarkerStore,
} from "../reverse/reverse-accept-marker";
import { getDeployment, listDeploymentAssets } from "../persistence/state-db";
import type { UuidV4 } from "../types";

export class CoreMutationScopeError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

export interface CoreMutationScope {
    assetIds: UuidV4[];
    settingsAuthority: boolean;
}

export interface CoreMutationScopeGate {
    /**
     * Reject already-published overlapping reservations before mutation locks are entered.
     * This is not a serialization lock: the owning mutation still relies on its authority
     * locks, fingerprints and CAS, while a later reverse preparation becomes stale.
     */
    assertMutationScope(scope: CoreMutationScope): void;
}

export function createCoreMutationScopeGate(input: {
    db: Database;
    transactionsRoot: string;
    reverseAcceptMarkerStore: ReverseAcceptMarkerStore;
}): CoreMutationScopeGate {
    return createGate(
        { db: input.db, transactionsRoot: input.transactionsRoot },
        () => scanActiveJournalReservations(input.transactionsRoot),
        () => scanReverseAcceptReservations(input.transactionsRoot, input.reverseAcceptMarkerStore),
    );
}

/** Test-only result seam; architecture tests forbid production imports. */
export function createCoreMutationScopeGateForTest(
    input: { db: Database; transactionsRoot: string },
    scanners: {
        scanDeploymentReservations(): ActiveJournalReservationScanResult;
        scanReverseReservations(): ReverseAcceptReservationScanResult;
    },
): CoreMutationScopeGate {
    return createGate(input, scanners.scanDeploymentReservations, scanners.scanReverseReservations);
}

function createGate(
    input: { db: Database; transactionsRoot: string },
    scanDeploymentReservations: () => ActiveJournalReservationScanResult,
    scanReverseReservations: () => ReverseAcceptReservationScanResult,
): CoreMutationScopeGate {
    return Object.freeze({
        assertMutationScope(scope: CoreMutationScope): void {
            const journals = scanDeploymentReservations();
            if (journals.corruptTxnIds.length > 0) {
                throw blocked(
                    "mutation_scope.corrupt_deployment_journal",
                    "a corrupt deployment journal prevents safe authority mutation",
                );
            }
            const requestedAssets = new Set(scope.assetIds);
            for (const journal of journals.journals) {
                if (getDeployment(input.db, journal.deploymentId) === null) {
                    throw blocked(
                        "mutation_scope.journal_deployment_missing",
                        "an active deployment journal has no durable Deployment authority",
                    );
                }
                if (listDeploymentAssets(input.db, journal.deploymentId, true).some((row) => requestedAssets.has(row.assetId))) {
                    throw blocked(
                        "mutation_scope.deployment_recovery_active",
                        "an overlapping Deployment has unresolved recovery authority",
                    );
                }
            }

            const reverse = scanReverseReservations();
            if (
                (scope.settingsAuthority && (reverse.globalFreeze || reverse.activePreparations.length > 0)) ||
                reverseAcceptScanBlocksScope(reverse, { assetIds: scope.assetIds })
            ) {
                throw blocked(
                    "mutation_scope.reverse_accept_active",
                    "an overlapping reverse-accept authority must be resolved first",
                );
            }
        },
    });
}

function blocked(code: string, message: string): CoreMutationScopeError {
    return new CoreMutationScopeError(code, message);
}
