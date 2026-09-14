/** Core-owned materialization orchestration and receipt validation. */
import { normalizeText } from "../catalog/payload-store";
import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import type {
    MaterializationSemanticCoverageProof,
    RenderOutputUnit,
    RequiredRenderSemantic,
    SelectedOutputUnitRenderer,
} from "../contracts/deployment-authority";
import type {
    CanonicalRenderSemanticValue,
    MaterializationSafeRenderSelection,
    MaterializationSafeSelectedSemanticOption,
    MaterializedRenderFile,
    ProviderRenderDialectInputsForAsset,
    RenderAnalysisView,
    RenderDeploymentInput,
    RenderMaterializationInput,
    RenderMaterializationResult,
    ResolvedCoreRenderSelection,
} from "../contracts/render";
import { completeResult } from "../foundation/core-result";
import {
    computeMaterializationFingerprint,
    computeProviderRenderDialectInputFingerprint,
    computeRenderSelectionFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isCanonicalRelativePath, isSha256Digest } from "../foundation/validators";
import type { AdapterProviderSummary, CoreResult, OperationDiagnostic, Sha256Digest } from "../types";
import { isExactFileNativeConsistencySatisfied } from "./native-project-exact-file-consistency";
import { isExactGraphNativeConsistencySatisfied } from "./native-project-exact-graph-consistency";
import { canonicalValueForSemantic, isMaterializationCoverageProofBound } from "./render-materialization-coverage";
import { validateAnalysisView, validateDialectInputProjection } from "./render-analysis";
import {
    declaredJsoncTopLevelPropertyPatch,
    isDeclaredJsoncContainerPatch,
    isExactJsoncContainerPatchClosure,
    type JsoncTopLevelPropertyPatchDeclaration,
} from "./render-container-patch-receipt";
import { projectProviderTargetFileSnapshots } from "./render-dialect-authority";
import { projectRenderDialectInputs } from "./render-dialect-scope";
import {
    MaterializationFailure,
    type MaterializationSelectionAuthority,
    resolvedSelectionAuthority,
    validateObservationMaterializationClosure,
} from "./render-materialization-authority";
import type {
    CoreMaterializedOutputUnit,
    CoreRenderMaterializationView,
    MaterializeRenderDeploymentConfiguration,
} from "./render-materialization-contract";
import type { RenderRegistrySnapshot } from "./render-registry";
import { versionRefKey } from "./render-semantics";

export type {
    CoreMaterializedOutputUnit,
    CoreRenderMaterializationView,
    MaterializeRenderDeploymentConfiguration,
} from "./render-materialization-contract";

export async function materializeRenderDeployment(
    sourceInput: {
        deployment: RenderDeploymentInput;
        analysis: RenderAnalysisView;
        selection: ResolvedCoreRenderSelection;
    },
    configuration: MaterializeRenderDeploymentConfiguration,
): Promise<CoreResult<CoreRenderMaterializationView>> {
    try {
        const input = structuredClone(sourceInput);
        configuration = Object.freeze({ ...configuration });
        validateMaterializationClosure(input, configuration.registry);
        return await materializeValidatedSelection(
            input.deployment,
            input.analysis,
            resolvedSelectionAuthority(input.selection),
            configuration,
        );
    } catch (error) {
        return failed(error);
    }
}

/** Read-only exact-target materialization; its input cannot carry write authority. */
export async function materializeRenderObservation(
    sourceInput: {
        deployment: RenderDeploymentInput;
        analysis: RenderAnalysisView;
        observationSelection: MaterializationSelectionAuthority;
    },
    configuration: MaterializeRenderDeploymentConfiguration,
): Promise<CoreResult<CoreRenderMaterializationView>> {
    try {
        const input = structuredClone(sourceInput);
        configuration = Object.freeze({ ...configuration });
        validateObservationMaterializationClosure(input, configuration.registry);
        return await materializeValidatedSelection(input.deployment, input.analysis, input.observationSelection, configuration);
    } catch (error) {
        return failed(error);
    }
}

