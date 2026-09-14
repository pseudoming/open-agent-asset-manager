/** Core-owned materialization and reverse validation guards for encoded files. */

import { describe, expect, it } from "vitest";
import type { Sha256Digest } from "../../src/types";
import {
    changedEncodedInspection,
    encodedCanonicalValues,
    encodedMaterializationInput,
    fullEncodedAppliedSnapshot,
    makeEncodedFileFixture,
} from "./fixtures/native-project-encoded-file-test-fixtures";

describe("native project encoded-file validation guards", () => {
    it("validates the complete materialization and reverse proofs", () => {
        const fixture = makeEncodedFileFixture();
        const materialization = materializationProof(fixture);
        expect(fixture.components.materializationValidators[0]!.validate(materialization)).toMatchObject({
            outputUnitFingerprint: materialization.outputUnit.outputUnitFingerprint,
            coveredSemanticRefFingerprints: materialization.selectedSemantics
                .map((semantic) => semantic.semanticRefFingerprint)
                .sort(),
        });

        const reverse = reverseProof(fixture);
        expect(fixture.components.reverseInspectionValidators[0]!.validate(reverse)).toMatchObject({
            coveredChangeFingerprints: reverse.adapterResult.changes.map((change) => change.changeFingerprint).sort(),
        });

        const restored = makeEncodedFileFixture({ restorationDialectIds: ["fixture-restoration-v1"] });
        const restoredMaterialization = materializationProof(restored);
        expect(restored.components.materializationValidators[0]!.validate(restoredMaterialization)).toMatchObject({
            outputUnitFingerprint: restoredMaterialization.outputUnit.outputUnitFingerprint,
        });
    });

    it("rejects incomplete semantic, dialect, inventory and materialized-file closure", () => {
        const fixture = makeEncodedFileFixture();
        const base = materializationProof(fixture);
        const mutations: Array<(input: typeof base) => void> = [
            (input) => {
                input.profile.materializationProfileId = "foreign";
            },
            (input) => {
                input.selectedSemantics.splice(0, 1);
                input.canonicalValues.splice(0, 1);
            },
            (input) => {
                const index = input.selectedSemantics.findIndex((semantic) => semantic.semanticKind === "asset.file_inventory");
                input.selectedSemantics.splice(index, 1);
                input.canonicalValues = input.canonicalValues.filter((value) =>
                    input.selectedSemantics.some((semantic) => semantic.semanticRefFingerprint === value.semanticRefFingerprint),
                );
            },
            (input) => {
                input.selectedSemantics.push(structuredClone(input.selectedSemantics[0]!));
                input.canonicalValues.push(structuredClone(input.canonicalValues[0]!));
            },
            (input) => {
                input.canonicalValues.pop();
            },
            (input) => {
                input.canonicalValues[0]!.semanticRefFingerprint = `sha256:${"9".repeat(64)}`;
            },
            (input) => {
                input.canonicalValues[0]!.canonicalValueFingerprint = `sha256:${"9".repeat(64)}`;
            },
            (input) => {
                const inventory = input.canonicalValues.find((value) => value.valueKind === "file_inventory")!;
                inventory.valueKind = "asset_type_data" as never;
            },
            (input) => {
                const typeData = input.canonicalValues.find((value) => value.valueKind === "asset_type_data")!;
                if (typeData.valueKind === "asset_type_data") typeData.value = { kind: "Skill" } as never;
            },
            (input) => {
                const content = input.canonicalValues.find((value) => value.valueKind === "file_content")!;
                content.valueKind = "asset_type_data" as never;
            },
            (input) => {
                const inventory = inventoryValue(input);
                inventory.splice(0);
            },
            (input) => {
                const inventory = inventoryValue(input);
                inventory.push(structuredClone(inventory[1]!));
            },
            (input) => {
                const inventory = inventoryValue(input);
                inventory[0]!.role = "resource";
            },
            (input) => {
                const inventory = inventoryValue(input);
                inventory[0]!.contentKind = "binary";
            },
            (input) => {
                const inventory = inventoryValue(input);
                inventory[0]!.executable = true;
            },
            (input) => {
                input.dialectInputs = [];
            },
            (input) => {
                input.dialectInputs[0]!.inputs = [];
            },
            (input) => {
                input.dialectInputs[0]!.inputs.push(structuredClone(input.dialectInputs[0]!.inputs[0]!));
            },
            (input) => {
                input.dialectInputs[0]!.inputs.push({ inputKind: "dialect_restoration" } as never);
            },
            (input) => {
                const native = nativeInput(input);
                native.inputRole = "foreign" as never;
            },
            (input) => {
                nativeInput(input).representation.dialectId = "foreign";
            },
            (input) => {
                nativeInput(input).files.push(structuredClone(nativeInput(input).files[0]!));
            },
            (input) => {
                nativeInput(input).files[0]!.contentKind = "binary" as never;
            },
            (input) => {
                nativeInput(input).files[0]!.executable = true;
            },
            (input) => {
                input.outputUnit.claims.push(structuredClone(input.outputUnit.claims[0]!));
            },
            (input) => {
                input.outputUnit.managedDirectoryBoundaries.push("fixture" as never);
            },
            (input) => {
                input.outputUnit.claims[0]!.relativePath = "foreign.md";
            },
            (input) => {
                input.outputUnit.claims[0]!.contentKind = "binary";
            },
            (input) => {
                input.outputUnit.claims[0]!.executable = true;
            },
            (input) => {
                input.files.push(structuredClone(input.files[0]!));
            },
            (input) => {
                input.files[0]!.relativePath = "foreign.md";
            },
            (input) => {
                input.files[0]!.content = { contentKind: "binary", bytes: Uint8Array.of(1) };
            },
            (input) => {
                if (input.files[0]!.content.contentKind === "text") input.files[0]!.content.text = "foreign\n";
            },
            (input) => {
                input.files[0]!.executable = true;
            },
            (input) => {
                input.files[0]!.semanticRefFingerprints = [];
            },
            (input) => {
                input.files[0]!.sectionBindings.pop();
            },
            (input) => {
                input.files[0]!.sectionBindings[0]!.semanticRefFingerprints = [];
            },
            (input) => {
                const assetRef = input.selectedSemantics.find((semantic) => semantic.subject.subjectKind === "asset")!;
                input.files[0]!.sectionBindings[0]!.semanticRefFingerprints = [assetRef.semanticRefFingerprint];
            },
            (input) => {
                input.files[0]!.sectionBindings[1]!.semanticRefFingerprints = [
                    input.files[0]!.sectionBindings[0]!.semanticRefFingerprints[0]!,
                ];
            },
            (input) => {
                input.selectedOptions.pop();
            },
            (input) => {
                input.selectedOptions[0]!.semanticRefFingerprint = `sha256:${"9".repeat(64)}`;
            },
            (input) => {
                input.selectedOptions[0]!.outcome = "degraded";
            },
            (input) => {
                input.selectedOptions[0]!.renderStrategy = "portable";
            },
            (input) => {
                input.selectedOptions[0]!.actualReverseExtractPolicy = "cannot_reconcile";
            },
            (input) => {
                input.selectedOptions[0]!.requiredOutputUnitFingerprints = [];
            },
        ];
        for (const [index, mutate] of mutations.entries()) {
            const input = structuredClone(base);
            mutate(input);
            expect(
                () => fixture.components.materializationValidators[0]!.validate(input),
                `materialization mutation ${index}`,
            ).toThrow(/materialization violates/);
        }
    });

    it("rejects incomplete, conflicting and overclaimed reverse attribution", () => {
        const fixture = makeEncodedFileFixture();
        const base = reverseProof(fixture);
        const mutations: Array<(input: typeof base) => void> = [
            (input) => {
                input.files = [];
            },
            (input) => {
                input.adapterResult.files = [];
            },
            (input) => {
                input.inventoryDeltas.push({} as never);
            },
            (input) => {
                input.files[0]!.fileState = "baseline_missing";
            },
            (input) => {
                input.files[0]!.attributeChanges.push({} as never);
            },
            (input) => {
                input.files[0]!.diffHunks = [];
            },
            (input) => {
                input.adapterResult.files[0] = {
                    relativePath: input.files[0]!.relativePath,
                    attributionState: "conflict",
                    reasonCode: "fixture",
                    diagnostics: [],
                };
            },
            (input) => {
                uniqueResult(input).changeFingerprints = [];
            },
            (input) => {
                uniqueResult(input).changeFingerprints.push(...uniqueResult(input).changeFingerprints);
            },
            (input) => {
                input.adapterResult.changes.pop();
            },
            (input) => {
                input.adapterResult.changes[0]!.changeKind = "file_deletion" as never;
            },
            (input) => {
                input.adapterResult.changes[0]!.semanticRefFingerprints = [];
            },
            (input) => {
                input.adapterResult.changes[0]!.semanticRefFingerprints = [`sha256:${"9".repeat(64)}` as Sha256Digest];
            },
            (input) => {
                const first = input.adapterResult.changes[0]!.semanticRefFingerprints[0]!;
                input.adapterResult.changes[1]!.semanticRefFingerprints = [first];
            },
            (input) => {
                uniqueResult(input).hunkAttributions = [];
            },
            (input) => {
                uniqueResult(input).hunkAttributions[0]!.attributionKind = "ambiguous" as never;
            },
            (input) => {
                uniqueResult(input).hunkAttributions[0]!.semanticRefFingerprints = [];
            },
        ];
        for (const [index, mutate] of mutations.entries()) {
            const input = structuredClone(base);
            mutate(input);
            expect(() => fixture.components.reverseInspectionValidators[0]!.validate(input), `reverse mutation ${index}`).toThrow(
                /reverse result violates/,
            );
        }
    });
});

