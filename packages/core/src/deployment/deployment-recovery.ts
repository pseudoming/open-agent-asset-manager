/**
 * Deployment crash recovery: converge an unresolved journal to a consistent
 * runtime state using the commit-proof direction.
 *
 * Commit proof (CORE_DATA_MODEL_DRAFT §8.10 l.1046-1049):
 *   journal.transactionId == Deployment.committedTransactionId → commit=yes
 *   journal.transactionId != committedTransactionId (DB authoritative) → commit=no
 *   Deployment row missing / journal corrupt → commit=unknown (stop, do not touch runtime)
 *
 * commit=yes (converge-to-new): for each entry, if runtime is already at new →
 *   skip; if at old → write new (or delete if removal); if third value → stop.
 *   The success baseline was already written by the original success commit, so
 *   recovery only finishes any writes interrupted before that commit.
 *
 * commit=no (restore-to-old): for each entry, if runtime is already at old →
 *   skip; if at new → restore old (write oldBytes, or delete if oldHash==="" i.e.
 *   file did not exist pre-deploy; a zero-byte old file has oldHash!=="" and
 *   restores as an empty file); if third value → stop. Baseline is unchanged
 *   (the failed deploy never committed).
 *
 * commit=unknown / journal corrupt / any third value or I/O failure → blocked,
 *   journal left unresolved, runtime untouched.
 *
 * Action-time guard (R2-P0-2): recovery's per-target third-value detection
 * (read current hash, compare to old/new, stop if neither) IS the action-time
 * guard — the journal's old/new hashes are the safety baseline. No additional
 * CAS layer is needed.
 *
 * Scope (this module ONLY): given an unresolved txnId, derive target context
 * from the authoritative Deployment row, acquire ordered path locks, run the
 * short occupancy probe, determine commit direction, converge/restore runtime,
 * and resolve the journal on success. Out of scope: SQL mutations (never — no
 * commitDeploymentSuccess/updateDeployment), the freeze-gate trigger decision,
 * and building DeploymentView.
 *
 * Recovery does NOT write blocked-evidence to the DB — it returns a structured
 * result; the executor translates that into state changes.
 */

import { getCanonicalPhysicalAccessPathKind } from "@oaam/shared/paths";
import type { Database } from "better-sqlite3";
import type { UuidV4 } from "../contracts/primitives";
import { acquireAllLocks, computeDeploymentOperationKey, computePhysicalClosureKeys } from "../foundation/physical-path-locks";
import { isCanonicalTargetRootPath } from "../foundation/validators";
import type { DeploymentTargetTransactions } from "./deployment-target-transaction";
import { defaultTargetTransactionDependencies } from "./deployment-target-transaction-dependencies";
import { localTargetTransactions } from "./local-target-transaction";
import {
    getDeployment,
    getDeploymentFile,
    getDeploymentRenderSnapshot,
    getDeploymentResidualAuthority,
    type DeploymentRow,
} from "../persistence/state-db";
import {
    makeRemovalIntentFingerprint,
    parseAppliedRenderSnapshot,
    parseAppliedRenderSnapshotRef,
    parseDeploymentFileBaselineState,
    parseDeploymentResidualAuthorityRow,
} from "../render/deployment-render-authority";
import type { ReverseAcceptMarkerStore, ReverseAcceptPreparationIdentityV1 } from "../reverse/reverse-accept-marker";
import type { ActiveJournal, JournalEntry } from "./deployment-journal";
import { deleteJournal, getJournalDirectoryEntries, readJournal } from "./deployment-journal";
import { beginDeploymentProbeTx, findActivePathOccupiers, type ProbeTxHandle } from "./deployment-state-ops";
import { createTargetIo, type TargetIoContext } from "./deployment-target-io";

// ============================================================
// Public types
// ============================================================

export type RecoveryOutcome =
    | "recovered_to_new" // commit=yes: all targets converged to new
    | "recovered_to_old" // commit=no: all targets restored to old
    | "blocked"; // commit=unknown / journal corrupt / third value / I/O failure / deleteJournal failed