async function materializeValidatedSelection(
    deployment: RenderDeploymentInput,
    analysis: RenderAnalysisView,
    authority: MaterializationSelectionAuthority,
    configuration: MaterializeRenderDeploymentConfiguration,
): Promise<CoreResult<CoreRenderMaterializationView>> {
    if (authority.selection.outputUnits.length === 0) {
        return completeResult({
            schemaVersion: 1,
            renderInputFingerprint: deployment.renderInputFingerprint,
            selectionFingerprint: authority.selectionFingerprint,
            units: [],
        });
    }

    const groups = groupUnitsByRenderer(authority.selection);
    const units: CoreMaterializedOutputUnit[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    for (const group of groups) {
        const provider = configuration.registry.getProvider(group.adapterId);
        if (provider === null || provider.version !== group.adapterVersion) {
            throw new MaterializationFailure(
                "render.materializer_stale",
                `selected materializer is unavailable: ${group.adapterId}`,
                "unavailable",
                true,
            );
        }
        const semantics = semanticsForUnits({ analysis, selection: authority.selection }, group.unitFingerprints);
        const dialectInputs = structuredClone(
            configuration.resolveDialectInputs(provider, structuredClone(deployment), structuredClone(semantics)),
        );
        validateMaterializationDialectProjection(dialectInputs, deployment, semantics);
        const providerDialectFingerprint = computeProviderRenderDialectInputFingerprint({
            adapterId: provider.adapterId,
            adapterVersion: provider.version,
            dialectInputs,
        });
        const providerInput = buildProviderInput(
            deployment,
            authority.selection,
            semantics,
            dialectInputs,
            group.unitFingerprints,
        );
        const dispatched = await configuration.dispatch(provider.adapterId, structuredClone(providerInput));
        diagnostics.push(...dispatched.diagnostics);
        if (
            dispatched.status !== "complete" ||
            dispatched.value.materializationState !== "materialized" ||
            dispatched.value.status !== "complete"
        ) {
            return failed(
                new MaterializationFailure(
                    "render.materialization_blocked",
                    `renderer did not produce one complete atomic materialization: ${provider.adapterId}`,
                    dispatched.status === "failed" ? "unavailable" : "partial",
                    dispatched.status !== "failed",
                ),
                diagnostics,
            );
        }
        const providerResult = structuredClone(dispatched.value);
        units.push(
            ...validateProviderReceipts({
                deployment,
                selection: authority.selection,
                selectionFingerprint: authority.selectionFingerprint,
                semantics,
                provider,
                dialectInputs,
                providerDialectFingerprint,
                result: providerResult,
                unitFingerprints: group.unitFingerprints,
                registry: configuration.registry,
                dialectRegistry: configuration.dialectRegistry,
            }),
        );
    }
    const sortedUnits = units.sort((left, right) =>
        compareUtf8Bytes(left.outputUnit.outputUnitFingerprint, right.outputUnit.outputUnitFingerprint),
    );
    requireExactSet(
        sortedUnits.map((unit) => unit.outputUnit.outputUnitFingerprint),
        authority.selection.outputUnits.map((unit) => unit.outputUnitFingerprint),
        "materialized unit closure",
    );
    return {
        status: "complete",
        value: {
            schemaVersion: 1,
            renderInputFingerprint: deployment.renderInputFingerprint,
            selectionFingerprint: authority.selectionFingerprint,
            units: sortedUnits,
        },
        diagnostics,
    };
}

function validateMaterializationClosure(
    input: {
        deployment: RenderDeploymentInput;
        analysis: RenderAnalysisView;
        selection: ResolvedCoreRenderSelection;
    },
    registry: RenderRegistrySnapshot,
): void {
    if (
        input.deployment.renderRegistryFingerprint !== registry.fingerprint ||
        input.analysis.renderInputFingerprint !== input.deployment.renderInputFingerprint ||
        input.selection.renderInputFingerprint !== input.deployment.renderInputFingerprint ||
        input.selection.schemaVersion !== 1 ||
        input.selection.compilerPolicyVersion !== "core_render_policy_v1"
    ) {
        throw new MaterializationFailure(
            "render.materialization_input_stale",
            "materialization input does not share one fresh render authority",
            "conflict",
            true,
        );
    }
    validateAnalysisView(input.analysis, input.deployment, registry);
    const { selectionFingerprint: _stored, schemaVersion: _schemaVersion, ...selectionPreimage } = input.selection;
    if (computeRenderSelectionFingerprint(selectionPreimage) !== input.selection.selectionFingerprint) {
        throw new MaterializationFailure(
            "render.materialization_selection_fingerprint_mismatch",
            "materialization selection fingerprint is stale",
            "conflict",
            true,
        );
    }
    requireExactSet(
        input.selection.semanticOptions.map((option) => option.semanticRefFingerprint),
        input.analysis.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint),
        "selected semantic closure",
    );
    requireExactSet(
        input.selection.outputUnitRenderers.map((renderer) => renderer.outputUnitFingerprint),
        input.selection.outputUnits.map((unit) => unit.outputUnitFingerprint),
        "selected renderer closure",
    );
}

