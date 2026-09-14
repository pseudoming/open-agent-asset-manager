/** Phase-21 T5 durable target capture and provider reverse inspection. */

import { SafeFilesystemError } from "@oaam/shared/filesystem";
import { withDeploymentTargetOperations } from "./deployment-target-operations";
import type { AppliedRenderSnapshotV1 } from "../contracts/deployment-authority";
import type { RenderedTargetInspectionInput } from "../contracts/reverse";
import { scanJournals } from "../deployment/deployment-journal";
import {
    captureDeploymentObservationAttemptAnchor,
    commitDeploymentObservation,
    commitIncompleteDeploymentObservationAttempt,
} from "../deployment/deployment-observation-state-ops";
import { type ActiveDeploymentBaseline, loadDeploymentBaseline } from "../deployment/deployment-state-ops";
import type { DeploymentRuntimeReplacementAuthorityV1 } from "../deployment/deployment-target-replacement";
import { tryAcquireAuthorityLocks } from "../foundation/authority-locks";
import { stableStringify } from "../foundation/fingerprint";
import { acquireAllLocks, computeDeploymentOperationKey, computePhysicalClosureKeys } from "../foundation/physical-path-locks";
import { compareUtf8Bytes } from "../foundation/text-order";
import { getDeployment, getDeploymentRenderSnapshot } from "../persistence/state-db";
import {
    parseAppliedInputsSnapshot,
    parseAppliedRenderSnapshot,
    parseAppliedRenderSnapshotRef,
} from "../render/deployment-render-authority";
import { inspectRenderedTarget } from "../render/render-inspection";
import type { RenderRegistrySnapshot } from "../render/render-registry";
import type { CoreResult, DeploymentView, RenderedTargetInspectionResult, UuidV4 } from "../types";
import { listAdapterProviders, type dispatchInspectRenderedTarget } from "./adapter-registry";
import {
    captureDeploymentInspectionInput as captureInspectionInput,
    contentFromBytes,
    joinPhysicalTargetPath,
} from "./deployment-inspection-capture";
import { DeploymentInspectionFailure, deploymentInspectionFailure as failure } from "./deployment-inspection-errors";
import type { DeploymentRenderServiceConfiguration, DeploymentRenderServiceDependencies } from "./deployment-render-service";
import { loadRenderBaseAuthority, prepareRenderOperation } from "./deployment-render-service";
import type { RenderBaseAuthority, RenderOperationAuthority } from "./deployment-render-authority";
import { selectPlatformContext } from "./deployment-render-probe-snapshot";

interface AppliedTargetInspection {
    appliedRenderSnapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>;
    input: RenderedTargetInspectionInput;
    result: RenderedTargetInspectionResult;
    runtimeReplacementAuthority: DeploymentRuntimeReplacementAuthorityV1;
}

export interface DeploymentInspectionAuthorityV1 extends AppliedTargetInspection {
    base: RenderBaseAuthority;
    operation: RenderOperationAuthority;
}

export interface DeploymentInspectionService {
    inspectDeploymentRenderedTarget(deploymentId: UuidV4): Promise<CoreResult<RenderedTargetInspectionResult>>;
    scanDeployment(deploymentId: UuidV4): Promise<CoreResult<DeploymentView>>;
}

export interface DeploymentInspectionServiceDependencies extends DeploymentRenderServiceDependencies {
    dispatchInspection: typeof dispatchInspectRenderedTarget;
    resolveRetainedInspectionRegistry(adapterId: string, rendererVersion: string): RenderRegistrySnapshot | null;
    readDeploymentView(input: {
        db: DeploymentRenderServiceConfiguration["db"];
        transactionsRoot: string;
        deploymentId: UuidV4;
    }): DeploymentView | null;
}

