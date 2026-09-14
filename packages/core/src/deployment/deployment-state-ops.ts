/**
 * Deployment SQL facade: occupancy probe + success commit + baseline load.
 *
 * This module concentrates ALL deployment-specific SQL (the one cross-table
 * occupancy query) behind high-level APIs so the executor never writes raw SQL,
 * never calls db.prepare(), and never holds a raw Statement. The `db` handle is
 * passed in as a dependency but the module returns only data, void, or a small
 * { commit, rollback } transaction handle.
 *
 * Three transaction boundaries (plan §4 — never span runtime FS writes):
 *   1. occupancy probe — short BEGIN IMMEDIATE; query other active deployments
 *      for path ownership; COMMIT (free) or ROLLBACK (busy) immediately. No
 *      runtime file I/O inside this tx.
 *   2. (no SQLite tx) runtime write/journal/verify phase — handled by
 *      target-io / journal modules outside any DB transaction.
 *   3. success commit — short db.transaction() inserting/reopening the exact
 *      render snapshot and cumulative residuals, replacing active/removed file
 *      baselines, and advancing AppliedInputs/current snapshot/transaction.
 *      Again no runtime file I/O inside.
 *
 * Scope (this module ONLY): SQL facade for deployment state. It reuses the
 * single-table CRUD from state-db.ts and adds the one composite occupancy query
 * plus the cross-table success authority transaction that state-db deliberately
 * does not own.
 *
 * Out of scope: runtime file I/O, journal files, OS locks, recovery decisions,
 * transactionId generation and AppliedInputs/render compilation construction
 * (the executor owns those inputs; this facade validates and commits them).
 *
 * v1 single-writer scope (§8.11 l.1739-1744): occupancy joins each validated
 * root + relative path into one lexical canonical absolute path before exact
 * platform comparison. Symlink / junction / Win32-WSL alias resolution is NOT
 * promised.
 */

import type { Database } from "better-sqlite3";
import type { VerifiedTarget } from "./deployment-target-verify";
import type {
    AppliedRenderSnapshotV1,
    DeploymentFileBaselineStateV1,
    DeploymentResidualRenderAuthorityV1,
    DurableAppliedPayloadRefV1,
    TargetFileRenderProvenanceV1,
} from "../contracts/deployment-authority";
import type { AppliedInputsSnapshotV1, PosixRelativePath } from "../types";
import {
    parseAppliedInputsSnapshot,
    parseAppliedRenderSnapshot,
    parseAppliedRenderSnapshotRef,
    parseDeploymentFileBaselineState,
    parseDeploymentResidualAuthorityRow,
    projectDeploymentFileAuthority,
    makeRemovalIntentFingerprint,
    serializeAppliedInputsSnapshot,
    serializeAppliedRenderSnapshot,
    serializeAppliedRenderSnapshotRef,
    serializeDeploymentFileBaselineState,
    serializeDeploymentResidualAuthorityBody,
    validateAppliedRenderSnapshot,
    validateDeploymentResidualAuthority,
    validateTargetFileRenderProvenance,
} from "../render/deployment-render-authority";
import { computeAppliedRenderSnapshotFingerprint, stableStringify } from "../foundation/fingerprint";
import { computePhysicalKey } from "../foundation/physical-path-locks";
import { isCanonicalRelativePath, isCanonicalTargetRootPath, isUuidV4 } from "../foundation/validators";
import {
    listDeploymentFiles,
    upsertDeploymentFile,
    updateDeployment,
    getDeployment,
    getDeploymentRenderSnapshot,
    getDeploymentResidualAuthority,
    insertDeploymentRenderSnapshot,
    insertDeploymentResidualAuthority,
    listDeploymentAssets,
    type DeploymentFileRow,
    type DeploymentRow,
} from "../persistence/state-db";

// ============================================================
// Public types
// ============================================================

/** A path ownership conflict found by the occupancy probe. */
export interface PathOccupier {
    /** The other active deployment that owns one of the probed paths. */
    deploymentId: string;
    /** The conflicting relative path (one of the probed set). */
    relativePath: string;
}

/** Handle for the occupancy-probe short transaction. The executor acquires OS
 *  locks, opens the probe tx, queries occupancy, then commits (path free) or
 *  rolls back (path busy). The handle is idempotent: calling commit() after
 *  rollback() (or vice versa, or twice) is a no-op after the first terminating
 *  call — it never leaves a dangling transaction. */
