import type { Database } from "better-sqlite3";
import { readVersionAuthority } from "../catalog/version-authority";
import { isCanonicalTargetRootPath, isUuidV4 } from "../foundation/validators";
import { listDeployments } from "../persistence/state-db";
import type {
    AdapterProviderSummary,
    AgentRuntimeId,
    AnalyzeAssetUsageInput,
    AssetKind,
    AssetUsageObservedTargetState,
    AssetUsageProjectionView,
    AssetUsageRelationshipView,
    ImportProvenanceAuthority,
    ImportSourceSnapshotV1,
    OperationDiagnostic,
    RenderAnalysisView,
    RenderDegradationKind,
    UuidV4,
} from "../types";
import { DeploymentRenderFailure } from "./deployment-render-action-authority";
import { loadProjectRootPath, loadRenderAssetAuthorities, type RenderAssetSelection } from "./deployment-render-asset-authority";
import type { RenderBaseAuthority } from "./deployment-render-authority";

interface AssetUsageConfiguration {
    readonly db: Database;
    readonly assetsRoot: string;
    readonly projectsRoot: string;
    readonly transactionsRoot: string;
    readonly dialectRegistry: Parameters<typeof loadRenderAssetAuthorities>[0]["dialectRegistry"];
    newUuid(): UuidV4;
}

interface AssetUsageDependencies {
    readDeploymentView(input: {
        readonly db: Database;
        readonly transactionsRoot: string;
        readonly deploymentId: UuidV4;
    }): import("../types").DeploymentView | null;
}

export function normalizeAssetUsageInput(source: AnalyzeAssetUsageInput): AnalyzeAssetUsageInput {
    const input = structuredClone(source);
    const invalid = (message: string): never => {
        throw new DeploymentRenderFailure("asset_usage.input_invalid", message, "invalid_schema", false, []);
    };
    if (input.projectId !== "" && !isUuidV4(input.projectId)) invalid("projectId must be empty or UUID v4");
    if (
        input.consumerAgentRuntimeIds.length === 0 ||
        input.consumerAgentRuntimeIds.some(
            (value) => value.length === 0 || value !== value.toUpperCase() || value.includes("\0"),
        ) ||
        new Set(input.consumerAgentRuntimeIds).size !== input.consumerAgentRuntimeIds.length
    ) {
        invalid("consumerAgentRuntimeIds must contain unique uppercase non-empty IDs");
    }
    input.consumerAgentRuntimeIds = [...input.consumerAgentRuntimeIds].sort();
    if (input.platform !== "win32" && input.platform !== "darwin" && input.platform !== "linux" && input.platform !== "wsl") {
        invalid("platform is invalid");
    }
    if (input.platformInstanceId.trim() === "" || input.platformInstanceId.includes("\0")) {
        invalid("platformInstanceId must be non-blank and NUL-free");
    }
    if (!isCanonicalTargetRootPath(input.targetRootPath, input.platform)) {
        invalid("targetRootPath must be canonical for platform");
    }
    if (!isUuidV4(input.asset.assetId) || !isUuidV4(input.asset.versionId) || typeof input.asset.allowIncomplete !== "boolean") {
        invalid("asset usage requires UUID v4 Asset and Version identities plus an explicit incomplete policy");
    }
    if (!Array.isArray(input.currentProbeResults) || input.currentProbeResults.length === 0) {
        invalid("asset usage requires at least one current probe result from the same read-only operation");
    }
    return input;
}

export function loadAssetUsageBaseAuthority(
    configuration: AssetUsageConfiguration,
    input: AnalyzeAssetUsageInput,
): RenderBaseAuthority {
    const deploymentId = configuration.newUuid();
    if (!isUuidV4(deploymentId)) {
        throw new DeploymentRenderFailure(
            "asset_usage.projection_identity_invalid",
            "asset usage projection identity must be UUID v4",
            "internal_error",
            false,
            [],
        );
    }
    const selections: readonly RenderAssetSelection[] = [input.asset];
    const loaded = loadRenderAssetAuthorities(configuration, input.projectId, selections);
    return {
        deploymentId,
        consumerAgentRuntimeIds: [...input.consumerAgentRuntimeIds],
        platform: input.platform,
        platformInstanceId: input.platformInstanceId,
        targetRootPath: input.targetRootPath,
        projectId: input.projectId,
        projectRootPath: loadProjectRootPath(configuration, input.projectId),
        assets: loaded.assets,
        dialectInputs: loaded.dialectInputs,
        appliedInputsSnapshot: {
            schemaVersion: 1,
            deploymentId,
            consumerAgentRuntimeIds: [...input.consumerAgentRuntimeIds],
            assets: selections.map((item) => ({ ...item })),
        },
    };
}