export interface RecoveryResult {
    outcome: RecoveryOutcome;
    /** Stable blocked recovery reason code when outcome === "blocked"; "" otherwise.
     *  One of the 6 frozen recovery reason codes (or "" when not blocked). */
    reasonCode: string;
    /** Whether the active journal was successfully resolved (deleted) by this
     *  recovery. false when blocked (journal left unresolved). */
    journalResolved: boolean;
}

/**
 * R1 reservation truth table. This is internal recovery evidence, never a
 * public DeploymentStage or client DTO.
 */
export type ReverseAcceptReservationRecoveryResult =
    | {
          reservationState: "marker_authoritative";
          locatorState: "matched" | "rebuilt";
          identity: ReverseAcceptPreparationIdentityV1;
      }
    | {
          reservationState: "marker_authoritative_locator_unavailable";
          identity: ReverseAcceptPreparationIdentityV1;
      }
    | {
          reservationState: "scoped_freeze";
          identity: ReverseAcceptPreparationIdentityV1;
      }
    | { reservationState: "global_freeze" };

/**
 * Reconcile one preparation ID discovered by the reverse marker/locator scan.
 * A valid marker is the sole state/identity authority and may repair a missing,
 * corrupt, or mismatched locator under the same Deployment operation mutex
 * used by ordinary deploy/recovery. A locator
 * supplies only freeze scope when the marker is unusable; neither source being
 * usable forces global freeze.
 */
export function recoverReverseAcceptReservation(
    markerStore: ReverseAcceptMarkerStore,
    transactionsRoot: string,
    preparationId: UuidV4,
): ReverseAcceptReservationRecoveryResult {
    const marker = markerStore.readMarker(preparationId);
    if (marker.state !== "available") {
        return classifyUnusableMarker(markerStore, preparationId);
    }
    const identity = marker.value.identity;
    const operationLock = acquireAllLocks(transactionsRoot, [computeDeploymentOperationKey(identity.deploymentId)]);
    if (operationLock === null) {
        return { reservationState: "marker_authoritative_locator_unavailable", identity };
    }
    try {
        const current = markerStore.readMarker(identity.preparationId);
        if (current.state !== "available") {
            return classifyUnusableMarker(markerStore, identity.preparationId);
        }
        if (current.value.identity.preparationIdentityFingerprint !== identity.preparationIdentityFingerprint) {
            return { reservationState: "global_freeze" };
        }
        try {
            return {
                reservationState: "marker_authoritative",
                locatorState: markerStore.repairLocatorFromMarker(current.value),
                identity: current.value.identity,
            };
        } catch {
            return {
                reservationState: "marker_authoritative_locator_unavailable",
                identity: current.value.identity,
            };
        }
    } finally {
        operationLock.release();
    }
}

function classifyUnusableMarker(
    markerStore: ReverseAcceptMarkerStore,
    preparationId: UuidV4,
): ReverseAcceptReservationRecoveryResult {
    const locator = markerStore.readLocator(preparationId);
    return locator.state === "available"
        ? { reservationState: "scoped_freeze", identity: locator.value.identity }
        : { reservationState: "global_freeze" };
}

// ============================================================
// Per-target outcome (internal)
// ============================================================

// ============================================================
// recoverDeployment
// ============================================================

/**
 * Recover a single unresolved journal. Determines commit direction by comparing
 * journal.transactionId with the Deployment's committedTransactionId, then
 * converges/restores each target. On success, resolves (deletes) the journal.
 *
 * The caller is responsible for the freeze-gate trigger decision and for
 * translating the returned result into Deployment state changes. It cannot
 * choose a target root or platform; production derives both from state DB.
 *
 * @returns RecoveryResult. Never throws for recovery-domain failures (corrupt
 *          journal, third value, I/O failure) — those map to outcome="blocked".
 *          May throw for programmer errors (invalid args).
 */
