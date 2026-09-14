/** Historical inspection uses the contracts that produced the applied native output. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    clearRegistry,
    disableAdapter,
    dispatchInspectRenderedTarget,
    enableAdapter,
    freezeRegistry,
    getRegisteredRetainedInspectionRegistry,
    listAdapterProviders,
    registerAdapterProvider,
} from "../../src/orchestration/adapter-registry";
import type { AdapterRetainedInspectionBindingV1 } from "../../src/contracts/adapter";
import { retainedInspectionPartition } from "../../src/orchestration/adapter-retained-inspection";
import { multiRendererInspectionFixture } from "./fixtures/render-inspection-test-fixtures";
import { inspectRenderedTarget, projectInspectionSafeAppliedRenderSnapshot } from "../../src/render/render-inspection";
import {
    computeAppliedRenderSnapshotFingerprint,
    computeRenderedTargetDiffHunkFingerprint,
    computeRenderedTargetInspectionScopeFingerprint,
    computeTargetFileRenderProvenanceFingerprint,
} from "../../src/foundation/fingerprint";
import { makeLifecycleAdapterProvider } from "./fixtures/render-lifecycle-fixtures";
import {
    canonicalValues,
    changedInspection,
    fullAppliedSnapshot,
    makeFixture,
    materializationInput as makeNativeProjectGuidanceMaterializationInput,
} from "./fixtures/native-project-guidance-test-fixtures";
beforeEach(() => clearRegistry());

function setup() {
    const old = makeFixture("claude");
    const current = makeFixture("claude", { adapterVersion: "0.4.0", outputSuffix: "-current" });
    const oldProvider = makeLifecycleAdapterProvider(old.provider);
    const currentProvider = makeLifecycleAdapterProvider(current.provider);
    const inspectOld = vi.fn(async (input: Parameters<typeof old.support.inspect>[0]) => old.support.inspect(input));
    const inspectCurrent = vi.fn(async (input: Parameters<typeof current.support.inspect>[0]) => current.support.inspect(input));
    const binding: AdapterRetainedInspectionBindingV1 = {
        schemaVersion: 1,
        rendererVersion: oldProvider.version,
        agentRuntimes: oldProvider.agentRuntimes,
        targetContextSchemas: oldProvider.targetContextSchemas,
        assetTargetCapabilities: oldProvider.assetTargetCapabilities,
        materializerCapabilities: oldProvider.materializerCapabilities,
        renderContractDeclarations: oldProvider.renderContractDeclarations,
        inspectRenderedTarget: inspectOld,
    };
    const provider = { ...currentProvider, inspectRenderedTarget: inspectCurrent, retainedInspectionBindings: [binding] };
    return { old, current, provider, binding, inspectOld, inspectCurrent };
}

function oldAppliedInput(fixture: ReturnType<typeof makeFixture>) {
    const materialization = makeNativeProjectGuidanceMaterializationInput(fixture);
    const inspection = changedInspection(fixture, materialization);
    const snapshot = fullAppliedSnapshot(inspection.appliedRenderSnapshot);
    const outputUnit = materialization.selection.outputUnits[0]!;
    const materialized = fixture.support.materialize(materialization);
    if (materialized.materializationState !== "materialized") {
        throw new Error("native materialization fixture did not close");
    }
    const contract = fixture.components.outputContracts[0]!;
    const profile = contract.materializationProfiles[0]!;
    snapshot.semanticCoverageProofs = [
        fixture.registry.validateOutputContractMaterialization({
            contract,
            profile,
            outputUnit,
            selectedSemantics: fixture.requiredSemantics,
            canonicalValues: canonicalValues(fixture),
            selectedOptions: materialization.selection.semanticOptions,
            files: materialized.materializedUnits[0]!.files,
        }),
    ];
    inspection.appliedRenderSnapshot = projectInspectionSafeAppliedRenderSnapshot(snapshot);
    const provenance = inspection.files[0]!.provenance;
    provenance.appliedRenderSnapshotFingerprint = computeAppliedRenderSnapshotFingerprint(snapshot);
    const { provenanceFingerprint: _storedProvenanceFingerprint, ...provenancePreimage } = provenance;
    provenance.provenanceFingerprint = computeTargetFileRenderProvenanceFingerprint(provenancePreimage);
    inspection.inspectionScope.fileStates[0]!.provenanceFingerprint = provenance.provenanceFingerprint;
    const state = inspection.inspectionScope.fileStates[0]!;
    const hunk = inspection.files[0]!.diffHunks[0]!;
    const { hunkFingerprint: _storedHunkFingerprint, ...hunkPreimage } = hunk;
    hunk.hunkFingerprint = computeRenderedTargetDiffHunkFingerprint({
        relativePath: inspection.files[0]!.relativePath,
        appliedContentHash: state.appliedContentHash,
        currentContentHash: state.currentContentHash,
        diffAlgorithmVersion: "core_byte_ranges_v1",
        hunk: hunkPreimage,
    });
    const { inspectionScopeFingerprint: _storedScopeFingerprint, ...scope } = inspection.inspectionScope;
    inspection.inspectionScope.inspectionScopeFingerprint = computeRenderedTargetInspectionScopeFingerprint({
        deploymentId: inspection.deploymentId,
        appliedCompilationFingerprint: snapshot.compilationFingerprint,
        scope,
    });
    return { appliedRenderSnapshot: snapshot, inspection };
}

describe("retained renderer inspection authority", () => {
    it("requires a compiled retained binding identity even when raw metadata has the same values", () => {
        const fixture = setup();
        expect(retainedInspectionPartition(fixture.provider, fixture.binding.rendererVersion)).toBeNull();
        expect(registerAdapterProvider(fixture.provider).status).toBe("complete");
        freezeRegistry();
        enableAdapter(fixture.provider.adapterId);
        expect(
            getRegisteredRetainedInspectionRegistry(fixture.provider.adapterId, fixture.binding.rendererVersion),
        ).not.toBeNull();
        expect(getRegisteredRetainedInspectionRegistry(fixture.provider.adapterId, "unretained-version")).toBeNull();
        expect(retainedInspectionPartition(fixture.provider, fixture.binding.rendererVersion)).toBeNull();
        expect(
            retainedInspectionPartition(
                {
                    ...fixture.provider,
                    retainedInspectionBindings: [{ ...fixture.binding }],
                },
                fixture.binding.rendererVersion,
            ),
        ).toBeNull();
        expect(fixture.inspectOld).not.toHaveBeenCalled();
        expect(fixture.inspectCurrent).not.toHaveBeenCalled();
    });

    it("rejects an unpartitioned request mixing retained and current renderer versions before callbacks", async () => {
        const fixture = setup(),
            combined = await multiRendererInspectionFixture();
        const input = structuredClone(combined.inspection);
        expect(input.files).toHaveLength(2);
        expect(input.appliedRenderSnapshot.outputUnitRenderers).toHaveLength(2);
        for (const [index, renderer] of input.appliedRenderSnapshot.outputUnitRenderers.entries()) {
            renderer.rendererAdapterId = fixture.provider.adapterId;
            renderer.rendererAdapterVersion = index === 0 ? fixture.binding.rendererVersion : fixture.provider.version;
        }
        expect(registerAdapterProvider(fixture.provider).status).toBe("complete");
        freezeRegistry();
        enableAdapter(fixture.provider.adapterId);
        const result = await dispatchInspectRenderedTarget(fixture.provider.adapterId, input);
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]).toMatchObject({ code: "render_inspection_error" });
        expect(result.diagnostics[0]!.message).toContain("inspection partition must contain one renderer version");
        expect(fixture.inspectOld).not.toHaveBeenCalled();
        expect(fixture.inspectCurrent).not.toHaveBeenCalled();
    });
    it("uses exact older contracts and callback without adding old write candidates", async () => {
        const fixture = setup(),
            input = oldAppliedInput(fixture.old);
        expect(registerAdapterProvider(fixture.provider).status).toBe("complete");
        freezeRegistry();
        enableAdapter(fixture.provider.adapterId);
        const current = listAdapterProviders().value;
        expect(current).toHaveLength(1);
        expect(current[0]!.version).toBe("0.4.0");
        expect(current[0]!.materializerCapabilities).toEqual(fixture.provider.materializerCapabilities);
        expect(current[0]).not.toHaveProperty("retainedInspectionBindings");
        expect(
            fixture.current.registry.getOutputContract(input.appliedRenderSnapshot.outputUnits[0]!.outputContractId),
        ).toBeNull();
        const result = await inspectRenderedTarget(input, {
            registry: fixture.current.registry,
            resolveRetainedRegistry: getRegisteredRetainedInspectionRegistry,
            dispatch: dispatchInspectRenderedTarget,
        });
        expect(result, JSON.stringify(result.diagnostics)).toMatchObject({ status: "complete" });
        expect(result.value.files).toHaveLength(1);
        expect(fixture.inspectOld).toHaveBeenCalledTimes(1);
        expect(fixture.inspectCurrent).not.toHaveBeenCalled();
        expect(input.inspection.files).toHaveLength(1);
    });

    it("keeps current enablement authoritative and rejects an absent historical partition", async () => {
        const fixture = setup(),
            input = oldAppliedInput(fixture.old);
        expect(registerAdapterProvider(fixture.provider).status).toBe("complete");
        freezeRegistry();
        expect(getRegisteredRetainedInspectionRegistry(fixture.provider.adapterId, fixture.binding.rendererVersion)).toBeNull();
        expect((await dispatchInspectRenderedTarget(fixture.provider.adapterId, input.inspection)).diagnostics[0]?.code).toBe(
            "adapter_disabled",
        );
        enableAdapter(fixture.provider.adapterId);
        const absent = await inspectRenderedTarget(input, {
            registry: fixture.current.registry,
            dispatch: dispatchInspectRenderedTarget,
        });
        expect(absent.diagnostics[0]?.code).toBe("render.inspection_renderer_stale");
        disableAdapter(fixture.provider.adapterId);
        expect(getRegisteredRetainedInspectionRegistry(fixture.provider.adapterId, fixture.binding.rendererVersion)).toBeNull();
        expect(fixture.inspectOld).not.toHaveBeenCalled();
    });

    it("freezes old metadata and rejects foreign profiles and unretained versions before dispatch", async () => {
        const fixture = setup(),
            input = oldAppliedInput(fixture.old);
        expect(registerAdapterProvider(fixture.provider).status).toBe("complete");
        freezeRegistry();
        enableAdapter(fixture.provider.adapterId);
        fixture.binding.materializerCapabilities[0]!.materializationProfileIds.length = 0;
        fixture.binding.renderContractDeclarations.length = 0;
        const old = getRegisteredRetainedInspectionRegistry(fixture.provider.adapterId, "0.3.0");
        expect(old?.getProvider(fixture.provider.adapterId)?.renderContractDeclarations).toHaveLength(1);
        for (const field of ["materializationProfileId", "rendererAdapterVersion"] as const) {
            const invalid = structuredClone(input.inspection);
            invalid.appliedRenderSnapshot.outputUnitRenderers[0]![field] = "unregistered";
            expect((await dispatchInspectRenderedTarget(fixture.provider.adapterId, invalid)).diagnostics[0]?.code).toBe(
                "render_inspection_error",
            );
        }
        expect(fixture.inspectOld).not.toHaveBeenCalled();
        expect((await dispatchInspectRenderedTarget(fixture.provider.adapterId, input.inspection)).status).toBe("complete");
        expect(fixture.inspectOld).toHaveBeenCalledTimes(1);
    });

    it.each([
        "not-array",
        "missing-method",
        "current-version",
        "duplicate",
        "foreign-runtime",
        "profile",
        "schema",
        "write-method",
    ])("atomically rejects invalid retained registration: %s", (mode) => {
        const fixture = setup();
        let binding = fixture.binding;
        if (mode === "current-version") binding = { ...binding, rendererVersion: fixture.provider.version };
        if (mode === "foreign-runtime") binding.agentRuntimes[0]!.agentRuntimeId = "FOREIGN_CLI";
        if (mode === "profile") binding.materializerCapabilities[0]!.materializationProfileIds = ["foreign"];
        if (mode === "schema") binding = { ...binding, schemaVersion: 2 as never };
        if (mode === "write-method") Object.assign(binding, { materializeRender: fixture.provider.materializeRender });
        if (mode === "missing-method") {
            const { inspectRenderedTarget: _inspect, ...incomplete } = binding;
            binding = incomplete as AdapterRetainedInspectionBindingV1;
        }
        const bindings = mode === "not-array" ? ({} as never) : mode === "duplicate" ? [binding, binding] : [binding];
        expect(registerAdapterProvider({ ...fixture.provider, retainedInspectionBindings: bindings }).status).toBe("failed");
        expect(listAdapterProviders().value).toEqual([]);
        expect(fixture.inspectOld).not.toHaveBeenCalled();
        expect(fixture.inspectCurrent).not.toHaveBeenCalled();
    });
});
