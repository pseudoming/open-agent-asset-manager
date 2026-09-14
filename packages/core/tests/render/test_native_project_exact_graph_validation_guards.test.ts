/** Core-owned materialization, reverse and native-consistency guards for exact graphs. */

import type { MaterializationSemanticCoverageProof } from "../../src/contracts/deployment-authority";
import { describe, expect, it } from "vitest";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { isExactGraphNativeConsistencySatisfied } from "../../src/render/native-project-exact-graph-consistency";
import {
    GRAPH_BOUNDARY,
    GRAPH_HASH,
    changedExactGraphInspection,
    exactGraphCanonicalValues,
    exactGraphMaterializationInput,
    fullExactGraphAppliedSnapshot,
    graphCanonicalMaterializer,
    makeExactGraphFixture,
    makeParentGraphRebaseFixture,
} from "./fixtures/native-project-exact-graph-test-fixtures";

describe("native project exact-graph validation guards", () => {
    it("validates current-exact and parent-rebase materialization proofs", () => {
        for (const fixture of [makeExactGraphFixture(), makeParentGraphRebaseFixture()]) {
            const input = materializationProof(fixture);
            expect(fixture.components.materializationValidators[0]!.validate(input)).toMatchObject({
                outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                coveredSemanticRefFingerprints: input.selectedSemantics.map((semantic) => semantic.semanticRefFingerprint).sort(),
            });
        }
    });

    it("rejects incomplete semantic, dialect, inventory, file and option materialization closure", () => {
        const fixture = makeExactGraphFixture();
        const base = materializationProof(fixture);
        const mutations: Array<(input: typeof base) => void> = [
            (input) => {
                const inventory = input.selectedSemantics.findIndex(
                    (semantic) => semantic.semanticKind === "asset.file_inventory",
                );
                input.selectedSemantics.splice(inventory, 1);
                input.canonicalValues.splice(inventory, 1);
            },
            (input) => {
                input.dialectInputs[0]!.inputs = [
                    {
                        inputKind: "dialect_restoration",
                        restoration: {
                            dialectId: "foreign-v1",
                            restorationContractFingerprint: GRAPH_HASH,
                            contentHash: GRAPH_HASH,
                        },
                        content: { contentKind: "binary", bytes: Uint8Array.of(1) },
                    },
                ];
            },
            (input) => {
                const inventory = input.canonicalValues.find((value) => value.valueKind === "file_inventory")!;
                inventory.valueKind = "asset_type_data" as never;
                inventory.value = fixture.canonical as never;
            },
            (input) => {
                input.dialectInputs[0]!.inputs.push({
                    inputKind: "dialect_restoration",
                    restoration: {
                        dialectId: "foreign-v1",
                        restorationContractFingerprint: GRAPH_HASH,
                        contentHash: GRAPH_HASH,
                    },
                    content: { contentKind: "binary", bytes: Uint8Array.of(1) },
                });
            },
            (input) => {
                input.outputUnit.claims.pop();
            },
            (input) => {
                input.outputUnit.managedDirectoryBoundaries = [];
            },
            (input) => {
                input.files.pop();
            },
            (input) => {
                const inventory = input.canonicalValues.find((value) => value.valueKind === "file_inventory")!;
                if (inventory.valueKind === "file_inventory") inventory.value.pop();
            },
            (input) => {
                const inventory = input.canonicalValues.find((value) => value.valueKind === "file_inventory")!;
                if (inventory.valueKind === "file_inventory") inventory.value[0]!.logicalPath = "unknown.txt";
            },
            (input) => {
                const value = input.canonicalValues.find((candidate) => candidate.valueKind === "asset_type_data")!;
                value.valueKind = "file_content" as never;
                value.value = { contentKind: "text", text: "wrong" } as never;
            },
            (input) => {
                const value = input.canonicalValues.find((candidate) => candidate.valueKind === "file_content")!;
                value.valueKind = "asset_type_data" as never;
                value.value = fixture.canonical as never;
            },
            (input) => {
                input.canonicalValues[0]!.semanticRefFingerprint = GRAPH_HASH;
            },
            (input) => {
                input.files[0]!.semanticRefFingerprints = [];
            },
            (input) => {
                input.files[0]!.relativePath = "missing/member.txt";
            },
            (input) => {
                input.files[0]!.semanticRefFingerprints = [GRAPH_HASH];
            },
            (input) => {
                const firstFileId = fixture.closure.files[0]!.file.fileId;
                const secondFileRef = input.selectedSemantics.find(
                    (semantic) => semantic.subject.subjectKind === "file" && semantic.subject.fileId !== firstFileId,
                )!.semanticRefFingerprint;
                input.files[0]!.semanticRefFingerprints.push(secondFileRef);
            },
            (input) => {
                const fileSemantic = input.selectedSemantics.find((semantic) => semantic.subject.subjectKind === "file")!;
                if (fileSemantic.subject.subjectKind === "file") {
                    fileSemantic.subject.fileId = "00000000-0000-4000-8000-000000000000";
                }
            },
            (input) => {
                input.selectedOptions[0]!.outcome = "degraded";
            },
        ];
        for (const [index, mutate] of mutations.entries()) {
            const input = structuredClone(base);
            mutate(input);
            expect(
                () => fixture.components.materializationValidators[0]!.validate(input),
                `materialization guard mutation ${index}`,
            ).toThrow(/materialization violates/);
        }
    });

    it("accepts all-conflict reverse output but rejects incomplete or overclaimed attribution", () => {
        const fixture = makeExactGraphFixture();
        const base = reverseProof(fixture);
        expect(fixture.components.reverseInspectionValidators[0]!.validate(base)).toMatchObject({
            coveredChangeFingerprints: base.adapterResult.changes.map((change) => change.changeFingerprint).sort(),
        });

        const conflicts = structuredClone(base);
        conflicts.adapterResult.files = conflicts.files.map((file) => ({
            relativePath: file.relativePath,
            attributionState: "conflict" as const,
            reasonCode: "fixture_conflict",
            diagnostics: [],
        }));
        conflicts.adapterResult.changes = [];
        conflicts.files[0]!.fileState = "baseline_missing" as never;
        conflicts.inventoryDeltas = [
            {
                inventoryDeltaFingerprint: GRAPH_HASH,
                outputUnitFingerprint: conflicts.outputUnit.outputUnitFingerprint,
                relativePath: "fixture/added.txt",
                deltaKind: "file_added",
                inventorySemanticRefFingerprint: GRAPH_HASH,
            },
        ];
        expect(fixture.components.reverseInspectionValidators[0]!.validate(conflicts)).toMatchObject({
            coveredChangeFingerprints: [],
        });

        const mutations: Array<(input: typeof base) => void> = [
            (input) => {
                input.adapterResult.files.pop();
            },
            (input) => {
                input.files[0]!.fileState = "baseline_missing" as never;
            },
            (input) => {
                const result = uniqueResult(input);
                result.changeFingerprints = [GRAPH_HASH];
            },
            (input) => {
                uniqueResult(input).hunkAttributions = [];
            },
            (input) => {
                uniqueResult(input).hunkAttributions[0]!.semanticRefFingerprints = [];
            },
            (input) => {
                input.files[0]!.diffHunks = [];
            },
            (input) => {
                input.files.find(
                    (file) => file.fileState === "baseline_changed" && file.attributeChanges.length === 1,
                )!.attributeChanges = [];
            },
            (input) => {
                uniqueResult(input).changeFingerprints.push(uniqueResult(input).changeFingerprints[0]!);
            },
            (input) => {
                input.adapterResult.files.push(structuredClone(input.adapterResult.files[0]!));
            },
            (input) => {
                input.adapterResult.changes.push({
                    ...structuredClone(input.adapterResult.changes[0]!),
                    changeFingerprint: GRAPH_HASH,
                });
            },
        ];
        for (const mutate of mutations) {
            const input = structuredClone(base);
            mutate(input);
            expect(() => fixture.components.reverseInspectionValidators[0]!.validate(input)).toThrow(/reverse result violates/);
        }
    });

    it("requires one exact Asset, dialect group, complete path set and valid native dialect at final consistency", () => {
        const fixture = makeExactGraphFixture({
            nativeDirectories: [GRAPH_BOUNDARY, `${GRAPH_BOUNDARY}/empty`, `${GRAPH_BOUNDARY}/resources`],
        });
        const base = consistencyInput(fixture);
        expect(isExactGraphNativeConsistencySatisfied(base)).toBe(true);

        const unrelated = consistencyInput(fixture);
        unrelated.provider.renderContractDeclarations = [];
        expect(isExactGraphNativeConsistencySatisfied(unrelated)).toBe(true);

        const mutations: Array<(input: typeof base) => void> = [
            (input) => {
                input.deployment.assets = [];
            },
            (input) => {
                input.dialectInputs = [];
            },
            (input) => {
                input.dialectInputs[0]!.inputs = [];
            },
            (input) => {
                input.files.push(structuredClone(input.files[0]!));
            },
            (input) => {
                input.files.pop();
            },
            (input) => {
                input.files[0]!.relativePath = "foreign/member.txt";
            },
            (input) => {
                input.files[0]!.content = { contentKind: "binary", bytes: Uint8Array.of(1) };
            },
            (input) => {
                input.dialectRegistry = createVersionDialectRegistry([], [], [], []);
            },
            (input) => {
                const changed = {
                    ...fixture.nativeDialect,
                    definition: structuredClone(fixture.nativeDialect.definition),
                };
                changed.definition.contentNormalization.configFingerprint = `sha256:${"b".repeat(64)}`;
                input.dialectRegistry = createVersionDialectRegistry([changed], [], [], []);
            },
            (input) => {
                input.dialectRegistry = createVersionDialectRegistry(
                    [{ ...fixture.nativeDialect, validateSameContent: () => false }],
                    [],
                    [],
                    [],
                );
            },
        ];
        for (const mutate of mutations) {
            const input = consistencyInput(fixture);
            mutate(input);
            expect(isExactGraphNativeConsistencySatisfied(input)).toBe(false);
        }
    });

    it("rejects a registered entry checker exception instead of accepting its conversion", () => {
        const fixture = makeExactGraphFixture({
            canonicalMaterializer: {
                ...graphCanonicalMaterializer,
                validateEntry() {
                    throw new Error("target parser failed");
                },
            },
        });
        expect(() => fixture.registry.validateOutputContractMaterialization(materializationProof(fixture))).toThrow(
            /materialization violates/,
        );
    });

    it("rejects incomplete canonical graph output, attribution and dialect consistency", () => {
        const fixture = makeExactGraphFixture({ canonicalMaterializer: graphCanonicalMaterializer });
        expect(isExactGraphNativeConsistencySatisfied(consistencyInput(fixture))).toBe(true);
        const mutations: Array<(input: ReturnType<typeof consistencyInput>) => void> = [
            (input) => {
                input.files.pop();
            },
            (input) => {
                input.files[0]!.semanticRefFingerprints = [];
            },
            (input) => {
                input.files[0]!.content = { contentKind: "binary", bytes: Uint8Array.of(1) };
            },
            (input) => {
                input.dialectRegistry = createVersionDialectRegistry([], [], [], []);
            },
        ];
        for (const mutate of mutations) {
            const input = consistencyInput(fixture);
            mutate(input);
            expect(isExactGraphNativeConsistencySatisfied(input)).toBe(false);
        }
    });

    it("keeps reviewed conversion coverage separate from immutable native same-content validation", () => {
        const fixture = makeExactGraphFixture({ canonicalMaterializer: graphCanonicalMaterializer });
        const input = consistencyInput(fixture);
        let nativeChecks = 0;
        input.dialectRegistry = createVersionDialectRegistry(
            [
                {
                    ...fixture.nativeDialect,
                    validateSameContent() {
                        nativeChecks += 1;
                        return false;
                    },
                },
            ],
            [],
            [],
            [],
        );
        expect(isExactGraphNativeConsistencySatisfied(input)).toBe(true);
        expect(nativeChecks).toBe(0);
    });

    it("rejects missing, stale or no-longer-bound registered conversion coverage", () => {
        const fixture = makeExactGraphFixture({ canonicalMaterializer: graphCanonicalMaterializer });
        const mutations: Array<(input: ReturnType<typeof consistencyInput>) => void> = [
            (input) => {
                input.canonicalCoverageProof = undefined;
            },
            (input) => {
                const resource = input.files.find((file) => file.content.contentKind === "binary")!;
                resource.content = { contentKind: "binary", bytes: Uint8Array.of(9, 8, 7) };
            },
            (input) => {
                const semantic = structuredClone(input.semantics.find((item) => item.subject.subjectKind === "asset")!);
                semantic.subject.assetId = "99999999-9999-4999-8999-999999999999";
                input.semantics.push(semantic);
            },
            (input) => {
                const semantic = structuredClone(input.semantics.find((item) => item.subject.subjectKind === "file")!);
                if (semantic.subject.subjectKind === "file") semantic.subject.fileId = "99999999-9999-4999-8999-999999999999";
                input.semantics.push(semantic);
            },
            (input) => {
                input.canonicalCoverageProof!.coverageFingerprint = GRAPH_HASH;
            },
            (input) => {
                input.canonicalCoverageProof!.coveredSemanticRefFingerprints.pop();
            },
            (input) => {
                input.renderer.profileConstraintFingerprint = GRAPH_HASH;
            },
            (input) => {
                input.outputUnit.claims[0]!.relativePath += ".changed";
            },
            (input) => {
                input.outputUnit.managedDirectoryBoundaries[0]!.relativePath += "-changed";
            },
            (input) => {
                const file = input.files.find((candidate) => candidate.content.contentKind === "text")!;
                if (file.content.contentKind === "text") file.content.text += "changed after validation\n";
            },
            (input) => {
                const canonical = input.deployment.assets[0]!.version.canonical;
                if (canonical.kind === "Skill") canonical.typeData.description = "changed after validation";
            },
        ];
        for (const mutate of mutations) {
            const input = consistencyInput(fixture);
            mutate(input);
            expect(isExactGraphNativeConsistencySatisfied(input)).toBe(false);
        }
    });
});

