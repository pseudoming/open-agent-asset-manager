/** Phase-21 T4 Core orchestration: durable intent -> render -> compiled executor token. */

import type { Database } from "better-sqlite3";
import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import type { DeployResult } from "../deployment/deployment-executor";
import {
    type CapturedDeploymentPreWritePreview,
    DeploymentPreWritePreviewError,
} from "../deployment/deployment-prewrite-preview";
import { readCanonicalDeploymentPreCommitDatabaseStateFromConnection } from "../deployment/deployment-state-authority";
import { loadDeploymentBaseline } from "../deployment/deployment-state-ops";
import type { DeploymentRuntimeReplacementAuthorityV1 } from "../deployment/deployment-target-replacement";
import type { DeploymentTargetTransactions } from "../deployment/deployment-target-transaction";
import type { readDeploymentView } from "../deployment/deployment-view";
import { completeResult } from "../foundation/core-result";
import { computeRenderInputFingerprint, stableStringify } from "../foundation/fingerprint";
import { isUuidV4 } from "../foundation/validators";
import { getDeployment } from "../persistence/state-db";
import {
    primeOperationLocalBuildArtifactObservations,
    retainCurrentTargetBuildObservations,
} from "../render/native-project-target-build-observation";
import { selectedWslBuildObservation } from "./selected-wsl-build-observation";
import type { SelectedWslProbeExecution } from "./selected-wsl-probe-execution";
import {
    createTargetCheckObservationSnapshot,
    TargetCheckObservationScopes,
    type TargetCheckObservationSnapshot,
} from "../render/native-project-target-observation-snapshot";
import { analyzeRenderDeployment, deriveRequiredRenderSemanticsV1 } from "../render/render-analysis";
import {
    compileRenderDeployment,
    projectValidatedCompiledDeploymentPreviewInput,
    type ValidatedCompiledDeploymentPlan,
} from "../render/render-compiler";
import { resolveProviderExactFileDialectInputs } from "../render/render-dialect-authority";
import { materializeRenderDeployment } from "../render/render-materialization";
import { inspectPromotionAuthorizations } from "../render/render-promotion-authorization";
import type { RenderRegistrySnapshot } from "../render/render-registry";
import {
    denyUnverifiedOneTimeRenderApproval,
    type RenderSelectionAuthorityLeases,
    type resolveCoreRenderSelection,
    resolveNoSavedRenderPolicy,
} from "../render/render-selection";
import type {
    AdapterId,
    AdapterProviderSummary,
    AnalyzeAssetUsageInput,
    AppliedInputsSnapshotV1,
    AssetUsageProjectionView,
    CoreResult,
    DeploymentRenderAnalysisView,
    DeploymentRenderPreviewView,
    DeploymentView,
    DeployWithRenderSelectionInput,
    OperationDiagnostic,
    PlatformContext,
    PreviewDeploymentRenderInput,
    ProbeResult,
    RenderAnalysisView,
    RenderDeploymentInput,
    RenderSelectionRequest,
    ResolvedCoreRenderSelection,
    TargetAgentRuntimeRenderContext,
    UuidV4,
} from "../types";
import { dispatchAnalyzeRender, dispatchMaterializeRender, listAdapterProviders, type probeAdapters } from "./adapter-registry";
import {
    assetUsageCapableConsumerIds,
    classifyAssetUsageRelationship,
    loadAssetUsageBaseAuthority,
    loadAssetUsageSourceSnapshot,
    normalizeAssetUsageInput,
    projectAssetUsageRelationships,
} from "./asset-usage-analysis";
import { observeAssetUsageRenderTargets } from "./asset-usage-render-observation";
import { type CoreMutationScope, CoreMutationScopeError } from "./core-mutation-scope";
import {
    acquireActionTimeAuthorityLeases,
    DeploymentRenderFailure,
    deploymentRenderActionAuthorityInternalsForTest,
    requireActionTimeAssetLeaseCoverage,
    requirePreviewedAction,
    requirePreviewMatch,
} from "./deployment-render-action-authority";
import { loadProjectRootPath, loadRenderAssetAuthorities } from "./deployment-render-asset-authority";
import {
    mergeRenderOperationDiagnostics,
    type ObservedRenderTargetContextResolver,
    type RenderBaseAuthority,
    type RenderOperationAuthority,
    requireRenderOperationValue,
    resolveOperationDialectInputs,
    resolveRenderTargetContextAsync,
} from "./deployment-render-authority";
import { resolveRenderProbeSnapshot, selectPlatformContext } from "./deployment-render-probe-snapshot";
import { captureMemoryCatalogTargetFileSnapshots, type CaptureMemoryCatalogTargets } from "./deployment-render-target-snapshot";
import {
    withSelectedMemoryCatalogCapture,
    withDeploymentTargetOperations,
    withAssetUsageTargetOperations,
} from "./deployment-target-operations";
import type { SelectedWslTargetExecution } from "./selected-wsl-target-execution";