export function recoverDeployment(
    db: Database,
    transactionsRoot: string,
    txnId: string,
    targetExecution: DeploymentTargetTransactions,
): RecoveryResult {
    return recoverDeploymentProductionCore(db, transactionsRoot, txnId, () => undefined, acquireAllLocks, targetExecution);
}

/** Test-only orchestration seam for mutations after path locks are held. */
export function recoverDeploymentWithLocksForTest(
    db: Database,
    transactionsRoot: string,
    txnId: string,
    afterLocks: () => void,
    acquireLocks: typeof acquireAllLocks = acquireAllLocks,
): RecoveryResult {
    return recoverDeploymentProductionCore(db, transactionsRoot, txnId, afterLocks, acquireLocks, localTargetTransactions);
}

function recoverDeploymentProductionCore(
    db: Database,
    transactionsRoot: string,
    txnId: string,
    afterLocks: () => void,
    acquireLocks: typeof acquireAllLocks,
    targetExecution: DeploymentTargetTransactions,
): RecoveryResult {
    const initialJournal = readJournal(transactionsRoot, txnId);
    if (initialJournal === null) {
        return blocked("blocked_by_recovery_journal_corrupt", false);
    }
    const initialDeployment = getDeployment(db, initialJournal.deploymentId);
    if (initialDeployment === null || initialDeployment.deleted !== 0) {
        return blocked("blocked_by_recovery_state_unavailable", false);
    }
    if (!isCanonicalTargetRootPath(initialDeployment.targetRootPath, initialDeployment.platform)) {
        return blocked("blocked_by_recovery_state_unavailable", false);
    }
    // Legacy Windows-coordinate journals cannot acquire Linux physical identity
    // authority by changing execution routes. Preserve them before any target I/O.
    if (
        initialDeployment.platform === "wsl" &&
        getCanonicalPhysicalAccessPathKind(initialDeployment.targetRootPath) === "win32" &&
        (initialJournal.schemaVersion === 1 ||
            initialJournal.schemaVersion === 2 ||
            (initialJournal.schemaVersion === 4 && initialJournal.targetExecution.kind === "host"))
    )
        return blocked("blocked_by_recovery_target_unavailable", false);
    if (!targetExecution.ownsDeployment(initialDeployment)) {
        return blocked("blocked_by_recovery_state_unavailable", false);
    }
    if (!targetExecution.ownsJournal(initialJournal)) {
        return blocked(
            targetExecution.kind === "host" ? "blocked_by_recovery_target_unavailable" : "blocked_by_recovery_state_unavailable",
            false,
        );
    }
    let operationLock: ReturnType<typeof acquireAllLocks>;
    try {
        operationLock = acquireLocks(transactionsRoot, [computeDeploymentOperationKey(initialJournal.deploymentId)]);
    } catch {
        return blocked("blocked_by_recovery_target_unavailable", false);
    }
    if (operationLock === null) {
        return blocked("blocked_by_recovery_target_unavailable", false);
    }
    try {
        const minimumPhysicalKeys = computePhysicalClosureKeys(initialDeployment.platform, initialDeployment.targetRootPath, [
            ...initialJournal.entries.map((entry) => ({
                relativePath: entry.relativePath,
                entryKind: "file" as const,
                containingDirectoryBoundaries:
                    initialJournal.schemaVersion !== 1
                        ? initialJournal.managedDirectoryBoundaries.filter((boundary) =>
                              entry.relativePath.startsWith(`${boundary}/`),
                          )
                        : [],
            })),
            ...(initialJournal.schemaVersion !== 1
                ? initialJournal.directoryEntries.map((entry) => ({
                      relativePath: entry.relativePath,
                      entryKind: "directory" as const,
                      containingDirectoryBoundaries: initialJournal.managedDirectoryBoundaries.filter(
                          (boundary) => entry.relativePath === boundary || entry.relativePath.startsWith(`${boundary}/`),
                      ),
                  }))
                : []),
        ]);
        if (minimumPhysicalKeys.some((key) => !initialJournal.reservedPhysicalKeys.includes(key))) {
            return blocked("blocked_by_recovery_journal_corrupt", false);
        }
        let locks: ReturnType<typeof acquireAllLocks>;
        try {
            locks = acquireLocks(transactionsRoot, initialJournal.reservedPhysicalKeys);
        } catch {
            return blocked("blocked_by_recovery_target_unavailable", false);
        }
        if (locks === null) return blocked("blocked_by_recovery_target_unavailable", false);
        try {
            afterLocks();
            const journal = readJournal(transactionsRoot, txnId);
            const deployment = getDeployment(db, initialJournal.deploymentId);
            if (journal === null) return blocked("blocked_by_recovery_journal_corrupt", false);
            if (JSON.stringify(journal) !== JSON.stringify(initialJournal)) {
                return blocked("blocked_by_recovery_evidence_conflict", false);
            }
            if (
                deployment === null ||
                deployment.deleted !== 0 ||
                deployment.platform !== initialDeployment.platform ||
                deployment.platformInstanceId !== initialDeployment.platformInstanceId ||
                deployment.targetRootPath !== initialDeployment.targetRootPath
            ) {
                return blocked("blocked_by_recovery_state_unavailable", false);
            }
            const occupancy = probeRecoveryOccupancy(db, deployment, journal);
            if (occupancy === "occupied") {
                return blocked("blocked_by_recovery_evidence_conflict", false);
            }
            if (occupancy === "unavailable") {
                return blocked("blocked_by_recovery_state_unavailable", false);
            }
            const ctx = createTargetIo(deployment.targetRootPath);
            return recoverLoadedJournal(db, ctx, transactionsRoot, journal, deployment, deleteJournal, targetExecution);
        } finally {
            locks.release();
        }
    } finally {
        operationLock.release();
    }
}

