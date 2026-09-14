/** Phase-21 single composition root through T5 catalog, inspection and lifecycle orchestration. */

import * as crypto from "node:crypto";
import * as path from "node:path";
import { durableEnsureDirectory } from "@oaam/shared/filesystem";
import { isCanonicalPhysicalAccessPath } from "@oaam/shared/paths";
import { acquireProjectAuthorityLocks } from "../catalog/project-authority";
import type { CoreService } from "../contracts/core-service";
import type { ConfirmOneTimeRenderApprovalInput } from "../contracts/render";
import { executeDeployment } from "../deployment/deployment-executor";
import { readDeploymentView } from "../deployment/deployment-view";
import { completeResult } from "../foundation/core-result";
import { hasExactKeys, isSha256Digest, isStrictObject } from "../foundation/validators";
import { closeDb, getDb, resolveDbPath } from "../persistence/db";
import { adapterRenderRegistryComponents } from "../render/adapter-render-contract-registration";
import { resolveObservedNativeProjectTargetContextAsyncWithSnapshot } from "../render/native-project-guidance-observation";
import { createRenderRegistry } from "../render/render-registry";
import { resolveCoreRenderSelection, resolveCoreRenderSelectionWithAuthorityLeases } from "../render/render-selection";
import {
    createReverseAcceptMarkerStore,
    type ReverseAcceptRenderAnalysisValidator,
    scanReverseAcceptReservations,
} from "../reverse/reverse-accept-marker";
import { finalizeCommittedReverseAcceptPreparation } from "../reverse/reverse-accept-reconcile";
import {
    deriveAdapterReadAuthorityContext,
    readAuthorityContextsAreExact,
    SourceReadAuthorityError,
} from "../source-import/source-read-authority";
import type {
    AdapterProvider,
    AdapterReadResult,
    AdapterReadTarget,
    CoreResult,
    DeploymentView,
    EpochMillis,
    OperationDiagnostic,
    Platform,
    PlatformContext,
    RenderAnalysisView,
    UuidV4,
} from "../types";
import { createAdapterEnablementService } from "./adapter-enablement-service";
import {
    bootstrapAdapterRegistry,
    dispatchInspectRenderedTarget,
    getRegisteredRetainedInspectionRegistry,
    getRegisteredVersionDialectRegistry,
    getRegisteredCanonicalMaterializationValidators,
    probeAdapters,
    resolveRegisteredSourceCapabilityAgentRuntimeId,
    revalidateRegisteredReadAuthority,
} from "./adapter-registry";
import { createCoreAssetLibraryService } from "./core-asset-library-service";
import { createCoreAssetService } from "./core-asset-service";
import { createCoreCatalogSearchService } from "./core-catalog-search-service";
import { createCoreDeploymentCatalogService } from "./core-deployment-service";
import { createCoreMutationScopeGate } from "./core-mutation-scope";
import { createCoreProjectService, resolveActiveProjectIdByRoot } from "./core-project-service";
import { createCoreSettingsService } from "./core-settings-service";
import {
    createDeploymentInspectionService,
    type DeploymentInspectionServiceDependencies,
    inspectDeploymentRuntimeAuthority,
} from "./deployment-inspection-service";
import { createDeploymentLifecycleService } from "./deployment-lifecycle-service";
import { createDeploymentRecoveryViewReader } from "./deployment-recovery-projection";
import {
    createDeploymentRenderService,
    type DeploymentRenderServiceConfiguration,
    type DeploymentRenderServiceDependencies,
} from "./deployment-render-service";
import { createImportService } from "./import-service";
import { createPromotionGrantQuery } from "./promotion-grant-view";
import { commitAndCompleteReverseAccept } from "./reverse-accept-completion";
import { createStateBackupPolicyService } from "./state-backup-policy-service";
import { createStateBackupService } from "./state-backup-service";
import { assertStateProfileRestoreStartup } from "./state-profile-startup";
import { finalizeStateRestoreReopen } from "./state-restore-reopen";
import { createWatchedScanIntentService } from "./watched-scan-intent-service";
import { bindSelectedWslProbeExecution, type SelectedWslProbeExecution } from "./selected-wsl-probe-execution";
import type { SelectedWslTargetExecution } from "./selected-wsl-target-execution";
import { bindSelectedWslSourceExecution, type SelectedWslSourceExecution } from "./selected-wsl-source-execution";

