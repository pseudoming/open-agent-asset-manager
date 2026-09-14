/** Runtime-neutral mechanics shared by Asset catalog operations. */

import { SafeFilesystemError, inventoryDirectoryNoFollow, type PhysicalPathIdentity } from "@oaam/shared/filesystem";
import type { Database } from "better-sqlite3";
import { acquireAssetCatalogLock, readAssetManifest } from "../catalog/asset-manifest";
import { readProjectManifest } from "../catalog/project-authority";
import { acquireProjectAuthorityLocks } from "../catalog/project-authority";
import { reindexAssets as rebuildAssetIndex } from "../catalog/reindex";
import {
    readVersionAuthority,
    replaceExistingAssetManifestAuthority,
    type VersionAuthorityClosureV1,
    type VersionDialectRegistryV1,
} from "../catalog/version-authority";
import type { AssetManifestV1, CoreResult, CreateAssetInput, OperationDiagnostic, UuidV4, VersionRef } from "../types";
import { tryAcquireAuthorityLocks } from "../foundation/authority-locks";
import { completeResult } from "../foundation/core-result";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isUuidV4 } from "../foundation/validators";

export interface CoreAssetServiceConfiguration {
    assetsRoot: string;
    projectsRoot: string;
    authorityLocksRoot: string;
    db: Database;
    dialectRegistry: VersionDialectRegistryV1;
    assertMutationScope(scope: { assetIds: UuidV4[]; settingsAuthority: boolean }): void;
    onProjectionChanged?(): void;
    now(): number;
    newUuid(): UuidV4;
}

export interface CoreAssetServiceTestHooks {
    afterExistingAssetLock?(): void;
    afterPurgeCatalogLock?(): void;
    beforeIndexProjection?(asset: AssetManifestV1): void;
    beforePurgeVersionRead?(assetId: UuidV4, versionId: UuidV4): void;
    beforePurgeRecycle?(): void;
    beforePurgeProjection?(): void;
    assertDirectoryTreeRecycleSupported?(directoryPath: string): void;
    confirmDirectoryTreeNoFollow?(directoryPath: string, maximumEntries: number): PhysicalPathIdentity;
    recycleDirectoryTreeIfIdentity?(
        directoryPath: string,
        expectedIdentity: PhysicalPathIdentity,
        maximumEntries: number,
    ): boolean;
}

export interface AssetIdentityAllocator {
    next(label: string): UuidV4;
}

export function mutateAsset<T>(
    configuration: CoreAssetServiceConfiguration,
    assetIds: UuidV4[],
    operation: OperationDiagnostic["operation"],
    mutation: () => CoreResult<T>,
): CoreResult<T> {
    try {
        configuration.assertMutationScope({ assetIds, settingsAuthority: false });
        return mutation();
    } catch (error) {
        return failedOperationResult(error, operation);
    }
}

