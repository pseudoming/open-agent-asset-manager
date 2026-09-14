/** Deployment recovery and fresh reverse-accept lifecycle orchestration. */

import { readJournal, scanJournals } from "../deployment/deployment-journal";
import { getDeployment } from "../persistence/state-db";
import { localTargetTransactions } from "../deployment/local-target-transaction";
import { withDeploymentTargetOperations } from "./deployment-target-operations";
import { recoverDeployment as recoverDeploymentJournal } from "../deployment/deployment-recovery";
import { loadDeploymentBaseline } from "../deployment/deployment-state-ops";
import { projectDeploymentSuccessAuthority } from "../deployment/deployment-success-projection";
import { completeResult } from "../foundation/core-result";
import { isUuidV4 } from "../foundation/validators";
import { compileRenderDeployment, openValidatedCompiledDeploymentPlan } from "../render/render-compiler";
import { resolveProviderExactFileDialectInputs } from "../render/render-dialect-authority";
import { materializeRenderDeployment } from "../render/render-materialization";
import { resolveCoreRenderSelectionForStagedVersion } from "../render/render-selection";
import { createReverseAcceptMarkerStore, scanReverseAcceptReservations } from "../reverse/reverse-accept-marker";
import { reconcileReverseAcceptPreparation } from "../reverse/reverse-accept-reconcile";
import {
    createReverseAcceptService,
    type FreshReverseAcceptCommitDraft,
    type FreshReverseAcceptPreparationDraft,
    type ResolveFreshReverseAcceptCommitInput,
    type ResolveFreshReverseAcceptPreparationInput,
} from "../reverse/reverse-accept-service";
import type { CoreResult, DeploymentView, UuidV4 } from "../types";
import { dispatchMaterializeRender } from "./adapter-registry";
import type { DeploymentInspectionServiceDependencies } from "./deployment-inspection-service";
import { rebuildExactFileNativeDialectAuthority } from "./deployment-lifecycle-exact-file";
import type {
    DeploymentLifecycleConfiguration,
    DeploymentLifecycleRecoveryDependencies,
    DeploymentLifecycleService,
} from "./deployment-lifecycle-model";
import {
    buildFreshReverseProjection,
    buildStagedReverseVersionContent,
    buildStagedVersionClosure,
    importedPromotionSafety,
    nextAssetRevision,
    pendingPromotionGrant,
    projectStagedRenderBase,
    rebuildWholeFileNativeDialectAuthority,
    requireAvailableStagedAsset,
    requireOneWholeFileContentChange,
    requireT5ParentSourceFile,
    requireT5WholeFileRenderAsset,
    resolvePreparationPromotionState,
} from "./deployment-lifecycle-projection";
import { appliedRuleReverseContractKind } from "./deployment-lifecycle-rule-reverse-contract";
import { collectDeploymentPayloads, verifyCompiledPlanAlreadyPresent } from "./deployment-lifecycle-runtime";
import { failed, lifecycleFailure, requireComplete } from "./deployment-lifecycle-shared";
import { selectionConfiguration } from "./deployment-render-service";

export const REVERSE_ACCEPT_TTL_MS = 15 * 60 * 1000;

export const DEFAULT_RECOVERY_DEPENDENCIES: DeploymentLifecycleRecoveryDependencies = Object.freeze({
    scanDeploymentJournals: scanJournals,
    recoverDeploymentJournal,
    scanReservations: scanReverseAcceptReservations,
    reconcilePreparation: reconcileReverseAcceptPreparation,
});

export function createDeploymentLifecycleService(
    configuration: DeploymentLifecycleConfiguration,
    dependencies: DeploymentInspectionServiceDependencies,
): DeploymentLifecycleService {
    const reverse = createReverseAcceptService({
        transactionsRoot: configuration.render.transactionsRoot,
        assetsRoot: configuration.render.assetsRoot,
        deploymentsRoot: configuration.render.deploymentsRoot,
        authorityLocksRoot: configuration.render.authorityLocksRoot,
        databasePath: configuration.databasePath,
        dialectRegistry: configuration.render.dialectRegistry,
        preparationTtlMs: REVERSE_ACCEPT_TTL_MS,
        renderAnalysisValidator: configuration.renderAnalysisValidator,
        now: configuration.render.now,
        newUuid: configuration.newUuid,
        resolveFreshPreparation: (input) => resolveFreshPreparation(configuration, dependencies, input),
        resolveFreshCommit: (input) => resolveFreshCommit(configuration, dependencies, input),
    });
    return Object.freeze({
        ...reverse,
        recoverDeployment: (deploymentId: UuidV4) =>
            recoverDeploymentLifecycle(configuration, dependencies, DEFAULT_RECOVERY_DEPENDENCIES, deploymentId),
    });
}

