/** Current-exact project-file analysis, materialization, and inspection behavior. */

import { normalizeText } from "../catalog/payload-store";
import type {
    AdapterRenderAnalysisResult,
    OutputContractDefinitionV1,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderMaterializationResult,
    SemanticRenderOption,
    VersionedContractComponentRef,
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
    AdapterNativeProjectExactFileRenderDeclarationV1,
    AdapterProviderSummary,
    AgentRuntimeDescriptor,
    MaterializationProfileId,
    MaterializerCapabilityKey,
    NativeProjectExactFileAssetKind,
} from "../contracts/source-import";
import type { AdapterTargetBuildCompatibilityPolicyV1 } from "../contracts/target-build-compatibility";
import { deepFreezeChildrenFirst } from "../foundation/deep-freeze";
import {
    computeAttributedSemanticChangeFingerprint,
    computeProviderRenderDialectInputFingerprint,
    computeRenderOptionFingerprint,
    computeReverseInspectionCoverageFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { isSha256Digest } from "../foundation/validators";
import { getAssetSpecHandler } from "../specs/registry";
import type { AdapterId, AgentRuntimeId, OperationDiagnostic, PosixRelativePath, Sha256Digest } from "../types";
import { makeExactFileMaterializationValidator } from "./native-project-exact-file-materialization-validator";
import {
    createVerifiedNativeProjectExactFileBuild,
    makeExactFileApplicabilityPredicateRef,
    makeExactFileConsumerConformance,
    makeNativeProjectExactFileContractParts,
    type NativeProjectExactFileProfileDefinition,
    type VerifiedNativeProjectExactFileBuild,
} from "./native-project-exact-file-profiles";
import {
    blockedExactFileAnalysis,
    blockedExactFileInspection,
    blockedExactFileMaterialization,
    exactFileDiagnostic,
    exactFileOutputUnit,
    findExactFileAssets,
    hasExactFileSemanticClosure,
    isExactFileSemantic,
    makeExactFileOutputUnit,
    type NativeProjectExactFileProviderBehavior,
    type NativeProjectExactFileRebaseMaterializer,
    safePathValidation,
    safeReverseParse,
} from "./native-project-exact-file-results";
import {
    compareUtf8Bytes,
    makeTargetContextSchema,
    PLATFORM_FACT_KEY,
    PROJECT_BINDING_FACT_KEY,
} from "./native-project-guidance-profiles";
import {
    inspectNativeProjectMemoryCatalog,
    validateNativeProjectMemoryCatalogReverse,
} from "./native-project-memory-catalog-behavior";
import { trustedNonProjectTargetFactEvidence } from "./native-project-target-authority";
import { trustedProjectEvidence } from "./native-project-target-evidence";
import type {
    RenderRegistryConfiguration,
    ReverseInspectionValidatorImplementation,
    TargetApplicabilityPredicateImplementation,
} from "./render-registry";
import { entrySemanticKind } from "./render-semantics";
import { resolveTargetBuildCompatibility } from "./target-build-compatibility";

export { createVerifiedNativeProjectExactFileBuild };

export interface NativeProjectExactFileProviderSupport {
    targetContextSchema: ReturnType<typeof makeTargetContextSchema>;
    targetCapability: AdapterAssetTargetCapabilityAvailable;
    materializerCapability: AdapterMaterializerCapability;
    renderContractDeclaration: AdapterNativeProjectExactFileRenderDeclarationV1;
    analyze(input: RenderAnalysisInput): AdapterRenderAnalysisResult;
    materialize(input: RenderMaterializationInput): RenderMaterializationResult;
    inspect(input: RenderedTargetInspectionInput): AdapterRenderedTargetInspectionResult;
}

export interface NativeProjectExactFileComponent {
    ref: VersionedContractComponentRef;
}

export function createNativeProjectExactFileProviderSupport(input: {
    adapterId: AdapterId;
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    agentRuntimeId: AgentRuntimeId;
    assetKind: NativeProjectExactFileAssetKind;
    outputContractId: string;
    materializationProfileId: MaterializationProfileId;
    /** Overrides the legacy Adapter × AssetKind key when sibling runtime entries need distinct materializers. */
    materializerCapabilityKey?: MaterializerCapabilityKey;
    nativeDialectId: string;
    projectPathValidator: NativeProjectExactFileComponent & {
        validate(relativePath: PosixRelativePath): boolean;
    };
    reverseParser: NativeProjectExactFileComponent & {
        parse(input: {
            assetKind: NativeProjectExactFileAssetKind;
            nativeDialectId: string;
            relativePath: PosixRelativePath;
            appliedNativeText: string;
            currentNativeText: string;
        }): { canonicalEntryText: string } | null;
    };
    memoryCatalog?: NonNullable<NativeProjectExactFileProviderBehavior["memoryCatalog"]>;
    rebaseMaterializer: NativeProjectExactFileRebaseMaterializer | null;
    restorationDialectIds: readonly string[];
    target: {
        targetContextSchemaId: string;
        requiredFacts: Readonly<Record<string, string>>;
    };
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: readonly VerifiedNativeProjectExactFileBuild[];
}): NativeProjectExactFileProviderSupport {
    if (typeof input.projectPathValidator.validate !== "function" || typeof input.reverseParser.parse !== "function") {
        throw new Error("native exact-file support requires Provider-owned path and parser implementations");
    }
    const renderContractDeclaration: AdapterNativeProjectExactFileRenderDeclarationV1 = deepFreezeChildrenFirst({
        schemaVersion: 1,
        declarationKind: "native_project_exact_file_v1",
        outputContractId: input.outputContractId,
        materializationProfileId: input.materializationProfileId,
        agentRuntimeId: input.agentRuntimeId,
        assetKind: input.assetKind,
        nativeDialectId: input.nativeDialectId,
        projectPathValidator: structuredClone(input.projectPathValidator.ref),
        reverseParser: structuredClone(input.reverseParser.ref),
        rebaseMaterializer: input.rebaseMaterializer === null ? null : structuredClone(input.rebaseMaterializer.ref),
        restorationDialectIds: structuredClone([...input.restorationDialectIds]),
        target: structuredClone(input.target),
        ...(input.buildCompatibility === undefined ? {} : { buildCompatibility: structuredClone(input.buildCompatibility) }),
        verifiedBuilds: structuredClone([...input.verifiedBuilds]),
    });
    const { profile, outputContract } = makeNativeProjectExactFileContractParts(renderContractDeclaration);
    const descriptor = input.agentRuntimes.find((entry) => entry.agentRuntimeId === input.agentRuntimeId);
    if (descriptor === undefined) throw new Error("native exact-file support references an unknown agent runtime");
    if (
        input.verifiedBuilds.length === 0 ||
        input.verifiedBuilds.some(
            (build) =>
                build.agentRuntimeId !== input.agentRuntimeId ||
                build.materializationProfileId !== input.materializationProfileId,
        )
    ) {
        throw new Error("native exact-file verified builds do not belong to the declaration");
    }
    const targetContextSchema = makeTargetContextSchema(input.adapterId, descriptor, profile);
    const targetCapability: AdapterAssetTargetCapabilityAvailable = {
        agentRuntimeId: input.agentRuntimeId,
        entrySupportStatus: "supported",
        assetKind: input.assetKind,
        renderStrategy: "native_file",
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        targetContextSchemaId: targetContextSchema.targetContextSchemaId,
        targetContextSchemaFingerprint: targetContextSchema.schemaFingerprint,
        reverseExtractPolicy: "can_reconcile",
        diagnostics: [],
    };
    const materializerCapabilityKey =
        input.materializerCapabilityKey ??
        `${input.adapterId.toLowerCase()}.project-${input.assetKind.toLowerCase()}-exact-file-v1`;
    if (
        materializerCapabilityKey.length === 0 ||
        materializerCapabilityKey.trim() !== materializerCapabilityKey ||
        materializerCapabilityKey.includes("\0")
    ) {
        throw new Error("native exact-file materializer capability key must be canonical non-blank text");
    }
    const materializerCapability: AdapterMaterializerCapability = {
        materializerCapabilityKey,
        outputContractId: outputContract.outputContractId,
        outputContractFingerprint: outputContract.outputContractFingerprint,
        materializationProfileIds: [input.materializationProfileId],
        diagnostics: [],
    };
    const profileConstraintFingerprint = (
        outputContract.materializationProfiles.find(
            (candidate) => candidate.materializationProfileId === profile.materializationProfileId,
        ) as OutputContractDefinitionV1["materializationProfiles"][number]
    ).profileConstraintFingerprint;
    const behavior: NativeProjectExactFileProviderBehavior = {
        adapterId: input.adapterId,
        adapterVersion: input.adapterVersion,
        profile,
        profileConstraintFingerprint,
        targetContextSchema,
        materializerCapability,
        outputContract,
        validateProjectPath: input.projectPathValidator.validate,
        parseChangedNativeText: input.reverseParser.parse,
        memoryCatalog: input.memoryCatalog ?? null,
        rebaseMaterializer: input.rebaseMaterializer,
    };
    return {
        targetContextSchema,
        targetCapability,
        materializerCapability,
        renderContractDeclaration,
        analyze: (value) => analyzeNativeProjectExactFile(value, behavior),
        materialize: (value) => materializeNativeProjectExactFile(value, behavior),
        inspect: (value) => inspectNativeProjectExactFile(value, behavior),
    };
}

function makeApplicabilityPredicate(
    declaration: AdapterNativeProjectExactFileRenderDeclarationV1,
    build: VerifiedNativeProjectExactFileBuild,
): TargetApplicabilityPredicateImplementation {
    const profile = makeNativeProjectExactFileContractParts(declaration).profile;
    return {
        ref: makeExactFileApplicabilityPredicateRef(build, declaration.buildCompatibility),
        ...(declaration.buildCompatibility === undefined ? {} : { allowsBuildIdentityMismatch: true as const }),
        evaluate(context) {
            const facts = Object.fromEntries(context.renderFacts.map((fact) => [fact.key, fact]));
            const trustedFacts =
                context.agentRuntimeId === build.agentRuntimeId &&
                facts[PLATFORM_FACT_KEY]?.value === build.platform &&
                facts[PLATFORM_FACT_KEY]?.evidenceLevel === "agent_runtime_verified" &&
                Object.entries(profile.requiredFacts).every(
                    ([key, value]) =>
                        facts[key]?.value === value &&
                        (key === PROJECT_BINDING_FACT_KEY
                            ? trustedProjectEvidence(facts[key]?.evidenceLevel)
                            : trustedNonProjectTargetFactEvidence(key, facts[key]?.evidenceLevel)),
                );
            if (!trustedFacts || !isSha256Digest(context.buildIdentity)) return false;
            const resolution = resolveTargetBuildCompatibility({
                anchors: declaration.verifiedBuilds,
                policy: declaration.buildCompatibility,
                current: {
                    agentRuntimeId: context.agentRuntimeId,
                    versionText: context.versionText,
                    buildIdentity: context.buildIdentity as Sha256Digest,
                    platform: build.platform,
                },
            });
            return (
                resolution.status !== "blocked" &&
                resolution.anchor.versionText === build.versionText &&
                resolution.anchor.buildIdentity === build.buildIdentity
            );
        },
    };
}

export function nativeProjectExactFileRegistryComponents(
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
                (declaration): declaration is AdapterNativeProjectExactFileRenderDeclarationV1 =>
                    declaration.declarationKind === "native_project_exact_file_v1",
            )
            .map((declaration) => ({ provider, declaration })),
    );
    const parts = declarations.map(({ declaration }) => makeNativeProjectExactFileContractParts(declaration));
    return {
        outputContracts: parts.map(({ outputContract }) => outputContract),
        consumerConformances: declarations.flatMap(({ provider, declaration }) =>
            declaration.verifiedBuilds.map((build) => makeExactFileConsumerConformance(provider, declaration, build)),
        ),
        targetApplicabilityPredicates: declarations.flatMap(({ declaration }) =>
            declaration.verifiedBuilds.map((build) => makeApplicabilityPredicate(declaration, build)),
        ),
        materializationValidators: parts.map(({ profile, components }) =>
            makeExactFileMaterializationValidator(profile, components.materialize),
        ),
        reverseInspectionValidators: parts.map(({ profile, components }) => makeReverseValidator(profile, components.reverse)),
    };
}

