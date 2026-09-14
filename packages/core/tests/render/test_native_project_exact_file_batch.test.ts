/** Same-kind multi-Asset behavior for the generic exact-file render factory. */

import { describe, expect, it } from "vitest";
import { binaryPayloadStats } from "../../src/catalog/payload-store";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { computeRenderSelectionFingerprint } from "../../src/foundation/fingerprint";
import { materializeRenderDeployment } from "../../src/render/render-materialization";
import {
    EXACT_HASH,
    EXACT_NATIVE_TEXT,
    EXACT_TARGET_PATH,
    SECOND_EXACT_CHANGED_NATIVE_TEXT,
    SECOND_EXACT_NATIVE_TEXT,
    SECOND_EXACT_TARGET_PATH,
    changedExactFileInspection,
    exactMaterializationInput,
    makeTwoAssetExactFileFixture,
} from "./fixtures/native-project-exact-file-test-fixtures";

describe("native project exact-file same-kind batch", () => {
    it("materializes two same-kind one-file Assets and attributes each changed file independently", async () => {
        const fixture = makeTwoAssetExactFileFixture();
        const analysis = fixture.support.analyze(fixture.analysisInput);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [] });
        expect(analysis.outputUnits.map((unit) => unit.claims[0]!.relativePath).sort()).toEqual(
            [EXACT_TARGET_PATH, SECOND_EXACT_TARGET_PATH].sort(),
        );
        expect(analysis.outputUnits).toHaveLength(2);
        expect(new Set(analysis.outputUnits.map((unit) => unit.outputUnitFingerprint)).size).toBe(2);
        expect(analysis.semanticOptions.every((option) => option.requiredOutputUnitFingerprints.length === 1)).toBe(true);

        const input = exactMaterializationInput(fixture);
        const materialized = fixture.support.materialize(input);
        expect(materialized).toMatchObject({ status: "complete", materializationState: "materialized" });
        if (materialized.materializationState !== "materialized") throw new Error("batched materialization failed");
        expect(
            materialized.materializedUnits
                .flatMap((unit) => unit.files.map((file) => [file.relativePath, file.content]))
                .sort(([left], [right]) => String(left).localeCompare(String(right))),
        ).toEqual(
            [
                [EXACT_TARGET_PATH, { contentKind: "text", text: EXACT_NATIVE_TEXT }],
                [SECOND_EXACT_TARGET_PATH, { contentKind: "text", text: SECOND_EXACT_NATIVE_TEXT }],
            ].sort(([left], [right]) => String(left).localeCompare(String(right))),
        );
        expect(materialized.materializedUnits.every((unit) => unit.files[0]!.semanticRefFingerprints.length > 1)).toBe(true);

        const selectionPreimage = {
            schemaVersion: 1 as const,
            compilerPolicyVersion: "core_render_policy_v1" as const,
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            semanticOptions: input.selection.semanticOptions.map((option) => ({
                ...option,
                consumerOwnerAdapterId: fixture.provider.adapterId,
                consumerOwnerAdapterVersion: fixture.provider.version,
                approval: { approvalState: "not_required" as const },
            })),
            outputUnits: input.selection.outputUnits,
            outputUnitRenderers: input.selection.outputUnitRenderers,
            promotionAuthorizations: [],
        };
        const selection = {
            ...selectionPreimage,
            selectionFingerprint: computeRenderSelectionFingerprint(selectionPreimage),
        };
        const coreMaterialized = await materializeRenderDeployment(
            {
                deployment: fixture.deployment,
                analysis: {
                    renderInputFingerprint: fixture.deployment.renderInputFingerprint,
                    requiredSemantics: fixture.requiredSemantics,
                    analyses: [
                        {
                            ...analysis,
                            adapterId: fixture.provider.adapterId,
                            adapterVersion: fixture.provider.version,
                        },
                    ],
                },
                selection,
            },
            {
                registry: fixture.registry,
                dialectRegistry: createVersionDialectRegistry([fixture.nativeDialect], [], [], []),
                resolveDialectInputs: () => structuredClone(fixture.analysisInput.dialectInputs),
                dispatch: async (_adapterId, providerInput) => ({
                    status: "complete" as const,
                    value: fixture.support.materialize(providerInput),
                    diagnostics: [],
                }),
            },
        );
        expect(coreMaterialized).toMatchObject({ status: "complete", value: { units: [{}, {}] } });

        const firstUnit = input.selection.outputUnits.find((unit) => unit.claims[0]?.relativePath === EXACT_TARGET_PATH)!;
        const inspection = changedExactFileInspection(fixture, input);
        inspection.appliedRenderSnapshot.outputUnits = structuredClone(input.selection.outputUnits);
        inspection.appliedRenderSnapshot.outputUnitRenderers = structuredClone(input.selection.outputUnitRenderers);
        inspection.appliedRenderSnapshot.decisions = fixture.requiredSemantics.map((semantic) => {
            const option = analysis.semanticOptions.find(
                (candidate) => candidate.semanticRefFingerprint === semantic.semanticRefFingerprint,
            )!;
            return {
                semanticRef: structuredClone(semantic),
                consumerOwnerAdapterId: fixture.provider.adapterId,
                consumerOwnerAdapterVersion: fixture.provider.version,
                optionFingerprint: option.optionFingerprint,
                renderStrategy: "native_file" as const,
                actualReverseExtractPolicy: "can_reconcile" as const,
                outputUnitFingerprints: structuredClone(option.requiredOutputUnitFingerprints),
                outcome: "preserved" as const,
            };
        });
        inspection.inspectionScope.fileStates[0]!.outputUnitFingerprint = firstUnit.outputUnitFingerprint;
        const firstRefs = inspection.appliedRenderSnapshot.decisions
            .filter((decision) => decision.outputUnitFingerprints.includes(firstUnit.outputUnitFingerprint))
            .map((decision) => decision.semanticRef.semanticRefFingerprint);
        const changedFile = inspection.files[0];
        if (changedFile?.fileState !== "baseline_changed") throw new Error("changed exact-file fixture is missing");
        changedFile.provenance.outputUnitFingerprint = firstUnit.outputUnitFingerprint;
        changedFile.provenance.semanticRefFingerprints = firstRefs;
        expect(fixture.support.inspect(inspection)).toMatchObject({
            status: "complete",
            changes: [{ semanticRefFingerprints: [expect.any(String)] }],
            files: [{ relativePath: EXACT_TARGET_PATH, attributionState: "uniquely_attributable" }],
        });

        const secondUnit = input.selection.outputUnits.find((unit) => unit.claims[0]?.relativePath === SECOND_EXACT_TARGET_PATH)!;
        const bothChanged = structuredClone(inspection);
        bothChanged.inspectionScope.fileStates.push({
            relativePath: SECOND_EXACT_TARGET_PATH,
            state: "changed",
            appliedContentHash: binaryPayloadStats(new TextEncoder().encode(SECOND_EXACT_NATIVE_TEXT)).contentHash,
            currentContentHash: binaryPayloadStats(new TextEncoder().encode(SECOND_EXACT_CHANGED_NATIVE_TEXT)).contentHash,
            appliedExecutable: false,
            currentExecutable: false,
            outputUnitFingerprint: secondUnit.outputUnitFingerprint,
            provenanceFingerprint: EXACT_HASH,
        });
        const secondRefs = bothChanged.appliedRenderSnapshot.decisions
            .filter((decision) => decision.outputUnitFingerprints.includes(secondUnit.outputUnitFingerprint))
            .map((decision) => decision.semanticRef.semanticRefFingerprint);
        bothChanged.files.push({
            fileState: "baseline_changed",
            relativePath: SECOND_EXACT_TARGET_PATH,
            appliedContent: { contentKind: "text", text: SECOND_EXACT_NATIVE_TEXT },
            currentContent: { contentKind: "text", text: SECOND_EXACT_CHANGED_NATIVE_TEXT },
            diffHunks: [
                {
                    hunkFingerprint: EXACT_HASH,
                    appliedStartByte: 0,
                    appliedEndByte: Buffer.byteLength(SECOND_EXACT_NATIVE_TEXT),
                    currentStartByte: 0,
                    currentEndByte: Buffer.byteLength(SECOND_EXACT_CHANGED_NATIVE_TEXT),
                },
            ],
            attributeChanges: [],
            provenance: {
                schemaVersion: 1,
                appliedRenderSnapshotFingerprint: EXACT_HASH,
                outputUnitFingerprint: secondUnit.outputUnitFingerprint,
                semanticRefFingerprints: secondRefs,
                sectionBindings: [],
                materializationFingerprint: EXACT_HASH,
                provenanceFingerprint: EXACT_HASH,
            },
        });
        expect(fixture.support.inspect(bothChanged)).toMatchObject({
            status: "complete",
            changes: [{}, {}],
            files: [{ attributionState: "uniquely_attributable" }, { attributionState: "uniquely_attributable" }],
        });
    });

    it("rejects incomplete or colliding same-kind exact-file batches", () => {
        const fixture = makeTwoAssetExactFileFixture();
        const collisions = makeTwoAssetExactFileFixture();
        const secondNative = collisions.analysisInput.dialectInputs[1]!.inputs[0]!;
        if (secondNative.inputKind !== "native_representation") throw new Error("second native input is missing");
        secondNative.files[0]!.relativePath = EXACT_TARGET_PATH;
        expect(collisions.support.analyze(collisions.analysisInput).status).toBe("failed");

        const missingDialect = makeTwoAssetExactFileFixture();
        missingDialect.analysisInput.dialectInputs.pop();
        expect(missingDialect.support.analyze(missingDialect.analysisInput).status).toBe("failed");

        const staleSelection = exactMaterializationInput(makeTwoAssetExactFileFixture());
        staleSelection.selection.outputUnitRenderers.pop();
        expect(fixture.support.materialize(staleSelection)).toMatchObject({
            status: "failed",
            materializationState: "blocked",
        });
    });
});