export function createDeploymentInspectionService(
    configuration: DeploymentRenderServiceConfiguration,
    dependencies: DeploymentInspectionServiceDependencies,
): DeploymentInspectionService {
    const service: DeploymentInspectionService = {
        async inspectDeploymentRenderedTarget(deploymentId: UuidV4) {
            const inspected = await inspectManagedDeployment(deploymentId, configuration, dependencies, false);
            return inspected.status === "complete"
                ? {
                      status: "complete",
                      value: inspected.value.result,
                      diagnostics: inspected.diagnostics,
                  }
                : {
                      status: inspected.status,
                      value: undefined as unknown as RenderedTargetInspectionResult,
                      diagnostics: inspected.diagnostics,
                  };
        },
        async scanDeployment(deploymentId: UuidV4) {
            const attemptAnchor = captureDeploymentObservationAttemptAnchor(configuration.db, deploymentId);
            const inspected = await inspectManagedDeployment(deploymentId, configuration, dependencies, true);
            if (inspected.status !== "complete") {
                if (attemptAnchor !== null) {
                    commitIncompleteDeploymentObservationAttempt({
                        db: configuration.db,
                        anchor: attemptAnchor,
                        state: inspected.status === "partial" ? "partial" : "failed",
                        attemptedAt: configuration.now(),
                    });
                }
                return {
                    status: inspected.status,
                    value: undefined as unknown as DeploymentView,
                    diagnostics: inspected.diagnostics,
                };
            }
            const view = dependencies.readDeploymentView({
                db: configuration.db,
                transactionsRoot: configuration.transactionsRoot,
                deploymentId,
            });
            if (view === null) {
                return failureResult(
                    "scan.deployment_missing_after_observation",
                    "Deployment disappeared after observation commit",
                );
            }
            return { status: "complete", value: view, diagnostics: inspected.diagnostics };
        },
    };
    return Object.freeze(service);
}

/** Observe the applied renderer's files; current installation and write eligibility belong to render preparation. */
function inspectManagedDeployment(
    deploymentId: UuidV4,
    configuration: DeploymentRenderServiceConfiguration,
    dependencies: DeploymentInspectionServiceDependencies,
    commitObservation: boolean,
): Promise<CoreResult<AppliedTargetInspection>> {
    return runInspectionSafely(async () => {
        const initialBase = loadRenderBaseAuthority(configuration, deploymentId);
        if (commitObservation) {
            configuration.assertMutationScope({
                assetIds: initialBase.assets.map((asset) => asset.version.ref.assetId),
                settingsAuthority: false,
            });
        }
        const assetIds = [...new Set(initialBase.assets.map((asset) => asset.version.ref.assetId))].sort(compareUtf8Bytes);
        const releaseAssets = tryAcquireAuthorityLocks(configuration.authorityLocksRoot, "assets", assetIds);
        if (releaseAssets === null) {
            throw failure("scan.asset_locked", "an Asset authority used by this Deployment is locked", "unavailable", true);
        }
        try {
            const operationLock = acquireAllLocks(configuration.transactionsRoot, [computeDeploymentOperationKey(deploymentId)]);
            if (operationLock === null) {
                throw failure("scan.deployment_locked", "another operation owns this Deployment", "unavailable", true);
            }
            try {
                requireInspectionJournalClear(
                    scanJournals(configuration.transactionsRoot, deploymentId),
                    "an unresolved or corrupt deployment journal blocks inspection",
                );
                const base = loadRenderBaseAuthority(configuration, deploymentId);
                if (stableStringify(initialBase) !== stableStringify(base)) {
                    throw failure("scan.render_authority_changed", "Deployment or Asset authority changed", "conflict", true);
                }
                selectPlatformContext(
                    configuration.platformContexts,
                    base.platform,
                    base.platformInstanceId,
                    base.targetRootPath,
                );
                const authority = loadAppliedInspectionAuthority(configuration, deploymentId);
                requireAppliedIntentMatchesCurrentInputs(configuration, base);
                const registry = dependencies.buildRenderRegistry(structuredClone(listAdapterProviders().value));
                const pathLocks = acquireAllLocks(
                    configuration.transactionsRoot,
                    physicalInspectionKeys(base, authority.baseline),
                );
                if (pathLocks === null) {
                    throw failure("scan.target_locked", "the managed target closure is locked", "unavailable", true);
                }
                try {
                    const current = loadAppliedInspectionAuthority(configuration, deploymentId);
                    requireStableAppliedInspectionAuthority(authority, current);
                    return await inspectAppliedTarget(
                        configuration,
                        dependencies,
                        deploymentId,
                        base,
                        registry,
                        current,
                        commitObservation,
                    );
                } finally {
                    pathLocks.release();
                }
            } finally {
                operationLock.release();
            }
        } finally {
            releaseAssets();
        }
    });
}

