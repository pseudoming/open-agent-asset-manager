import * as path from "node:path";
import * as crypto from "node:crypto";
import {
    SafeFilesystemError,
    confirmDurableDirectoryNoFollow,
    confirmDurableDirectoryTreeNoFollow,
    durableEnsureDirectory,
    durablePublishDirectory,
    durableRemoveDirectoryTree,
    inventoryDirectoryNoFollow,
} from "@oaam/shared/filesystem";
import { isSafeSegment } from "../foundation/validators";

/**
 * Asset-local staging + atomic commit (CORE_DATA_MODEL §8.4).
 *
 * Staging directory: `<assetsRoot>/.staging/<txn-uuid>/` — a sibling of the
 * asset UUID dirs, on the SAME filesystem as the assets root. Quote §8.4
 * line 672: "把 staging 留在 assets 所在文件系统，是为了避免 /tmp 与资产根
 * 目录跨文件系统时 rename 退化为非原子的复制再删除". So we MUST NOT use
 * os.tmpdir() / /tmp.
 *
 * Two commit protocols:
 *  - new-asset: build full asset tree (asset.json + versions/...) inside
 *    `.staging/<txn>/`, validate, then ONE atomic rename of the staging dir →
 *    `assets/<assetId>/`. That rename is the commit point.
 *  - new-version: build + validate the version dir inside `.staging/<txn>/`,
 *    then atomic rename of the version dir → `assets/<assetId>/versions/<vId>/`.
 *    The version dir may land BEFORE asset.json is replaced — at that moment it
 *    is an orphan (asset-manifest.detectOrphanVersions reports it). The single
 *    commit point for the version-becomes-current transition is the atomic
 *    replace of asset.json (handled by the Version authority's pointer writer).
 *
 * Orphan / residual handling (§8.4 lines 662-670):
 *  - residual staging dirs (crash / startup / stale) may be discarded outright
 *    ("失败、进程崩溃或启动时发现的残留 staging 均可直接丢弃")
 *  - orphan version dirs (renamed into versions/ but not in versionIds) must
 *    NOT be auto-adopted; only explicit recovery may handle them
 *  - MUST NOT use mtime/system time to decide whether residual content should
 *    be merged into history
 *
 * Concurrency (§8.4 lines 674-678): per-asset serial mutation required; lock
 * impl DEFERRED. This module does NOT acquire a lock — Step 7 deployment-
 * executor will own the writer serialization.
 */

const STAGING_DIR_NAME = ".staging";

/** Resolve the staging root: `<assetsRoot>/.staging`. */
export function resolveStagingRoot(assetsRoot: string): string {
    return path.join(assetsRoot, STAGING_DIR_NAME);
}

/** Resolve a per-txn staging dir: `<assetsRoot>/.staging/<txnId>`. txnId must
 * be a safe single segment (defends against path traversal). */
export function resolveStagingDir(assetsRoot: string, txnId: string): string {
    requireSafeSegment(txnId, "txnId");
    return path.join(resolveStagingRoot(assetsRoot), txnId);
}

/**
 * Create a fresh staging directory for a new transaction. Returns the absolute
 * staging dir path. Throws if it already exists (caller should use a new
 * txn UUID) or if txnId is not a safe single segment.
 *
 * The txnId is caller-provided (typically crypto.randomUUID()); staging-commit
 * does not generate it so callers can pre-bind it to journal entries.
 */
export function createStagingDir(assetsRoot: string, txnId: string): string {
    requireSafeSegment(txnId, "txnId");
    durableEnsureDirectory(path.dirname(assetsRoot), path.basename(assetsRoot));
    const stagingRoot = resolveStagingRoot(assetsRoot);
    durableEnsureDirectory(assetsRoot, STAGING_DIR_NAME);
    const stagingDir = resolveStagingDir(assetsRoot, txnId);
    const ensured = durableEnsureDirectory(stagingRoot, txnId);
    if (!ensured.created) {
        throw new Error(`staging dir already exists: ${stagingDir}`);
    }
    return stagingDir;
}

/** Create one fresh Version directory inside an already-created transaction. */
export function createStagingVersionDir(assetsRoot: string, txnId: string, versionId: string): string {
    requireSafeSegment(txnId, "txnId");
    requireSafeSegment(versionId, "versionId");
    const stagingDir = resolveStagingDir(assetsRoot, txnId);
    const versionsDir = path.join(stagingDir, "versions");
    durableEnsureDirectory(stagingDir, "versions");
    const ensured = durableEnsureDirectory(versionsDir, versionId);
    if (!ensured.created) {
        throw new Error(`staging version dir already exists: ${path.join(versionsDir, versionId)}`);
    }
    return path.join(versionsDir, versionId);
}

