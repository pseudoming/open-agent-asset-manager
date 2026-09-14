/** Authority-focused split from the original oversized render test suite. */

import { describe, expect, it } from "vitest";
import { dispatchInspectRenderedTarget, enableAdapter, registerAdapterProvider } from "../../src/orchestration/adapter-registry";
import type { RenderedTargetInspectionInput } from "../../src/contracts/reverse";
import { inspectRenderedTarget, projectInspectionSafeAppliedRenderSnapshot } from "../../src/render/render-inspection";
import {
    computeRenderedTargetAttributeChangeFingerprint,
    computeRenderedTargetDiffHunkFingerprint,
    computeRenderedTargetInspectionScopeFingerprint,
    computeRenderedTargetInventoryDeltaFingerprint,
    computeAppliedRenderSnapshotFingerprint,
    computeMaterializationProfileConstraintFingerprint,
    computeOutputContractFingerprint,
    computeTargetFileRenderProvenanceFingerprint,
} from "../../src/foundation/fingerprint";
import { makeLifecycleAdapterProvider } from "./fixtures/render-lifecycle-fixtures";
import {
    canonicalValues,
    changedInspection,
    fullAppliedSnapshot,
    makeFixture as makeNativeProjectGuidanceFixture,
    materializationInput as makeNativeProjectGuidanceMaterializationInput,
} from "./fixtures/native-project-guidance-test-fixtures";
import { makeOutputContract, makeProviderSummary, makeRenderRegistry } from "./fixtures/render-contract-fixtures";
import {
    inspectionFixture,
    adapterResult,
    run,
    refreshScope,
    addedInspectionFixture,
    missingInspectionFixture,
    wholeFileResult,
    multiRendererInspectionFixture,
} from "./fixtures/render-inspection-test-fixtures";