export interface DeploymentRenderService {
    analyzeAssetUsage(input: AnalyzeAssetUsageInput): Promise<CoreResult<AssetUsageProjectionView>>;
    analyzeDeploymentRender(deploymentId: UuidV4): Promise<CoreResult<DeploymentRenderAnalysisView>>;
    previewDeploymentRender(input: PreviewDeploymentRenderInput): Promise<CoreResult<DeploymentRenderPreviewView>>;
    deployDeployment(input: DeployWithRenderSelectionInput): Promise<CoreResult<DeploymentView>>;
    /** @internal Repair supplies protected inspection authority with an empty replacement scope. */
    deployDeploymentWithRuntimeReplacement(
        input: Extract<DeployWithRenderSelectionInput, { deploymentAction: "overwrite_runtime" }>,
        runtimeReplacementAuthority: DeploymentRuntimeReplacementAuthorityV1,
    ): Promise<CoreResult<DeploymentView>>;
}

export interface DeploymentRenderServiceConfiguration {
    db: Database;
    assetsRoot: string;
    projectsRoot: string;
    oaamRoot: string;
    authorityLocksRoot: string;
    transactionsRoot: string;
    deploymentsRoot: string;
    platformContexts: PlatformContext[];
    selectedWslTargetExecution?: SelectedWslTargetExecution;
    selectedWslProbeExecution?: SelectedWslProbeExecution;
    dialectRegistry: VersionDialectRegistryV1;
    assertMutationScope(scope: CoreMutationScope): void;
    confirmOneTimeRenderApproval?: Parameters<typeof resolveCoreRenderSelection>[1]["confirmOneTimeApproval"];
    newUuid(): UuidV4;
    now(): number;
}

export interface DeploymentRenderServiceDependencies {
    buildRenderRegistry(providers: AdapterProviderSummary[]): RenderRegistrySnapshot;
    resolveObservedTargetContext: ObservedRenderTargetContextResolver;
    executeDeployment(
        input: {
            db: Database;
            transactionsRoot: string;
            deploymentsRoot: string;
            projectsRoot: string;
            deploymentId: string;
            now: () => number;
            targetExecution: DeploymentTargetTransactions;
        },
        compiledPlan: ValidatedCompiledDeploymentPlan,
        runtimeReplacementAuthority?: DeploymentRuntimeReplacementAuthorityV1,
    ): DeployResult;
    resolveSelection(
        input: {
            deployment: RenderDeploymentInput;
            analysis: RenderAnalysisView;
            request: RenderSelectionRequest;
        },
        configuration: Parameters<typeof resolveCoreRenderSelection>[1],
        leases?: RenderSelectionAuthorityLeases,
    ): CoreResult<ResolvedCoreRenderSelection>;
    readDeploymentView(input: Parameters<typeof readDeploymentView>[0]): DeploymentView | null;
    probeAdapters: typeof probeAdapters;
}

interface SelectedRenderAuthority {
    operation: RenderOperationAuthority;
    analysis: RenderAnalysisView;
    selection: ResolvedCoreRenderSelection;
}

interface SelectedRenderDraft extends SelectedRenderAuthority {
    compiledPlan: ValidatedCompiledDeploymentPlan;
    preview: CapturedDeploymentPreWritePreview;
}

