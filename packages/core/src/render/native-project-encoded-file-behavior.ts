/** Analysis, materialization and reverse inspection for an encoded Subagent file. */

import type { RenderedSectionBinding } from "../contracts/deployment-authority";
import type {
    AdapterRenderAnalysisResult,
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
import type { AdapterNativeEncodedFileRenderDeclarationV1, AdapterProviderSummary } from "../contracts/source-import";
import {
    computeAttributedSemanticChangeFingerprint,
    computeProviderRenderDialectInputFingerprint,
    computeRenderOptionFingerprint,
    computeReverseInspectionCoverageFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { isSha256Digest } from "../foundation/validators";
import type { OperationDiagnostic, Sha256Digest } from "../types";
import { makeEncodedFileMaterializationValidator } from "./native-project-encoded-file-materialization-validator";
import {
    makeEncodedFileApplicabilityPredicateRef,
    makeEncodedFileConsumerConformance,
    makeNativeProjectEncodedFileContractParts,
    type NativeProjectEncodedFileProfileDefinition,
    type VerifiedNativeEncodedFileBuild,
} from "./native-project-encoded-file-profiles";
import {
    canonicalSectionRefs,
    type EncodedCanonicalSectionDescriptor,
    encodedFileDiagnostic,
    findEncodedFileAssets,
    hasEncodedFileSemanticClosure,
    makeEncodedFileOutputUnit,
    type NativeProjectEncodedFileProviderBehavior,
    safeDecodeNativeFile,
} from "./native-project-encoded-file-results";
import { compareUtf8Bytes, PLATFORM_FACT_KEY, PROJECT_BINDING_FACT_KEY } from "./native-project-guidance-profiles";
import { trustedNonProjectTargetFactEvidence } from "./native-project-target-authority";
import { trustedProjectEvidence } from "./native-project-target-evidence";
import type {
    RenderRegistryConfiguration,
    ReverseInspectionValidatorImplementation,
    TargetApplicabilityPredicateImplementation,
} from "./render-registry";
import { resolveTargetBuildCompatibility } from "./target-build-compatibility";

function makeApplicabilityPredicate(
    declaration: AdapterNativeEncodedFileRenderDeclarationV1,
    build: VerifiedNativeEncodedFileBuild,
): TargetApplicabilityPredicateImplementation {
    const profile = makeNativeProjectEncodedFileContractParts(declaration).profile;
    return {
        ref: makeEncodedFileApplicabilityPredicateRef(build, profile.targetScope, declaration.buildCompatibility),
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

export function nativeProjectEncodedFileRegistryComponents(
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
                (declaration): declaration is AdapterNativeEncodedFileRenderDeclarationV1 =>
                    declaration.declarationKind === "native_project_encoded_file_v1" ||
                    declaration.declarationKind === "native_global_encoded_file_v1",
            )
            .map((declaration) => ({ provider, declaration })),
    );
    const parts = declarations.map(({ declaration }) => makeNativeProjectEncodedFileContractParts(declaration));
    return {
        outputContracts: parts.map(({ outputContract }) => outputContract),
        consumerConformances: declarations.flatMap(({ provider, declaration }) =>
            declaration.verifiedBuilds.map((build) => makeEncodedFileConsumerConformance(provider, declaration, build)),
        ),
        targetApplicabilityPredicates: declarations.flatMap(({ declaration }) =>
            declaration.verifiedBuilds.map((build) => makeApplicabilityPredicate(declaration, build)),
        ),
        materializationValidators: parts.map(({ profile, components }) =>
            makeEncodedFileMaterializationValidator(profile, components.materialize),
        ),
        reverseInspectionValidators: parts.map(({ profile, components }) => makeReverseValidator(profile, components.reverse)),
    };
}

function makeReverseValidator(
    profile: NativeProjectEncodedFileProfileDefinition,
    ref: ReverseInspectionValidatorImplementation["ref"],
): ReverseInspectionValidatorImplementation {
    return {
        ref,
        validate(input) {
            const [file] = input.files;
            const baselineFile = file?.fileState === "baseline_changed" ? file : undefined;
            const [result] = input.adapterResult.files;
            const changes = new Map(input.adapterResult.changes.map((change) => [change.changeFingerprint, change]));
            const referenced = result?.attributionState === "uniquely_attributable" ? result.changeFingerprints : [];
            const referencedChanges = referenced.map((fingerprint) => changes.get(fingerprint));
            const changedRefs = referencedChanges.flatMap((change) =>
                change?.changeKind === "file_content_replacement" ? change.semanticRefFingerprints : [],
            );
            const allowedSectionRefs = new Set(
                baselineFile?.provenance.sectionBindings.flatMap((binding) => binding.semanticRefFingerprints),
            );
            const valid =
                input.files.length === 1 &&
                input.adapterResult.files.length === 1 &&
                input.inventoryDeltas.length === 0 &&
                baselineFile !== undefined &&
                baselineFile.attributeChanges.length === 0 &&
                baselineFile.diffHunks.length > 0 &&
                result?.attributionState === "uniquely_attributable" &&
                referenced.length >= 1 &&
                referenced.length <= 2 &&
                new Set(referenced).size === referenced.length &&
                referenced.length === changes.size &&
                referencedChanges.every(
                    (change) =>
                        change?.changeKind === "file_content_replacement" &&
                        change.semanticRefFingerprints.length === 1 &&
                        allowedSectionRefs.has(change.semanticRefFingerprints[0] as Sha256Digest),
                ) &&
                new Set(changedRefs).size === changedRefs.length &&
                result.hunkAttributions.length === baselineFile.diffHunks.length &&
                result.hunkAttributions.every(
                    (attribution) =>
                        attribution.attributionKind === "semantic" &&
                        stableStringify(attribution.semanticRefFingerprints) ===
                            stableStringify([...changedRefs].sort(compareUtf8Bytes)),
                );
            if (!valid) {
                throw new Error(
                    `native ${profile.targetScope} encoded-file reverse result violates its ${profile.assetKind} policy`,
                );
            }
            const proof = {
                outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                coveredHunkFingerprints: baselineFile.diffHunks.map((hunk) => hunk.hunkFingerprint).sort(compareUtf8Bytes),
                coveredAttributeChangeFingerprints: [],
                coveredInventoryDeltaFingerprints: [],
                coveredChangeFingerprints: [...changes.keys()].sort(compareUtf8Bytes) as Sha256Digest[],
            };
            return {
                ...proof,
                reverseCoverageFingerprint: computeReverseInspectionCoverageFingerprint({
                    outputContractFingerprint: input.contract.outputContractFingerprint,
                    outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                    inspectionScopeFingerprint: input.inspectionScopeFingerprint,
                    diffHunks: baselineFile.diffHunks,
                    attributeChanges: [],
                    inventoryDeltas: [],
                    changes: input.adapterResult.changes,
                    files: input.adapterResult.files,
                    proof,
                }),
            };
        },
    };
}

export function analyzeNativeProjectEncodedFile(
    input: RenderAnalysisInput,
    behavior: NativeProjectEncodedFileProviderBehavior,
): AdapterRenderAnalysisResult {
    const resolved = findEncodedFileAssets(input, behavior);
    if (resolved === null) return blockedAnalysis(input, behavior);
    const closures = resolved.map((item) => ({
        item,
        semantics: input.requiredSemantics.filter(
            (semantic) =>
                semantic.consumerAgentRuntimeId === behavior.profile.agentRuntimeId &&
                semantic.subject.assetId === item.asset.version.ref.assetId &&
                semantic.subject.versionId === item.asset.version.ref.versionId,
        ),
    }));
    if (closures.some(({ item, semantics }) => !hasEncodedFileSemanticClosure(semantics, item.asset))) {
        return blockedAnalysis(input, behavior);
    }
    const dialectFingerprint = computeProviderRenderDialectInputFingerprint({
        adapterId: behavior.adapterId,
        adapterVersion: behavior.adapterVersion,
        dialectInputs: input.dialectInputs,
    });
    const outputUnits = closures.map(({ item }) =>
        makeEncodedFileOutputUnit(item.nativeFile.relativePath, behavior.outputContract),
    );
    const options = closures.flatMap(({ item, semantics }) => {
        const outputUnit = makeEncodedFileOutputUnit(item.nativeFile.relativePath, behavior.outputContract);
        return semantics.map((semantic): SemanticRenderOption => {
            const option = {
                semanticRefFingerprint: semantic.semanticRefFingerprint,
                renderStrategy: "native_graph" as const,
                outcome: "preserved" as const,
                actualReverseExtractPolicy: "can_reconcile" as const,
                approvalRequirement: { approvalState: "not_required" as const },
                requiredOutputUnitFingerprints: [outputUnit.outputUnitFingerprint],
                reasonCode: `native_${behavior.profile.targetScope}_encoded_file_preserved`,
                diagnostics: [] as OperationDiagnostic[],
            };
            return {
                ...option,
                optionFingerprint: computeRenderOptionFingerprint({
                    adapterId: behavior.adapterId,
                    adapterVersion: behavior.adapterVersion,
                    renderInputFingerprint: input.deployment.renderInputFingerprint,
                    providerRenderDialectInputFingerprint: dialectFingerprint,
                    option,
                }),
            };
        });
    });
    return {
        status: "complete",
        outputUnits: outputUnits.sort((left, right) => compareUtf8Bytes(left.outputUnitFingerprint, right.outputUnitFingerprint)),
        semanticOptions: options.sort((left, right) =>
            compareUtf8Bytes(left.semanticRefFingerprint, right.semanticRefFingerprint),
        ),
        blockedSemanticRefs: [],
        diagnostics: [],
    };
}

export function materializeNativeProjectEncodedFile(
    input: RenderMaterializationInput,
    behavior: NativeProjectEncodedFileProviderBehavior,
): RenderMaterializationResult {
    const resolved = findEncodedFileAssets(input, behavior);
    const reanalysis = analyzeNativeProjectEncodedFile(
        {
            schemaVersion: 1,
            deployment: input.deployment,
            requiredSemantics: input.requiredSemantics,
            dialectInputs: input.dialectInputs,
        },
        behavior,
    );
    if (resolved === null || reanalysis.status !== "complete") return blockedMaterialization(behavior);
    const expectedOptions = new Map(reanalysis.semanticOptions.map((option) => [option.semanticRefFingerprint, option]));
    const units = resolved.map((item) => makeEncodedFileOutputUnit(item.nativeFile.relativePath, behavior.outputContract));
    const selectedUnits = new Map(input.selection.outputUnits.map((unit) => [unit.outputUnitFingerprint, unit]));
    const renderers = new Map(input.selection.outputUnitRenderers.map((renderer) => [renderer.outputUnitFingerprint, renderer]));
    const valid =
        selectedUnits.size === units.length &&
        renderers.size === units.length &&
        units.every((unit) => {
            const renderer = renderers.get(unit.outputUnitFingerprint);
            return (
                stableStringify(selectedUnits.get(unit.outputUnitFingerprint)) === stableStringify(unit) &&
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
                option.renderStrategy === "native_graph" &&
                option.actualReverseExtractPolicy === "can_reconcile" &&
                stableStringify(option.requiredOutputUnitFingerprints) ===
                    stableStringify(expected.requiredOutputUnitFingerprints)
            );
        });
    if (!valid) return blockedMaterialization(behavior);
    const materializedUnits = [];
    for (const item of resolved) {
        const unit = makeEncodedFileOutputUnit(item.nativeFile.relativePath, behavior.outputContract);
        const semantics = input.requiredSemantics.filter(
            (semantic) =>
                semantic.subject.assetId === item.asset.version.ref.assetId &&
                semantic.subject.versionId === item.asset.version.ref.versionId,
        );
        const allRefs = semantics.map((semantic) => semantic.semanticRefFingerprint).sort(compareUtf8Bytes);
        const sectionBindings = item.sections.map((section) => ({
            sectionHandle: section.sectionHandle,
            semanticRefFingerprints: canonicalSectionRefs(semantics, item.asset, section),
        }));
        if (sectionBindings.some((binding) => binding.semanticRefFingerprints.length !== 1)) {
            return blockedMaterialization(behavior);
        }
        materializedUnits.push({
            outputUnitFingerprint: unit.outputUnitFingerprint,
            files: [
                {
                    relativePath: item.nativeFile.relativePath,
                    content: { contentKind: "text" as const, text: item.materializedText },
                    executable: false,
                    semanticRefFingerprints: allRefs,
                    sectionBindings,
                },
            ],
        });
    }
    return {
        status: "complete",
        materializationState: "materialized",
        materializedUnits,
        diagnostics: [],
    };
}

export function inspectNativeProjectEncodedFile(
    input: RenderedTargetInspectionInput,
    behavior: NativeProjectEncodedFileProviderBehavior,
): AdapterRenderedTargetInspectionResult {
    if (!isInspectionShape(input)) return blockedInspection(behavior);
    const units = input.appliedRenderSnapshot.outputUnits.filter(
        (unit) =>
            unit.outputContractId === behavior.outputContract.outputContractId &&
            unit.outputContractFingerprint === behavior.outputContract.outputContractFingerprint &&
            unit.claims.length === 1 &&
            unit.claims[0]?.contentKind === "text" &&
            unit.claims[0].executable === false &&
            unit.managedDirectoryBoundaries.length === 0 &&
            stableStringify(unit) ===
                stableStringify(makeEncodedFileOutputUnit(unit.claims[0].relativePath, behavior.outputContract)),
    );
    const [unit] = units;
    const renderers = input.appliedRenderSnapshot.outputUnitRenderers.filter(
        (renderer) =>
            renderer.outputUnitFingerprint === unit?.outputUnitFingerprint &&
            renderer.rendererAdapterId === behavior.adapterId &&
            renderer.rendererAdapterVersion === behavior.adapterVersion &&
            renderer.materializerCapabilityKey === behavior.materializerCapability.materializerCapabilityKey &&
            renderer.materializationProfileId === behavior.profile.materializationProfileId &&
            renderer.profileConstraintFingerprint === behavior.profileConstraintFingerprint,
    );
    const [file] = input.files;
    const state = input.inspectionScope.fileStates.find((candidate) => candidate.relativePath === file?.relativePath);
    if (
        units.length !== 1 ||
        renderers.length !== 1 ||
        input.files.length !== 1 ||
        input.inventoryDeltas.length !== 0 ||
        input.inspectionScope.directoryInventories.length !== 0 ||
        file === undefined ||
        state?.outputUnitFingerprint !== unit?.outputUnitFingerprint ||
        file.fileState !== "baseline_changed" ||
        file.appliedContent.contentKind !== "text" ||
        file.currentContent.contentKind !== "text" ||
        file.attributeChanges.length !== 0 ||
        file.diffHunks.length === 0
    ) {
        return blockedInspection(behavior);
    }
    const sections = sectionDescriptorsForInspection(input, file.provenance.sectionBindings);
    if (sections === null) return blockedInspection(behavior);
    const applied = safeDecodeNativeFile(behavior, file.relativePath, file.appliedContent.text, sections);
    const current = safeDecodeNativeFile(behavior, file.relativePath, file.currentContent.text, sections);
    if (applied === null || current === null) return conflictInspection(file.relativePath, behavior);
    const changes: AttributedSemanticChange[] = [];
    const changedRefs: Sha256Digest[] = [];
    for (const descriptor of sections) {
        const appliedSection = applied.find(
            (section) => section.sectionHandle === descriptor.sectionHandle,
        ) as (typeof applied)[number];
        const currentSection = current.find(
            (section) => section.sectionHandle === descriptor.sectionHandle,
        ) as (typeof current)[number];
        const binding = file.provenance.sectionBindings.find(
            (item) => item.sectionHandle === descriptor.sectionHandle,
        ) as RenderedSectionBinding;
        if (stableStringify(appliedSection.canonicalContent) === stableStringify(currentSection.canonicalContent)) continue;
        const semanticRefFingerprint = binding.semanticRefFingerprints[0] as Sha256Digest;
        const preimage = {
            changeKind: "file_content_replacement" as const,
            semanticRefFingerprints: [semanticRefFingerprint],
            replacementContent: currentSection.canonicalContent,
        };
        changes.push({
            ...preimage,
            changeFingerprint: computeAttributedSemanticChangeFingerprint({
                inspectionScopeFingerprint: input.inspectionScope.inspectionScopeFingerprint,
                change: preimage,
            }),
        });
        changedRefs.push(semanticRefFingerprint);
    }
    if (changes.length === 0) return conflictInspection(file.relativePath, behavior);
    changes.sort((left, right) => compareUtf8Bytes(left.changeFingerprint, right.changeFingerprint));
    changedRefs.sort(compareUtf8Bytes);
    const result: RenderedFileAttributionResult = {
        relativePath: file.relativePath,
        attributionState: "uniquely_attributable",
        changeFingerprints: changes.map((change) => change.changeFingerprint),
        hunkAttributions: file.diffHunks.map((hunk) => ({
            attributionKind: "semantic" as const,
            hunkFingerprint: hunk.hunkFingerprint,
            semanticRefFingerprints: changedRefs,
        })),
        diagnostics: [],
    };
    return { status: "complete", changes, files: [result], diagnostics: [] };
}

function sectionDescriptorsForInspection(
    input: RenderedTargetInspectionInput,
    bindings: RenderedSectionBinding[],
): EncodedCanonicalSectionDescriptor[] | null {
    const sections = bindings.flatMap((binding): EncodedCanonicalSectionDescriptor[] => {
        if (binding.semanticRefFingerprints.length !== 1) return [];
        const decisions = input.appliedRenderSnapshot.decisions.filter(
            (decision) => decision.semanticRef.semanticRefFingerprint === binding.semanticRefFingerprints[0],
        );
        const semanticKind = decisions[0]?.semanticRef.semanticKind;
        return decisions.length === 1 &&
            (semanticKind === "subagent.invoked_context" || semanticKind === "subagent.resource") &&
            decisions[0]?.semanticRef.subject.subjectKind === "file"
            ? [{ sectionHandle: binding.sectionHandle, semanticKind }]
            : [];
    });
    return sections.length === bindings.length &&
        sections.length >= 1 &&
        sections.length <= 2 &&
        new Set(sections.map((section) => section.sectionHandle)).size === sections.length &&
        new Set(sections.map((section) => section.semanticKind)).size === sections.length
        ? sections.sort((left, right) => compareUtf8Bytes(left.sectionHandle, right.sectionHandle))
        : null;
}

function isInspectionShape(input: RenderedTargetInspectionInput): boolean {
    return (
        Array.isArray(input.files) &&
        Array.isArray(input.inventoryDeltas) &&
        Array.isArray(input.appliedRenderSnapshot?.outputUnits) &&
        Array.isArray(input.appliedRenderSnapshot?.outputUnitRenderers) &&
        Array.isArray(input.appliedRenderSnapshot?.decisions) &&
        Array.isArray(input.inspectionScope?.fileStates)
    );
}

function blockedAnalysis(
    input: RenderAnalysisInput,
    behavior: NativeProjectEncodedFileProviderBehavior,
): AdapterRenderAnalysisResult {
    const issue = encodedFileDiagnostic(behavior, "encoded native file requires one complete Subagent graph");
    return {
        status: "failed",
        outputUnits: [],
        semanticOptions: [],
        blockedSemanticRefs: input.requiredSemantics.map((semantic) => ({
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            reasonCode: `native_${behavior.profile.targetScope}_encoded_file_not_applicable`,
            diagnostics: [issue],
        })),
        diagnostics: [issue],
    };
}

function blockedMaterialization(behavior: NativeProjectEncodedFileProviderBehavior): RenderMaterializationResult {
    const issue = encodedFileDiagnostic(behavior, "encoded native file materialization is invalid");
    return {
        status: "failed",
        materializationState: "blocked",
        reasonCode: `native_${behavior.profile.targetScope}_encoded_file_materialization_invalid`,
        diagnostics: [issue],
    };
}

function blockedInspection(behavior: NativeProjectEncodedFileProviderBehavior): AdapterRenderedTargetInspectionResult {
    return {
        status: "failed",
        changes: [],
        files: [],
        diagnostics: [encodedFileDiagnostic(behavior, "encoded native file inspection is invalid")],
    };
}

function conflictInspection(
    relativePath: string,
    behavior: NativeProjectEncodedFileProviderBehavior,
): AdapterRenderedTargetInspectionResult {
    const issue = encodedFileDiagnostic(behavior, "changed encoded native file cannot be safely decoded", "warning");
    return {
        status: "complete",
        changes: [],
        files: [
            {
                relativePath: relativePath as never,
                attributionState: "conflict",
                reasonCode: `native_${behavior.profile.targetScope}_encoded_file_change_not_reconcilable`,
                diagnostics: [issue],
            },
        ],
        diagnostics: [issue],
    };
}
