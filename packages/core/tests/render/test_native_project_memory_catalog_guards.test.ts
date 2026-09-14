/** Fail-closed guards for the zero-file Memory Catalog target contract. */

import { describe, expect, it } from "vitest";
import type { CanonicalRenderSemanticValue, RenderedTargetInspectionInput } from "../../src/types";
import { computeCanonicalRenderSemanticValueFingerprint } from "../../src/foundation/fingerprint";
import { makeNativeProjectExactFileContractParts } from "../../src/render/native-project-exact-file";
import {
    safeMemoryCatalogParse,
    type NativeProjectExactFileProviderBehavior,
} from "../../src/render/native-project-exact-file-results";
import { buildInspectionPartition } from "../../src/render/render-inspection-validation";
import {
    CATALOG_ASSET_ID,
    CATALOG_TEXT,
    CHANGED_CATALOG_TEXT,
    MEMORY_CATALOG_PATH,
    TEST_HASH,
    UNIT_ASSET_ID,
    UNIT_VERSION_ID,
    makeMemoryCatalogExactFileFixture,
    makeMemoryCatalogInspectionInput,
    makeMemoryCatalogMaterializationInput,
} from "./fixtures/native-project-memory-catalog-test-fixtures";

describe("native project Memory Catalog guards", () => {
    it("proves the exact zero-file materialization and rejects every forged closure field", () => {
        const fixture = makeMemoryCatalogExactFileFixture();
        const baseline = materializationValidatorInput(fixture);
        expect(fixture.registry.validateOutputContractMaterialization(baseline)).toMatchObject({
            coveredSemanticRefFingerprints: fixture.catalogSemantics.map((semantic) => semantic.semanticRefFingerprint).sort(),
        });

        const parent = structuredClone(baseline);
        const parentNative = parent.dialectInputs[0]?.inputs[0];
        if (parentNative?.inputKind !== "native_representation") throw new Error("Catalog native input missing");
        Object.assign(parentNative, {
            inputRole: "parent_rebase_seed",
            sourceVersion: { assetId: CATALOG_ASSET_ID, versionId: fixture.catalogClosure.manifest.versionId },
        });
        parent.files[0]!.content = { contentKind: "text", text: `${CATALOG_TEXT} ` };
        expect(() => fixture.registry.validateOutputContractMaterialization(parent)).not.toThrow();

        const mutations: Array<(value: typeof baseline) => void> = [
            (value) => {
                value.profile.materializationProfileId = "wrong";
            },
            (value) => {
                value.selectedSemantics.pop();
            },
            (value) => {
                value.selectedSemantics[0]!.subject = {
                    subjectKind: "file",
                    assetId: CATALOG_ASSET_ID,
                    versionId: fixture.catalogClosure.manifest.versionId,
                    fileId: UNIT_ASSET_ID,
                };
            },
            (value) => {
                value.selectedSemantics[1]!.subject.assetId = UNIT_ASSET_ID;
            },
            (value) => {
                value.selectedSemantics[1]!.subject.versionId = UNIT_VERSION_ID;
            },
            (value) => {
                value.selectedSemantics[1]!.semanticRefFingerprint = value.selectedSemantics[0]!.semanticRefFingerprint;
            },
            (value) => {
                value.canonicalValues.pop();
            },
            (value) => {
                value.selectedSemantics = value.selectedSemantics.filter(
                    (semantic) => semantic.semanticKind !== "asset.file_inventory",
                );
            },
            (value) => {
                const inventory = value.canonicalValues.find((candidate) => candidate.valueKind === "file_inventory");
                if (inventory?.valueKind === "file_inventory") inventory.value = [{} as never];
            },
            (value) => {
                const inventory = value.canonicalValues.find((candidate) => candidate.valueKind === "file_inventory");
                if (inventory !== undefined) inventory.valueKind = "asset_type_data" as never;
            },
            (value) => {
                const support = value.canonicalValues.find((candidate) => candidate.valueKind === "asset_type_data");
                if (support !== undefined) support.semanticRefFingerprint = `sha256:${"f".repeat(64)}`;
            },
            (value) => {
                const support = value.canonicalValues.find((candidate) => candidate.valueKind === "asset_type_data");
                if (support !== undefined) support.valueKind = "file_inventory" as never;
            },
            (value) => {
                const support = value.canonicalValues.find((candidate) => candidate.valueKind === "asset_type_data");
                if (support?.valueKind === "asset_type_data") {
                    support.value = { kind: "Guidance", typeData: { schemaVersion: 1 } };
                }
            },
            (value) => {
                const support = value.canonicalValues.find((candidate) => candidate.valueKind === "asset_type_data");
                if (support?.valueKind === "asset_type_data") {
                    support.value = {
                        kind: "Memory",
                        typeData: {
                            schemaVersion: 2,
                            entityRole: "unit",
                            card: { name: "unit", description: "unit" },
                            loading: { card: "high", body: "low" },
                            applicabilityRule: "",
                        },
                    };
                }
            },
            (value) => {
                value.dialectInputs[0]!.targetVersion.assetId = UNIT_ASSET_ID;
            },
            (value) => {
                value.dialectInputs[0]!.inputs = [];
            },
            (value) => {
                value.dialectInputs[0]!.inputs.push({ inputKind: "dialect_restoration" } as never);
            },
            (value) => {
                const native = requireNative(value);
                native.inputRole = "unknown" as never;
            },
            (value) => {
                const native = requireNative(value);
                native.representation.dialectId = "foreign-memory-catalog-v1";
            },
            (value) => {
                requireNative(value).files.push(structuredClone(requireNative(value).files[0]!));
            },
            (value) => {
                requireNative(value).files[0] = { contentKind: "binary" } as never;
            },
            (value) => {
                requireNative(value).files[0]!.executable = true;
            },
            (value) => {
                value.outputUnit.claims.push(structuredClone(value.outputUnit.claims[0]!));
            },
            (value) => {
                value.outputUnit.managedDirectoryBoundaries.push({ relativePath: "managed" } as never);
            },
            (value) => {
                value.outputUnit.claims[0]!.relativePath = "wrong.md";
            },
            (value) => {
                value.outputUnit.claims[0]!.contentKind = "binary";
            },
            (value) => {
                value.outputUnit.claims[0]!.executable = true;
            },
            (value) => {
                value.files.push(structuredClone(value.files[0]!));
            },
            (value) => {
                value.files[0]!.relativePath = "wrong.md";
            },
            (value) => {
                value.files[0]!.content = { contentKind: "binary", bytes: Uint8Array.of(1) };
            },
            (value) => {
                value.files[0]!.content = { contentKind: "text", text: "changed" };
            },
            (value) => {
                value.files[0]!.executable = true;
            },
            (value) => {
                value.files[0]!.sectionBindings.push({ sectionHandle: "x", semanticRefFingerprints: [TEST_HASH] });
            },
            (value) => {
                value.files[0]!.semanticRefFingerprints = [];
            },
            (value) => {
                value.selectedOptions.pop();
            },
            (value) => {
                value.selectedOptions[0]!.semanticRefFingerprint = TEST_HASH;
            },
            (value) => {
                value.selectedOptions[0]!.outcome = "degraded";
            },
            (value) => {
                value.selectedOptions[0]!.renderStrategy = "inline";
            },
            (value) => {
                value.selectedOptions[0]!.actualReverseExtractPolicy = "unsupported";
            },
            (value) => {
                value.selectedOptions[0]!.requiredOutputUnitFingerprints = [];
            },
        ];
        for (const [index, mutate] of mutations.entries()) {
            const value = structuredClone(baseline);
            mutate(value);
            expect(
                () => fixture.registry.validateOutputContractMaterialization(value),
                `materialization mutation ${index}`,
            ).toThrow(/materialization validator|violates its profile/);
        }
    });

    it("proves one membership reverse result and rejects every forged attribution field", () => {
        const fixture = makeMemoryCatalogExactFileFixture();
        const inspection = makeMemoryCatalogInspectionInput(fixture);
        const adapterResult = fixture.support.inspect(inspection);
        const contract = makeNativeProjectExactFileContractParts(fixture.support.renderContractDeclaration).outputContract;
        const outputUnit = inspection.appliedRenderSnapshot.outputUnits[0]!;
        const baseline = {
            contract,
            outputUnit,
            appliedRenderSnapshot: inspection.appliedRenderSnapshot as never,
            inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
            files: inspection.files,
            inventoryDeltas: inspection.inventoryDeltas,
            adapterResult,
        };
        expect(fixture.registry.validateOutputContractReverseInspection(baseline)).toMatchObject({
            coveredChangeFingerprints: [adapterResult.changes[0]!.changeFingerprint],
        });

        const mutations: Array<(value: typeof baseline) => void> = [
            (value) => {
                value.files = [];
            },
            (value) => {
                const file = value.files[0];
                if (file?.fileState === "baseline_changed") file.fileState = "baseline_missing" as never;
            },
            (value) => {
                const file = value.files[0];
                if (file?.fileState === "baseline_changed")
                    file.appliedContent = { contentKind: "binary", bytes: Uint8Array.of(1) };
            },
            (value) => {
                const file = value.files[0];
                if (file?.fileState === "baseline_changed")
                    file.currentContent = { contentKind: "binary", bytes: Uint8Array.of(1) };
            },
            (value) => {
                const file = value.files[0];
                if (file?.fileState === "baseline_changed" && file.currentContent.contentKind === "text") {
                    file.currentContent.text = `${file.currentContent.text}\r\n`;
                }
            },
            (value) => {
                const file = value.files[0];
                if (file?.fileState === "baseline_changed") file.attributeChanges.push({} as never);
            },
            (value) => {
                value.files[0]!.provenance.sectionBindings.push({ sectionHandle: "x", semanticRefFingerprints: [TEST_HASH] });
            },
            (value) => {
                value.appliedRenderSnapshot.decisions = [];
            },
            (value) => {
                value.adapterResult.files[0] = {
                    relativePath: MEMORY_CATALOG_PATH,
                    attributionState: "conflict",
                    reasonCode: "fixture",
                    diagnostics: [],
                };
            },
            (value) => {
                const result = value.adapterResult.files[0];
                if (result?.attributionState === "uniquely_attributable") result.hunkAttributions = [];
            },
            (value) => {
                const result = value.adapterResult.files[0];
                if (result?.attributionState === "uniquely_attributable") {
                    result.hunkAttributions[0]!.semanticRefFingerprints = [];
                }
            },
            (value) => {
                const result = value.adapterResult.files[0];
                if (result?.attributionState === "uniquely_attributable") result.changeFingerprints = [];
            },
            (value) => {
                value.adapterResult.changes[0] = {
                    changeKind: "file_content_replacement",
                    changeFingerprint: TEST_HASH,
                    semanticRefFingerprints: [TEST_HASH],
                    replacementContent: { contentKind: "text", text: "wrong" },
                };
            },
            (value) => {
                const change = value.adapterResult.changes[0];
                if (change?.changeKind === "asset_type_data_replacement") {
                    change.replacement = { kind: "Guidance", typeData: { schemaVersion: 1 } };
                }
            },
            (value) => {
                const change = value.adapterResult.changes[0];
                if (change?.changeKind === "asset_type_data_replacement") {
                    change.replacement = {
                        kind: "Memory",
                        typeData: {
                            schemaVersion: 2,
                            entityRole: "unit",
                            card: { name: "unit", description: "unit" },
                            loading: { card: "high", body: "low" },
                            applicabilityRule: "",
                        },
                    };
                }
            },
            (value) => {
                value.adapterResult.changes[0]!.semanticRefFingerprints = [];
            },
            (value) => {
                value.inventoryDeltas.push({} as never);
            },
            (value) => {
                value.adapterResult.files.push({
                    relativePath: "extra.md",
                    attributionState: "conflict",
                    reasonCode: "fixture",
                    diagnostics: [],
                });
            },
            (value) => {
                value.adapterResult.changes.push({
                    changeKind: "file_content_replacement",
                    changeFingerprint: `sha256:${"a".repeat(64)}`,
                    semanticRefFingerprints: [TEST_HASH],
                    replacementContent: { contentKind: "text", text: "extra" },
                });
            },
        ];
        for (const mutate of mutations) {
            const value = structuredClone(baseline);
            mutate(value);
            expect(() => fixture.registry.validateOutputContractReverseInspection(value)).toThrow(/violates its policy/);
        }
    });

    it("keeps malformed or ambiguous Catalog inspection inputs as conflicts", () => {
        const mutations: Array<(input: RenderedTargetInspectionInput) => void> = [
            (input) => {
                input.files = [];
            },
            (input) => {
                input.files.push(structuredClone(input.files[0]!));
            },
            (input) => {
                delete input.appliedAssets;
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed" && file.currentContent.contentKind === "text") {
                    file.currentContent.text = "- [Broken](../escape.md)\n";
                }
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed" && file.currentContent.contentKind === "text") {
                    file.currentContent.text = CHANGED_CATALOG_TEXT.replace("topics/second.md", "topics/unknown.md");
                }
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed" && file.currentContent.contentKind === "text") {
                    file.currentContent.text = CHANGED_CATALOG_TEXT.replace("topics/second.md", "topics/first.md");
                }
            },
            (input) => {
                input.appliedRenderSnapshot.outputUnits = [];
            },
            (input) => {
                input.appliedRenderSnapshot.decisions = input.appliedRenderSnapshot.decisions.filter(
                    (decision) => decision.semanticRef.subject.assetId !== CATALOG_ASSET_ID,
                );
            },
            (input) => {
                input.appliedRenderSnapshot.decisions.push(structuredClone(input.appliedRenderSnapshot.decisions[0]!));
            },
            (input) => {
                input.appliedRenderSnapshot.decisions = input.appliedRenderSnapshot.decisions.filter(
                    (decision) => decision.semanticRef.subject.assetId === CATALOG_ASSET_ID,
                );
            },
            (input) => {
                input.appliedRenderSnapshot.decisions[1]!.outputUnitFingerprints = [TEST_HASH];
            },
            (input) => {
                const unit = input.appliedAssets?.find((asset) => asset.version.ref.assetId === UNIT_ASSET_ID);
                if (unit !== undefined) unit.version.canonical = { kind: "Guidance", typeData: { schemaVersion: 1 } };
            },
            (input) => {
                const unit = input.appliedAssets?.find((asset) => asset.version.ref.assetId === UNIT_ASSET_ID);
                if (unit !== undefined) unit.version.status = "incomplete";
            },
            (input) => {
                const unit = input.appliedAssets?.find((asset) => asset.version.ref.assetId === UNIT_ASSET_ID);
                if (unit !== undefined) unit.scope = "global";
            },
            (input) => {
                const unit = input.appliedAssets?.find((asset) => asset.version.ref.assetId === UNIT_ASSET_ID);
                if (unit !== undefined) unit.projectId = TEST_HASH;
            },
            (input) => {
                const unit = input.appliedAssets?.find((asset) => asset.version.ref.assetId === UNIT_ASSET_ID);
                if (unit !== undefined) unit.scopePath = "nested";
            },
            (input) => {
                input.appliedRenderSnapshot.decisions[1]!.semanticRef.semanticKind = "asset.file_inventory";
            },
            (input) => {
                input.appliedRenderSnapshot.decisions[1]!.semanticRef.subject.assetId = CATALOG_ASSET_ID;
            },
            (input) => {
                input.appliedRenderSnapshot.decisions[1]!.semanticRef.subject.versionId = TEST_HASH;
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed") file.fileState = "baseline_missing" as never;
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed")
                    file.appliedContent = { contentKind: "binary", bytes: Uint8Array.of(1) };
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed")
                    file.currentContent = { contentKind: "binary", bytes: Uint8Array.of(1) };
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed" && file.currentContent.contentKind === "text") {
                    file.currentContent.text = `${file.currentContent.text}\r\n`;
                }
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed") file.attributeChanges.push({} as never);
            },
            (input) => {
                input.files[0]!.provenance.sectionBindings.push({ sectionHandle: "x", semanticRefFingerprints: [TEST_HASH] });
            },
            (input) => {
                const unit = input.appliedAssets?.find((asset) => asset.version.ref.assetId === UNIT_ASSET_ID);
                if (unit !== undefined) unit.version.ref.versionId = "invalid" as never;
            },
        ];
        for (const [index, mutate] of mutations.entries()) {
            const fixture = makeMemoryCatalogExactFileFixture();
            const input = makeMemoryCatalogInspectionInput(fixture);
            mutate(input);
            const result = fixture.support.inspect(input);
            expect(
                result.status === "failed" || result.files[0]?.attributionState === "conflict",
                `inspection mutation ${index}: ${JSON.stringify(result)}`,
            ).toBe(true);
        }
    });

    it("keeps Catalog parsing exceptions and non-Catalog behavior fail closed", () => {
        expect(
            safeMemoryCatalogParse(
                { memoryCatalog: null } as NativeProjectExactFileProviderBehavior,
                MEMORY_CATALOG_PATH,
                CATALOG_TEXT,
            ),
        ).toBeNull();
        expect(
            safeMemoryCatalogParse(
                {
                    memoryCatalog: {
                        parse: () => {
                            throw new Error("fixture parser failure");
                        },
                    },
                } as NativeProjectExactFileProviderBehavior,
                MEMORY_CATALOG_PATH,
                CATALOG_TEXT,
            ),
        ).toBeNull();
    });

    it("keeps the Catalog and all same-scope complete Unit authority in an inspection partition", () => {
        const fixture = makeMemoryCatalogExactFileFixture();
        const input = makeMemoryCatalogInspectionInput(fixture);
        const catalogUnit = input.appliedRenderSnapshot.outputUnits[0];
        if (catalogUnit === undefined) throw new Error("Catalog output unit missing");
        const states = new Map(
            input.inspectionScope.fileStates.map((state) => [
                state.relativePath,
                { ...state, outputUnitFingerprint: state.outputUnitFingerprint },
            ]),
        );
        const partition = buildInspectionPartition(input, states, new Set([catalogUnit.outputUnitFingerprint]));
        expect(partition.appliedAssets?.map((asset) => asset.version.ref.assetId)).toEqual([
            CATALOG_ASSET_ID,
            UNIT_ASSET_ID,
            expect.any(String),
        ]);

        const unrelated = structuredClone(input);
        unrelated.appliedAssets = unrelated.appliedAssets?.map((asset, index) =>
            index === 0
                ? { ...asset, version: { ...asset.version, canonical: { kind: "Guidance", typeData: { schemaVersion: 1 } } } }
                : asset,
        );
        expect(buildInspectionPartition(unrelated, states, new Set([catalogUnit.outputUnitFingerprint])).appliedAssets).toEqual([
            expect.objectContaining({
                version: expect.objectContaining({ ref: expect.objectContaining({ assetId: CATALOG_ASSET_ID }) }),
            }),
        ]);
        expect(buildInspectionPartition(input, states, new Set([TEST_HASH])).appliedAssets).toBeUndefined();
    });
});