export function createDeploymentRenderService(
    sourceConfiguration: DeploymentRenderServiceConfiguration,
    dependencies: DeploymentRenderServiceDependencies,
): DeploymentRenderService {
    const configuration = Object.freeze({
        ...sourceConfiguration,
        platformContexts: structuredClone(sourceConfiguration.platformContexts),
    });
    const targetCheckObservationScopes = new TargetCheckObservationScopes();

    const analyzeDeploymentRender = async (deploymentId: UuidV4): Promise<CoreResult<DeploymentRenderAnalysisView>> => {
        try {
            const operation = await prepareRenderOperation(
                loadRenderBaseAuthority(configuration, deploymentId),
                configuration,
                dependencies,
            );
            const analysis = await runAnalysis(operation);
            if (analysis.status === "failed") {
                return mergeRenderOperationDiagnostics(
                    analysis as CoreResult<DeploymentRenderAnalysisView>,
                    operation.diagnostics,
                );
            }
            const authorization = inspectPromotionAuthorizations(
                operation.deployment,
                selectionConfiguration(configuration, operation.registry),
            );
            const result: CoreResult<DeploymentRenderAnalysisView> = {
                status: analysis.status === "complete" && authorization.status === "complete" ? "complete" : "partial",
                value: {
                    ...analysis.value,
                    promotionAuthorizationInspections: authorization.value,
                },
                diagnostics: [...analysis.diagnostics, ...authorization.diagnostics],
            };
            return mergeRenderOperationDiagnostics(result, operation.diagnostics);
        } catch (error) {
            return failed(error, "render");
        }
    };

    const analyzeAssetUsage = async (sourceInput: AnalyzeAssetUsageInput): Promise<CoreResult<AssetUsageProjectionView>> => {
        try {
            const targetCheckSnapshot = targetCheckObservationScopes.for(sourceInput.currentProbeResults);
            const input = normalizeAssetUsageInput(sourceInput);
            const base = loadAssetUsageBaseAuthority(configuration, input);
            const providers = listAdapterProviders().value;
            const capableConsumerIds = assetUsageCapableConsumerIds(
                providers,
                input.consumerAgentRuntimeIds,
                base.assets.map((asset) => asset.version.canonical.kind),
                base.projectId === "" ? "global" : "project",
            );
            if (capableConsumerIds.length === 0) {
                await resolveRenderProbeSnapshot({
                    base,
                    ownerAdapterIds: providers
                        .filter((provider) =>
                            provider.agentRuntimes.some((runtime) =>
                                input.consumerAgentRuntimeIds.includes(runtime.agentRuntimeId),
                            ),
                        )
                        .map((provider) => provider.adapterId),
                    platformContext: selectPlatformContext(
                        configuration.platformContexts,
                        input.platform,
                        input.platformInstanceId,
                        input.targetRootPath,
                    ),
                    probeAdapters: dependencies.probeAdapters,
                    currentProbeResults: input.currentProbeResults,
                });
                return completeResult(projectAssetUsageRelationships(configuration, dependencies, input, null, new Set()));
            }
            const capableBase: RenderBaseAuthority = {
                ...base,
                consumerAgentRuntimeIds: capableConsumerIds,
                appliedInputsSnapshot: {
                    ...base.appliedInputsSnapshot,
                    consumerAgentRuntimeIds: capableConsumerIds,
                },
            };
            return await withAssetUsageTargetOperations<CoreResult<AssetUsageProjectionView>>(
                configuration,
                capableBase,
                async (targetOperations) => {
                    const operation = await prepareRenderOperation(
                        capableBase,
                        configuration,
                        dependencies,
                        input.currentProbeResults,
                        targetCheckSnapshot,
                        targetOperations.review.captureMemoryCatalogTargets,
                    );
                    const analysis = await runAnalysis(operation);
                    if (analysis.status === "failed") {
                        return {
                            status: "failed",
                            value: undefined as unknown as AssetUsageProjectionView,
                            diagnostics: analysis.diagnostics,
                        };
                    }
                    const sourceSnapshot = loadAssetUsageSourceSnapshot(configuration, input);
                    const observation = await observeAssetUsageRenderTargets({
                        operation,
                        analysis: analysis.value,
                        consumerAgentRuntimeIds: capableConsumerIds,
                        targetOperations,
                        dialectRegistry: configuration.dialectRegistry,
                        ...(sourceSnapshot === undefined ? {} : { sourceSnapshot }),
                        targetCheckSnapshot,
                    });
                    const value = projectAssetUsageRelationships(
                        configuration,
                        dependencies,
                        input,
                        analysis.value,
                        new Set(capableConsumerIds),
                        observation.observedTargetStates,
                        observation.diagnosticsByAgentRuntimeId,
                    );
                    return mergeRenderOperationDiagnostics({ ...analysis, value }, [
                        ...operation.diagnostics,
                        ...observation.diagnostics,
                    ]);
                },
            );
        } catch (error) {
            return failed(error, "render");
        }
    };

    const previewDeploymentRender = async (
        sourceInput: PreviewDeploymentRenderInput,
    ): Promise<CoreResult<DeploymentRenderPreviewView>> => {
        try {
            const input = structuredClone(sourceInput);
            const base = loadRenderBaseAuthority(configuration, input.deploymentId);
            const authority = await prepareSelectedRenderAuthority(base, input.selectionRequest, configuration, dependencies);
            const draft = await completeSelectedRenderDraft(authority, base, configuration);
            return mergeRenderOperationDiagnostics(completeResult(draft.preview.view), draft.operation.diagnostics);
        } catch (error) {
            return failed(error, "render");
        }
    };

    const deployDeploymentCore = async (
        sourceInput: DeployWithRenderSelectionInput,
        runtimeReplacementAuthority?: DeploymentRuntimeReplacementAuthorityV1,
    ): Promise<CoreResult<DeploymentView>> => {
        try {
            const input = structuredClone(sourceInput);
            requirePreviewedAction(input);
            const initialBase = loadRenderBaseAuthority(configuration, input.deploymentId);
            configuration.assertMutationScope({
                assetIds: initialBase.assets.map((asset) => asset.version.ref.assetId),
                settingsAuthority: true,
            });
            const authorityLeases = acquireActionTimeAuthorityLeases(
                configuration.authorityLocksRoot,
                initialBase.assets.map((asset) => asset.version.ref.assetId),
            );
            try {
                const currentBase = loadRenderBaseAuthority(configuration, input.deploymentId);
                requireActionTimeAssetLeaseCoverage(
                    initialBase.assets.map((asset) => asset.version.ref.assetId),
                    currentBase.assets.map((asset) => asset.version.ref.assetId),
                );
                const currentDraft = await prepareSelectedRenderDraft(
                    currentBase,
                    input.selectionRequest,
                    configuration,
                    dependencies,
                    {
                        assetAuthorityLeaseProof: authorityLeases.assets.proof,
                        settingsAuthorityLeaseProof: authorityLeases.settings.proof,
                    },
                );
                requirePreviewMatch(input, currentDraft.preview.view);
                configuration.assertMutationScope({
                    assetIds: currentBase.assets.map((asset) => asset.version.ref.assetId),
                    settingsAuthority: true,
                });
                const execution = await withDeploymentTargetOperations(
                    configuration,
                    currentBase,
                    ({ execution: targetExecution }) =>
                        dependencies.executeDeployment(
                            {
                                db: configuration.db,
                                transactionsRoot: configuration.transactionsRoot,
                                deploymentsRoot: configuration.deploymentsRoot,
                                projectsRoot: configuration.projectsRoot,
                                deploymentId: input.deploymentId,
                                now: configuration.now,
                                targetExecution,
                            },
                            currentDraft.compiledPlan,
                            // Complete overwrite authority comes wholly from this
                            // compiled preview, including changed desired leaf boundaries.
                            // Repair explicitly carries an empty scope and exact inspection.
                            runtimeReplacementAuthority?.replacementScope === undefined
                                ? currentDraft.preview.runtimeReplacementAuthority
                                : runtimeReplacementAuthority,
                        ),
                );
                if (execution.outcome !== "committed") {
                    throw new DeploymentRenderFailure(
                        execution.reasonCode || "render.executor_blocked",
                        `deployment executor returned ${execution.outcome}`,
                        execution.outcome === "conflict" ? "conflict" : "unavailable",
                        execution.outcome !== "conflict",
                        execution.diagnostics,
                    );
                }
                const view = dependencies.readDeploymentView({
                    db: configuration.db,
                    transactionsRoot: configuration.transactionsRoot,
                    deploymentId: input.deploymentId,
                });
                if (view === null) {
                    throw new DeploymentRenderFailure(
                        "render.deployment_missing_after_commit",
                        "Deployment disappeared after a committed executor result",
                        "internal_error",
                        false,
                        [],
                    );
                }
                return {
                    status: "complete",
                    value: view,
                    diagnostics: [...currentDraft.operation.diagnostics, ...execution.diagnostics],
                };
            } finally {
                try {
                    authorityLeases.settings.release();
                } finally {
                    authorityLeases.assets.release();
                }
            }
        } catch (error) {
            return failed(error, "deploy");
        }
    };

    const deployDeployment = (input: DeployWithRenderSelectionInput) => deployDeploymentCore(input);
    const deployDeploymentWithRuntimeReplacement = (
        input: Extract<DeployWithRenderSelectionInput, { deploymentAction: "overwrite_runtime" }>,
        runtimeReplacementAuthority: DeploymentRuntimeReplacementAuthorityV1,
    ) => deployDeploymentCore(input, runtimeReplacementAuthority);

    return Object.freeze({
        analyzeAssetUsage,
        analyzeDeploymentRender,
        previewDeploymentRender,
        deployDeployment,
        deployDeploymentWithRuntimeReplacement,
    });
}

