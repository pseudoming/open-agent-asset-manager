import { assetUsageTargetFailureDiagnostic } from "./asset-usage-target-diagnostics";
/** Read-only render selection, materialization, and exact-target observation for Asset usage analysis. */

import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import type { ImportSourceSnapshotV1 } from "../contracts/persistence";
import type { TargetCheckObservationSnapshot } from "../render/native-project-target-observation-snapshot";
import { materializeRenderObservation } from "../render/render-materialization";
import { resolveAssetUsageObservationSelection } from "../render/render-selection";
import type { AgentRuntimeId, AssetUsageObservedTargetState, OperationDiagnostic, RenderAnalysisView } from "../types";
import { dispatchMaterializeRender } from "./adapter-registry";
import { classifyAssetUsageRelationship } from "./asset-usage-analysis";
import { type RenderOperationAuthority, resolveOperationDialectInputs } from "./deployment-render-authority";
import type { AssetUsageTargetOperations } from "./deployment-target-operations";

export async function observeAssetUsageRenderTargets(input: {
    readonly operation: RenderOperationAuthority;
    readonly analysis: RenderAnalysisView;
    readonly consumerAgentRuntimeIds: readonly AgentRuntimeId[];
    readonly targetOperations: AssetUsageTargetOperations;
    readonly dialectRegistry: VersionDialectRegistryV1;
    readonly sourceSnapshot?: ImportSourceSnapshotV1;
    readonly targetCheckSnapshot?: TargetCheckObservationSnapshot;
}): Promise<{
    readonly observedTargetStates: ReadonlyMap<AgentRuntimeId, AssetUsageObservedTargetState>;
    readonly diagnosticsByAgentRuntimeId: ReadonlyMap<AgentRuntimeId, readonly OperationDiagnostic[]>;
    readonly diagnostics: readonly OperationDiagnostic[];
}> {
    const observedTargetStates = new Map<AgentRuntimeId, AssetUsageObservedTargetState>();
    const diagnosticsByAgentRuntimeId = new Map<AgentRuntimeId, readonly OperationDiagnostic[]>();
    const diagnostics: OperationDiagnostic[] = [];
    const observations = await Promise.all(
        input.consumerAgentRuntimeIds.map(async (agentRuntimeId) => {
            const capability = classifyAssetUsageRelationship(agentRuntimeId, input.analysis).capability;
            if (capability === "unavailable") return { agentRuntimeId, diagnostics: [] } as const;
            const selected = resolveAssetUsageObservationSelection(
                { deployment: input.operation.deployment, analysis: input.analysis },
                input.operation.registry,
                [agentRuntimeId],
            );
            if (selected.status === "failed") return { agentRuntimeId, diagnostics: selected.diagnostics } as const;
            const [, materialized] = await Promise.all([
                input.targetOperations.primeUsageFiles(
                    selected.value.selection.outputUnits.flatMap((unit) => unit.claims.map((claim) => claim.relativePath)),
                    input.targetCheckSnapshot,
                ),
                materializeRenderObservation(
                    {
                        deployment: input.operation.deployment,
                        analysis: input.analysis,
                        observationSelection: selected.value,
                    },
                    {
                        registry: input.operation.registry,
                        dialectRegistry: input.dialectRegistry,
                        resolveDialectInputs: (provider, deployment, semantics) =>
                            resolveOperationDialectInputs(input.operation, provider, deployment, semantics),
                        dispatch: dispatchMaterializeRender,
                    },
                ),
            ]);
            if (materialized.status === "failed") {
                return { agentRuntimeId, diagnostics: materialized.diagnostics } as const;
            }
            const resolved = input.targetOperations.review.resolveContainerPatches(materialized.value);
            if (resolved.status === "failed") return { agentRuntimeId, diagnostics: resolved.diagnostics } as const;
            return {
                agentRuntimeId,
                diagnostics: [...materialized.diagnostics, ...resolved.diagnostics],
                materialization: resolved.value,
            } as const;
        }),
    );
    for (const observation of observations) {
        diagnostics.push(...observation.diagnostics);
        diagnosticsByAgentRuntimeId.set(observation.agentRuntimeId, observation.diagnostics);
    }
    const materialized = observations.filter((observation) => observation.materialization !== undefined);
    if (materialized.length > 0) {
        const targets = await input.targetOperations.observeUsageTargets(
            materialized.map((observation) => observation.materialization!),
            input.sourceSnapshot,
            input.targetCheckSnapshot,
        );
        targets.forEach((target, index) => {
            const observation = materialized[index]!;
            observedTargetStates.set(observation.agentRuntimeId, target.observedTargetState);
            if (target.failureStatus !== undefined) {
                const diagnostic = assetUsageTargetFailureDiagnostic(target.failureStatus);
                diagnostics.push(diagnostic);
                diagnosticsByAgentRuntimeId.set(observation.agentRuntimeId, [...observation.diagnostics, diagnostic]);
            }
        });
    }
    return { observedTargetStates, diagnosticsByAgentRuntimeId, diagnostics };
}
