/** Exact Core contract tests for current-native project Rule/Workflow/Skill/Subagent/Memory Unit files. */

import { describe, expect, it } from "vitest";
import type { RenderMaterializationInput } from "../../src/contracts/render";
import type { RenderedTargetInspectionInput } from "../../src/contracts/reverse";
import { validateAdapterRenderContractRegistration } from "../../src/render/adapter-render-contract-registration";
import {
    createNativeProjectExactFileProviderSupport,
    findNativeProjectExactFileDeclaration,
    isNativeProjectExactFileAssetKind,
} from "../../src/render/native-project-exact-file";
import { computeTargetApplicabilityFingerprint } from "../../src/foundation/fingerprint";
import { binaryPayloadStats } from "../../src/catalog/payload-store";
import { ASSET_ID, VERSION_ID } from "../catalog/fixtures/version-v2";
import {
    EXACT_CHANGED_NATIVE_TEXT,
    EXACT_DIALECT_ID,
    EXACT_ENTRY_TEXT,
    EXACT_HASH,
    EXACT_NATIVE_TEXT,
    EXACT_OUTPUT_CONTRACT_ID,
    EXACT_PARSER_REF,
    EXACT_PATH_REF,
    EXACT_PROFILE_ID,
    EXACT_TARGET_PATH,
    MEMORY_EXACT_CHANGED_ENTRY_TEXT,
    MEMORY_EXACT_NATIVE_TEXT,
    MEMORY_EXACT_REBASED_NATIVE_TEXT,
    MEMORY_EXACT_TARGET_PATH,
    RULE_EXACT_CHANGED_ENTRY_TEXT,
    RULE_EXACT_CHANGED_NATIVE_TEXT,
    RULE_EXACT_NATIVE_TEXT,
    RULE_EXACT_REBASED_NATIVE_TEXT,
    RULE_EXACT_TARGET_PATH,
    asExactFileProvider,
    changedExactFileInspection,
    exactCanonicalValues,
    exactMaterializationInput,
    fullExactFileAppliedSnapshot,
    makeExactFileFixture,
    makeParentRebaseFixture,
} from "./fixtures/native-project-exact-file-test-fixtures";