function materializationProof(fixture: ReturnType<typeof makeEncodedFileFixture>) {
    const materialization = encodedMaterializationInput(fixture);
    const result = fixture.support.materialize(materialization);
    if (result.materializationState !== "materialized") throw new Error("encoded materialization fixture failed");
    return {
        contract: structuredClone(fixture.components.outputContracts[0]!),
        profile: structuredClone(fixture.components.outputContracts[0]!.materializationProfiles[0]!),
        outputUnit: structuredClone(materialization.selection.outputUnits[0]!),
        selectedSemantics: structuredClone(fixture.requiredSemantics),
        canonicalValues: encodedCanonicalValues(fixture),
        selectedOptions: structuredClone(materialization.selection.semanticOptions),
        dialectInputs: structuredClone(materialization.dialectInputs),
        files: structuredClone(result.materializedUnits[0]!.files),
    };
}

function reverseProof(fixture: ReturnType<typeof makeEncodedFileFixture>) {
    const materialization = encodedMaterializationInput(fixture);
    const inspection = changedEncodedInspection(fixture, materialization);
    return {
        contract: fixture.components.outputContracts[0]!,
        outputUnit: materialization.selection.outputUnits[0]!,
        appliedRenderSnapshot: fullEncodedAppliedSnapshot(inspection.appliedRenderSnapshot),
        inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
        files: structuredClone(inspection.files),
        inventoryDeltas: structuredClone(inspection.inventoryDeltas),
        adapterResult: fixture.support.inspect(inspection),
    };
}

function inventoryValue(input: ReturnType<typeof materializationProof>) {
    const inventory = input.canonicalValues.find((value) => value.valueKind === "file_inventory");
    if (inventory?.valueKind !== "file_inventory") throw new Error("inventory fixture is missing");
    return inventory.value;
}

function nativeInput(input: ReturnType<typeof materializationProof>) {
    const native = input.dialectInputs[0]!.inputs[0]!;
    if (native.inputKind !== "native_representation") throw new Error("native fixture is missing");
    return native;
}

function uniqueResult(input: ReturnType<typeof reverseProof>) {
    const result = input.adapterResult.files[0];
    if (result?.attributionState !== "uniquely_attributable") throw new Error("unique result fixture is missing");
    return result;
}
