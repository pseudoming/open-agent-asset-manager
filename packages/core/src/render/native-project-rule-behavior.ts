/** Native project-Rule analysis, materialization, and reverse inspection behavior. */

import { normalizeText, textPayloadStats } from "../catalog/payload-store";
import type {
    AdapterRenderAnalysisResult,
    OutputContractDefinitionV1,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderMaterializationResult,
    SemanticRenderOption,
} from "../contracts/render";
import type {
    AdapterRenderedTargetInspectionResult,
    AttributedSemanticChange,
    RenderedFileAttributionResult,
    RenderedTargetInspectionInput,
} from "../contracts/reverse";
import type {
    AdapterAssetTargetCapabilityAvailable,
    AdapterMaterializerCapability,
    AdapterNativeRuleRenderDeclarationV1,
    AdapterProviderSummary,
    AgentRuntimeDescriptor,
    MaterializationProfileId,
    MaterializerCapabilityKey,
} from "../contracts/source-import";
import type { AdapterTargetBuildCompatibilityPolicyV1 } from "../contracts/target-build-compatibility";
import { deepFreezeChildrenFirst } from "../foundation/deep-freeze";
import {
    computeAttributedSemanticChangeFingerprint,
    computeProviderRenderDialectInputFingerprint,
    computeRenderOptionFingerprint,
    computeReverseInspectionCoverageFingerprint,
    computeSemanticCoverageFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import type { AdapterId, AgentRuntimeId, OperationDiagnostic, Sha256Digest } from "../types";
import { compareUtf8Bytes, makeTargetContextSchema } from "./native-project-guidance-profiles";
import { makeRuleApplicabilityPredicate } from "./native-project-rule-applicability";
import {
    isNativeProjectRuleFileNameSuffix,
    makeNativeProjectRuleContractParts,
    makeRuleConsumerConformance,
    type NativeProjectRuleProfileDefinition,
    type NativeProjectRuleTargetDeclaration,
    nativeProjectRuleNameFromRelativePath,
    nativeProjectRuleRelativePath,
    type VerifiedNativeGlobalRuleBuild,
    type VerifiedNativeProjectRuleBuild,
    type VerifiedNativeRuleBuild,
} from "./native-project-rule-profiles";
import {
    blockedRuleAnalysis,
    blockedRuleInspection,
    blockedRuleMaterialization,
    findExactRuleAsset,
    hasExactRuleSemanticClosure,
    isExactRuleSemantic,
    makeRuleOutputUnit,
    type NativeProjectRuleProviderBehavior,
    outputUnitForRuleName,
    ruleFileOutputUnit,
    ruleInspectionConflictDiagnostic,
    ruleTargetBlockedDiagnostic,
} from "./native-project-rule-results";
import type { NativeGlobalRuleProviderSupport, NativeProjectRuleProviderSupport } from "./native-project-rule-support-types";
import type {
    MaterializationValidatorImplementation,
    RenderRegistryConfiguration,
    ReverseInspectionValidatorImplementation,
} from "./render-registry";

export { makeRuleApplicabilityPredicate } from "./native-project-rule-applicability";

export {
    createVerifiedNativeGlobalRuleBuild,
    createVerifiedNativeProjectRuleBuild,
} from "./native-project-rule-profiles";

export function createNativeProjectRuleProviderSupport(input: {
    adapterId: AdapterId;
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    agentRuntimeId: AgentRuntimeId;
    outputContractId: string;
    materializationProfileId: MaterializationProfileId;
    /** Overrides the legacy Adapter-level key when sibling runtime entries need distinct materializers. */
    materializerCapabilityKey?: MaterializerCapabilityKey;
    target: NativeProjectRuleTargetDeclaration;
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: readonly VerifiedNativeProjectRuleBuild[];
}): NativeProjectRuleProviderSupport {
    return createNativeRuleProviderSupport({ ...input, targetScope: "project" }) as NativeProjectRuleProviderSupport;
}

export function createNativeGlobalRuleProviderSupport(input: {
    adapterId: AdapterId;
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    agentRuntimeId: AgentRuntimeId;
    outputContractId: string;
    materializationProfileId: MaterializationProfileId;
    materializerCapabilityKey?: MaterializerCapabilityKey;
    target: NativeProjectRuleTargetDeclaration;
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: readonly VerifiedNativeGlobalRuleBuild[];
}): NativeGlobalRuleProviderSupport {
    return createNativeRuleProviderSupport({ ...input, targetScope: "global" }) as NativeGlobalRuleProviderSupport;
}

function createNativeRuleProviderSupport(input: {
    adapterId: AdapterId;
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    agentRuntimeId: AgentRuntimeId;
    outputContractId: string;
    materializationProfileId: MaterializationProfileId;
    materializerCapabilityKey?: MaterializerCapabilityKey;
    target: NativeProjectRuleTargetDeclaration;
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: readonly VerifiedNativeRuleBuild[];
    targetScope: "project" | "global";
}): NativeProjectRuleProviderSupport | NativeGlobalRuleProviderSupport {
    if (!isNativeProjectRuleFileNameSuffix(input.target.fileNameSuffix)) {
        throw new Error("native Rule target requires the version-1 Markdown filename suffix");
    }
    const renderContractDeclaration: AdapterNativeRuleRenderDeclarationV1 = deepFreezeChildrenFirst({
        schemaVersion: 1,
        declarationKind: input.targetScope === "project" ? "native_project_rule_v1" : "native_global_rule_v1",
        outputContractId: input.outputContractId,
        materializationProfileId: input.materializationProfileId,
        agentRuntimeId: input.agentRuntimeId,
        target: structuredClone(input.target),
        ...(input.buildCompatibility === undefined ? {} : { buildCompatibility: structuredClone(input.buildCompatibility) }),
        verifiedBuilds: structuredClone([...input.verifiedBuilds]),
    });
    const { profile, outputContract } = makeNativeProjectRuleContractParts(renderContractDeclaration);
    const descriptor = input.agentRuntimes.find((entry) => entry.agentRuntimeId === input.agentRuntimeId);
    if (descriptor === undefined) throw new Error("native Rule support references an unknown agent runtime");
    if (
        input.verifiedBuilds.length === 0 ||
        input.verifiedBuilds.some(
            (build) =>
                build.agentRuntimeId !== input.agentRuntimeId ||
                build.materializationProfileId !== input.materializationProfileId,
        )
    ) {
        throw new Error("native Rule verified builds do not belong to the declaration");
    }
    const targetContextSchema = makeTargetContextSchema(input.adapterId, descriptor, profile);
    const targetCapability: AdapterAssetTargetCapabilityAvailable = {
        agentRuntimeId: input.agentRuntimeId,
        entrySupportStatus: "supported",
        assetKind: "Rule",
        renderStrategy: "native_file",
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        targetContextSchemaId: targetContextSchema.targetContextSchemaId,
        targetContextSchemaFingerprint: targetContextSchema.schemaFingerprint,
        reverseExtractPolicy: "can_reconcile",
        diagnostics: [],
    };
    const materializerCapabilityKey =
        input.materializerCapabilityKey ?? `${input.adapterId.toLowerCase()}.${input.targetScope}-rule-native-v1`;
    if (
        materializerCapabilityKey.length === 0 ||
        materializerCapabilityKey.trim() !== materializerCapabilityKey ||
        materializerCapabilityKey.includes("\0")
    ) {
        throw new Error("native Rule materializer capability key must be canonical non-blank text");
    }
    const materializerCapability: AdapterMaterializerCapability = {
        materializerCapabilityKey,
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        materializationProfileIds: [input.materializationProfileId],
        diagnostics: [],
    };
    const behavior: NativeProjectRuleProviderBehavior = {
        adapterId: input.adapterId,
        adapterVersion: input.adapterVersion,
        profile,
        profileConstraintFingerprint: (
            outputContract.materializationProfiles.find(
                (candidate) => candidate.materializationProfileId === profile.materializationProfileId,
            ) as OutputContractDefinitionV1["materializationProfiles"][number]
        ).profileConstraintFingerprint,
        outputContract,
        targetContextSchema,
        materializerCapability,
    };
    return {
        targetContextSchema,
        targetCapability,
        materializerCapability,
        renderContractDeclaration,
        analyze: (value) => analyzeNativeProjectRule(value, behavior),
        materialize: (value) => materializeNativeProjectRule(value, behavior),
        inspect: (value) => inspectNativeProjectRule(value, behavior),
    } as NativeProjectRuleProviderSupport | NativeGlobalRuleProviderSupport;
}

function makeRuleMaterializationValidator(
    profile: NativeProjectRuleProfileDefinition,
    ref: MaterializationValidatorImplementation["ref"],
): MaterializationValidatorImplementation {
    return {
        ref,
        validate(input) {
            if (input.profile.materializationProfileId !== profile.materializationProfileId) {
                throw new Error("native project Rule materialization profile mismatch");
            }
            const semanticByKind = new Map(input.selectedSemantics.map((semantic) => [semantic.semanticKind, semantic]));
            const valueByRef = new Map(input.canonicalValues.map((value) => [value.semanticRefFingerprint, value]));
            const inventorySemantic = semanticByKind.get("asset.file_inventory");
            const activationSemantic = semanticByKind.get("rule.activation");
            const contentSemantic = semanticByKind.get("rule.content");
            const inventoryValue =
                inventorySemantic === undefined ? undefined : valueByRef.get(inventorySemantic.semanticRefFingerprint);
            const activationValue =
                activationSemantic === undefined ? undefined : valueByRef.get(activationSemantic.semanticRefFingerprint);
            const contentValue =
                contentSemantic === undefined ? undefined : valueByRef.get(contentSemantic.semanticRefFingerprint);
            const inventoryEntry = inventoryValue?.valueKind === "file_inventory" ? inventoryValue.value[0] : undefined;
            const ruleData = activationValue?.valueKind === "asset_type_data" ? activationValue.value : undefined;
            const contentText =
                contentValue?.valueKind === "file_content" && contentValue.value.contentKind === "text"
                    ? contentValue.value.text
                    : undefined;
            const expectedPath =
                ruleData?.kind === "Rule" &&
                ruleData.typeData.description === "" &&
                ruleData.typeData.activation.mode === "always"
                    ? nativeProjectRuleRelativePath(profile, ruleData.typeData.name)
                    : "";
            const claim = input.outputUnit.claims[0];
            const file = input.files[0];
            const semanticRefs = input.selectedSemantics
                .map((semantic) => semantic.semanticRefFingerprint)
                .sort(compareUtf8Bytes);
            const valid =
                semanticByKind.size === 3 &&
                valueByRef.size === 3 &&
                input.selectedSemantics.length === 3 &&
                input.canonicalValues.length === 3 &&
                inventorySemantic?.subject.subjectKind === "asset" &&
                activationSemantic?.subject.subjectKind === "asset" &&
                contentSemantic?.subject.subjectKind === "file" &&
                inventoryValue?.valueKind === "file_inventory" &&
                inventoryValue.value.length === 1 &&
                inventoryEntry?.fileId === contentSemantic.subject.fileId &&
                inventoryEntry.role === "entry" &&
                inventoryEntry.contentKind === "text" &&
                inventoryEntry.executable === false &&
                ruleData?.kind === "Rule" &&
                ruleData.typeData.schemaVersion === 2 &&
                expectedPath !== "" &&
                contentText !== undefined &&
                normalizeText(contentText).normalized === contentText &&
                contentText.trim().length > 0 &&
                inventoryEntry.contentHash === textPayloadStats(contentText).contentHash &&
                input.outputUnit.claims.length === 1 &&
                input.outputUnit.managedDirectoryBoundaries.length === 0 &&
                claim?.relativePath === expectedPath &&
                claim.contentKind === "text" &&
                claim.executable === false &&
                input.files.length === 1 &&
                file?.relativePath === expectedPath &&
                file.content.contentKind === "text" &&
                file.content.text === contentText &&
                file.executable === false &&
                file.sectionBindings.length === 0 &&
                stableStringify(file.semanticRefFingerprints) === stableStringify(semanticRefs) &&
                input.selectedOptions.length === 3 &&
                new Set(input.selectedOptions.map((option) => option.semanticRefFingerprint)).size === 3 &&
                input.selectedOptions.every(
                    (option) =>
                        semanticRefs.includes(option.semanticRefFingerprint) &&
                        option.outcome === "preserved" &&
                        option.renderStrategy === "native_file" &&
                        option.actualReverseExtractPolicy === "can_reconcile" &&
                        option.requiredOutputUnitFingerprints.length === 1 &&
                        option.requiredOutputUnitFingerprints[0] === input.outputUnit.outputUnitFingerprint,
                );
            if (!valid) throw new Error("native project Rule materialization violates its profile");
            return {
                outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                coveredSemanticRefFingerprints: semanticRefs,
                coverageFingerprint: computeSemanticCoverageFingerprint({
                    outputContractFingerprint: input.contract.outputContractFingerprint,
                    profileConstraintFingerprint: input.profile.profileConstraintFingerprint,
                    outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                    canonicalValues: input.canonicalValues,
                    files: input.files,
                    coveredSemanticRefFingerprints: semanticRefs,
                }),
            };
        },
    };
}

function makeRuleReverseValidator(
    profile: NativeProjectRuleProfileDefinition,
    ref: ReverseInspectionValidatorImplementation["ref"],
): ReverseInspectionValidatorImplementation {
    return {
        ref,
        validate(input) {
            const results = new Map(input.adapterResult.files.map((file) => [file.relativePath, file]));
            const changes = new Map(input.adapterResult.changes.map((change) => [change.changeFingerprint, change]));
            const contentRefs = input.appliedRenderSnapshot.decisions
                .filter(
                    (decision) =>
                        decision.semanticRef.semanticKind === "rule.content" &&
                        decision.outputUnitFingerprints.includes(input.outputUnit.outputUnitFingerprint),
                )
                .map((decision) => decision.semanticRef.semanticRefFingerprint)
                .sort(compareUtf8Bytes);
            const referencedChanges = new Set<string>();
            const valid =
                input.files.length === 1 &&
                input.files.every((file) => {
                    const result = results.get(file.relativePath);
                    if (
                        file.fileState === "baseline_changed" &&
                        nativeProjectRuleNameFromRelativePath(profile, file.relativePath) !== null &&
                        file.appliedContent.contentKind === "text" &&
                        file.currentContent.contentKind === "text" &&
                        normalizeText(file.currentContent.text).normalized === file.currentContent.text &&
                        file.currentContent.text.trim().length > 0 &&
                        file.attributeChanges.length === 0 &&
                        file.provenance.sectionBindings.length === 0 &&
                        contentRefs.length === 1
                    ) {
                        const referenced = result?.attributionState === "uniquely_attributable" ? result.changeFingerprints : [];
                        const change = referenced.length === 1 ? changes.get(referenced[0] as Sha256Digest) : undefined;
                        const hunksValid =
                            result?.attributionState === "uniquely_attributable" &&
                            result.hunkAttributions.length === file.diffHunks.length &&
                            result.hunkAttributions.every(
                                (attribution) =>
                                    stableStringify(attribution.semanticRefFingerprints) === stableStringify(contentRefs),
                            );
                        const fileValid =
                            result?.attributionState === "uniquely_attributable" &&
                            referenced.length === 1 &&
                            hunksValid &&
                            change?.changeKind === "file_content_replacement" &&
                            stableStringify(change.semanticRefFingerprints) === stableStringify(contentRefs) &&
                            stableStringify(change.replacementContent) === stableStringify(file.currentContent);
                        if (fileValid) referencedChanges.add(referenced[0] as string);
                        return fileValid;
                    }
                    return result?.attributionState === "conflict";
                });
            if (
                !valid ||
                input.inventoryDeltas.length !== 0 ||
                results.size !== input.files.length ||
                referencedChanges.size !== changes.size
            ) {
                throw new Error("native project Rule reverse result violates whole-file policy");
            }
            const proof = {
                outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                coveredHunkFingerprints: input.files
                    .flatMap((file) => file.diffHunks.map((hunk) => hunk.hunkFingerprint))
                    .sort(compareUtf8Bytes),
                coveredAttributeChangeFingerprints: input.files
                    .flatMap((file) =>
                        file.fileState === "baseline_changed"
                            ? file.attributeChanges.map((change) => change.attributeChangeFingerprint)
                            : [],
                    )
                    .sort(compareUtf8Bytes),
                coveredInventoryDeltaFingerprints: [],
                coveredChangeFingerprints: input.adapterResult.changes
                    .map((change) => change.changeFingerprint)
                    .sort(compareUtf8Bytes),
            };
            return {
                ...proof,
                reverseCoverageFingerprint: computeReverseInspectionCoverageFingerprint({
                    outputContractFingerprint: input.contract.outputContractFingerprint,
                    outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                    inspectionScopeFingerprint: input.inspectionScopeFingerprint,
                    diffHunks: input.files.flatMap((file) => file.diffHunks),
                    attributeChanges: input.files.flatMap((file) =>
                        file.fileState === "baseline_changed" ? file.attributeChanges : [],
                    ),
                    inventoryDeltas: input.inventoryDeltas,
                    changes: input.adapterResult.changes,
                    files: input.adapterResult.files,
                    proof,
                }),
            };
        },
    };
}

export function nativeProjectRuleRegistryComponents(
    providers: readonly AdapterProviderSummary[],
): Pick<
    RenderRegistryConfiguration,
    | "outputContracts"
    | "consumerConformances"
    | "targetApplicabilityPredicates"
    | "materializationValidators"
    | "reverseInspectionValidators"
> {
    const declarations = providers.flatMap((provider) =>
        provider.renderContractDeclarations
            .filter(
                (declaration): declaration is AdapterNativeRuleRenderDeclarationV1 =>
                    declaration.declarationKind === "native_project_rule_v1" ||
                    declaration.declarationKind === "native_global_rule_v1",
            )
            .map((declaration) => ({ provider, declaration })),
    );
    const parts = declarations.map(({ declaration }) => makeNativeProjectRuleContractParts(declaration));
    return {
        outputContracts: parts.map(({ outputContract }) => outputContract),
        consumerConformances: declarations.flatMap(({ provider, declaration }) =>
            declaration.verifiedBuilds.map((build) => makeRuleConsumerConformance(provider, declaration, build)),
        ),
        targetApplicabilityPredicates: declarations.flatMap(({ declaration }) =>
            declaration.verifiedBuilds.map((build) => makeRuleApplicabilityPredicate(declaration, build)),
        ),
        materializationValidators: parts.map(({ profile, components }) =>
            makeRuleMaterializationValidator(profile, components.materialize),
        ),
        reverseInspectionValidators: parts.map(({ profile, components }) =>
            makeRuleReverseValidator(profile, components.reverse),
        ),
    };
}

export function analyzeNativeProjectRule(
    input: RenderAnalysisInput,
    behavior: NativeProjectRuleProviderBehavior,
): AdapterRenderAnalysisResult {
    const asset =
        input.deployment.targetContexts.length === 1 && input.dialectInputs.length === 0
            ? findExactRuleAsset(input.deployment, behavior.profile.targetScope)
            : null;
    const supportedRefs =
        asset === null ? [] : input.requiredSemantics.filter((semantic) => isExactRuleSemantic(input, semantic, asset, behavior));
    if (asset === null || !hasExactRuleSemanticClosure(supportedRefs, asset)) return blockedRuleAnalysis(input, behavior);
    const outputUnit = outputUnitForRuleName(asset.version.canonical.typeData.name, behavior);
    const providerDialectFingerprint = computeProviderRenderDialectInputFingerprint({
        adapterId: behavior.adapterId,
        adapterVersion: behavior.adapterVersion,
        dialectInputs: input.dialectInputs,
    });
    const semanticOptions = supportedRefs.map((semantic): SemanticRenderOption => {
        const option = {
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            renderStrategy: "native_file" as const,
            outcome: "preserved" as const,
            actualReverseExtractPolicy: "can_reconcile" as const,
            approvalRequirement: { approvalState: "not_required" as const },
            requiredOutputUnitFingerprints: [outputUnit.outputUnitFingerprint],
            reasonCode: "project_rule_preserved_native_file",
            diagnostics: [] as OperationDiagnostic[],
        };
        return {
            ...option,
            optionFingerprint: computeRenderOptionFingerprint({
                adapterId: behavior.adapterId,
                adapterVersion: behavior.adapterVersion,
                renderInputFingerprint: input.deployment.renderInputFingerprint,
                providerRenderDialectInputFingerprint: providerDialectFingerprint,
                option,
            }),
        };
    });
    const supportedFingerprints = new Set(supportedRefs.map((semantic) => semantic.semanticRefFingerprint));
    const blockedSemanticRefs = input.requiredSemantics
        .filter((semantic) => !supportedFingerprints.has(semantic.semanticRefFingerprint))
        .map((semantic) => ({
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            reasonCode: `${behavior.profile.targetScope}_rule_target_not_applicable`,
            diagnostics: [
                ruleTargetBlockedDiagnostic(
                    behavior,
                    `this semantic is outside the exact native ${behavior.profile.targetScope} Rule cell`,
                ),
            ],
        }));
    return {
        status: blockedSemanticRefs.length === 0 ? "complete" : "partial",
        outputUnits: [outputUnit],
        semanticOptions: semanticOptions.sort((left, right) =>
            compareUtf8Bytes(left.semanticRefFingerprint, right.semanticRefFingerprint),
        ),
        blockedSemanticRefs,
        diagnostics: blockedSemanticRefs.flatMap((item) => item.diagnostics),
    };
}

export function materializeNativeProjectRule(
    input: RenderMaterializationInput,
    behavior: NativeProjectRuleProviderBehavior,
): RenderMaterializationResult {
    const asset = findExactRuleAsset(input.deployment, behavior.profile.targetScope);
    const entry = asset?.version.files.find((file) => file.file.role === "entry");
    const unit = input.selection.outputUnits[0];
    const renderer = input.selection.outputUnitRenderers[0];
    const expectedUnit = asset === null ? null : outputUnitForRuleName(asset.version.canonical.typeData.name, behavior);
    const reanalysis = analyzeNativeProjectRule(
        {
            schemaVersion: 1,
            deployment: input.deployment,
            requiredSemantics: input.requiredSemantics,
            dialectInputs: input.dialectInputs,
        },
        behavior,
    );
    const expectedOptions = new Map(reanalysis.semanticOptions.map((option) => [option.semanticRefFingerprint, option]));
    const semanticRefs = input.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint).sort(compareUtf8Bytes);
    const valid =
        asset !== null &&
        expectedUnit !== null &&
        input.deployment.assets.length === 1 &&
        input.deployment.targetContexts.length === 1 &&
        input.dialectInputs.length === 0 &&
        hasExactRuleSemanticClosure(input.requiredSemantics, asset) &&
        input.requiredSemantics.every((semantic) => isExactRuleSemantic(input, semantic, asset, behavior)) &&
        reanalysis.status === "complete" &&
        reanalysis.blockedSemanticRefs.length === 0 &&
        input.selection.outputUnits.length === 1 &&
        input.selection.outputUnitRenderers.length === 1 &&
        unit !== undefined &&
        renderer !== undefined &&
        stableStringify(unit) === stableStringify(expectedUnit) &&
        renderer.outputUnitFingerprint === unit.outputUnitFingerprint &&
        renderer.rendererAdapterId === behavior.adapterId &&
        renderer.rendererAdapterVersion === behavior.adapterVersion &&
        renderer.materializerCapabilityKey === behavior.materializerCapability.materializerCapabilityKey &&
        renderer.materializationProfileId === behavior.profile.materializationProfileId &&
        renderer.profileConstraintFingerprint === behavior.profileConstraintFingerprint &&
        entry?.contentKind === "text" &&
        input.selection.semanticOptions.length === expectedOptions.size &&
        new Set(input.selection.semanticOptions.map((option) => option.semanticRefFingerprint)).size === expectedOptions.size &&
        input.selection.semanticOptions.every((option) => {
            const expected = expectedOptions.get(option.semanticRefFingerprint);
            return (
                expected !== undefined &&
                option.outcome === "preserved" &&
                option.renderStrategy === expected.renderStrategy &&
                option.actualReverseExtractPolicy === expected.actualReverseExtractPolicy &&
                stableStringify(option.requiredOutputUnitFingerprints) ===
                    stableStringify(expected.requiredOutputUnitFingerprints)
            );
        });
    if (!valid || entry?.contentKind !== "text" || unit === undefined || expectedUnit === null) {
        return blockedRuleMaterialization(behavior);
    }
    return {
        status: "complete",
        materializationState: "materialized",
        materializedUnits: [
            {
                outputUnitFingerprint: unit.outputUnitFingerprint,
                files: [
                    {
                        relativePath: expectedUnit.claims[0].relativePath,
                        content: { contentKind: "text", text: entry.text },
                        executable: false,
                        semanticRefFingerprints: semanticRefs,
                        sectionBindings: [],
                    },
                ],
            },
        ],
        diagnostics: [],
    };
}