function groupUnitsByRenderer(selection: MaterializationSafeRenderSelection): Array<{
    adapterId: string;
    adapterVersion: string;
    unitFingerprints: Set<string>;
}> {
    const groups = new Map<string, { adapterId: string; adapterVersion: string; unitFingerprints: Set<string> }>();
    for (const renderer of selection.outputUnitRenderers) {
        const key = `${renderer.rendererAdapterId}\0${renderer.rendererAdapterVersion}`;
        const group = groups.get(key) ?? {
            adapterId: renderer.rendererAdapterId,
            adapterVersion: renderer.rendererAdapterVersion,
            unitFingerprints: new Set<string>(),
        };
        group.unitFingerprints.add(renderer.outputUnitFingerprint);
        groups.set(key, group);
    }
    // outputUnitRenderers is already a canonical sorted closure; Map insertion
    // order therefore gives deterministic provider dispatch without a second key.
    return [...groups.values()];
}

function semanticsForUnits(
    input: { analysis: RenderAnalysisView; selection: MaterializationSafeRenderSelection },
    unitFingerprints: ReadonlySet<string>,
): RequiredRenderSemantic[] {
    const selectedRefs = new Set(
        input.selection.semanticOptions
            .filter((option) => option.requiredOutputUnitFingerprints.some((unit) => unitFingerprints.has(unit)))
            .map((option) => option.semanticRefFingerprint),
    );
    return input.analysis.requiredSemantics
        .filter((semantic) => selectedRefs.has(semantic.semanticRefFingerprint))
        .sort((left, right) => compareUtf8Bytes(left.semanticRefFingerprint, right.semanticRefFingerprint));
}