async function prepareSelectedRenderDraft(
    base: RenderBaseAuthority,
    request: RenderSelectionRequest,
    configuration: DeploymentRenderServiceConfiguration,
    dependencies: DeploymentRenderServiceDependencies,
    leases?: RenderSelectionAuthorityLeases,
): Promise<SelectedRenderDraft> {
    const authority = await prepareSelectedRenderAuthority(base, request, configuration, dependencies, leases);
    return completeSelectedRenderDraft(authority, base, configuration);
}

async function prepareSelectedRenderAuthority(
    base: RenderBaseAuthority,
    request: RenderSelectionRequest,
    configuration: DeploymentRenderServiceConfiguration,
    dependencies: DeploymentRenderServiceDependencies,
    leases?: RenderSelectionAuthorityLeases,
): Promise<SelectedRenderAuthority> {
    const operation = await prepareRenderOperation(base, configuration, dependencies);
    return resolveSelectedRenderAuthority(operation, request, configuration, dependencies, leases);
}

async function resolveSelectedRenderAuthority(
    operation: RenderOperationAuthority,
    request: RenderSelectionRequest,
    configuration: DeploymentRenderServiceConfiguration,
    dependencies: DeploymentRenderServiceDependencies,
    leases?: RenderSelectionAuthorityLeases,
): Promise<SelectedRenderAuthority> {
    const analysis = requireRenderOperationValue(await runAnalysis(operation));
    const selection = requireRenderOperationValue(
        dependencies.resolveSelection(
            { deployment: operation.deployment, analysis, request },
            selectionConfiguration(configuration, operation.registry),
            leases,
        ),
    );
    return { operation, analysis, selection };
}