export function inspectDeploymentRuntimeAuthority(
    deploymentId: UuidV4,
    configuration: DeploymentRenderServiceConfiguration,
    dependencies: DeploymentInspectionServiceDependencies,
): Promise<CoreResult<DeploymentInspectionAuthorityV1>> {
    return runInspectionSafely(async () => {
        // Resolve once without locks so no lock is retained across a stale or
        // unavailable agent-runtime probe. The same authority is resolved again
        // while the Deployment operation mutex is held.
        const initialBase = loadRenderBaseAuthority(configuration, deploymentId);
        const initialOperation = await prepareRenderOperation(initialBase, configuration, dependencies);
        const assetIds = [...new Set(initialBase.assets.map((asset) => asset.version.ref.assetId))].sort(compareUtf8Bytes);
        const releaseAssets = tryAcquireAuthorityLocks(configuration.authorityLocksRoot, "assets", assetIds);
        if (releaseAssets === null) {
            throw failure("scan.asset_locked", "an Asset authority used by this Deployment is locked", "unavailable", true);
        }
        try {
            const operationLock = acquireAllLocks(configuration.transactionsRoot, [computeDeploymentOperationKey(deploymentId)]);
            if (operationLock === null) {
                throw failure("scan.deployment_locked", "another operation owns this Deployment", "unavailable", true);
            }
            try {
                const scan = scanJournals(configuration.transactionsRoot, deploymentId);
                requireInspectionJournalClear(scan, "an unresolved or corrupt deployment journal blocks inspection");
                const base = loadRenderBaseAuthority(configuration, deploymentId);
                const operation = await prepareRenderOperation(base, configuration, dependencies);
                if (
                    operation.deployment.renderInputFingerprint !== initialOperation.deployment.renderInputFingerprint ||
                    operation.registry.fingerprint !== initialOperation.registry.fingerprint
                ) {
                    throw failure(
                        "scan.render_authority_changed",
                        "Deployment inputs, provider registry or observed target context changed",
                        "conflict",
                        true,
                    );
                }
                const authority = loadAppliedInspectionAuthority(configuration, deploymentId);
                requireAppliedIntentMatchesCurrentInputs(configuration, base);
                const physicalKeys = physicalInspectionKeys(base, authority.baseline);
                const pathLocks = acquireAllLocks(configuration.transactionsRoot, physicalKeys);
                if (pathLocks === null) {
                    throw failure("scan.target_locked", "the managed target closure is locked", "unavailable", true);
                }
                try {
                    const current = loadAppliedInspectionAuthority(configuration, deploymentId);
                    requireStableAppliedInspectionAuthority(authority, current);
                    return await inspectCapturedAuthority(configuration, dependencies, deploymentId, base, operation, current);
                } finally {
                    pathLocks.release();
                }
            } finally {
                operationLock.release();
            }
        } finally {
            releaseAssets();
        }
    });
}

/**
 * @internal Stage-R resolver entry. createReverseAcceptService already holds
 * the Deployment preparation mutex, calls the resolver once before and once
 * after acquiring the complete physical target closure, and rejects unequal
 * drafts. Re-acquiring either lock here would self-deadlock and a boolean
 * "already locked" option would create a production bypass, so this narrow
 * entry is restricted to deployment-lifecycle-service by the architecture
 * guard.
 */
export function inspectDeploymentRuntimeAuthorityForReverseResolver(
    deploymentId: UuidV4,
    configuration: DeploymentRenderServiceConfiguration,
    dependencies: DeploymentInspectionServiceDependencies,
): Promise<CoreResult<DeploymentInspectionAuthorityV1>> {
    return runInspectionSafely(async () => {
        const scan = scanJournals(configuration.transactionsRoot, deploymentId);
        requireInspectionJournalClear(scan, "an unresolved or corrupt deployment journal blocks reverse inspection");
        const base = loadRenderBaseAuthority(configuration, deploymentId);
        const operation = await prepareRenderOperation(base, configuration, dependencies);
        const current = loadAppliedInspectionAuthority(configuration, deploymentId);
        requireAppliedIntentMatchesCurrentInputs(configuration, base);
        return await inspectCapturedAuthority(configuration, dependencies, deploymentId, base, operation, current);
    });
}

async function runInspectionSafely<T>(operation: () => Promise<CoreResult<T>>): Promise<CoreResult<T>> {
    try {
        return await operation();
    } catch (error) {
        return inspectionFailureResult<T>(error);
    }
}

function requireInspectionJournalClear(scan: ReturnType<typeof scanJournals>, message: string): void {
    if (scan.matchingTxnIds.length > 0 || scan.corruptTxnIds.length > 0) {
        throw failure("scan.recovery_required", message, "unavailable", true);
    }
}

