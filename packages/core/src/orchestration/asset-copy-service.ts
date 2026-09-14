/** Exact cross-location Asset copy without grant, Deployment, or runtime-write transfer. */

import { readAssetManifest } from "../catalog/asset-manifest";
import { acquireProjectAuthorityLocks } from "../catalog/project-authority";
import { publishInitialAssetVersion, readVersionAuthority, type VersionAuthorityClosureV1 } from "../catalog/version-authority";
import { resolveVersionSourcePromotionSafety } from "../catalog/version-origin-lineage";
import type {
    AssetKindTypeDataV2,
    AssetManifestV1,
    AssetVersionFileContentV2,
    AssetVersionManifestV2,
    CopyAssetVersionToLocationInputV1,
    CopyAssetVersionToLocationResultV1,
    CoreResult,
    UuidV4,
} from "../types";
import { completeResult } from "../foundation/core-result";
import {
    computeVersionCanonicalContentFingerprint,
    computeVersionFingerprint,
    computeVersionOriginAuthorityFingerprint,
} from "../foundation/fingerprint";
import { isSha256Digest } from "../foundation/validators";
import {
    acquireNewAssetLocks,
    cloneNativePayload,
    cloneRestorationPayload,
    failedOperationResult,
    identityAllocator,
    mutateAsset,
    requireActiveAsset,
    requireUserAction,
    requireVersion,
    requireVersionRef,
    validateAssetScope,
    withProjection,
    type AssetIdentityAllocator,
    type CoreAssetServiceConfiguration,
    type CoreAssetServiceTestHooks,
} from "./asset-service-shared";

export function copyAssetVersionToLocation(
    configuration: CoreAssetServiceConfiguration,
    hooks: CoreAssetServiceTestHooks,
    sourceInput: CopyAssetVersionToLocationInputV1,
): CoreResult<CopyAssetVersionToLocationResultV1> {
    let input: CopyAssetVersionToLocationInputV1;
    try {
        input = structuredClone(sourceInput) as CopyAssetVersionToLocationInputV1;
        requireVersionRef(input.source);
    } catch (error) {
        return failedOperationResult(error, "asset");
    }
    return mutateAsset(configuration, [input.source.assetId], "asset", () => {
        validateCopyInput(configuration, input);
        const preliminary = requireActiveAsset(configuration, input.source.assetId);
        const releaseProjects = acquireProjectsForCopy(configuration, preliminary, input);
        try {
            const ids = identityAllocator(configuration.newUuid);
            const assetId = ids.next("assetId");
            const versionId = ids.next("versionId");
            const releaseAssets = acquireNewAssetLocks(configuration.authorityLocksRoot, [input.source.assetId, assetId]);
            try {
                configuration.assertMutationScope({
                    assetIds: [input.source.assetId, assetId],
                    settingsAuthority: false,
                });
                const sourceAsset = requireActiveAsset(configuration, input.source.assetId);
                validateCopyDestinationIsDifferent(sourceAsset, input);
                validateAssetScope(configuration.projectsRoot, input.destination);
                if (readAssetManifest(configuration.assetsRoot, assetId) !== null) {
                    throw new Error("generated assetId already exists");
                }
                const sourceVersion = requireVersion(configuration, input.source);
                validateExactCopySource(sourceVersion, input);
                const createdAt = configuration.now();
                const version = buildCopiedVersion(configuration, {
                    assetId,
                    versionId,
                    source: sourceVersion,
                    input,
                    createdAt,
                    ids,
                });
                const asset: AssetManifestV1 = {
                    schemaVersion: 1,
                    assetId,
                    kind: sourceAsset.kind,
                    scope: input.destination.scope,
                    projectId: input.destination.projectId,
                    scopePath: input.destination.scopePath,
                    displayName: input.displayName,
                    displayDescription: input.displayDescription,
                    versionIds: [versionId],
                    deleted: false,
                    createdAt,
                    updatedAt: createdAt,
                };
                publishInitialAssetVersion({
                    assetsRoot: configuration.assetsRoot,
                    transactionId: ids.next("transactionId"),
                    asset,
                    version,
                    dialectRegistry: configuration.dialectRegistry,
                });
                return withCopyProjection(configuration, input, asset, version, hooks);
            } finally {
                releaseAssets();
            }
        } finally {
            releaseProjects();
        }
    });
}

