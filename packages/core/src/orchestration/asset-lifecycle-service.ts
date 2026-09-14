/** Reversible Asset lifecycle and dependency-closed owner-tree purge. */

import {
    assertDirectoryTreeRecycleSupported,
    confirmDurableDirectoryTreeNoFollow,
    durableRecycleDirectoryTreeIfIdentity,
    type PhysicalPathIdentity,
} from "@oaam/shared/filesystem";
import { acquireAssetCatalogLock, readAssetManifest, resolveAssetRoot } from "../catalog/asset-manifest";
import { listRetainedPromotionGrantAuthorities } from "../catalog/promotion-grant-store";
import { readVersionAuthority } from "../catalog/version-authority";
import type { AssetKindTypeDataV2 } from "../contracts/specs";
import type {
    AssetApiWrite,
    AssetManifestV1,
    AssetPurgePreparationV1,
    AssetPurgeResultV1,
    CommitAssetPurgeInputV1,
    CoreResult,
    Sha256Digest,
    UuidV4,
} from "../types";
import { completeResult } from "../foundation/core-result";
import { computeAssetManifestFileFingerprint, fingerprintDomain, stableStringify } from "../foundation/fingerprint";
import { hasExactKeys, isNonNegativeInteger, isSha256Digest, isStrictObject, isUuidV4 } from "../foundation/validators";
import { deleteAssetsFts, deleteCurrentAssetIndex, listDeploymentAssets, listDeployments } from "../persistence/state-db";
import { getAssetSpecHandler } from "../specs/registry";
import {
    acquireAssetLocks,
    failedOperationResult,
    inventoryAssetIds,
    mutateAsset,
    mutateExistingManifest,
    requireUserAction,
    requireUuid,
    type CoreAssetServiceConfiguration,
    type CoreAssetServiceTestHooks,
} from "./asset-service-shared";

const MAXIMUM_PURGE_TREE_ENTRIES = 100_000;
const DIRECTORY_IDENTITY_DOMAIN = "oaam.asset.purge-directory-identity.v1";
const PURGE_PREPARATION_FIELDS = [
    "schemaVersion",
    "action",
    "assetId",
    "assetManifestFingerprint",
    "assetDirectoryIdentityFingerprint",
    "kind",
    "scope",
    "projectId",
    "scopePath",
    "displayName",
    "versionCount",
    "promotionGrantCount",
] as const;

type AssetLifecycleOperations = Pick<AssetApiWrite, "softDeleteAsset" | "restoreAsset" | "inspectAssetPurge" | "purgeAsset">;

export function createAssetLifecycleOperations(
    configuration: CoreAssetServiceConfiguration,
    hooks: CoreAssetServiceTestHooks,
): AssetLifecycleOperations {
    return Object.freeze({
        softDeleteAsset(assetId) {
            return mutateExistingManifest(configuration, hooks, assetId, false, (asset) =>
                asset.deleted
                    ? asset
                    : {
                          ...asset,
                          deleted: true,
                          updatedAt: Math.max(asset.updatedAt, configuration.now()),
                      },
            );
        },
        restoreAsset(assetId) {
            return mutateExistingManifest(configuration, hooks, assetId, true, (asset) => {
                if (!asset.deleted) throw new Error("active Asset cannot be restored");
                return {
                    ...asset,
                    deleted: false,
                    updatedAt: Math.max(asset.updatedAt, configuration.now()),
                };
            });
        },
        inspectAssetPurge(assetId) {
            return inspectAssetPurge(configuration, hooks, assetId);
        },
        purgeAsset(input) {
            return purgeAsset(configuration, hooks, input);
        },
    });
}

function inspectAssetPurge(
    configuration: CoreAssetServiceConfiguration,
    hooks: CoreAssetServiceTestHooks,
    assetId: UuidV4,
): CoreResult<AssetPurgePreparationV1> {
    return mutateAsset(configuration, [assetId], "asset", () => {
        requireUuid(assetId, "assetId");
        const release = acquireAssetLocks(configuration.authorityLocksRoot, [assetId]);
        try {
            configuration.assertMutationScope({ assetIds: [assetId], settingsAuthority: false });
            const asset = requireDeletedAsset(configuration, assetId);
            const facts = inspectPurgeClosure(configuration, hooks, asset);
            const assetRoot = resolveAssetRoot(configuration.assetsRoot, assetId);
            (hooks.assertDirectoryTreeRecycleSupported ?? assertDirectoryTreeRecycleSupported)(assetRoot);
            const identity = (hooks.confirmDirectoryTreeNoFollow ?? confirmDurableDirectoryTreeNoFollow)(
                assetRoot,
                MAXIMUM_PURGE_TREE_ENTRIES,
            );
            return completeResult(projectPreparation(asset, facts.promotionGrantCount, identity));
        } finally {
            release();
        }
    });
}

