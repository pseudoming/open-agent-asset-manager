/**
 * Deployment executor — pure orchestrator.
 *
 * 串起 5 个已实现模块(locks/journal/target-io 拆 4/state-ops/recovery)成完整 deploy 流程。
 * executor 不含任何 SQL 字符串 / fs.* / base64 / test-only factory / db.prepare。
 * 所有 I/O 通过 target-io;所有 SQL 通过 state-ops / state-db;所有 journal 通过 journal 模块。
 *
 * 编排顺序(CORE_DATA_MODEL §8.10 生命周期 9 步 + §8.11 单 writer):
 *   1. read deployment row(missing/deleted → blockedPassive; MUST precede
 *      freeze gate so a deleted deployment with leftover journal does not get
 *      its row mutated by blocked() — audit Addition 20)
 *   2. freeze gate(scanJournals:matching 或 corrupt 非空 → blocked needs_recovery)
 *   3. load/strict-validate current Deployment authority and reopen every
 *      active durable baseline payload
 *   4. buildDeployEntries + buildRemovalEntries(纯构造)
 *   5. createTargetIo(生产 context)
 *   6. acquireAllLocks(OS 锁;失败 → blocked_target_locked)
 *   7. populateOldBytes(锁内快照 old bytes;read_failed → blocked)
 *   8. preflight executable old/new state through the selected Shared backend
 *   9. occupancy probe 短事务(beginDeploymentProbeTx + findActivePathOccupiers;占用 → blocked)
 *   10. publish strict journal(绑定compilation + old/new provenance/materialization;
 *      任何 runtime 写之前)
 *   11. casWriteAll(third_value → rollback + deleteJournal + conflict;write_failed → 留 journal + blocked)
 *   12. verifyAll(!ok → 留 journal + blocked_verification_failed)
 *   13. durable发布Deployment payload；commitDeploymentSuccess短事务原子提交
 *       AppliedInputs/render snapshot/active+removed baseline/residual/txn pointer
 *   14. deleteJournal + 释放锁(finally)
 *
 * Recovery 触发不在此(executor 只报 needs_recovery;CoreService 决定调 recoverDeployment)。
 */

import type { Database } from "better-sqlite3";
import * as crypto from "node:crypto";
import { readProjectManifest } from "../catalog/project-authority";
import type { TargetFileRenderProvenanceV1 } from "../contracts/deployment-authority";
import { bytesToBase64 } from "../foundation/crypto-bytes";
import { acquireAllLocks, computeDeploymentOperationKey, computePhysicalClosureKeys } from "../foundation/physical-path-locks";
import { isCanonicalTargetRootPath } from "../foundation/validators";
import type { DeploymentTargetTransactions, TargetTransactionFailure } from "./deployment-target-transaction";
import { getDeployment } from "../persistence/state-db";
import { openValidatedCompiledDeploymentPlan, type ValidatedCompiledDeploymentPlan } from "../render/render-compiler";
import type { OperationDiagnostic } from "../types";
import { blocked, blockedPassive, blockedRaw } from "./deployment-execution-blocked";
import { measureDeploymentStage } from "./deployment-stage-timing";
import {
    validateDeploymentExecutionAuthority,
    validateTargetPlanPaths,
    type DeploymentExecutionAuthorityV1,
} from "./deployment-execution-validation";
import {
    publishJournal,
    scanActiveJournalReservations,
    scanJournals,
    type ActiveJournalV2,
    type DirectoryJournal,
    type JournalEntry,
} from "./deployment-journal";
import { resolveManagedDirectoryBoundaryAuthority } from "./deployment-managed-directory-execution";
import { desiredManagedDirectoryPaths, managedDirectoryAncestorPaths } from "./deployment-managed-directory-graph";
import { publishDeploymentPayloads, readDeploymentPayload } from "./deployment-payload-store";
import type { ActiveDeploymentBaseline } from "./deployment-state-ops";
import {
    assertCurrentDeploymentInputs,
    beginDeploymentProbeTx,
    commitDeploymentSuccess,
    findActivePathOccupiers,
    loadDeploymentBaseline,
} from "./deployment-state-ops";
import { projectDeploymentSuccessAuthority } from "./deployment-success-projection";
import {
    defaultTargetTransactionDependencies,
    type TargetTransactionDependencies,
} from "./deployment-target-transaction-dependencies";
import { buildDeployEntries, buildRemovalEntries, buildUnmanagedRemovalEntries } from "./deployment-target-entries";
import { createTargetIo, type TargetIoContext } from "./deployment-target-io";
import type { TargetPlan } from "./deployment-target-plan";
import type { DeploymentRuntimeReplacementAuthorityV1 } from "./deployment-target-replacement";

