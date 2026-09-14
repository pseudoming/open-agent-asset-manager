/** Fresh reverse Version, render base, lineage, and promotion projection. */

import { readAssetManifest } from "../catalog/asset-manifest";
import { binaryPayloadStats, textPayloadStats } from "../catalog/payload-store";
import { buildPromotionGrantAuthority, listPromotionGrantAuthorities } from "../catalog/promotion-grant-store";
import { getRestrictedSourceFullAccessAuthority } from "../catalog/settings-authority";
import {
    readAssetManifestAuthoritySet,
    readVersionAuthority,
    type VersionAuthorityClosureV1,
} from "../catalog/version-authority";
import { resolveVersionSourcePromotionSafety } from "../catalog/version-origin-lineage";
import type { AssetVersionFileContentV2, AssetVersionManifestV2 } from "../contracts/asset-version";
import type {
    PromotionGrantV1,
    VersionNativeRepresentation,
    VersionNativeRepresentationV1,
    VersionNativeRepresentationV2,
    VersionOriginAuthorityV1,
} from "../contracts/persistence";
import type { RenderVersionDialectInputs, RenderAssetInput, RenderDeploymentInput } from "../contracts/render";
import type { AttributedSemanticChange } from "../contracts/reverse";
import type { AssetKindTypeDataV2 } from "../contracts/specs";
import {
    type CanonicalDeploymentPreCommitDatabaseStateV1,
    readCanonicalDeploymentPreCommitDatabaseState,
} from "../deployment/deployment-state-authority";
import {
    computeDeploymentAuthorityFingerprint,
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeVersionNativeRepresentationFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { isUuidV4 } from "../foundation/validators";
import { projectVersionDialectInputs } from "../render/render-dialect-authority";
import { promotionTargetForDeployment } from "../render/render-promotion-authorization";
import type { FreshReverseAcceptPreparationDraft, ResolveFreshReverseAcceptCommitInput } from "../reverse/reverse-accept-service";
import type { AppliedInputsSnapshotV1, Sha256Digest, UuidV4 } from "../types";
import {
    type DeploymentInspectionAuthorityV1,
    type DeploymentInspectionServiceDependencies,
    inspectDeploymentRuntimeAuthority,
    inspectDeploymentRuntimeAuthorityForReverseResolver,
} from "./deployment-inspection-service";
import { buildExactFileStagedReverseVersionContent, exactFileAssetKindForSemantic } from "./deployment-lifecycle-exact-file";
import { tryBuildExactGraphStagedReverseVersionContent } from "./deployment-lifecycle-exact-graph";
import { tryBuildMemoryCatalogStagedReverseVersionContent } from "./deployment-lifecycle-memory-catalog";
import type {
    DeploymentLifecycleConfiguration,
    FreshReverseProjection,
    StagedReverseVersionContentV1,
} from "./deployment-lifecycle-model";
import { appliedRuleReverseContractKind } from "./deployment-lifecycle-rule-reverse-contract";
import { lifecycleFailure, requireComplete } from "./deployment-lifecycle-shared";
import { nextAssetRevision, requireAvailableStagedAsset } from "./deployment-lifecycle-version-authority";
import type { RenderBaseAuthority, RenderOperationAuthority } from "./deployment-render-authority";
import { loadRenderBaseAuthority, reprojectObservedReverseRenderOperation, runAnalysis } from "./deployment-render-service";
import { withSelectedMemoryCatalogCapture } from "./deployment-target-operations";

export { nextAssetRevision, requireAvailableStagedAsset } from "./deployment-lifecycle-version-authority";

export async function buildFreshReverseProjection(
    configuration: DeploymentLifecycleConfiguration,
    dependencies: DeploymentInspectionServiceDependencies,
    deploymentId: UuidV4,
    expectedInspectionResultFingerprint: Sha256Digest,
    stagedVersionId: UuidV4,
    reverseResolverOwnsLocks: boolean,
): Promise<FreshReverseProjection> {
    const inspected = requireComplete(
        await (reverseResolverOwnsLocks
            ? inspectDeploymentRuntimeAuthorityForReverseResolver(deploymentId, configuration.render, dependencies)
            : inspectDeploymentRuntimeAuthority(deploymentId, configuration.render, dependencies)),
    );
    if (inspected.result.inspectionResultFingerprint !== expectedInspectionResultFingerprint) {
        throw lifecycleFailure(
            "reverse_accept.inspection_stale",
            "runtime inspection changed before reverse preparation or commit",
            "conflict",
            true,
        );
    }
    const currentBase = loadRenderBaseAuthority(configuration.render, deploymentId);
    const content = buildStagedReverseVersionContent(
        configuration,
        inspected,
        currentBase,
        stagedVersionId,
        dependencies.resolveRetainedInspectionRegistry,
    );
    const base = projectStagedRenderBase(currentBase, content);
    const operation = await withSelectedMemoryCatalogCapture(configuration.render, base, (capture) =>
        reprojectObservedReverseRenderOperation(base, inspected, dependencies, capture),
    );
    const analysis = requireComplete(await runAnalysis(operation));
    const canonical = readCanonicalDeploymentPreCommitDatabaseState(configuration.databasePath, deploymentId);
    const deploymentAuthorityFingerprint = projectDeploymentAuthorityFingerprint(canonical, inspected, operation);
    const assetManifestAuthorities = readAssetManifestAuthoritySet(
        configuration.render.assetsRoot,
        currentBase.assets.map((asset) => asset.version.ref.assetId),
    );
    return {
        inspected,
        content,
        base,
        operation,
        analysis,
        deploymentAuthorityFingerprint,
        assetManifestAuthorities,
    };
}

export function buildStagedReverseVersionContent(
    configuration: DeploymentLifecycleConfiguration,
    inspected: DeploymentInspectionAuthorityV1,
    base: RenderBaseAuthority,
    stagedVersionId: UuidV4,
    resolveRetainedRegistry?: DeploymentInspectionServiceDependencies["resolveRetainedInspectionRegistry"],
): StagedReverseVersionContentV1 {
    if (!isUuidV4(stagedVersionId)) throw new Error("stagedVersionId must be UUID v4");
    const memoryCatalog = tryBuildMemoryCatalogStagedReverseVersionContent({
        configuration,
        inspected,
        base,
        stagedVersionId,
    });
    if (memoryCatalog !== null) return memoryCatalog;
    const exactGraph = tryBuildExactGraphStagedReverseVersionContent({
        configuration,
        inspected,
        base,
        stagedVersionId,
        resolveRetainedRegistry,
    });
    if (exactGraph !== null) return exactGraph;
    const change = requireOneWholeFileContentChange(inspected);
    const semanticRef = change.semanticRefFingerprints[0] as Sha256Digest;
    const decisions = inspected.appliedRenderSnapshot.decisions.filter(
        (decision) =>
            decision.semanticRef.semanticRefFingerprint === semanticRef && decision.semanticRef.subject.subjectKind === "file",
    );
    if (decisions.length !== 1) {
        throw lifecycleFailure(
            "reverse_accept.semantic_subject_ambiguous",
            "whole-file change does not bind one applied file semantic supported by T5",
        );
    }
    const decision = decisions[0] as (typeof decisions)[number];
    const subject = decision.semanticRef.subject as Extract<typeof decision.semanticRef.subject, { subjectKind: "file" }>;
    const exactAssetKind = exactFileAssetKindForSemantic(decision.semanticRef.semanticKind);
    if (exactAssetKind !== null) {
        const contractKind =
            exactAssetKind === "Rule" ? appliedRuleReverseContractKind(inspected, decision) : "native_project_exact_file_v1";
        if (contractKind === "unknown") {
            throw lifecycleFailure(
                "reverse_accept.rule_contract_stale",
                "applied Rule semantic has no unique current reverse contract",
                "conflict",
                true,
            );
        }
        if (contractKind === "native_project_exact_file_v1") {
            return buildExactFileStagedReverseVersionContent({
                configuration,
                inspected,
                base,
                stagedVersionId,
                change,
                decision,
                subject,
                assetKind: exactAssetKind,
            });
        }
    }
    if (decision.semanticRef.semanticKind !== "guidance.content" && decision.semanticRef.semanticKind !== "rule.content") {
        throw lifecycleFailure(
            "reverse_accept.semantic_subject_ambiguous",
            "whole-file change does not bind one supported applied file semantic",
        );
    }
    const assetKind = decision.semanticRef.semanticKind === "guidance.content" ? "Guidance" : "Rule";
    if (
        base.assets.length !== 1 ||
        base.appliedInputsSnapshot.assets.length !== 1 ||
        base.appliedInputsSnapshot.assets[0]?.assetId !== subject.assetId
    ) {
        throw lifecycleFailure(
            "reverse_accept.t5_asset_closure_unsupported",
            "T5 reverse accept supports one exact project Guidance or Rule Asset",
            "unsupported",
        );
    }
    requireT5WholeFileRenderAsset(base, subject, assetKind);
    const parent = readVersionAuthority(
        configuration.render.assetsRoot,
        subject.assetId,
        subject.versionId,
        configuration.render.dialectRegistry,
    );
    const validatedParent = requireT5ParentSourceFile(parent, subject.fileId, change, assetKind);
    const stats = textPayloadStats(validatedParent.replacementText);
    const replacement: AssetVersionFileContentV2 = {
        contentKind: "text",
        text: validatedParent.replacementText,
        file: {
            ...structuredClone(validatedParent.sourceFile.file),
            contentKind: "text",
            contentHash: stats.contentHash,
            byteSize: stats.byteSize,
        },
    };
    const files = [replacement];
    const canonical = {
        kind: assetKind,
        typeData: structuredClone(validatedParent.parent.manifest.typeData),
    } as Extract<AssetKindTypeDataV2, { kind: "Guidance" | "Rule" }>;
    const asset = requireAvailableStagedAsset(
        readAssetManifest(configuration.render.assetsRoot, subject.assetId),
        stagedVersionId,
    );
    const revision = nextAssetRevision(asset, (versionId) =>
        readVersionAuthority(configuration.render.assetsRoot, subject.assetId, versionId, configuration.render.dialectRegistry),
    );
    const versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(
        canonical,
        files.map((file) => file.file),
    );
    const dialect = rebuildWholeFileNativeDialectAuthority({
        parent: validatedParent.parent,
        canonical,
        files,
        replacementText: validatedParent.replacementText,
        versionCanonicalContentFingerprint,
        registry: configuration.render.dialectRegistry,
    });
    return {
        assetId: subject.assetId,
        versionId: stagedVersionId,
        revision,
        parentVersionId: validatedParent.parent.manifest.versionId,
        parentOriginAuthorityFingerprint: validatedParent.parent.manifest.originAuthority.authorityFingerprint,
        promotionRequirement: validatedParent.parent.manifest.originAuthority.promotionRequirement,
        canonical,
        files,
        portableDialectContracts: [],
        nativeRepresentations: dialect.nativeRepresentations,
        dialectRestorationPayloads: [],
        nativePayloads: dialect.nativePayloads,
        restorationPayloads: [],
        versionCanonicalContentFingerprint,
        versionFingerprint: computeVersionFingerprint(versionCanonicalContentFingerprint, dialect.nativeRepresentations, [], []),
    };
}

export function requireT5WholeFileRenderAsset(
    base: RenderBaseAuthority,
    subject: Extract<import("../contracts/deployment-authority").RenderSemanticSubject, { subjectKind: "file" }>,
    assetKind: "Guidance" | "Rule",
): RenderAssetInput {
    const renderAsset = base.assets.find(
        (asset) => asset.version.ref.assetId === subject.assetId && asset.version.ref.versionId === subject.versionId,
    );
    if (renderAsset === undefined || renderAsset.version.canonical.kind !== assetKind) {
        throw lifecycleFailure(
            assetKind === "Guidance" ? "reverse_accept.guidance_asset_stale" : "reverse_accept.rule_asset_stale",
            `applied ${assetKind} semantic no longer matches the Deployment Version`,
            "conflict",
            true,
        );
    }
    return renderAsset;
}

export function requireT5ParentSourceFile(
    parent: VersionAuthorityClosureV1 | null,
    fileId: UuidV4,
    change: Extract<AttributedSemanticChange, { changeKind: "file_content_replacement" }>,
    assetKind: "Guidance" | "Rule",
): {
    parent: VersionAuthorityClosureV1;
    sourceFile: AssetVersionFileContentV2;
    replacementText: string;
} {
    if (parent === null || parent.manifest.status !== "complete") {
        throw lifecycleFailure(
            "reverse_accept.parent_version_unavailable",
            "reverse parent Version is missing or incomplete",
            "conflict",
            true,
        );
    }
    if (parent.manifest.kind !== assetKind) {
        throw lifecycleFailure(
            "reverse_accept.parent_kind_stale",
            `reverse parent Version is not ${assetKind}`,
            "conflict",
            true,
        );
    }
    if (
        parent.files.length !== 1 ||
        parent.files[0]?.file.fileId !== fileId ||
        change.replacementContent.contentKind !== "text"
    ) {
        throw lifecycleFailure(
            "reverse_accept.file_subject_unavailable",
            "reverse change does not provide one text replacement for the source Version file",
            "conflict",
        );
    }
    return {
        parent,
        sourceFile: parent.files[0] as AssetVersionFileContentV2,
        replacementText: change.replacementContent.text,
    };
}

export function rebuildWholeFileNativeDialectAuthority(input: {
    parent: VersionAuthorityClosureV1;
    canonical: Extract<AssetKindTypeDataV2, { kind: "Guidance" | "Rule" }>;
    files: AssetVersionFileContentV2[];
    replacementText: string;
    versionCanonicalContentFingerprint: Sha256Digest;
    registry: DeploymentLifecycleConfiguration["render"]["dialectRegistry"];
}): Pick<StagedReverseVersionContentV1, "nativeRepresentations" | "nativePayloads"> {
    if (
        input.parent.manifest.portableDialectContracts.length > 0 ||
        input.parent.manifest.dialectRestorationPayloads.length > 0 ||
        input.parent.restorationPayloads.length > 0
    ) {
        throw lifecycleFailure(
            "reverse_accept.t5_dialect_projection_unsupported",
            "T5 cannot silently rewrite portable or restoration dialect authority",
            "unsupported",
        );
    }
    const replacementBytes = new Uint8Array(Buffer.from(input.replacementText, "utf8"));
    const replacementStats = binaryPayloadStats(replacementBytes);
    const nativeRepresentations: VersionNativeRepresentation[] = [];
    const nativePayloads: VersionAuthorityClosureV1["nativePayloads"] = [];
    for (const representation of input.parent.manifest.nativeRepresentations) {
        const payload = input.parent.nativePayloads.find((candidate) => candidate.dialectId === representation.dialectId);
        const descriptor = representation.files[0];
        const payloadFile = payload?.files[0];
        if (
            representation.files.length !== 1 ||
            payload?.files.length !== 1 ||
            descriptor === undefined ||
            payloadFile === undefined ||
            descriptor.relativePath !== payloadFile.relativePath ||
            descriptor.contentKind !== "text" ||
            descriptor.executable
        ) {
            throw lifecycleFailure(
                "reverse_accept.t5_native_dialect_unsupported",
                "T5 cannot safely project the changed target into the parent native dialect graph",
                "unsupported",
            );
        }
        const nextDescriptor = {
            ...structuredClone(descriptor),
            contentHash: replacementStats.contentHash,
            byteSize: replacementStats.byteSize,
        };
        const { representationFingerprint: _oldFingerprint, ...oldPreimage } = representation;
        const preimage:
            | Omit<VersionNativeRepresentationV1, "representationFingerprint">
            | Omit<VersionNativeRepresentationV2, "representationFingerprint"> = {
            ...structuredClone(oldPreimage),
            canonicalContentFingerprint: input.versionCanonicalContentFingerprint,
            files: [nextDescriptor],
        };
        const nextRepresentation = {
            ...preimage,
            representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage),
        };
        const nextPayload = {
            dialectId: representation.dialectId,
            files: [{ relativePath: descriptor.relativePath, bytes: replacementBytes }],
        };
        const contract = input.registry.getNative(input.canonical.kind, representation.dialectId);
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
                "reverse_accept.t5_native_dialect_unsupported",
                "T5 native dialect validator rejected the projected target bytes",
                "unsupported",
            );
        }
        nativeRepresentations.push(nextRepresentation as VersionNativeRepresentation);
        nativePayloads.push(nextPayload);
    }
    if (nativePayloads.length !== input.parent.nativePayloads.length) {
        throw lifecycleFailure(
            "reverse_accept.t5_native_dialect_unsupported",
            "T5 parent native dialect membership is inconsistent",
            "unsupported",
        );
    }
    return { nativeRepresentations, nativePayloads };
}

