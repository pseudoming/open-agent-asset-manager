/** Exact Core contract tests for the native project-Rule subset. */

import { describe, expect, it } from "vitest";
import type { RenderMaterializationInput } from "../../src/contracts/render";
import type { AdapterRenderedTargetInspectionResult, RenderedTargetInspectionInput } from "../../src/contracts/reverse";
import {
    computeAttributedSemanticChangeFingerprint,
    computeTargetApplicabilityFingerprint,
} from "../../src/foundation/fingerprint";
import { validateAdapterRenderContractRegistration } from "../../src/render/adapter-render-contract-registration";
import {
    createNativeProjectRuleProviderSupport,
    findNativeProjectRuleDeclaration,
    isNativeProjectRuleFileNameSuffix,
    isSafePortableRuleName,
    nativeProjectRuleNameFromRelativePath,
    nativeProjectRuleRegistryComponents,
    nativeProjectRuleRelativePath,
} from "../../src/render/native-project-rule";
import { makeRuleApplicabilityPredicate } from "../../src/render/native-project-rule-behavior";
import type { AdapterProvider } from "../../src/types";
import { ASSET_ID, VERSION_ID } from "../catalog/fixtures/version-v2";
import {
    changedRuleInspection,
    fullRuleAppliedSnapshot,
    makeRuleFixture,
    RULE_HASH,
    RULE_OUTPUT_CONTRACT_ID,
    RULE_PROFILE_ID,
    RULE_TEXT,
    ruleCanonicalValues,
    ruleMaterializationInput,
} from "./fixtures/native-project-rule-test-fixtures";