async function inspectCapturedAuthority(
    configuration: DeploymentRenderServiceConfiguration,
    dependencies: DeploymentInspectionServiceDependencies,
    deploymentId: UuidV4,
    base: RenderBaseAuthority,
    operation: RenderOperationAuthority,
    current: ReturnType<typeof loadAppliedInspectionAuthority>,
): Promise<CoreResult<DeploymentInspectionAuthorityV1>> {
    const inspected = await inspectAppliedTarget(
        configuration,
        dependencies,
        deploymentId,
        base,
        operation.registry,
        current,
        false,
    );
    if (inspected.status !== "complete") return { ...inspected, value: undefined as never };
    return {
        status: "complete",
        value: { base, operation, ...inspected.value },
        diagnostics: [...operation.diagnostics, ...inspected.diagnostics],
    };
}

async function inspectAppliedTarget(
    configuration: DeploymentRenderServiceConfiguration,
    dependencies: DeploymentInspectionServiceDependencies,
    deploymentId: UuidV4,
    base: RenderBaseAuthority,
    registry: RenderRegistrySnapshot,
    current: ReturnType<typeof loadAppliedInspectionAuthority>,
    commitObservation: boolean,
): Promise<CoreResult<AppliedTargetInspection>> {
    const capture = await withDeploymentTargetOperations(configuration, base, (operations) =>
        captureInspectionInput(
            configuration,
            deploymentId,
            current.snapshot,
            current.baseline,
            base.targetRootPath,
            operations.review.captureInspectionTarget,
        ),
    );
    const inspectionInput: RenderedTargetInspectionInput = {
        ...capture.input,
        appliedAssets: structuredClone(base.assets),
    };
    const inspected = await inspectRenderedTarget(
        { appliedRenderSnapshot: current.snapshot, inspection: inspectionInput },
        {
            registry,
            dispatch: dependencies.dispatchInspection,
            resolveRetainedRegistry: dependencies.resolveRetainedInspectionRegistry,
        },
    );
    if (inspected.status !== "complete") {
        return {
            status: inspected.status,
            value: undefined as unknown as AppliedTargetInspection,
            diagnostics: inspected.diagnostics,
        };
    }
    if (commitObservation) {
        commitDeploymentObservation({
            db: configuration.db,
            deploymentId,
            expectedCommittedTransactionId: current.committedTransactionId,
            expectedSnapshotFingerprint: current.snapshotFingerprint,
            files: inspectionInput.inspectionScope.fileStates.map((state) =>
                state.state === "missing"
                    ? {
                          relativePath: state.relativePath,
                          observedState: "missing" as const,
                      }
                    : {
                          relativePath: state.relativePath,
                          observedState: "present" as const,
                          observedContentHash: state.currentContentHash,
                          observedExecutable: state.currentExecutable,
                      },
            ),
            observedAt: configuration.now(),
        });
    }
    return {
        status: "complete",
        value: {
            appliedRenderSnapshot: current.snapshot,
            input: inspectionInput,
            result: inspected.value,
            runtimeReplacementAuthority: capture.runtimeReplacementAuthority,
        },
        diagnostics: inspected.diagnostics,
    };
}

function inspectionFailureResult<T>(error: unknown): CoreResult<T> {
    const problem =
        error instanceof DeploymentInspectionFailure
            ? error
            : failure(
                  "scan.inspection_unavailable",
                  `Deployment inspection authority is unavailable: ${String(error)}`,
                  "unavailable",
                  true,
              );
    return {
        status: "failed",
        value: undefined as T,
        diagnostics: [
            {
                severity: "error",
                code: problem.code,
                message: problem.message,
                path: error instanceof SafeFilesystemError ? error.targetPath : "",
                traceId: "",
                operation: "scan",
                causeKind: problem.causeKind,
                retryable: problem.retryable,
                suggestedActions: problem.retryable ? ["retry"] : [],
                rawSummary:
                    error instanceof SafeFilesystemError
                        ? JSON.stringify({
                              message: error.message,
                              failureKind: error.failureKind,
                              systemCode: error.systemCode,
                              operation: error.operation,
                              targetPath: error.targetPath,
                          })
                        : problem.message,
            },
        ],
    };
}