function buildCopiedVersion(
    configuration: CoreAssetServiceConfiguration,
    context: {
        assetId: UuidV4;
        versionId: UuidV4;
        source: VersionAuthorityClosureV1;
        input: CopyAssetVersionToLocationInputV1;
        createdAt: number;
        ids: AssetIdentityAllocator;
    },
): VersionAuthorityClosureV1 {
    const files = context.source.files.map((file): AssetVersionFileContentV2 => {
        const descriptor = {
            ...structuredClone(file.file),
            fileId: context.ids.next("fileId"),
        };
        return file.contentKind === "text"
            ? { file: descriptor, contentKind: "text", text: file.text }
            : { file: descriptor, contentKind: "binary", bytes: new Uint8Array(file.bytes) };
    });
    const canonical = {
        kind: context.source.manifest.kind,
        typeData: structuredClone(context.source.manifest.typeData),
    } as AssetKindTypeDataV2;
    const versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(
        canonical,
        files.map((file) => file.file),
    );
    const portableDialectContracts = structuredClone(context.source.manifest.portableDialectContracts);
    const nativeRepresentations = structuredClone(context.source.manifest.nativeRepresentations);
    const dialectRestorationPayloads = structuredClone(context.source.manifest.dialectRestorationPayloads);
    const fingerprint = computeVersionFingerprint(
        versionCanonicalContentFingerprint,
        nativeRepresentations,
        dialectRestorationPayloads,
        portableDialectContracts,
    );
    const sourcePromotion = resolveVersionSourcePromotionSafety(context.source, (assetId, versionId) =>
        readVersionAuthority(configuration.assetsRoot, assetId, versionId, configuration.dialectRegistry),
    );
    if (sourcePromotion.status === "broken") throw new Error(sourcePromotion.message);
    const promotionRequirement = context.source.manifest.originAuthority.promotionRequirement;
    if (
        (promotionRequirement === "not_required" && sourcePromotion.promotionSafety !== null) ||
        (promotionRequirement === "requires_current_authorization" && sourcePromotion.promotionSafety === null)
    ) {
        throw new Error("source Version promotion requirement and origin lineage are inconsistent");
    }
    const originPreimage = {
        schemaVersion: 1 as const,
        assetId: context.assetId,
        versionId: context.versionId,
        originKind: "asset_copy" as const,
        sourceAssetId: context.source.manifest.assetId,
        sourceVersionId: context.source.manifest.versionId,
        sourceVersionFingerprint: context.source.manifest.fingerprint,
        sourceVersionOriginAuthorityFingerprint: context.source.manifest.originAuthority.authorityFingerprint,
        sourcePromotionSafety: sourcePromotion.promotionSafety ?? ("not_applicable" as const),
        userActionEvidenceId: context.input.userActionEvidenceId,
        promotionRequirement,
        createdAt: context.createdAt,
    };
    const manifest: AssetVersionManifestV2 = {
        schemaVersion: 2,
        versionId: context.versionId,
        assetId: context.assetId,
        revision: 1,
        fingerprint,
        status: context.source.manifest.status,
        diagnostics: structuredClone(context.source.manifest.diagnostics),
        ...canonical,
        files: files.map((file) => file.file),
        changeKind: "create",
        sourceVersionId: "",
        sourceDeploymentId: "",
        changeNote: "",
        createdAt: context.createdAt,
        versionCanonicalContentFingerprint,
        portableDialectContracts,
        nativeRepresentations,
        dialectRestorationPayloads,
        originAuthority: {
            ...originPreimage,
            authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
        },
    };
    return {
        manifest,
        files,
        nativePayloads: context.source.nativePayloads.map(cloneNativePayload),
        restorationPayloads: context.source.restorationPayloads.map(cloneRestorationPayload),
    };
}

function withCopyProjection(
    configuration: CoreAssetServiceConfiguration,
    input: CopyAssetVersionToLocationInputV1,
    asset: AssetManifestV1,
    version: VersionAuthorityClosureV1,
    hooks: CoreAssetServiceTestHooks,
): CoreResult<CopyAssetVersionToLocationResultV1> {
    const projected = withProjection(configuration, asset, hooks);
    const value: CopyAssetVersionToLocationResultV1 = {
        source: {
            assetId: input.source.assetId,
            versionId: input.source.versionId,
        },
        asset,
        version: version.manifest,
    };
    return projected.status === "complete"
        ? completeResult(value)
        : {
              status: "partial",
              value,
              diagnostics: projected.diagnostics,
          };
}

function validateCopyInput(configuration: CoreAssetServiceConfiguration, input: CopyAssetVersionToLocationInputV1): void {
    if (!isSha256Digest(input.source.versionFingerprint)) {
        throw new Error("source versionFingerprint must be a SHA-256 digest");
    }
    if (!isSha256Digest(input.source.originAuthorityFingerprint)) {
        throw new Error("source originAuthorityFingerprint must be a SHA-256 digest");
    }
    if (input.displayName.trim().length === 0) throw new Error("displayName must be non-blank");
    if (typeof input.displayDescription !== "string") throw new Error("displayDescription must be a string");
    requireUserAction(input.userActionEvidenceId);
    validateAssetScope(configuration.projectsRoot, input.destination);
}

function validateCopyDestinationIsDifferent(source: AssetManifestV1, input: CopyAssetVersionToLocationInputV1): void {
    if (
        source.scope === input.destination.scope &&
        source.projectId === input.destination.projectId &&
        source.scopePath === input.destination.scopePath
    ) {
        throw new Error("Asset copy destination must be another Global/Project location");
    }
}

function validateExactCopySource(source: VersionAuthorityClosureV1, input: CopyAssetVersionToLocationInputV1): void {
    if (
        source.manifest.fingerprint !== input.source.versionFingerprint ||
        source.manifest.originAuthority.authorityFingerprint !== input.source.originAuthorityFingerprint
    ) {
        throw new Error("source Version or origin authority changed before Asset copy");
    }
}

function acquireProjectsForCopy(
    configuration: CoreAssetServiceConfiguration,
    source: AssetManifestV1,
    input: CopyAssetVersionToLocationInputV1,
): () => void {
    const projectIds = [
        ...(source.scope === "project" ? [source.projectId as UuidV4] : []),
        ...(input.destination.scope === "project" ? [input.destination.projectId as UuidV4] : []),
    ];
    return projectIds.length === 0 ? () => undefined : acquireProjectAuthorityLocks(configuration.authorityLocksRoot, projectIds);
}