async function completeSelectedRenderDraft(
    authority: SelectedRenderAuthority,
    base: RenderBaseAuthority,
    configuration: DeploymentRenderServiceConfiguration,
): Promise<SelectedRenderDraft> {
    const { operation, analysis, selection } = authority;
    const providerMaterialization = requireRenderOperationValue(
        await materializeRenderDeployment(
            { deployment: operation.deployment, analysis, selection },
            {
                registry: operation.registry,
                dialectRegistry: configuration.dialectRegistry,
                resolveDialectInputs: (provider, deployment, semantics) =>
                    resolveOperationDialectInputs(operation, provider, deployment, semantics),
                dispatch: dispatchMaterializeRender,
            },
        ),
    );
    return withDeploymentTargetOperations(configuration, base, (targetOperations) => {
        const materialization = requireRenderOperationValue(
            targetOperations.review.resolveContainerPatches(providerMaterialization),
        );
        const compiledPlan = requireRenderOperationValue(
            compileRenderDeployment({
                deployment: operation.deployment,
                analysis,
                selection,
                materialization,
                appliedInputsSnapshot: base.appliedInputsSnapshot,
            }),
        );
        const compiled = projectValidatedCompiledDeploymentPreviewInput(compiledPlan);
        let preview: CapturedDeploymentPreWritePreview;
        try {
            preview = targetOperations.review.capturePreWritePreview({
                deploymentId: base.deploymentId,
                targetRootPath: base.targetRootPath,
                renderInputFingerprint: operation.deployment.renderInputFingerprint,
                selectionFingerprint: selection.selectionFingerprint,
                compilationFingerprint: compiled.compilationFingerprint,
                targetPlan: compiled.targetPlan,
                baseline: loadDeploymentBaseline(configuration.db, base.deploymentId),
            });
        } catch (error) {
            throw mapPreWritePreviewError(error);
        }
        return { ...authority, compiledPlan, preview };
    });
}

function mapPreWritePreviewError(error: unknown): DeploymentRenderFailure {
    if (!(error instanceof DeploymentPreWritePreviewError)) throw error;
    return new DeploymentRenderFailure(
        error.code,
        error.message,
        error.code === "render.preview_target_unavailable" ? "unavailable" : "unsupported",
        error.code === "render.preview_target_unavailable",
        [],
    );
}

/** @internal Narrow helper seam for the overwrite inspection boundary. */
export const deploymentRenderServiceInternalsForTest = Object.freeze({
    ...deploymentRenderActionAuthorityInternalsForTest,
    classifyAssetUsageRelationship,
    mapPreWritePreviewError,
});