export function requireOneWholeFileContentChange(
    inspected: DeploymentInspectionAuthorityV1,
): Extract<AttributedSemanticChange, { changeKind: "file_content_replacement" }> {
    const changes = inspected.result.changes;
    const files = inspected.result.files;
    if (
        stableStringify({
            status: inspected.result.status,
            inputFiles: inspected.input.files.length,
            inventoryDeltas: inspected.input.inventoryDeltas.length,
            changes: changes.length,
            files: files.length,
        }) !==
        stableStringify({
            status: "complete",
            inputFiles: 1,
            inventoryDeltas: 0,
            changes: 1,
            files: 1,
        })
    ) {
        throw lifecycleFailure(
            "reverse_accept.t5_change_unsupported",
            "T5 accepts exactly one uniquely attributable whole-file Guidance or Rule content replacement",
            "unsupported",
        );
    }
    const file = files[0] as Extract<(typeof files)[number], { attributionState: "uniquely_attributable" }>;
    const change = changes[0] as (typeof changes)[number];
    if (
        stableStringify({
            attributionState: file.attributionState,
            changeFingerprints: file.changeFingerprints,
            expectedChangeFingerprint: change.changeFingerprint,
            changeKind: change.changeKind,
            semanticRefCount: change.semanticRefFingerprints.length,
        }) !==
        stableStringify({
            attributionState: "uniquely_attributable",
            changeFingerprints: [change.changeFingerprint],
            expectedChangeFingerprint: change.changeFingerprint,
            changeKind: "file_content_replacement",
            semanticRefCount: 1,
        })
    ) {
        throw lifecycleFailure(
            "reverse_accept.t5_change_unsupported",
            "T5 accepts exactly one uniquely attributable whole-file Guidance or Rule content replacement",
            "unsupported",
        );
    }
    return change as Extract<AttributedSemanticChange, { changeKind: "file_content_replacement" }>;
}

