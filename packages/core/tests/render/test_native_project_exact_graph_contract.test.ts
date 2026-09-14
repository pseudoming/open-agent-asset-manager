/** Core contract and fail-closed tests for complete native Skill file graphs. */

import { describe, expect, it } from "vitest";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import type { RenderMaterializationInput } from "../../src/contracts/render";
import type { RenderedTargetInspectionInput } from "../../src/contracts/reverse";
import { computeRenderSelectionFingerprint } from "../../src/foundation/fingerprint";
import { validateAdapterRenderContractRegistration } from "../../src/render/adapter-render-contract-registration";
import {
    createNativeProjectExactGraphProviderSupport,
    createVerifiedNativeProjectExactGraphBuild,
    makeNativeProjectExactGraphContractParts,
} from "../../src/render/native-project-exact-graph";
import { materializeRenderDeployment } from "../../src/render/render-materialization";
import {
    asExactGraphProvider,
    changedExactGraphInspection,
    exactGraphCanonicalValues,
    exactGraphMaterializationInput,
    fullExactGraphAppliedSnapshot,
    GRAPH_BINARY_RESOURCE_PATH,
    GRAPH_BOUNDARY,
    GRAPH_CHANGED_ENTRY_TEXT,
    GRAPH_CHANGED_TEXT_RESOURCE,
    GRAPH_DIALECT_ID,
    GRAPH_ENTRY_PATH,
    GRAPH_HASH,
    GRAPH_NATIVE_ENTRY_TEXT,
    GRAPH_OUTPUT_CONTRACT_ID,
    GRAPH_PARSER_REF,
    GRAPH_PROFILE_ID,
    GRAPH_REBASE_REF,
    GRAPH_REBASED_NATIVE_ENTRY_TEXT,
    GRAPH_TEXT_RESOURCE_PATH,
    GRAPH_VALIDATOR_REF,
    graphCanonicalMaterializer,
    makeExactGraphFixture,
    makeParentGraphRebaseFixture,
} from "./fixtures/native-project-exact-graph-test-fixtures";

