/** Asset catalog lookup and physical authority-lock acquisition for Import. */

import { SafeFilesystemError, inventoryDirectoryNoFollow } from "@oaam/shared/filesystem";
import type { ExtractedAssetCandidate } from "../contracts/source-import";
import type { AssetManifestV1 } from "../contracts/core-service";
import type { PromotionGrantV1 } from "../contracts/persistence";
import type { UuidV4 } from "../contracts/primitives";
import { readAssetManifest } from "../catalog/asset-manifest";
import { readPromotionGrantAuthority } from "../catalog/promotion-grant-store";
import { readVersionAuthority, type VersionAuthorityClosureV1 } from "../catalog/version-authority";
import { isUuidV4 } from "../foundation/validators";
import { tryAcquireAuthorityLocks } from "../foundation/authority-locks";
import type { ImportServiceConfiguration, AssetAuthorityRecord } from "./import-service-shared";
import { ImportServiceFailure, compareUtf8Bytes } from "./import-service-shared";

export function nextRevision(configuration: ImportServiceConfiguration, assetId: UuidV4): number {
    const asset = requireActiveAsset(configuration.assetsRoot, assetId);
    let highest = 0;
    for (const versionId of asset.versionIds) {
        const closure = readVersionAuthority(configuration.assetsRoot, assetId, versionId, configuration.dialectRegistry);
        highest = Math.max(highest, (closure as VersionAuthorityClosureV1).manifest.revision);
    }
    return highest + 1;
}

export function readAssetCatalog(configuration: ImportServiceConfiguration): AssetAuthorityRecord[] {
    let entries: ReturnType<typeof inventoryDirectoryNoFollow>["entries"];
    try {
        entries = inventoryDirectoryNoFollow(configuration.assetsRoot).entries;
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return [];
        throw error;
    }
    const catalog: AssetAuthorityRecord[] = [];
    for (const entry of entries) {
        if (entry.identity.entryKind !== "directory" || !isUuidV4(entry.relativeName)) continue;
        const asset = readAssetManifest(configuration.assetsRoot, entry.relativeName);
        if (asset === null) throw new ImportServiceFailure("import.asset_missing", "Asset directory has no manifest");
        const versions = asset.versionIds.map((versionId) => {
            const closure = readVersionAuthority(
                configuration.assetsRoot,
                asset.assetId,
                versionId,
                configuration.dialectRegistry,
            );
            return closure as VersionAuthorityClosureV1;
        });
        catalog.push({ asset, versions });
    }
    return catalog.sort((left, right) => compareUtf8Bytes(left.asset.assetId, right.asset.assetId));
}

export function requireVersionOwner(configuration: ImportServiceConfiguration, versionId: UuidV4): AssetAuthorityRecord {
    const matches = readAssetCatalog(configuration).filter(({ asset }) => asset.versionIds.includes(versionId));
    if (matches.length !== 1) {
        throw new ImportServiceFailure(
            "import.binding_target_missing",
            "callable binding target must belong to exactly one Asset",
        );
    }
    return matches[0] as AssetAuthorityRecord;
}

export function requireActiveAsset(assetsRoot: string, assetId: UuidV4): AssetManifestV1 {
    const asset = readAssetManifest(assetsRoot, assetId);
    if (asset === null || asset.deleted) {
        throw new ImportServiceFailure("import.asset_inactive", "active Asset not found", "not_found");
    }
    return asset;
}

export function resolveCandidateProjectId(
    configuration: ImportServiceConfiguration,
    candidate: ExtractedAssetCandidate,
): UuidV4 | "" {
    if (candidate.scope === "global") return "";
    const projectId = configuration.resolveProjectId(candidate.projectRootPath);
    if (projectId === null || !isUuidV4(projectId)) {
        throw new ImportServiceFailure(
            "import.project_unregistered",
            "project-scoped candidate does not map to a registered Project",
            "not_found",
        );
    }
    return projectId;
}

export function locatePromotionGrant(configuration: ImportServiceConfiguration, promotionGrantId: UuidV4): PromotionGrantV1 {
    const matches = readAssetCatalog(configuration).flatMap(({ asset }) => {
        const grant = readPromotionGrantAuthority(configuration.assetsRoot, asset.assetId, promotionGrantId);
        return grant === null ? [] : [grant];
    });
    if (matches.length !== 1) {
        throw new ImportServiceFailure("promotion.grant_cardinality", "promotionGrantId must resolve exactly once", "not_found");
    }
    return matches[0] as PromotionGrantV1;
}

export function acquireAssetAuthorityLocks(authorityLocksRoot: string, sortedAssetIds: readonly UuidV4[]): () => void {
    for (const assetId of sortedAssetIds) {
        if (!isUuidV4(assetId)) {
            throw new ImportServiceFailure("import.asset_id_invalid", "Asset lock identity is not UUID v4");
        }
    }
    const release = tryAcquireAuthorityLocks(authorityLocksRoot, "assets", sortedAssetIds);
    if (release === null) {
        throw new ImportServiceFailure("import.asset_locked", "one or more Asset authorities are locked", "unavailable", true);
    }
    return release;
}

export function acquireSettingsAuthorityLock(authorityLocksRoot: string): () => void {
    const release = tryAcquireAuthorityLocks(authorityLocksRoot, "settings", ["settings"]);
    if (release === null) {
        throw new ImportServiceFailure("settings.authority_locked", "settings authority is locked", "unavailable", true);
    }
    return release;
}

export function acquireImportCatalogLock(authorityLocksRoot: string): () => void {
    const release = tryAcquireAuthorityLocks(authorityLocksRoot, "imports", ["import-catalog"]);
    if (release === null) {
        throw new ImportServiceFailure(
            "import.catalog_locked",
            "import catalog reconciliation is already in progress",
            "unavailable",
            true,
        );
    }
    return release;
}