export type { StateProfileRecoveryReason } from "../persistence/state-profile";
export { StateProfileRecoveryRequiredError } from "../persistence/state-profile";

interface CoreServiceTestDependencies extends DeploymentInspectionServiceDependencies {
    resolveProjectId(projectRootPath: string): UuidV4 | null;
}

/** Public composition input. Core owns clocks, identities, durable codecs, and validators. */
export interface CoreServiceConfiguration {
    providers: AdapterProvider[];
    platformContexts: PlatformContext[];
    oaamRoot: string;
    databasePath?: string;
    /** Trusted composition port; absent callers remain unable to approve a degraded render. */
    confirmOneTimeRenderApproval?: (input: ConfirmOneTimeRenderApprovalInput) => EpochMillis | null;
    /** Internal Windows App Server composition port; local Environments retain their local Provider path. */
    selectedWslProbeExecution?: SelectedWslProbeExecution;
    /** Internal Windows App Server composition port for whole target operations. */
    selectedWslTargetExecution?: SelectedWslTargetExecution;
    /** Trusted App Server source service; Core retains durable authority and physical lock ownership. */
    selectedWslSourceExecution?: SelectedWslSourceExecution;
}

/** Process-owned Core lifecycle returned only by the production composition factory. */
export interface CoreServiceProcessOwner extends CoreService {
    shutdownProcessState(): void;
}

/** @internal Test-only deterministic composition input; never exported from the package barrel. */
export interface CoreServiceTestConfiguration extends CoreServiceConfiguration {
    now?: () => EpochMillis;
    newUuid?: () => UuidV4;
}

interface CoreServiceInternalConfiguration extends CoreServiceTestConfiguration {
    renderAnalysisValidator: ReverseAcceptRenderAnalysisValidator;
}

/**
 * Bootstrap the one process-wide registry and bind source/import operations to durable Core
 * authorities. Phase-21 T4/T5 extend this same object; they do not create sibling orchestrators.
 */
export function createCoreService(sourceConfiguration: CoreServiceConfiguration): CoreServiceProcessOwner {
    try {
        return createCoreServiceCore(withProductionAuthorities(sourceConfiguration), DEFAULT_DEPENDENCIES);
    } catch (error) {
        closeDb();
        throw error;
    }
}

/** Test-only module-boundary seam; architecture tests forbid production imports. */
export function createCoreServiceForTest(
    sourceConfiguration: CoreServiceTestConfiguration,
    overrides: Partial<CoreServiceTestDependencies>,
): CoreService {
    return createCoreServiceCore(withTestAuthorities(sourceConfiguration), {
        ...DEFAULT_DEPENDENCIES,
        ...overrides,
    });
}

const STORED_RENDER_ANALYSIS_VALIDATOR: ReverseAcceptRenderAnalysisValidator = Object.freeze({
    validate: validateStoredRenderAnalysisEnvelope,
});

const DEFAULT_DEPENDENCIES: DeploymentInspectionServiceDependencies = Object.freeze({
    buildRenderRegistry(providers: Parameters<DeploymentRenderServiceDependencies["buildRenderRegistry"]>[0]) {
        return createRenderRegistry({
            providers,
            ...adapterRenderRegistryComponents(providers, getRegisteredCanonicalMaterializationValidators(providers)),
        });
    },
    resolveObservedTargetContext: resolveObservedNativeProjectTargetContextAsyncWithSnapshot,
    executeDeployment,
    resolveSelection(
        input: Parameters<DeploymentRenderServiceDependencies["resolveSelection"]>[0],
        configuration: Parameters<DeploymentRenderServiceDependencies["resolveSelection"]>[1],
        leases: Parameters<DeploymentRenderServiceDependencies["resolveSelection"]>[2],
    ) {
        return leases === undefined
            ? resolveCoreRenderSelection(input, configuration)
            : resolveCoreRenderSelectionWithAuthorityLeases(input, configuration, leases);
    },
    readDeploymentView,
    probeAdapters,
    dispatchInspection: dispatchInspectRenderedTarget,
    resolveRetainedInspectionRegistry: getRegisteredRetainedInspectionRegistry,
});