function buildProviderInput(
    deployment: RenderDeploymentInput,
    selection: MaterializationSafeRenderSelection,
    semantics: RequiredRenderSemantic[],
    dialectInputs: ProviderRenderDialectInputsForAsset[],
    unitFingerprints: ReadonlySet<string>,
): RenderMaterializationInput {
    const consumerIds = new Set(semantics.map((semantic) => semantic.consumerAgentRuntimeId));
    const assetIds = new Set([
        ...semantics.map((semantic) => semantic.subject.assetId),
        ...dialectInputs.map((group) => group.targetVersion.assetId),
    ]);
    const units = selection.outputUnits.filter((unit) => unitFingerprints.has(unit.outputUnitFingerprint));
    const renderers = selection.outputUnitRenderers.filter((renderer) => unitFingerprints.has(renderer.outputUnitFingerprint));
    const options = selection.semanticOptions
        .filter((option) => option.requiredOutputUnitFingerprints.some((unit) => unitFingerprints.has(unit)))
        .map(
            (option): MaterializationSafeSelectedSemanticOption => ({
                ...structuredClone(option),
                requiredOutputUnitFingerprints: option.requiredOutputUnitFingerprints.filter((unit) =>
                    unitFingerprints.has(unit),
                ),
            }),
        )
        .sort((left, right) => compareUtf8Bytes(left.semanticRefFingerprint, right.semanticRefFingerprint));
    const targetFileSnapshots = projectProviderTargetFileSnapshots({
        targetFileSnapshots: deployment.targetFileSnapshots,
        dialectInputs,
    });
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: deployment.platform,
            platformInstanceId: deployment.platformInstanceId,
            targetContexts: deployment.targetContexts.filter((context) => consumerIds.has(context.agentRuntimeId)),
            assets: deployment.assets.filter((asset) => assetIds.has(asset.version.ref.assetId)),
            ...(targetFileSnapshots === undefined ? {} : { targetFileSnapshots }),
            renderInputFingerprint: deployment.renderInputFingerprint,
        },
        requiredSemantics: semantics,
        dialectInputs,
        selection: {
            schemaVersion: 1,
            semanticOptions: options,
            outputUnits: units,
            outputUnitRenderers: renderers,
        },
    };
}

function validateMaterializationDialectProjection(
    dialectInputs: readonly ProviderRenderDialectInputsForAsset[],
    deployment: RenderDeploymentInput,
    semantics: readonly RequiredRenderSemantic[],
): void {
    const versionKeys = new Set([
        ...semantics.map((semantic) => versionRefKey(semantic.subject)),
        ...dialectInputs.map((group) => versionRefKey(group.targetVersion)),
    ]);
    const assets = deployment.assets.filter((asset) => versionKeys.has(versionRefKey(asset.version.ref)));
    try {
        validateDialectInputProjection(dialectInputs, assets, semantics);
    } catch (error) {
        throw new MaterializationFailure(
            "render.materialization_dialect_projection_invalid",
            `materialization dialect authority is invalid: ${String(error)}`,
        );
    }
}