function loadAppliedInspectionAuthority(
    configuration: DeploymentRenderServiceConfiguration,
    deploymentId: UuidV4,
): {
    snapshotFingerprint: string;
    committedTransactionId: string;
    snapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>;
    baseline: ActiveDeploymentBaseline[];
} {
    const deployment = getDeployment(configuration.db, deploymentId);
    if (deployment === null || deployment.deleted !== 0) {
        throw failure("scan.deployment_missing", "Deployment is missing or deleted", "not_found", false);
    }
    const ref = parseAppliedRenderSnapshotRef(deployment.appliedRenderSnapshotRef);
    if (ref.snapshotState !== "applied") {
        throw failure("scan.never_deployed", "Deployment has no applied render snapshot", "conflict", false);
    }
    const row = getDeploymentRenderSnapshot(configuration.db, deploymentId, ref.snapshotFingerprint);
    if (row === null || row.deleted !== 0) {
        throw failure("scan.snapshot_unavailable", "the current applied render snapshot is unavailable", "unavailable", true);
    }
    const snapshot = parseAppliedRenderSnapshot(row.snapshotJson, ref.snapshotFingerprint);
    if (snapshot.snapshotState !== "applied") {
        throw failure("scan.snapshot_invalid", "the referenced snapshot is not applied", "invalid_schema", false);
    }
    return {
        snapshotFingerprint: ref.snapshotFingerprint,
        committedTransactionId: deployment.committedTransactionId,
        snapshot,
        baseline: loadDeploymentBaseline(configuration.db, deploymentId),
    };
}

function physicalInspectionKeys(base: RenderBaseAuthority, baseline: ActiveDeploymentBaseline[]): string[] {
    return computePhysicalClosureKeys(
        base.platform,
        base.targetRootPath,
        baseline.map((file) => ({
            relativePath: file.relativePath,
            entryKind: "file" as const,
            containingDirectoryBoundaries: file.managedDirectoryBoundaryPaths,
        })),
    );
}

function baselineIdentity(row: ActiveDeploymentBaseline): unknown {
    return {
        relativePath: row.relativePath,
        baselineState: row.baselineState,
        managedDirectoryBoundaryPaths: row.managedDirectoryBoundaryPaths,
    };
}

function requireStableAppliedInspectionAuthority(
    expected: ReturnType<typeof loadAppliedInspectionAuthority>,
    current: ReturnType<typeof loadAppliedInspectionAuthority>,
): void {
    if (
        current.snapshotFingerprint !== expected.snapshotFingerprint ||
        current.committedTransactionId !== expected.committedTransactionId ||
        JSON.stringify(current.baseline.map(baselineIdentity)) !== JSON.stringify(expected.baseline.map(baselineIdentity))
    ) {
        throw failure(
            "scan.baseline_changed",
            "the applied snapshot or active baseline changed before capture",
            "conflict",
            true,
        );
    }
}

function requireAppliedIntentMatchesCurrentInputs(
    configuration: DeploymentRenderServiceConfiguration,
    base: RenderBaseAuthority,
): void {
    const deployment = getDeployment(configuration.db, base.deploymentId);
    // The base rebuilds current consumers, exact Versions and allowIncomplete.
    // Renderer/build observations belong to fresh operation authority, not saved user intent.
    if (
        deployment === null ||
        stableStringify(parseAppliedInputsSnapshot(deployment.appliedInputsSnapshot, base.deploymentId)) !==
            stableStringify(base.appliedInputsSnapshot)
    ) {
        throw failure(
            "scan.applied_render_stale",
            "the current Deployment intent no longer matches its applied inputs",
            "conflict",
            true,
        );
    }
}

/** @internal Narrow pure-helper seam for deterministic T5 boundary tests. */
export const deploymentInspectionInternalsForTest = Object.freeze({
    contentFromBytes,
    joinPhysicalTargetPath,
    compareUtf8Bytes,
    loadAppliedInspectionAuthority,
    captureInspectionInput,
    requireStableAppliedInspectionAuthority,
    requireAppliedIntentMatchesCurrentInputs,
    requireInspectionJournalClear,
});

function failureResult<T>(code: string, message: string): CoreResult<T> {
    return {
        status: "failed",
        value: undefined as unknown as T,
        diagnostics: [
            {
                severity: "error",
                code,
                message,
                path: "",
                traceId: "",
                operation: "scan",
                causeKind: "unavailable",
                retryable: true,
                suggestedActions: ["retry"],
                rawSummary: message,
            },
        ],
    };
}