export function projectStagedRenderBase(base: RenderBaseAuthority, content: StagedReverseVersionContentV1): RenderBaseAuthority {
    const projectedDialectInputs = projectVersionDialectInputs(
        { assetId: content.assetId, versionId: content.versionId },
        {
            nativeRepresentations: content.nativeRepresentations,
            dialectRestorationPayloads: content.dialectRestorationPayloads,
            nativePayloads: content.nativePayloads,
            restorationPayloads: content.restorationPayloads,
        },
    );
    const assetIndexes = base.assets.flatMap((asset, index) => (asset.version.ref.assetId === content.assetId ? [index] : []));
    const appliedAssetIndexes = base.appliedInputsSnapshot.assets.flatMap((asset, index) =>
        asset.assetId === content.assetId ? [index] : [],
    );
    const dialectInputIndexes = base.dialectInputs.flatMap((group, index) =>
        group.targetVersion.assetId === content.assetId ? [index] : [],
    );
    const assetIndex = requireUniqueStagedParentIndex(assetIndexes);
    const appliedAssetIndex = requireUniqueStagedParentIndex(appliedAssetIndexes);
    if (
        base.assets[assetIndex]?.version.ref.versionId !== content.parentVersionId ||
        base.appliedInputsSnapshot.assets[appliedAssetIndex]?.versionId !== content.parentVersionId
    ) {
        throwStagedProjectionStale();
    }
    let dialectInputIndex: number | null = null;
    let obsoleteParentSeedIndex: number | null = null;
    if (projectedDialectInputs === null) {
        if (dialectInputIndexes.length !== 0) {
            obsoleteParentSeedIndex = requireUniqueStagedParentIndex(dialectInputIndexes);
            const group = base.dialectInputs[obsoleteParentSeedIndex];
            if (group === undefined || !isObsoleteParentRebaseSeedGroup(group, content.assetId, content.parentVersionId)) {
                throwStagedProjectionStale();
            }
        }
    } else if (dialectInputIndexes.length !== 0) {
        dialectInputIndex = requireUniqueStagedParentIndex(dialectInputIndexes);
        if (base.dialectInputs[dialectInputIndex]?.targetVersion.versionId !== content.parentVersionId) {
            throwStagedProjectionStale();
        }
    } else if (content.allowFirstNativeDialectProjection !== true) {
        throwStagedProjectionStale();
    }
    const projected = structuredClone(base);
    const asset = projected.assets[assetIndex] as RenderAssetInput;
    projected.assets[assetIndex] = {
        ...asset,
        version: {
            ref: { assetId: content.assetId, versionId: content.versionId },
            versionFingerprint: content.versionFingerprint,
            versionCanonicalContentFingerprint: content.versionCanonicalContentFingerprint,
            status: "complete",
            canonical: structuredClone(content.canonical),
            files: structuredClone(content.files),
        },
        sectionHandles: Object.fromEntries(
            content.files.map((file) => [file.file.fileId, `version:${content.versionId}:file:${file.file.fileId}`]),
        ),
    };
    const appliedAsset = projected.appliedInputsSnapshot.assets[appliedAssetIndex] as AppliedInputsSnapshotV1["assets"][number];
    projected.appliedInputsSnapshot.assets[appliedAssetIndex] = {
        ...appliedAsset,
        versionId: content.versionId,
    };
    if (projectedDialectInputs !== null && dialectInputIndex !== null) {
        projected.dialectInputs[dialectInputIndex] = projectedDialectInputs;
    } else if (projectedDialectInputs !== null) {
        projected.dialectInputs.push(projectedDialectInputs);
        const orderByAssetId = new Map(projected.assets.map((item, index) => [item.version.ref.assetId, index]));
        projected.dialectInputs.sort(
            (left, right) =>
                (orderByAssetId.get(left.targetVersion.assetId) as number) -
                (orderByAssetId.get(right.targetVersion.assetId) as number),
        );
    } else if (obsoleteParentSeedIndex !== null) {
        projected.dialectInputs.splice(obsoleteParentSeedIndex, 1);
    }
    return projected;
}