function createCoreServiceCore(
    sourceConfiguration: CoreServiceInternalConfiguration,
    dependencies: DeploymentInspectionServiceDependencies & {
        resolveProjectId?: (projectRootPath: string) => UuidV4 | null;
    },
): CoreServiceProcessOwner {
    const configuration = validateConfiguration(sourceConfiguration);
    const profileStartup = assertStateProfileRestoreStartup({
        oaamRoot: configuration.oaamRoot,
        databasePath: configuration.databasePath,
    });
    durableEnsureDirectory(path.dirname(configuration.oaamRoot), path.basename(configuration.oaamRoot));
    const databasePath = resolveDbPath(configuration.databasePath);
    const db = getDb(databasePath);
    const transactionsRoot = path.join(configuration.oaamRoot, "transactions");
    durableEnsureDirectory(configuration.oaamRoot, "transactions");
    const authorityLocksRoot = path.join(transactionsRoot, "authority-locks");
    const assetsRoot = path.join(configuration.oaamRoot, "assets");
    const projectsRoot = path.join(configuration.oaamRoot, "projects");
    const deploymentsRoot = path.join(configuration.oaamRoot, "deployments");
    const reverseAcceptMarkerStore = createReverseAcceptMarkerStore(transactionsRoot, configuration.renderAnalysisValidator);
    const deploymentDependencies: DeploymentInspectionServiceDependencies = {
        ...dependencies,
        probeAdapters: bindSelectedWslProbeExecution(
            configuration.platformContexts,
            configuration.selectedWslProbeExecution,
            dependencies.probeAdapters,
        ),
        readDeploymentView: createDeploymentRecoveryViewReader({
            transactionsRoot,
            markerStore: reverseAcceptMarkerStore,
            readBaseView: dependencies.readDeploymentView,
            scanReservations: scanReverseAcceptReservations,
        }),
    };
    const mutationGate = createCoreMutationScopeGate({
        db,
        transactionsRoot,
        reverseAcceptMarkerStore,
    });
    requireBootstrapResult(bootstrapAdapterRegistry(configuration.providers), "bootstrap adapter registry");
    const now = configuration.now ?? Date.now;
    const adapterEnablement = createAdapterEnablementService({
        oaamRoot: configuration.oaamRoot,
        authorityLocksRoot,
        assertMutationScope: (scope) => mutationGate.assertMutationScope(scope),
        now,
    });
    adapterEnablement.initializeProjection();
    const watchedScanIntent = createWatchedScanIntentService({
        oaamRoot: configuration.oaamRoot,
        projectsRoot,
        authorityLocksRoot,
        platformContexts: configuration.platformContexts,
        assertMutationScope: (scope) => mutationGate.assertMutationScope(scope),
        now,
    });
    const dialectRegistry = getRegisteredVersionDialectRegistry();
    if (profileStartup.state === "ready" && profileStartup.pendingRestore !== undefined) {
        finalizeStateRestoreReopen({
            db,
            oaamRoot: configuration.oaamRoot,
            databasePath,
            assetsRoot,
            projectsRoot,
            deploymentsRoot,
            transactionsRoot,
            dialectRegistry,
            pendingRestore: profileStartup.pendingRestore,
            now,
        });
    }

    const dispatchSourceRead = bindSelectedWslSourceExecution(
        configuration.platformContexts,
        configuration.selectedWslSourceExecution,
    );
    const readAssets = async (sourceInput: AdapterReadTarget): Promise<CoreResult<AdapterReadResult>> => {
        const input = structuredClone(sourceInput);
        try {
            const initialAuthority = deriveAdapterReadAuthorityContext({
                db,
                target: input,
                transactionsRoot,
            });
            const result = await dispatchSourceRead(input, initialAuthority, () =>
                readAuthorityContextsAreExact(
                    initialAuthority,
                    deriveAdapterReadAuthorityContext({
                        db,
                        target: input,
                        transactionsRoot,
                    }),
                ),
            );
            const finalAuthority = deriveAdapterReadAuthorityContext({
                db,
                target: input,
                transactionsRoot,
            });
            if (!readAuthorityContextsAreExact(initialAuthority, finalAuthority)) {
                return failed(
                    "read.authority_changed",
                    "durable managed-target or reservation authority changed during source read",
                    "read",
                    "conflict",
                    true,
                );
            }
            return result;
        } catch (error) {
            return error instanceof SourceReadAuthorityError
                ? failed(error.code, error.message, "read", "unavailable", true)
                : failed(
                      "read.authority_unavailable",
                      `source-read authority is unavailable: ${String(error)}`,
                      "read",
                      "unavailable",
                      true,
                  );
        }
    };

    const projectService = createCoreProjectService({
        projectsRoot,
        assetsRoot,
        authorityLocksRoot,
        transactionsRoot,
        db,
        assertMutationScope: (scope) => mutationGate.assertMutationScope(scope),
        now,
        newUuid: configuration.newUuid ?? (() => crypto.randomUUID() as UuidV4),
    });
    const catalogSearchService = createCoreCatalogSearchService({
        db,
        listProjects: projectService.listProjects,
    });
    let assetCatalogGeneration = 0;
    const assetLibraryService = createCoreAssetLibraryService({
        assetsRoot,
        db,
        dialectRegistry,
        catalogGeneration: () => assetCatalogGeneration,
        now,
    });
    const assetService = createCoreAssetService({
        assetsRoot,
        projectsRoot,
        authorityLocksRoot,
        db,
        dialectRegistry,
        assertMutationScope: (scope) => mutationGate.assertMutationScope(scope),
        onProjectionChanged: () => {
            assetCatalogGeneration += 1;
        },
        now,
        newUuid: configuration.newUuid ?? (() => crypto.randomUUID() as UuidV4),
    });
    const importService = createImportService({
        assetsRoot,
        oaamRoot: configuration.oaamRoot,
        authorityLocksRoot,
        dialectRegistry,
        resolveSourceCapabilityAgentRuntimeId: resolveRegisteredSourceCapabilityAgentRuntimeId,
        resolveProjectId:
            dependencies.resolveProjectId ?? ((projectRootPath) => resolveActiveProjectIdByRoot(projectsRoot, projectRootPath)),
        acquireProjectAuthority: (projectId) => acquireProjectAuthorityLocks(authorityLocksRoot, [projectId]),
        refreshReadResult: async (previous) => readAssets(previous.readTarget),
        validateReadAuthority: (previous) =>
            revalidateRegisteredReadAuthority(
                previous,
                deriveAdapterReadAuthorityContext({ db, target: previous.readTarget, transactionsRoot }),
            ),
        reindexImportedAsset: (assetId) =>
            assetService.reindexAssets({
                assetIds: [assetId],
                includeDeleted: true,
            }),
        assertMutationScope: (scope) => mutationGate.assertMutationScope(scope),
        now: configuration.now,
        newUuid: configuration.newUuid,
    });

    const renderConfiguration: DeploymentRenderServiceConfiguration = {
        db,
        assetsRoot,
        projectsRoot,
        oaamRoot: configuration.oaamRoot,
        authorityLocksRoot,
        transactionsRoot,
        deploymentsRoot,
        platformContexts: configuration.platformContexts,
        dialectRegistry,
        selectedWslTargetExecution: configuration.selectedWslTargetExecution,
        selectedWslProbeExecution: configuration.selectedWslProbeExecution,
        assertMutationScope: (scope) => mutationGate.assertMutationScope(scope),
        confirmOneTimeRenderApproval: configuration.confirmOneTimeRenderApproval,
        newUuid: configuration.newUuid ?? (() => crypto.randomUUID() as UuidV4),
        now,
    };
    const renderService = createDeploymentRenderService(renderConfiguration, deploymentDependencies);
    const inspectionService = createDeploymentInspectionService(renderConfiguration, deploymentDependencies);
    const lifecycleService = createDeploymentLifecycleService(
        {
            render: renderConfiguration,
            databasePath,
            renderAnalysisValidator: configuration.renderAnalysisValidator,
            newUuid: configuration.newUuid,
        },
        deploymentDependencies,
    );

    const deploymentCatalog = createCoreDeploymentCatalogService({
        db,
        assetsRoot,
        projectsRoot,
        authorityLocksRoot,
        transactionsRoot,
        readDeploymentView: deploymentDependencies.readDeploymentView,
        dialectRegistry,
        assertMutationScope: (scope) => mutationGate.assertMutationScope(scope),
        now,
        newUuid: configuration.newUuid ?? (() => crypto.randomUUID() as UuidV4),
    });
    const settingsService = createCoreSettingsService({
        oaamRoot: configuration.oaamRoot,
        authorityLocksRoot,
        assertMutationScope: (scope) => mutationGate.assertMutationScope(scope),
    });
    const stateBackupService = createStateBackupService({
        db,
        oaamRoot: configuration.oaamRoot,
        databasePath,
        authorityLocksRoot,
        now,
        newUuid: configuration.newUuid ?? (() => crypto.randomUUID() as UuidV4),
    });
    const stateBackupPolicyService = createStateBackupPolicyService({
        oaamRoot: configuration.oaamRoot,
        authorityLocksRoot,
        assertMutationScope: (scope) => mutationGate.assertMutationScope(scope),
        now,
    });

    const service: CoreServiceProcessOwner = {
        ...projectService,
        ...catalogSearchService,
        ...assetService,
        ...assetLibraryService,
        ...deploymentCatalog,
        ...settingsService,
        ...adapterEnablement.api,
        ...watchedScanIntent,
        ...stateBackupService,
        ...stateBackupPolicyService,
        shutdownProcessState: closeDb,
        getAvailablePlatformContexts(targetPlatforms: Platform[]) {
            if (targetPlatforms.some((platform) => !isPlatform(platform))) {
                return failed(
                    "environment.platform_invalid",
                    "targetPlatforms must contain only supported Platform values",
                    "probe",
                    "invalid_schema",
                    false,
                );
            }
            if (new Set(targetPlatforms).size !== targetPlatforms.length) {
                return failed(
                    "environment.platform_duplicate",
                    "targetPlatforms must be unique",
                    "probe",
                    "invalid_schema",
                    false,
                );
            }
            return completeResult(
                targetPlatforms.flatMap((platform) =>
                    configuration.platformContexts
                        .filter((context) => context.platform === platform)
                        .map((context) => structuredClone(context)),
                ),
            );
        },
        probeAdapters: deploymentDependencies.probeAdapters,
        readAssetsFromAdapter: readAssets,
        previewImport: importService.previewImport,
        acceptImport: importService.acceptImport,
        acceptImportBatch: importService.acceptImportBatch,
        listPromotionGrants: importService.listPromotionGrants,
        ...createPromotionGrantQuery(db, importService, projectService),
        createPromotionGrant: importService.createPromotionGrant,
        revokePromotionGrant: importService.revokePromotionGrant,
        getRestrictedSourcePromotionFullAccess: importService.getRestrictedSourcePromotionFullAccess,
        setRestrictedSourcePromotionFullAccess: importService.setRestrictedSourcePromotionFullAccess,
        analyzeAssetUsage: renderService.analyzeAssetUsage,
        analyzeDeploymentRender: renderService.analyzeDeploymentRender,
        previewDeploymentRender: renderService.previewDeploymentRender,
        async deployDeployment(input) {
            if (input.deploymentAction !== "overwrite_runtime") {
                return renderService.deployDeployment(input);
            }
            if (input.userActionId.trim().length === 0) {
                return failed(
                    "render.overwrite_user_action_missing",
                    "overwrite_runtime requires a non-empty userActionId",
                    "deploy",
                    "invalid_schema",
                    false,
                );
            }
            // The current schema-3 preview owns desired scope and protected facts.
            // An old runtime parser is not an authority for applying this Version.
            return renderService.deployDeployment(input);
        },
        scanDeployment: inspectionService.scanDeployment,
        inspectDeploymentRenderedTarget: inspectionService.inspectDeploymentRenderedTarget,
        prepareRenderedTargetAccept: lifecycleService.prepareRenderedTargetAccept,
        commitRenderedTargetAccept: (input) =>
            commitAndCompleteReverseAccept(input, {
                commit: lifecycleService.commitRenderedTargetAccept,
                finalize: (preparationId, version) =>
                    finalizeCommittedReverseAcceptPreparation(
                        {
                            transactionsRoot,
                            authorityLocksRoot,
                            assetsRoot,
                            deploymentsRoot,
                            databasePath,
                            dialectRegistry,
                            renderAnalysisValidator: configuration.renderAnalysisValidator,
                        },
                        preparationId,
                        version,
                    ),
                reindex: (assetId) => assetService.reindexAssets({ assetIds: [assetId], includeDeleted: true }),
            }),
        cancelRenderedTargetAccept: lifecycleService.cancelRenderedTargetAccept,
        async recoverDeployment(deploymentId) {
            const recovered = await lifecycleService.recoverDeployment(deploymentId);
            if (recovered.status === "failed") return recovered;
            return completeRecoveredAssetProjection(recovered, () =>
                assetService.reindexAssets({
                    assetIds: [...new Set(recovered.value.assets.map((asset) => asset.assetId))],
                    includeDeleted: true,
                }),
            );
        },
        async repairDeployment(input) {
            if (input.userActionId.trim().length === 0) {
                return failed(
                    "repair.user_action_missing",
                    "repairDeployment requires a non-empty userActionId",
                    "deploy",
                    "invalid_schema",
                    false,
                );
            }
            const inspected = await inspectDeploymentRuntimeAuthority(
                input.deploymentId,
                renderConfiguration,
                deploymentDependencies,
            );
            if (inspected.status !== "complete") {
                return {
                    status: "failed",
                    value: undefined as never,
                    diagnostics: structuredClone(inspected.diagnostics),
                };
            }
            if (inspected.value.result.inspectionResultFingerprint !== input.expectedInspectionResultFingerprint) {
                return failed(
                    "repair.inspection_stale",
                    "runtime inspection no longer matches the user-confirmed repair",
                    "deploy",
                    "conflict",
                    true,
                );
            }
            const changedFiles = inspected.value.input.files;
            const repairable =
                changedFiles.length > 0 &&
                changedFiles.every(
                    (file) =>
                        file.fileState === "baseline_missing" ||
                        (file.fileState === "baseline_changed" &&
                            file.appliedContent.contentKind === file.currentContent.contentKind &&
                            file.diffHunks.length === 0 &&
                            file.attributeChanges.length > 0),
                );
            if (!repairable) {
                return failed(
                    "repair.runtime_third_value",
                    "repairDeployment cannot overwrite changed runtime content",
                    "deploy",
                    "conflict",
                    false,
                );
            }
            const snapshot = inspected.value.appliedRenderSnapshot;
            return continueRepairAfterApprovalReplay(snapshot, async () => {
                const selectionRequest = {
                    schemaVersion: 1 as const,
                    renderInputFingerprint: snapshot.renderInputFingerprint,
                    semanticOptions: snapshot.decisions.map((decision) => ({
                        optionFingerprint: decision.optionFingerprint,
                        approvalRequest: { approvalAction: "none" as const },
                    })),
                };
                const preview = await renderService.previewDeploymentRender({
                    deploymentId: input.deploymentId,
                    selectionRequest,
                });
                if (preview.status === "failed") {
                    return { status: "failed", value: undefined as never, diagnostics: structuredClone(preview.diagnostics) };
                }
                return renderService.deployDeploymentWithRuntimeReplacement(
                    {
                        deploymentId: input.deploymentId,
                        deploymentAction: "overwrite_runtime",
                        expectedPreviewFingerprint: preview.value.previewFingerprint,
                        userActionId: input.userActionId,
                        selectionRequest,
                    },
                    {
                        ...inspected.value.runtimeReplacementAuthority,
                        replacementScope: { filePaths: [], directoryPaths: [] },
                    },
                );
            });
        },
    };
    return Object.freeze(service);
}