function materializationProof(fixture: ReturnType<typeof makeExactGraphFixture>) {
    const materialization = exactGraphMaterializationInput(fixture);
    const result = fixture.support.materialize(materialization);
    if (result.materializationState !== "materialized") throw new Error("exact graph materialization fixture failed");
    return {
        contract: fixture.components.outputContracts[0]!,
        profile: fixture.components.outputContracts[0]!.materializationProfiles[0]!,
        outputUnit: materialization.selection.outputUnits[0]!,
        selectedSemantics: structuredClone(fixture.requiredSemantics),
        canonicalValues: exactGraphCanonicalValues(fixture),
        selectedOptions: structuredClone(materialization.selection.semanticOptions),
        dialectInputs: structuredClone(materialization.dialectInputs),
        files: structuredClone(result.materializedUnits[0]!.files),
    };
}

function reverseProof(fixture: ReturnType<typeof makeExactGraphFixture>) {
    const materialization = exactGraphMaterializationInput(fixture);
    const inspection = changedExactGraphInspection(fixture, materialization);
    return {
        contract: fixture.components.outputContracts[0]!,
        outputUnit: materialization.selection.outputUnits[0]!,
        appliedRenderSnapshot: fullExactGraphAppliedSnapshot(inspection.appliedRenderSnapshot),
        inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
        files: structuredClone(inspection.files),
        inventoryDeltas: structuredClone(inspection.inventoryDeltas),
        adapterResult: fixture.support.inspect(inspection),
    };
}