function isObsoleteParentRebaseSeedGroup(group: RenderVersionDialectInputs, assetId: UuidV4, parentVersionId: UuidV4): boolean {
    if (
        group.targetVersion.assetId !== assetId ||
        group.targetVersion.versionId !== parentVersionId ||
        group.inputs.length === 0
    ) {
        return false;
    }
    let sourceVersionId: UuidV4 | null = null;
    for (const input of group.inputs) {
        if (
            input.inputKind !== "native_representation" ||
            input.inputRole !== "parent_rebase_seed" ||
            input.sourceVersion.assetId !== assetId ||
            input.sourceVersion.versionId === parentVersionId
        ) {
            return false;
        }
        sourceVersionId ??= input.sourceVersion.versionId;
        if (sourceVersionId !== input.sourceVersion.versionId) return false;
    }
    return true;
}

function requireUniqueStagedParentIndex(indexes: readonly number[]): number {
    if (indexes.length !== 1) throwStagedProjectionStale();
    return indexes[0] as number;
}

function throwStagedProjectionStale(): never {
    throw lifecycleFailure(
        "reverse_accept.staged_projection_stale",
        "staged reverse projection no longer matches one unique parent authority",
        "conflict",
        true,
    );
}

export function buildStagedVersionClosure(
    content: StagedReverseVersionContentV1,
    originAuthority: Extract<VersionOriginAuthorityV1, { originKind: "reverse_accept" }>,
    sourceDeploymentId: UuidV4,
): VersionAuthorityClosureV1 {
    if (
        stableStringify({
            assetId: originAuthority.assetId,
            versionId: originAuthority.versionId,
            previousVersionId: originAuthority.previousVersionId,
            previousVersionOriginAuthorityFingerprint: originAuthority.previousVersionOriginAuthorityFingerprint,
            promotionRequirement: originAuthority.promotionRequirement,
        }) !==
        stableStringify({
            assetId: content.assetId,
            versionId: content.versionId,
            previousVersionId: content.parentVersionId,
            previousVersionOriginAuthorityFingerprint: content.parentOriginAuthorityFingerprint,
            promotionRequirement: content.promotionRequirement,
        })
    ) {
        throw lifecycleFailure(
            "reverse_accept.origin_stale",
            "final reverse origin no longer matches the staged Version lineage",
            "conflict",
            true,
        );
    }
    const manifest: AssetVersionManifestV2 = {
        schemaVersion: 2,
        versionId: content.versionId,
        assetId: content.assetId,
        revision: content.revision,
        fingerprint: content.versionFingerprint,
        status: "complete",
        diagnostics: [],
        ...structuredClone(content.canonical),
        files: content.files.map((file) => structuredClone(file.file)),
        changeKind: "sync",
        sourceVersionId: content.parentVersionId,
        sourceDeploymentId,
        changeNote: "",
        createdAt: originAuthority.createdAt,
        versionCanonicalContentFingerprint: content.versionCanonicalContentFingerprint,
        portableDialectContracts: structuredClone(content.portableDialectContracts),
        nativeRepresentations: structuredClone(content.nativeRepresentations),
        dialectRestorationPayloads: structuredClone(content.dialectRestorationPayloads),
        originAuthority: structuredClone(originAuthority),
    };
    return {
        manifest,
        files: structuredClone(content.files),
        nativePayloads: structuredClone(content.nativePayloads),
        restorationPayloads: structuredClone(content.restorationPayloads),
    };
}