function purgeAsset(
    configuration: CoreAssetServiceConfiguration,
    hooks: CoreAssetServiceTestHooks,
    sourceInput: CommitAssetPurgeInputV1,
): CoreResult<AssetPurgeResultV1> {
    let input: CommitAssetPurgeInputV1;
    try {
        input = structuredClone(sourceInput) as CommitAssetPurgeInputV1;
        requireCommitInput(input);
    } catch (error) {
        return failedOperationResult(error, "asset");
    }
    return mutateAsset(configuration, [input.preparation.assetId], "asset", () => {
        const releaseCatalog = acquireAssetCatalogLock(configuration.authorityLocksRoot);
        try {
            hooks.afterPurgeCatalogLock?.();
            const lockedAssetIds = [...new Set([...inventoryAssetIds(configuration.assetsRoot), input.preparation.assetId])];
            const release = acquireAssetLocks(configuration.authorityLocksRoot, lockedAssetIds);
            try {
                configuration.assertMutationScope({
                    assetIds: [input.preparation.assetId],
                    settingsAuthority: false,
                });
                const asset = requireDeletedAsset(configuration, input.preparation.assetId);
                const facts = inspectPurgeClosure(configuration, hooks, asset);
                const assetRoot = resolveAssetRoot(configuration.assetsRoot, asset.assetId);
                (hooks.assertDirectoryTreeRecycleSupported ?? assertDirectoryTreeRecycleSupported)(assetRoot);
                const identity = (hooks.confirmDirectoryTreeNoFollow ?? confirmDurableDirectoryTreeNoFollow)(
                    assetRoot,
                    MAXIMUM_PURGE_TREE_ENTRIES,
                );
                const expected = projectPreparation(asset, facts.promotionGrantCount, identity);
                if (stableStringify(expected) !== stableStringify(input.preparation)) {
                    throw new Error("Asset purge review no longer matches current authority");
                }
                hooks.beforePurgeRecycle?.();
                const recycled = (hooks.recycleDirectoryTreeIfIdentity ?? durableRecycleDirectoryTreeIfIdentity)(
                    assetRoot,
                    identity,
                    MAXIMUM_PURGE_TREE_ENTRIES,
                );
                if (!recycled) throw new Error("Asset owner tree disappeared before Recycle Bin handoff");
                return purgeProjection(configuration, hooks, asset.assetId);
            } finally {
                release();
            }
        } finally {
            releaseCatalog();
        }
    });
}

function requireDeletedAsset(configuration: CoreAssetServiceConfiguration, assetId: UuidV4): AssetManifestV1 {
    const asset = readAssetManifest(configuration.assetsRoot, assetId);
    if (asset === null) throw new Error("Asset not found");
    if (!asset.deleted) throw new Error("Asset must be soft-deleted before purge");
    return asset;
}

function inspectPurgeClosure(
    configuration: CoreAssetServiceConfiguration,
    hooks: CoreAssetServiceTestHooks,
    asset: AssetManifestV1,
): { promotionGrantCount: number } {
    for (const deployment of listDeployments(configuration.db, true)) {
        if (listDeploymentAssets(configuration.db, deployment.deploymentId, true).some((row) => row.assetId === asset.assetId)) {
            throw new Error(`retained Deployment relation blocks Asset purge: ${deployment.deploymentId}`);
        }
    }
    const targetVersions = new Set(asset.versionIds);
    for (const candidateAssetId of inventoryAssetIds(configuration.assetsRoot)) {
        const candidate = readAssetManifest(configuration.assetsRoot, candidateAssetId);
        if (candidate === null) throw new Error(`Asset disappeared during purge dependency inventory: ${candidateAssetId}`);
        if (candidate.assetId === asset.assetId) continue;
        for (const versionId of candidate.versionIds) {
            hooks.beforePurgeVersionRead?.(candidate.assetId, versionId as UuidV4);
            const closure = readVersionAuthority(
                configuration.assetsRoot,
                candidate.assetId,
                versionId,
                configuration.dialectRegistry,
            );
            if (closure === null) throw new Error(`retained Version disappeared during purge dependency inventory: ${versionId}`);
            for (const dependencyId of collectHardDependencyIds(closure)) {
                if (targetVersions.has(dependencyId)) {
                    throw new Error(`retained Asset Version ${versionId} depends on purged Version ${dependencyId}`);
                }
            }
        }
    }
    const grants = listRetainedPromotionGrantAuthorities(configuration.assetsRoot, asset.assetId);
    for (const versionId of asset.versionIds) {
        hooks.beforePurgeVersionRead?.(asset.assetId, versionId as UuidV4);
        if (readVersionAuthority(configuration.assetsRoot, asset.assetId, versionId, configuration.dialectRegistry) === null) {
            throw new Error(`Asset Version is missing during purge inventory: ${versionId}`);
        }
    }
    return { promotionGrantCount: grants.length };
}

