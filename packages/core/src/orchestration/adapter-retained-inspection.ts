/** Retained renderer metadata is compiled only for inspection of already applied output. */
import type {
    AdapterProvider,
    AdapterProviderStaticDeclarations,
    AdapterRetainedInspectionBindingV1,
} from "../contracts/adapter";
import type { AdapterProviderSummary } from "../contracts/source-import";
import type { RenderedTargetInspectionInput } from "../contracts/reverse";
import type { Sha256Digest } from "../types";
import { validateRetainedInspectionRegistration } from "../adapters/adapter-contract-validator";
import {
    adapterRenderRegistryComponents,
    validateAdapterRenderContractRegistration,
} from "../render/adapter-render-contract-registration";
import {
    canonicalMaterializationValidatorsForProviders,
    snapshotCanonicalMaterializationValidators,
} from "../render/canonical-materialization-validation";
import { createRenderRegistry, type RenderRegistrySnapshot } from "../render/render-registry";
import { deepFreezeParentFirst } from "../foundation/deep-freeze";

interface RetainedInspectionPartition {
    readonly metadata: AdapterProviderStaticDeclarations;
    readonly registry: RenderRegistrySnapshot;
    readonly inspectRenderedTarget: AdapterProvider["inspectRenderedTarget"];
}

const partitions = new WeakMap<AdapterRetainedInspectionBindingV1, RetainedInspectionPartition>();

export function snapshotRetainedInspectionBindings(
    current: AdapterProviderStaticDeclarations,
    bindings: readonly AdapterRetainedInspectionBindingV1[] | undefined,
): readonly AdapterRetainedInspectionBindingV1[] {
    if (bindings === undefined) return Object.freeze([]);
    if (!Array.isArray(bindings)) throw new Error("retained inspection bindings must be an array");
    const versions = new Set([current.version]);
    return Object.freeze(
        bindings.map((source) => {
            const keys = new Set(Object.keys(source));
            for (const key of [
                "schemaVersion",
                "rendererVersion",
                "agentRuntimes",
                "targetContextSchemas",
                "assetTargetCapabilities",
                "materializerCapabilities",
                "renderContractDeclarations",
                "inspectRenderedTarget",
            ]) {
                if (!keys.delete(key)) throw new Error("retained inspection binding is incomplete");
            }
            keys.delete("canonicalMaterializationValidators");
            if (
                keys.size !== 0 ||
                source.schemaVersion !== 1 ||
                typeof source.rendererVersion !== "string" ||
                source.rendererVersion.trim() === "" ||
                versions.has(source.rendererVersion) ||
                typeof source.inspectRenderedTarget !== "function"
            ) {
                throw new Error("retained inspection binding has invalid or duplicate authority");
            }
            versions.add(source.rendererVersion);
            const binding: AdapterRetainedInspectionBindingV1 = Object.freeze({
                schemaVersion: 1,
                rendererVersion: source.rendererVersion,
                agentRuntimes: deepFreezeParentFirst(structuredClone(source.agentRuntimes)),
                targetContextSchemas: deepFreezeParentFirst(structuredClone(source.targetContextSchemas)),
                assetTargetCapabilities: deepFreezeParentFirst(structuredClone(source.assetTargetCapabilities)),
                materializerCapabilities: deepFreezeParentFirst(structuredClone(source.materializerCapabilities)),
                renderContractDeclarations: deepFreezeParentFirst(structuredClone(source.renderContractDeclarations)),
                canonicalMaterializationValidators: snapshotCanonicalMaterializationValidators(
                    source.canonicalMaterializationValidators,
                ),
                inspectRenderedTarget: source.inspectRenderedTarget,
            });
            if (
                binding.agentRuntimes.some(
                    (descriptor) =>
                        !current.agentRuntimes.some(
                            (owner) =>
                                owner.agentRuntimeId === descriptor.agentRuntimeId && owner.entryClass === descriptor.entryClass,
                        ),
                )
            )
                throw new Error("retained inspection runtime is not owned by the current Provider");
            const metadata: AdapterProviderStaticDeclarations = Object.freeze({
                adapterId: current.adapterId,
                displayName: current.displayName,
                version: binding.rendererVersion,
                agentRuntimes: binding.agentRuntimes,
                targetContextSchemas: binding.targetContextSchemas,
                assetSourceCapabilities: [],
                assetTargetCapabilities: binding.assetTargetCapabilities,
                materializerCapabilities: binding.materializerCapabilities,
                renderContractDeclarations: binding.renderContractDeclarations,
                // Append-only Version dialect contracts remain available independently of enablement.
                dialectContracts: current.dialectContracts,
                canonicalMaterializationValidators: binding.canonicalMaterializationValidators,
            });
            const issues = [
                ...validateRetainedInspectionRegistration(metadata),
                ...validateAdapterRenderContractRegistration([metadata]),
            ];
            if (issues.length !== 0)
                throw new Error("retained inspection metadata is invalid: " + issues.map((issue) => issue.message).join("; "));
            const summary: AdapterProviderSummary = {
                adapterId: metadata.adapterId,
                displayName: metadata.displayName,
                version: metadata.version,
                enabled: true,
                agentRuntimes: metadata.agentRuntimes,
                targetContextSchemas: metadata.targetContextSchemas,
                assetSourceCapabilities: [],
                assetTargetCapabilities: metadata.assetTargetCapabilities,
                materializerCapabilities: metadata.materializerCapabilities,
                renderContractDeclarations: metadata.renderContractDeclarations,
            };
            const registry = createRenderRegistry({
                providers: [summary],
                ...adapterRenderRegistryComponents([summary], canonicalMaterializationValidatorsForProviders([metadata])),
            });
            partitions.set(binding, Object.freeze({ metadata, registry, inspectRenderedTarget: binding.inspectRenderedTarget }));
            return binding;
        }),
    );
}

export function retainedInspectionPartition(
    provider: AdapterProvider,
    rendererVersion: string,
): RetainedInspectionPartition | null {
    const binding = provider.retainedInspectionBindings?.find((item) => item.rendererVersion === rendererVersion);
    return binding === undefined ? null : (partitions.get(binding) ?? null);
}

/** Derive the renderer only from the changed-unit closure of the applied snapshot. */
export function inspectionRendererPartition(
    input: RenderedTargetInspectionInput,
    adapterId: string,
): {
    rendererVersion: string;
    changedUnits: ReadonlySet<Sha256Digest>;
} {
    if (input.schemaVersion !== 1) throw new Error("inspection schemaVersion must be 1");
    const stateByPath = new Map(input.inspectionScope.fileStates.map((state) => [state.relativePath, state]));
    const changedUnits = new Set(input.inventoryDeltas.map((delta) => delta.outputUnitFingerprint));
    for (const file of input.files) {
        const state = stateByPath.get(file.relativePath);
        if (state === undefined) throw new Error("inspection file is outside its scope");
        changedUnits.add(state.outputUnitFingerprint);
    }
    if (changedUnits.size === 0) throw new Error("inspection partition contains no changed output unit");
    const renderers = new Map(input.appliedRenderSnapshot.outputUnitRenderers.map((row) => [row.outputUnitFingerprint, row]));
    const versions = new Set<string>();
    for (const unit of changedUnits) {
        const renderer = renderers.get(unit);
        if (renderer === undefined || renderer.rendererAdapterId !== adapterId) {
            throw new Error("inspection partition contains a foreign renderer");
        }
        versions.add(renderer.rendererAdapterVersion);
    }
    if (versions.size !== 1) throw new Error("inspection partition must contain one renderer version");
    return { rendererVersion: [...versions][0]!, changedUnits };
}
