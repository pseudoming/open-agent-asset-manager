/** Reverse staging for one selected exact native project/global graph. */

import { readAssetManifest } from "../catalog/asset-manifest";
import { binaryPayloadStats, bytesForPayload, normalizeText, textPayloadStats } from "../catalog/payload-store";
import { readVersionAuthority, type VersionAuthorityClosureV1 } from "../catalog/version-authority";
import type { AssetVersionFileContentV2 } from "../contracts/asset-version";
import type {
    VersionNativeRepresentation,
    VersionNativeRepresentationV1,
    VersionNativeRepresentationV2,
} from "../contracts/persistence";
import type { ProviderRenderDialectInput, RenderNativeRepresentationFileInput } from "../contracts/render";
import type { AttributedSemanticChange } from "../contracts/reverse";
import type { AdapterNativeGraphRenderDeclarationV1 } from "../contracts/source-import";
import type { AssetKindTypeDataV2 } from "../contracts/specs";
import {
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../foundation/fingerprint";
import { readJsoncTopLevelPropertyValue } from "../foundation/jsonc-top-level-property";
import { compareUtf8Bytes } from "../foundation/text-order";
import { getAssetSpecHandler } from "../specs/registry";
import type { Sha256Digest, UuidV4 } from "../types";
import type { DeploymentInspectionAuthorityV1 } from "./deployment-inspection-service";
import type { DeploymentLifecycleConfiguration, StagedReverseVersionContentV1 } from "./deployment-lifecycle-model";
import { lifecycleFailure } from "./deployment-lifecycle-shared";
import {
    isAppliedCanonicalGraphCurrent,
    readAppliedCanonicalGraphFiles,
    rebuildSourceNativeGraphs,
} from "./deployment-lifecycle-applied-canonical-graph";
import { nextAssetRevision, requireAvailableStagedAsset } from "./deployment-lifecycle-version-authority";
import type { RenderBaseAuthority } from "./deployment-render-authority";
import { resolveProviderExactFileDialectInputs } from "../render/render-dialect-authority";
import { type InspectRenderedTargetConfiguration, resolveAppliedRenderer } from "../render/render-inspection";
import type { RenderRegistrySnapshot } from "../render/render-registry";

type GraphNativeInput = Extract<ProviderRenderDialectInput, { inputKind: "native_representation" }>;
type GraphCanonicalMaterializationInput = Extract<ProviderRenderDialectInput, { inputKind: "canonical_materialization" }>;
type ExactGraphChange = Extract<
    AttributedSemanticChange,
    { changeKind: "file_content_replacement" | "file_executable_replacement" }
>;

export function tryBuildExactGraphStagedReverseVersionContent(input: {
    configuration: DeploymentLifecycleConfiguration;
    inspected: DeploymentInspectionAuthorityV1;
    base: RenderBaseAuthority;
    stagedVersionId: UuidV4;
    resolveRetainedRegistry?: InspectRenderedTargetConfiguration["resolveRetainedRegistry"];
}): StagedReverseVersionContentV1 | null {
    if (!Array.isArray(input.inspected.input.files) || !Array.isArray(input.inspected.input.inspectionScope?.fileStates)) {
        return null;
    }
    const unitIds = [
        ...new Set(
            input.inspected.input.files
                .map((file) =>
                    input.inspected.input.inspectionScope.fileStates.find((state) => state.relativePath === file.relativePath),
                )
                .map((state) => state?.outputUnitFingerprint),
        ),
    ].filter((value): value is Sha256Digest => value !== undefined);
    if (unitIds.length !== 1) return null;
    const [unitId] = unitIds as [Sha256Digest];
    const unit = input.inspected.appliedRenderSnapshot.outputUnits.find(
        (candidate) => candidate.outputUnitFingerprint === unitId,
    );
    const renderer = input.inspected.appliedRenderSnapshot.outputUnitRenderers.find(
        (candidate) => candidate.outputUnitFingerprint === unitId,
    );
    if (unit === undefined || renderer === undefined) return null;
    const applied = resolveAppliedRenderer(
        { registry: input.inspected.operation.registry, resolveRetainedRegistry: input.resolveRetainedRegistry },
        renderer.rendererAdapterId,
        renderer.rendererAdapterVersion,
    );
    if (applied === null) return null;
    const { provider: owner, registry: appliedRegistry } = applied;
    const declarations = owner.renderContractDeclarations.filter(
        (declaration): declaration is AdapterNativeGraphRenderDeclarationV1 =>
            (declaration.declarationKind === "native_project_exact_graph_v1" ||
                declaration.declarationKind === "native_global_exact_graph_v1" ||
                declaration.declarationKind === "native_project_encoded_file_v1" ||
                declaration.declarationKind === "native_global_encoded_file_v1") &&
            declaration.outputContractId === unit.outputContractId &&
            declaration.materializationProfileId === renderer.materializationProfileId,
    );
    if (declarations.length === 0) return null;
    if (declarations.length !== 1) {
        throw lifecycleFailure(
            "reverse_accept.exact_graph_contract_stale",
            "applied exact-graph semantic has no unique Applied renderer declaration",
            "conflict",
            true,
        );
    }
    const [declaration] = declarations as [AdapterNativeGraphRenderDeclarationV1];
    return buildExactGraphStagedReverseVersionContent({ ...input, owner, appliedRegistry, declaration, unitId });
}

function buildExactGraphStagedReverseVersionContent(input: {
    configuration: DeploymentLifecycleConfiguration;
    inspected: DeploymentInspectionAuthorityV1;
    base: RenderBaseAuthority;
    stagedVersionId: UuidV4;
    owner: NonNullable<ReturnType<DeploymentInspectionAuthorityV1["operation"]["registry"]["getProvider"]>>;
    appliedRegistry: RenderRegistrySnapshot;
    declaration: AdapterNativeGraphRenderDeclarationV1;
    unitId: Sha256Digest;
}): StagedReverseVersionContentV1 {
    const decisions = input.inspected.appliedRenderSnapshot.decisions.filter((decision) =>
        decision.outputUnitFingerprints.includes(input.unitId),
    );
    const subjects = decisions.map((decision) => decision.semanticRef.subject);
    const assetKeys = new Set(subjects.map((subject) => `${subject.assetId}\0${subject.versionId}`));
    if (
        assetKeys.size !== 1 ||
        decisions.length === 0 ||
        decisions.some(
            (decision) =>
                decision.semanticRef.consumerAgentRuntimeId !== input.declaration.agentRuntimeId ||
                decision.consumerOwnerAdapterId !== input.owner.adapterId,
        )
    ) {
        throw lifecycleFailure(
            "reverse_accept.exact_graph_asset_closure_unsupported",
            "exact-graph reverse accept requires one unique applied Asset",
            "unsupported",
        );
    }
    const [subject] = subjects as [(typeof subjects)[number]];
    const renderAssets = input.base.assets.filter(
        (asset) => asset.version.ref.assetId === subject.assetId && asset.version.ref.versionId === subject.versionId,
    );
    const appliedAssets = input.base.appliedInputsSnapshot.assets.filter(
        (asset) => asset.assetId === subject.assetId && asset.versionId === subject.versionId,
    );
    if (renderAssets.length !== 1 || appliedAssets.length !== 1) {
        throw lifecycleFailure(
            "reverse_accept.exact_graph_asset_closure_unsupported",
            "exact-graph reverse accept requires one unique applied Asset",
            "unsupported",
        );
    }
    const [renderAsset] = renderAssets as [(typeof renderAssets)[number]];
    if (renderAsset.version.canonical.kind !== input.declaration.assetKind) {
        throw lifecycleFailure(
            "reverse_accept.exact_graph_asset_stale",
            "applied exact-graph semantic no longer matches the Deployment Version",
            "conflict",
            true,
        );
    }
    if (
        input.inspected.input.inventoryDeltas.length !== 0 ||
        input.inspected.result.files.some((file) => file.attributionState !== "uniquely_attributable") ||
        input.inspected.result.changes.length === 0 ||
        input.inspected.result.changes.some(
            (change) => change.changeKind !== "file_content_replacement" && change.changeKind !== "file_executable_replacement",
        )
    ) {
        throw lifecycleFailure(
            "reverse_accept.exact_graph_inventory_change_unsupported",
            "exact-graph reverse accepts only uniquely attributable existing-file content or executable changes",
            "unsupported",
        );
    }
    const parent = readVersionAuthority(
        input.configuration.render.assetsRoot,
        subject.assetId,
        subject.versionId,
        input.configuration.render.dialectRegistry,
    );
    if (parent === null || parent.manifest.fingerprint !== renderAsset.version.versionFingerprint) {
        throw lifecycleFailure(
            "reverse_accept.exact_graph_parent_unavailable",
            "exact-graph reverse parent Version is missing or outside the complete graph contract",
            "conflict",
            true,
        );
    }
    const files = applyCanonicalChanges(parent, decisions, input.inspected.result.changes as ExactGraphChange[]);
    const canonical = {
        kind: input.declaration.assetKind,
        typeData: structuredClone(parent.manifest.typeData),
    } as Extract<AssetKindTypeDataV2, { kind: "Rule" | "Workflow" | "Skill" | "Subagent" }>;
    validateCompleteGraph(canonical, files);
    const versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(
        canonical,
        files.map((file) => file.file),
    );
    const nativeResolution = resolveAppliedNativeInput({
        inspected: input.inspected,
        owner: input.owner,
        appliedRegistry: input.appliedRegistry,
        decisions,
        parent,
        nativeDialectId: input.declaration.nativeDialectId,
        outputUnitFingerprint: input.unitId,
        registry: input.configuration.render.dialectRegistry,
    });
    const native =
        nativeResolution.sourceKind === "canonical_only"
            ? { nativeRepresentations: [], nativePayloads: [] }
            : nativeResolution.sourceKind === "source_native_rebase"
              ? rebuildSourceNativeGraphs({
                    parent,
                    canonical,
                    files,
                    versionCanonicalContentFingerprint,
                    registry: input.configuration.render.dialectRegistry,
                })
              : rebuildExactGraphNativeDialectAuthority({
                    inspected: input.inspected,
                    nativeInput: nativeResolution.nativeInput,
                    canonical,
                    files,
                    nativeDialectId: input.declaration.nativeDialectId,
                    jsoncTopLevelPropertyPatch: input.declaration.jsoncTopLevelPropertyPatch,
                    versionCanonicalContentFingerprint,
                    registry: input.configuration.render.dialectRegistry,
                });
    const asset = requireAvailableStagedAsset(
        readAssetManifest(input.configuration.render.assetsRoot, subject.assetId),
        input.stagedVersionId,
    );
    const revision = nextAssetRevision(asset, (versionId) =>
        readVersionAuthority(
            input.configuration.render.assetsRoot,
            subject.assetId,
            versionId,
            input.configuration.render.dialectRegistry,
        ),
    );
    const portableDialectContracts = structuredClone(parent.manifest.portableDialectContracts);
    const dialectRestorationPayloads = structuredClone(parent.manifest.dialectRestorationPayloads);
    const restorationPayloads = parent.restorationPayloads.map((payload) => ({
        dialectId: payload.dialectId,
        bytes: new Uint8Array(payload.bytes),
    }));
    return {
        assetId: subject.assetId,
        versionId: input.stagedVersionId,
        revision,
        parentVersionId: parent.manifest.versionId,
        parentOriginAuthorityFingerprint: parent.manifest.originAuthority.authorityFingerprint,
        promotionRequirement: parent.manifest.originAuthority.promotionRequirement,
        canonical,
        files,
        portableDialectContracts,
        nativeRepresentations: native.nativeRepresentations,
        dialectRestorationPayloads,
        nativePayloads: native.nativePayloads,
        restorationPayloads,
        ...(nativeResolution.sourceKind === "applied_canonical" ? { allowFirstNativeDialectProjection: true as const } : {}),
        versionCanonicalContentFingerprint,
        versionFingerprint: computeVersionFingerprint(
            versionCanonicalContentFingerprint,
            native.nativeRepresentations,
            dialectRestorationPayloads,
            portableDialectContracts,
        ),
    };
}

function applyCanonicalChanges(
    parent: VersionAuthorityClosureV1,
    decisions: DeploymentInspectionAuthorityV1["appliedRenderSnapshot"]["decisions"],
    changes: ExactGraphChange[],
): AssetVersionFileContentV2[] {
    const files = new Map(parent.files.map((file) => [file.file.fileId, cloneFile(file)]));
    const touchedContent = new Set<string>();
    const touchedExecutable = new Set<string>();
    for (const change of changes) {
        if (change.changeKind === "file_content_replacement") {
            if (change.semanticRefFingerprints.length !== 1) throwUnsupportedChange();
            const matches = decisions.filter(
                (decision) =>
                    decision.semanticRef.semanticRefFingerprint === change.semanticRefFingerprints[0] &&
                    decision.semanticRef.subject.subjectKind === "file",
            );
            const subject = matches[0]?.semanticRef.subject;
            if (matches.length !== 1 || subject?.subjectKind !== "file" || touchedContent.has(subject.fileId)) {
                throwUnsupportedChange();
            }
            const source = files.get(subject.fileId);
            if (source === undefined) throwUnsupportedChange();
            files.set(subject.fileId, replaceFileContent(source, change.replacementContent));
            touchedContent.add(subject.fileId);
        } else {
            const source = files.get(change.fileId);
            if (source === undefined || touchedExecutable.has(change.fileId)) throwUnsupportedChange();
            files.set(change.fileId, { ...source, file: { ...source.file, executable: change.executable } });
            touchedExecutable.add(change.fileId);
        }
    }
    return [...files.values()].sort((left, right) => compareUtf8Bytes(left.file.logicalPath, right.file.logicalPath));
}

function replaceFileContent(
    source: AssetVersionFileContentV2,
    content: Extract<AttributedSemanticChange, { changeKind: "file_content_replacement" }>["replacementContent"],
): AssetVersionFileContentV2 {
    if (source.contentKind === "text" && content.contentKind === "text") {
        const text = normalizeText(content.text).normalized;
        const stats = textPayloadStats(text);
        return { contentKind: "text", text, file: { ...source.file, contentHash: stats.contentHash, byteSize: stats.byteSize } };
    }
    if (source.contentKind === "binary" && content.contentKind === "binary") {
        const bytes = new Uint8Array(content.bytes);
        const stats = binaryPayloadStats(bytes);
        return {
            contentKind: "binary",
            bytes,
            file: { ...source.file, contentHash: stats.contentHash, byteSize: stats.byteSize },
        };
    }
    return throwUnsupportedChange();
}

function validateCompleteGraph(
    canonical: Extract<AssetKindTypeDataV2, { kind: "Rule" | "Workflow" | "Skill" | "Subagent" }>,
    files: AssetVersionFileContentV2[],
): void {
    const handler = getAssetSpecHandler(canonical.kind);
    // The immutable parent closure already proved graph cardinality, roles and content kinds;
    // supported reverse changes cannot alter those fields, so revalidate changed entry and
    // any AssetKind-specific resource relation such as Subagent initialPrompt.
    const entry = files.find((file) => file.file.role === "entry") as Extract<AssetVersionFileContentV2, { contentKind: "text" }>;
    if (!handler.validateEntryText(entry.text) || handler.validateFiles(canonical, files).length !== 0) {
        throw lifecycleFailure(
            "reverse_accept.exact_graph_canonical_invalid",
            "exact-graph reverse result violates the complete canonical graph",
            "unsupported",
        );
    }
}

function resolveAppliedNativeInput(input: {
    inspected: DeploymentInspectionAuthorityV1;
    owner: NonNullable<ReturnType<DeploymentInspectionAuthorityV1["operation"]["registry"]["getProvider"]>>;
    appliedRegistry: RenderRegistrySnapshot;
    decisions: DeploymentInspectionAuthorityV1["appliedRenderSnapshot"]["decisions"];
    parent: VersionAuthorityClosureV1;
    nativeDialectId: string;
    outputUnitFingerprint: Sha256Digest;
    registry: DeploymentLifecycleConfiguration["render"]["dialectRegistry"];
}):
    | { nativeInput: GraphNativeInput; sourceKind: "version_native" | "applied_canonical" }
    | { sourceKind: "source_native_rebase" }
    | { sourceKind: "canonical_only" } {
    const semantics = input.decisions.map((decision) => decision.semanticRef);
    const groups = resolveProviderExactFileDialectInputs({
        provider: input.owner,
        deployment: input.inspected.operation.deployment,
        semantics,
        available: input.inspected.operation.dialectInputs,
        renderRegistry: input.appliedRegistry,
        dialectRegistry: input.inspected.operation.dialectRegistry,
    });
    const group = groups[0];
    if (
        groups.length !== 1 ||
        group === undefined ||
        group.targetVersion.assetId !== input.parent.manifest.assetId ||
        group.targetVersion.versionId !== input.parent.manifest.versionId
    ) {
        throw lifecycleFailure(
            "reverse_accept.exact_graph_native_input_stale",
            "exact-graph reverse has no unique applied target-dialect input",
            "conflict",
            true,
        );
    }
    // The dialect resolver returns a group only after proving exactly one
    // native or canonical authority; preserve that stronger runtime invariant here.
    const dialectInput = group.inputs.find(
        (candidate): candidate is GraphNativeInput | GraphCanonicalMaterializationInput =>
            candidate.inputKind === "native_representation" || candidate.inputKind === "canonical_materialization",
    ) as GraphNativeInput | GraphCanonicalMaterializationInput;
    const sourceKind = dialectInput.inputKind === "native_representation" ? "version_native" : "applied_canonical";
    const native =
        sourceKind === "version_native"
            ? (dialectInput as GraphNativeInput)
            : reconstructAppliedCanonicalNativeInput({
                  ...input,
                  canonicalInput: dialectInput as GraphCanonicalMaterializationInput,
              });
    if (
        native === null &&
        dialectInput.inputKind === "canonical_materialization" &&
        isAppliedCanonicalGraphCurrent({ ...input, dialectInput: group })
    ) {
        // A proved Applied conversion need not be native same-content. Keep a Skill
        // with no current native authority canonical-only; existing source-native
        // authority must still be rebuilt rather than discarded.
        if (
            input.parent.manifest.kind === "Skill" &&
            input.parent.manifest.nativeRepresentations.length === 0 &&
            input.parent.nativePayloads.length === 0 &&
            input.registry.getNative("Skill", input.nativeDialectId) !== null
        ) {
            return { sourceKind: "canonical_only" };
        }
        return { sourceKind: "source_native_rebase" };
    }
    if (native === null || native.representation.dialectId !== input.nativeDialectId) {
        throw lifecycleFailure(
            "reverse_accept.exact_graph_native_input_stale",
            "exact-graph reverse has no unique applied target-dialect input",
            "conflict",
            true,
        );
    }
    const lineageMatches =
        native.inputRole === "current_exact"
            ? native.representation.canonicalContentFingerprint === input.parent.manifest.versionCanonicalContentFingerprint
            : input.parent.manifest.sourceVersionId !== "" &&
              native.sourceVersion.assetId === input.parent.manifest.assetId &&
              native.sourceVersion.versionId === input.parent.manifest.sourceVersionId;
    if (!lineageMatches) {
        throw lifecycleFailure(
            "reverse_accept.exact_graph_native_input_stale",
            "exact-graph reverse target-dialect input no longer matches immediate Version lineage",
            "conflict",
            true,
        );
    }
    return { nativeInput: native, sourceKind };
}

function reconstructAppliedCanonicalNativeInput(input: {
    inspected: DeploymentInspectionAuthorityV1;
    parent: VersionAuthorityClosureV1;
    nativeDialectId: string;
    outputUnitFingerprint: Sha256Digest;
    registry: DeploymentLifecycleConfiguration["render"]["dialectRegistry"];
    canonicalInput: GraphCanonicalMaterializationInput;
}): GraphNativeInput | null {
    const outputUnit = input.inspected.appliedRenderSnapshot.outputUnits.find(
        (candidate) => candidate.outputUnitFingerprint === input.outputUnitFingerprint,
    );
    const contract = input.registry.getNative(input.parent.manifest.kind, input.nativeDialectId);
    if (
        outputUnit === undefined ||
        contract === null ||
        input.canonicalInput.nativeDialectId !== input.nativeDialectId ||
        outputUnit.claims.length === 0
    ) {
        return null;
    }
    const files = readAppliedCanonicalGraphFiles(input);
    if (files === null) return null;
    const descriptors = files.map((file) => {
        if (file.contentKind === "text") {
            const { text: _text, ...descriptor } = file;
            return descriptor;
        }
        const { bytes: _bytes, ...descriptor } = file;
        return descriptor;
    });
    const representationPreimage: Omit<VersionNativeRepresentationV1, "representationFingerprint"> = {
        schemaVersion: 1,
        dialectId: input.nativeDialectId,
        dialectContractFingerprint: contract.contractFingerprint,
        canonicalContentFingerprint: input.parent.manifest.versionCanonicalContentFingerprint,
        files: descriptors,
    };
    const representation: VersionNativeRepresentationV1 = {
        ...representationPreimage,
        representationFingerprint: computeVersionNativeRepresentationFingerprint(representationPreimage),
    };
    if (
        !contract.validateSameContent({
            canonical: { kind: input.parent.manifest.kind, typeData: input.parent.manifest.typeData } as Extract<
                AssetKindTypeDataV2,
                { kind: "Rule" | "Workflow" | "Skill" | "Subagent" }
            >,
            canonicalFiles: input.parent.files,
            representation,
            nativeFiles: files.map((file) => ({
                relativePath: file.relativePath,
                bytes: bytesForPayload(file.contentKind === "text" ? file.text : file.bytes, file.contentKind),
            })),
        })
    ) {
        return null;
    }
    const { files: _descriptors, ...projectedRepresentation } = representation;
    return {
        inputKind: "native_representation",
        inputRole: "current_exact",
        representation: projectedRepresentation,
        files,
    };
}

export function rebuildExactGraphNativeDialectAuthority(input: {
    inspected: DeploymentInspectionAuthorityV1;
    nativeInput: GraphNativeInput;
    canonical: Extract<AssetKindTypeDataV2, { kind: "Rule" | "Workflow" | "Skill" | "Subagent" }>;
    files: AssetVersionFileContentV2[];
    nativeDialectId: string;
    jsoncTopLevelPropertyPatch?: AdapterNativeGraphRenderDeclarationV1["jsoncTopLevelPropertyPatch"];
    versionCanonicalContentFingerprint: Sha256Digest;
    registry: DeploymentLifecycleConfiguration["render"]["dialectRegistry"];
}): Pick<StagedReverseVersionContentV1, "nativeRepresentations" | "nativePayloads"> {
    const authorityFiles = input.inspected.runtimeReplacementAuthority.files;
    const inspectionStates = input.inspected.input.inspectionScope.fileStates;
    const statesByPath = new Map(inspectionStates.map((state) => [state.relativePath, state]));
    const nativePaths = new Set(input.nativeInput.files.map((file) => file.relativePath));
    const outputUnits = new Set([...nativePaths].map((relativePath) => statesByPath.get(relativePath)?.outputUnitFingerprint));
    const outputUnit = [...outputUnits][0];
    const scopedAuthorityFiles = authorityFiles.filter((file) => {
        const state = statesByPath.get(file.relativePath);
        if (state === undefined) throwUnsupportedChange();
        return state.outputUnitFingerprint === outputUnit;
    });
    const authorityByPath = new Map(scopedAuthorityFiles.map((file) => [file.relativePath, file]));
    if (
        statesByPath.size !== inspectionStates.length ||
        nativePaths.size !== input.nativeInput.files.length ||
        outputUnits.size !== 1 ||
        outputUnit === undefined ||
        authorityByPath.size !== scopedAuthorityFiles.length ||
        authorityByPath.size !== input.nativeInput.files.length ||
        [...nativePaths].some((relativePath) => !authorityByPath.has(relativePath))
    ) {
        throwUnsupportedChange();
    }
    const currentFiles = input.nativeInput.files
        .map((source): RenderNativeRepresentationFileInput => {
            const authority = authorityByPath.get(source.relativePath);
            const state = statesByPath.get(source.relativePath);
            if (
                authority === undefined ||
                authority.expectedState !== "present" ||
                state === undefined ||
                state.state === "missing" ||
                binaryPayloadStats(authority.expectedBytes).contentHash !== state.currentContentHash ||
                authority.expectedExecutable !== state.currentExecutable
            ) {
                throwUnsupportedChange();
            }
            const patch = input.jsoncTopLevelPropertyPatch;
            const isPatch = patch?.allowedContainerRelativePaths.includes(source.relativePath) ?? false;
            const nativeBytes = isPatch
                ? readJsoncTopLevelPropertyValue(authority.expectedBytes, patch?.propertyName as string)?.valueBytes
                : authority.expectedBytes;
            if (nativeBytes === undefined || (isPatch && (source.contentKind !== "binary" || authority.expectedExecutable))) {
                throwUnsupportedChange();
            }
            const stats = binaryPayloadStats(nativeBytes);
            if (source.contentKind === "text") {
                const normalized = normalizeText(new TextDecoder("utf-8", { fatal: true }).decode(nativeBytes));
                if (!Buffer.from(normalized.bytes).equals(Buffer.from(nativeBytes))) throwUnsupportedChange();
                return { ...source, text: normalized.normalized, executable: authority.expectedExecutable, ...stats };
            }
            return {
                ...source,
                bytes: new Uint8Array(nativeBytes),
                executable: authority.expectedExecutable,
                ...stats,
            };
        })
        .sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
    const descriptors = currentFiles.map((file) => {
        if (file.contentKind === "text") {
            const { text: _text, ...descriptor } = file;
            return descriptor;
        }
        const { bytes: _bytes, ...descriptor } = file;
        return descriptor;
    });
    const representationPreimage:
        | Omit<VersionNativeRepresentationV1, "representationFingerprint">
        | Omit<VersionNativeRepresentationV2, "representationFingerprint"> =
        input.nativeInput.representation.schemaVersion === 2
            ? {
                  schemaVersion: 2,
                  dialectId: input.nativeDialectId,
                  dialectContractFingerprint: input.nativeInput.representation.dialectContractFingerprint,
                  canonicalContentFingerprint: input.versionCanonicalContentFingerprint,
                  directories: [...input.nativeInput.representation.directories],
                  files: descriptors,
              }
            : {
                  schemaVersion: 1,
                  dialectId: input.nativeDialectId,
                  dialectContractFingerprint: input.nativeInput.representation.dialectContractFingerprint,
                  canonicalContentFingerprint: input.versionCanonicalContentFingerprint,
                  files: descriptors,
              };
    const representation: VersionNativeRepresentation = {
        ...representationPreimage,
        representationFingerprint: computeVersionNativeRepresentationFingerprint(representationPreimage),
    } as VersionNativeRepresentation;
    const payload = {
        dialectId: input.nativeDialectId,
        files: currentFiles.map((file) => ({
            relativePath: file.relativePath,
            bytes: bytesForPayload(file.contentKind === "text" ? file.text : file.bytes, file.contentKind),
        })),
    };
    const contract = input.registry.getNative(input.canonical.kind, input.nativeDialectId);
    if (
        contract === null ||
        contract.contractFingerprint !== representation.dialectContractFingerprint ||
        !contract.validateSameContent({
            canonical: input.canonical,
            canonicalFiles: input.files,
            representation,
            nativeFiles: payload.files,
        })
    ) {
        throw lifecycleFailure(
            "reverse_accept.exact_graph_native_dialect_unsupported",
            "exact-graph native dialect validator rejected the complete changed target graph",
            "unsupported",
        );
    }
    return { nativeRepresentations: [representation], nativePayloads: [payload] };
}

function cloneFile(file: AssetVersionFileContentV2): AssetVersionFileContentV2 {
    return file.contentKind === "text"
        ? { contentKind: "text", text: file.text, file: structuredClone(file.file) }
        : { contentKind: "binary", bytes: new Uint8Array(file.bytes), file: structuredClone(file.file) };
}

function throwUnsupportedChange(): never {
    throw lifecycleFailure(
        "reverse_accept.exact_graph_change_unsupported",
        "exact-graph reverse change is ambiguous, duplicated, or outside the existing file graph",
        "unsupported",
    );
}

/** Narrow pure seam for fail-closed graph-change branch coverage. */
export const deploymentLifecycleExactGraphInternalsForTest = {
    applyCanonicalChanges,
    resolveAppliedNativeInput,
    reconstructAppliedCanonicalNativeInput,
};
