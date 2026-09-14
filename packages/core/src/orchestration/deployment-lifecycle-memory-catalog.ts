/** Reverse staging for one zero-canonical-file Memory Catalog native index. */

import { readAssetManifest } from "../catalog/asset-manifest";
import { binaryPayloadStats } from "../catalog/payload-store";
import { readVersionAuthority, type VersionAuthorityClosureV1 } from "../catalog/version-authority";
import type { VersionNativeRepresentationV1 } from "../contracts/persistence";
import type { ProviderRenderDialectInput } from "../contracts/render";
import type { AttributedSemanticChange } from "../contracts/reverse";
import type { AdapterNativeProjectExactFileRenderDeclarationV1 } from "../contracts/source-import";
import type { AssetKindTypeDataV2, MemoryCatalogTypeDataV2 } from "../contracts/specs";
import {
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeVersionNativeRepresentationFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { getAssetSpecHandler } from "../specs/registry";
import type { Sha256Digest, UuidV4 } from "../types";
import type { DeploymentInspectionAuthorityV1 } from "./deployment-inspection-service";
import type { DeploymentLifecycleConfiguration, StagedReverseVersionContentV1 } from "./deployment-lifecycle-model";
import { lifecycleFailure } from "./deployment-lifecycle-shared";
import { nextAssetRevision, requireAvailableStagedAsset } from "./deployment-lifecycle-version-authority";
import { type RenderBaseAuthority, resolveOperationDialectInputs } from "./deployment-render-authority";

type CatalogChange = Extract<AttributedSemanticChange, { changeKind: "asset_type_data_replacement" }>;
type CatalogNativeInput = Extract<ProviderRenderDialectInput, { inputKind: "native_representation" }>;
type MemoryCatalogCanonical = { kind: "Memory"; typeData: MemoryCatalogTypeDataV2 };

export function tryBuildMemoryCatalogStagedReverseVersionContent(input: {
    configuration: DeploymentLifecycleConfiguration;
    inspected: DeploymentInspectionAuthorityV1;
    base: RenderBaseAuthority;
    stagedVersionId: UuidV4;
}): StagedReverseVersionContentV1 | null {
    const change = input.inspected.result.changes[0];
    if (change?.changeKind !== "asset_type_data_replacement") return null;
    const catalogChange = requireMemoryCatalogChange(input.inspected, change);
    const semanticRef = catalogChange.semanticRefFingerprints[0] as Sha256Digest;
    const decisions = input.inspected.appliedRenderSnapshot.decisions.filter(
        (decision) =>
            decision.semanticRef.semanticRefFingerprint === semanticRef &&
            decision.semanticRef.semanticKind === "memory.support" &&
            decision.semanticRef.subject.subjectKind === "asset",
    );
    const decision = decisions[0];
    if (decisions.length !== 1 || decision === undefined) {
        throw catalogFailure(
            "reverse_accept.memory_catalog_subject_ambiguous",
            "Memory Catalog reverse does not bind one applied Catalog Asset",
        );
    }
    const subject = decision.semanticRef.subject;
    const renderAssets = input.base.assets.filter(
        (asset) => asset.version.ref.assetId === subject.assetId && asset.version.ref.versionId === subject.versionId,
    );
    const appliedAssets = input.base.appliedInputsSnapshot.assets.filter(
        (asset) => asset.assetId === subject.assetId && asset.versionId === subject.versionId,
    );
    const renderAsset = renderAssets[0];
    if (
        renderAssets.length !== 1 ||
        appliedAssets.length !== 1 ||
        renderAsset.version.status !== "complete" ||
        renderAsset.version.canonical.kind !== "Memory" ||
        renderAsset.version.canonical.typeData.entityRole !== "catalog" ||
        renderAsset.version.files.length !== 0 ||
        Object.keys(renderAsset.sectionHandles).length !== 0
    ) {
        throw catalogFailure(
            "reverse_accept.memory_catalog_asset_closure_unsupported",
            "Memory Catalog reverse requires one complete zero-file applied Catalog Asset",
        );
    }
    const canonical = structuredClone(catalogChange.replacement) as Extract<AssetKindTypeDataV2, { kind: "Memory" }>;
    if (
        canonical.kind !== "Memory" ||
        canonical.typeData.entityRole !== "catalog" ||
        !getAssetSpecHandler("Memory").isCanonicalPair(canonical) ||
        new Set(canonical.typeData.members.map((member) => member.targetAssetVersionId)).size !==
            canonical.typeData.members.length
    ) {
        throw catalogFailure(
            "reverse_accept.memory_catalog_canonical_invalid",
            "Memory Catalog reverse produced an invalid canonical membership list",
        );
    }
    requireDeployedMemoryUnitMembers(input.base, renderAsset, canonical as MemoryCatalogCanonical);

    const outputUnits = input.inspected.appliedRenderSnapshot.outputUnits.filter((unit) =>
        decision.outputUnitFingerprints.includes(unit.outputUnitFingerprint),
    );
    const outputUnit = outputUnits[0];
    const owner = input.inspected.operation.registry.getProvider(decision.consumerOwnerAdapterId);
    const declarations = owner?.renderContractDeclarations.filter(
        (declaration): declaration is AdapterNativeProjectExactFileRenderDeclarationV1 =>
            declaration.declarationKind === "native_project_exact_file_v1" &&
            declaration.agentRuntimeId === decision.semanticRef.consumerAgentRuntimeId &&
            declaration.assetKind === "Memory" &&
            outputUnit !== undefined &&
            declaration.outputContractId === outputUnit.outputContractId &&
            outputUnit.outputContractFingerprint ===
                input.inspected.operation.registry.getOutputContract(declaration.outputContractId)?.outputContractFingerprint,
    );
    const declaration = declarations?.[0];
    const changedTarget = input.inspected.input.files[0];
    const claim = outputUnit?.claims[0];
    if (
        owner === null ||
        declarations?.length !== 1 ||
        declaration === undefined ||
        outputUnits.length !== 1 ||
        outputUnit === undefined ||
        outputUnit.claims.length !== 1 ||
        claim?.contentKind !== "text" ||
        claim.executable ||
        changedTarget?.fileState !== "baseline_changed" ||
        changedTarget.currentContent.contentKind !== "text" ||
        changedTarget.relativePath !== claim.relativePath
    ) {
        throw catalogFailure(
            "reverse_accept.memory_catalog_contract_stale",
            "Memory Catalog reverse has no unique current Provider target contract and changed text",
            "conflict",
            true,
        );
    }
    const parent = readVersionAuthority(
        input.configuration.render.assetsRoot,
        subject.assetId,
        subject.versionId,
        input.configuration.render.dialectRegistry,
    );
    if (
        parent === null ||
        parent.manifest.status !== "complete" ||
        parent.manifest.kind !== "Memory" ||
        parent.manifest.typeData.entityRole !== "catalog" ||
        parent.manifest.fingerprint !== renderAsset.version.versionFingerprint ||
        parent.files.length !== 0
    ) {
        throw catalogFailure(
            "reverse_accept.memory_catalog_parent_unavailable",
            "Memory Catalog reverse parent Version is missing or outside the zero-file Catalog contract",
            "conflict",
            true,
        );
    }
    const nativeInput = resolveAppliedCatalogNativeInput({
        inspected: input.inspected,
        owner,
        decision,
        parent,
        nativeDialectId: declaration.nativeDialectId,
    });
    const files: [] = [];
    const versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(canonical, []);
    const dialect = rebuildMemoryCatalogNativeAuthority({
        nativeInput,
        canonical: canonical as MemoryCatalogCanonical,
        nativeDialectId: declaration.nativeDialectId,
        targetRelativePath: changedTarget.relativePath,
        nativeText: changedTarget.currentContent.text,
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
    const restorationPayloads = structuredClone(parent.restorationPayloads);
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

function requireMemoryCatalogChange(inspected: DeploymentInspectionAuthorityV1, change: CatalogChange): CatalogChange {
    const file = inspected.result.files[0];
    if (
        stableStringify({
            status: inspected.result.status,
            inputFiles: inspected.input.files.length,
            inventoryDeltas: inspected.input.inventoryDeltas.length,
            changes: inspected.result.changes.length,
            files: inspected.result.files.length,
            semanticRefs: change.semanticRefFingerprints.length,
            attributionState: file?.attributionState,
            changeFingerprints: file?.attributionState === "uniquely_attributable" ? file.changeFingerprints : [],
        }) !==
        stableStringify({
            status: "complete",
            inputFiles: 1,
            inventoryDeltas: 0,
            changes: 1,
            files: 1,
            semanticRefs: 1,
            attributionState: "uniquely_attributable",
            changeFingerprints: [change.changeFingerprint],
        })
    ) {
        throw catalogFailure(
            "reverse_accept.memory_catalog_change_unsupported",
            "Memory Catalog reverse accepts exactly one uniquely attributable membership replacement",
        );
    }
    return change;
}

function requireDeployedMemoryUnitMembers(
    base: RenderBaseAuthority,
    catalog: RenderBaseAuthority["assets"][number],
    canonical: MemoryCatalogCanonical,
): void {
    const versions = new Map(
        base.assets
            .filter(
                (asset) =>
                    asset.version.status === "complete" &&
                    asset.version.canonical.kind === "Memory" &&
                    asset.version.canonical.typeData.entityRole === "unit" &&
                    asset.scope === catalog.scope &&
                    asset.projectId === catalog.projectId &&
                    asset.scopePath === catalog.scopePath,
            )
            .map((asset) => [asset.version.ref.versionId, asset]),
    );
    if (
        canonical.typeData.members.some((member) => {
            const unit = versions.get(member.targetAssetVersionId);
            return (
                unit === undefined ||
                base.appliedInputsSnapshot.assets.filter(
                    (asset) => asset.assetId === unit.version.ref.assetId && asset.versionId === unit.version.ref.versionId,
                ).length !== 1
            );
        })
    ) {
        throw catalogFailure(
            "reverse_accept.memory_catalog_member_unavailable",
            "Memory Catalog reverse may reference only complete same-scope Memory Units in this Deployment",
        );
    }
}

function resolveAppliedCatalogNativeInput(input: {
    inspected: DeploymentInspectionAuthorityV1;
    owner: NonNullable<ReturnType<DeploymentInspectionAuthorityV1["operation"]["registry"]["getProvider"]>>;
    decision: DeploymentInspectionAuthorityV1["appliedRenderSnapshot"]["decisions"][number];
    parent: VersionAuthorityClosureV1;
    nativeDialectId: string;
}): CatalogNativeInput {
    const groups = resolveOperationDialectInputs(input.inspected.operation, input.owner, input.inspected.operation.deployment, [
        input.decision.semanticRef,
    ]);
    const matching = groups.filter(
        (group) =>
            group.targetVersion.assetId === input.parent.manifest.assetId &&
            group.targetVersion.versionId === input.parent.manifest.versionId,
    );
    const nativeInputs = matching[0]?.inputs.filter(
        (candidate): candidate is CatalogNativeInput =>
            candidate.inputKind === "native_representation" && candidate.representation.dialectId === input.nativeDialectId,
    );
    const nativeInput = nativeInputs?.[0];
    if (matching.length !== 1 || nativeInputs?.length !== 1 || nativeInput === undefined) {
        throw catalogFailure(
            "reverse_accept.memory_catalog_native_input_stale",
            "Memory Catalog reverse has no unique applied target-dialect input",
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
        throw catalogFailure(
            "reverse_accept.memory_catalog_native_input_stale",
            "Memory Catalog reverse target-dialect input no longer matches the immediate Version lineage",
            "conflict",
            true,
        );
    }
    return nativeInput;
}

function rebuildMemoryCatalogNativeAuthority(input: {
    nativeInput: CatalogNativeInput;
    canonical: MemoryCatalogCanonical;
    nativeDialectId: string;
    targetRelativePath: string;
    nativeText: string;
    versionCanonicalContentFingerprint: Sha256Digest;
    registry: DeploymentLifecycleConfiguration["render"]["dialectRegistry"];
}): Pick<StagedReverseVersionContentV1, "nativeRepresentations" | "nativePayloads"> {
    const nativeFile = input.nativeInput.files[0];
    const representation = input.nativeInput.representation;
    if (
        representation.schemaVersion !== 1 ||
        input.canonical.typeData.entityRole !== "catalog" ||
        input.nativeInput.files.length !== 1 ||
        nativeFile?.contentKind !== "text" ||
        nativeFile.relativePath !== input.targetRelativePath ||
        nativeFile.executable
    ) {
        throw catalogFailure(
            "reverse_accept.memory_catalog_native_dialect_unsupported",
            "Memory Catalog reverse requires one matching selected native text index",
        );
    }
    const nativeBytes = new Uint8Array(Buffer.from(input.nativeText, "utf8"));
    const nativeStats = binaryPayloadStats(nativeBytes);
    const { text: _text, ...descriptor } = nativeFile;
    const { representationFingerprint: _fingerprint, ...oldPreimage } = representation;
    const preimage: Omit<VersionNativeRepresentationV1, "representationFingerprint"> = {
        ...structuredClone(oldPreimage),
        canonicalContentFingerprint: input.versionCanonicalContentFingerprint,
        files: [{ ...structuredClone(descriptor), ...nativeStats }],
    };
    const nextRepresentation: VersionNativeRepresentationV1 = {
        ...preimage,
        representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage),
    };
    const nextPayload = {
        dialectId: input.nativeDialectId,
        files: [{ relativePath: input.targetRelativePath, bytes: nativeBytes }],
    };
    const contract = input.registry.getNative("Memory", input.nativeDialectId);
    if (
        contract === null ||
        contract.contractFingerprint !== representation.dialectContractFingerprint ||
        !contract.validateSameContent({
            canonical: input.canonical,
            canonicalFiles: [],
            representation: nextRepresentation,
            nativeFiles: nextPayload.files,
        })
    ) {
        throw catalogFailure(
            "reverse_accept.memory_catalog_native_dialect_unsupported",
            "Memory Catalog native dialect validator rejected the changed index",
        );
    }
    return { nativeRepresentations: [nextRepresentation], nativePayloads: [nextPayload] };
}

function catalogFailure(
    code: string,
    message: string,
    causeKind: "unsupported" | "conflict" = "unsupported",
    retryable = false,
): ReturnType<typeof lifecycleFailure> {
    return lifecycleFailure(code, message, causeKind, retryable);
}