describe("rendered target inspection dispatch and partitioning", () => {
    it("uses live registry inspection with the exact renderer partition and rejects unsafe provider exits", async () => {
        const fixture = makeNativeProjectGuidanceFixture("claude");
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
        const provider = makeLifecycleAdapterProvider(fixture.provider);
        let calls = 0;
        let captured: RenderedTargetInspectionInput | undefined;
        let mode: "valid" | "throw" | "invalid" | "partial" | "failed" = "valid";
        provider.inspectRenderedTarget = async (input) => {
            calls += 1;
            captured = structuredClone(input);
            if (mode === "throw") throw new Error("inspection fault");
            if (mode === "invalid") {
                return { status: "complete", changes: null, files: [], diagnostics: [] } as never;
            }
            if (mode === "partial" || mode === "failed") {
                return { status: mode, changes: [], files: [], diagnostics: [] };
            }
            if (input.files.length === 0) {
                return { status: "complete", changes: [], files: [], diagnostics: [] };
            }
            const value = fixture.support.inspect(input);
            input.files.length = 0;
            return value;
        };
        expect(registerAdapterProvider(provider).status).toBe("complete");
        expect(enableAdapter(provider.adapterId).status).toBe("complete");
        const live = await inspectRenderedTarget(
            { appliedRenderSnapshot: snapshot, inspection },
            { registry: fixture.registry, dispatch: dispatchInspectRenderedTarget },
        );
        expect(live, JSON.stringify(live.diagnostics)).toMatchObject({ status: "complete" });
        expect(calls).toBe(1);
        expect(inspection.files).toHaveLength(1);
        expect(captured?.files.map((file) => file.relativePath)).toEqual([outputUnit.claims[0]!.relativePath]);

        const invalidInputs: Array<(input: RenderedTargetInspectionInput) => void> = [
            (input) => {
                input.schemaVersion = 2 as never;
            },
            (input) => {
                input.files[0]!.relativePath = "outside.md";
            },
            (input) => {
                input.files = [];
            },
            (input) => {
                input.appliedRenderSnapshot.outputUnitRenderers[0]!.rendererAdapterId = "FOREIGN";
            },
            (input) => {
                input.appliedRenderSnapshot.outputUnitRenderers[0]!.materializerCapabilityKey = "missing";
            },
            (input) => {
                input.appliedRenderSnapshot.outputUnitRenderers[0]!.materializationProfileId = "missing";
            },
            (input) => {
                input.inspectionScope.fileStates[0]!.outputUnitFingerprint = `sha256:${"f".repeat(64)}`;
            },
            (input) => {
                input.appliedRenderSnapshot.outputUnits = [];
            },
            (input) => {
                input.appliedRenderSnapshot.outputUnits[0]!.outputContractId = "FOREIGN_CONTRACT";
            },
            (input) => {
                input.appliedRenderSnapshot.outputUnits[0]!.outputContractFingerprint = `sha256:${"e".repeat(64)}`;
            },
        ];
        for (const mutate of invalidInputs) {
            const invalid = structuredClone(inspection);
            mutate(invalid);
            expect((await dispatchInspectRenderedTarget(provider.adapterId, invalid)).diagnostics[0]?.code).toBe(
                "render_inspection_error",
            );
        }
        expect(calls).toBe(1);

        const inventoryOnly = structuredClone(inspection);
        inventoryOnly.files = [];
        const inventoryDelta = {
            outputUnitFingerprint: outputUnit.outputUnitFingerprint,
            relativePath: "managed/new.md",
            deltaKind: "file_added" as const,
            inventorySemanticRefFingerprint: `sha256:${"2".repeat(64)}`,
        };
        inventoryOnly.inventoryDeltas = [
            {
                ...inventoryDelta,
                inventoryDeltaFingerprint: computeRenderedTargetInventoryDeltaFingerprint({
                    inspectionScopeFingerprint: inventoryOnly.inspectionScope.inspectionScopeFingerprint,
                    delta: inventoryDelta,
                }),
            },
        ];
        expect((await dispatchInspectRenderedTarget(provider.adapterId, inventoryOnly)).status).toBe("complete");
        expect(calls).toBe(2);

        mode = "throw";
        expect((await dispatchInspectRenderedTarget(provider.adapterId, inspection)).diagnostics[0]?.code).toBe(
            "render_inspection_error",
        );
        mode = "invalid";
        expect((await dispatchInspectRenderedTarget(provider.adapterId, inspection)).diagnostics[0]?.code).toBe(
            "render_inspection_result_invalid",
        );
        mode = "partial";
        expect((await dispatchInspectRenderedTarget(provider.adapterId, inspection)).status).toBe("partial");
        mode = "failed";
        expect((await dispatchInspectRenderedTarget(provider.adapterId, inspection)).status).toBe("failed");
    });

    it("accepts only a declared managed descendant and a matching inventory delta", async () => {
        const fixture = await addedInspectionFixture();
        expect((await run(fixture, wholeFileResult(fixture.addedPath))).status).toBe("complete");
        const binary = await addedInspectionFixture("managed/binary.bin", true);
        expect((await run(binary, wholeFileResult(binary.addedPath))).status).toBe("complete");

        const outside = await addedInspectionFixture("outside.md");
        expect((await run(outside, wholeFileResult(outside.addedPath))).diagnostics[0]?.code).toBe(
            "render.inspection_scope_file_invalid",
        );

        const missingDelta = await addedInspectionFixture();
        missingDelta.inspection.inventoryDeltas = [];
        expect((await run(missingDelta, wholeFileResult(missingDelta.addedPath))).diagnostics[0]?.code).toBe(
            "render.inspection_inventory_delta_missing",
        );

        const mismatchedDelta = await addedInspectionFixture();
        const delta = mismatchedDelta.inspection.inventoryDeltas[0];
        if (delta === undefined) throw new Error("fixture delta missing");
        delta.deltaKind = "file_deleted";
        const { inventoryDeltaFingerprint: _stored, ...preimage } = delta;
        delta.inventoryDeltaFingerprint = computeRenderedTargetInventoryDeltaFingerprint({
            inspectionScopeFingerprint: mismatchedDelta.inspection.inspectionScope.inspectionScopeFingerprint,
            delta: preimage,
        });
        expect((await run(mismatchedDelta, wholeFileResult(mismatchedDelta.addedPath))).diagnostics[0]?.code).toBe(
            "render.inspection_inventory_delta_invalid",
        );

        const badBytes = await addedInspectionFixture();
        const badFile = badBytes.inspection.files[0];
        if (badFile?.fileState !== "added_managed_descendant") {
            throw new Error("fixture added file missing");
        }
        badFile.currentContent = { contentKind: "text", text: "different" };
        expect((await run(badBytes, wholeFileResult(badBytes.addedPath))).diagnostics[0]?.code).toBe(
            "render.inspection_file_authority_mismatch",
        );
    });

    it("partitions two changed units across two renderers and merges their exact proofs", async () => {
        const fixture = await multiRendererInspectionFixture();
        const calls: string[] = [];
        const result = await inspectRenderedTarget(
            { appliedRenderSnapshot: fixture.snapshot, inspection: fixture.inspection },
            {
                registry: fixture.registry,
                dispatch: async (adapterId, partition) => {
                    calls.push(adapterId);
                    return {
                        status: "complete",
                        value: {
                            status: "complete",
                            changes: [],
                            files: partition.files.map((file) => ({
                                relativePath: file.relativePath,
                                attributionState: "whole_file_adoption_required" as const,
                                diagnostics: [],
                            })),
                            diagnostics: [],
                        },
                        diagnostics: [],
                    };
                },
            },
        );
        expect(result.status).toBe("complete");
        expect(new Set(calls)).toEqual(new Set([fixture.provider.adapterId, "SECOND_RENDERER"]));
        expect(result.value.files).toHaveLength(2);
        expect(result.value.reverseCoverageProofs).toHaveLength(2);
    });

    it("rejects a missing, disabled, version-stale, or contract-stale renderer", async () => {
        const rendererMutations: Array<(fixture: Awaited<ReturnType<typeof inspectionFixture>>) => void> = [
            (fixture) => {
                fixture.snapshot.outputUnitRenderers[0]!.rendererAdapterId = "MISSING";
                fixture.inspection.appliedRenderSnapshot = projectInspectionSafeAppliedRenderSnapshot(fixture.snapshot);
            },
            (fixture) => {
                fixture.snapshot.outputUnitRenderers[0]!.rendererAdapterVersion = "stale";
                fixture.inspection.appliedRenderSnapshot = projectInspectionSafeAppliedRenderSnapshot(fixture.snapshot);
            },
        ];
        for (const mutate of rendererMutations) {
            const fixture = await inspectionFixture();
            mutate(fixture);
            expect((await run(fixture)).diagnostics[0]?.code).toBe("render.inspection_renderer_stale");
        }

        const disabled = await inspectionFixture();
        const disabledRegistry = makeRenderRegistry({
            providers: [{ ...disabled.provider, enabled: false }],
            contract: disabled.contract,
        });
        expect((await run(disabled, adapterResult(disabled), "complete", disabledRegistry)).diagnostics[0]?.code).toBe(
            "render.inspection_renderer_stale",
        );

        const staleContract = await inspectionFixture();
        const alternate = makeOutputContract();
        alternate.outputContractId = "OAAM_ALTERNATE_V1";
        const { outputContractFingerprint: _stored, ...contractPreimage } = alternate;
        alternate.outputContractFingerprint = computeOutputContractFingerprint(contractPreimage);
        for (const profile of alternate.materializationProfiles) {
            profile.profileConstraintFingerprint = computeMaterializationProfileConstraintFingerprint({
                outputContractFingerprint: alternate.outputContractFingerprint,
                materializationProfileId: profile.materializationProfileId,
                constraintValidator: profile.constraintValidator,
            });
        }
        const alternateProvider = makeProviderSummary({ contract: alternate });
        const alternateRegistry = makeRenderRegistry({
            providers: [alternateProvider],
            contract: alternate,
        });
        expect((await run(staleContract, adapterResult(staleContract), "complete", alternateRegistry)).diagnostics[0]?.code).toBe(
            "render.inspection_contract_stale",
        );
    });

    it("accepts a claimed missing file and rejects a correctly fingerprinted out-of-bounds hunk", async () => {
        const missing = await missingInspectionFixture();
        expect((await run(missing, wholeFileResult(missing.target.relativePath))).status).toBe("complete");
        const missingLie = await missingInspectionFixture();
        const missingFile = missingLie.inspection.files[0];
        if (missingFile?.fileState !== "baseline_missing") {
            throw new Error("fixture missing file mismatch");
        }
        missingFile.appliedContent = { contentKind: "text", text: "different" };
        expect((await run(missingLie, wholeFileResult(missingLie.target.relativePath))).diagnostics[0]?.code).toBe(
            "render.inspection_file_authority_mismatch",
        );

        const managedMissing = await missingInspectionFixture({
            analysisResultOptions: {
                relativePath: "managed/AGENTS.md",
                managedDirectoryBoundary: "managed",
            },
        });
        expect((await run(managedMissing, wholeFileResult(managedMissing.target.relativePath))).status).toBe("complete");
        managedMissing.inspection.inventoryDeltas = [];
        expect((await run(managedMissing, wholeFileResult(managedMissing.target.relativePath))).diagnostics[0]?.code).toBe(
            "render.inspection_inventory_delta_missing",
        );

        const changedWithoutHunk = await inspectionFixture();
        changedWithoutHunk.inspection.files[0]!.diffHunks = [];
        expect((await run(changedWithoutHunk)).diagnostics[0]?.code).toBe("render.inspection_hunk_missing");
        const missingWithoutHunk = await missingInspectionFixture();
        missingWithoutHunk.inspection.files[0]!.diffHunks = [];
        expect(
            (await run(missingWithoutHunk, wholeFileResult(missingWithoutHunk.target.relativePath))).diagnostics[0]?.code,
        ).toBe("render.inspection_hunk_missing");
        const addedWithoutHunk = await addedInspectionFixture();
        addedWithoutHunk.inspection.files[0]!.diffHunks = [];
        expect((await run(addedWithoutHunk, wholeFileResult(addedWithoutHunk.addedPath))).diagnostics[0]?.code).toBe(
            "render.inspection_hunk_missing",
        );

        const fixture = await inspectionFixture();
        const file = fixture.inspection.files[0];
        const state = fixture.inspection.inspectionScope.fileStates[0];
        if (file?.fileState !== "baseline_changed" || state?.state !== "changed") {
            throw new Error("fixture state mismatch");
        }
        const hunk = file.diffHunks[0];
        if (hunk === undefined) throw new Error("fixture hunk missing");
        hunk.currentEndByte = Buffer.byteLength(file.currentContent.text) + 1;
        const { hunkFingerprint: _stored, ...preimage } = hunk;
        hunk.hunkFingerprint = computeRenderedTargetDiffHunkFingerprint({
            relativePath: file.relativePath,
            appliedContentHash: state.appliedContentHash,
            currentContentHash: state.currentContentHash,
            diffAlgorithmVersion: "core_byte_ranges_v1",
            hunk: preimage,
        });
        expect((await run(fixture)).diagnostics[0]?.code).toBe("render.inspection_hunk_invalid");
    });

    it("rejects incomplete, duplicate, foreign, and malformed managed-directory inventories", async () => {
        const cases: Array<[string, (fixture: Awaited<ReturnType<typeof addedInspectionFixture>>) => void]> = [
            [
                "render.inspection_closure_mismatch",
                (fixture) => {
                    fixture.inspection.inspectionScope.directoryInventories = [];
                },
            ],
            [
                "render.inspection_scope_inventory_invalid",
                (fixture) => {
                    fixture.inspection.inspectionScope.directoryInventories.push(
                        structuredClone(fixture.inspection.inspectionScope.directoryInventories[0]!),
                    );
                },
            ],
            [
                "render.inspection_scope_inventory_invalid",
                (fixture) => {
                    fixture.inspection.inspectionScope.directoryInventories[0]!.boundary.relativePath = "foreign";
                },
            ],
            [
                "render.inspection_inventory_paths_invalid",
                (fixture) => {
                    fixture.inspection.inspectionScope.directoryInventories[0]!.currentDescendantPaths = ["managed"];
                },
            ],
            [
                "render.inspection_inventory_paths_invalid",
                (fixture) => {
                    fixture.inspection.inspectionScope.directoryInventories[0]!.currentDescendantPaths = [
                        "managed/z",
                        "managed/a",
                    ];
                },
            ],
            [
                "render.inspection_closure_mismatch",
                (fixture) => {
                    fixture.inspection.inspectionScope.directoryInventories[0]!.currentDescendantPaths.push(
                        "managed/z-unrepresented.md",
                    );
                },
            ],
        ];
        for (const [code, mutate] of cases) {
            const fixture = await addedInspectionFixture();
            mutate(fixture);
            expect((await run(fixture, wholeFileResult(fixture.addedPath))).diagnostics[0]?.code).toBe(code);
        }
    });

    it("accepts an exact executable attribute change bound to the scope state", async () => {
        const fixture = await inspectionFixture();
        const state = fixture.inspection.inspectionScope.fileStates[0];
        const file = fixture.inspection.files[0];
        if (state?.state !== "changed" || file?.fileState !== "baseline_changed") {
            throw new Error("fixture changed file mismatch");
        }
        state.currentExecutable = true;
        refreshScope(fixture);
        expect((await run(fixture)).diagnostics[0]?.code).toBe("render.inspection_attribute_closure_invalid");
        const preimage = {
            attributeKind: "executable" as const,
            appliedValue: false,
            currentValue: true,
        };
        file.attributeChanges = [
            {
                ...preimage,
                attributeChangeFingerprint: computeRenderedTargetAttributeChangeFingerprint({
                    relativePath: file.relativePath,
                    inspectionScopeFingerprint: fixture.inspection.inspectionScope.inspectionScopeFingerprint,
                    change: preimage,
                }),
            },
        ];
        expect((await run(fixture)).status).toBe("complete");
        file.attributeChanges[0]!.attributeChangeFingerprint = `sha256:${"f".repeat(64)}`;
        expect((await run(fixture)).diagnostics[0]?.code).toBe("render.inspection_attribute_invalid");
    });

    it("partitions a changed file and returns one Core-owned reverse proof", async () => {
        const fixture = await inspectionFixture();
        let captured: RenderedTargetInspectionInput | undefined;
        const result = await inspectRenderedTarget(
            { appliedRenderSnapshot: fixture.snapshot, inspection: fixture.inspection },
            {
                registry: fixture.registry,
                dispatch: async (_adapterId, input) => {
                    captured = structuredClone(input);
                    const value = adapterResult(fixture);
                    input.files.length = 0;
                    input.appliedRenderSnapshot.outputUnits.length = 0;
                    return { status: "complete", value, diagnostics: [] };
                },
            },
        );
        expect(result.status).toBe("complete");
        expect(fixture.inspection.files).toHaveLength(1);
        expect(result.value).toEqual(
            expect.objectContaining({
                status: "complete",
                changes: [expect.objectContaining({ changeKind: "file_content_replacement" })],
                reverseCoverageProofs: [
                    expect.objectContaining({
                        outputUnitFingerprint: fixture.target.outputUnitFingerprint,
                        reverseCoverageFingerprint: expect.stringMatching(/^sha256:/),
                    }),
                ],
                inspectionResultFingerprint: expect.stringMatching(/^sha256:/),
            }),
        );
        expect(captured?.appliedRenderSnapshot).not.toHaveProperty("promotionAuthorizations");
        expect(captured?.appliedRenderSnapshot.decisions[0]).not.toHaveProperty("approval");
    });
});