function repairApprovalReplayFailure(
    snapshot: Extract<import("../contracts/deployment-authority").AppliedRenderSnapshotV1, { snapshotState: "applied" }>,
): CoreResult<DeploymentView> | null {
    const replayable = snapshot.decisions.every((decision) => decision.approval.approvalState === "not_required");
    return replayable
        ? null
        : failed(
              "repair.applied_approval_not_replayable",
              "repair cannot replay a prior render approval without a fresh user selection",
              "deploy",
              "unsupported",
              false,
          );
}

async function continueRepairAfterApprovalReplay(
    snapshot: Extract<import("../contracts/deployment-authority").AppliedRenderSnapshotV1, { snapshotState: "applied" }>,
    continueRepair: () => Promise<CoreResult<DeploymentView>>,
): Promise<CoreResult<DeploymentView>> {
    return repairApprovalReplayFailure(snapshot) ?? continueRepair();
}

/** @internal Narrow orchestration helper seam; never exported from the package barrel. */
export const coreServiceInternalsForTest = Object.freeze({
    completeRecoveredAssetProjection,
    continueRepairAfterApprovalReplay,
    validateStoredRenderAnalysisEnvelope,
});

function validateConfiguration(input: CoreServiceInternalConfiguration): CoreServiceInternalConfiguration {
    const configuration = structuredCloneConfiguration(input);
    if (
        !path.isAbsolute(configuration.oaamRoot) ||
        path.normalize(configuration.oaamRoot) !== configuration.oaamRoot ||
        configuration.oaamRoot === path.parse(configuration.oaamRoot).root ||
        configuration.oaamRoot.endsWith(path.sep)
    ) {
        throw new Error("oaamRoot must be a canonical non-root absolute path");
    }
    const contexts = new Set<string>();
    for (const context of configuration.platformContexts) {
        const key = `${context.platform}\0${context.platformInstanceId}`;
        if (
            contexts.has(key) ||
            context.platformInstanceId.trim().length === 0 ||
            context.platformInstanceId.includes("\0") ||
            !isCanonicalPhysicalAccessPath(context.accessRootPath)
        ) {
            throw new Error("platformContexts must be unique and canonical");
        }
        contexts.add(key);
    }
    return Object.freeze(configuration);
}