describe("native project exact-graph contract", () => {
    it("registers one immutable Skill graph and emits every current native file under one managed boundary", () => {
        const nativeDirectories = [GRAPH_BOUNDARY, `${GRAPH_BOUNDARY}/empty`, `${GRAPH_BOUNDARY}/resources`] as const;
        const fixture = makeExactGraphFixture({ nativeDirectories });
        expect(validateAdapterRenderContractRegistration([asExactGraphProvider(fixture)])).toEqual([]);
        expect(Object.isFrozen(fixture.support.renderContractDeclaration)).toBe(true);
        expect(fixture.support.targetCapability).toMatchObject({
            assetKind: "Skill",
            renderStrategy: "native_graph",
            reverseExtractPolicy: "can_reconcile",
        });

        const analysis = fixture.support.analyze(fixture.analysisInput);
        expect(analysis).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            outputUnits: [
                {
                    managedDirectoryBoundaries: [
                        {
                            schemaVersion: 2,
                            relativePath: GRAPH_BOUNDARY,
                            boundaryKind: "directory_inventory",
                            desiredDirectoryPaths: nativeDirectories,
                        },
                    ],
                },
            ],
        });
        expect(analysis.outputUnits[0]!.claims.map((claim) => claim.relativePath).sort()).toEqual(
            [GRAPH_ENTRY_PATH, GRAPH_TEXT_RESOURCE_PATH, GRAPH_BINARY_RESOURCE_PATH].sort(),
        );
        expect(analysis.semanticOptions).toHaveLength(fixture.requiredSemantics.length);
        expect(
            analysis.semanticOptions.every(
                (option) =>
                    option.outcome === "preserved" &&
                    option.renderStrategy === "native_graph" &&
                    option.actualReverseExtractPolicy === "can_reconcile",
            ),
        ).toBe(true);

        const input = exactGraphMaterializationInput(fixture);
        const result = fixture.support.materialize(input);
        expect(result).toMatchObject({ status: "complete", materializationState: "materialized" });
        if (result.materializationState !== "materialized") throw new Error("graph fixture did not materialize");
        expect(result.materializedUnits[0]!.files.map((file) => file.relativePath).sort()).toEqual(
            [GRAPH_ENTRY_PATH, GRAPH_TEXT_RESOURCE_PATH, GRAPH_BINARY_RESOURCE_PATH].sort(),
        );
        const entry = result.materializedUnits[0]!.files.find((file) => file.relativePath === GRAPH_ENTRY_PATH);
        expect(entry).toMatchObject({ content: { contentKind: "text", text: GRAPH_NATIVE_ENTRY_TEXT } });
        expect(result.materializedUnits[0]!.files.every((file) => file.semanticRefFingerprints.length > 0)).toBe(true);

        expect(
            fixture.registry.validateOutputContractMaterialization({
                contract: fixture.components.outputContracts[0]!,
                profile: fixture.components.outputContracts[0]!.materializationProfiles[0]!,
                outputUnit: input.selection.outputUnits[0]!,
                selectedSemantics: fixture.requiredSemantics,
                canonicalValues: exactGraphCanonicalValues(fixture),
                selectedOptions: input.selection.semanticOptions,
                dialectInputs: input.dialectInputs,
                files: result.materializedUnits[0]!.files,
            }),
        ).toMatchObject({
            outputUnitFingerprint: input.selection.outputUnits[0]!.outputUnitFingerprint,
            coveredSemanticRefFingerprints: fixture.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint).sort(),
        });
    });

    it("rebases a foreign canonical child into the complete immediate-parent native graph", () => {
        const fixture = makeParentGraphRebaseFixture();
        expect(fixture.support.analyze(fixture.analysisInput).status).toBe("complete");
        const result = fixture.support.materialize(exactGraphMaterializationInput(fixture));
        expect(result).toMatchObject({ status: "complete", materializationState: "materialized" });
        if (result.materializationState !== "materialized") throw new Error("parent graph fixture did not materialize");
        const files = new Map(result.materializedUnits[0]!.files.map((file) => [file.relativePath, file]));
        expect(files.get(GRAPH_ENTRY_PATH)).toMatchObject({
            content: { contentKind: "text", text: GRAPH_REBASED_NATIVE_ENTRY_TEXT },
        });
        expect(files.get(GRAPH_TEXT_RESOURCE_PATH)).toMatchObject({
            content: { contentKind: "text", text: GRAPH_CHANGED_TEXT_RESOURCE },
            executable: true,
        });
        expect(files.has(GRAPH_BINARY_RESOURCE_PATH)).toBe(true);
        const input = exactGraphMaterializationInput(fixture);
        expect(
            fixture.registry.validateOutputContractMaterialization({
                contract: fixture.components.outputContracts[0]!,
                profile: fixture.components.outputContracts[0]!.materializationProfiles[0]!,
                outputUnit: input.selection.outputUnits[0]!,
                selectedSemantics: fixture.requiredSemantics,
                canonicalValues: exactGraphCanonicalValues(fixture),
                selectedOptions: input.selection.semanticOptions,
                dialectInputs: input.dialectInputs,
                files: result.materializedUnits[0]!.files,
            }),
        ).toMatchObject({ outputUnitFingerprint: input.selection.outputUnits[0]!.outputUnitFingerprint });

        const missing = makeParentGraphRebaseFixture();
        const native = missing.analysisInput.dialectInputs[0]!.inputs[0]!;
        if (native.inputKind !== "native_representation") throw new Error("parent graph input is missing");
        native.files.pop();
        expect(missing.support.analyze(missing.analysisInput)).toMatchObject({ status: "failed", outputUnits: [] });

        const wrongShape = makeParentGraphRebaseFixture();
        const wrongNative = wrongShape.analysisInput.dialectInputs[0]!.inputs[0]!;
        if (wrongNative.inputKind !== "native_representation") throw new Error("parent graph input is missing");
        wrongNative.files[0]!.mediaType = "application/x-wrong";
        expect(wrongShape.support.analyze(wrongShape.analysisInput)).toMatchObject({ status: "failed", outputUnits: [] });
    });

    it("materializes one declared canonical migration only as an approved degraded graph", async () => {
        const fixture = makeExactGraphFixture({ canonicalMaterializer: graphCanonicalMaterializer });
        expect(validateAdapterRenderContractRegistration([asExactGraphProvider(fixture)])).toEqual([]);
        const analysis = fixture.support.analyze(fixture.analysisInput);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.semanticOptions).toHaveLength(fixture.requiredSemantics.length);
        expect(
            analysis.semanticOptions.every(
                (option) =>
                    option.outcome === "degraded" &&
                    option.reasonCode === "fixture_skill_reviewed_migration" &&
                    option.approvalRequirement.approvalState === "required",
            ),
        ).toBe(true);

        const providerInput = exactGraphMaterializationInput(fixture);
        const providerResult = fixture.support.materialize(providerInput);
        expect(providerResult).toMatchObject({ status: "complete", materializationState: "materialized" });
        if (providerResult.materializationState !== "materialized") throw new Error("canonical graph did not materialize");
        expect(
            fixture.registry.validateOutputContractMaterialization({
                contract: fixture.components.outputContracts[0]!,
                profile: fixture.components.outputContracts[0]!.materializationProfiles[0]!,
                outputUnit: providerInput.selection.outputUnits[0]!,
                selectedSemantics: fixture.requiredSemantics,
                canonicalValues: exactGraphCanonicalValues(fixture),
                selectedOptions: providerInput.selection.semanticOptions,
                dialectInputs: providerInput.dialectInputs,
                files: providerResult.materializedUnits[0]!.files,
            }),
        ).toMatchObject({ outputUnitFingerprint: providerInput.selection.outputUnits[0]!.outputUnitFingerprint });

        const optionByRef = new Map(analysis.semanticOptions.map((option) => [option.semanticRefFingerprint, option]));
        const selectionPreimage = {
            schemaVersion: 1 as const,
            compilerPolicyVersion: "core_render_policy_v1" as const,
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            semanticOptions: providerInput.selection.semanticOptions.map((selected) => {
                const option = optionByRef.get(selected.semanticRefFingerprint);
                if (
                    option?.outcome !== "degraded" ||
                    option.approvalRequirement.approvalState !== "required" ||
                    selected.outcome !== "degraded"
                ) {
                    throw new Error("degraded canonical option is missing");
                }
                return {
                    ...selected,
                    consumerOwnerAdapterId: fixture.provider.adapterId,
                    consumerOwnerAdapterVersion: fixture.provider.version,
                    degradationKinds: option.degradationKinds,
                    approval: {
                        approvalState: "approved" as const,
                        approvalSource: "one_time_user_approval" as const,
                        userActionEvidenceId: `approved-${selected.semanticRefFingerprint}`,
                        resolvedAt: 1,
                        approvalFingerprint: option.approvalRequirement.approvalFingerprint,
                    },
                };
            }),
            outputUnits: providerInput.selection.outputUnits,
            outputUnitRenderers: providerInput.selection.outputUnitRenderers,
            promotionAuthorizations: [],
        };
        const selection = {
            ...selectionPreimage,
            selectionFingerprint: computeRenderSelectionFingerprint(selectionPreimage),
        };
        const result = await materializeRenderDeployment(
            {
                deployment: fixture.deployment,
                analysis: {
                    renderInputFingerprint: fixture.deployment.renderInputFingerprint,
                    requiredSemantics: fixture.requiredSemantics,
                    analyses: [{ ...analysis, adapterId: fixture.provider.adapterId, adapterVersion: fixture.provider.version }],
                },
                selection,
            },
            {
                registry: fixture.registry,
                dialectRegistry: createVersionDialectRegistry([fixture.nativeDialect], [], [], []),
                resolveDialectInputs: () => structuredClone(fixture.analysisInput.dialectInputs),
                dispatch: async (_adapterId, input) => ({
                    status: "complete" as const,
                    value: fixture.support.materialize(input),
                    diagnostics: [],
                }),
            },
        );
        expect(result.status).toBe("complete");
    });

    it("carries a Provider-owned substitute AssetKind through declaration, dialect input, and semantic analysis", () => {
        const fixture = makeExactGraphFixture({
            canonicalMaterializer: { ...graphCanonicalMaterializer, substituteAssetKind: "Workflow" },
        });
        expect(fixture.support.renderContractDeclaration.canonicalMaterialization).toMatchObject({
            substituteAssetKind: "Workflow",
        });
        expect(fixture.analysisInput.dialectInputs[0]?.inputs[0]).toMatchObject({
            inputKind: "canonical_materialization",
            substituteAssetKind: "Workflow",
        });
        const analysis = fixture.support.analyze(fixture.analysisInput);
        expect(analysis.status).toBe("complete");
        expect(analysis.semanticOptions).not.toHaveLength(0);
        expect(analysis.semanticOptions.every((option) => option.substituteAssetKind === "Workflow")).toBe(true);
    });

    it("fails analysis and materialization when graph identity, lineage, semantics or selection drift", () => {
        const analysisMutations: Array<(fixture: ReturnType<typeof makeExactGraphFixture>) => void> = [
            (fixture) => {
                fixture.analysisInput.deployment.assets = [];
            },
            (fixture) => {
                fixture.analysisInput.deployment.targetContexts = [];
            },
            (fixture) => {
                fixture.analysisInput.dialectInputs = [];
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.scope = "global";
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.status = "incomplete";
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.files.pop();
            },
            (fixture) => {
                fixture.analysisInput.requiredSemantics.pop();
            },
            (fixture) => {
                const input = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
                if (input.inputKind === "native_representation") input.representation.dialectId = "foreign-v1";
            },
            (fixture) => {
                const input = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
                if (input.inputKind === "native_representation") input.files[0]!.relativePath = "outside/SKILL.md";
            },
            (fixture) => {
                fixture.analysisInput.dialectInputs.push(structuredClone(fixture.analysisInput.dialectInputs[0]!));
            },
        ];
        for (const mutate of analysisMutations) {
            const fixture = makeExactGraphFixture();
            mutate(fixture);
            expect(fixture.support.analyze(fixture.analysisInput)).toMatchObject({ status: "failed", outputUnits: [] });
        }

        const fixture = makeExactGraphFixture();
        const valid = exactGraphMaterializationInput(fixture);
        const mutations: Array<(input: RenderMaterializationInput) => void> = [
            (input) => {
                input.selection.outputUnits = [];
            },
            (input) => {
                input.selection.outputUnitRenderers = [];
            },
            (input) => {
                input.selection.outputUnits[0]!.claims.pop();
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.rendererAdapterId = "FOREIGN";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.materializationProfileId = "wrong";
            },
            (input) => {
                input.selection.semanticOptions.pop();
            },
            (input) => {
                input.selection.semanticOptions[0]!.outcome = "degraded";
            },
            (input) => {
                input.selection.semanticOptions[0]!.renderStrategy = "inline";
            },
            (input) => {
                input.requiredSemantics.pop();
            },
            (input) => {
                input.dialectInputs = [];
            },
        ];
        for (const mutate of mutations) {
            const input = structuredClone(valid);
            mutate(input);
            expect(fixture.support.materialize(input)).toMatchObject({ status: "failed", materializationState: "blocked" });
        }
    });

    it("attributes existing text, binary and executable changes while rejecting graph inventory mutation", () => {
        const fixture = makeExactGraphFixture();
        const materialization = exactGraphMaterializationInput(fixture);
        const inspection = changedExactGraphInspection(fixture, materialization);
        const result = fixture.support.inspect(inspection);
        expect(result.status).toBe("complete");
        expect(result.files.every((file) => file.attributionState === "uniquely_attributable")).toBe(true);
        expect(result.changes.map((change) => change.changeKind).sort()).toEqual([
            "file_content_replacement",
            "file_content_replacement",
            "file_content_replacement",
            "file_executable_replacement",
        ]);
        expect(
            result.changes.some(
                (change) =>
                    change.changeKind === "file_content_replacement" &&
                    change.replacementContent.contentKind === "text" &&
                    change.replacementContent.text === GRAPH_CHANGED_ENTRY_TEXT,
            ),
        ).toBe(true);
        expect(
            fixture.registry.validateOutputContractReverseInspection({
                contract: fixture.components.outputContracts[0]!,
                outputUnit: materialization.selection.outputUnits[0]!,
                appliedRenderSnapshot: fullExactGraphAppliedSnapshot(inspection.appliedRenderSnapshot),
                inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
                files: inspection.files,
                inventoryDeltas: inspection.inventoryDeltas,
                adapterResult: result,
            }),
        ).toMatchObject({ coveredChangeFingerprints: result.changes.map((change) => change.changeFingerprint).sort() });

        const added = structuredClone(inspection);
        const original = added.files[0]!;
        added.files = [
            {
                fileState: "added_managed_descendant",
                relativePath: `${GRAPH_BOUNDARY}/resources/new.txt`,
                currentContent: { contentKind: "text", text: "new\n" },
                diffHunks: [],
            },
        ];
        added.inspectionScope.fileStates.push({
            relativePath: `${GRAPH_BOUNDARY}/resources/new.txt`,
            state: "added",
            currentContentHash: GRAPH_HASH,
            currentExecutable: false,
            outputUnitFingerprint: materialization.selection.outputUnits[0]!.outputUnitFingerprint,
        });
        added.inventoryDeltas = [
            {
                inventoryDeltaFingerprint: GRAPH_HASH,
                outputUnitFingerprint: materialization.selection.outputUnits[0]!.outputUnitFingerprint,
                relativePath: `${GRAPH_BOUNDARY}/resources/new.txt`,
                deltaKind: "file_added",
                inventorySemanticRefFingerprint: inventoryRef(fixture),
            },
        ];
        expect(fixture.support.inspect(added).files).toMatchObject([{ attributionState: "conflict" }]);

        const missing = structuredClone(inspection);
        if (original.fileState !== "baseline_changed") throw new Error("graph changed file is missing");
        missing.files = [
            {
                fileState: "baseline_missing",
                relativePath: original.relativePath,
                appliedContent: original.appliedContent,
                currentContent: { contentKind: "missing" },
                diffHunks: [],
                provenance: original.provenance,
            },
        ];
        expect(fixture.support.inspect(missing).files).toMatchObject([{ attributionState: "conflict" }]);

        const header = structuredClone(inspection);
        const entry = header.files.find((file) => file.relativePath === GRAPH_ENTRY_PATH);
        if (entry?.fileState !== "baseline_changed" || entry.currentContent.contentKind !== "text") {
            throw new Error("graph entry fixture is missing");
        }
        entry.currentContent.text = entry.currentContent.text.replace("x-fixture-only: keep-me", "x-fixture-only: changed");
        expect(fixture.support.inspect(header).files).toContainEqual(
            expect.objectContaining({ relativePath: GRAPH_ENTRY_PATH, attributionState: "conflict" }),
        );
    });

    it("Core rejects a Provider graph that drops or corrupts a resource after rebase", async () => {
        const fixture = makeParentGraphRebaseFixture();
        const analysis = fixture.support.analyze(fixture.analysisInput);
        if (analysis.status !== "complete") throw new Error("graph analysis fixture failed");
        const providerSelection = exactGraphMaterializationInput(fixture).selection;
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
        const run = (forge: "none" | "drop" | "corrupt") =>
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
                        if (value.materializationState === "materialized" && forge === "drop") {
                            value.materializedUnits[0]!.files.pop();
                        }
                        if (value.materializationState === "materialized" && forge === "corrupt") {
                            const resource = value.materializedUnits[0]!.files.find(
                                (file) => file.relativePath === GRAPH_TEXT_RESOURCE_PATH,
                            );
                            if (resource !== undefined) resource.content = { contentKind: "text", text: "corrupt\n" };
                        }
                        return { status: "complete" as const, value, diagnostics: [] };
                    },
                },
            );
        expect((await run("none")).status).toBe("complete");
        expect((await run("drop")).status).toBe("failed");
        const corrupt = await run("corrupt");
        expect(corrupt.status).toBe("failed");
        expect(corrupt.diagnostics[0]?.code).toBe("render.native_consistency_failed");
        expect(corrupt.diagnostics[0]?.causeKind).toBe("verification_failed");
    });

    it("rejects malformed graph declarations and Provider ownership drift", () => {
        const fixture = makeExactGraphFixture();
        const provider = asExactGraphProvider(fixture);
        provider.dialectContracts.native = [];
        expect(validateAdapterRenderContractRegistration([provider])[0]?.code).toBe("adapter.render_contract_invalid");

        const parserMismatch = asExactGraphProvider(makeExactGraphFixture());
        parserMismatch.dialectContracts.native[0]!.definition.nativeToCanonicalParser = GRAPH_VALIDATOR_REF;
        expect(validateAdapterRenderContractRegistration([parserMismatch])[0]?.message).toMatch(/dialect parser/);

        const duplicate = asExactGraphProvider(makeExactGraphFixture());
        duplicate.renderContractDeclarations.push(structuredClone(duplicate.renderContractDeclarations[0]!));
        expect(validateAdapterRenderContractRegistration([duplicate])[0]?.message).toMatch(/duplicate native render/);

        const declaration = structuredClone(fixture.support.renderContractDeclaration);
        declaration.assetKind = "Guidance" as never;
        expect(() => makeNativeProjectExactGraphContractParts(declaration)).toThrow(/unsupported AssetKind/);

        expect(() =>
            createNativeProjectExactGraphProviderSupport({
                adapterId: "FIXTURE",
                adapterVersion: "0.1.0",
                agentRuntimes: [fixture.descriptor],
                agentRuntimeId: fixture.descriptor.agentRuntimeId,
                assetKind: "Skill",
                outputContractId: GRAPH_OUTPUT_CONTRACT_ID,
                materializationProfileId: GRAPH_PROFILE_ID,
                nativeDialectId: GRAPH_DIALECT_ID,
                projectGraphValidator: { ref: GRAPH_VALIDATOR_REF, project: undefined as never },
                reverseParser: { ref: GRAPH_PARSER_REF, parse: undefined as never },
                rebaseMaterializer: null,
                restorationDialectIds: [],
                target: fixture.support.renderContractDeclaration.target,
                verifiedBuilds: [fixture.build],
            }),
        ).toThrow(/Provider-owned graph and parser/);

        expect(() =>
            createVerifiedNativeProjectExactGraphBuild({
                ...fixture.build,
                fixtureId: "invalid-kind",
                assetKind: "Guidance" as never,
                nativeDialectId: GRAPH_DIALECT_ID,
                projectGraphValidator: GRAPH_VALIDATOR_REF,
                reverseParser: GRAPH_PARSER_REF,
                rebaseMaterializer: GRAPH_REBASE_REF,
                restorationDialectIds: [],
                parentRebaseFixtureId: "parent",
                targetGraphIdentity: GRAPH_ENTRY_PATH,
                targetRelativePaths: [GRAPH_ENTRY_PATH],
                exactLoadMarker: "marker",
                reverseFixtureId: "reverse",
            }),
        ).toThrow(/unsupported/);
    });
});

function inventoryRef(fixture: ReturnType<typeof makeExactGraphFixture>) {
    return fixture.requiredSemantics.find((semantic) => semantic.semanticKind === "asset.file_inventory")!.semanticRefFingerprint;
}