export function projectAssetUsageRelationships(
    configuration: AssetUsageConfiguration,
    dependencies: AssetUsageDependencies,
    input: AnalyzeAssetUsageInput,
    analysis: RenderAnalysisView | null,
    capableConsumerIds: ReadonlySet<AgentRuntimeId>,
    observedTargetStates: ReadonlyMap<AgentRuntimeId, AssetUsageObservedTargetState> = new Map(),
    observationDiagnostics: ReadonlyMap<AgentRuntimeId, readonly OperationDiagnostic[]> = new Map(),
): AssetUsageProjectionView {
    const matchingDeployments = listDeployments(configuration.db)
        .filter(
            (row) =>
                !row.deleted &&
                row.projectId === input.projectId &&
                row.platform === input.platform &&
                row.platformInstanceId === input.platformInstanceId &&
                row.targetRootPath === input.targetRootPath,
        )
        .flatMap((row) => {
            const view = dependencies.readDeploymentView({
                db: configuration.db,
                transactionsRoot: configuration.transactionsRoot,
                deploymentId: row.deploymentId as UuidV4,
            });
            return view === null ? [] : [view];
        });
    const relationships = [...input.consumerAgentRuntimeIds].sort().map((agentRuntimeId) => {
        const capabilityProjection =
            capableConsumerIds.has(agentRuntimeId) && analysis !== null
                ? classifyAssetUsageRelationship(agentRuntimeId, analysis)
                : {
                      capability: "unavailable" as const,
                      substitute: null,
                      degradationKinds: [],
                      reasonCodes: ["asset_usage.target_unsupported"],
                      diagnostics: [],
                      requiresReview: false,
                  };
        const configuredDeploymentIds = matchingDeployments
            .filter(
                (deployment) =>
                    deployment.consumerAgentRuntimeIds.includes(agentRuntimeId) &&
                    deployment.assets.some(
                        (asset) => asset.assetId === input.asset.assetId && asset.versionId === input.asset.versionId,
                    ),
            )
            .map((deployment) => deployment.deploymentId);
        const appliedDeploymentIds = matchingDeployments
            .filter(
                (deployment) =>
                    deployment.appliedInputsSnapshot.consumerAgentRuntimeIds.includes(agentRuntimeId) &&
                    deployment.appliedInputsSnapshot.assets.some(
                        (asset) => asset.assetId === input.asset.assetId && asset.versionId === input.asset.versionId,
                    ),
            )
            .map((deployment) => deployment.deploymentId);
        const deploymentIds = [...new Set([...configuredDeploymentIds, ...appliedDeploymentIds])].sort() as UuidV4[];
        return {
            agentRuntimeId,
            ...capabilityProjection,
            diagnostics: [...capabilityProjection.diagnostics, ...(observationDiagnostics.get(agentRuntimeId) ?? [])],
            observedTargetState: observedTargetStates.get(agentRuntimeId) ?? "unknown",
            managedState:
                appliedDeploymentIds.length > 0
                    ? ("applied" as const)
                    : deploymentIds.length > 0
                      ? ("configured" as const)
                      : ("none" as const),
            deploymentIds,
            appliedDeploymentIds: [...new Set(appliedDeploymentIds)].sort() as UuidV4[],
        };
    });
    return {
        schemaVersion: 2,
        assetId: input.asset.assetId,
        versionId: input.asset.versionId,
        relationships,
    };
}

export function assetUsageCapableConsumerIds(
    providers: readonly AdapterProviderSummary[],
    consumerAgentRuntimeIds: readonly AgentRuntimeId[],
    assetKinds: readonly AssetKind[],
    scope: "project" | "global",
): AgentRuntimeId[] {
    const selectedKinds = new Set(assetKinds);
    return consumerAgentRuntimeIds.filter((agentRuntimeId) =>
        providers.some(
            (provider) =>
                provider.agentRuntimes.some((runtime) => runtime.agentRuntimeId === agentRuntimeId) &&
                provider.assetTargetCapabilities.some(
                    (capability) =>
                        capability.agentRuntimeId === agentRuntimeId &&
                        selectedKinds.has(capability.assetKind) &&
                        capability.entrySupportStatus === "supported" &&
                        "targetContextSchemaId" in capability &&
                        hasCompatibleDeclaredScope(provider, capability.outputContractId, agentRuntimeId, scope),
                ),
        ),
    );
}