export interface ProbeTxHandle {
    /** Commit the probe transaction (path was free). No-op after first terminate. */
    commit(): void;
    /** Rollback the probe transaction (path was busy / aborting). No-op after first terminate. */
    rollback(): void;
}

// ============================================================
// loadDeploymentBaseline
// ============================================================

/**
 * Load the active (deleted=0) DeploymentFile rows for a deployment — the last
 * success baseline. Used by the executor as the CAS anchor source
 * (buildDeployEntries/buildRemovalEntries) and for removal-candidate computation.
 *
 * Returns only active rows (includeDeleted=false) so a stale CAS anchor from a
 * soft-deleted row cannot leak into target-io's build functions (audit N6).
 */
export type ActiveDeploymentBaseline = Omit<DeploymentFileRow, "baselineState"> & {
    baselineState: Extract<DeploymentFileBaselineStateV1, { rowState: "active" }>;
    /** Durable managed boundaries containing this exact baseline path. */
    managedDirectoryBoundaryPaths: PosixRelativePath[];
};

export function loadDeploymentBaseline(db: Database, deploymentId: string): ActiveDeploymentBaseline[] {
    const deployment = getDeployment(db, deploymentId);
    if (deployment === null || deployment.deleted !== 0) throw new Error("active Deployment not found");
    const currentSnapshotRef = validateCurrentSnapshotReference(db, deploymentId, deployment.appliedRenderSnapshotRef);
    const active: ActiveDeploymentBaseline[] = [];
    const currentRows = listDeploymentFiles(db, deploymentId, false);
    if (currentSnapshotRef.snapshotState === "never" && currentRows.length > 0) {
        throw new Error("a never-deployed Deployment cannot own current file baselines");
    }
    for (const row of currentRows) {
        const baseline = parseDeploymentFileBaselineState(row.baselineState);
        const observation = parsePhysicalObservation(row);
        projectDeploymentFileAuthority({
            deploymentFileId: row.deploymentFileId,
            relativePath: row.relativePath,
            baselineState: baseline,
            observation,
            observedAt: row.observedAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        });
        if (baseline.rowState === "removed") {
            const residualRow = getDeploymentResidualAuthority(db, baseline.latestResidualAuthorityId);
            if (residualRow === null || residualRow.deleted !== 0) {
                throw new Error("removed baseline points to a missing residual authority");
            }
            const residual = parseDeploymentResidualAuthorityRow({
                ...residualRow,
                residualAuthorityFingerprint: residualRow.residualAuthorityFingerprint as `sha256:${string}`,
                deploymentId: residualRow.deploymentId as `${string}`,
            });
            if (residual.deploymentId !== deploymentId || residual.relativePath !== row.relativePath) {
                throw new Error("removed baseline residual authority belongs to another owner/path");
            }
            continue;
        }
        const managedDirectoryBoundaryPaths = validateBaselineSnapshotProvenance(
            db,
            deploymentId,
            row.relativePath,
            baseline.provenance,
        );
        active.push({ ...row, baselineState: baseline, managedDirectoryBoundaryPaths });
    }
    return active;
}

// ============================================================
// Occupancy probe (short BEGIN IMMEDIATE transaction)
// ============================================================

/**
 * Open the occupancy-probe short transaction. The executor MUST hold the OS
 * locks (foundation/physical-path-locks) for all probed paths BEFORE calling this; the probe
 * tx is the SQLite-side reservation that pairs with the OS locks.
 *
 * The returned handle is a `BEGIN IMMEDIATE` transaction that the executor
 * terminates with commit() (path free → proceed) or rollback() (path busy /
 * abort → release locks + report blocked). The handle is idempotent so a
 * dangling transaction cannot be left by a double-call.
 *
 * NOTE: this only OPENS the tx + acquires the write lock. The actual occupancy
 * QUERY is a separate call (findActivePathOccupiers) so the executor can run it
 * inside the held tx. The query is stateless (reads committed rows); it does
 * not need the handle because better-sqlite3 transactions are connection-scoped
 * — once BEGIN IMMEDIATE is issued, subsequent statements on the same db run
 * inside it until COMMIT/ROLLBACK.
 */