function validateProviderReceipts(input: {
    deployment: RenderDeploymentInput;
    selection: MaterializationSafeRenderSelection;
    selectionFingerprint: Sha256Digest;
    semantics: RequiredRenderSemantic[];
    provider: AdapterProviderSummary;
    dialectInputs: ProviderRenderDialectInputsForAsset[];
    providerDialectFingerprint: Sha256Digest;
    result: Extract<RenderMaterializationResult, { materializationState: "materialized" }>;
    unitFingerprints: ReadonlySet<string>;
    registry: RenderRegistrySnapshot;
    dialectRegistry: VersionDialectRegistryV1;
}): CoreMaterializedOutputUnit[] {
    const receipts = new Map<string, (typeof input.result.materializedUnits)[number]>();
    for (const receipt of input.result.materializedUnits) {
        if (receipts.has(receipt.outputUnitFingerprint)) {
            throw new MaterializationFailure(
                "render.materialization_receipt_duplicate",
                "renderer repeated an output-unit receipt",
            );
        }
        receipts.set(receipt.outputUnitFingerprint, receipt);
    }
    requireExactSet([...receipts.keys()], [...input.unitFingerprints], "provider materialization receipt closure");
    return [...input.unitFingerprints].map((fingerprint) => {
        const outputUnit = input.selection.outputUnits.find(
            (unit) => unit.outputUnitFingerprint === fingerprint,
        ) as RenderOutputUnit;
        const renderer = input.selection.outputUnitRenderers.find(
            (item) => item.outputUnitFingerprint === fingerprint,
        ) as SelectedOutputUnitRenderer;
        const capability = input.provider.materializerCapabilities.find(
            (item) => item.materializerCapabilityKey === renderer.materializerCapabilityKey,
        );
        const contract = input.registry.getOutputContract(outputUnit.outputContractId);
        const profile = contract?.materializationProfiles.find(
            (item) => item.materializationProfileId === renderer.materializationProfileId,
        );
        if (
            capability === undefined ||
            capability.outputContractId !== outputUnit.outputContractId ||
            capability.outputContractFingerprint !== outputUnit.outputContractFingerprint ||
            !capability.materializationProfileIds.includes(renderer.materializationProfileId) ||
            contract === null ||
            profile === undefined ||
            profile.profileConstraintFingerprint !== renderer.profileConstraintFingerprint
        ) {
            throw new MaterializationFailure(
                "render.materialization_capability_stale",
                "selected materializer capability/profile is stale",
                "conflict",
                true,
            );
        }
        const receipt = receipts.get(fingerprint) as (typeof input.result.materializedUnits)[number];
        const expectedSemantics = input.semantics.filter((semantic) =>
            input.selection.semanticOptions.some(
                (option) =>
                    option.semanticRefFingerprint === semantic.semanticRefFingerprint &&
                    option.requiredOutputUnitFingerprints.includes(fingerprint as Sha256Digest),
            ),
        );
        const expectedRefs = expectedSemantics.map((semantic) => semantic.semanticRefFingerprint);
        const jsoncPatchDeclaration = declaredJsoncTopLevelPropertyPatch(
            input.provider,
            outputUnit.outputContractId,
            renderer.materializationProfileId,
        );
        const providerFiles = validateMaterializedFiles(
            receipt.files,
            outputUnit,
            expectedRefs,
            input.deployment,
            jsoncPatchDeclaration,
        );
        const canonicalValues = expectedSemantics.map((semantic) => canonicalValueForSemantic(input.deployment, semantic));
        const selectedOptions = input.selection.semanticOptions
            .filter((option) => expectedRefs.includes(option.semanticRefFingerprint))
            .map((option) => structuredClone(option));
        const dialectInputs = dialectInputsForSemantics(input.dialectInputs, expectedSemantics, input.deployment);
        validateMaterializationDialectProjection(dialectInputs, input.deployment, expectedSemantics);
        const proof = input.registry.validateOutputContractMaterialization({
            contract,
            profile,
            outputUnit,
            selectedSemantics: expectedSemantics,
            canonicalValues,
            selectedOptions,
            dialectInputs: structuredClone(dialectInputs),
            files: providerFiles,
        });
        validateCoverageProof(proof, {
            contractFingerprint: contract.outputContractFingerprint,
            profileFingerprint: profile.profileConstraintFingerprint,
            outputUnit,
            expectedRefs,
            canonicalValues,
            files: providerFiles,
        });
        if (
            !isExactFileNativeConsistencySatisfied({
                deployment: input.deployment,
                provider: input.provider,
                semantics: expectedSemantics,
                dialectInputs,
                outputUnit,
                renderer,
                files: providerFiles,
                dialectRegistry: input.dialectRegistry,
            })
        ) {
            throw new MaterializationFailure(
                "render.native_consistency_failed",
                "native exact-file materialization is inconsistent with the target canonical Version",
                "verification_failed",
                false,
            );
        }
        if (
            !isExactGraphNativeConsistencySatisfied({
                deployment: input.deployment,
                provider: input.provider,
                semantics: expectedSemantics,
                dialectInputs,
                outputUnit,
                renderer,
                files: providerFiles,
                dialectRegistry: input.dialectRegistry,
                canonicalCoverageProof: proof,
                renderRegistry: input.registry,
            })
        ) {
            throw new MaterializationFailure(
                "render.native_consistency_failed",
                "native exact-graph materialization is inconsistent with the target canonical Version",
                "verification_failed",
                false,
            );
        }
        const files = providerFiles;
        const materializationFingerprint = computeMaterializationFingerprint({
            rendererAdapterId: input.provider.adapterId,
            rendererAdapterVersion: input.provider.version,
            renderInputFingerprint: input.deployment.renderInputFingerprint,
            selectionFingerprint: input.selectionFingerprint,
            outputUnitFingerprint: outputUnit.outputUnitFingerprint,
            materializerCapabilityKey: renderer.materializerCapabilityKey,
            materializationProfileId: renderer.materializationProfileId,
            profileConstraintFingerprint: renderer.profileConstraintFingerprint,
            providerRenderDialectInputFingerprint: input.providerDialectFingerprint,
            files,
        });
        return {
            outputUnit,
            renderer,
            providerRenderDialectInputFingerprint: input.providerDialectFingerprint,
            materializationFingerprint,
            semanticCoverageProof: proof,
            files,
        };
    });
}