export function projectDeploymentAuthorityFingerprint(
    canonical: CanonicalDeploymentPreCommitDatabaseStateV1,
    inspected: DeploymentInspectionAuthorityV1,
    operation: RenderOperationAuthority,
): Sha256Digest {
    return computeDeploymentAuthorityFingerprint({
        deploymentId: canonical.deployment.deploymentId,
        deleted: canonical.deployment.deleted,
        platform: canonical.deployment.platform,
        platformInstanceId: canonical.deployment.platformInstanceId,
        targetRootPath: canonical.deployment.targetRootPath,
        projectId: canonical.deployment.projectId,
        consumerAgentRuntimeIds: canonical.deployment.consumerAgentRuntimeIds,
        deploymentAssets: canonical.deploymentAssets.map((asset) => ({
            assetId: asset.assetId,
            versionId: asset.versionId,
            sortOrder: asset.sortOrder,
            allowIncomplete: asset.allowIncomplete,
            deleted: asset.deleted,
        })),
        appliedCompilationFingerprint: inspected.appliedRenderSnapshot.compilationFingerprint,
        committedTransactionId: canonical.deployment.committedTransactionId,
        renderRegistryFingerprint: operation.registry.fingerprint,
        freshRenderInputFingerprint: operation.deployment.renderInputFingerprint,
    });
}