export function beginDeploymentProbeTx(db: Database): ProbeTxHandle {
    db.exec("BEGIN IMMEDIATE");
    let terminated = false;
    const finish = (action: "COMMIT" | "ROLLBACK") => {
        if (terminated) return;
        // Audit fix (必修1): do NOT swallow COMMIT/ROLLBACK failures and do NOT
        // mark terminated before the exec succeeds. If COMMIT fails the executor
        // must learn (it cannot safely proceed to runtime writes on an unknown
        // tx state); if ROLLBACK fails the executor must learn (the reservation
        // is not released). terminated is set ONLY after a successful exec, so a
        // failed first call leaves the handle usable for a retry of the SAME
        // action (the executor's error path can attempt ROLLBACK after a failed
        // COMMIT, or re-try the same action).
        db.exec(action);
        terminated = true;
    };
    return {
        commit: () => finish("COMMIT"),
        rollback: () => finish("ROLLBACK"),
    };
}

/**
 * Query whether any OTHER active deployment owns one of the probed canonical
 * absolute paths on the given platform. Run this inside the probe tx (after
 * beginDeploymentProbeTx). Returns the first conflict found, or null if free.
 *
 * Root + relative path are joined lexically before comparison, so overlapping
 * roots cannot evade ownership (`/root` + `a/x` equals `/root/a` + `x`). No
 * symlink/junction/Win32-WSL alias resolution is promised (§8.11 l.1739-1744).
 *
 * Empty relativePaths → null immediately (nothing to probe).
 */
export function findActivePathOccupiers(
    db: Database,
    platform: string,
    targetRootPath: string,
    relativePaths: string[],
    selfDeploymentId: string,
): PathOccupier | null {
    if (relativePaths.length === 0) return null;
    const requestedByKey = new Map(
        relativePaths.map((relativePath) => [computePhysicalKey(platform, targetRootPath, relativePath), relativePath]),
    );
    const rows = db
        .prepare(
            `SELECT df.deployment_id AS deploymentId,
                    df.relative_path AS relativePath,
                    d.target_root_path AS targetRootPath
             FROM deployment_files df
             JOIN deployments d ON d.deployment_id = df.deployment_id
             WHERE d.platform = ?
               AND df.deleted = 0
               AND json_extract(df.baseline_state, '$.rowState') = 'active'
               AND d.deleted = 0
               AND df.deployment_id != ?`,
        )
        .all(platform, selfDeploymentId) as Array<{
        deploymentId: string;
        relativePath: string;
        targetRootPath: string;
    }>;
    for (const row of rows) {
        if (!isCanonicalTargetRootPath(row.targetRootPath, platform) || !isCanonicalRelativePath(row.relativePath)) {
            throw new Error("active path occupancy authority is not canonical");
        }
        const relativePath = requestedByKey.get(computePhysicalKey(platform, row.targetRootPath, row.relativePath));
        if (relativePath !== undefined) {
            return { deploymentId: row.deploymentId, relativePath };
        }
    }
    return null;
}

// ============================================================
// Success commit (short transaction)
// ============================================================

/**
 * Assert the deployment exists and is active (deleted=0) at the start of a
 * success commit. Throws if missing or soft-deleted — a commit must never
 * silently succeed against either (audit 必修2). Run inside the commit
 * transaction so the read is consistent with the writes that follow.
 */
function assertActiveDeploymentForCommit(db: Database, deploymentId: string): DeploymentRow {
    const row = getDeployment(db, deploymentId);
    if (row === null) {
        throw new Error(
            `commitDeploymentSuccess: deployment ${deploymentId} does not exist; refusing to commit a phantom success`,
        );
    }
    if (row.deleted !== 0) {
        throw new Error(
            `commitDeploymentSuccess: deployment ${deploymentId} is soft-deleted (deleted=1); a deleted deployment loses all active rights and must not gain a committedTransactionId`,
        );
    }
    return row;
}

/**
 * Commit a successful deployment in a single short transaction. Writes:
 *   - For each VerifiedTarget: UPSERT its DeploymentFile row with the new
 *     success baseline (durable payload/executable/provenance) and the trusted
 *     observation just produced by verify (observedState='present',
 *     observedContentHash, observedExecutable, observedAt=now). UPSERT preserves
 *     deploymentFileId/createdAt and restores deleted=0.
 *   - For each removal: insert/reopen its immutable residual authority and keep
 *     the current DeploymentFile row as rowState="removed" + observed missing.
 *   - Update the Deployment row: committedTransactionId = txnId,
 *     observationState = 'complete', appliedInputsSnapshot = snapshot, updatedAt = now.
 *
 * ATOMICITY (audit 必修, CORE_DATA_MODEL_DRAFT §8.10 l.1480/1638): the
 * appliedInputsSnapshot MUST be replaced in the SAME transaction as the file
 * baseline + committedTransactionId. Splitting them produces a half-applied
 * success (baseline updated but snapshot still reflects the prior input set),
 * which breaks "what AssetVersions/consumers produced the last success". So the
 * caller passes structured strict authorities; state-ops validates and
 * serializes AppliedInputs, the applied render snapshot, active/removed file
 * baselines and residual rows before writing all of them inside the tx. The
 * executor's earlier validation is a pre-write gate, not a substitute for the
 * persistence authority boundary checking its own input.
 *
 * No runtime file I/O happens inside this transaction. If it throws, nothing
 * is committed (better-sqlite3 rolls back the db.transaction on throw) — the
 * executor leaves the journal unresolved for recovery.
 *
 * `txnId` is the executor-generated transaction UUID (== the active journal's
 * transactionId). state-ops independently requires a canonical UUIDv4.
 */