/** @internal — strict durable Deployment/Asset/Version projection. */
export function loadRenderBaseAuthority(
    configuration: DeploymentRenderServiceConfiguration,
    deploymentId: UuidV4,
): RenderBaseAuthority {
    if (!isUuidV4(deploymentId)) {
        throw new DeploymentRenderFailure(
            "render.deployment_id_invalid",
            "deploymentId must be UUID v4",
            "invalid_schema",
            false,
            [],
        );
    }
    const canonical = configuration.db.transaction(() => {
        const row = getDeployment(configuration.db, deploymentId);
        if (row === null) return null;
        return readCanonicalDeploymentPreCommitDatabaseStateFromConnection(configuration.db, deploymentId);
    })();
    if (canonical === null) {
        throw new DeploymentRenderFailure(
            "render.deployment_unavailable",
            "Deployment is missing or deleted",
            "not_found",
            false,
            [],
        );
    }
    if (canonical.deployment.deleted) {
        throw new DeploymentRenderFailure(
            "render.deployment_unavailable",
            "Deployment is missing or deleted",
            "not_found",
            false,
            [],
        );
    }
    const consumerAgentRuntimeIds = canonical.deployment.consumerAgentRuntimeIds;
    if (consumerAgentRuntimeIds.length === 0) {
        throw new DeploymentRenderFailure(
            "render.consumer_missing",
            "Deployment has no consumer agent runtime",
            "invalid_schema",
            false,
            [],
        );
    }
    const deploymentAssets = canonical.deploymentAssets
        .filter((item) => !item.deleted)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((item) => ({
            assetId: item.assetId,
            versionId: item.versionId,
            allowIncomplete: item.allowIncomplete,
        }));
    const loaded = loadRenderAssetAuthorities(configuration, canonical.deployment.projectId, deploymentAssets);
    const appliedInputsSnapshot: AppliedInputsSnapshotV1 = {
        schemaVersion: 1,
        deploymentId,
        consumerAgentRuntimeIds: [...consumerAgentRuntimeIds],
        assets: deploymentAssets.map((item) => ({
            assetId: item.assetId,
            versionId: item.versionId,
            allowIncomplete: item.allowIncomplete,
        })),
    };
    return {
        deploymentId,
        consumerAgentRuntimeIds,
        platform: canonical.deployment.platform,
        platformInstanceId: canonical.deployment.platformInstanceId,
        targetRootPath: canonical.deployment.targetRootPath,
        projectId: canonical.deployment.projectId,
        projectRootPath: loadProjectRootPath(configuration, canonical.deployment.projectId),
        assets: loaded.assets,
        dialectInputs: loaded.dialectInputs,
        appliedInputsSnapshot,
    };
}

/** @internal — fresh probe/registry/target-context operation snapshot. */
export async function prepareRenderOperation(
    base: RenderBaseAuthority,
    configuration: DeploymentRenderServiceConfiguration,
    dependencies: DeploymentRenderServiceDependencies,
    currentProbeResults?: readonly ProbeResult[],
    targetCheckSnapshot?: TargetCheckObservationSnapshot,
    captureMemoryTargets?: CaptureMemoryCatalogTargets,
): Promise<RenderOperationAuthority> {
    const providers = structuredClone(listAdapterProviders().value);
    const registry = dependencies.buildRenderRegistry(providers);
    const platformContext = selectPlatformContext(
        configuration.platformContexts,
        base.platform,
        base.platformInstanceId,
        base.targetRootPath,
    );
    const consumers = renderConsumers(base, registry);
    const ownerAdapterIds = uniqueSorted(consumers.map((consumer) => consumer.ownerAdapterId)) as AdapterId[];
    const assetKinds = [...new Set(base.assets.map((asset) => asset.version.canonical.kind))].sort();
    const probeSnapshot = await resolveRenderProbeSnapshot({
        base,
        ownerAdapterIds,
        platformContext,
        probeAdapters: dependencies.probeAdapters,
        currentProbeResults,
    });
    const probeResults = probeSnapshot.results;
    const physicalBuildObservation = selectedWslBuildObservation(
        configuration.platformContexts,
        configuration.selectedWslProbeExecution,
        currentProbeResults ?? probeResults,
    );
    const observations = targetCheckSnapshot ?? createTargetCheckObservationSnapshot();
    if (targetCheckSnapshot === undefined) {
        retainCurrentTargetBuildObservations(probeResults, base.consumerAgentRuntimeIds, observations);
    } else if (currentProbeResults !== undefined) {
        // All original snapshots have passed registered Provider validation before any prewarm I/O begins.
        primeOperationLocalBuildArtifactObservations(
            currentProbeResults,
            observations,
            physicalBuildObservation?.observeBuildArtifacts,
        );
    }
    const resolveObservedTargetContext: ObservedRenderTargetContextResolver =
        physicalBuildObservation === undefined
            ? dependencies.resolveObservedTargetContext
            : (input, snapshot) =>
                  dependencies.resolveObservedTargetContext(input, snapshot, physicalBuildObservation.snapshotRegularFile);
    const targetContexts = await Promise.all(
        consumers.map((consumer) =>
            resolveRenderTargetContextAsync(
                {
                    agentRuntimeId: consumer.agentRuntimeId,
                    targetRootPath: base.targetRootPath,
                    projectRootPath: base.projectRootPath,
                    ownerAdapterId: consumer.ownerAdapterId,
                    provider: consumer.provider,
                    probeResults,
                    assetKinds,
                },
                resolveObservedTargetContext,
                observations,
            ),
        ),
    );
    if (captureMemoryTargets !== undefined)
        return projectRenderOperation(
            base,
            registry,
            targetContexts,
            probeSnapshot.diagnostics,
            captureMemoryTargets,
            configuration.dialectRegistry,
        );
    return withSelectedMemoryCatalogCapture(configuration, base, (capture) =>
        projectRenderOperation(base, registry, targetContexts, probeSnapshot.diagnostics, capture, configuration.dialectRegistry),
    );
}

