/** Reverse staging for one selected current-exact or parent-rebased project declaration file. */

import { readAssetManifest } from "../catalog/asset-manifest";
import { binaryPayloadStats, textPayloadStats } from "../catalog/payload-store";
import { readVersionAuthority, type VersionAuthorityClosureV1 } from "../catalog/version-authority";
import type { AssetVersionFileContentV2 } from "../contracts/asset-version";
import type { VersionNativeRepresentationV1 } from "../contracts/persistence";
import type { ProviderRenderDialectInput } from "../contracts/render";
import type { AttributedSemanticChange } from "../contracts/reverse";
import type {
    AdapterNativeProjectExactFileRenderDeclarationV1,
    NativeProjectExactFileAssetKind,
} from "../contracts/source-import";
import type { AssetKindTypeDataV2 } from "../contracts/specs";
import {
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../foundation/fingerprint";
import { entrySemanticKind } from "../render/render-semantics";
import type { Sha256Digest, UuidV4 } from "../types";
import type { DeploymentInspectionAuthorityV1 } from "./deployment-inspection-service";
import type { DeploymentLifecycleConfiguration, StagedReverseVersionContentV1 } from "./deployment-lifecycle-model";
import { lifecycleFailure } from "./deployment-lifecycle-shared";
import { nextAssetRevision, requireAvailableStagedAsset } from "./deployment-lifecycle-version-authority";
import { type RenderBaseAuthority, resolveOperationDialectInputs } from "./deployment-render-authority";

export type ExactFileReverseAssetKind = NativeProjectExactFileAssetKind;

export function exactFileAssetKindForSemantic(semanticKind: string): ExactFileReverseAssetKind | null {
    if (semanticKind === entrySemanticKind("Rule")) return "Rule";
    if (semanticKind === entrySemanticKind("Workflow")) return "Workflow";
    if (semanticKind === entrySemanticKind("Skill")) return "Skill";
    if (semanticKind === entrySemanticKind("Subagent")) return "Subagent";
    if (semanticKind === entrySemanticKind("Memory")) return "Memory";
    return null;
}

export function buildExactFileStagedReverseVersionContent(input: {
    configuration: DeploymentLifecycleConfiguration;
    inspected: DeploymentInspectionAuthorityV1;
    base: RenderBaseAuthority;
    stagedVersionId: UuidV4;
    change: Extract<AttributedSemanticChange, { changeKind: "file_content_replacement" }>;
    decision: DeploymentInspectionAuthorityV1["appliedRenderSnapshot"]["decisions"][number];
    subject: Extract<
        DeploymentInspectionAuthorityV1["appliedRenderSnapshot"]["decisions"][number]["semanticRef"]["subject"],
        { subjectKind: "file" }
    >;
    assetKind: ExactFileReverseAssetKind;
}): StagedReverseVersionContentV1 {
    const renderAssets = input.base.assets.filter((asset) => asset.version.ref.assetId === input.subject.assetId);
    const appliedAssets = input.base.appliedInputsSnapshot.assets.filter((asset) => asset.assetId === input.subject.assetId);
    if (renderAssets.length !== 1 || appliedAssets.length !== 1) {
        throw lifecycleFailure(
            "reverse_accept.exact_file_asset_closure_unsupported",
            "exact-file reverse accept requires one unique applied project Asset",
            "unsupported",
        );
    }
    const renderAsset = renderAssets[0] as (typeof renderAssets)[number];
    const appliedAsset = appliedAssets[0] as (typeof appliedAssets)[number];
    if (renderAsset.version.ref.versionId !== input.subject.versionId || appliedAsset.versionId !== input.subject.versionId) {
        throw lifecycleFailure(
            "reverse_accept.exact_file_asset_closure_unsupported",
            "exact-file reverse accept requires one unique applied project Asset",
            "unsupported",
        );
    }
    if (renderAsset.version.canonical.kind !== input.assetKind) {
        throw lifecycleFailure(
            "reverse_accept.exact_file_asset_stale",
            "applied exact-file semantic no longer matches the Deployment Version",
            "conflict",
            true,
        );
    }
    const outputUnits = input.inspected.appliedRenderSnapshot.outputUnits.filter((unit) =>
        input.decision.outputUnitFingerprints.includes(unit.outputUnitFingerprint),
    );
    const owner = input.inspected.operation.registry.getProvider(input.decision.consumerOwnerAdapterId);
    const declarations = owner?.renderContractDeclarations.filter(
        (declaration): declaration is AdapterNativeProjectExactFileRenderDeclarationV1 =>
            declaration.declarationKind === "native_project_exact_file_v1" &&
            declaration.agentRuntimeId === input.decision.semanticRef.consumerAgentRuntimeId &&
            declaration.assetKind === input.assetKind &&
            outputUnits.some(
                (unit) =>
                    unit.outputContractId === declaration.outputContractId &&
                    unit.outputContractFingerprint ===
                        input.inspected.operation.registry.getOutputContract(declaration.outputContractId)
                            ?.outputContractFingerprint,
            ),
    );
    const declaration = declarations?.[0];
    if (owner === null || declarations?.length !== 1 || declaration === undefined || outputUnits.length !== 1) {
        throw lifecycleFailure(
            "reverse_accept.exact_file_contract_stale",
            "applied exact-file semantic has no unique current Provider declaration",
            "conflict",
            true,
        );
    }
    const parent = readVersionAuthority(
        input.configuration.render.assetsRoot,
        input.subject.assetId,
        input.subject.versionId,
        input.configuration.render.dialectRegistry,
    );
    if (
        parent === null ||
        parent.manifest.status !== "complete" ||
        parent.manifest.kind !== input.assetKind ||
        parent.files.length !== 1 ||
        parent.files[0]?.file.fileId !== input.subject.fileId ||
        parent.files[0].contentKind !== "text" ||
        input.change.replacementContent.contentKind !== "text"
    ) {
        throw lifecycleFailure(
            "reverse_accept.exact_file_parent_unavailable",
            "exact-file reverse parent Version is missing or outside the one-file contract",
            "conflict",
            true,
        );
    }
    const sourceFile = parent.files[0];
    const canonicalStats = textPayloadStats(input.change.replacementContent.text);
    const replacement: AssetVersionFileContentV2 = {
        contentKind: "text",
        text: input.change.replacementContent.text,
        file: {
            ...structuredClone(sourceFile.file),
            contentKind: "text",
            contentHash: canonicalStats.contentHash,
            byteSize: canonicalStats.byteSize,
        },
    };
    const canonical = {
        kind: input.assetKind,
        typeData: structuredClone(parent.manifest.typeData),
    } as Extract<AssetKindTypeDataV2, { kind: ExactFileReverseAssetKind }>;
    const files = [replacement];
    const versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(
        canonical,
        files.map((file) => file.file),
    );
    const changedTarget = input.inspected.input.files.find(
        (file) => file.relativePath === input.inspected.result.files[0]?.relativePath,
    );
    if (changedTarget?.currentContent.contentKind !== "text") {
        throw lifecycleFailure(
            "reverse_accept.exact_file_target_unavailable",
            "exact-file reverse target text is unavailable",
            "conflict",
            true,
        );
    }
    const nativeInput = resolveExactFileAppliedNativeInput({
        inspected: input.inspected,
        owner,
        decision: input.decision,
        parent,
        nativeDialectId: declaration.nativeDialectId,
    });
    const dialect = rebuildExactFileNativeDialectAuthority({
        nativeInput,
        canonical,
        files,
        nativeDialectId: declaration.nativeDialectId,
        targetRelativePath: changedTarget.relativePath,
        nativeText: changedTarget.currentContent.text,
        versionCanonicalContentFingerprint,
        registry: input.configuration.render.dialectRegistry,
    });
    const asset = requireAvailableStagedAsset(
        readAssetManifest(input.configuration.render.assetsRoot, input.subject.assetId),
        input.stagedVersionId,
    );
    const revision = nextAssetRevision(asset, (versionId) =>
        readVersionAuthority(
            input.configuration.render.assetsRoot,
            input.subject.assetId,
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
        assetId: input.subject.assetId,
        versionId: input.stagedVersionId,
        revision,
        parentVersionId: parent.manifest.versionId,
        parentOriginAuthorityFingerprint: parent.manifest.originAuthority.authorityFingerprint,
        promotionRequirement: parent.manifest.originAuthority.promotionRequirement,
        canonical,
        files,
        portableDialectContracts,
        nativeRepresentations: dialect.nativeRepresentations,
        dialectRestorationPayloads,
        nativePayloads: dialect.nativePayloads,
        restorationPayloads,
        versionCanonicalContentFingerprint,
        versionFingerprint: computeVersionFingerprint(
            versionCanonicalContentFingerprint,
            dialect.nativeRepresentations,
            dialectRestorationPayloads,
            portableDialectContracts,
        ),
    };
}

type ExactFileNativeInput = Extract<ProviderRenderDialectInput, { inputKind: "native_representation" }>;

function resolveExactFileAppliedNativeInput(input: {
    inspected: DeploymentInspectionAuthorityV1;
    owner: NonNullable<ReturnType<DeploymentInspectionAuthorityV1["operation"]["registry"]["getProvider"]>>;
    decision: DeploymentInspectionAuthorityV1["appliedRenderSnapshot"]["decisions"][number];
    parent: VersionAuthorityClosureV1;
    nativeDialectId: string;
}): ExactFileNativeInput {
    const groups = resolveOperationDialectInputs(input.inspected.operation, input.owner, input.inspected.operation.deployment, [
        input.decision.semanticRef,
    ]);
    const group = groups[0];
    const nativeInputs = group?.inputs.filter(
        (candidate): candidate is ExactFileNativeInput => candidate.inputKind === "native_representation",
    );
    const nativeInput = nativeInputs?.[0];
    if (
        groups.length !== 1 ||
        group === undefined ||
        group.targetVersion.assetId !== input.parent.manifest.assetId ||
        group.targetVersion.versionId !== input.parent.manifest.versionId ||
        nativeInputs?.length !== 1 ||
        nativeInput === undefined ||
        nativeInput.representation.dialectId !== input.nativeDialectId
    ) {
        throw lifecycleFailure(
            "reverse_accept.exact_file_native_input_stale",
            "exact-file reverse has no unique applied target-dialect input",
            "conflict",
            true,
        );
    }
    const lineageMatches =
        nativeInput.inputRole === "current_exact"
            ? nativeInput.representation.canonicalContentFingerprint === input.parent.manifest.versionCanonicalContentFingerprint
            : input.parent.manifest.sourceVersionId !== "" &&
              nativeInput.sourceVersion.assetId === input.parent.manifest.assetId &&
              nativeInput.sourceVersion.versionId === input.parent.manifest.sourceVersionId;
    if (!lineageMatches) {
        throw lifecycleFailure(
            "reverse_accept.exact_file_native_input_stale",
            "exact-file reverse target-dialect input no longer matches the immediate Version lineage",
            "conflict",
            true,
        );
    }
    return nativeInput;
}

export function rebuildExactFileNativeDialectAuthority(input: {
    nativeInput: ExactFileNativeInput;
    canonical: Extract<AssetKindTypeDataV2, { kind: ExactFileReverseAssetKind }>;
    files: AssetVersionFileContentV2[];
    nativeDialectId: string;
    targetRelativePath: string;
    nativeText: string;
    versionCanonicalContentFingerprint: Sha256Digest;
    registry: DeploymentLifecycleConfiguration["render"]["dialectRegistry"];
}): Pick<StagedReverseVersionContentV1, "nativeRepresentations" | "nativePayloads"> {
    const representation = input.nativeInput.representation;
    const nativeFile = input.nativeInput.files[0];
    const sourceFile = input.files[0];
    if (
        representation.schemaVersion !== 1 ||
        representation.dialectId !== input.nativeDialectId ||
        input.nativeInput.files.length !== 1 ||
        nativeFile?.relativePath !== input.targetRelativePath ||
        nativeFile?.contentKind !== "text" ||
        nativeFile.executable ||
        input.files.length !== 1 ||
        sourceFile?.contentKind !== "text" ||
        sourceFile.file.role !== "entry" ||
        sourceFile.file.executable ||
        sourceFile.file.references.length !== 0
    ) {
        throw lifecycleFailure(
            "reverse_accept.exact_file_native_dialect_unsupported",
            "exact-file reverse requires one matching selected native text file",
            "unsupported",
        );
    }
    const { text: _oldText, ...descriptor } = nativeFile;
    const nativeBytes = new Uint8Array(Buffer.from(input.nativeText, "utf8"));
    const nativeStats = binaryPayloadStats(nativeBytes);
    const nextDescriptor = {
        ...structuredClone(descriptor),
        contentHash: nativeStats.contentHash,
        byteSize: nativeStats.byteSize,
    };
    const { representationFingerprint: _oldFingerprint, ...oldPreimage } = representation;
    const preimage: Omit<VersionNativeRepresentationV1, "representationFingerprint"> = {
        ...structuredClone(oldPreimage),
        canonicalContentFingerprint: input.versionCanonicalContentFingerprint,
        files: [nextDescriptor],
    };
    const nextRepresentation: VersionNativeRepresentationV1 = {
        ...preimage,
        representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage),
    };
    const nextPayload = {
        dialectId: input.nativeDialectId,
        files: [{ relativePath: input.targetRelativePath, bytes: nativeBytes }],
    };
    const contract = input.registry.getNative(input.canonical.kind, input.nativeDialectId);
    if (
        contract === null ||
        contract.contractFingerprint !== representation.dialectContractFingerprint ||
        !contract.validateSameContent({
            canonical: input.canonical,
            canonicalFiles: input.files,
            representation: nextRepresentation,
            nativeFiles: nextPayload.files,
        })
    ) {
        throw lifecycleFailure(
            "reverse_accept.exact_file_native_dialect_unsupported",
            "exact-file native dialect validator rejected the changed target bytes",
            "unsupported",
        );
    }
    return { nativeRepresentations: [nextRepresentation], nativePayloads: [nextPayload] };
}