export function resolvePreparationPromotionState(
    configuration: DeploymentLifecycleConfiguration,
    content: StagedReverseVersionContentV1,
    deployment: RenderDeploymentInput,
): FreshReverseAcceptPreparationDraft["promotionState"] {
    if (content.promotionRequirement === "not_required") return "already_authorized";
    const target = promotionTargetForDeployment(deployment);
    const asset = readAssetManifest(configuration.render.assetsRoot, content.assetId);
    if (asset === null) return "user_confirmation_required";
    const allVersionGrant = listPromotionGrantAuthorities(configuration.render.assetsRoot, content.assetId).some(
        (grant) =>
            grant.grantState === "active" &&
            grant.subject.subjectKind === "asset_all_versions" &&
            asset.versionIds.includes(grant.subject.activationVersionId) &&
            stableStringify(grant.target) === stableStringify(target),
    );
    if (allVersionGrant) return "already_authorized";
    const fullAccess = getRestrictedSourceFullAccessAuthority(configuration.render.oaamRoot);
    if (fullAccess.state !== "enabled") return "user_confirmation_required";
    const parent = readVersionAuthority(
        configuration.render.assetsRoot,
        content.assetId,
        content.parentVersionId,
        configuration.render.dialectRegistry,
    );
    return parent !== null && importedPromotionSafety(configuration, parent) === "requires_user_confirmation"
        ? "already_authorized"
        : "user_confirmation_required";
}