function materializationValidatorInput(fixture: ReturnType<typeof makeMemoryCatalogExactFileFixture>) {
    const input = makeMemoryCatalogMaterializationInput(fixture);
    const materialized = fixture.support.materialize(input);
    if (materialized.materializationState !== "materialized") throw new Error("Catalog materialization failed");
    const contract = makeNativeProjectExactFileContractParts(fixture.support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0]!;
    return {
        contract,
        profile,
        outputUnit: input.selection.outputUnits[0]!,
        selectedSemantics: structuredClone(input.requiredSemantics),
        canonicalValues: catalogCanonicalValues(fixture),
        selectedOptions: structuredClone(input.selection.semanticOptions),
        dialectInputs: structuredClone(input.dialectInputs),
        files: structuredClone(materialized.materializedUnits[0]!.files),
    };
}

function catalogCanonicalValues(fixture: ReturnType<typeof makeMemoryCatalogExactFileFixture>): CanonicalRenderSemanticValue[] {
    return fixture.catalogSemantics.map((semantic) => {
        const value =
            semantic.semanticKind === "asset.file_inventory"
                ? {
                      semanticRefFingerprint: semantic.semanticRefFingerprint,
                      valueKind: "file_inventory" as const,
                      value: [],
                  }
                : {
                      semanticRefFingerprint: semantic.semanticRefFingerprint,
                      valueKind: "asset_type_data" as const,
                      value: structuredClone(fixture.catalogAsset.version.canonical),
                  };
        return {
            ...value,
            canonicalValueFingerprint: computeCanonicalRenderSemanticValueFingerprint({
                semantic,
                assetKind: "Memory",
                value,
            }),
        } as CanonicalRenderSemanticValue;
    });
}

function requireNative(value: ReturnType<typeof materializationValidatorInput>) {
    const native = value.dialectInputs[0]?.inputs[0];
    if (native?.inputKind !== "native_representation") throw new Error("Catalog native input missing");
    return native;
}