function isPlatform(value: unknown): value is Platform {
    return value === "win32" || value === "darwin" || value === "linux" || value === "wsl";
}

function structuredCloneConfiguration(input: CoreServiceInternalConfiguration): CoreServiceInternalConfiguration {
    return {
        providers: [...input.providers],
        platformContexts: structuredClone(input.platformContexts),
        oaamRoot: input.oaamRoot,
        databasePath: input.databasePath,
        confirmOneTimeRenderApproval: input.confirmOneTimeRenderApproval,
        selectedWslProbeExecution: input.selectedWslProbeExecution,
        selectedWslTargetExecution: input.selectedWslTargetExecution,
        selectedWslSourceExecution: input.selectedWslSourceExecution,
        renderAnalysisValidator: input.renderAnalysisValidator,
        now: input.now,
        newUuid: input.newUuid,
    };
}

function withProductionAuthorities(input: CoreServiceConfiguration): CoreServiceInternalConfiguration {
    return {
        providers: input.providers,
        platformContexts: input.platformContexts,
        oaamRoot: input.oaamRoot,
        databasePath: input.databasePath,
        confirmOneTimeRenderApproval: input.confirmOneTimeRenderApproval,
        selectedWslProbeExecution: input.selectedWslProbeExecution,
        selectedWslTargetExecution: input.selectedWslTargetExecution,
        selectedWslSourceExecution: input.selectedWslSourceExecution,
        renderAnalysisValidator: STORED_RENDER_ANALYSIS_VALIDATOR,
    };
}

