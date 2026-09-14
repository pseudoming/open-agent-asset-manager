/** Authority-focused split from the original oversized render test suite. */

import { describe, expect, it } from "vitest";
import type { RenderMaterializationInput } from "../../src/contracts/render";
import type {
    AdapterRenderedTargetInspectionResult,
    ChangedRenderedTargetFileInput,
    RenderedTargetInspectionInput,
} from "../../src/contracts/reverse";
import { computeAttributedSemanticChangeFingerprint } from "../../src/foundation/fingerprint";
import { ASSET_ID, VERSION_ID } from "../catalog/fixtures/version-v2";
import {
    HASH,
    makeFixture,
    materializationInput,
    canonicalValues,
    changedInspection,
    fullAppliedSnapshot,
} from "./fixtures/native-project-guidance-test-fixtures";

describe("native project Guidance materialization and reverse inspection", () => {
    it("materializes exact canonical text and rejects stale selections", () => {
        const fixture = makeFixture("antigravity");
        const valid = materializationInput(fixture);
        expect(fixture.support.materialize(valid)).toEqual({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    outputUnitFingerprint: valid.selection.outputUnits[0]!.outputUnitFingerprint,
                    files: [
                        {
                            relativePath: "AGENTS.md",
                            content: { contentKind: "text", text: "# Project guidance\n" },
                            executable: false,
                            semanticRefFingerprints: fixture.requiredSemantics
                                .map((semantic) => semantic.semanticRefFingerprint)
                                .sort(),
                            sectionBindings: [],
                        },
                    ],
                },
            ],
            diagnostics: [],
        });
        const providerBound = structuredClone(valid);
        providerBound.selection.semanticOptions[0]!.optionFingerprint = HASH;
        expect(fixture.support.materialize(providerBound)).toMatchObject({
            status: "complete",
            materializationState: "materialized",
        });
        const mutations: Array<(input: RenderMaterializationInput) => void> = [
            (input) => {
                input.deployment.assets = [];
            },
            (input) => {
                input.selection.outputUnits = [];
            },
            (input) => {
                input.selection.outputUnitRenderers = [];
            },
            (input) => {
                input.selection.outputUnits[0]!.outputUnitFingerprint = HASH;
            },
            (input) => {
                input.selection.outputUnits[0]!.claims[0]!.relativePath = "WRONG.md";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.outputUnitFingerprint = HASH;
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.rendererAdapterId = "FOREIGN";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.rendererAdapterVersion = "0.0.0";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.materializerCapabilityKey = "wrong";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.materializationProfileId = "wrong";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.profileConstraintFingerprint = HASH;
            },
            (input) => {
                input.selection.semanticOptions.pop();
            },
            (input) => {
                input.selection.semanticOptions[0]!.semanticRefFingerprint = HASH;
            },
            (input) => {
                input.selection.semanticOptions[0]!.outcome = "degraded";
            },
            (input) => {
                input.selection.semanticOptions[0]!.renderStrategy = "inline";
            },
            (input) => {
                input.selection.semanticOptions[0]!.actualReverseExtractPolicy = "unsupported";
            },
            (input) => {
                input.selection.semanticOptions[0]!.requiredOutputUnitFingerprints = [];
            },
            (input) => {
                input.deployment.targetContexts.push(structuredClone(input.deployment.targetContexts[0]!));
            },
            (input) => {
                input.dialectInputs.push({
                    targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
                    inputs: [],
                });
            },
            (input) => {
                input.requiredSemantics.pop();
            },
        ];
        for (const mutate of mutations) {
            const input = structuredClone(valid);
            mutate(input);
            expect(fixture.support.materialize(input)).toMatchObject({
                status: "failed",
                materializationState: "blocked",
            });
        }
    });

    it("proves materialized bytes against all three canonical Guidance semantics", () => {
        const fixture = makeFixture("claude");
        const providerInput = materializationInput(fixture);
        const providerResult = fixture.support.materialize(providerInput);
        if (providerResult.materializationState !== "materialized") {
            throw new Error("materialization fixture failed");
        }
        const contract = fixture.components.outputContracts[0]!;
        const profile = contract.materializationProfiles.find((item) => item.materializationProfileId === fixture.profile)!;
        const validatorInput = {
            contract,
            profile,
            outputUnit: providerInput.selection.outputUnits[0]!,
            selectedSemantics: fixture.requiredSemantics,
            canonicalValues: canonicalValues(fixture),
            selectedOptions: providerInput.selection.semanticOptions,
            files: providerResult.materializedUnits[0]!.files,
        };
        const proof = fixture.registry.validateOutputContractMaterialization(validatorInput);
        expect(proof).toMatchObject({
            outputUnitFingerprint: providerInput.selection.outputUnits[0]!.outputUnitFingerprint,
            coveredSemanticRefFingerprints: fixture.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint).sort(),
            coverageFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        });

        const wrongProfile = structuredClone(validatorInput);
        wrongProfile.profile.materializationProfileId = "wrong-profile";
        expect(() => fixture.components.materializationValidators[0]!.validate(wrongProfile)).toThrow(
            /materialization profile mismatch/,
        );

        const invalids = [
            (input: typeof validatorInput) => {
                input.files[0]!.content = {
                    contentKind: "text",
                    text: "# Different\n",
                };
            },
            (input: typeof validatorInput) => {
                input.files[0]!.semanticRefFingerprints = [];
            },
            (input: typeof validatorInput) => {
                input.canonicalValues.pop();
            },
            (input: typeof validatorInput) => {
                input.selectedOptions[0]!.renderStrategy = "inline";
            },
            (input: typeof validatorInput) => {
                input.outputUnit.claims[0]!.relativePath = "WRONG.md";
            },
            (input: typeof validatorInput) => {
                const ref = fixture.requiredSemantics.find(
                    (semantic) => semantic.semanticKind === "asset.file_inventory",
                )!.semanticRefFingerprint;
                input.canonicalValues = input.canonicalValues.filter((value) => value.semanticRefFingerprint !== ref);
            },
            (input: typeof validatorInput) => {
                const ref = fixture.requiredSemantics.find(
                    (semantic) => semantic.semanticKind === "guidance.base_context",
                )!.semanticRefFingerprint;
                input.canonicalValues = input.canonicalValues.filter((value) => value.semanticRefFingerprint !== ref);
            },
            (input: typeof validatorInput) => {
                const ref = fixture.requiredSemantics.find(
                    (semantic) => semantic.semanticKind === "guidance.content",
                )!.semanticRefFingerprint;
                input.canonicalValues = input.canonicalValues.filter((value) => value.semanticRefFingerprint !== ref);
            },
            (input: typeof validatorInput) => {
                const value = input.canonicalValues.find((candidate) => candidate.valueKind === "file_content");
                if (value?.valueKind === "file_content") {
                    value.value = { contentKind: "binary", bytes: new Uint8Array([1]) };
                }
            },
            (input: typeof validatorInput) => {
                input.selectedSemantics = input.selectedSemantics.filter(
                    (semantic) => semantic.semanticKind !== "asset.file_inventory",
                );
            },
            (input: typeof validatorInput) => {
                input.selectedSemantics = input.selectedSemantics.filter(
                    (semantic) => semantic.semanticKind !== "guidance.base_context",
                );
            },
            (input: typeof validatorInput) => {
                input.selectedSemantics = input.selectedSemantics.filter(
                    (semantic) => semantic.semanticKind !== "guidance.content",
                );
            },
        ];
        for (const mutate of invalids) {
            const input = structuredClone(validatorInput);
            mutate(input);
            expect(() => fixture.registry.validateOutputContractMaterialization(input)).toThrow(/violates its profile/);
        }
    });

    it("attributes canonical whole-file text edits and conflicts on deletion or attribute drift", () => {
        const fixture = makeFixture("antigravity");
        const materialization = materializationInput(fixture);
        const inspection = changedInspection(fixture, materialization);
        const result = fixture.support.inspect(inspection);
        expect(result).toMatchObject({
            status: "complete",
            changes: [expect.objectContaining({ changeKind: "file_content_replacement" })],
            files: [expect.objectContaining({ attributionState: "uniquely_attributable" })],
        });
        const proof = fixture.registry.validateOutputContractReverseInspection({
            contract: fixture.components.outputContracts[0]!,
            outputUnit: materialization.selection.outputUnits[0]!,
            appliedRenderSnapshot: fullAppliedSnapshot(inspection.appliedRenderSnapshot),
            inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
            files: inspection.files,
            inventoryDeltas: [],
            adapterResult: result,
        });
        expect(proof.coveredChangeFingerprints).toHaveLength(1);

        const unchanged = structuredClone(inspection);
        unchanged.files = [];
        unchanged.inspectionScope.fileStates[0]!.state = "unchanged";
        expect(fixture.support.inspect(unchanged)).toEqual({
            status: "complete",
            changes: [],
            files: [],
            diagnostics: [],
        });

        const conflictMutations: Array<(input: RenderedTargetInspectionInput) => void> = [
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed")
                    file.attributeChanges = [
                        {
                            attributeChangeFingerprint: HASH,
                            attributeKind: "executable",
                            appliedValue: false,
                            currentValue: true,
                        },
                    ];
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed")
                    file.currentContent = {
                        contentKind: "text",
                        text: "# bad\r\n",
                    };
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed")
                    file.provenance.sectionBindings = [
                        {
                            sectionHandle: "generated",
                            semanticRefFingerprints: [HASH],
                        },
                    ];
            },
        ];
        for (const mutate of conflictMutations) {
            const input = structuredClone(inspection);
            mutate(input);
            expect(fixture.support.inspect(input).files[0]).toMatchObject({
                attributionState: "conflict",
            });
        }

        const outsideClosureMutations: Array<(input: RenderedTargetInspectionInput) => void> = [
            (input) => {
                (input.files[0] as ChangedRenderedTargetFileInput).relativePath = "WRONG.md";
            },
            (input) => {
                input.appliedRenderSnapshot.outputUnits = [];
            },
            (input) => {
                input.appliedRenderSnapshot.outputUnitRenderers = [];
            },
            (input) => {
                input.appliedRenderSnapshot.outputUnitRenderers[0]!.rendererAdapterId = "FOREIGN";
            },
            (input) => {
                input.appliedRenderSnapshot.outputUnitRenderers[0]!.rendererAdapterVersion = "0.0.0";
            },
            (input) => {
                input.appliedRenderSnapshot.outputUnitRenderers[0]!.profileConstraintFingerprint = HASH;
            },
            (input) => {
                input.inspectionScope.fileStates = [];
            },
            (input) => {
                input.inventoryDeltas = [
                    {
                        inventoryDeltaFingerprint: HASH,
                        outputUnitFingerprint: materialization.selection.outputUnits[0]!.outputUnitFingerprint,
                        relativePath: "extra.md",
                        deltaKind: "file_added",
                        inventorySemanticRefFingerprint: HASH,
                    },
                ];
            },
        ];
        for (const mutate of outsideClosureMutations) {
            const input = structuredClone(inspection);
            mutate(input);
            expect(fixture.support.inspect(input)).toMatchObject({
                status: "failed",
                changes: [],
                files: [],
            });
        }

        const missing = structuredClone(inspection);
        missing.files = [
            {
                fileState: "baseline_missing",
                relativePath: "AGENTS.md",
                appliedContent: { contentKind: "text", text: "# Project guidance\n" },
                currentContent: { contentKind: "missing" },
                diffHunks: [],
                provenance: (
                    inspection.files[0] as Extract<
                        ChangedRenderedTargetFileInput,
                        {
                            fileState: "baseline_changed";
                        }
                    >
                ).provenance,
            },
        ];
        expect(fixture.support.inspect(missing).files[0]).toMatchObject({
            attributionState: "conflict",
        });
        const missingResult = fixture.support.inspect(missing);
        expect(() =>
            fixture.registry.validateOutputContractReverseInspection({
                contract: fixture.components.outputContracts[0]!,
                outputUnit: materialization.selection.outputUnits[0]!,
                appliedRenderSnapshot: fullAppliedSnapshot(missing.appliedRenderSnapshot),
                inspectionScopeFingerprint: missing.inspectionScope.inspectionScopeFingerprint,
                files: missing.files,
                inventoryDeltas: [],
                adapterResult: missingResult,
            }),
        ).not.toThrow();

        const executableChanged = structuredClone(inspection);
        const executableFile = executableChanged.files[0];
        if (executableFile?.fileState !== "baseline_changed") {
            throw new Error("executable fixture mismatch");
        }
        executableFile.attributeChanges = [
            {
                attributeChangeFingerprint: HASH,
                attributeKind: "executable",
                appliedValue: false,
                currentValue: true,
            },
        ];
        const executableResult = fixture.support.inspect(executableChanged);
        expect(() =>
            fixture.registry.validateOutputContractReverseInspection({
                contract: fixture.components.outputContracts[0]!,
                outputUnit: materialization.selection.outputUnits[0]!,
                appliedRenderSnapshot: fullAppliedSnapshot(executableChanged.appliedRenderSnapshot),
                inspectionScopeFingerprint: executableChanged.inspectionScope.inspectionScopeFingerprint,
                files: executableChanged.files,
                inventoryDeltas: [],
                adapterResult: executableResult,
            }),
        ).not.toThrow();
    });

    it("fails closed before provenance traversal when reverse input arrays are malformed", () => {
        const fixture = makeFixture("claude");
        const materialization = materializationInput(fixture);
        const malformed = structuredClone(changedInspection(fixture, materialization)) as unknown as {
            files: null;
        };
        malformed.files = null;

        expect(fixture.support.inspect(malformed as unknown as RenderedTargetInspectionInput)).toMatchObject({
            status: "failed",
            changes: [],
            files: [],
        });
    });

    it("rejects reverse receipts that alter content meaning or claim unreferenced changes", () => {
        const fixture = makeFixture("claude");
        const materialization = materializationInput(fixture);
        const inspection = changedInspection(fixture, materialization);
        const valid = fixture.support.inspect(inspection);
        const base: Parameters<typeof fixture.registry.validateOutputContractReverseInspection>[0] = {
            contract: fixture.components.outputContracts[0]!,
            outputUnit: materialization.selection.outputUnits[0]!,
            appliedRenderSnapshot: fullAppliedSnapshot(inspection.appliedRenderSnapshot),
            inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
            files: inspection.files,
            inventoryDeltas: [],
            adapterResult: valid,
        };
        const invalids: Array<(result: AdapterRenderedTargetInspectionResult) => void> = [
            (result) => {
                const change = result.changes[0];
                if (change?.changeKind === "file_content_replacement") {
                    change.replacementContent = { contentKind: "text", text: "# forged\n" };
                }
            },
            (result) => {
                const file = result.files[0];
                if (file?.attributionState === "uniquely_attributable") {
                    file.hunkAttributions[0]!.semanticRefFingerprints = [HASH];
                }
            },
            (result) => {
                result.files = [];
            },
            (result) => {
                const source = result.changes[0]!;
                const preimage = {
                    changeKind: "file_content_replacement" as const,
                    semanticRefFingerprints: [...source.semanticRefFingerprints],
                    replacementContent: { contentKind: "text" as const, text: "# extra\n" },
                };
                result.changes.push({
                    ...preimage,
                    changeFingerprint: computeAttributedSemanticChangeFingerprint({
                        inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
                        change: preimage,
                    }),
                });
            },
        ];
        for (const mutate of invalids) {
            const input = structuredClone(base);
            mutate(input.adapterResult);
            expect(() => fixture.registry.validateOutputContractReverseInspection(input)).toThrow(/violates whole-file policy/);
        }
        const inventory = structuredClone(base);
        inventory.inventoryDeltas = [
            {
                inventoryDeltaFingerprint: HASH,
                outputUnitFingerprint: base.outputUnit.outputUnitFingerprint,
                relativePath: "extra.md",
                deltaKind: "file_added",
                inventorySemanticRefFingerprint: HASH,
            },
        ];
        expect(() => fixture.registry.validateOutputContractReverseInspection(inventory)).toThrow(/violates whole-file policy/);
    });
});
