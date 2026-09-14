/** Current-exact scoped graph analysis, materialization, and inspection behavior. */

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
    ChangedRenderedTargetFileInput,
    RenderedFileAttributionResult,
    RenderedTargetInspectionInput,
} from "../contracts/reverse";
import type { AdapterNativeExactGraphRenderDeclarationV1, AdapterProviderSummary } from "../contracts/source-import";
import {
    computeAttributedSemanticChangeFingerprint,
    computeProviderRenderDialectInputFingerprint,
    computeRenderApprovalFingerprint,
    computeRenderDegradationFingerprint,
    computeRenderOptionFingerprint,
    computeRenderOutputUnitFingerprint,
    computeReverseInspectionCoverageFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { isSha256Digest } from "../foundation/validators";
import type { OperationDiagnostic, PosixRelativePath, Sha256Digest } from "../types";
import { makeExactGraphMaterializationValidator } from "./native-project-exact-graph-materialization-validator";
import {
    makeExactGraphApplicabilityPredicateRef,
    makeExactGraphConsumerConformance,
    makeNativeProjectExactGraphContractParts,
    type NativeProjectExactGraphProfileDefinition,
    type VerifiedNativeExactGraphBuild,
} from "./native-project-exact-graph-profiles";
import {
    canonicalPathForNativeGraphFile,
    exactGraphDiagnostic,
    findExactGraphAssets,
    graphSemanticRefs,
    hasExactGraphBoundaryClosure,
    hasExactGraphSemanticClosure,
    makeExactGraphOutputUnit,
    type NativeProjectExactGraphProviderBehavior,
    type NativeProjectExactGraphResolvedAsset,
    safeGraphReverseParse,
} from "./native-project-exact-graph-results";
import { compareUtf8Bytes, diagnostic, PLATFORM_FACT_KEY, PROJECT_BINDING_FACT_KEY } from "./native-project-guidance-profiles";
import { trustedNonProjectTargetFactEvidence } from "./native-project-target-authority";
import { trustedProjectEvidence } from "./native-project-target-evidence";
import type {
    RenderRegistryConfiguration,
    ReverseInspectionValidatorImplementation,
    TargetApplicabilityPredicateImplementation,
} from "./render-registry";
import { resolveTargetBuildCompatibility } from "./target-build-compatibility";
import {
    findCanonicalMaterializationValidator,
    validateCanonicalMaterializationContributions,
    snapshotCanonicalMaterializationValidators,
    type CanonicalMaterializationValidatorsByAdapter,
} from "./canonical-materialization-validation";

function makeApplicabilityPredicate(
    declaration: AdapterNativeExactGraphRenderDeclarationV1,
    build: VerifiedNativeExactGraphBuild,
): TargetApplicabilityPredicateImplementation {
    const profile = makeNativeProjectExactGraphContractParts(declaration).profile;
    return {
        ref: makeExactGraphApplicabilityPredicateRef(build, profile.targetScope, declaration.buildCompatibility),
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

export function nativeProjectExactGraphRegistryComponents(
    providers: readonly AdapterProviderSummary[],
    canonicalValidators: CanonicalMaterializationValidatorsByAdapter = new Map(),
): Pick<
    RenderRegistryConfiguration,
    | "canonicalMaterializationValidators"
    | "outputContracts"
    | "consumerConformances"
    | "targetApplicabilityPredicates"
    | "materializationValidators"
    | "reverseInspectionValidators"
> {
    const frozenValidators = new Map(
        [...canonicalValidators].map(
            ([adapterId, validators]) => [adapterId, snapshotCanonicalMaterializationValidators(validators)] as const,
        ),
    );
    validateCanonicalMaterializationContributions(providers, frozenValidators);
    const declarations = providers.flatMap((provider) =>
        provider.renderContractDeclarations
            .filter(
                (declaration): declaration is AdapterNativeExactGraphRenderDeclarationV1 =>
                    declaration.declarationKind === "native_project_exact_graph_v1" ||
                    declaration.declarationKind === "native_global_exact_graph_v1",
            )
            .map((declaration) => ({ provider, declaration })),
    );
    const parts = declarations.map(({ provider, declaration }) => ({
        ...makeNativeProjectExactGraphContractParts(declaration),
        provider,
        declaration,
    }));
    return {
        canonicalMaterializationValidators: frozenValidators,
        outputContracts: parts.map(({ outputContract }) => outputContract),
        consumerConformances: declarations.flatMap(({ provider, declaration }) =>
            declaration.verifiedBuilds.map((build) => makeExactGraphConsumerConformance(provider, declaration, build)),
        ),
        targetApplicabilityPredicates: declarations.flatMap(({ declaration }) =>
            declaration.verifiedBuilds.map((build) => makeApplicabilityPredicate(declaration, build)),
        ),
        materializationValidators: parts.map(({ provider, declaration, profile, components }) =>
            makeExactGraphMaterializationValidator(
                profile,
                components.materialize,
                declaration.canonicalMaterialization === undefined
                    ? undefined
                    : findCanonicalMaterializationValidator(frozenValidators, provider.adapterId, {
                          ...declaration,
                          materializer: declaration.canonicalMaterialization.materializer,
                      }),
            ),
        ),
        reverseInspectionValidators: parts.map(({ profile, components }) => makeReverseValidator(profile, components.reverse)),
    };
}

function makeReverseValidator(
    profile: NativeProjectExactGraphProfileDefinition,
    ref: ReverseInspectionValidatorImplementation["ref"],
): ReverseInspectionValidatorImplementation {
    return {
        ref,
        validate(input) {
            const results = new Map(input.adapterResult.files.map((file) => [file.relativePath, file]));
            const changes = new Map(input.adapterResult.changes.map((change) => [change.changeFingerprint, change]));
            const referenced = new Set<string>();
            const valid = input.files.every((file) => {
                const result = results.get(file.relativePath);
                if (result?.attributionState === "conflict") return true;
                if (file.fileState !== "baseline_changed" || result?.attributionState !== "uniquely_attributable") return false;
                const fileChanges = result.changeFingerprints.map((fingerprint) => changes.get(fingerprint));
                const contentChanges = fileChanges.filter((change) => change?.changeKind === "file_content_replacement");
                const executableChanges = fileChanges.filter((change) => change?.changeKind === "file_executable_replacement");
                const contentChanged = file.diffHunks.length > 0;
                const executableChanged = file.attributeChanges.length === 1;
                const hunksValid =
                    result.hunkAttributions.length === file.diffHunks.length &&
                    result.hunkAttributions.every((attribution) => attribution.semanticRefFingerprints.length === 1);
                const validChanges =
                    contentChanges.length === (contentChanged ? 1 : 0) &&
                    executableChanges.length === (executableChanged ? 1 : 0) &&
                    fileChanges.length === contentChanges.length + executableChanges.length;
                if (hunksValid && validChanges) for (const fingerprint of result.changeFingerprints) referenced.add(fingerprint);
                return hunksValid && validChanges;
            });
            if (
                !valid ||
                results.size !== input.files.length ||
                results.size !== input.adapterResult.files.length ||
                changes.size !== input.adapterResult.changes.length ||
                referenced.size !== changes.size
            ) {
                throw new Error(
                    `native ${profile.targetScope} exact-graph reverse result violates its ${profile.assetKind} policy`,
                );
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
                coveredInventoryDeltaFingerprints: input.inventoryDeltas
                    .map((delta) => delta.inventoryDeltaFingerprint)
                    .sort(compareUtf8Bytes),
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

export function analyzeNativeProjectExactGraph(
    input: RenderAnalysisInput,
    behavior: NativeProjectExactGraphProviderBehavior,
): AdapterRenderAnalysisResult {
    const resolved = findExactGraphAssets(input, behavior);
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
    if (closures.some(({ item, semantics }) => !hasExactGraphSemanticClosure(semantics, item.asset))) {
        return blockedAnalysis(input, behavior);
    }
    const dialectFingerprint = computeProviderRenderDialectInputFingerprint({
        adapterId: behavior.adapterId,
        adapterVersion: behavior.adapterVersion,
        dialectInputs: input.dialectInputs,
    });
    const outputUnits = closures.map(({ item }) => makeExactGraphOutputUnit(item, behavior.outputContract));
    const options = closures.flatMap(({ item, semantics }) => {
        const outputUnit = makeExactGraphOutputUnit(item, behavior.outputContract);
        return semantics.map((semantic): SemanticRenderOption => {
            const base = {
                semanticRefFingerprint: semantic.semanticRefFingerprint,
                renderStrategy: "native_graph" as const,
                actualReverseExtractPolicy: "can_reconcile" as const,
                requiredOutputUnitFingerprints: [outputUnit.outputUnitFingerprint],
                ...(item.canonicalMaterialization?.substituteAssetKind === undefined
                    ? {}
                    : { substituteAssetKind: item.canonicalMaterialization.substituteAssetKind }),
                reasonCode:
                    item.canonicalMaterialization === null
                        ? exactGraphReasonCode(behavior, "preserved")
                        : item.canonicalMaterialization.reasonCode,
            };
            if (item.canonicalMaterialization === null || item.canonicalMaterialization.degradationKinds.length === 0) {
                const option = {
                    ...base,
                    outcome: "preserved" as const,
                    approvalRequirement: { approvalState: "not_required" as const },
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
            }
            const option = canonicalMigrationOption(
                input,
                behavior,
                item.canonicalMaterialization,
                item.canonicalMaterializer,
                base,
            );
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

function canonicalMigrationOption(
    input: RenderAnalysisInput,
    behavior: NativeProjectExactGraphProviderBehavior,
    canonical: NonNullable<NativeProjectExactGraphResolvedAsset["canonicalMaterialization"]>,
    implementation: NonNullable<NativeProjectExactGraphProviderBehavior["canonicalMaterializer"]>,
    base: {
        semanticRefFingerprint: Sha256Digest;
        renderStrategy: "native_graph";
        actualReverseExtractPolicy: "can_reconcile";
        requiredOutputUnitFingerprints: Sha256Digest[];
        reasonCode: string;
    },
): Omit<Extract<SemanticRenderOption, { outcome: "degraded" }>, "optionFingerprint"> {
    const outcome = {
        outcome: "degraded" as const,
        degradationKinds: structuredClone(canonical.degradationKinds) as Extract<
            SemanticRenderOption,
            { outcome: "degraded" }
        >["degradationKinds"],
        degradationFingerprint: "" as Sha256Digest,
    };
    outcome.degradationFingerprint = computeRenderDegradationFingerprint({
        adapterId: behavior.adapterId,
        adapterVersion: behavior.adapterVersion,
        renderInputFingerprint: input.deployment.renderInputFingerprint,
        semanticRefFingerprint: base.semanticRefFingerprint,
        renderStrategy: base.renderStrategy,
        outcome,
        actualReverseExtractPolicy: base.actualReverseExtractPolicy,
        reasonCode: base.reasonCode,
    });
    const concerns: ["semantic_degradation"] = ["semantic_degradation"];
    return {
        ...base,
        ...outcome,
        approvalRequirement: {
            approvalState: "required",
            concerns,
            approvalFingerprint: computeRenderApprovalFingerprint({
                renderInputFingerprint: input.deployment.renderInputFingerprint,
                semanticRefFingerprint: base.semanticRefFingerprint,
                renderStrategy: base.renderStrategy,
                outcome,
                actualReverseExtractPolicy: base.actualReverseExtractPolicy,
                concerns,
            }),
        },
        diagnostics: [
            diagnostic(
                "render",
                "render.canonical_conversion_review_required",
                implementation.diagnosticMessage,
                "partial",
                "warning",
            ),
        ],
    };
}

export function materializeNativeProjectExactGraph(
    input: RenderMaterializationInput,
    behavior: NativeProjectExactGraphProviderBehavior,
): RenderMaterializationResult {
    const resolved = findExactGraphAssets(input, behavior);
    const reanalysis = analyzeNativeProjectExactGraph(
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
    const units = resolved.map((item) => makeExactGraphOutputUnit(item, behavior.outputContract));
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
                selectedOutcomeMatchesExpected(option, expected) &&
                option.renderStrategy === "native_graph" &&
                option.actualReverseExtractPolicy === "can_reconcile" &&
                stableStringify(option.requiredOutputUnitFingerprints) ===
                    stableStringify(expected.requiredOutputUnitFingerprints)
            );
        });
    if (!valid) return blockedMaterialization(behavior);
    return {
        status: "complete",
        materializationState: "materialized",
        materializedUnits: resolved.map((item) => {
            const unit = makeExactGraphOutputUnit(item, behavior.outputContract);
            const semantics = input.requiredSemantics.filter(
                (semantic) =>
                    semantic.subject.assetId === item.asset.version.ref.assetId &&
                    semantic.subject.versionId === item.asset.version.ref.versionId,
            );
            return {
                outputUnitFingerprint: unit.outputUnitFingerprint,
                files: item.nativeFiles.map((file) => {
                    const logicalPath = canonicalPathForNativeGraphFile(item.projection, file.relativePath);
                    const patch = behavior.profile.jsoncTopLevelPropertyPatch;
                    const isPatch = patch?.allowedContainerRelativePaths.includes(file.relativePath) ?? false;
                    return {
                        relativePath: file.relativePath,
                        content:
                            file.contentKind === "text"
                                ? { contentKind: "text" as const, text: file.text }
                                : { contentKind: "binary" as const, bytes: new Uint8Array(file.bytes) },
                        executable: file.executable,
                        semanticRefFingerprints: graphSemanticRefs(semantics, item.asset, logicalPath),
                        sectionBindings: [],
                        ...(isPatch
                            ? {
                                  containerPatch: {
                                      patchKind: "jsonc_top_level_property_value" as const,
                                      propertyName: patch?.propertyName as string,
                                  },
                              }
                            : {}),
                    };
                }),
            };
        }),
        diagnostics: [],
    };
}

function selectedOutcomeMatchesExpected(
    selected: RenderMaterializationInput["selection"]["semanticOptions"][number],
    expected: SemanticRenderOption,
): boolean {
    return (
        selected.outcome === expected.outcome &&
        (selected.outcome === "preserved" ||
            (expected.outcome === "degraded" && selected.degradationFingerprint === expected.degradationFingerprint))
    );
}

export function inspectNativeProjectExactGraph(
    input: RenderedTargetInspectionInput,
    behavior: NativeProjectExactGraphProviderBehavior,
): AdapterRenderedTargetInspectionResult {
    if (!isInspectionShape(input)) return blockedInspection(behavior);
    const units = input.appliedRenderSnapshot.outputUnits.filter(
        (unit) =>
            unit.outputContractId === behavior.outputContract.outputContractId &&
            unit.outputContractFingerprint === behavior.outputContract.outputContractFingerprint &&
            unit.outputUnitFingerprint ===
                computeRenderOutputUnitFingerprint({
                    outputContractId: unit.outputContractId,
                    outputContractFingerprint: unit.outputContractFingerprint,
                    claims: unit.claims,
                    managedDirectoryBoundaries: unit.managedDirectoryBoundaries,
                }) &&
            unit.claims.length >= 1 &&
            unit.managedDirectoryBoundaries.every((boundary) => boundary.boundaryKind === "directory_inventory") &&
            hasExactGraphBoundaryClosure(
                unit.claims.map((claim) => claim.relativePath),
                unit.managedDirectoryBoundaries.map((boundary) => boundary.relativePath),
                behavior.profile.jsoncTopLevelPropertyPatch !== undefined,
            ),
    );
    const unitByFingerprint = new Map(units.map((unit) => [unit.outputUnitFingerprint, unit]));
    const renderers = input.appliedRenderSnapshot.outputUnitRenderers.filter(
        (renderer) =>
            unitByFingerprint.has(renderer.outputUnitFingerprint) &&
            renderer.rendererAdapterId === behavior.adapterId &&
            renderer.rendererAdapterVersion === behavior.adapterVersion &&
            renderer.materializerCapabilityKey === behavior.materializerCapability.materializerCapabilityKey &&
            renderer.materializationProfileId === behavior.profile.materializationProfileId &&
            renderer.profileConstraintFingerprint === behavior.profileConstraintFingerprint,
    );
    if (
        units.length === 0 ||
        renderers.length !== units.length ||
        new Set(renderers.map((renderer) => renderer.outputUnitFingerprint)).size !== units.length ||
        input.inspectionScope.fileStates.some((state) => !unitByFingerprint.has(state.outputUnitFingerprint)) ||
        input.files.some((file) => !unitByFingerprint.has(outputUnitForFile(input, file)))
    ) {
        return blockedInspection(behavior);
    }
    const changes: AttributedSemanticChange[] = [];
    const files = input.files.map((file): RenderedFileAttributionResult => {
        const unitFingerprint = outputUnitForFile(input, file);
        const fileDecision = fileSemanticDecision(input, file, unitFingerprint);
        const inventoryDecision = inventorySemanticDecision(input, fileDecision, unitFingerprint);
        if (
            file.fileState !== "baseline_changed" ||
            file.provenance.sectionBindings.length !== 0 ||
            fileDecision === null ||
            inventoryDecision === null
        ) {
            return conflict(file.relativePath, behavior, exactGraphReasonCode(behavior, "inventory_change_not_reconcilable"));
        }
        const fileChanges: AttributedSemanticChange[] = [];
        const contentChanged = file.diffHunks.length > 0;
        if (contentChanged) {
            const parsed = safeGraphReverseParse(behavior, file.relativePath, file.appliedContent, file.currentContent);
            if (parsed === null || parsed.canonicalContent.contentKind !== file.appliedContent.contentKind) {
                return conflict(file.relativePath, behavior, exactGraphReasonCode(behavior, "content_not_reconcilable"));
            }
            const preimage = {
                changeKind: "file_content_replacement" as const,
                semanticRefFingerprints: [fileDecision.semanticRef.semanticRefFingerprint],
                replacementContent: parsed.canonicalContent,
            };
            fileChanges.push({
                ...preimage,
                changeFingerprint: computeAttributedSemanticChangeFingerprint({
                    inspectionScopeFingerprint: input.inspectionScope.inspectionScopeFingerprint,
                    change: preimage,
                }),
            });
        }
        const executableChange = file.attributeChanges[0];
        if (file.attributeChanges.length === 1 && executableChange !== undefined) {
            const subject = fileDecision.semanticRef.subject as Extract<
                typeof fileDecision.semanticRef.subject,
                { subjectKind: "file" }
            >;
            const preimage = {
                changeKind: "file_executable_replacement" as const,
                semanticRefFingerprints: [inventoryDecision.semanticRef.semanticRefFingerprint],
                fileId: subject.fileId,
                executable: executableChange.currentValue,
            };
            fileChanges.push({
                ...preimage,
                changeFingerprint: computeAttributedSemanticChangeFingerprint({
                    inspectionScopeFingerprint: input.inspectionScope.inspectionScopeFingerprint,
                    change: preimage,
                }),
            });
        }
        if (fileChanges.length === 0) {
            return conflict(file.relativePath, behavior, exactGraphReasonCode(behavior, "change_missing"));
        }
        changes.push(...fileChanges);
        const contentRef = [fileDecision.semanticRef.semanticRefFingerprint];
        return {
            relativePath: file.relativePath,
            attributionState: "uniquely_attributable",
            changeFingerprints: fileChanges.map((change) => change.changeFingerprint).sort(compareUtf8Bytes),
            hunkAttributions: file.diffHunks.map((hunk) => ({
                attributionKind: "semantic" as const,
                hunkFingerprint: hunk.hunkFingerprint,
                semanticRefFingerprints: contentRef,
            })),
            diagnostics: [],
        };
    });
    changes.sort((left, right) => compareUtf8Bytes(left.changeFingerprint, right.changeFingerprint));
    files.sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
    return { status: "complete", changes, files, diagnostics: files.flatMap((file) => file.diagnostics) };
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

function outputUnitForFile(input: RenderedTargetInspectionInput, file: ChangedRenderedTargetFileInput): Sha256Digest {
    return (
        input.inspectionScope.fileStates.find((state) => state.relativePath === file.relativePath)?.outputUnitFingerprint ??
        ("" as Sha256Digest)
    );
}

function fileSemanticDecision(
    input: RenderedTargetInspectionInput,
    file: ChangedRenderedTargetFileInput,
    unitFingerprint: Sha256Digest,
) {
    if (file.fileState === "added_managed_descendant") return null;
    const refs = new Set(file.provenance.semanticRefFingerprints);
    const matches = input.appliedRenderSnapshot.decisions.filter(
        (decision) =>
            decision.semanticRef.subject.subjectKind === "file" &&
            decision.outputUnitFingerprints.includes(unitFingerprint) &&
            refs.has(decision.semanticRef.semanticRefFingerprint),
    );
    return matches.length === 1 ? (matches[0] as (typeof matches)[number]) : null;
}

function inventorySemanticDecision(
    input: RenderedTargetInspectionInput,
    fileDecision: ReturnType<typeof fileSemanticDecision>,
    unitFingerprint: Sha256Digest,
) {
    const subject = fileDecision?.semanticRef.subject;
    if (subject?.subjectKind !== "file") return null;
    const matches = input.appliedRenderSnapshot.decisions.filter(
        (decision) =>
            decision.semanticRef.semanticKind === "asset.file_inventory" &&
            decision.semanticRef.subject.subjectKind === "asset" &&
            decision.semanticRef.subject.assetId === subject.assetId &&
            decision.semanticRef.subject.versionId === subject.versionId &&
            decision.outputUnitFingerprints.includes(unitFingerprint),
    );
    return matches.length === 1 ? (matches[0] as (typeof matches)[number]) : null;
}

function conflict(
    relativePath: PosixRelativePath,
    behavior: NativeProjectExactGraphProviderBehavior,
    reasonCode: string,
): RenderedFileAttributionResult {
    return {
        relativePath,
        attributionState: "conflict",
        reasonCode,
        diagnostics: [exactGraphDiagnostic(behavior, "changed native graph cannot be safely reconciled", "warning")],
    };
}

function blockedAnalysis(
    input: RenderAnalysisInput,
    behavior: NativeProjectExactGraphProviderBehavior,
): AdapterRenderAnalysisResult {
    const issue = exactGraphDiagnostic(
        behavior,
        `native ${behavior.profile.targetScope} exact-graph target requires one complete validated graph`,
    );
    return {
        status: "failed",
        outputUnits: [],
        semanticOptions: [],
        blockedSemanticRefs: input.requiredSemantics.map((semantic) => ({
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            reasonCode: exactGraphReasonCode(behavior, "not_applicable"),
            diagnostics: [issue],
        })),
        diagnostics: [issue],
    };
}

function blockedMaterialization(behavior: NativeProjectExactGraphProviderBehavior): RenderMaterializationResult {
    return {
        status: "failed",
        materializationState: "blocked",
        reasonCode: exactGraphReasonCode(behavior, "materialization_invalid"),
        diagnostics: [exactGraphDiagnostic(behavior, "exact-graph materialization is outside the selected graph closure")],
    };
}

function exactGraphReasonCode(behavior: NativeProjectExactGraphProviderBehavior, suffix: string): string {
    return `native_${behavior.profile.targetScope}_exact_graph_${suffix}`;
}

function blockedInspection(behavior: NativeProjectExactGraphProviderBehavior): AdapterRenderedTargetInspectionResult {
    return {
        status: "failed",
        changes: [],
        files: [],
        diagnostics: [exactGraphDiagnostic(behavior, "exact-graph inspection is outside the applied graph closure")],
    };
}