export interface DeploymentSuccessActiveFileV1 {
    verified: VerifiedTarget;
    appliedPayload: DurableAppliedPayloadRefV1;
    provenance: TargetFileRenderProvenanceV1;
}

export interface DeploymentSuccessCommitInputV1 {
    deploymentId: string;
    verifiedActiveFiles: DeploymentSuccessActiveFileV1[];
    newlyRemoved: DeploymentResidualRenderAuthorityV1[];
    transactionId: string;
    appliedInputsSnapshot: AppliedInputsSnapshotV1;
    appliedRenderSnapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>;
    now: number;
}

export function commitDeploymentSuccess(db: Database, input: DeploymentSuccessCommitInputV1): void {
    if (!isUuidV4(input.transactionId)) {
        throw new Error("success transactionId must be a UUID v4");
    }
    if (!Number.isInteger(input.now) || input.now < 0) {
        throw new Error("success commit time must be a non-negative epoch millisecond");
    }
    const tx = db.transaction(() => {
        // Audit fix (必修2): a commit must never silently succeed against a
        // missing or soft-deleted deployment. updateDeployment does not check
        // affected rows, so without this guard an empty verified/removal commit
        // on a non-existent deployment would update 0 rows and return void —
        // the executor could then delete the journal thinking it committed.
        // A deleted deployment also loses all active rights (writer / reservation
        // / scheduling) and must not gain a committedTransactionId.
        const deployment = assertActiveDeploymentForCommit(db, input.deploymentId);
        if (input.now < deployment.observationAttemptedAt || input.now < deployment.updatedAt) {
            throw new Error("success commit time predates current Deployment authority");
        }
        const priorActiveByPath = new Map(loadDeploymentBaseline(db, input.deploymentId).map((row) => [row.relativePath, row]));
        assertCurrentDeploymentInputs(db, input.deploymentId, input.appliedInputsSnapshot, deployment);
        validateAppliedRenderSnapshot(input.appliedRenderSnapshot);
        const snapshotFingerprint = computeAppliedRenderSnapshotFingerprint(input.appliedRenderSnapshot);
        const snapshotJson = serializeAppliedRenderSnapshot(input.appliedRenderSnapshot);
        insertDeploymentRenderSnapshot(db, {
            snapshotFingerprint,
            deploymentId: input.deploymentId,
            snapshotJson,
            deleted: 0,
            createdAt: input.now,
            updatedAt: input.now,
        });
        const storedSnapshot = getDeploymentRenderSnapshot(db, input.deploymentId, snapshotFingerprint);
        // INSERT occurs through the DAO above; this SELECT verifies the
        // immutable row after ON CONFLICT DO NOTHING.
        /* istanbul ignore next -- @preserve: defensive-unreachable */
        if (!storedSnapshot) throw new Error("AppliedRenderSnapshot not found after insert");
        if (
            storedSnapshot.deploymentId !== input.deploymentId ||
            storedSnapshot.snapshotJson !== snapshotJson ||
            storedSnapshot.deleted !== 0
        ) {
            throw new Error("same AppliedRenderSnapshot fingerprint has a different authority body");
        }

        const seenPaths = new Set<string>();
        for (const file of input.verifiedActiveFiles) {
            const v = file.verified;
            if (seenPaths.has(v.relativePath)) throw new Error("duplicate success DeploymentFile path");
            seenPaths.add(v.relativePath);
            validateTargetFileRenderProvenance(file.provenance);
            if (file.provenance.appliedRenderSnapshotFingerprint !== snapshotFingerprint) {
                throw new Error("file provenance does not reference the committed render snapshot");
            }
            if (
                v.observedState !== "present" ||
                v.observedContentHash !== file.appliedPayload.contentHash ||
                v.appliedContentHash !== file.appliedPayload.contentHash ||
                v.observedExecutable !== v.appliedExecutable
            ) {
                throw new Error("verified active file does not match its durable payload baseline");
            }
            upsertDeploymentFile(
                db,
                input.deploymentId,
                v.relativePath,
                serializeDeploymentFileBaselineState({
                    rowState: "active",
                    appliedPayload: file.appliedPayload,
                    appliedExecutable: v.appliedExecutable,
                    provenance: file.provenance,
                }),
                v.observedState,
                v.observedContentHash,
                v.observedExecutable ? 1 : 0,
                input.now,
                input.now,
            );
        }
        for (const residual of input.newlyRemoved) {
            validateDeploymentResidualAuthority(residual);
            if (residual.deploymentId !== input.deploymentId) {
                throw new Error("residual authority belongs to another Deployment");
            }
            if (seenPaths.has(residual.relativePath)) {
                throw new Error("one path cannot be active and removed in the same success");
            }
            seenPaths.add(residual.relativePath);
            const prior = priorActiveByPath.get(residual.relativePath);
            if (prior === undefined) {
                throw new Error("a newly removed path must come from the current active baseline");
            }
            if (
                stableStringify(residual.appliedPayload) !== stableStringify(prior.baselineState.appliedPayload) ||
                residual.appliedExecutable !== prior.baselineState.appliedExecutable ||
                stableStringify(residual.previousProvenance) !== stableStringify(prior.baselineState.provenance) ||
                residual.removalIntentFingerprint !==
                    makeRemovalIntentFingerprint({
                        deploymentId: input.deploymentId as `${string}`,
                        relativePath: residual.relativePath,
                        previousProvenanceFingerprint: prior.baselineState.provenance.provenanceFingerprint,
                        nextCompilationFingerprint: input.appliedRenderSnapshot.compilationFingerprint,
                        reason: "absent_from_new_desired_set",
                    })
            ) {
                throw new Error("new residual does not prove this active baseline removal");
            }
            const authorityBody = serializeDeploymentResidualAuthorityBody(residual);
            insertDeploymentResidualAuthority(db, {
                residualAuthorityId: residual.residualAuthorityId,
                deploymentId: residual.deploymentId,
                relativePath: residual.relativePath,
                authorityBody,
                residualAuthorityFingerprint: residual.residualAuthorityFingerprint,
                deleted: 0,
                createdAt: input.now,
                updatedAt: input.now,
            });
            // INSERT occurs through the DAO above; this SELECT verifies the
            // immutable row after ON CONFLICT DO NOTHING.
            const stored = getDeploymentResidualAuthority(db, residual.residualAuthorityId);
            /* istanbul ignore next -- @preserve: defensive-unreachable */
            if (!stored) throw new Error("Deployment residual authority not found after insert");
            if (
                stored.deploymentId !== residual.deploymentId ||
                stored.relativePath !== residual.relativePath ||
                stored.authorityBody !== authorityBody ||
                stored.residualAuthorityFingerprint !== residual.residualAuthorityFingerprint ||
                stored.deleted !== 0
            ) {
                throw new Error("same residual authority ID has a different authority body");
            }
            upsertDeploymentFile(
                db,
                input.deploymentId,
                residual.relativePath,
                serializeDeploymentFileBaselineState({
                    rowState: "removed",
                    latestResidualAuthorityId: residual.residualAuthorityId,
                }),
                "missing",
                "",
                0,
                input.now,
                input.now,
            );
        }
        for (const relativePath of priorActiveByPath.keys()) {
            if (!seenPaths.has(relativePath)) {
                throw new Error("success result omitted a current active DeploymentFile path");
            }
        }
        updateDeployment(
            db,
            input.deploymentId,
            {
                committedTransactionId: input.transactionId,
                observationState: "complete",
                observationAttemptedAt: input.now,
                lastCompleteObservationAt: input.now,
                appliedInputsSnapshot: serializeAppliedInputsSnapshot(input.appliedInputsSnapshot),
                appliedRenderSnapshotRef: serializeAppliedRenderSnapshotRef({
                    snapshotState: "applied",
                    snapshotFingerprint,
                }),
                blockingEvidence: canonicalEmptyBlockingEvidence(),
            },
            input.now,
        );
    });
    tx();
}