export function withProjection(
    configuration: CoreAssetServiceConfiguration,
    asset: AssetManifestV1,
    hooks: CoreAssetServiceTestHooks,
): CoreResult<AssetManifestV1> {
    try {
        hooks.beforeIndexProjection?.(asset);
        const report = rebuildAssetIndex(configuration.assetsRoot, configuration.db, {
            assetIds: [asset.assetId],
            includeDeleted: true,
            dialectRegistry: configuration.dialectRegistry,
        });
        return report.diagnostics.length === 0
            ? completeResult(asset)
            : { status: "partial", value: asset, diagnostics: report.diagnostics };
    } catch (error) {
        const message = `Asset authority committed but index projection failed: ${String(error)}`;
        return {
            status: "partial",
            value: asset,
            diagnostics: [
                {
                    severity: "error",
                    code: "asset.index_projection_failed",
                    message,
                    path: asset.assetId,
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

export function validateAssetScope(
    projectsRoot: string,
    input: Pick<CreateAssetInput, "scope" | "projectId" | "scopePath">,
): void {
    if (input.scope === "global") {
        if (input.projectId !== "" || input.scopePath !== "") {
            throw new Error("global Asset requires empty projectId and scopePath");
        }
        return;
    }
    requireUuid(input.projectId, "projectId");
    const project = readProjectManifest(projectsRoot, input.projectId);
    if (project === null || project.deleted) throw new Error("active Project not found");
}

export function acquireProjectForScope(
    configuration: CoreAssetServiceConfiguration,
    scope: AssetManifestV1["scope"],
    projectId: string,
): () => void {
    if (scope === "global") return () => undefined;
    requireUuid(projectId, "projectId");
    return acquireProjectAuthorityLocks(configuration.authorityLocksRoot, [projectId]);
}

export function requireActiveAsset(configuration: CoreAssetServiceConfiguration, assetId: UuidV4): AssetManifestV1 {
    const asset = readAssetManifest(configuration.assetsRoot, assetId);
    if (asset === null || asset.deleted) throw new Error("active Asset not found");
    if (asset.scope === "project") {
        const project = readProjectManifest(configuration.projectsRoot, asset.projectId as UuidV4);
        if (project === null || project.deleted) throw new Error("Asset Project is not active");
    }
    return asset;
}

export function mutateExistingManifest(
    configuration: CoreAssetServiceConfiguration,
    hooks: CoreAssetServiceTestHooks,
    assetId: UuidV4,
    requireActiveProject: boolean,
    project: (asset: AssetManifestV1) => AssetManifestV1,
): CoreResult<AssetManifestV1> {
    return mutateAsset(configuration, [assetId], "asset", () => {
        requireUuid(assetId, "assetId");
        const preliminary = readAssetManifest(configuration.assetsRoot, assetId);
        if (preliminary === null) throw new Error("Asset not found");
        const releaseProject = acquireProjectForScope(configuration, preliminary.scope, preliminary.projectId);
        try {
            const release = acquireAssetLocks(configuration.authorityLocksRoot, [assetId]);
            try {
                configuration.assertMutationScope({
                    assetIds: [assetId],
                    settingsAuthority: false,
                });
                hooks.afterExistingAssetLock?.();
                const current = readAssetManifest(configuration.assetsRoot, assetId);
                if (current === null) throw new Error("Asset not found");
                if (requireActiveProject && current.scope === "project") {
                    const owner = readProjectManifest(configuration.projectsRoot, current.projectId as UuidV4);
                    if (owner === null || owner.deleted) throw new Error("Asset Project is not active");
                }
                const next = project(current);
                replaceExistingAssetManifestAuthority({
                    assetsRoot: configuration.assetsRoot,
                    expected: current,
                    next,
                });
                return withProjection(configuration, next, hooks);
            } finally {
                release();
            }
        } finally {
            releaseProject();
        }
    });
}

export function requireVersion(configuration: CoreAssetServiceConfiguration, ref: VersionRef): VersionAuthorityClosureV1 {
    const version = readVersionAuthority(configuration.assetsRoot, ref.assetId, ref.versionId, configuration.dialectRegistry);
    if (version === null) throw new Error("Version not found in Asset history");
    return version;
}

export function acquireAssetLocks(authorityLocksRoot: string, assetIds: readonly UuidV4[]): () => void {
    const ordered = [...new Set(assetIds)].sort(compareUtf8Bytes);
    for (const assetId of ordered) requireUuid(assetId, "assetId");
    const release = tryAcquireAuthorityLocks(authorityLocksRoot, "assets", ordered);
    if (release === null) throw new Error("Asset authority is locked");
    return release;
}

/** Acquire the catalog-creation sentinel before the exact new/existing Asset owners. */
export function acquireNewAssetLocks(authorityLocksRoot: string, assetIds: readonly UuidV4[]): () => void {
    const releaseCatalog = acquireAssetCatalogLock(authorityLocksRoot);
    try {
        const releaseAssets = acquireAssetLocks(authorityLocksRoot, assetIds);
        return () => {
            try {
                releaseAssets();
            } finally {
                releaseCatalog();
            }
        };
    } catch (error) {
        releaseCatalog();
        throw error;
    }
}

export function identityAllocator(nextUuid: () => UuidV4): AssetIdentityAllocator {
    const used = new Set<UuidV4>();
    return {
        next(label: string): UuidV4 {
            const value = nextUuid();
            if (!isUuidV4(value) || used.has(value)) {
                throw new Error(`${label} generator returned an invalid or duplicate UUID v4`);
            }
            used.add(value);
            return value;
        },
    };
}

export function requireVersionRef(ref: VersionRef): void {
    requireUuid(ref.assetId, "assetId");
    requireUuid(ref.versionId, "versionId");
}

export function requireUuid(value: string, label: string): asserts value is UuidV4 {
    if (!isUuidV4(value)) throw new Error(`${label} must be UUID v4`);
}

export function requireUserAction(value: string): void {
    if (value.trim().length === 0 || value.includes("\0")) {
        throw new Error("userActionEvidenceId must be non-empty and contain no NUL");
    }
}

export function cloneNativePayload(payload: VersionAuthorityClosureV1["nativePayloads"][number]) {
    return {
        dialectId: payload.dialectId,
        files: payload.files.map((file) => ({
            relativePath: file.relativePath,
            bytes: new Uint8Array(file.bytes),
        })),
    };
}

export function cloneRestorationPayload(payload: VersionAuthorityClosureV1["restorationPayloads"][number]) {
    return { dialectId: payload.dialectId, bytes: new Uint8Array(payload.bytes) };
}

export function inventoryAssetIds(assetsRoot: string): UuidV4[] {
    try {
        return inventoryDirectoryNoFollow(assetsRoot)
            .entries.filter((entry) => entry.identity.entryKind === "directory" && isUuidV4(entry.relativeName))
            .map((entry) => entry.relativeName as UuidV4)
            .sort(compareUtf8Bytes);
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return [];
        throw error;
    }
}

export function failedOperationResult<T>(error: unknown, operation: OperationDiagnostic["operation"]): CoreResult<T> {
    const message = error instanceof Error ? error.message : String(error);
    return {
        status: "failed",
        value: undefined as T,
        diagnostics: [
            {
                severity: "error",
                code: `${operation}.operation_failed`,
                message,
                path: "",
                traceId: "",
                operation,
                causeKind: "invalid_schema",
                retryable: false,
                suggestedActions: [],
                rawSummary: message,
            },
        ],
    };
}