function dialectInputsForSemantics(
    dialectInputs: readonly ProviderRenderDialectInputsForAsset[],
    semantics: readonly RequiredRenderSemantic[],
    deployment: RenderDeploymentInput,
): ProviderRenderDialectInputsForAsset[] {
    return projectRenderDialectInputs(dialectInputs, semantics, deployment.assets);
}

function validateMaterializedFiles(
    files: readonly MaterializedRenderFile[],
    outputUnit: RenderOutputUnit,
    expectedRefs: readonly Sha256Digest[],
    deployment: RenderDeploymentInput,
    jsoncPatchDeclaration?: JsoncTopLevelPropertyPatchDeclaration,
): MaterializedRenderFile[] {
    if (!Array.isArray(files)) {
        throw new MaterializationFailure("render.materialization_files_invalid", "materialized files must be an array");
    }
    const claims = new Map(outputUnit.claims.map((claim) => [claim.relativePath, claim]));
    const byPath = new Map<string, MaterializedRenderFile>();
    const allowedHandles = new Set(deployment.assets.flatMap((asset) => Object.values(asset.sectionHandles)));
    const union = new Set<string>();
    let patchCount = 0;
    for (const original of files) {
        const file: MaterializedRenderFile = structuredClone(original);
        const claim = claims.get(file.relativePath);
        if (
            claim === undefined ||
            byPath.has(file.relativePath) ||
            !isCanonicalRelativePath(file.relativePath) ||
            file.executable !== claim.executable ||
            file.content.contentKind !== claim.contentKind ||
            !Array.isArray(file.semanticRefFingerprints) ||
            !Array.isArray(file.sectionBindings)
        ) {
            throw new MaterializationFailure(
                "render.materialization_file_claim_mismatch",
                "materialized files do not exactly satisfy their output claims",
            );
        }
        validateTargetContent(file.content);
        if (file.containerPatch !== undefined) {
            patchCount += 1;
            if (!isDeclaredJsoncContainerPatch(file, file.containerPatch, jsoncPatchDeclaration)) {
                throw new MaterializationFailure(
                    "render.materialization_container_patch_invalid",
                    "materialized container patch is absent from or outside its exact Provider declaration",
                );
            }
        }
        requireSortedUnique(file.semanticRefFingerprints, "materialized file semantic refs");
        if (
            file.semanticRefFingerprints.length === 0 ||
            file.semanticRefFingerprints.some((ref) => !expectedRefs.includes(ref))
        ) {
            throw new MaterializationFailure(
                "render.materialization_semantic_foreign",
                "materialized file semantic refs are empty or foreign",
            );
        }
        for (const ref of file.semanticRefFingerprints) union.add(ref);
        const handles = new Set<string>();
        for (const binding of file.sectionBindings) {
            if (
                binding.sectionHandle.trim().length === 0 ||
                handles.has(binding.sectionHandle) ||
                !allowedHandles.has(binding.sectionHandle)
            ) {
                throw new MaterializationFailure(
                    "render.materialization_section_invalid",
                    "section binding handle is blank, duplicated, or foreign",
                );
            }
            handles.add(binding.sectionHandle);
            requireSortedUnique(binding.semanticRefFingerprints, "section semantic refs");
            if (
                binding.semanticRefFingerprints.length === 0 ||
                binding.semanticRefFingerprints.some((ref) => !file.semanticRefFingerprints.includes(ref))
            ) {
                throw new MaterializationFailure(
                    "render.materialization_section_invalid",
                    "section binding refs must be a non-empty file-ref subset",
                );
            }
        }
        byPath.set(file.relativePath, file);
    }
    requireExactSet([...byPath.keys()], [...claims.keys()], "materialized file claims");
    requireExactSet([...union], expectedRefs, "materialized semantic coverage");
    if (!isExactJsoncContainerPatchClosure(jsoncPatchDeclaration, patchCount)) {
        throw new MaterializationFailure(
            "render.materialization_container_patch_invalid",
            "materialized container patch closure is not exact",
        );
    }
    return [...byPath.values()].sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
}