export type { DeploymentExecutionAuthorityV1 } from "./deployment-execution-validation";

// ============================================================
// Public types (module-private; CoreService wraps into CoreResult<DeploymentView>)
// ============================================================

export type DeployOutcome = "committed" | "conflict" | "blocked";

export interface DeployResult {
    outcome: DeployOutcome;
    reasonCode: string;
    diagnostics: OperationDiagnostic[];
    transactionId: string;
}

// ============================================================
// Options
// ============================================================

export interface DeployExecutorOptions {
    db: Database;
    transactionsRoot: string;
    deploymentsRoot: string;
    projectsRoot?: string;
    deploymentId: string;
    now: () => number;
    /** Required physical transaction operations selected for this exact Deployment target. */
    targetExecution: DeploymentTargetTransactions;
}

/**
 * Test seam: optional overrides for the high-level module functions the
 * executor calls during the deploy flow. Production callers use
 * executeDeployment() which passes no overrides (all defaults = real modules).
 * Test callers use executeDeploymentForTest() to inject module-boundary results
 * (NOT fsHooks, NOT fs.*, NOT SQL — only the result objects the modules return).
 *
 * Each override has the same signature as the real module function. Tests
 * construct realistic result objects (e.g. CasBatchResult with stop=write_failed)
 * to drive executor's fault-mapping branches without touching real FS/SQL.
 */
export interface DeployDeps extends TargetTransactionDependencies {
    publishDeploymentPayloads: typeof publishDeploymentPayloads;
    scanActiveJournalReservations: typeof scanActiveJournalReservations;
}

/** Production deps: all real module functions. */
const DEFAULT_DEPS: DeployDeps = {
    ...defaultTargetTransactionDependencies,
    publishDeploymentPayloads,
    scanActiveJournalReservations,
};

// ============================================================
// executeDeployment (production)
// ============================================================

export function executeDeployment(
    opts: DeployExecutorOptions,
    compiledPlan: ValidatedCompiledDeploymentPlan,
    runtimeReplacementAuthority?: DeploymentRuntimeReplacementAuthorityV1,
): DeployResult {
    const compiled = openValidatedCompiledDeploymentPlan(compiledPlan);
    if (compiled.deploymentInput.deploymentId !== opts.deploymentId) {
        return blockedPassive("blocked_needs_support", "compiled plan belongs to another Deployment");
    }
    return executeDeploymentCore(
        opts,
        compiled.targetPlan,
        compiled.executionAuthority,
        runtimeReplacementAuthority,
        DEFAULT_DEPS,
    );
}

// ============================================================
// executeDeploymentCore (shared logic)
// ============================================================

function executeDeploymentCore(
    opts: DeployExecutorOptions,
    plan: TargetPlan,
    authority: DeploymentExecutionAuthorityV1,
    runtimeReplacementAuthority: DeploymentRuntimeReplacementAuthorityV1 | undefined,
    deps: DeployDeps,
): DeployResult {
    let operationLock: ReturnType<typeof acquireAllLocks>;
    try {
        operationLock = acquireAllLocks(opts.transactionsRoot, [computeDeploymentOperationKey(opts.deploymentId)]);
    } catch (error) {
        return blockedPassive("blocked_by_deploy_target_unavailable", `Deployment operation lock unavailable: ${String(error)}`);
    }
    if (operationLock === null) {
        return blockedPassive("blocked_by_deploy_target_locked", "another operation owns this Deployment");
    }
    try {
        return executeDeploymentUnderOperationLock(opts, plan, authority, runtimeReplacementAuthority, deps);
    } finally {
        operationLock.release();
    }
}