function withTestAuthorities(input: CoreServiceTestConfiguration): CoreServiceInternalConfiguration {
    return {
        ...withProductionAuthorities(input),
        now: input.now,
        newUuid: input.newUuid,
    };
}

/**
 * Durable prepared markers need only expose the envelope fields read before commit re-analysis.
 * The marker fingerprint authenticates the full stored JSON, and commit then recomputes and
 * exact-compares the complete RenderAnalysisView before using any nested semantic result.
 */
function validateStoredRenderAnalysisEnvelope(value: unknown): asserts value is RenderAnalysisView {
    if (!isStrictObject(value)) {
        throw new Error("stored render analysis must be an object");
    }
    if (!hasExactKeys(value, ["renderInputFingerprint", "requiredSemantics", "analyses"])) {
        throw new Error("stored render analysis has an invalid key set");
    }
    if (!isSha256Digest(value.renderInputFingerprint)) {
        throw new Error("stored render analysis input fingerprint is invalid");
    }
    if (!Array.isArray(value.requiredSemantics)) {
        throw new Error("stored render analysis semantics must be an array");
    }
    if (!Array.isArray(value.analyses)) {
        throw new Error("stored render analyses must be an array");
    }
}

function requireBootstrapResult<T>(result: CoreResult<T>, operation: string): void {
    if (result.status === "failed") {
        throw new Error(`${operation} failed: ${JSON.stringify(result.diagnostics)}`);
    }
}