describe("native project Rule contract", () => {
    it("compiles one exact unconditional Rule and derives its safe native path", () => {
        const fixture = makeRuleFixture();
        const analysis = fixture.support.analyze(fixture.analysisInput);
        expect(analysis).toMatchObject({
            status: "complete",
            outputUnits: [{ claims: [{ relativePath: ".fixture/rules/typescript-review.md" }] }],
            semanticOptions: [
                { outcome: "preserved", actualReverseExtractPolicy: "can_reconcile" },
                { outcome: "preserved", actualReverseExtractPolicy: "can_reconcile" },
                { outcome: "preserved", actualReverseExtractPolicy: "can_reconcile" },
            ],
            blockedSemanticRefs: [],
        });
        expect(Object.isFrozen(fixture.support.renderContractDeclaration)).toBe(true);
        expect(findNativeProjectRuleDeclaration(fixture.provider, fixture.descriptor.agentRuntimeId)).toBe(
            fixture.support.renderContractDeclaration,
        );
        expect(() => findNativeProjectRuleDeclaration(fixture.provider, "FOREIGN")).toThrow(/exactly one/);
        expect(
            nativeProjectRuleRelativePath(
                {
                    materializationProfileId: RULE_PROFILE_ID,
                    agentRuntimeId: fixture.descriptor.agentRuntimeId,
                    relativeDirectory: ".fixture/rules",
                    fileNameSuffix: ".md",
                    targetContextSchemaId: "FIXTURE_CLI_PROJECT_TARGET_V1",
                    requiredFacts: {},
                },
                "Rule_7",
            ),
        ).toBe(".fixture/rules/Rule_7.md");
        expect(
            nativeProjectRuleNameFromRelativePath(fixture.support.renderContractDeclaration.target, ".fixture/rules/Rule_7.md"),
        ).toBe("Rule_7");
        expect(
            nativeProjectRuleNameFromRelativePath(fixture.support.renderContractDeclaration.target, ".fixture/Rule_7.md"),
        ).toBeNull();
        expect(
            nativeProjectRuleNameFromRelativePath(fixture.support.renderContractDeclaration.target, ".fixture/rules/bad name.md"),
        ).toBeNull();
        expect(isNativeProjectRuleFileNameSuffix(".md")).toBe(true);
        expect(isNativeProjectRuleFileNameSuffix(".markdown")).toBe(false);
        expect(["A", "a-b", "Rule_7", "x".repeat(120)].every(isSafePortableRuleName)).toBe(true);
        expect(["", "x".repeat(121), "bad name", "a/b", "a.b", "é"].every((name) => !isSafePortableRuleName(name))).toBe(true);
        expect(() => nativeProjectRuleRelativePath(fixture.support.renderContractDeclaration.target, "../escape")).toThrow(
            /safe portable filename/,
        );
    });

    it("admits materialization only for the exact verified build and facts", () => {
        const fixture = makeRuleFixture();
        const unit = fixture.support.analyze(fixture.analysisInput).outputUnits[0]!;
        const requirement = {
            context: fixture.targetContext,
            assetKind: "Rule" as const,
            renderStrategy: "native_file" as const,
        };
        expect(fixture.registry.findMaterializerCandidates(unit, [requirement])).toEqual([
            expect.objectContaining({ rendererAdapterId: "FIXTURE", materializationProfileId: RULE_PROFILE_ID }),
        ]);
        for (const mutate of [
            (context: typeof fixture.targetContext) => {
                context.versionText = "1.2.4";
            },
            (context: typeof fixture.targetContext) => {
                context.buildIdentity = `sha256:${"0".repeat(64)}`;
            },
            (context: typeof fixture.targetContext) => {
                context.renderFacts[0]!.value = "linux";
            },
            (context: typeof fixture.targetContext) => {
                context.renderFacts[0]!.evidenceLevel = "docs_declared";
            },
            (context: typeof fixture.targetContext) => {
                context.renderFacts[1]!.evidenceLevel = "docs_declared";
            },
        ]) {
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

    it("routes a newer Rule build through the Provider-owned nearest anchor and blocks older builds", () => {
        const fixture = makeRuleFixture();
        const support = createNativeProjectRuleProviderSupport({
            adapterId: "FIXTURE",
            adapterVersion: "0.1.0",
            agentRuntimes: [fixture.descriptor],
            agentRuntimeId: fixture.descriptor.agentRuntimeId,
            outputContractId: RULE_OUTPUT_CONTRACT_ID,
            materializationProfileId: RULE_PROFILE_ID,
            target: fixture.support.renderContractDeclaration.target,
            buildCompatibility: {
                schemaVersion: 1,
                versionOrdering: "numeric_dotted_core_v1",
                unknownVersionPolicy: "allow_with_warning",
                deniedBuilds: [],
            },
            verifiedBuilds: [fixture.build],
        });
        const predicate = makeRuleApplicabilityPredicate(support.renderContractDeclaration, fixture.build);
        expect(support.renderContractDeclaration.buildCompatibility).toEqual({
            schemaVersion: 1,
            versionOrdering: "numeric_dotted_core_v1",
            unknownVersionPolicy: "allow_with_warning",
            deniedBuilds: [],
        });
        const newer = structuredClone(fixture.targetContext);
        newer.versionText = "1.2.4";
        newer.buildIdentity = `sha256:${"4".repeat(64)}`;
        expect(predicate.evaluate(newer)).toBe(true);
        const older = structuredClone(fixture.targetContext);
        older.versionText = "1.2.2";
        older.buildIdentity = `sha256:${"2".repeat(64)}`;
        expect(predicate.evaluate(older)).toBe(false);
    });

    it("requires verified evidence for a non-project static Rule fact", () => {
        const fixture = makeRuleFixture();
        const support = createNativeProjectRuleProviderSupport({
            adapterId: "FIXTURE",
            adapterVersion: "0.1.0",
            agentRuntimes: [fixture.descriptor],
            agentRuntimeId: fixture.descriptor.agentRuntimeId,
            outputContractId: RULE_OUTPUT_CONTRACT_ID,
            materializationProfileId: RULE_PROFILE_ID,
            target: {
                relativeDirectory: ".fixture/rules",
                fileNameSuffix: ".md",
                targetContextSchemaId: "FIXTURE_CLI_PROJECT_TARGET_V1",
                requiredFacts: { "fixture.mode": "exact" },
            },
            verifiedBuilds: [fixture.build],
        });
        const predicate = makeRuleApplicabilityPredicate(support.renderContractDeclaration, fixture.build);
        const context = structuredClone(fixture.targetContext);
        context.renderFacts = [
            { key: "fixture.mode", value: "exact", evidenceLevel: "agent_runtime_verified" },
            { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
        ];
        expect(predicate.evaluate(context)).toBe(true);
        context.renderFacts[0]!.evidenceLevel = "docs_declared";
        expect(predicate.evaluate(context)).toBe(false);
    });

    it("supports one explicit sibling-runtime materializer key without changing the legacy default", () => {
        const fixture = makeRuleFixture();
        expect(fixture.support.materializerCapability.materializerCapabilityKey).toBe("fixture.project-rule-native-v1");
        const sibling = createNativeProjectRuleProviderSupport({
            adapterId: "FIXTURE",
            adapterVersion: "0.1.0",
            agentRuntimes: [fixture.descriptor],
            agentRuntimeId: fixture.descriptor.agentRuntimeId,
            outputContractId: "FIXTURE_SIBLING_NATIVE_PROJECT_RULE_V1",
            materializationProfileId: "fixture-sibling-project-rule-v1",
            materializerCapabilityKey: "fixture.sibling-project-rule-native-v1",
            target: fixture.support.renderContractDeclaration.target,
            verifiedBuilds: [
                {
                    ...fixture.build,
                    materializationProfileId: "fixture-sibling-project-rule-v1",
                },
            ],
        });
        expect(sibling.materializerCapability.materializerCapabilityKey).toBe("fixture.sibling-project-rule-native-v1");
        for (const materializerCapabilityKey of ["", " leading", "trailing ", "embedded\0nul"]) {
            expect(() =>
                createNativeProjectRuleProviderSupport({
                    adapterId: "FIXTURE",
                    adapterVersion: "0.1.0",
                    agentRuntimes: [fixture.descriptor],
                    agentRuntimeId: fixture.descriptor.agentRuntimeId,
                    outputContractId: "FIXTURE_INVALID_NATIVE_PROJECT_RULE_V1",
                    materializationProfileId: RULE_PROFILE_ID,
                    materializerCapabilityKey,
                    target: fixture.support.renderContractDeclaration.target,
                    verifiedBuilds: [fixture.build],
                }),
            ).toThrow(/canonical non-blank text/);
        }
    });

    it("rejects every excluded canonical Rule shape before producing an output unit", () => {
        const mutations: Array<(fixture: ReturnType<typeof makeRuleFixture>) => void> = [
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
                const canonical = fixture.analysisInput.deployment.assets[0]!.version.canonical;
                if (canonical.kind === "Rule") canonical.typeData.name = "bad name";
            },
            (fixture) => {
                const canonical = fixture.analysisInput.deployment.assets[0]!.version.canonical;
                if (canonical.kind === "Rule") canonical.typeData.description = "not natively represented";
            },
            (fixture) => {
                const canonical = fixture.analysisInput.deployment.assets[0]!.version.canonical;
                if (canonical.kind === "Rule") canonical.typeData.activation = { mode: "manual" };
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.files[0]!.file.references = [
                    { referenceKind: "asset_version", targetAssetVersionId: VERSION_ID },
                ];
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.files[0]!.file.executable = true;
            },
            (fixture) => {
                fixture.analysisInput.deployment.targetContexts.push(
                    structuredClone(fixture.analysisInput.deployment.targetContexts[0]!),
                );
            },
            (fixture) => {
                fixture.analysisInput.dialectInputs.push({
                    targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
                    inputs: [],
                });
            },
            (fixture) => {
                fixture.analysisInput.requiredSemantics.pop();
            },
            (fixture) => {
                fixture.analysisInput.deployment.assets[0]!.version.canonical = {
                    kind: "Guidance",
                    typeData: { schemaVersion: 1 },
                };
            },
        ];
        for (const mutate of mutations) {
            const fixture = makeRuleFixture();
            mutate(fixture);
            expect(fixture.support.analyze(fixture.analysisInput)).toMatchObject({
                status: "failed",
                outputUnits: [],
                semanticOptions: [],
            });
        }

        const partial = makeRuleFixture();
        partial.analysisInput.requiredSemantics.push({
            ...structuredClone(partial.analysisInput.requiredSemantics[0]!),
            consumerAgentRuntimeId: "FOREIGN",
            semanticRefFingerprint: RULE_HASH,
        });
        expect(partial.support.analyze(partial.analysisInput)).toMatchObject({
            status: "partial",
            outputUnits: [{ claims: [{ relativePath: ".fixture/rules/typescript-review.md" }] }],
            blockedSemanticRefs: [{ semanticRefFingerprint: RULE_HASH }],
            diagnostics: [{ code: "fixture_project_rule_target_blocked" }],
        });
    });

    it("materializes exact Markdown and validates all three canonical semantics", () => {
        const fixture = makeRuleFixture();
        const input = ruleMaterializationInput(fixture);
        const result = fixture.support.materialize(input);
        expect(result).toEqual({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    outputUnitFingerprint: input.selection.outputUnits[0]!.outputUnitFingerprint,
                    files: [
                        {
                            relativePath: ".fixture/rules/typescript-review.md",
                            content: { contentKind: "text", text: RULE_TEXT },
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
        if (result.materializationState !== "materialized") throw new Error("Rule materialization fixture failed");
        const contract = fixture.components.outputContracts[0]!;
        const profile = contract.materializationProfiles[0]!;
        const validatorInput = {
            contract,
            profile,
            outputUnit: input.selection.outputUnits[0]!,
            selectedSemantics: fixture.requiredSemantics,
            canonicalValues: ruleCanonicalValues(fixture),
            selectedOptions: input.selection.semanticOptions,
            files: result.materializedUnits[0]!.files,
        };
        expect(fixture.registry.validateOutputContractMaterialization(validatorInput)).toMatchObject({
            outputUnitFingerprint: input.selection.outputUnits[0]!.outputUnitFingerprint,
            coveredSemanticRefFingerprints: fixture.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint).sort(),
        });

        const wrongProfile = structuredClone(validatorInput);
        wrongProfile.profile.materializationProfileId = "wrong";
        expect(() => fixture.components.materializationValidators[0]!.validate(wrongProfile)).toThrow(/profile mismatch/);

        const invalidValidatorMutations: Array<(value: typeof validatorInput) => void> = [
            (value) => {
                value.files[0]!.content = { contentKind: "text", text: "# forged\n" };
            },
            (value) => {
                value.files[0]!.semanticRefFingerprints = [];
            },
            (value) => {
                value.canonicalValues.pop();
            },
            (value) => {
                value.selectedOptions[0]!.renderStrategy = "inline";
            },
            (value) => {
                value.outputUnit.claims[0]!.relativePath = ".fixture/rules/wrong.md";
            },
            (value) => {
                const activation = value.canonicalValues.find((candidate) => candidate.valueKind === "asset_type_data");
                if (activation?.valueKind === "asset_type_data" && activation.value.kind === "Rule") {
                    activation.value.typeData.description = "lost";
                }
            },
            (value) => {
                const content = value.canonicalValues.find((candidate) => candidate.valueKind === "file_content");
                if (content?.valueKind === "file_content") {
                    content.value = { contentKind: "binary", bytes: new Uint8Array([1]) };
                }
            },
            (value) => {
                value.selectedSemantics = value.selectedSemantics.filter(
                    (semantic) => semantic.semanticKind !== "asset.file_inventory",
                );
            },
            (value) => {
                value.selectedSemantics = value.selectedSemantics.filter(
                    (semantic) => semantic.semanticKind !== "rule.activation",
                );
            },
            (value) => {
                value.selectedSemantics = value.selectedSemantics.filter((semantic) => semantic.semanticKind !== "rule.content");
            },
            (value) => {
                const semantic = value.selectedSemantics.find((candidate) => candidate.semanticKind === "asset.file_inventory");
                value.canonicalValues = value.canonicalValues.filter(
                    (candidate) => candidate.semanticRefFingerprint !== semantic?.semanticRefFingerprint,
                );
            },
            (value) => {
                const semantic = value.selectedSemantics.find((candidate) => candidate.semanticKind === "rule.activation");
                value.canonicalValues = value.canonicalValues.filter(
                    (candidate) => candidate.semanticRefFingerprint !== semantic?.semanticRefFingerprint,
                );
            },
        ];
        for (const mutate of invalidValidatorMutations) {
            const value = structuredClone(validatorInput);
            mutate(value);
            expect(() => fixture.registry.validateOutputContractMaterialization(value)).toThrow(/violates its profile/);
        }

        const providerBound = structuredClone(input);
        providerBound.selection.semanticOptions[0]!.optionFingerprint = RULE_HASH;
        expect(fixture.support.materialize(providerBound)).toMatchObject({
            status: "complete",
            materializationState: "materialized",
        });

        const materializationMutations: Array<(value: RenderMaterializationInput) => void> = [
            (value) => {
                value.deployment.assets = [];
            },
            (value) => {
                value.selection.outputUnits = [];
            },
            (value) => {
                value.selection.outputUnitRenderers = [];
            },
            (value) => {
                value.selection.outputUnits[0]!.outputUnitFingerprint = RULE_HASH;
            },
            (value) => {
                value.selection.outputUnitRenderers[0]!.rendererAdapterId = "FOREIGN";
            },
            (value) => {
                value.selection.semanticOptions.pop();
            },
            (value) => {
                value.dialectInputs.push({ targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID }, inputs: [] });
            },
        ];
        for (const mutate of materializationMutations) {
            const value = structuredClone(input);
            mutate(value);
            expect(fixture.support.materialize(value)).toMatchObject({ status: "failed", materializationState: "blocked" });
        }
    });

    it("attributes only a normalized whole-file body replacement", () => {
        const fixture = makeRuleFixture();
        const materialization = ruleMaterializationInput(fixture);
        const inspection = changedRuleInspection(fixture, materialization);
        const result = fixture.support.inspect(inspection);
        expect(result).toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement" }],
            files: [{ attributionState: "uniquely_attributable" }],
        });
        expect(
            fixture.registry.validateOutputContractReverseInspection({
                contract: fixture.components.outputContracts[0]!,
                outputUnit: materialization.selection.outputUnits[0]!,
                appliedRenderSnapshot: fullRuleAppliedSnapshot(inspection.appliedRenderSnapshot),
                inspectionScopeFingerprint: inspection.inspectionScope.inspectionScopeFingerprint,
                files: inspection.files,
                inventoryDeltas: [],
                adapterResult: result,
            }).coveredChangeFingerprints,
        ).toHaveLength(1);

        for (const mutate of [
            (input: RenderedTargetInspectionInput) => {
                input.files[0]!.relativePath = ".fixture/rules/renamed.md";
            },
            (input: RenderedTargetInspectionInput) => {
                input.appliedRenderSnapshot.outputUnits = [];
            },
            (input: RenderedTargetInspectionInput) => {
                input.appliedRenderSnapshot.outputUnitRenderers = [];
            },
            (input: RenderedTargetInspectionInput) => {
                input.inventoryDeltas = [
                    {
                        inventoryDeltaFingerprint: RULE_HASH,
                        outputUnitFingerprint: materialization.selection.outputUnits[0]!.outputUnitFingerprint,
                        relativePath: ".fixture/rules/extra.md",
                        deltaKind: "file_added",
                        inventorySemanticRefFingerprint: RULE_HASH,
                    },
                ];
            },
            (input: RenderedTargetInspectionInput) => {
                input.inspectionScope.fileStates = [];
            },
        ]) {
            const input = structuredClone(inspection);
            mutate(input);
            expect(fixture.support.inspect(input)).toMatchObject({ status: "failed", changes: [], files: [] });
        }

        for (const mutate of [
            (input: RenderedTargetInspectionInput) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed") file.currentContent = { contentKind: "text", text: "# bad\r\n" };
            },
            (input: RenderedTargetInspectionInput) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed") {
                    file.attributeChanges = [
                        {
                            attributeChangeFingerprint: RULE_HASH,
                            attributeKind: "executable",
                            appliedValue: false,
                            currentValue: true,
                        },
                    ];
                }
            },
            (input: RenderedTargetInspectionInput) => {
                const file = input.files[0];
                if (file?.fileState === "baseline_changed") {
                    file.provenance.sectionBindings = [{ sectionHandle: "foreign", semanticRefFingerprints: [RULE_HASH] }];
                }
            },
        ]) {
            const input = structuredClone(inspection);
            mutate(input);
            expect(fixture.support.inspect(input).files[0]).toMatchObject({ attributionState: "conflict" });
        }

        const malformed = structuredClone(inspection) as unknown as { files: null };
        malformed.files = null;
        expect(fixture.support.inspect(malformed as unknown as RenderedTargetInspectionInput)).toMatchObject({
            status: "failed",
            files: [],
        });

        const conflictInspection = structuredClone(inspection);
        const conflictFile = conflictInspection.files[0];
        if (conflictFile?.fileState === "baseline_changed") {
            conflictFile.attributeChanges = [
                {
                    attributeChangeFingerprint: RULE_HASH,
                    attributeKind: "executable",
                    appliedValue: false,
                    currentValue: true,
                },
            ];
        }
        const conflictResult = fixture.support.inspect(conflictInspection);
        expect(conflictResult.files[0]).toMatchObject({ attributionState: "conflict" });
        expect(
            fixture.registry.validateOutputContractReverseInspection({
                contract: fixture.components.outputContracts[0]!,
                outputUnit: materialization.selection.outputUnits[0]!,
                appliedRenderSnapshot: fullRuleAppliedSnapshot(conflictInspection.appliedRenderSnapshot),
                inspectionScopeFingerprint: conflictInspection.inspectionScope.inspectionScopeFingerprint,
                files: conflictInspection.files,
                inventoryDeltas: [],
                adapterResult: conflictResult,
            }).coveredAttributeChangeFingerprints,
        ).toEqual([RULE_HASH]);

        const missingInspection = structuredClone(inspection);
        const changedFile = missingInspection.files[0];
        const changedState = missingInspection.inspectionScope.fileStates[0];
        if (changedFile?.fileState !== "baseline_changed" || changedState?.state !== "changed") {
            throw new Error("Rule missing-file fixture requires a changed baseline");
        }
        missingInspection.files = [
            {
                fileState: "baseline_missing",
                relativePath: changedFile.relativePath,
                appliedContent: changedFile.appliedContent,
                currentContent: { contentKind: "missing" },
                diffHunks: [],
                provenance: changedFile.provenance,
            },
        ];
        missingInspection.inspectionScope.fileStates = [
            {
                relativePath: changedState.relativePath,
                state: "missing",
                appliedContentHash: changedState.appliedContentHash,
                appliedExecutable: changedState.appliedExecutable,
                outputUnitFingerprint: changedState.outputUnitFingerprint,
                provenanceFingerprint: changedState.provenanceFingerprint,
            },
        ];
        const missingResult = fixture.support.inspect(missingInspection);
        expect(missingResult.files[0]).toMatchObject({ attributionState: "conflict" });
        expect(
            fixture.registry.validateOutputContractReverseInspection({
                contract: fixture.components.outputContracts[0]!,
                outputUnit: materialization.selection.outputUnits[0]!,
                appliedRenderSnapshot: fullRuleAppliedSnapshot(missingInspection.appliedRenderSnapshot),
                inspectionScopeFingerprint: missingInspection.inspectionScope.inspectionScopeFingerprint,
                files: missingInspection.files,
                inventoryDeltas: [],
                adapterResult: missingResult,
            }),
        ).toMatchObject({ coveredAttributeChangeFingerprints: [], coveredHunkFingerprints: [] });
    });

    it("rejects forged reverse receipts and malformed provider declarations", () => {
        const fixture = makeRuleFixture();
        const materialization = ruleMaterializationInput(fixture);
        const inspection = changedRuleInspection(fixture, materialization);
        const valid = fixture.support.inspect(inspection);
        const proofInput: Parameters<typeof fixture.registry.validateOutputContractReverseInspection>[0] = {
            contract: fixture.components.outputContracts[0]!,
            outputUnit: materialization.selection.outputUnits[0]!,
            appliedRenderSnapshot: fullRuleAppliedSnapshot(inspection.appliedRenderSnapshot),
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
            const input = structuredClone(proofInput);
            mutate(input.adapterResult);
            expect(() => fixture.registry.validateOutputContractReverseInspection(input)).toThrow(/whole-file policy/);
        }

        expect(validateAdapterRenderContractRegistration([asProvider(fixture)])).toEqual([]);
        for (const mutate of [
            (provider: AdapterProvider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_rule_v1") declaration.target.relativeDirectory = "../bad";
            },
            (provider: AdapterProvider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_rule_v1") declaration.target.fileNameSuffix = ".txt";
            },
            (provider: AdapterProvider) => {
                provider.renderContractDeclarations.push(structuredClone(provider.renderContractDeclarations[0]!));
            },
            (provider: AdapterProvider) => {
                provider.assetTargetCapabilities = [];
            },
            (provider: AdapterProvider) => {
                provider.materializerCapabilities = [];
            },
            (provider: AdapterProvider) => {
                provider.targetContextSchemas = [];
            },
            (provider: AdapterProvider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_rule_v1") {
                    declaration.target.requiredFacts["oaam.platform"] = "wsl";
                }
            },
            (provider: AdapterProvider) => {
                const declaration = provider.renderContractDeclarations[0];
                if (declaration?.declarationKind === "native_project_rule_v1") declaration.verifiedBuilds = [];
            },
        ]) {
            const provider = asProvider(makeRuleFixture());
            mutate(provider);
            expect(validateAdapterRenderContractRegistration([provider])[0]?.code).toBe("adapter.render_contract_invalid");
        }

        expect(() =>
            createNativeProjectRuleProviderSupport({
                adapterId: "FIXTURE",
                adapterVersion: "0.1.0",
                agentRuntimes: [fixture.descriptor],
                agentRuntimeId: fixture.descriptor.agentRuntimeId,
                outputContractId: RULE_OUTPUT_CONTRACT_ID,
                materializationProfileId: RULE_PROFILE_ID,
                target: {
                    ...fixture.support.renderContractDeclaration.target,
                    fileNameSuffix: ".txt",
                },
                verifiedBuilds: [fixture.build],
            }),
        ).toThrow(/Markdown filename suffix/);
        expect(() =>
            createNativeProjectRuleProviderSupport({
                adapterId: "FIXTURE",
                adapterVersion: "0.1.0",
                agentRuntimes: [],
                agentRuntimeId: fixture.descriptor.agentRuntimeId,
                outputContractId: RULE_OUTPUT_CONTRACT_ID,
                materializationProfileId: RULE_PROFILE_ID,
                target: fixture.support.renderContractDeclaration.target,
                verifiedBuilds: [fixture.build],
            }),
        ).toThrow(/unknown agent runtime/);
        expect(() =>
            createNativeProjectRuleProviderSupport({
                adapterId: "FIXTURE",
                adapterVersion: "0.1.0",
                agentRuntimes: [fixture.descriptor],
                agentRuntimeId: fixture.descriptor.agentRuntimeId,
                outputContractId: RULE_OUTPUT_CONTRACT_ID,
                materializationProfileId: RULE_PROFILE_ID,
                target: fixture.support.renderContractDeclaration.target,
                verifiedBuilds: [],
            }),
        ).toThrow(/verified builds/);
        expect(() =>
            createNativeProjectRuleProviderSupport({
                adapterId: "FIXTURE",
                adapterVersion: "0.1.0",
                agentRuntimes: [fixture.descriptor],
                agentRuntimeId: fixture.descriptor.agentRuntimeId,
                outputContractId: RULE_OUTPUT_CONTRACT_ID,
                materializationProfileId: RULE_PROFILE_ID,
                target: fixture.support.renderContractDeclaration.target,
                verifiedBuilds: [{ ...fixture.build, materializationProfileId: "foreign-profile" }],
            }),
        ).toThrow(/verified builds/);
        expect(() =>
            nativeProjectRuleRegistryComponents([
                {
                    ...fixture.provider,
                    targetContextSchemas: [],
                },
            ]),
        ).toThrow(/no provider schema/);
    });
});

function asProvider(fixture: ReturnType<typeof makeRuleFixture>): AdapterProvider {
    return {
        ...structuredClone(fixture.provider),
        dialectContracts: { native: [], restoration: [], portableEntries: [], portableSelectors: [] },
        probe: async () => {
            throw new Error("not called");
        },
        read: async () => {
            throw new Error("not called");
        },
        analyzeRender: async (input) => fixture.support.analyze(input),
        materializeRender: async (input) => fixture.support.materialize(input),
        inspectRenderedTarget: async (input) => fixture.support.inspect(input),
    };
}
