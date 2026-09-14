/** Core contract tests for one native file encoding a Subagent graph. */

import { describe, expect, it } from "vitest";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { materializeRenderDeployment } from "../../src/render/render-materialization";
import { validateAdapterRenderContractRegistration } from "../../src/render/adapter-render-contract-registration";
import { computeRenderSelectionFingerprint } from "../../src/foundation/fingerprint";
import {
    ENCODED_CHANGED_ENTRY_TEXT,
    ENCODED_CHANGED_NATIVE_TEXT,
    ENCODED_CHANGED_PROMPT_TEXT,
    ENCODED_ENTRY_TEXT,
    ENCODED_HASH,
    ENCODED_NATIVE_TEXT,
    ENCODED_REBASED_NATIVE_TEXT,
    ENCODED_TARGET_PATH,
    asEncodedFileProvider,
    changedEncodedInspection,
    encodedCanonicalValues,
    encodedMaterializationInput,
    fullEncodedAppliedSnapshot,
    makeEncodedFileFixture,
    makeParentEncodedRebaseFixture,
} from "./fixtures/native-project-encoded-file-test-fixtures";

describe("native project encoded-file contract", () => {
    it("materializes a complete current Subagent entry and initial prompt into one bound native file", () => {
        const fixture = makeEncodedFileFixture();
        expect(validateAdapterRenderContractRegistration([asEncodedFileProvider(fixture)])).toEqual([]);
        expect(Object.isFrozen(fixture.support.renderContractDeclaration)).toBe(true);
        expect(fixture.support.targetCapability).toMatchObject({
            assetKind: "Subagent",
            renderStrategy: "native_graph",
            reverseExtractPolicy: "can_reconcile",
        });

        const analysis = fixture.support.analyze(fixture.analysisInput);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [] });
        expect(analysis.outputUnits).toHaveLength(1);
        expect(analysis.outputUnits[0]).toMatchObject({
            claims: [{ relativePath: ENCODED_TARGET_PATH, contentKind: "text", executable: false }],
            managedDirectoryBoundaries: [],
        });
        expect(analysis.semanticOptions).toHaveLength(fixture.requiredSemantics.length);
        expect(
            analysis.semanticOptions.every(
                (option) =>
                    option.outcome === "preserved" &&
                    option.renderStrategy === "native_graph" &&
                    option.actualReverseExtractPolicy === "can_reconcile",
            ),
        ).toBe(true);

        const input = encodedMaterializationInput(fixture);
        const result = fixture.support.materialize(input);
        expect(result).toMatchObject({ status: "complete", materializationState: "materialized" });
        if (result.materializationState !== "materialized") throw new Error("encoded fixture did not materialize");
        expect(result.materializedUnits).toHaveLength(1);
        expect(result.materializedUnits[0]!.files).toEqual([
            expect.objectContaining({
                relativePath: ENCODED_TARGET_PATH,
                content: { contentKind: "text", text: ENCODED_NATIVE_TEXT },
                executable: false,
                sectionBindings: expect.arrayContaining([
                    expect.objectContaining({ sectionHandle: "encoded-entry" }),
                    expect.objectContaining({ sectionHandle: "encoded-resource" }),
                ]),
            }),
        ]);
        expect(result.materializedUnits[0]!.files[0]!.sectionBindings).toHaveLength(2);

        expect(
            fixture.registry.validateOutputContractMaterialization({
                contract: fixture.components.outputContracts[0]!,
                profile: fixture.components.outputContracts[0]!.materializationProfiles[0]!,
                outputUnit: input.selection.outputUnits[0]!,
                selectedSemantics: fixture.requiredSemantics,
                canonicalValues: encodedCanonicalValues(fixture),
                selectedOptions: input.selection.semanticOptions,
                dialectInputs: input.dialectInputs,
                files: result.materializedUnits[0]!.files,
            }),
        ).toMatchObject({
            outputUnitFingerprint: input.selection.outputUnits[0]!.outputUnitFingerprint,
            coveredSemanticRefFingerprints: fixture.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint).sort(),
        });
    });

    it("supports the legal one-canonical-file Subagent form without inventing a prompt section", () => {
        const fixture = makeEncodedFileFixture({ withPrompt: false });
        expect(fixture.support.analyze(fixture.analysisInput).status).toBe("complete");
        const result = fixture.support.materialize(encodedMaterializationInput(fixture));
        if (result.materializationState !== "materialized") throw new Error("one-file Subagent did not materialize");
        const file = result.materializedUnits[0]!.files[0]!;
        expect(file.sectionBindings).toHaveLength(1);
        expect(file.sectionBindings[0]?.sectionHandle).toBe("encoded-entry");
        expect(JSON.parse((file.content as { contentKind: "text"; text: string }).text)).toMatchObject({
            entry: ENCODED_ENTRY_TEXT,
            initialPrompt: null,
        });
    });

    it("rebases both canonical files into the immediate-parent native envelope while preserving private layout", () => {
        const fixture = makeParentEncodedRebaseFixture();
        expect(fixture.support.analyze(fixture.analysisInput).status).toBe("complete");
        const input = encodedMaterializationInput(fixture);
        const result = fixture.support.materialize(input);
        if (result.materializationState !== "materialized") throw new Error("encoded parent did not materialize");
        expect(result.materializedUnits[0]!.files[0]).toMatchObject({
            content: { contentKind: "text", text: ENCODED_REBASED_NATIVE_TEXT },
        });
        expect(
            fixture.registry.validateOutputContractMaterialization({
                contract: fixture.components.outputContracts[0]!,
                profile: fixture.components.outputContracts[0]!.materializationProfiles[0]!,
                outputUnit: input.selection.outputUnits[0]!,
                selectedSemantics: fixture.requiredSemantics,
                canonicalValues: encodedCanonicalValues(fixture),
                selectedOptions: input.selection.semanticOptions,
                dialectInputs: input.dialectInputs,
                files: result.materializedUnits[0]!.files,
            }),
        ).toMatchObject({ outputUnitFingerprint: input.selection.outputUnits[0]!.outputUnitFingerprint });
    });

    it("attributes entry-only, prompt-only, and combined edits to their exact canonical files", () => {
        const cases = [
            {
                currentText: replaceEnvelope(ENCODED_NATIVE_TEXT, { entry: ENCODED_CHANGED_ENTRY_TEXT }),
                expected: [ENCODED_CHANGED_ENTRY_TEXT],
            },
            {
                currentText: replaceEnvelope(ENCODED_NATIVE_TEXT, { initialPrompt: ENCODED_CHANGED_PROMPT_TEXT }),
                expected: [ENCODED_CHANGED_PROMPT_TEXT],
            },
            {
                currentText: ENCODED_CHANGED_NATIVE_TEXT,
                expected: [ENCODED_CHANGED_ENTRY_TEXT, ENCODED_CHANGED_PROMPT_TEXT],
            },
        ];
        for (const { currentText, expected } of cases) {
            const fixture = makeEncodedFileFixture();
            const materialization = encodedMaterializationInput(fixture);
            const inspection = changedEncodedInspection(fixture, materialization, currentText);
            const result = fixture.support.inspect(inspection);
            expect(result.status).toBe("complete");
            expect(result.files).toEqual([
                expect.objectContaining({ relativePath: ENCODED_TARGET_PATH, attributionState: "uniquely_attributable" }),
            ]);
            expect(
                result.changes.map((change) =>
                    change.changeKind === "file_content_replacement" && change.replacementContent.contentKind === "text"
                        ? change.replacementContent.text
                        : "",
                ),
            ).toEqual(expect.arrayContaining(expected));
            expect(result.changes).toHaveLength(expected.length);
            expect(
                fixture.registry.validateOutputContractReverseInspection({
                    contract: fixture.components.outputContracts[0]!,
                    outputUnit: materialization.selection.outputUnits[0]!,
                    appliedRenderSnapshot: fullEncodedAppliedSnapshot(inspection.appliedRenderSnapshot),
                    inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
                    files: inspection.files,
                    inventoryDeltas: inspection.inventoryDeltas,
                    adapterResult: result,
                }),
            ).toMatchObject({ coveredChangeFingerprints: result.changes.map((change) => change.changeFingerprint).sort() });
        }
    });

    it("runs the final native consistency gate and rejects a Provider-forged native envelope", async () => {
        const fixture = makeParentEncodedRebaseFixture();
        const analysis = fixture.support.analyze(fixture.analysisInput);
        if (analysis.status !== "complete") throw new Error("encoded analysis fixture failed");
        const providerSelection = encodedMaterializationInput(fixture).selection;
        const selectionPreimage = {
            schemaVersion: 1 as const,
            compilerPolicyVersion: "core_render_policy_v1" as const,
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            semanticOptions: providerSelection.semanticOptions.map((option) => ({
                ...option,
                consumerOwnerAdapterId: fixture.provider.adapterId,
                consumerOwnerAdapterVersion: fixture.provider.version,
                approval: { approvalState: "not_required" as const },
            })),
            outputUnits: providerSelection.outputUnits,
            outputUnitRenderers: providerSelection.outputUnitRenderers,
            promotionAuthorizations: [],
        };
        const selection = {
            ...selectionPreimage,
            selectionFingerprint: computeRenderSelectionFingerprint(selectionPreimage),
        };
        const run = (forge: boolean) =>
            materializeRenderDeployment(
                {
                    deployment: fixture.deployment,
                    analysis: {
                        renderInputFingerprint: fixture.deployment.renderInputFingerprint,
                        requiredSemantics: fixture.requiredSemantics,
                        analyses: [
                            { ...analysis, adapterId: fixture.provider.adapterId, adapterVersion: fixture.provider.version },
                        ],
                    },
                    selection,
                },
                {
                    registry: fixture.registry,
                    dialectRegistry: createVersionDialectRegistry([fixture.nativeDialect], [], [], []),
                    resolveDialectInputs: () => structuredClone(fixture.analysisInput.dialectInputs),
                    dispatch: async (_adapterId, input) => {
                        const value = fixture.support.materialize(input);
                        if (forge && value.materializationState === "materialized") {
                            const file = value.materializedUnits[0]!.files[0]!;
                            file.content = {
                                contentKind: "text",
                                text: replaceEnvelope(ENCODED_REBASED_NATIVE_TEXT, { privateLayout: "forged" }),
                            };
                        }
                        return { status: "complete" as const, value, diagnostics: [] };
                    },
                },
            );
        expect((await run(false)).status).toBe("complete");
        const forged = await run(true);
        expect(forged.status).toBe("failed");
        expect(forged.diagnostics[0]?.code).toBe("render.native_consistency_failed");
    });
});

function replaceEnvelope(text: string, patch: Record<string, unknown>): string {
    return `${JSON.stringify({ ...(JSON.parse(text) as Record<string, unknown>), ...patch })}\n`;
}