function executeDeploymentUnderOperationLock(
    opts: DeployExecutorOptions,
    plan: TargetPlan,
    authority: DeploymentExecutionAuthorityV1,
    runtimeReplacementAuthority: DeploymentRuntimeReplacementAuthorityV1 | undefined,
    deps: DeployDeps,
): DeployResult {
    const txnRoot = opts.transactionsRoot;
    const deploymentId = opts.deploymentId;

    // 1. read deployment row FIRST — missing/deleted must always take the
    // passive branch before any state-DB write (audit Addition 20). The freeze
    // gate (step 2) writes blockingEvidence via blocked(), which would mutate a
    // deleted row and violate "deleted=1 loses all active rights". A deleted
    // deployment with a leftover unresolved/corrupt journal must still go through
    // blockedPassive, not blocked.
    const dep = getDeployment(opts.db, deploymentId);
    if (dep === null || dep.deleted !== 0) {
        // Fix: do NOT write state for missing/deleted deployments.
        // blocked() would call updateDeployment on a deleted row, violating
        // deleted=1 loses active rights. Return a passive blocked result.
        return blockedPassive("blocked_needs_support", "deployment missing or deleted");
    }
    // 2. freeze gate (only reached for active deployments). An unresolved or
    // corrupt journal means a previous tx did not complete; the deployment is
    // frozen until recovery/人工解阻 clears it. Writes blockingEvidence +
    // Blocking evidence is Deployment operation state, not target-observation
    // freshness. A failed deploy must not overwrite the last scan attempt.
    const scan = scanJournals(txnRoot, deploymentId);
    if (scan.matchingTxnIds.length > 0 || scan.corruptTxnIds.length > 0) {
        return blocked(
            opts,
            deploymentId,
            "blocked_by_recovery_state_unavailable",
            `unresolved journal(s): matching=${scan.matchingTxnIds.length} corrupt=${scan.corruptTxnIds.length}`,
        );
    }

    // Every remaining validation failure records blocking evidence. It must
    // therefore run only after the active-journal freeze gate: unresolved
    // recovery authority forbids an ordinary validation path from mutating
    // the Deployment row, even when its target root or Project is also bad.
    if (!isCanonicalTargetRootPath(dep.targetRootPath, dep.platform)) {
        return blocked(
            opts,
            deploymentId,
            "blocked_needs_support",
            "deployment target root is not a canonical absolute path for its platform",
        );
    }
    if (dep.projectId !== "") {
        if (opts.projectsRoot === undefined) {
            return blocked(
                opts,
                deploymentId,
                "blocked_needs_support",
                "project-scoped deployment has no Project authority root",
            );
        }
        try {
            const project = readProjectManifest(opts.projectsRoot, dep.projectId);
            if (project === null || project.deleted) {
                return blocked(opts, deploymentId, "blocked_needs_support", "deployment Project is missing or deleted");
            }
        } catch (error) {
            return blocked(
                opts,
                deploymentId,
                "blocked_needs_support",
                `deployment Project authority is unavailable: ${String(error)}`,
            );
        }
    }

    // 2b. validate target plan paths (pre-write safety: reject ../, /abs, \,
    // empty, trailing /, NUL, AND non-canonical aliases like a//b.md that
    // would bypass single-writer raw-string occupancy/lock matching). Runs
    // before any lock/journal/write; baseline side is validated at 3b.
    const pathCheck = validateTargetPlanPaths(plan);
    if (pathCheck !== null) {
        return blocked(opts, deploymentId, "blocked_needs_support", pathCheck);
    }

    const authorityCheck = validateDeploymentExecutionAuthority(plan, authority);
    if (authorityCheck !== null) {
        return blocked(opts, deploymentId, "blocked_needs_support", authorityCheck);
    }
    try {
        assertCurrentDeploymentInputs(opts.db, deploymentId, authority.appliedInputsSnapshot);
    } catch (error) {
        return blocked(opts, deploymentId, "blocked_needs_support", `stale Deployment execution inputs: ${String(error)}`);
    }

    // 3. load baseline
    let baseline: ActiveDeploymentBaseline[];
    const baselineBytesByPath = new Map<string, Uint8Array>();
    try {
        baseline = loadDeploymentBaseline(opts.db, deploymentId);
        for (const row of baseline) {
            const bytes = readDeploymentPayload({
                deploymentsRoot: opts.deploymentsRoot,
                deploymentId,
                contentHash: row.baselineState.appliedPayload.contentHash,
                expectedByteSize: row.baselineState.appliedPayload.byteSize,
            });
            baselineBytesByPath.set(row.relativePath, bytes);
        }
    } catch (error) {
        return blocked(
            opts,
            deploymentId,
            "blocked_by_recovery_state_unavailable",
            `deployment baseline authority unavailable: ${String(error)}`,
        );
    }

    const baselineByRel = new Map(baseline.map((f) => [f.relativePath, f]));
    let managedBoundaryPaths: string[];
    try {
        managedBoundaryPaths = resolveManagedDirectoryBoundaryAuthority(plan, baseline, runtimeReplacementAuthority);
    } catch (error) {
        return blocked(opts, deploymentId, "blocked_needs_support", String(error));
    }
    const desiredDirectoryPaths = desiredManagedDirectoryPaths(plan);

    // 4. build entries
    const planRels = new Set(plan.targetFiles.map((t) => t.relativePath));
    const deployEntries = buildDeployEntries(plan, baselineByRel);
    const removalEntries = buildRemovalEntries(planRels, baseline);
    let unmanagedRemovalEntries: JournalEntry[];
    try {
        unmanagedRemovalEntries = buildUnmanagedRemovalEntries(
            runtimeReplacementAuthority,
            planRels,
            new Set(baselineByRel.keys()),
        );
    } catch (error) {
        return blocked(
            opts,
            deploymentId,
            "blocked_needs_support",
            `reviewed unmanaged removal closure is invalid: ${String(error)}`,
        );
    }
    const allEntries: JournalEntry[] = [...deployEntries, ...removalEntries, ...unmanagedRemovalEntries];
    for (const entry of allEntries) {
        const oldBytes = baselineBytesByPath.get(entry.relativePath);
        if (oldBytes !== undefined) entry.oldBytesBase64 = bytesToBase64(oldBytes);
    }
    const newProvenanceByPath = new Map(authority.targetFileProvenance.map((item) => [item.relativePath, item.provenance]));
    for (const entry of deployEntries) {
        const provenance = newProvenanceByPath.get(entry.relativePath) as TargetFileRenderProvenanceV1;
        entry.newProvenanceFingerprint = provenance.provenanceFingerprint;
        entry.newMaterializationFingerprint = provenance.materializationFingerprint;
    }

    // 5. create production ctx
    const ctx = createTargetIo(dep.targetRootPath);
    if (!opts.targetExecution.ownsDeployment(dep)) {
        return blocked(opts, deploymentId, "blocked_needs_support", "target execution does not match this Deployment slice");
    }

    // 6. acquire locks
    const outputUnits = new Map(authority.appliedRenderSnapshot.outputUnits.map((unit) => [unit.outputUnitFingerprint, unit]));
    const physicalKeys = computePhysicalClosureKeys(dep.platform, dep.targetRootPath, [
        // Reserve possible structural creations before observing their missing/present state.
        // These positions are not complete-directory inventory or removal boundaries.
        ...managedDirectoryAncestorPaths(plan.managedDirectoryBoundaries.map((boundary) => boundary.relativePath)).map(
            (relativePath) => ({
                relativePath,
                entryKind: "directory" as const,
            }),
        ),
        ...plan.targetFiles.map((file) => {
            // validateDeploymentExecutionAuthority already proved exact output-unit
            // membership before baseline reads or lock construction.
            const unit = outputUnits.get(
                file.outputUnitFingerprint,
            ) as (typeof authority.appliedRenderSnapshot.outputUnits)[number];
            return {
                relativePath: file.relativePath,
                entryKind: "file" as const,
                containingDirectoryBoundaries: unit.managedDirectoryBoundaries
                    .map((boundary) => boundary.relativePath)
                    .filter((boundary) => file.relativePath === boundary || file.relativePath.startsWith(`${boundary}/`)),
            };
        }),
        ...removalEntries.map((entry) => ({
            relativePath: entry.relativePath,
            entryKind: "file" as const,
            containingDirectoryBoundaries: (baselineByRel.get(entry.relativePath) as ActiveDeploymentBaseline)
                .managedDirectoryBoundaryPaths,
        })),
        ...unmanagedRemovalEntries.map((entry) => ({
            relativePath: entry.relativePath,
            entryKind: "file" as const,
            containingDirectoryBoundaries: managedBoundaryPaths.filter(
                (boundary) => entry.relativePath === boundary || entry.relativePath.startsWith(`${boundary}/`),
            ),
        })),
        ...(runtimeReplacementAuthority?.directoryRemovalPaths ?? []).map((relativePath) => ({
            relativePath,
            entryKind: "directory" as const,
            containingDirectoryBoundaries: managedBoundaryPaths.filter(
                (boundary) => relativePath === boundary || relativePath.startsWith(`${boundary}/`),
            ),
        })),
        ...desiredDirectoryPaths.map((relativePath) => ({
            relativePath,
            entryKind: "directory" as const,
            containingDirectoryBoundaries: managedBoundaryPaths.filter(
                (boundary) => relativePath === boundary || relativePath.startsWith(`${boundary}/`),
            ),
        })),
    ]);
    const locks = acquireAllLocks(txnRoot, physicalKeys);
    if (locks === null) {
        return blocked(opts, deploymentId, "blocked_by_deploy_target_locked", "could not acquire OS lock");
    }

    try {
        let reservationScan: ReturnType<typeof scanActiveJournalReservations>;
        try {
            reservationScan = deps.scanActiveJournalReservations(txnRoot);
        } catch (error) {
            return blocked(
                opts,
                deploymentId,
                "blocked_by_recovery_state_unavailable",
                `journal reservation authority unavailable: ${String(error)}`,
            );
        }
        if (reservationScan.corruptTxnIds.length > 0) {
            return blocked(
                opts,
                deploymentId,
                "blocked_by_recovery_state_unavailable",
                "a corrupt journal prevents proving the target reservation set",
            );
        }
        const requestedKeys = new Set(physicalKeys);
        const occupier = reservationScan.journals.find((journal) =>
            journal.reservedPhysicalKeys.some((key) => requestedKeys.has(key)),
        );
        if (occupier !== undefined) {
            return blocked(
                opts,
                deploymentId,
                "blocked_by_deploy_target_locked",
                `unresolved transaction ${occupier.transactionId} reserves this target closure`,
            );
        }
        return executeInner(
            opts,
            deploymentId,
            dep,
            ctx,
            txnRoot,
            allEntries,
            plan,
            planRels,
            baselineByRel,
            authority,
            runtimeReplacementAuthority,
            managedBoundaryPaths,
            desiredDirectoryPaths,
            physicalKeys,
            deps,
        );
    } finally {
        locks.release();
    }
}

