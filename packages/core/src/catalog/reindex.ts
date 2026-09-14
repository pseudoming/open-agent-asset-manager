import { SafeFilesystemError, inventoryDirectoryNoFollow } from "@oaam/shared/filesystem";
import type { Database } from "better-sqlite3";
import { getDb } from "../persistence/db";
import { readAssetManifest } from "./asset-manifest";
import {
    EMPTY_VERSION_DIALECT_REGISTRY,
    readVersionAuthority,
    type VersionAuthorityClosureV1,
    type VersionDialectRegistryV1,
} from "./version-authority";
import {
    clearAssetsFts,
    clearCurrentAssetIndex,
    deleteAssetsFts,
    insertAssetsFts,
    upsertCurrentAssetIndex,
    deleteCurrentAssetIndex,
    type CurrentAssetIndexRow,
} from "../persistence/state-db";
import type { AssetManifestV1, AssetVersionManifestV2, OperationDiagnostic, ReindexReport } from "../types";
import { buildAssetSearchIndexProjection } from "./catalog-search";

/**
 * Rebuild the current_asset_index + assets_fts by scanning Asset manifests.
 *
 * Per CORE_DATA_MODEL_DRAFT §5.1, reindex:
 *  - reads Asset manifests → resolve versionIds[last] → read that Version manifest
 *  - rewrites current_asset_index + FTS for each asset
 *  - does NOT auto-adopt orphan Versions
 *  - does NOT fix/rewrite authoritative manifests
 *  - does NOT create AssetVersions
 *  - does NOT advance Deployment baselines
 *  - on a corrupt/missing/invalid Asset: returns diagnostics and skips that projection
 */

export interface ReindexOptions {
    /** If provided, only reindex these specific assetIds. If omitted, reindex all. */
    assetIds?: string[];
    /** Include deleted assets in the index. Default false. */
    includeDeleted?: boolean;
    dialectRegistry?: VersionDialectRegistryV1;
}

/**
 * Run a full reindex of current_asset_index + assets_fts.
 * Returns a ReindexReport with counts + diagnostics.
 *
 * @param assetsRoot  the `~/.oaam/assets` directory containing per-asset dirs
 * @param db          the state DB (uses getDb() if not provided)
 * @param options     reindex options
 */
export function reindexAssets(assetsRoot: string, db?: Database, options?: ReindexOptions): ReindexReport {
    const database = db ?? getDb();
    const includeDeleted = options?.includeDeleted ?? false;
    let scannedAssets = 0;
    let indexedAssets = 0;
    let skippedAssets = 0;
    const diagnostics: OperationDiagnostic[] = [];
    const diag = (severity: "info" | "warning" | "error", code: string, message: string, p: string): void => {
        diagnostics.push({
            severity,
            code,
            message,
            path: p,
            traceId: "",
            operation: "reindex",
            causeKind: "partial",
            retryable: false,
            suggestedActions: [],
            rawSummary: message,
        });
    };

    // Determine which asset IDs to scan.
    let assetDirs: string[];
    if (options?.assetIds && options.assetIds.length > 0) {
        assetDirs = options.assetIds;
    } else {
        // Scan the assets root for directories that look like UUID asset dirs.
        assetDirs = scanAssetDirs(assetsRoot);
    }

    // Full reindex: clear BOTH derived projections first (current_asset_index + FTS).
    // Partial reindex: clean per-asset stale projections before attempting to re-insert.
    const isFullReindex = !options?.assetIds || options.assetIds.length === 0;
    if (isFullReindex) {
        clearAssetsFts(database);
        clearCurrentAssetIndex(database);
    }

    for (const assetId of assetDirs) {
        scannedAssets++;
        // For partial reindex, clean this asset's stale projections FIRST.
        // Only re-insert if manifest + version are successfully read.
        // For full reindex, projections were already cleared above.
        if (!isFullReindex) {
            deleteCurrentAssetIndex(database, assetId);
            deleteAssetsFts(database, assetId);
        }
        try {
            const manifest = readAssetManifest(assetsRoot, assetId);
            if (manifest === null) {
                diag("warning", "reindex.asset_missing", `Asset manifest not found for ${assetId}; skipped`, assetId);
                skippedAssets++;
                continue;
            }

            // Skip deleted assets unless includeDeleted.
            if (manifest.deleted && !includeDeleted) {
                // Stale projections already cleaned above (partial) or by full clear.
                // For full reindex, deleted assets are simply not re-inserted.
                skippedAssets++;
                continue;
            }

            // Asset manifest validation guarantees a non-empty history.
            const currentVersionId = manifest.versionIds[manifest.versionIds.length - 1];
            let version: VersionAuthorityClosureV1;
            try {
                version = readVersionAuthority(
                    assetsRoot,
                    assetId,
                    currentVersionId,
                    options?.dialectRegistry ?? EMPTY_VERSION_DIALECT_REGISTRY,
                ) as VersionAuthorityClosureV1;
            } catch (error) {
                if (
                    error instanceof SafeFilesystemError &&
                    error.failureKind === "not_found" &&
                    error.targetPath.endsWith("/version.json")
                ) {
                    diag(
                        "warning",
                        "reindex.version_missing",
                        `Version ${currentVersionId} not found for asset ${assetId}; skipped`,
                        `${assetId}/versions/${currentVersionId}`,
                    );
                    skippedAssets++;
                    continue;
                }
                throw error;
            }
            // Build the index row from manifest + version.
            const row = buildIndexRow(manifest, version.manifest);
            upsertCurrentAssetIndex(database, row);

            // Build FTS entry.
            const search = buildAssetSearchIndexProjection(manifest, version);
            insertAssetsFts(database, manifest.assetId, search.displayName, search.displayDescription, search.searchableText);

            indexedAssets++;
        } catch (err) {
            // JS catch err is never null. String(err) produces the message for
            // Error instances and a readable form for non-Error throws.
            diag("error", "reindex.asset_error", `Error indexing asset ${assetId}: ${String(err)}`, assetId);
            skippedAssets++;
        }
    }

    return {
        scannedAssets,
        indexedAssets,
        skippedAssets,
        diagnostics,
    };
}

/** Scan the assets root for UUID-named directories. */
function scanAssetDirs(assetsRoot: string): string[] {
    try {
        return inventoryDirectoryNoFollow(assetsRoot)
            .entries.filter((entry) => entry.identity.entryKind === "directory" && entry.relativeName !== ".staging")
            .map((entry) => entry.relativeName);
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return [];
        throw error;
    }
}

/** Build a current_asset_index row from Asset + Version manifests. */
function buildIndexRow(manifest: AssetManifestV1, version: AssetVersionManifestV2): CurrentAssetIndexRow {
    return {
        assetId: manifest.assetId,
        kind: manifest.kind,
        scope: manifest.scope,
        projectId: manifest.projectId,
        scopePath: manifest.scopePath,
        displayName: manifest.displayName,
        displayDescription: manifest.displayDescription,
        currentVersionId: version.versionId,
        currentRevision: version.revision,
        currentFingerprint: version.fingerprint,
        currentVersionStatus: version.status,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        deleted: manifest.deleted ? 1 : 0,
    };
}
