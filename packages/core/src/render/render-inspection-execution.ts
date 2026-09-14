/** Rendered-target inspection partitioning and provider dispatch. */

import type { CoreResult, OperationDiagnostic, Sha256Digest } from "../types";
import type { AppliedRenderSnapshotV1, RenderOutputUnit } from "../contracts/deployment-authority";
import type {
    AdapterRenderedTargetInspectionResult,
    AttributedSemanticChange,
    RenderedFileAttributionResult,
    RenderedTargetInspectionInput,
    RenderedTargetInspectionResult,
    ReverseInspectionCoverageProof,
} from "../contracts/reverse";
import type { RenderRegistrySnapshot } from "./render-registry";
import { completeResult } from "../foundation/core-result";
import {
    validateInspectionInput,
    requiredInspectionUnits,
    groupUnitsByRenderer,
    buildInspectionPartition,
    partitionForUnit,
    resultForUnit,
    validateAdapterInspectionResult,
    mergeChanges,
    validateReverseProof,
    finalInspectionResult,
    requireExactSet,
    failed,
    InspectionFailure,
} from "./render-inspection-validation";

export interface InspectRenderedTargetConfiguration {
    registry: RenderRegistrySnapshot;
    resolveRetainedRegistry?(adapterId: string, rendererVersion: string): RenderRegistrySnapshot | null;
    dispatch(adapterId: string, input: RenderedTargetInspectionInput): Promise<CoreResult<AdapterRenderedTargetInspectionResult>>;
}

/** Bind only interpretation of Applied output; current Provider enablement still controls availability. */
export function resolveAppliedRenderer(
    configuration: Pick<InspectRenderedTargetConfiguration, "registry" | "resolveRetainedRegistry">,
    adapterId: string,
    rendererVersion: string,
) {
    const currentProvider = configuration.registry.getProvider(adapterId);
    const registry = currentProvider?.enabled
        ? currentProvider.version === rendererVersion
            ? configuration.registry
            : (configuration.resolveRetainedRegistry?.(adapterId, rendererVersion) ?? null)
        : null;
    const provider = registry?.getProvider(adapterId);
    return registry !== null && provider?.enabled && provider.version === rendererVersion ? { registry, provider } : null;
}

export async function inspectRenderedTarget(
    sourceInput: {
        appliedRenderSnapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>;
        inspection: RenderedTargetInspectionInput;
    },
    configuration: InspectRenderedTargetConfiguration,
): Promise<CoreResult<RenderedTargetInspectionResult>> {
    try {
        // Validate first so a hostile accessor is reported as the original
        // authority-read failure; snapshot immediately afterward, before the
        // first async provider boundary, to prevent later alias mutation.
        validateInspectionInput(sourceInput);
        const input = structuredClone(sourceInput);
        configuration = Object.freeze({ ...configuration });
        const stateByPath = new Map(input.inspection.inspectionScope.fileStates.map((state) => [state.relativePath, state]));
        const unitsByFingerprint = new Map(
            input.appliedRenderSnapshot.outputUnits.map((unit) => [unit.outputUnitFingerprint, unit]),
        );
        const rendererByUnit = new Map(
            input.appliedRenderSnapshot.outputUnitRenderers.map((renderer) => [renderer.outputUnitFingerprint, renderer]),
        );
        const changedUnitFingerprints = requiredInspectionUnits(input.inspection);
        if (changedUnitFingerprints.length === 0) {
            const value = finalInspectionResult(input.inspection.inspectionScope.inspectionScopeFingerprint, [], [], [], []);
            return completeResult(value);
        }
        const groups = groupUnitsByRenderer(changedUnitFingerprints, rendererByUnit);
        const aggregateChanges = new Map<string, AttributedSemanticChange>();
        const aggregateFiles = new Map<string, RenderedFileAttributionResult>();
        const proofs: ReverseInspectionCoverageProof[] = [];
        const diagnostics: OperationDiagnostic[] = [];

        for (const group of groups) {
            const applied = resolveAppliedRenderer(configuration, group.adapterId, group.adapterVersion);
            if (applied === null) {
                throw new InspectionFailure(
                    "render.inspection_renderer_stale",
                    `inspection renderer is unavailable: ${group.adapterId}`,
                    "unavailable",
                    true,
                );
            }
            const { registry, provider } = applied;
            const partition = buildInspectionPartition(input.inspection, stateByPath, group.unitFingerprints);
            const dispatched = await configuration.dispatch(provider.adapterId, structuredClone(partition));
            diagnostics.push(...dispatched.diagnostics);
            if (dispatched.status === "failed" || dispatched.value.status === "failed") {
                throw new InspectionFailure(
                    "render.inspection_provider_failed",
                    `inspection provider did not close its partition: ${provider.adapterId}`,
                    "unavailable",
                    false,
                );
            }
            if (dispatched.status === "partial" || dispatched.value.status === "partial") {
                return {
                    status: "partial",
                    value: undefined as unknown as RenderedTargetInspectionResult,
                    diagnostics,
                };
            }
            const result = structuredClone(dispatched.value);
            validateAdapterInspectionResult(result, partition, input.appliedRenderSnapshot);
            mergeChanges(aggregateChanges, result.changes);
            for (const file of result.files) {
                aggregateFiles.set(file.relativePath, file);
            }
            for (const unitFingerprint of group.unitFingerprints) {
                const outputUnit = unitsByFingerprint.get(unitFingerprint as Sha256Digest) as RenderOutputUnit;
                const unitInput = partitionForUnit(partition, stateByPath, unitFingerprint);
                const unitResult = resultForUnit(result, unitInput);
                const contract = registry.getOutputContract(outputUnit.outputContractId);
                if (contract === null || contract.outputContractFingerprint !== outputUnit.outputContractFingerprint) {
                    throw new InspectionFailure(
                        "render.inspection_contract_stale",
                        "inspection output contract is not in the frozen registry",
                        "conflict",
                        true,
                    );
                }
                const proof = registry.validateOutputContractReverseInspection({
                    contract,
                    outputUnit,
                    appliedRenderSnapshot: input.appliedRenderSnapshot,
                    inspectionScopeFingerprint: input.inspection.inspectionScope.inspectionScopeFingerprint,
                    files: unitInput.files,
                    inventoryDeltas: unitInput.inventoryDeltas,
                    adapterResult: unitResult,
                });
                validateReverseProof(proof, {
                    contractFingerprint: contract.outputContractFingerprint,
                    outputUnit,
                    inspectionScopeFingerprint: input.inspection.inspectionScope.inspectionScopeFingerprint,
                    files: unitInput.files,
                    inventoryDeltas: unitInput.inventoryDeltas,
                    result: unitResult,
                });
                proofs.push(proof);
            }
        }
        requireExactSet(
            [...aggregateFiles.keys()],
            input.inspection.files.map((file) => file.relativePath),
            "aggregate inspection file closure",
        );
        requireExactSet(
            proofs.map((proof) => proof.outputUnitFingerprint),
            changedUnitFingerprints,
            "aggregate reverse proof closure",
        );
        const value = finalInspectionResult(
            input.inspection.inspectionScope.inspectionScopeFingerprint,
            [...aggregateChanges.values()],
            [...aggregateFiles.values()],
            proofs,
            diagnostics,
        );
        return { status: "complete", value, diagnostics };
    } catch (error) {
        return failed(error);
    }
}