function executeInner(
    opts: DeployExecutorOptions,
    deploymentId: string,
    dep: {
        projectId: string;
        committedTransactionId: string;
        consumerAgentRuntimeIds: string;
        platform: string;
        targetRootPath: string;
    },
    ctx: TargetIoContext,
    txnRoot: string,
    entries: JournalEntry[],
    plan: TargetPlan,
    planRels: Set<string>,
    baselineByRel: Map<string, ActiveDeploymentBaseline>,
    authority: DeploymentExecutionAuthorityV1,
    runtimeReplacementAuthority: DeploymentRuntimeReplacementAuthorityV1 | undefined,
    managedBoundaryPaths: string[],
    desiredDirectoryPaths: string[],
    reservedPhysicalKeys: string[],
    deps: DeployDeps,
): DeployResult {
    // 7. populateOldBytes (lock held)
    const txnId = crypto.randomUUID();
    const projectRootPath =
        dep.projectId !== "" && opts.projectsRoot !== undefined
            ? readProjectManifest(opts.projectsRoot, dep.projectId)?.rootPath
            : undefined;
    const target = opts.targetExecution.create({ ctx, transactionsRoot: txnRoot, deps });
    const preparation = target.prepare({
        transactionId: txnId,
        ...(projectRootPath === undefined ? {} : { projectRootPath }),
        compilationFingerprint: authority.appliedRenderSnapshot.compilationFingerprint,
        entries,
        managedDirectoryBoundaries: managedBoundaryPaths,
        desiredDirectoryPaths,
        ...(runtimeReplacementAuthority === undefined ? {} : { runtimeReplacementAuthority }),
    });
    if (preparation.outcome !== "ready") return transactionFailure(opts, deploymentId, preparation);
    const prepared = preparation.prepared;
    entries = prepared.entries;
    const directoryEntries = prepared.directoryEntries;

    // 9. occupancy probe short tx (wrapped in try/catch for tx safety)
    const probeTx = beginDeploymentProbeTx(opts.db);
    try {
        const probeRels = [...planRels, ...entries.filter((e) => e.isRemoval).map((e) => e.relativePath)];
        const occupier = findActivePathOccupiers(opts.db, dep.platform, dep.targetRootPath, probeRels, deploymentId);
        if (occupier !== null) {
            probeTx.rollback();
            return blocked(
                opts,
                deploymentId,
                "blocked_by_deploy_target_locked",
                `path ${occupier.relativePath} owned by deployment ${occupier.deploymentId}`,
            );
        }
        probeTx.commit();
    } catch (err) {
        // Best-effort rollback; if rollback also fails, the original error is
        // more informative. Never continue to runtime write with a dangling tx.
        try {
            probeTx.rollback();
        } catch {
            // both commit and rollback failed — escalate with original error
        }
        throw err;
    }

    // 10. publish journal
    const journalBase: Omit<ActiveJournalV2, "schemaVersion"> = {
        transactionId: txnId,
        deploymentId,
        createdAt: opts.now(),
        compilationFingerprint: authority.appliedRenderSnapshot.compilationFingerprint,
        reservedPhysicalKeys,
        entries: entries.map((entry) => ({
            ...entry,
            entryAuthority: entry.entryAuthority ?? "managed_baseline",
        })),
        managedDirectoryBoundaries: managedBoundaryPaths,
        directoryEntries,
    };
    let journal: DirectoryJournal;
    try {
        journal = prepared.prepareJournal(journalBase);
    } catch (error) {
        return blocked(
            opts,
            deploymentId,
            "blocked_by_deploy_target_unavailable",
            `publication preparation failed: ${String(error)}`,
        );
    }
    publishJournal(txnRoot, journal);

    // 11. The selected implementation owns complete target execution; journal publication precedes every mutation.
    const written = measureDeploymentStage("publication", () => prepared.execute(journal));
    if (written.outcome === "conflict") {
        try {
            deps.deleteJournal(txnRoot, txnId);
        } catch {
            return blocked(
                opts,
                deploymentId,
                "blocked_by_deploy_target_unavailable",
                "conflict rollback completed but journal remains",
            );
        }
        return transactionFailure(opts, deploymentId, written);
    }
    if (written.outcome === "blocked") return transactionFailure(opts, deploymentId, written);
    journal = written.journal;

    // 12. Core independently requires exact compiled coverage before publishing State.
    const verify = measureDeploymentStage("verification", () => prepared.verify(journal));
    if (verify.outcome !== "verified") return transactionFailure(opts, deploymentId, verify);
    const expectedVerifiedPaths = plan.targetFiles.map((file) => file.relativePath).sort();
    const actualVerifiedPaths = verify.verified.map((file) => file.relativePath).sort();
    if (JSON.stringify(actualVerifiedPaths) !== JSON.stringify(expectedVerifiedPaths)) {
        throw new Error("verify success does not cover the exact compiled target path set");
    }

    // 13. commit success (single tx: baseline + txnId + observationState + snapshot)
    const projected = projectDeploymentSuccessAuthority({
        deploymentId,
        targetPlan: plan,
        executionAuthority: authority,
        baseline: [...baselineByRel.values()],
        verifiedActiveTargets: verify.verified,
        transactionId: txnId,
        now: opts.now(),
    });
    measureDeploymentStage("commit", () => {
        deps.publishDeploymentPayloads({
            deploymentsRoot: opts.deploymentsRoot,
            deploymentId,
            transactionId: txnId,
            payloads: projected.activePayloads,
        });
        commitDeploymentSuccess(opts.db, projected.successCommit);
    });

    // 14. delete journal — if marker cannot be removed after a successful commit,
    // the success baseline is already persisted (cannot undo); return committed
    // but with a diagnostic so the caller knows the reservation persists. Do NOT
    // throw — the deploy itself succeeded, and a crash here must not lose that.
    try {
        measureDeploymentStage("finalization", () => prepared.finalize(journal));
        measureDeploymentStage("journal_cleanup", () => deps.deleteJournal(txnRoot, txnId));
    } catch {
        return {
            outcome: "committed",
            reasonCode: "",
            diagnostics: [
                {
                    severity: "warning",
                    code: "journal_marker_stuck",
                    message: `deploy committed (txnId=${txnId}) but journal marker could not be removed; reservation persists until manual cleanup`,
                    operation: "deploy",
                    causeKind: "internal_error",
                    path: "",
                    traceId: "",
                    retryable: false,
                    suggestedActions: [],
                    rawSummary: "",
                },
            ],
            transactionId: txnId,
        };
    }

    return { outcome: "committed", reasonCode: "", diagnostics: [], transactionId: txnId };
}