/**
 * Test-only entry: allows tests to inject a faulting `deleteJournal` to
 * deterministically drive the "marker stuck → blocked" path without relying
 * on chmod-based FS injection. NOT exported via barrel; guarded by arch.
 */
export function recoverDeploymentForTest(
    db: Database,
    ctx: TargetIoContext,
    transactionsRoot: string,
    txnId: string,
    deleteJournalFn: typeof deleteJournal,
): RecoveryResult {
    return recoverDeploymentCore(db, ctx, transactionsRoot, txnId, deleteJournalFn);
}

function probeRecoveryOccupancy(
    db: Database,
    deployment: DeploymentRow,
    journal: ActiveJournal,
): "free" | "occupied" | "unavailable" {
    let probe: ProbeTxHandle;
    try {
        probe = beginDeploymentProbeTx(db);
    } catch {
        return "unavailable";
    }
    try {
        const occupier = findActivePathOccupiers(
            db,
            deployment.platform,
            deployment.targetRootPath,
            journal.entries.map((entry) => entry.relativePath),
            deployment.deploymentId,
        );
        if (occupier !== null) {
            probe.rollback();
            return "occupied";
        }
        probe.commit();
        return "free";
    } catch {
        try {
            probe.rollback();
        } catch {
            // Preserve fail-closed false; the connection state is unknown.
        }
        return "unavailable";
    }
}

function recoverDeploymentCore(
    db: Database,
    ctx: TargetIoContext,
    transactionsRoot: string,
    txnId: string,
    deleteJournalFn: typeof deleteJournal,
): RecoveryResult {
    // ===== Read journal (fail-closed on corrupt/missing) =====
    const journal = readJournal(transactionsRoot, txnId);
    if (journal === null) {
        return blocked("blocked_by_recovery_journal_corrupt", false);
    }

    // ===== Read deployment (fail-closed on missing) =====
    const deployment = getDeployment(db, journal.deploymentId);
    if (deployment === null || deployment.deleted !== 0) {
        return blocked("blocked_by_recovery_state_unavailable", false);
    }

    return recoverLoadedJournal(db, ctx, transactionsRoot, journal, deployment, deleteJournalFn, localTargetTransactions);
}