function collectHardDependencyIds(closure: NonNullable<ReturnType<typeof readVersionAuthority>>): UuidV4[] {
    const canonical = {
        kind: closure.manifest.kind,
        typeData: closure.manifest.typeData,
    } as AssetKindTypeDataV2;
    const dependencies = getAssetSpecHandler(closure.manifest.kind)
        .collectDependencies(canonical, closure.files)
        .map((item) => item.targetAssetVersionId);
    for (const file of closure.files) {
        for (const reference of file.file.references) {
            if (reference.resolution === "resolved_asset_version") {
                dependencies.push(reference.targetAssetVersionId);
            }
        }
    }
    return [...new Set(dependencies)];
}

function projectPreparation(
    asset: AssetManifestV1,
    promotionGrantCount: number,
    identity: PhysicalPathIdentity,
): AssetPurgePreparationV1 {
    if (identity.entryKind !== "directory") throw new Error("Asset owner path is not a directory");
    return {
        schemaVersion: 1,
        action: "purge",
        assetId: asset.assetId,
        assetManifestFingerprint: computeAssetManifestFileFingerprint(asset),
        assetDirectoryIdentityFingerprint: directoryIdentityFingerprint(asset.assetId, identity),
        kind: asset.kind,
        scope: asset.scope,
        projectId: asset.projectId,
        scopePath: asset.scopePath,
        displayName: asset.displayName,
        versionCount: asset.versionIds.length,
        promotionGrantCount,
    };
}

function directoryIdentityFingerprint(assetId: UuidV4, identity: PhysicalPathIdentity): Sha256Digest {
    return fingerprintDomain(DIRECTORY_IDENTITY_DOMAIN, {
        assetId,
        deviceId: identity.deviceId,
        fileId: identity.fileId,
        entryKind: identity.entryKind,
    });
}

function requireCommitInput(input: CommitAssetPurgeInputV1): void {
    requireUserAction(input.userActionEvidenceId);
    const value: unknown = input.preparation;
    if (!isStrictObject(value) || !hasExactKeys(value, PURGE_PREPARATION_FIELDS)) {
        throw new Error("Asset purge preparation must use the exact v1 shape");
    }
    if (
        value.schemaVersion !== 1 ||
        value.action !== "purge" ||
        !isUuidV4(value.assetId) ||
        !isSha256Digest(value.assetManifestFingerprint) ||
        !isSha256Digest(value.assetDirectoryIdentityFingerprint) ||
        !["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"].includes(String(value.kind)) ||
        !["global", "project"].includes(String(value.scope)) ||
        typeof value.projectId !== "string" ||
        typeof value.scopePath !== "string" ||
        typeof value.displayName !== "string" ||
        !isNonNegativeInteger(value.versionCount) ||
        !isNonNegativeInteger(value.promotionGrantCount)
    ) {
        throw new Error("Asset purge preparation is malformed");
    }
}

function purgeProjection(
    configuration: CoreAssetServiceConfiguration,
    hooks: CoreAssetServiceTestHooks,
    assetId: UuidV4,
): CoreResult<AssetPurgeResultV1> {
    const value: AssetPurgeResultV1 = { assetId, recycled: true };
    try {
        hooks.beforePurgeProjection?.();
        configuration.db.transaction(() => {
            deleteAssetsFts(configuration.db, assetId);
            deleteCurrentAssetIndex(configuration.db, assetId);
        })();
        return completeResult(value);
    } catch (error) {
        const message = `Asset owner tree was recycled but index projection cleanup failed: ${String(error)}`;
        return {
            status: "partial",
            value,
            diagnostics: [
                {
                    severity: "error",
                    code: "asset.purge_projection_failed",
                    message,
                    path: assetId,
                    traceId: "",
                    operation: "reindex",
                    causeKind: "partial",
                    retryable: true,
                    suggestedActions: ["retry"],
                    rawSummary: message,
                },
            ],
        };
    } finally {
        configuration.onProjectionChanged?.();
    }
}