function hasCompatibleDeclaredScope(
    provider: AdapterProviderSummary,
    outputContractId: string,
    agentRuntimeId: AgentRuntimeId,
    scope: "project" | "global",
): boolean {
    const declarations = provider.renderContractDeclarations.filter(
        (declaration) => declaration.agentRuntimeId === agentRuntimeId && declaration.outputContractId === outputContractId,
    );
    // Only a proved scope mismatch is unavailable here; absent authority must still reach the existing validation gates.
    return (
        declarations.length === 0 ||
        declarations.some((declaration) => declaration.declarationKind.startsWith(`native_${scope}_`))
    );
}

export function classifyAssetUsageRelationship(
    agentRuntimeId: AgentRuntimeId,
    analysis: RenderAnalysisView,
): Pick<
    AssetUsageRelationshipView,
    "capability" | "substitute" | "degradationKinds" | "reasonCodes" | "diagnostics" | "requiresReview"
> {
    const semantics = analysis.requiredSemantics.filter((semantic) => semantic.consumerAgentRuntimeId === agentRuntimeId);
    const allOptions = analysis.analyses.flatMap((provider) => provider.semanticOptions);
    const allBlocked = analysis.analyses.flatMap((provider) => provider.blockedSemanticRefs);
    const selectedOptions = semantics.flatMap((semantic) => {
        const candidates = allOptions.filter((option) => option.semanticRefFingerprint === semantic.semanticRefFingerprint);
        const preserved = candidates.find((option) => option.outcome === "preserved");
        const degraded = candidates.filter((option) => option.outcome === "degraded");
        const selected =
            preserved ??
            [...degraded].sort((left, right) => {
                return (
                    left.degradationKinds.length - right.degradationKinds.length ||
                    left.reasonCode.localeCompare(right.reasonCode)
                );
            })[0];
        return selected === undefined ? [] : [selected];
    });
    const covered = semantics.length > 0 && selectedOptions.length === semantics.length;
    const substituteKinds = [...new Set(selectedOptions.flatMap((option) => option.substituteAssetKind ?? []))];
    const substitute = covered && substituteKinds.length === 1 ? { assetKind: substituteKinds[0] as AssetKind } : null;
    const capability = !covered
        ? ("unavailable" as const)
        : substitute !== null
          ? ("substitute" as const)
          : selectedOptions.every((option) => option.outcome === "preserved")
            ? ("direct" as const)
            : ("transformed" as const);
    const blockedForConsumer = semantics.flatMap((semantic) =>
        allBlocked.filter((blocked) => blocked.semanticRefFingerprint === semantic.semanticRefFingerprint),
    );
    const blockedReasonCodes = blockedForConsumer.map((blocked) => blocked.reasonCode);
    const reasonCodes = [
        ...new Set([
            ...selectedOptions.map((option) => option.reasonCode),
            ...blockedReasonCodes,
            ...(!covered && blockedReasonCodes.length === 0 ? ["asset_usage.semantic_unavailable"] : []),
        ]),
    ].sort();
    const degradationKinds = [
        ...new Set(selectedOptions.flatMap((option) => (option.outcome === "degraded" ? [...option.degradationKinds] : []))),
    ].sort() as RenderDegradationKind[];
    return {
        capability,
        substitute,
        degradationKinds,
        reasonCodes,
        diagnostics: [
            ...selectedOptions.flatMap((option) => option.diagnostics),
            ...blockedForConsumer.flatMap((blocked) => blocked.diagnostics),
        ],
        requiresReview:
            capability === "transformed" ||
            capability === "substitute" ||
            selectedOptions.some(
                (option) =>
                    option.approvalRequirement.approvalState === "required" ||
                    option.actualReverseExtractPolicy === "unsupported",
            ),
    };
}

/** Current Version's immutable import-source receipt, used only for operation-local physical-relation checks. */
export function loadAssetUsageSourceSnapshot(
    configuration: Pick<AssetUsageConfiguration, "assetsRoot" | "dialectRegistry">,
    input: AnalyzeAssetUsageInput,
): ImportSourceSnapshotV1 | undefined {
    const closure = readVersionAuthority(
        configuration.assetsRoot,
        input.asset.assetId,
        input.asset.versionId,
        configuration.dialectRegistry,
    );
    if (closure === null || closure.manifest.originAuthority.originKind !== "import") {
        return undefined;
    }
    const importedManifest = closure.manifest as typeof closure.manifest & {
        readonly importProvenanceAuthority: ImportProvenanceAuthority;
    };
    if (importedManifest.importProvenanceAuthority.schemaVersion !== 2) return undefined;
    return structuredClone(importedManifest.importProvenanceAuthority.sourceSnapshot);
}