function recoverLoadedJournal(
    db: Database,
    ctx: TargetIoContext,
    transactionsRoot: string,
    journal: ActiveJournal,
    deployment: DeploymentRow,
    deleteJournalFn: typeof deleteJournal,
    targetExecution: DeploymentTargetTransactions,
): RecoveryResult {
    if (!targetExecution.ownsJournal(journal)) return blocked("blocked_by_recovery_target_unavailable", false);
    // Core alone determines the committed direction and validates durable State authority.
    const commitYes = journal.transactionId === deployment.committedTransactionId;
    if (!journalMatchesDatabaseAuthority(db, deployment, journal, commitYes)) {
        return blocked("blocked_by_recovery_state_unavailable", false);
    }
    const target = targetExecution.create({ ctx, transactionsRoot, deps: defaultTargetTransactionDependencies });
    const result = target.recover(journal, commitYes ? "new" : "old");
    if (result !== "done")
        return blocked(
            result === "third_value" ? "blocked_by_recovery_target_changed" : "blocked_by_recovery_target_unavailable",
            false,
        );
    return resolveJournal(
        transactionsRoot,
        journal.transactionId,
        commitYes ? "recovered_to_new" : "recovered_to_old",
        deleteJournalFn,
    );
}

/**
 * Bind internally valid journal bytes to the authoritative pre/post DB state.
 * This prevents a copied or stale journal from driving recovery merely because
 * its old/new hashes happen to be self-consistent.
 */
function journalMatchesDatabaseAuthority(
    db: Database,
    deployment: DeploymentRow,
    journal: ActiveJournal,
    commitYes: boolean,
): boolean {
    try {
        let committedSnapshotFingerprint = "";
        if (commitYes) {
            const ref = parseAppliedRenderSnapshotRef(deployment.appliedRenderSnapshotRef);
            if (ref.snapshotState !== "applied") return false;
            const snapshotRow = getDeploymentRenderSnapshot(db, journal.deploymentId, ref.snapshotFingerprint);
            if (snapshotRow === null || snapshotRow.deleted !== 0 || snapshotRow.deploymentId !== journal.deploymentId)
                return false;
            const snapshot = parseAppliedRenderSnapshot(snapshotRow.snapshotJson, ref.snapshotFingerprint);
            if (snapshot.snapshotState !== "applied") return false;
            if (snapshot.compilationFingerprint !== journal.compilationFingerprint) return false;
            committedSnapshotFingerprint = ref.snapshotFingerprint;
        }
        for (const entry of journal.entries) {
            const row = getDeploymentFile(db, journal.deploymentId, entry.relativePath);
            if (entry.entryAuthority === "explicit_unmanaged_replacement") {
                if (row !== null && row.deleted === 0) {
                    const baseline = parseDeploymentFileBaselineState(row.baselineState);
                    if (baseline.rowState !== "removed") return false;
                }
                continue;
            }
            if (!commitYes) {
                if (entry.oldHash === "") {
                    if (row !== null && row.deleted === 0) {
                        const baseline = parseDeploymentFileBaselineState(row.baselineState);
                        if (baseline.rowState !== "removed") return false;
                    }
                    continue;
                }
                if (row === null || row.deleted !== 0) return false;
                const baseline = parseDeploymentFileBaselineState(row.baselineState);
                if (baseline.rowState !== "active") return false;
                if (!activeBaselineMatchesJournalSide(baseline, entry, "old")) return false;
                continue;
            }
            if (row === null || row.deleted !== 0) return false;
            const baseline = parseDeploymentFileBaselineState(row.baselineState);
            if (entry.isRemoval) {
                if (baseline.rowState !== "removed" || row.observedState !== "missing") return false;
                const residualRow = getDeploymentResidualAuthority(db, baseline.latestResidualAuthorityId);
                if (residualRow === null || residualRow.deleted !== 0) return false;
                const residual = parseDeploymentResidualAuthorityRow({
                    residualAuthorityId: residualRow.residualAuthorityId,
                    residualAuthorityFingerprint: residualRow.residualAuthorityFingerprint as `sha256:${string}`,
                    deploymentId: residualRow.deploymentId as `${string}`,
                    relativePath: residualRow.relativePath,
                    authorityBody: residualRow.authorityBody,
                });
                if (
                    residual.deploymentId !== journal.deploymentId ||
                    residual.relativePath !== entry.relativePath ||
                    residual.appliedPayload.contentHash !== entry.oldHash ||
                    residual.appliedPayload.byteSize !== Buffer.from(entry.oldBytesBase64, "base64").length ||
                    residual.appliedExecutable !== entry.oldExecutable ||
                    residual.previousProvenance.provenanceFingerprint !== entry.oldProvenanceFingerprint ||
                    residual.previousProvenance.materializationFingerprint !== entry.oldMaterializationFingerprint ||
                    residual.removalIntentFingerprint !==
                        makeRemovalIntentFingerprint({
                            deploymentId: journal.deploymentId,
                            relativePath: entry.relativePath,
                            previousProvenanceFingerprint: entry.oldProvenanceFingerprint,
                            nextCompilationFingerprint: journal.compilationFingerprint as `sha256:${string}`,
                            reason: "absent_from_new_desired_set",
                        })
                )
                    return false;
                continue;
            }
            if (baseline.rowState !== "active" || row.observedState !== "present") return false;
            if (!activeBaselineMatchesJournalSide(baseline, entry, "new")) return false;
            if (row.observedContentHash !== entry.newHash || row.observedExecutable !== (entry.newExecutable ? 1 : 0))
                return false;
            if (baseline.provenance.appliedRenderSnapshotFingerprint !== committedSnapshotFingerprint) {
                return false;
            }
        }
        return true;
    } catch {
        return false;
    }
}