export async function recoverDeploymentLifecycle(
    configuration: DeploymentLifecycleConfiguration,
    dependencies: Pick<DeploymentInspectionServiceDependencies, "readDeploymentView">,
    recoveryDependencies: DeploymentLifecycleRecoveryDependencies,
    deploymentId: UuidV4,
): Promise<CoreResult<DeploymentView>> {
    try {
        if (!isUuidV4(deploymentId)) {
            throw lifecycleFailure("recovery.deployment_id_invalid", "deploymentId must be UUID v4");
        }
        const journals = recoveryDependencies.scanDeploymentJournals(configuration.render.transactionsRoot, deploymentId);
        if (journals.corruptTxnIds.length > 0) {
            throw lifecycleFailure(
                "blocked_by_recovery_journal_corrupt",
                "a corrupt Deployment journal requires manual support",
                "unavailable",
            );
        }
        for (const transactionId of journals.matchingTxnIds) {
            const recover = (targetExecution: Parameters<typeof recoverDeploymentJournal>[3]) =>
                recoveryDependencies.recoverDeploymentJournal(
                    configuration.render.db,
                    configuration.render.transactionsRoot,
                    transactionId,
                    targetExecution,
                );
            const journal = readJournal(configuration.render.transactionsRoot, transactionId);
            const selectedGraph =
                journal?.schemaVersion === 3 || (journal?.schemaVersion === 4 && journal.targetExecution.kind === "selected_wsl");
            const row = selectedGraph ? getDeployment(configuration.render.db, deploymentId) : null;
            // The recovery owner revalidates journal and State after process admission.
            // Legacy Windows-coordinate journals are retained without direct WSL I/O.
            const recovered =
                selectedGraph && row !== null && row.platform === "wsl"
                    ? await withDeploymentTargetOperations(configuration.render, { ...row, platform: "wsl" }, (operations) =>
                          recover(operations.execution),
                      )
                    : recover(localTargetTransactions);
            if (recovered.outcome === "blocked" || !recovered.journalResolved) {
                throw lifecycleFailure(
                    recovered.reasonCode || "recovery.deployment_blocked",
                    "Deployment journal recovery did not reach a verified terminal state",
                    "unavailable",
                    true,
                );
            }
        }
        const markerStore = createReverseAcceptMarkerStore(
            configuration.render.transactionsRoot,
            configuration.renderAnalysisValidator,
        );
        const reservations = recoveryDependencies.scanReservations(configuration.render.transactionsRoot, markerStore);
        if (reservations.globalFreeze) {
            throw lifecycleFailure(
                "recovery.reverse_global_freeze",
                "reverse-accept reservation scope is unavailable",
                "unavailable",
            );
        }
        for (const identity of reservations.activePreparations.filter((candidate) => candidate.deploymentId === deploymentId)) {
            const reconciled = recoveryDependencies.reconcilePreparation(
                {
                    transactionsRoot: configuration.render.transactionsRoot,
                    authorityLocksRoot: configuration.render.authorityLocksRoot,
                    assetsRoot: configuration.render.assetsRoot,
                    deploymentsRoot: configuration.render.deploymentsRoot,
                    databasePath: configuration.databasePath,
                    dialectRegistry: configuration.render.dialectRegistry,
                    renderAnalysisValidator: configuration.renderAnalysisValidator,
                },
                identity.preparationId,
            );
            if (reconciled.reconcileState !== "retired" && reconciled.reconcileState !== "resolved") {
                throw lifecycleFailure(
                    "recovery.reverse_accept_not_terminal",
                    `reverse-accept preparation remains ${reconciled.reconcileState}`,
                    "conflict",
                    reconciled.reconcileState === "busy",
                );
            }
        }
        const view = dependencies.readDeploymentView({
            db: configuration.render.db,
            transactionsRoot: configuration.render.transactionsRoot,
            deploymentId,
        });
        if (view === null) {
            throw lifecycleFailure("recovery.deployment_missing", "Deployment is missing after recovery", "not_found");
        }
        return completeResult(view);
    } catch (error) {
        return failed(error);
    }
}

export async function resolveFreshPreparation(
    configuration: DeploymentLifecycleConfiguration,
    dependencies: DeploymentInspectionServiceDependencies,
    input: ResolveFreshReverseAcceptPreparationInput,
): Promise<CoreResult<FreshReverseAcceptPreparationDraft>> {
    try {
        const projection = await buildFreshReverseProjection(
            configuration,
            dependencies,
            input.request.deploymentId,
            input.request.inspectionResultFingerprint,
            input.stagedVersionId,
            false,
        );
        return completeResult({
            deploymentAuthorityFingerprint: projection.deploymentAuthorityFingerprint,
            assetManifestAuthorities: projection.assetManifestAuthorities,
            inspectionScopeFingerprint: projection.inspected.result.inspectionScopeFingerprint,
            inspectionResultFingerprint: projection.inspected.result.inspectionResultFingerprint,
            stagedAssetId: projection.content.assetId,
            stagedVersionFingerprint: projection.content.versionFingerprint,
            stagedVersionOriginDraft: {
                previousVersionId: projection.content.parentVersionId,
                previousVersionOriginAuthorityFingerprint: projection.content.parentOriginAuthorityFingerprint,
                promotionRequirement: projection.content.promotionRequirement,
            },
            promotionState: resolvePreparationPromotionState(configuration, projection.content, projection.operation.deployment),
            renderAnalysis: projection.analysis,
        });
    } catch (error) {
        return failed(error);
    }
}