/**
 * Commit a NEW asset by atomically renaming the staging dir onto the asset's
 * final location. assetId must be a safe single segment.
 *
 * @param assetsRoot  the `~/.oaam/assets` root
 * @param txnId       staging txn id (safe segment)
 * @param assetId     the asset UUID (final dir name; safe segment)
 * @throws if the target asset dir already exists (commit refused; caller
 *         must clean up staging and report) or any id is unsafe
 */
export function commitNewAsset(assetsRoot: string, txnId: string, assetId: string): void {
    requireSafeSegment(txnId, "txnId");
    requireSafeSegment(assetId, "assetId");
    const stagingDir = resolveStagingDir(assetsRoot, txnId);
    const target = path.join(assetsRoot, assetId);
    if (directoryExistsNoFollow(target)) {
        throw new Error(`commit refused: target asset dir already exists: ${target}`);
    }
    requireDurableStagingTree(stagingDir, "staging dir");
    durablePublishDirectory(stagingDir, assetsRoot, assetId);
}

/**
 * Commit a NEW version onto an EXISTING asset by atomically renaming the
 * staging version dir onto the asset's versions/<versionId>/ location.
 * assetId and versionId must be safe single segments.
 *
 * @param assetsRoot  the `~/.oaam/assets` root
 * @param txnId       staging txn id (safe segment)
 * @param assetId     existing asset UUID (safe segment)
 * @param versionId   the new version UUID (safe segment)
 * @throws if the target version dir already exists (commit refused) or any id unsafe
 */
export function commitNewVersion(assetsRoot: string, txnId: string, assetId: string, versionId: string): void {
    requireSafeSegment(txnId, "txnId");
    requireSafeSegment(assetId, "assetId");
    requireSafeSegment(versionId, "versionId");
    const stagingVersionDir = path.join(resolveStagingDir(assetsRoot, txnId), "versions", versionId);
    const target = path.join(assetsRoot, assetId, "versions", versionId);
    if (directoryExistsNoFollow(target)) {
        throw new Error(`commit refused: target version dir already exists: ${target}`);
    }
    requireDurableStagingTree(stagingVersionDir, "staging version dir");
    // Ensure parent versions/ exists on the target asset.
    const versionsParent = path.join(assetsRoot, assetId, "versions");
    durableEnsureDirectory(path.join(assetsRoot, assetId), "versions");
    durablePublishDirectory(stagingVersionDir, versionsParent, versionId);
    // NOTE: the staging dir is intentionally NOT auto-cleaned here. Per §8.4,
    // residual staging dirs may be discarded outright at any time (they are
    // never authoritative). Callers / startup use discardStaging +
    // listResidualStaging for explicit cleanup.
}

/**
 * Discard a residual staging dir (crash / stale / aborted txn). Per §8.4 this
 * is safe to do outright — staging content is never authoritative. No-op if the
 * staging dir does not exist. Does NOT throw on FS errors during removal
 * (residual staging is best-effort cleanup; a stuck dir does not block OAAM
 * operation, only consumes disk).
 */
export function discardStaging(assetsRoot: string, txnId: string): void {
    const stagingDir = resolveStagingDir(assetsRoot, txnId);
    try {
        durableRemoveDirectoryTree(stagingDir);
    } catch {
        // best-effort; residual dir remains on disk, not authoritative
    }
}

/**
 * List residual staging txn ids (for startup cleanup / diagnostics). Returns
 * txn dir names found under `<assetsRoot>/.staging/`, or [] if the staging
 * root does not exist.
 */
export function listResidualStaging(assetsRoot: string): string[] {
    const stagingRoot = resolveStagingRoot(assetsRoot);
    try {
        return inventoryDirectoryNoFollow(stagingRoot)
            .entries.filter((entry) => entry.identity.entryKind === "directory")
            .map((entry) => entry.relativeName);
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return [];
        throw error;
    }
}

/**
 * Generate a fresh txn UUID (v4). Helper so callers don't need to import
 * crypto directly.
 */
export function newTxnId(): string {
    return crypto.randomUUID();
}

/** Flush every directory below root, then root itself, so a later rename publishes durable entries. */
export function makeDirectoryTreeDurable(root: string): void {
    confirmDurableDirectoryTreeNoFollow(root);
}

function directoryExistsNoFollow(directoryPath: string): boolean {
    try {
        confirmDurableDirectoryNoFollow(directoryPath);
        return true;
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return false;
        throw error;
    }
}

function requireDurableStagingTree(directoryPath: string, label: string): void {
    try {
        makeDirectoryTreeDurable(directoryPath);
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") {
            throw new Error(`${label} missing: ${directoryPath}`);
        }
        throw error;
    }
}

/** Throw if a path segment used in a path.join is not a safe single segment. */
function requireSafeSegment(segment: unknown, label: string): void {
    if (!isSafeSegment(segment)) {
        throw new Error(`${label} must be a safe single-segment identifier (got ${JSON.stringify(segment)})`);
    }
}