function activeBaselineMatchesJournalSide(
    baseline: Extract<ReturnType<typeof parseDeploymentFileBaselineState>, { rowState: "active" }>,
    entry: JournalEntry,
    side: "old" | "new",
): boolean {
    const hash = side === "old" ? entry.oldHash : entry.newHash;
    const bytes = side === "old" ? entry.oldBytesBase64 : entry.newBytesBase64;
    const executable = side === "old" ? entry.oldExecutable : entry.newExecutable;
    const provenance = side === "old" ? entry.oldProvenanceFingerprint : entry.newProvenanceFingerprint;
    const materialization = side === "old" ? entry.oldMaterializationFingerprint : entry.newMaterializationFingerprint;
    return (
        baseline.appliedPayload.contentHash === hash &&
        baseline.appliedPayload.byteSize === Buffer.from(bytes, "base64").length &&
        baseline.appliedExecutable === executable &&
        baseline.provenance.provenanceFingerprint === provenance &&
        baseline.provenance.materializationFingerprint === materialization
    );
}

// ============================================================
// Journal resolution + helpers
// ============================================================

/**
 * Resolve the journal after successful converge/restore. deleteJournal throws
 * if the marker cannot be removed (non-ENOENT) — in that case reservation
 * persists and recovery reports blocked (journal unresolved).
 */
function resolveJournal(
    transactionsRoot: string,
    txnId: string,
    outcome: "recovered_to_new" | "recovered_to_old",
    deleteJournalFn: typeof deleteJournal,
): RecoveryResult {
    try {
        deleteJournalFn(transactionsRoot, txnId);
    } catch {
        return blocked("blocked_by_recovery_state_unavailable", false);
    }
    return { outcome, reasonCode: "", journalResolved: true };
}

function blocked(reasonCode: string, journalResolved: boolean): RecoveryResult {
    return { outcome: "blocked", reasonCode, journalResolved };
}