export function importedPromotionSafety(
    configuration: DeploymentLifecycleConfiguration,
    closure: VersionAuthorityClosureV1,
): "default_promotable" | "requires_user_confirmation" | null {
    const resolved = resolveVersionSourcePromotionSafety(closure, (assetId, versionId) =>
        readVersionAuthority(configuration.render.assetsRoot, assetId, versionId, configuration.render.dialectRegistry),
    );
    if (resolved.status === "broken") {
        throw lifecycleFailure("reverse_accept.origin_lineage_broken", resolved.message, "conflict");
    }
    return resolved.promotionSafety;
}

export function pendingPromotionGrant(
    input: ResolveFreshReverseAcceptCommitInput,
    deployment: RenderDeploymentInput,
): PromotionGrantV1 | undefined {
    if (input.request.newVersionPromotion.promotionAction === "use_existing_authority") {
        return undefined;
    }
    if (input.promotionGrantId === "") {
        throw new Error("reverse service did not allocate a pending promotion grant ID");
    }
    return buildPromotionGrantAuthority({
        promotionGrantId: input.promotionGrantId,
        subject: {
            subjectKind: "asset_version",
            assetId: input.stagedVersionOriginAuthority.assetId,
            versionId: input.stagedVersionOriginAuthority.versionId,
        },
        target: promotionTargetForDeployment(deployment),
        userActionEvidenceId: input.stagedVersionOriginAuthority.userActionEvidenceId,
        updatedAt: input.stagedVersionOriginAuthority.createdAt,
    });
}