function makeReverseValidator(
    profile: NativeProjectExactFileProfileDefinition,
    ref: ReverseInspectionValidatorImplementation["ref"],
): ReverseInspectionValidatorImplementation {
    return {
        ref,
        validate(input) {
            const results = new Map(input.adapterResult.files.map((file) => [file.relativePath, file]));
            const changes = new Map(input.adapterResult.changes.map((change) => [change.changeFingerprint, change]));
            const entryKind = entrySemanticKind(profile.assetKind);
            const contentRefs = input.appliedRenderSnapshot.decisions
                .filter(
                    (decision) =>
                        decision.semanticRef.semanticKind === entryKind &&
                        decision.outputUnitFingerprints.includes(input.outputUnit.outputUnitFingerprint),
                )
                .map((decision) => decision.semanticRef.semanticRefFingerprint)
                .sort(compareUtf8Bytes);
            if (profile.assetKind === "Memory" && contentRefs.length === 0) {
                return validateNativeProjectMemoryCatalogReverse(input);
            }
            const referencedChanges = new Set<string>();
            const valid =
                input.files.length === 1 &&
                input.files.every((file) => {
                    const result = results.get(file.relativePath);
                    if (
                        file.fileState === "baseline_changed" &&
                        file.appliedContent.contentKind === "text" &&
                        file.currentContent.contentKind === "text" &&
                        normalizeText(file.currentContent.text).normalized === file.currentContent.text &&
                        file.attributeChanges.length === 0 &&
                        file.provenance.sectionBindings.length === 0 &&
                        contentRefs.length === 1
                    ) {
                        if (result?.attributionState === "conflict") return true;
                        const referenced = result?.attributionState === "uniquely_attributable" ? result.changeFingerprints : [];
                        const change = referenced.length === 1 ? changes.get(referenced[0] as Sha256Digest) : undefined;
                        const hunksValid =
                            result?.attributionState === "uniquely_attributable" &&
                            result.hunkAttributions.length === file.diffHunks.length &&
                            result.hunkAttributions.every(
                                (attribution) =>
                                    stableStringify(attribution.semanticRefFingerprints) === stableStringify(contentRefs),
                            );
                        const replacementValid =
                            change?.changeKind === "file_content_replacement" &&
                            change.replacementContent.contentKind === "text" &&
                            normalizeText(change.replacementContent.text).normalized === change.replacementContent.text &&
                            getAssetSpecHandler(profile.assetKind).validateEntryText(change.replacementContent.text);
                        const fileValid =
                            result?.attributionState === "uniquely_attributable" &&
                            referenced.length === 1 &&
                            hunksValid &&
                            replacementValid &&
                            stableStringify(change.semanticRefFingerprints) === stableStringify(contentRefs);
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
                throw new Error("native project exact-file reverse result violates its policy");
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

export function analyzeNativeProjectExactFile(
    input: RenderAnalysisInput,
    behavior: NativeProjectExactFileProviderBehavior,
): AdapterRenderAnalysisResult {
    const resolved = findExactFileAssets(input, behavior);
    if (resolved === null) {
        return blockedExactFileAnalysis(input, behavior);
    }
    const closures = resolved.map((item) => ({
        item,
        semantics: input.requiredSemantics.filter((semantic) => isExactFileSemantic(input, semantic, item.asset, behavior)),
    }));
    if (closures.some(({ item, semantics }) => !hasExactFileSemanticClosure(semantics, item.asset, behavior))) {
        return blockedExactFileAnalysis(input, behavior);
    }
    const providerDialectFingerprint = computeProviderRenderDialectInputFingerprint({
        adapterId: behavior.adapterId,
        adapterVersion: behavior.adapterVersion,
        dialectInputs: input.dialectInputs,
    });
    const outputUnits = closures.map(({ item }) =>
        makeExactFileOutputUnit(item.native.file.relativePath, behavior.outputContract),
    );
    const semanticOptions = closures.flatMap(({ item, semantics }) => {
        const outputUnit = makeExactFileOutputUnit(item.native.file.relativePath, behavior.outputContract);
        return semantics.map((semantic): SemanticRenderOption => {
            const option = {
                semanticRefFingerprint: semantic.semanticRefFingerprint,
                renderStrategy: "native_file" as const,
                outcome: "preserved" as const,
                actualReverseExtractPolicy: "can_reconcile" as const,
                approvalRequirement: { approvalState: "not_required" as const },
                requiredOutputUnitFingerprints: [outputUnit.outputUnitFingerprint],
                reasonCode: "native_project_exact_file_preserved",
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
    });
    const supportedRefs = new Set(semanticOptions.map((option) => option.semanticRefFingerprint));
    const blockedSemanticRefs = input.requiredSemantics
        .filter((semantic) => !supportedRefs.has(semantic.semanticRefFingerprint))
        .map((semantic) => ({
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            reasonCode: "native_project_exact_file_not_applicable",
            diagnostics: [exactFileDiagnostic(behavior, "semantic is outside the exact native one-file cell")],
        }));
    return {
        status: blockedSemanticRefs.length === 0 ? "complete" : "partial",
        outputUnits: outputUnits.sort((left, right) => compareUtf8Bytes(left.outputUnitFingerprint, right.outputUnitFingerprint)),
        semanticOptions: semanticOptions.sort((left, right) =>
            compareUtf8Bytes(left.semanticRefFingerprint, right.semanticRefFingerprint),
        ),
        blockedSemanticRefs,
        diagnostics: blockedSemanticRefs.flatMap((item) => item.diagnostics),
    };
}

export function materializeNativeProjectExactFile(
    input: RenderMaterializationInput,
    behavior: NativeProjectExactFileProviderBehavior,
): RenderMaterializationResult {
    const resolved = findExactFileAssets(input, behavior);
    const reanalysis = analyzeNativeProjectExactFile(
        {
            schemaVersion: 1,
            deployment: input.deployment,
            requiredSemantics: input.requiredSemantics,
            dialectInputs: input.dialectInputs,
        },
        behavior,
    );
    if (resolved === null || reanalysis.status !== "complete") {
        return blockedExactFileMaterialization(behavior);
    }
    const expectedOptions = new Map(reanalysis.semanticOptions.map((option) => [option.semanticRefFingerprint, option]));
    const expectedUnits = resolved.map((item) => makeExactFileOutputUnit(item.native.file.relativePath, behavior.outputContract));
    const selectedUnitByFingerprint = new Map(input.selection.outputUnits.map((unit) => [unit.outputUnitFingerprint, unit]));
    const selectedRendererByFingerprint = new Map(
        input.selection.outputUnitRenderers.map((renderer) => [renderer.outputUnitFingerprint, renderer]),
    );
    const valid =
        resolved.every((item) => {
            const semantics = input.requiredSemantics.filter((semantic) =>
                isExactFileSemantic(input, semantic, item.asset, behavior),
            );
            return hasExactFileSemanticClosure(semantics, item.asset, behavior);
        }) &&
        input.requiredSemantics.every(
            (semantic) => resolved.filter((item) => isExactFileSemantic(input, semantic, item.asset, behavior)).length === 1,
        ) &&
        input.selection.outputUnits.length === expectedUnits.length &&
        selectedUnitByFingerprint.size === expectedUnits.length &&
        input.selection.outputUnitRenderers.length === expectedUnits.length &&
        selectedRendererByFingerprint.size === expectedUnits.length &&
        expectedUnits.every((unit) => {
            const selected = selectedUnitByFingerprint.get(unit.outputUnitFingerprint);
            const renderer = selectedRendererByFingerprint.get(unit.outputUnitFingerprint);
            return (
                selected !== undefined &&
                stableStringify(selected) === stableStringify(unit) &&
                renderer?.rendererAdapterId === behavior.adapterId &&
                renderer.rendererAdapterVersion === behavior.adapterVersion &&
                renderer.materializerCapabilityKey === behavior.materializerCapability.materializerCapabilityKey &&
                renderer.materializationProfileId === behavior.profile.materializationProfileId &&
                renderer.profileConstraintFingerprint === behavior.profileConstraintFingerprint
            );
        }) &&
        input.selection.semanticOptions.length === expectedOptions.size &&
        input.selection.semanticOptions.every((option) => {
            const expected = expectedOptions.get(option.semanticRefFingerprint);
            return (
                expected !== undefined &&
                option.outcome === "preserved" &&
                option.renderStrategy === "native_file" &&
                option.actualReverseExtractPolicy === "can_reconcile" &&
                stableStringify(option.requiredOutputUnitFingerprints) ===
                    stableStringify(expected.requiredOutputUnitFingerprints)
            );
        });
    if (!valid) return blockedExactFileMaterialization(behavior);
    return {
        status: "complete",
        materializationState: "materialized",
        materializedUnits: resolved
            .map((item) => {
                const unit = makeExactFileOutputUnit(item.native.file.relativePath, behavior.outputContract);
                const semanticRefs = input.requiredSemantics
                    .filter((semantic) => isExactFileSemantic(input, semantic, item.asset, behavior))
                    .map((semantic) => semantic.semanticRefFingerprint)
                    .sort(compareUtf8Bytes);
                return {
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    files: [
                        {
                            relativePath: item.native.file.relativePath,
                            content: { contentKind: "text" as const, text: item.materializedText },
                            executable: false,
                            semanticRefFingerprints: semanticRefs,
                            sectionBindings: [],
                        },
                    ],
                };
            })
            .sort((left, right) => compareUtf8Bytes(left.outputUnitFingerprint, right.outputUnitFingerprint)),
        diagnostics: [],
    };
}

export function inspectNativeProjectExactFile(
    input: RenderedTargetInspectionInput,
    behavior: NativeProjectExactFileProviderBehavior,
): AdapterRenderedTargetInspectionResult {
    if (
        !Array.isArray(input.files) ||
        !Array.isArray(input.inventoryDeltas) ||
        !Array.isArray(input.appliedRenderSnapshot?.outputUnits) ||
        !Array.isArray(input.appliedRenderSnapshot?.outputUnitRenderers) ||
        !Array.isArray(input.appliedRenderSnapshot?.decisions) ||
        !Array.isArray(input.inspectionScope?.fileStates)
    ) {
        return blockedExactFileInspection(behavior);
    }
    const matchingUnits = input.appliedRenderSnapshot.outputUnits.filter((unit) => {
        const claim = unit.claims[0];
        return (
            unit.outputContractId === behavior.outputContract.outputContractId &&
            unit.outputContractFingerprint === behavior.outputContract.outputContractFingerprint &&
            unit.claims.length === 1 &&
            unit.managedDirectoryBoundaries.length === 0 &&
            claim?.contentKind === "text" &&
            !claim.executable &&
            safePathValidation(behavior, claim.relativePath) &&
            stableStringify(unit) === stableStringify(makeExactFileOutputUnit(claim.relativePath, behavior.outputContract))
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
    const unitByPath = new Map(
        matchingUnits.map((unit) => {
            const claim = unit.claims[0] as (typeof unit.claims)[number];
            return [claim.relativePath, unit] as const;
        }),
    );
    const rendererUnits = new Set(matchingRenderers.map((renderer) => renderer.outputUnitFingerprint));
    if (
        matchingUnits.length === 0 ||
        unitByPath.size !== matchingUnits.length ||
        matchingRenderers.length !== matchingUnits.length ||
        rendererUnits.size !== matchingUnits.length ||
        matchingUnits.some((unit) => !rendererUnits.has(unit.outputUnitFingerprint)) ||
        input.inventoryDeltas.length !== 0 ||
        input.inspectionScope.directoryInventories.length !== 0 ||
        new Set(input.files.map((file) => file.relativePath)).size !== input.files.length ||
        input.inspectionScope.fileStates.some((state) => {
            const unit = unitByPath.get(state.relativePath);
            return unit === undefined || state.outputUnitFingerprint !== unit.outputUnitFingerprint;
        }) ||
        input.files.some((file) => {
            const unit = unitByPath.get(file.relativePath);
            return unit === undefined || exactFileOutputUnit(input, file) !== unit.outputUnitFingerprint;
        })
    ) {
        return blockedExactFileInspection(behavior);
    }
    if (behavior.memoryCatalog !== null) {
        return inspectNativeProjectMemoryCatalog(input, behavior, matchingUnits);
    }
    const changes: AttributedSemanticChange[] = [];
    const entryKind = entrySemanticKind(behavior.profile.assetKind);
    const files = input.files.map((file): RenderedFileAttributionResult => {
        const contentRefs = input.appliedRenderSnapshot.decisions
            .filter(
                (decision) =>
                    decision.semanticRef.semanticKind === entryKind &&
                    decision.outputUnitFingerprints.includes(exactFileOutputUnit(input, file)),
            )
            .map((decision) => decision.semanticRef.semanticRefFingerprint)
            .sort(compareUtf8Bytes);
        const parsed =
            file.fileState === "baseline_changed" &&
            file.appliedContent.contentKind === "text" &&
            file.currentContent.contentKind === "text"
                ? safeReverseParse(behavior, file.relativePath, file.appliedContent.text, file.currentContent.text)
                : null;
        if (
            file.fileState !== "baseline_changed" ||
            file.appliedContent.contentKind !== "text" ||
            file.currentContent.contentKind !== "text" ||
            normalizeText(file.currentContent.text).normalized !== file.currentContent.text ||
            file.attributeChanges.length !== 0 ||
            file.provenance.sectionBindings.length !== 0 ||
            contentRefs.length !== 1 ||
            parsed === null
        ) {
            return {
                relativePath: file.relativePath,
                attributionState: "conflict",
                reasonCode: "native_project_exact_file_change_not_reconcilable",
                diagnostics: [exactFileDiagnostic(behavior, "changed native file cannot be safely reparsed", "warning")],
            };
        }
        const changePreimage = {
            changeKind: "file_content_replacement" as const,
            semanticRefFingerprints: contentRefs,
            replacementContent: { contentKind: "text" as const, text: parsed.canonicalEntryText },
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
    changes.sort((left, right) => compareUtf8Bytes(left.changeFingerprint, right.changeFingerprint));
    files.sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
    return { status: "complete", changes, files, diagnostics: files.flatMap((file) => file.diagnostics) };
}