export async function resolveFreshCommit(
    configuration: DeploymentLifecycleConfiguration,
    dependencies: DeploymentInspectionServiceDependencies,
    input: ResolveFreshReverseAcceptCommitInput,
): Promise<CoreResult<FreshReverseAcceptCommitDraft>> {
    try {
        const projection = await buildFreshReverseProjection(
            configuration,
            dependencies,
            input.preparation.identity.deploymentId,
            input.preparation.inspectionResultFingerprint,
            input.preparation.stagedVersionId,
            true,
        );
        const stagedVersion = buildStagedVersionClosure(
            projection.content,
            input.stagedVersionOriginAuthority,
            projection.inspected.base.deploymentId,
        );
        const promotionGrant = pendingPromotionGrant(input, projection.operation.deployment);
        const selected = requireComplete(
            resolveCoreRenderSelectionForStagedVersion(
                {
                    deployment: projection.operation.deployment,
                    analysis: projection.analysis,
                    request: input.request.renderSelectionRequest,
                },
                selectionConfiguration(configuration.render, projection.operation.registry),
                {
                    assetAuthorityLeaseProof: input.assetAuthorityLeaseProof,
                    settingsAuthorityLeaseProof: input.settingsAuthorityLeaseProof,
                },
                { version: stagedVersion, promotionGrant },
            ),
        );
        const providerMaterialization = requireComplete(
            await materializeRenderDeployment(
                {
                    deployment: projection.operation.deployment,
                    analysis: projection.analysis,
                    selection: selected,
                },
                {
                    registry: projection.operation.registry,
                    dialectRegistry: configuration.render.dialectRegistry,
                    resolveDialectInputs: (provider, deployment, semantics) =>
                        resolveProviderExactFileDialectInputs({
                            provider,
                            deployment,
                            semantics,
                            available: projection.operation.dialectInputs,
                            renderRegistry: projection.operation.registry,
                            dialectRegistry: configuration.render.dialectRegistry,
                        }),
                    dispatch: dispatchMaterializeRender,
                },
            ),
        );
        const materialized = requireComplete(
            await withDeploymentTargetOperations(configuration.render, projection.operation.deployment, (operations) =>
                operations.review.resolveContainerPatches(providerMaterialization),
            ),
        );
        const compiledToken = requireComplete(
            compileRenderDeployment({
                deployment: projection.operation.deployment,
                analysis: projection.analysis,
                selection: selected,
                materialization: materialized,
                appliedInputsSnapshot: projection.base.appliedInputsSnapshot,
            }),
        );
        const compiled = openValidatedCompiledDeploymentPlan(compiledToken);
        const verified = verifyCompiledPlanAlreadyPresent(compiled, projection.inspected);
        const baseline = loadDeploymentBaseline(configuration.render.db, projection.inspected.base.deploymentId);
        const projected = projectDeploymentSuccessAuthority({
            deploymentId: projection.inspected.base.deploymentId,
            targetPlan: compiled.targetPlan,
            executionAuthority: compiled.executionAuthority,
            baseline,
            verifiedActiveTargets: verified,
            transactionId: input.preparation.identity.commitTransactionId,
            now: input.stagedVersionOriginAuthority.createdAt,
        });
        const deploymentPayloads = collectDeploymentPayloads(
            configuration.render.deploymentsRoot,
            projection.inspected.base.deploymentId,
            projected.activePayloads,
            projected.successCommit.newlyRemoved,
        );
        return completeResult({
            deploymentAuthorityFingerprint: projection.deploymentAuthorityFingerprint,
            assetManifestAuthorities: projection.assetManifestAuthorities,
            inspectionScopeFingerprint: projection.inspected.result.inspectionScopeFingerprint,
            inspectionResultFingerprint: projection.inspected.result.inspectionResultFingerprint,
            deployment: projection.operation.deployment,
            renderAnalysis: projection.analysis,
            selectionFingerprint: selected.selectionFingerprint,
            compilationFingerprint: compiled.compilationFingerprint,
            stagedVersion,
            deploymentPayloads,
            successCommit: projected.successCommit,
        });
    } catch (error) {
        return failed(error);
    }
}

/** @internal Narrow helper seam for deterministic T5 lifecycle boundary tests. */
export const deploymentLifecycleInternalsForTest = Object.freeze({
    appliedRuleReverseContractKind,
    buildStagedReverseVersionContent,
    requireOneWholeFileContentChange,
    projectStagedRenderBase,
    buildStagedVersionClosure,
    resolvePreparationPromotionState,
    importedPromotionSafety,
    pendingPromotionGrant,
    verifyCompiledPlanAlreadyPresent,
    collectDeploymentPayloads,
    requireComplete,
    recoverDeploymentLifecycle,
    defaultRecoveryDependencies: DEFAULT_RECOVERY_DEPENDENCIES,
    requireT5WholeFileRenderAsset,
    requireT5ParentSourceFile,
    rebuildWholeFileNativeDialectAuthority,
    rebuildExactFileNativeDialectAuthority,
    requireAvailableStagedAsset,
    nextAssetRevision,
});