function completeRecoveredAssetProjection(
    recovered: CoreResult<DeploymentView>,
    reindex: () => CoreResult<{ diagnostics: OperationDiagnostic[] }>,
): CoreResult<DeploymentView> {
    const projection = reindex();
    if (projection.status !== "complete") {
        return {
            status: "partial",
            value: recovered.value,
            diagnostics: [
                recoveryIndexProjectionFailure(
                    `recovered Asset index projection failed: ${JSON.stringify(projection.diagnostics)}`,
                ),
            ],
        };
    }
    const diagnostics = [...recovered.diagnostics, ...projection.diagnostics, ...projection.value.diagnostics];
    return diagnostics.length === 0
        ? recovered
        : {
              status: "partial",
              value: recovered.value,
              diagnostics: structuredClone(diagnostics),
          };
}

function recoveryIndexProjectionFailure(message: string): OperationDiagnostic {
    return {
        severity: "error",
        code: "recovery.asset_index_projection_failed",
        message,
        path: "",
        traceId: "",
        operation: "reindex",
        causeKind: "partial",
        retryable: true,
        suggestedActions: ["retry"],
        rawSummary: message,
    };
}

function failed<T>(
    code: string,
    message: string,
    operation: OperationDiagnostic["operation"],
    causeKind: OperationDiagnostic["causeKind"],
    retryable: boolean,
): CoreResult<T> {
    return {
        status: "failed",
        value: undefined as T,
        diagnostics: [
            {
                severity: "error",
                code,
                message,
                path: "",
                traceId: "",
                operation,
                causeKind,
                retryable,
                suggestedActions: retryable ? ["retry"] : [],
                rawSummary: message,
            },
        ],
    };
}