function transactionFailure(opts: DeployExecutorOptions, deploymentId: string, failure: TargetTransactionFailure): DeployResult {
    if (failure.outcome === "conflict")
        return { outcome: "conflict", reasonCode: failure.reasonCode, diagnostics: [], transactionId: "" };
    return failure.diagnostics === undefined
        ? blocked(opts, deploymentId, failure.reasonCode, failure.message)
        : blockedRaw(opts, deploymentId, failure.reasonCode, failure.diagnostics, "");
}

// ============================================================
// Helpers
// ============================================================

// ============================================================
// TEST-ONLY entry — NOT exported via barrel; only test_deployment_executor.test.ts
// imports this. Arch guard (Group 9b) enforces no other core/src file uses it.
// ============================================================

/**
 * Test-only entry: execute a deploy with injected module-boundary result
 * overrides. Used to drive executor's fault-mapping branches (populateOldBytes
 * read_failed / casWriteAll write_failed / verifyAll !ok / deleteJournal throw)
 * without touching real FS/SQL. The overrides replace the HIGH-LEVEL module
 * functions only — they do NOT expose fsHooks, fs.*, db.prepare(), or any
 * internal target-io state. Tests construct realistic result objects matching
 * the module return types.
 */
export function executeDeploymentForTest(
    opts: DeployExecutorOptions,
    plan: TargetPlan,
    authority: DeploymentExecutionAuthorityV1,
    deps: Partial<DeployDeps>,
    runtimeReplacementAuthority?: DeploymentRuntimeReplacementAuthorityV1,
): DeployResult {
    return executeDeploymentCore(opts, plan, authority, runtimeReplacementAuthority, { ...DEFAULT_DEPS, ...deps });
}