/** @internal Rebuild a reverse review/commit draft from its own fresh inspection's target observation. */
export function reprojectObservedReverseRenderOperation(
    base: RenderBaseAuthority,
    observed: { readonly base: RenderBaseAuthority; readonly operation: RenderOperationAuthority },
    dependencies: Pick<DeploymentRenderServiceDependencies, "buildRenderRegistry">,
    captureMemoryTargets?: CaptureMemoryCatalogTargets,
): RenderOperationAuthority {
    const registry = dependencies.buildRenderRegistry(structuredClone(listAdapterProviders().value));
    const expected = physicalRenderInput(base);
    if (
        expected !== physicalRenderInput(observed.base) ||
        expected !== physicalRenderInput({ ...observed.operation.deployment, projectRootPath: observed.base.projectRootPath }) ||
        registry.fingerprint !== observed.operation.registry.fingerprint ||
        registry.fingerprint !== observed.operation.deployment.renderRegistryFingerprint
    ) {
        throw new DeploymentRenderFailure(
            "render.action_time_context_changed",
            "reverse draft physical inputs changed after its fresh target observation",
            "conflict",
            true,
            [],
        );
    }
    return projectRenderOperation(
        base,
        registry,
        observed.operation.deployment.targetContexts,
        observed.operation.diagnostics,
        captureMemoryTargets,
        observed.operation.dialectRegistry,
    );
}

function physicalRenderInput(base: Omit<RenderBaseAuthority, "dialectInputs" | "appliedInputsSnapshot">): string {
    return stableStringify({
        deploymentId: base.deploymentId,
        consumerAgentRuntimeIds: base.consumerAgentRuntimeIds,
        platform: base.platform,
        platformInstanceId: base.platformInstanceId,
        targetRootPath: base.targetRootPath,
        projectId: base.projectId,
        projectRootPath: base.projectRootPath,
        // Equal kinds and the same registry/consumers imply equal target-context schema requests.
        assetKinds: [...new Set(base.assets.map((asset) => asset.version.canonical.kind))].sort(),
    });
}

function renderConsumers(base: RenderBaseAuthority, registry: RenderRegistrySnapshot) {
    return base.consumerAgentRuntimeIds.map((agentRuntimeId) => {
        const owner = registry.getOwner(agentRuntimeId);
        if (owner === null || !owner.enabled) {
            throw new DeploymentRenderFailure(
                "render.consumer_owner_unavailable",
                `consumer owner is unavailable: ${agentRuntimeId}`,
                "unavailable",
                true,
                [],
            );
        }
        return { agentRuntimeId, ownerAdapterId: owner.adapterId, provider: owner };
    });
}