function uniqueResult(input: ReturnType<typeof reverseProof>) {
    const result = input.adapterResult.files.find((file) => file.attributionState === "uniquely_attributable");
    if (result?.attributionState !== "uniquely_attributable") throw new Error("unique graph result fixture is missing");
    return result;
}

function consistencyInput(fixture: ReturnType<typeof makeExactGraphFixture>) {
    const materialization = exactGraphMaterializationInput(fixture);
    const result = fixture.support.materialize(materialization);
    if (result.materializationState !== "materialized") throw new Error("exact graph materialization fixture failed");
    return {
        deployment: structuredClone(fixture.deployment),
        provider: structuredClone(fixture.provider),
        semantics: structuredClone(fixture.requiredSemantics),
        dialectInputs: structuredClone(fixture.analysisInput.dialectInputs),
        outputUnit: structuredClone(materialization.selection.outputUnits[0]!),
        renderer: structuredClone(materialization.selection.outputUnitRenderers[0]!),
        files: structuredClone(result.materializedUnits[0]!.files),
        dialectRegistry: createVersionDialectRegistry([fixture.nativeDialect], [], [], []),
        canonicalCoverageProof: fixture.registry.validateOutputContractMaterialization(materializationProof(fixture)) as
            | MaterializationSemanticCoverageProof
            | undefined,
    };
}