describe("native project exact-file contract", () => {
    it("registers one immutable Skill cell and emits the exact current native file", () => {
        const fixture = makeExactFileFixture();
        expect(validateAdapterRenderContractRegistration([asExactFileProvider(fixture)])).toEqual([]);
        expect(Object.isFrozen(fixture.support.renderContractDeclaration)).toBe(true);
        expect(findNativeProjectExactFileDeclaration(fixture.provider, fixture.descriptor.agentRuntimeId, "Skill")).toBe(
            fixture.support.renderContractDeclaration,
        );
        expect(() =>
            findNativeProjectExactFileDeclaration(fixture.provider, fixture.descriptor.agentRuntimeId, "Workflow"),
        ).toThrow(/requires one/);
        expect(["Rule", "Workflow", "Skill", "Subagent", "Memory"].every(isNativeProjectExactFileAssetKind)).toBe(true);
        expect(isNativeProjectExactFileAssetKind("Guidance")).toBe(false);

        const analysis = fixture.support.analyze(fixture.analysisInput);
        expect(analysis).toMatchObject({
            status: "complete",
            outputUnits: [{ claims: [{ relativePath: EXACT_TARGET_PATH }] }],
            blockedSemanticRefs: [],
        });
        expect(analysis.semanticOptions).toHaveLength(fixture.requiredSemantics.length);
        expect(
            analysis.semanticOptions.every(
                (option) =>
                    option.outcome === "preserved" &&
                    option.renderStrategy === "native_file" &&
                    option.actualReverseExtractPolicy === "can_reconcile",
            ),
        ).toBe(true);

        const materialization = exactMaterializationInput(fixture);
        expect(fixture.support.materialize(materialization)).toEqual({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    outputUnitFingerprint: materialization.selection.outputUnits[0]!.outputUnitFingerprint,
                    files: [
                        {
                            relativePath: EXACT_TARGET_PATH,
                            content: { contentKind: "text", text: EXACT_NATIVE_TEXT },
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
    });

    it("accepts only complete Memory Units and preserves their native topic through rebase and reverse", () => {
        const current = makeExactFileFixture({ assetKind: "Memory", targetKind: "directory" });
        expect(validateAdapterRenderContractRegistration([asExactFileProvider(current)])).toEqual([]);
        expect(findNativeProjectExactFileDeclaration(current.provider, current.descriptor.agentRuntimeId, "Memory")).toBe(
            current.support.renderContractDeclaration,
        );
        expect(current.requiredSemantics.map((semantic) => semantic.semanticKind).sort()).toEqual([
            "asset.file_inventory",
            "memory.content",
            "memory.support",
        ]);

        const materialization = exactMaterializationInput(current);
        expect(current.support.materialize(materialization)).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                { files: [{ relativePath: MEMORY_EXACT_TARGET_PATH, content: { text: MEMORY_EXACT_NATIVE_TEXT } }] },
            ],
        });
        expect(current.support.inspect(changedExactFileInspection(current, materialization))).toMatchObject({
            status: "complete",
            changes: [
                {
                    changeKind: "file_content_replacement",
                    replacementContent: { contentKind: "text", text: MEMORY_EXACT_CHANGED_ENTRY_TEXT },
                },
            ],
            files: [{ attributionState: "uniquely_attributable" }],
        });

        const parent = makeParentRebaseFixture({ assetKind: "Memory", targetKind: "directory" });
        expect(parent.support.materialize(exactMaterializationInput(parent))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ content: { contentKind: "text", text: MEMORY_EXACT_REBASED_NATIVE_TEXT } }] }],
        });

        const catalog = makeExactFileFixture({ assetKind: "Memory", targetKind: "directory" });
        catalog.analysisInput.deployment.assets[0]!.version.canonical = {
            kind: "Memory",
            typeData: { schemaVersion: 2, entityRole: "catalog", members: [] },
        };
        expect(catalog.support.analyze(catalog.analysisInput)).toMatchObject({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
        });
    });

    it("preserves one exact Rule wrapper across current bytes, parent rebase and body-only reverse", () => {
        const current = makeExactFileFixture({ assetKind: "Rule" });
        expect(validateAdapterRenderContractRegistration([asExactFileProvider(current)])).toEqual([]);
        expect(findNativeProjectExactFileDeclaration(current.provider, current.descriptor.agentRuntimeId, "Rule")).toBe(
            current.support.renderContractDeclaration,
        );
        expect(current.requiredSemantics.map((semantic) => semantic.semanticKind).sort()).toEqual([
            "asset.file_inventory",
            "rule.activation",
            "rule.content",
        ]);

        const currentMaterialization = exactMaterializationInput(current);
        expect(current.support.materialize(currentMaterialization)).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: RULE_EXACT_TARGET_PATH, content: { text: RULE_EXACT_NATIVE_TEXT } }] }],
        });
        const currentResult = current.support.materialize(currentMaterialization);
        if (currentResult.materializationState !== "materialized") throw new Error("Rule exact-file fixture did not materialize");
        expect(
            current.registry.validateOutputContractMaterialization({
                contract: current.components.outputContracts[0]!,
                profile: current.components.outputContracts[0]!.materializationProfiles[0]!,
                outputUnit: currentMaterialization.selection.outputUnits[0]!,
                selectedSemantics: current.requiredSemantics,
                canonicalValues: exactCanonicalValues(current),
                selectedOptions: currentMaterialization.selection.semanticOptions,
                dialectInputs: currentMaterialization.dialectInputs,
                files: currentResult.materializedUnits[0]!.files,
            }),
        ).toMatchObject({
            coveredSemanticRefFingerprints: current.requiredSemantics.map((item) => item.semanticRefFingerprint).sort(),
        });

        const inspection = changedExactFileInspection(current, currentMaterialization);
        const reverse = current.support.inspect(inspection);
        expect(reverse).toMatchObject({
            status: "complete",
            changes: [
                {
                    changeKind: "file_content_replacement",
                    replacementContent: { contentKind: "text", text: RULE_EXACT_CHANGED_ENTRY_TEXT },
                },
            ],
            files: [{ attributionState: "uniquely_attributable" }],
        });
        const wrapperChanged = structuredClone(inspection);
        const changed = wrapperChanged.files[0];
        if (changed?.fileState !== "baseline_changed" || changed.currentContent.contentKind !== "text") {
            throw new Error("Rule reverse fixture did not contain one changed text file");
        }
        changed.currentContent.text = RULE_EXACT_CHANGED_NATIVE_TEXT.replace("trigger: always_on", "trigger: model_decision");
        expect(current.support.inspect(wrapperChanged).files).toMatchObject([{ attributionState: "conflict" }]);

        const parent = makeParentRebaseFixture({ assetKind: "Rule" });
        expect(parent.support.materialize(exactMaterializationInput(parent))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ content: { contentKind: "text", text: RULE_EXACT_REBASED_NATIVE_TEXT } }] }],
        });
    });

    it("admits materialization only for the exact build, platform and project fact", () => {
        const fixture = makeExactFileFixture();
        const unit = fixture.support.analyze(fixture.analysisInput).outputUnits[0]!;
        const requirement = {
            context: fixture.targetContext,
            assetKind: "Skill" as const,
            renderStrategy: "native_file" as const,
        };
        expect(fixture.registry.findMaterializerCandidates(unit, [requirement])).toHaveLength(1);
        const mutations: Array<(context: typeof fixture.targetContext) => void> = [
            (context) => {
                context.agentRuntimeId = "FOREIGN";
            },
            (context) => {
                context.versionText = "1.2.4";
            },
            (context) => {
                context.buildIdentity = `sha256:${"0".repeat(64)}`;
            },
            (context) => {
                context.renderFacts[0]!.value = "linux";
            },
            (context) => {
                context.renderFacts[0]!.evidenceLevel = "docs_declared";
            },
            (context) => {
                context.renderFacts[1]!.evidenceLevel = "docs_declared";
            },
            (context) => {
                context.renderFacts[1]!.value = "foreign";
            },
        ];
        for (const mutate of mutations) {
            const context = structuredClone(fixture.targetContext);
            mutate(context);
            context.targetApplicabilityFingerprint = computeTargetApplicabilityFingerprint({
                context: {
                    schemaVersion: context.schemaVersion,
                    agentRuntimeId: context.agentRuntimeId,
                    versionText: context.versionText,
                    buildIdentity: context.buildIdentity,
                    targetContextSchemaId: context.targetContextSchemaId,
                    targetContextSchemaFingerprint: context.targetContextSchemaFingerprint,
                    renderFacts: context.renderFacts,
                },
                entryClass: fixture.descriptor.entryClass,
            });
            expect(fixture.registry.findMaterializerCandidates(unit, [{ ...requirement, context }])).toEqual([]);
        }
    });

    it("accepts target-kind only from trusted physical target evidence", () => {
        for (const evidenceLevel of ["agent_runtime_verified", "local_artifact", "user_provided"] as const) {
            const fixture = makeExactFileFixture({ targetKind: "directory", targetKindEvidenceLevel: evidenceLevel });
            const unit = fixture.support.analyze(fixture.analysisInput).outputUnits[0]!;
            expect(
                fixture.registry.findMaterializerCandidates(unit, [
                    { context: fixture.targetContext, assetKind: "Skill", renderStrategy: "native_file" },
                ]),
            ).toHaveLength(1);
        }
        for (const evidenceLevel of ["source_code", "docs_declared", "agent_answer"] as const) {
            const fixture = makeExactFileFixture({ targetKind: "directory", targetKindEvidenceLevel: evidenceLevel });
            const unit = fixture.support.analyze(fixture.analysisInput).outputUnits[0]!;
            expect(
                fixture.registry.findMaterializerCandidates(unit, [
                    { context: fixture.targetContext, assetKind: "Skill", renderStrategy: "native_file" },
                ]),
            ).toEqual([]);
        }
    });

    it("rejects every excluded Asset or native-input shape before analysis", () => {
        const mutations: Array<(fixture: ReturnType<typeof makeExactFileFixture>) => void> = [
            (fixture) => {
                fixture.analysisInput.deployment.assets.push(structuredClone(fixture.analysisInput.deployment.assets[0]!));
            },
            (fixture) => {
                fixture.analysisInput.deployment.targetContexts.push(
                    structuredClone(fixture.analysisInput.deployment.targetContexts[0]!),
                );
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.scope = "global";
                fixture.analysisInput.deployment.assets[0]!.projectId = "";
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.scopePath = "nested";
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.status = "incomplete";
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.files.push(
                    structuredClone(fixture.analysisInput.deployment.assets[0]!.version.files[0]!),
                );
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.files[0]!.file.role = "resource";
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.files[0]!.file.executable = true;
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.files[0]!.file.references = [
                    { referenceKind: "asset_version", targetAssetVersionId: VERSION_ID },
                ];
            },
            (fixture) => {
                const file = fixture.analysisInput.deployment.assets[0]!.version.files[0]!;
                if (file.contentKind === "text") file.text = "# bad\r\n";
            },
            (fixture) => {
                const file = fixture.analysisInput.deployment.assets[0]!.version.files[0]!;
                if (file.contentKind === "text") file.text = " ";
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.canonical = {
                    kind: "Guidance",
                    typeData: { schemaVersion: 1 },
                };
            },
            (fixture) => {
                fixture.analysisInput.dialectInputs = [];
            },
            (fixture) => {
                fixture.analysisInput.dialectInputs.push(structuredClone(fixture.analysisInput.dialectInputs[0]!));
            },
            (fixture) => {
                fixture.analysisInput.dialectInputs[0]!.targetVersion.versionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
            },
            (fixture) => {
                fixture.analysisInput.dialectInputs[0]!.inputs = [];
            },
            (fixture) => {
                fixture.analysisInput.dialectInputs[0]!.inputs.push(
                    structuredClone(fixture.analysisInput.dialectInputs[0]!.inputs[0]!),
                );
            },
            (fixture) => {
                const input = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
                if (input.inputKind === "native_representation") input.inputRole = "parent_rebase_seed" as never;
            },
            (fixture) => {
                const input = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
                if (input.inputKind === "native_representation") input.representation.dialectId = "foreign-v1";
            },
            (fixture) => {
                const input = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
                if (input.inputKind === "native_representation") input.files.push(structuredClone(input.files[0]!));
            },
            (fixture) => {
                const input = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
                if (input.inputKind === "native_representation") input.files[0]!.executable = true;
            },
            (fixture) => {
                const input = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
                if (input.inputKind === "native_representation") input.files[0]!.relativePath = "wrong/SKILL.md";
            },
            (fixture) => {
                const input = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
                if (input.inputKind === "native_representation" && input.files[0]?.contentKind === "text") {
                    input.files[0].text = "# bad\r\n";
                }
            },
            (fixture) => {
                fixture.analysisInput.requiredSemantics.pop();
            },
        ];
        for (const mutate of mutations) {
            const fixture = makeExactFileFixture();
            mutate(fixture);
            expect(fixture.support.analyze(fixture.analysisInput)).toMatchObject({
                status: "failed",
                outputUnits: [],
                semanticOptions: [],
            });
        }

        const partial = makeExactFileFixture();
        partial.analysisInput.requiredSemantics.push({
            ...structuredClone(partial.requiredSemantics[0]!),
            consumerAgentRuntimeId: "FOREIGN",
            semanticRefFingerprint: EXACT_HASH,
        });
        expect(partial.support.analyze(partial.analysisInput)).toMatchObject({
            status: "partial",
            outputUnits: [{ claims: [{ relativePath: EXACT_TARGET_PATH }] }],
            blockedSemanticRefs: [{ semanticRefFingerprint: EXACT_HASH }],
        });
    });

    it("rejects stale or forged materialization selection while preserving native frontmatter", () => {
        const fixture = makeExactFileFixture();
        const valid = exactMaterializationInput(fixture);
        const providerBound = structuredClone(valid);
        providerBound.selection.semanticOptions[0]!.optionFingerprint = EXACT_HASH;
        expect(fixture.support.materialize(providerBound)).toMatchObject({
            status: "complete",
            materializationState: "materialized",
        });
        const mutations: Array<(input: RenderMaterializationInput) => void> = [
            (input) => {
                input.selection.outputUnits = [];
            },
            (input) => {
                input.selection.outputUnitRenderers = [];
            },
            (input) => {
                input.selection.outputUnits[0]!.claims[0]!.relativePath = "wrong/SKILL.md";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.rendererAdapterId = "FOREIGN";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.rendererAdapterVersion = "9.9.9";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.materializerCapabilityKey = "wrong";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.materializationProfileId = "wrong";
            },
            (input) => {
                input.selection.outputUnitRenderers[0]!.profileConstraintFingerprint = EXACT_HASH;
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
                input.selection.semanticOptions[0]!.actualReverseExtractPolicy = "unsupported";
            },
            (input) => {
                input.selection.semanticOptions[0]!.requiredOutputUnitFingerprints = [];
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
            expect(fixture.support.materialize(input)).toMatchObject({
                status: "failed",
                materializationState: "blocked",
            });
        }
    });

    it("proves exact native bytes against canonical semantics and the operation-local dialect input", () => {
        const fixture = makeExactFileFixture();
        const input = exactMaterializationInput(fixture);
        const result = fixture.support.materialize(input);
        if (result.materializationState !== "materialized") throw new Error("exact materialization fixture failed");
        const contract = fixture.components.outputContracts[0]!;
        const profile = contract.materializationProfiles.find(
            (candidate) => candidate.materializationProfileId === EXACT_PROFILE_ID,
        )!;
        const validatorInput = {
            contract,
            profile,
            outputUnit: input.selection.outputUnits[0]!,
            selectedSemantics: fixture.requiredSemantics,
            canonicalValues: exactCanonicalValues(fixture),
            selectedOptions: input.selection.semanticOptions,
            dialectInputs: input.dialectInputs,
            files: result.materializedUnits[0]!.files,
        };
        expect(fixture.registry.validateOutputContractMaterialization(validatorInput)).toMatchObject({
            outputUnitFingerprint: input.selection.outputUnits[0]!.outputUnitFingerprint,
            coveredSemanticRefFingerprints: fixture.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint).sort(),
        });

        const mutations: Array<(value: typeof validatorInput) => void> = [
            (value) => {
                value.profile.materializationProfileId = "wrong";
            },
            (value) => {
                value.selectedSemantics.pop();
            },
            (value) => {
                value.selectedSemantics = value.selectedSemantics.filter(
                    (semantic) => semantic.semanticKind !== "asset.file_inventory",
                );
            },
            (value) => {
                value.selectedSemantics = value.selectedSemantics.filter((semantic) => semantic.semanticKind !== "skill.body");
            },
            (value) => {
                value.canonicalValues.pop();
            },
            (value) => {
                const item = value.canonicalValues.find((candidate) => candidate.valueKind === "file_inventory");
                if (item?.valueKind === "file_inventory") item.value = [];
            },
            (value) => {
                const item = value.canonicalValues.find((candidate) => candidate.valueKind === "file_content");
                if (item?.valueKind === "file_content") item.value = { contentKind: "text", text: "" };
            },
            (value) => {
                const item = value.canonicalValues.find((candidate) => candidate.valueKind === "asset_type_data");
                if (item?.valueKind === "asset_type_data") item.value = { kind: "Guidance", typeData: { schemaVersion: 1 } };
            },
            (value) => {
                value.dialectInputs = [];
            },
            (value) => {
                const bytes = Uint8Array.of(9);
                value.dialectInputs[0]!.inputs.push({
                    inputKind: "dialect_restoration",
                    restoration: {
                        dialectId: "undeclared-restoration-v1",
                        restorationContractFingerprint: EXACT_HASH,
                        contentHash: binaryPayloadStats(bytes).contentHash,
                    },
                    content: { contentKind: "binary", bytes },
                });
            },
            (value) => {
                const native = value.dialectInputs[0]!.inputs[0]!;
                if (native.inputKind === "native_representation" && native.files[0]?.contentKind === "text") {
                    native.files[0].text = "forged";
                }
            },
            (value) => {
                value.files[0]!.content = { contentKind: "text", text: EXACT_ENTRY_TEXT };
            },
            (value) => {
                value.files[0]!.semanticRefFingerprints = [];
            },
            (value) => {
                value.selectedOptions[0]!.outcome = "degraded";
            },
        ];
        for (const mutate of mutations) {
            const value = structuredClone(validatorInput);
            mutate(value);
            expect(() => fixture.registry.validateOutputContractMaterialization(value)).toThrow(
                /materialization validator|violates its profile/,
            );
        }
    });

    it("attributes one provider-parsed body replacement and rejects unsafe target drift", () => {
        const fixture = makeExactFileFixture();
        const materialization = exactMaterializationInput(fixture);
        const inspection = changedExactFileInspection(fixture, materialization);
        const result = fixture.support.inspect(inspection);
        expect(result).toMatchObject({
            status: "complete",
            changes: [
                {
                    changeKind: "file_content_replacement",
                    replacementContent: { contentKind: "text", text: "# Review\nReview the change and its tests.\n" },
                },
            ],
            files: [{ attributionState: "uniquely_attributable" }],
        });
        expect(
            fixture.registry.validateOutputContractReverseInspection({
                contract: fixture.components.outputContracts[0]!,
                outputUnit: materialization.selection.outputUnits[0]!,
                appliedRenderSnapshot: fullExactFileAppliedSnapshot(inspection.appliedRenderSnapshot),
                inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
                files: inspection.files,
                inventoryDeltas: [],
                adapterResult: result,
            }),
        ).toMatchObject({ coveredChangeFingerprints: [result.changes[0]!.changeFingerprint] });

        const unchanged = structuredClone(inspection);
        unchanged.files = [];
        unchanged.inspectionScope.fileStates[0]!.state = "unchanged";
        expect(fixture.support.inspect(unchanged)).toEqual({ status: "complete", changes: [], files: [], diagnostics: [] });

        const conflicts: Array<(input: RenderedTargetInspectionInput) => void> = [
            (input) => {
                input.inventoryDeltas.push({} as never);
            },
            (input) => {
                input.files[0]!.relativePath = "wrong/SKILL.md";
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed") file.currentContent = { contentKind: "text", text: "bad" };
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed") file.currentContent = { contentKind: "text", text: "# bad\r\n" };
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed" && file.currentContent.contentKind === "text") {
                    file.currentContent.text = file.currentContent.text.replace(
                        "description: Review changes",
                        "description: Changed outside the canonical body",
                    );
                }
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed") {
                    file.attributeChanges = [
                        {
                            attributeChangeFingerprint: EXACT_HASH,
                            attributeKind: "executable",
                            appliedValue: false,
                            currentValue: true,
                        },
                    ];
                }
            },
            (input) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed") {
                    file.provenance.sectionBindings = [{ sectionHandle: "generated", semanticRefFingerprints: [EXACT_HASH] }];
                }
            },
            (input) => {
                input.appliedRenderSnapshot.decisions = input.appliedRenderSnapshot.decisions.filter(
                    (decision) => decision.semanticRef.semanticKind !== "skill.body",
                );
            },
        ];
        for (const mutate of conflicts) {
            const input = structuredClone(inspection);
            mutate(input);
            const value = fixture.support.inspect(input);
            expect(value.status === "failed" || value.files[0]?.attributionState === "conflict").toBe(true);
        }

        const missing = structuredClone(inspection);
        const changed = missing.files[0]!;
        if (changed.fileState !== "baseline_changed") throw new Error("changed fixture missing");
        missing.files = [
            {
                fileState: "baseline_missing",
                relativePath: changed.relativePath,
                appliedContent: changed.appliedContent,
                currentContent: { contentKind: "missing" },
                diffHunks: [],
                provenance: changed.provenance,
            },
        ];
        const missingResult = fixture.support.inspect(missing);
        expect(missingResult.files).toMatchObject([{ attributionState: "conflict" }]);
        expect(
            fixture.registry.validateOutputContractReverseInspection({
                contract: fixture.components.outputContracts[0]!,
                outputUnit: materialization.selection.outputUnits[0]!,
                appliedRenderSnapshot: fullExactFileAppliedSnapshot(missing.appliedRenderSnapshot),
                inspectionScopeFingerprint: missing.inspectionScope.inspectionScopeFingerprint,
                files: missing.files,
                inventoryDeltas: [],
                adapterResult: missingResult,
            }),
        ).toMatchObject({ coveredChangeFingerprints: [] });

        const attributeConflict = structuredClone(inspection);
        const attributeFile = attributeConflict.files[0];
        if (attributeFile?.fileState !== "baseline_changed") throw new Error("changed fixture missing");
        attributeFile.attributeChanges = [
            {
                attributeChangeFingerprint: EXACT_HASH,
                attributeKind: "executable",
                appliedValue: false,
                currentValue: true,
            },
        ];
        const conflictResult = {
            status: "failed" as const,
            changes: [],
            files: [
                {
                    relativePath: EXACT_TARGET_PATH,
                    attributionState: "conflict" as const,
                    reasonCode: "fixture_conflict",
                    diagnostics: [],
                },
            ],
            diagnostics: [],
        };
        expect(
            fixture.registry.validateOutputContractReverseInspection({
                contract: fixture.components.outputContracts[0]!,
                outputUnit: materialization.selection.outputUnits[0]!,
                appliedRenderSnapshot: fullExactFileAppliedSnapshot(attributeConflict.appliedRenderSnapshot),
                inspectionScopeFingerprint: attributeConflict.inspectionScope.inspectionScopeFingerprint,
                files: attributeConflict.files,
                inventoryDeltas: [],
                adapterResult: conflictResult,
            }),
        ).toMatchObject({ coveredAttributeChangeFingerprints: [EXACT_HASH] });

        expect(
            fixture.registry.validateOutputContractReverseInspection({
                contract: fixture.components.outputContracts[0]!,
                outputUnit: materialization.selection.outputUnits[0]!,
                appliedRenderSnapshot: fullExactFileAppliedSnapshot(inspection.appliedRenderSnapshot),
                inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
                files: inspection.files,
                inventoryDeltas: [],
                adapterResult: conflictResult,
            }),
        ).toMatchObject({ coveredChangeFingerprints: [] });

        const missingScope = structuredClone(inspection);
        missingScope.inspectionScope.fileStates = [];
        expect(fixture.support.inspect(missingScope).status).toBe("failed");

        const malformed = structuredClone(inspection);
        malformed.files = null as never;
        expect(fixture.support.inspect(malformed).status).toBe("failed");

        const throwingPath = exactSupportWith(fixture, {
            validate: () => {
                throw new Error("fixture path validator failure");
            },
        });
        expect(throwingPath.analyze(fixture.analysisInput).status).toBe("failed");

        const throwingParser = exactSupportWith(fixture, {
            parse: () => {
                throw new Error("fixture reverse parser failure");
            },
        });
        expect(throwingParser.inspect(inspection).files).toMatchObject([{ attributionState: "conflict" }]);

        const badResult = structuredClone(result);
        if (badResult.files[0]?.attributionState === "uniquely_attributable") {
            badResult.files[0].hunkAttributions = [];
        }
        expect(() =>
            fixture.registry.validateOutputContractReverseInspection({
                contract: fixture.components.outputContracts[0]!,
                outputUnit: materialization.selection.outputUnits[0]!,
                appliedRenderSnapshot: fullExactFileAppliedSnapshot(inspection.appliedRenderSnapshot),
                inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
                files: inspection.files,
                inventoryDeltas: [],
                adapterResult: badResult,
            }),
        ).toThrow(/violates its policy/);
    });
});

function exactSupportWith(
    fixture: ReturnType<typeof makeExactFileFixture>,
    overrides: {
        validate?: (relativePath: typeof EXACT_TARGET_PATH) => boolean;
        parse?: () => { canonicalEntryText: string } | null;
    },
) {
    return createNativeProjectExactFileProviderSupport({
        adapterId: "FIXTURE",
        adapterVersion: "0.1.0",
        agentRuntimes: [fixture.descriptor],
        agentRuntimeId: fixture.descriptor.agentRuntimeId,
        assetKind: "Skill",
        outputContractId: EXACT_OUTPUT_CONTRACT_ID,
        materializationProfileId: EXACT_PROFILE_ID,
        nativeDialectId: EXACT_DIALECT_ID,
        projectPathValidator: { ref: EXACT_PATH_REF, validate: overrides.validate ?? (() => true) },
        reverseParser: {
            ref: EXACT_PARSER_REF,
            parse: overrides.parse ?? (() => ({ canonicalEntryText: EXACT_ENTRY_TEXT })),
        },
        rebaseMaterializer: fixture.rebaseMaterializer,
        restorationDialectIds: [],
        target: fixture.support.renderContractDeclaration.target,
        verifiedBuilds: [fixture.build],
    });
}