function projectRenderOperation(
    base: RenderBaseAuthority,
    registry: RenderRegistrySnapshot,
    targetContexts: readonly TargetAgentRuntimeRenderContext[],
    diagnostics: readonly OperationDiagnostic[],
    captureMemoryTargets?: CaptureMemoryCatalogTargets,
    dialectRegistry?: VersionDialectRegistryV1,
): RenderOperationAuthority {
    const consumers = renderConsumers(base, registry);
    const basePreimage = {
        schemaVersion: 1 as const,
        deploymentId: base.deploymentId,
        consumerAgentRuntimeIds: [...base.consumerAgentRuntimeIds],
        platform: base.platform,
        platformInstanceId: base.platformInstanceId,
        targetRootPath: base.targetRootPath,
        projectId: base.projectId,
        targetContexts: structuredClone([...targetContexts]),
        renderRegistryFingerprint: registry.fingerprint,
        assets: structuredClone(base.assets),
    };
    const draftDeployment: RenderDeploymentInput = {
        ...basePreimage,
        renderInputFingerprint: "" as RenderDeploymentInput["renderInputFingerprint"],
    };
    const requiredSemantics = deriveRequiredRenderSemanticsV1(draftDeployment);
    const selectedDialectInputs = [
        ...new Map(consumers.map((consumer) => [consumer.ownerAdapterId, consumer.provider])).values(),
    ].flatMap((provider) => {
        const ownedRuntimeIds = new Set(provider.agentRuntimes.map((runtime) => runtime.agentRuntimeId));
        return resolveProviderExactFileDialectInputs({
            provider,
            deployment: draftDeployment,
            semantics: requiredSemantics.filter((semantic) => ownedRuntimeIds.has(semantic.consumerAgentRuntimeId)),
            available: base.dialectInputs,
            renderRegistry: registry,
            ...(dialectRegistry === undefined ? {} : { dialectRegistry }),
        });
    });
    const targetFileSnapshots = captureMemoryCatalogTargetFileSnapshots(
        {
            targetRootPath: base.targetRootPath,
            assets: base.assets,
            dialectInputs: selectedDialectInputs,
        },
        captureMemoryTargets,
    );
    const preimage = {
        ...basePreimage,
        ...(targetFileSnapshots.length === 0 ? {} : { targetFileSnapshots }),
    };
    return {
        deployment: {
            ...preimage,
            renderInputFingerprint: computeRenderInputFingerprint(preimage),
        },
        registry,
        ...(dialectRegistry === undefined ? {} : { dialectRegistry }),
        dialectInputs: structuredClone(base.dialectInputs),
        diagnostics: structuredClone([...diagnostics]),
    };
}

/** @internal — run analysis against one frozen operation snapshot. */
export async function runAnalysis(operation: RenderOperationAuthority): Promise<CoreResult<RenderAnalysisView>> {
    return analyzeRenderDeployment(operation.deployment, {
        registry: operation.registry,
        resolveDialectInputs: (provider, deployment, semantics) =>
            resolveOperationDialectInputs(operation, provider, deployment, semantics),
        dispatch: dispatchAnalyzeRender,
    });
}

/** @internal — authority-bearing selection configuration for lifecycle reuse. */
export function selectionConfiguration(configuration: DeploymentRenderServiceConfiguration, registry: RenderRegistrySnapshot) {
    return {
        assetsRoot: configuration.assetsRoot,
        oaamRoot: configuration.oaamRoot,
        authorityLocksRoot: configuration.authorityLocksRoot,
        dialectRegistry: configuration.dialectRegistry,
        registry,
        confirmOneTimeApproval: configuration.confirmOneTimeRenderApproval ?? denyUnverifiedOneTimeRenderApproval,
        resolveSavedPolicy: resolveNoSavedRenderPolicy,
        now: configuration.now,
    };
}

function uniqueSorted(values: string[]): string[] {
    return [...new Set(values)].sort();
}

function failed<T>(error: unknown, operation: OperationDiagnostic["operation"]): CoreResult<T> {
    const known = error instanceof DeploymentRenderFailure;
    if (known && error.diagnostics.length > 0) {
        return { status: "failed", value: undefined as T, diagnostics: error.diagnostics };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
        status: "failed",
        value: undefined as T,
        diagnostics: [
            {
                severity: "error",
                code:
                    error instanceof CoreMutationScopeError
                        ? error.code
                        : known
                          ? error.code
                          : "render.core_service_internal_error",
                message,
                path: "",
                traceId: "",
                operation,
                causeKind: known ? error.causeKind : "internal_error",
                retryable: known ? error.retryable : false,
                suggestedActions: known && error.retryable ? ["retry"] : [],
                rawSummary: message,
            },
        ],
    };
}