export function assertCurrentDeploymentInputs(
    db: Database,
    deploymentId: string,
    appliedInputsSnapshot: AppliedInputsSnapshotV1,
    knownDeployment?: DeploymentRow,
): void {
    const deployment = knownDeployment ?? assertActiveDeploymentForCommit(db, deploymentId);
    const parsed = parseAppliedInputsSnapshot(serializeAppliedInputsSnapshot(appliedInputsSnapshot), deploymentId as `${string}`);
    if (parsed.consumerAgentRuntimeIds.length === 0) {
        throw new Error("a successful deployment must have at least one consumer agent runtime");
    }
    const consumers: unknown = JSON.parse(deployment.consumerAgentRuntimeIds);
    if (stableStringify(consumers) !== stableStringify(parsed.consumerAgentRuntimeIds)) {
        throw new Error("AppliedInputsSnapshot consumers do not match current Deployment intent");
    }
    const expectedAssets = listDeploymentAssets(db, deploymentId, false).map((row) => ({
        assetId: row.assetId,
        versionId: row.versionId,
        allowIncomplete: row.allowIncomplete === 1,
    }));
    if (stableStringify(expectedAssets) !== stableStringify(parsed.assets)) {
        throw new Error("AppliedInputsSnapshot assets do not match current Deployment inputs");
    }
}