export function inspectNativeProjectRule(
    input: RenderedTargetInspectionInput,
    behavior: NativeProjectRuleProviderBehavior,
): AdapterRenderedTargetInspectionResult {
    if (
        !Array.isArray(input.files) ||
        !Array.isArray(input.inventoryDeltas) ||
        !Array.isArray(input.appliedRenderSnapshot?.outputUnits) ||
        !Array.isArray(input.appliedRenderSnapshot?.outputUnitRenderers) ||
        !Array.isArray(input.appliedRenderSnapshot?.decisions) ||
        !Array.isArray(input.inspectionScope?.fileStates)
    ) {
        return blockedRuleInspection(behavior);
    }
    const matchingUnits = input.appliedRenderSnapshot.outputUnits.filter((unit) => {
        const claim = unit.claims[0];
        return (
            unit.outputContractId === behavior.outputContract.outputContractId &&
            unit.outputContractFingerprint === behavior.outputContract.outputContractFingerprint &&
            unit.claims.length === 1 &&
            unit.managedDirectoryBoundaries.length === 0 &&
            claim?.contentKind === "text" &&
            claim.executable === false &&
            nativeProjectRuleNameFromRelativePath(behavior.profile, claim.relativePath) !== null &&
            stableStringify(unit) === stableStringify(makeRuleOutputUnit(claim.relativePath, behavior.outputContract))
        );
    });
    const matchingRenderers = input.appliedRenderSnapshot.outputUnitRenderers.filter(
        (renderer) =>
            matchingUnits.some((unit) => unit.outputUnitFingerprint === renderer.outputUnitFingerprint) &&
            renderer.rendererAdapterId === behavior.adapterId &&
            renderer.rendererAdapterVersion === behavior.adapterVersion &&
            renderer.materializerCapabilityKey === behavior.materializerCapability.materializerCapabilityKey &&
            renderer.materializationProfileId === behavior.profile.materializationProfileId &&
            renderer.profileConstraintFingerprint === behavior.profileConstraintFingerprint,
    );
    const expectedPath = matchingUnits[0]?.claims[0]?.relativePath;
    if (
        matchingUnits.length !== 1 ||
        matchingRenderers.length !== 1 ||
        expectedPath === undefined ||
        input.inventoryDeltas.length !== 0 ||
        input.files.some(
            (file) =>
                file.relativePath !== expectedPath || ruleFileOutputUnit(input, file) !== matchingUnits[0]?.outputUnitFingerprint,
        )
    ) {
        return blockedRuleInspection(behavior);
    }
    const changes: AttributedSemanticChange[] = [];
    const files = input.files.map((file): RenderedFileAttributionResult => {
        const contentRefs = input.appliedRenderSnapshot.decisions
            .filter(
                (decision) =>
                    decision.semanticRef.semanticKind === "rule.content" &&
                    decision.outputUnitFingerprints.includes(ruleFileOutputUnit(input, file)),
            )
            .map((decision) => decision.semanticRef.semanticRefFingerprint)
            .sort(compareUtf8Bytes);
        if (
            file.fileState !== "baseline_changed" ||
            file.relativePath !== expectedPath ||
            file.appliedContent.contentKind !== "text" ||
            file.currentContent.contentKind !== "text" ||
            normalizeText(file.currentContent.text).normalized !== file.currentContent.text ||
            file.currentContent.text.trim().length === 0 ||
            file.attributeChanges.length !== 0 ||
            file.provenance.sectionBindings.length !== 0 ||
            contentRefs.length !== 1
        ) {
            return {
                relativePath: file.relativePath,
                attributionState: "conflict",
                reasonCode: "project_rule_whole_file_change_not_reconcilable",
                diagnostics: [ruleInspectionConflictDiagnostic(file.relativePath)],
            };
        }
        const changePreimage = {
            changeKind: "file_content_replacement" as const,
            semanticRefFingerprints: contentRefs,
            replacementContent: file.currentContent,
        };
        const change = {
            ...changePreimage,
            changeFingerprint: computeAttributedSemanticChangeFingerprint({
                inspectionScopeFingerprint: input.inspectionScope.inspectionScopeFingerprint,
                change: changePreimage,
            }),
        };
        changes.push(change);
        return {
            relativePath: file.relativePath,
            attributionState: "uniquely_attributable",
            changeFingerprints: [change.changeFingerprint],
            hunkAttributions: file.diffHunks.map((hunk) => ({
                attributionKind: "semantic" as const,
                hunkFingerprint: hunk.hunkFingerprint,
                semanticRefFingerprints: contentRefs,
            })),
            diagnostics: [],
        };
    });
    return { status: "complete", changes, files, diagnostics: files.flatMap((file) => file.diagnostics) };
}