function validateCoverageProof(
    proof: MaterializationSemanticCoverageProof,
    input: {
        contractFingerprint: Sha256Digest;
        profileFingerprint: Sha256Digest;
        outputUnit: RenderOutputUnit;
        expectedRefs: Sha256Digest[];
        canonicalValues: CanonicalRenderSemanticValue[];
        files: MaterializedRenderFile[];
    },
): void {
    requireSortedUnique(proof.coveredSemanticRefFingerprints, "semantic coverage refs");
    requireExactSet(proof.coveredSemanticRefFingerprints, input.expectedRefs, "semantic coverage proof");
    if (!isMaterializationCoverageProofBound(proof, input)) {
        throw new MaterializationFailure(
            "render.materialization_coverage_invalid",
            "Core-owned semantic coverage proof is stale or malformed",
        );
    }
}

function validateTargetContent(content: MaterializedRenderFile["content"]): void {
    if (content.contentKind === "text") {
        if (typeof content.text !== "string" || normalizeText(content.text).normalized !== content.text) {
            throw new MaterializationFailure(
                "render.materialization_content_invalid",
                "materialized text must be canonical UTF-8 text",
            );
        }
        return;
    }
    if (!(content.bytes instanceof Uint8Array)) {
        throw new MaterializationFailure(
            "render.materialization_content_invalid",
            "materialized binary content must be Uint8Array",
        );
    }
}

function requireSortedUnique(values: readonly string[], label: string): void {
    if (
        values.some((value) => !isSha256Digest(value)) ||
        new Set(values).size !== values.length ||
        stableStringify([...values].sort(compareUtf8Bytes)) !== stableStringify(values)
    ) {
        throw new MaterializationFailure(
            "render.materialization_collection_invalid",
            `${label} must be canonical sorted-unique SHA-256 values`,
        );
    }
}

function requireExactSet(actual: readonly string[], expected: readonly string[], label: string): void {
    if (
        new Set(actual).size !== actual.length ||
        new Set(expected).size !== expected.length ||
        stableStringify([...actual].sort(compareUtf8Bytes)) !== stableStringify([...expected].sort(compareUtf8Bytes))
    ) {
        throw new MaterializationFailure("render.materialization_closure_mismatch", `${label} is not exact`);
    }
}

/** Narrow pure/filesystem seams for exhaustive fail-closed container-patch coverage. */
export const renderMaterializationInternalsForTest = {
    validateMaterializedFiles,
};

function failed<T>(error: unknown, diagnostics: readonly OperationDiagnostic[] = []): CoreResult<T> {
    const known = error instanceof MaterializationFailure;
    return {
        status: "failed",
        value: undefined as T,
        diagnostics: [
            {
                severity: "error",
                code: known ? error.code : "render.materialization_internal_error",
                message: error instanceof Error ? error.message : String(error),
                operation: "render",
                causeKind: known ? error.causeKind : "internal_error",
                path: "",
                traceId: "",
                retryable: known ? error.retryable : false,
                suggestedActions: [],
                rawSummary: "",
            },
            ...diagnostics,
        ],
    };
}