function parsePhysicalObservation(row: DeploymentFileRow) {
    if (row.observedState === "missing") {
        if (row.observedContentHash !== "" || row.observedExecutable !== 0) {
            throw new Error("missing DeploymentFile observation has hidden physical values");
        }
        return { observedState: "missing" as const };
    }
    if (row.observedState === "present") {
        if (row.observedContentHash === "") {
            throw new Error("present DeploymentFile observation has no content hash");
        }
        return {
            observedState: "present" as const,
            observedContentHash: row.observedContentHash as `sha256:${string}`,
            observedExecutable: row.observedExecutable === 1,
        };
    }
    throw new Error("DeploymentFile observed_state is invalid");
}

function validateCurrentSnapshotReference(
    db: Database,
    deploymentId: string,
    snapshotRefJson: string,
): ReturnType<typeof parseAppliedRenderSnapshotRef> {
    const ref = parseAppliedRenderSnapshotRef(snapshotRefJson);
    if (ref.snapshotState === "never") return ref;
    const row = getDeploymentRenderSnapshot(db, deploymentId, ref.snapshotFingerprint);
    if (row === null || row.deleted !== 0 || row.deploymentId !== deploymentId) {
        throw new Error("current render snapshot reference is unresolved");
    }
    const snapshot = parseAppliedRenderSnapshot(row.snapshotJson, ref.snapshotFingerprint);
    if (snapshot.snapshotState !== "applied") {
        throw new Error("current render snapshot reference does not resolve to an applied snapshot");
    }
    return ref;
}

function validateBaselineSnapshotProvenance(
    db: Database,
    deploymentId: string,
    relativePath: string,
    provenance: TargetFileRenderProvenanceV1,
): PosixRelativePath[] {
    const row = getDeploymentRenderSnapshot(db, deploymentId, provenance.appliedRenderSnapshotFingerprint);
    if (row === null || row.deleted !== 0 || row.deploymentId !== deploymentId) {
        throw new Error("active baseline provenance references an unresolved snapshot");
    }
    const snapshot = parseAppliedRenderSnapshot(row.snapshotJson, provenance.appliedRenderSnapshotFingerprint);
    if (snapshot.snapshotState !== "applied") {
        throw new Error("active baseline provenance references a non-applied snapshot");
    }
    const units = snapshot.outputUnits.filter((unit) => unit.outputUnitFingerprint === provenance.outputUnitFingerprint);
    if (units.length !== 1) {
        throw new Error("active baseline provenance does not resolve exactly one output unit");
    }
    const unit = units[0] as (typeof units)[number];
    if (!unit.claims.some((claim) => claim.relativePath === relativePath)) {
        throw new Error("active baseline path is not claimed by its provenance output unit");
    }
    return unit.managedDirectoryBoundaries
        .map((boundary) => boundary.relativePath)
        .filter((boundary) => relativePath === boundary || relativePath.startsWith(`${boundary}/`));
}

function canonicalEmptyBlockingEvidence(): string {
    return JSON.stringify({
        schemaVersion: 1,
        reasonCode: "",
        operation: "",
        contextFingerprint: "",
        occurredAt: 0,
        diagnostics: [],
        suggestedActions: [],
        retryable: false,
    });
}
