/** Immutable render authorities shared by render and reverse orchestration. */

import type { RequiredRenderSemantic } from "../contracts/deployment-authority";
import type { snapshotPlatformContextRegularFileNoFollowBounded } from "@oaam/shared/paths";
import type {
    ObservedNativeProjectGuidanceTargetContextResolution,
    ResolveObservedNativeProjectGuidanceTargetContextInput,
} from "../render/native-project-guidance";
import type { TargetCheckObservationSnapshot } from "../render/native-project-target-observation-snapshot";
import { resolveProviderExactFileDialectInputs } from "../render/render-dialect-authority";
import type { RenderRegistrySnapshot } from "../render/render-registry";
import type {
    AdapterId,
    AdapterProviderSummary,
    AgentRuntimeId,
    AppliedInputsSnapshotV1,
    AssetKind,
    CoreResult,
    OperationDiagnostic,
    Platform,
    ProbeResult,
    ProviderRenderDialectInputsForAsset,
    RenderVersionDialectInputs,
    RenderAssetInput,
    RenderDeploymentInput,
    TargetAgentRuntimeRenderContext,
    UuidV4,
} from "../types";
import { DeploymentRenderFailure } from "./deployment-render-action-authority";
import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";

export interface RenderBaseAuthority {
    deploymentId: UuidV4;
    consumerAgentRuntimeIds: AgentRuntimeId[];
    platform: Platform;
    platformInstanceId: string;
    targetRootPath: string;
    projectId: string;
    projectRootPath: string;
    assets: RenderAssetInput[];
    dialectInputs: RenderVersionDialectInputs[];
    appliedInputsSnapshot: AppliedInputsSnapshotV1;
}

export interface RenderOperationAuthority {
    /** Internal immutable native validators; not persisted or projected to Provider summaries. */
    dialectRegistry?: VersionDialectRegistryV1;
    deployment: RenderDeploymentInput;
    registry: RenderRegistrySnapshot;
    dialectInputs: RenderVersionDialectInputs[];
    diagnostics: OperationDiagnostic[];
}

export type ObservedRenderTargetContextResolver = (
    input: ResolveObservedNativeProjectGuidanceTargetContextInput,
    snapshot?: TargetCheckObservationSnapshot,
    snapshotRegularFile?: typeof snapshotPlatformContextRegularFileNoFollowBounded,
) => ObservedNativeProjectGuidanceTargetContextResolution | Promise<ObservedNativeProjectGuidanceTargetContextResolution>;

export function resolveRenderTargetContext(
    input: {
        agentRuntimeId: AgentRuntimeId;
        targetRootPath: string;
        projectRootPath: string;
        ownerAdapterId: AdapterId;
        provider: AdapterProviderSummary;
        probeResults: ProbeResult[];
        assetKinds: readonly AssetKind[];
    },
    resolveObservedTargetContext: ObservedRenderTargetContextResolver,
    snapshot?: TargetCheckObservationSnapshot,
): TargetAgentRuntimeRenderContext {
    const matches = input.probeResults.filter((item) => item.observation.adapterId === input.ownerAdapterId);
    const match = matches[0];
    if (matches.length !== 1 || match === undefined) {
        throw new DeploymentRenderFailure(
            "render.probe_result_cardinality",
            `target probe did not return exactly one owner result for ${input.agentRuntimeId}`,
            "unavailable",
            true,
            [],
        );
    }
    const resolution = resolveObservedTargetContext(
        {
            provider: input.provider,
            probeResult: match,
            agentRuntimeId: input.agentRuntimeId,
            targetRootPath: input.targetRootPath,
            projectRootPath: input.projectRootPath,
            targetContextSchemaIds: targetContextSchemaIds(input.provider, input.agentRuntimeId, input.assetKinds),
        },
        snapshot,
    );
    if (resolution instanceof Promise) {
        throw new TypeError("synchronous target-context resolution received an asynchronous owner");
    }
    return requireObservedTargetContext(resolution);
}

export async function resolveRenderTargetContextAsync(
    input: Parameters<typeof resolveRenderTargetContext>[0],
    resolveObservedTargetContext: ObservedRenderTargetContextResolver,
    snapshot?: TargetCheckObservationSnapshot,
): Promise<TargetAgentRuntimeRenderContext> {
    const matches = input.probeResults.filter((item) => item.observation.adapterId === input.ownerAdapterId);
    const match = matches[0];
    if (matches.length !== 1 || match === undefined) {
        throw new DeploymentRenderFailure(
            "render.probe_result_cardinality",
            `target probe did not return exactly one owner result for ${input.agentRuntimeId}`,
            "unavailable",
            true,
            [],
        );
    }
    const resolution = await resolveObservedTargetContext(
        {
            provider: input.provider,
            probeResult: match,
            agentRuntimeId: input.agentRuntimeId,
            targetRootPath: input.targetRootPath,
            projectRootPath: input.projectRootPath,
            targetContextSchemaIds: targetContextSchemaIds(input.provider, input.agentRuntimeId, input.assetKinds),
        },
        snapshot,
    );
    return requireObservedTargetContext(resolution);
}

function requireObservedTargetContext(
    resolution: ObservedNativeProjectGuidanceTargetContextResolution,
): TargetAgentRuntimeRenderContext {
    if (resolution.status === "failed") {
        throw new DeploymentRenderFailure(
            resolution.diagnostics[0].code,
            resolution.diagnostics[0].message,
            resolution.diagnostics[0].causeKind,
            resolution.diagnostics[0].retryable,
            resolution.diagnostics,
        );
    }
    return structuredClone(resolution.targetContext);
}

function targetContextSchemaIds(
    provider: AdapterProviderSummary,
    agentRuntimeId: AgentRuntimeId,
    assetKinds: readonly AssetKind[],
): string[] {
    const kinds = new Set(assetKinds);
    return [
        ...new Set(
            provider.assetTargetCapabilities.flatMap((capability) =>
                capability.agentRuntimeId === agentRuntimeId &&
                kinds.has(capability.assetKind) &&
                "targetContextSchemaId" in capability
                    ? [capability.targetContextSchemaId]
                    : [],
            ),
        ),
    ].sort();
}

export function resolveOperationDialectInputs(
    operation: RenderOperationAuthority,
    provider: AdapterProviderSummary,
    deployment: RenderDeploymentInput,
    semantics: readonly RequiredRenderSemantic[],
): ProviderRenderDialectInputsForAsset[] {
    return resolveProviderExactFileDialectInputs({
        provider,
        deployment,
        semantics,
        available: operation.dialectInputs,
        renderRegistry: operation.registry,
        ...(operation.dialectRegistry === undefined ? {} : { dialectRegistry: operation.dialectRegistry }),
    });
}

export function mergeRenderOperationDiagnostics<T>(
    result: CoreResult<T>,
    operationDiagnostics: OperationDiagnostic[],
): CoreResult<T> {
    return {
        ...result,
        status: result.status === "complete" && operationDiagnostics.length > 0 ? "partial" : result.status,
        diagnostics: [...operationDiagnostics, ...result.diagnostics],
    };
}

export function requireRenderOperationValue<T>(result: CoreResult<T>): T {
    if (result.status !== "failed") return result.value;
    const diagnostic = result.diagnostics[0] as OperationDiagnostic;
    throw new DeploymentRenderFailure(
        diagnostic.code,
        diagnostic.message,
        diagnostic.causeKind,
        diagnostic.retryable,
        result.diagnostics,
    );
}
