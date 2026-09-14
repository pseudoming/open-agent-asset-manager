import * as path from "node:path";
import {
    SafeFilesystemError,
    durableEnsureDirectory,
    durableReplaceFile,
    inventoryDirectoryNoFollow,
    readRegularFileNoFollow,
} from "@oaam/shared/filesystem";
import type { AssetManifestV1, AssetKind, Diagnostic } from "../types";
import { tryAcquireAuthorityLocks } from "../foundation/authority-locks";
import { isNonNegativeInteger, isPosixRelativePath, isSafeSegment, isStrictObject, isUuidV4 } from "../foundation/validators";

/**
 * Asset manifest v1 reader / writer / validator (STRICT).
 *
 * Strict contract (ASSET_SPECS §2.3 + §3): JSON is strict — declared fields
 * only, no extra keys, no null. validateAssetManifest NEVER throws on malformed
 * input (manifest files are the file authority and may be corrupted on disk).
 *
 * File location: `~/.oaam/assets/<assetId>/asset.json`.
 */

const ASSET_MANIFEST_FIELDS = [
    "schemaVersion",
    "assetId",
    "kind",
    "scope",
    "projectId",
    "scopePath",
    "displayName",
    "displayDescription",
    "versionIds",
    "deleted",
    "createdAt",
    "updatedAt",
] as const;

const VALID_KINDS: readonly AssetKind[] = ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"];

export interface AssetValidationResult {
    ok: boolean;
    diagnostics: Diagnostic[];
}

/**
 * Validate an Asset manifest. NEVER throws — returns diagnostics. `ok` is true
 * iff no error-severity diagnostics. Accepts `unknown` so callers can pass raw
 * parsed JSON.
 */
export function validateAssetManifest(manifest: unknown): AssetValidationResult {
    const diags: Diagnostic[] = [];
    const err = (code: string, message: string) => diags.push({ severity: "error", code, message, path: "", traceId: "" });

    if (!isStrictObject(manifest)) {
        err("asset.shape", "manifest must be a non-null object");
        return { ok: false, diagnostics: diags };
    }

    // Strict-key check (ASSET_SPECS §2.3): no extra keys.
    const allowedTop = new Set<string>(ASSET_MANIFEST_FIELDS);
    for (const k of Object.keys(manifest)) {
        if (!allowedTop.has(k)) {
            err("asset.strict", `manifest has undeclared field: ${k}`);
        }
    }

    const m = manifest as Record<string, unknown>;

    if (m.schemaVersion !== 1) {
        err("asset.schemaVersion", `schemaVersion must be 1, got ${JSON.stringify(m.schemaVersion)}`);
    }
    if (!isUuidV4(m.assetId)) {
        err("asset.assetId", "assetId must be a UUID v4");
    }
    if (!VALID_KINDS.includes(m.kind as AssetKind)) {
        err("asset.kind", `kind must be one of ${VALID_KINDS.join("|")}`);
    }
    if (m.scope !== "global" && m.scope !== "project") {
        err("asset.scope", "scope must be global|project");
    } else if (m.scope === "global") {
        if (m.projectId !== "") {
            err("asset.projectId", "global Asset must have empty projectId");
        }
        if (m.scopePath !== "") {
            err("asset.scopePath", "global Asset must have empty scopePath");
        }
    } else {
        // project scope
        if (!isUuidV4(m.projectId)) {
            err("asset.projectId", "project Asset must have a UUID v4 projectId");
        }
    }
    if (typeof m.scopePath !== "string") {
        err("asset.scopePath", "scopePath must be a string");
    } else if (m.scopePath.length > 0) {
        // Reuse the unified POSIX-relative validator (rejects absolute, `..`,
        // `.`, backslash, trailing `/`, AND embedded NUL — audit fix).
        if (!isPosixRelativePath(m.scopePath)) {
            err("asset.scopePath", "scopePath must be POSIX-relative (no absolute/..//./backslash/trailing-slash/NUL)");
        }
    }
    if (typeof m.displayName !== "string" || m.displayName.trim().length === 0) {
        err("asset.displayName", "displayName must be non-empty and non-blank");
    }
    if (typeof m.displayDescription !== "string") {
        err("asset.displayDescription", "displayDescription must be a string (may be empty)");
    }
    if (!Array.isArray(m.versionIds) || m.versionIds.length === 0) {
        err("asset.versionIds", "versionIds must be a non-empty array");
    } else {
        const seen = new Set<string>();
        for (const vid of m.versionIds) {
            if (!isUuidV4(vid)) {
                err("asset.versionIds", `versionIds contains non-UUID: ${JSON.stringify(vid)}`);
            } else if (seen.has(vid)) {
                err("asset.versionIds", `versionIds duplicate: ${vid}`);
            }
            seen.add(vid);
        }
    }
    if (typeof m.deleted !== "boolean") {
        err("asset.deleted", "deleted must be boolean");
    }
    if (!isNonNegativeInteger(m.createdAt)) {
        err("asset.createdAt", "createdAt must be a non-negative epoch-ms integer");
    }
    if (!isNonNegativeInteger(m.updatedAt)) {
        err("asset.updatedAt", "updatedAt must be a non-negative epoch-ms integer");
    } else if (typeof m.createdAt === "number" && m.updatedAt < m.createdAt) {
        err("asset.updatedAt", "updatedAt must be >= createdAt");
    }

    return { ok: !diags.some((d) => d.severity === "error"), diagnostics: diags };
}

/**
 * Strict-serialize an Asset manifest. Strict = exactly the schema fields in
 * declared order; undefined values cause an error.
 */
export function serializeAssetManifest(manifest: AssetManifestV1): string {
    const obj: Record<string, unknown> = {};
    for (const key of ASSET_MANIFEST_FIELDS) {
        const v = manifest[key] as unknown;
        if (v === undefined) {
            throw new Error(`Asset manifest field "${key}" is undefined (strict serialize)`);
        }
        obj[key] = v;
    }
    const validation = validateAssetManifest(obj);
    if (!validation.ok) {
        throw new Error(validation.diagnostics.map((item) => item.message).join("; "));
    }
    return JSON.stringify(obj, null, 2);
}

/**
 * Parse + STRICT-shape-check an Asset manifest JSON string. Throws on JSON
 * parse error, non-object, missing field, OR extra field.
 */
export function parseAssetManifest(json: string): AssetManifestV1 {
    const parsed: unknown = JSON.parse(json);
    if (!isStrictObject(parsed)) {
        throw new Error("Asset manifest JSON must be an object");
    }
    const allowed = new Set<string>(ASSET_MANIFEST_FIELDS);
    for (const k of Object.keys(parsed)) {
        if (!allowed.has(k)) {
            throw new Error(`Asset manifest has undeclared field: ${k}`);
        }
    }
    for (const key of ASSET_MANIFEST_FIELDS) {
        if (!(key in parsed)) {
            throw new Error(`Asset manifest missing required field: ${key}`);
        }
    }
    const validation = validateAssetManifest(parsed);
    if (!validation.ok) {
        throw new Error(validation.diagnostics.map((item) => item.message).join("; "));
    }
    return parsed as unknown as AssetManifestV1;
}

/** Resolve the per-asset root directory, with safe-segment guard on assetId. */
export function resolveAssetRoot(assetsRoot: string, assetId: string): string {
    requireSafeSegment(assetId, "assetId");
    return path.join(assetsRoot, assetId);
}

/**
 * Serialize Asset-owner creation against catalog-wide dependency inspection.
 *
 * Per-Asset locks protect retained owners. This catalog lock covers the one
 * case they cannot name in advance: publishing a brand-new Asset directory.
 */
export function acquireAssetCatalogLock(authorityLocksRoot: string): () => void {
    const release = tryAcquireAuthorityLocks(authorityLocksRoot, "assets", ["catalog"]);
    if (release === null) throw new Error("Asset catalog is locked");
    return release;
}

/**
 * Read + parse + strict-shape-check an Asset manifest. Returns null if missing.
 * Throws on parse/shape error or unsafe assetId (caller surfaces).
 */
export function readAssetManifest(assetsRoot: string, assetId: string): AssetManifestV1 | null {
    const file = path.join(resolveAssetRoot(assetsRoot, assetId), "asset.json");
    try {
        return parseAssetManifest(Buffer.from(readRegularFileNoFollow(file).bytes).toString("utf-8"));
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return null;
        throw error;
    }
}

/**
 * Write an Asset manifest via descriptor-safe durable replace. The
 * rename is the commit point — must be the LAST write in any Asset mutation
 * flow (CORE_DATA_MODEL §8.1, §8.4). assetId is safe-segment-guarded.
 */
export function writeAssetManifest(assetsRoot: string, manifest: AssetManifestV1): void {
    const assetRoot = resolveAssetRoot(assetsRoot, manifest.assetId);
    durableEnsureDirectory(assetsRoot, manifest.assetId);
    const file = path.join(assetRoot, "asset.json");
    const json = serializeAssetManifest(manifest);
    durableReplaceFile(file, json);
}

/**
 * Append a versionId to an Asset manifest's versionIds and bump updatedAt.
 * Returns a NEW manifest object (does not mutate input).
 *
 * Idempotent: if versionId is already the last entry, returns input unchanged.
 */
export function appendVersionId(manifest: AssetManifestV1, versionId: string, now: number): AssetManifestV1 {
    if (manifest.versionIds.length > 0 && manifest.versionIds[manifest.versionIds.length - 1] === versionId) {
        return manifest;
    }
    if (manifest.versionIds.includes(versionId)) {
        const filtered = manifest.versionIds.filter((v) => v !== versionId);
        return { ...manifest, versionIds: [...filtered, versionId], updatedAt: now };
    }
    return { ...manifest, versionIds: [...manifest.versionIds, versionId], updatedAt: now };
}

/**
 * Detect orphan Version directories under `<assetRoot>/versions/`: any version
 * dir whose UUID is NOT in the Asset manifest's versionIds. assetId is
 * safe-segment-guarded. Does NOT auto-adopt (§8.4).
 */
export function detectOrphanVersions(assetsRoot: string, manifest: AssetManifestV1): string[] {
    const assetRoot = resolveAssetRoot(assetsRoot, manifest.assetId);
    const versionsDir = path.join(assetRoot, "versions");
    const known = new Set(manifest.versionIds);
    try {
        return inventoryDirectoryNoFollow(versionsDir)
            .entries.filter((entry) => entry.identity.entryKind === "directory" && !known.has(entry.relativeName))
            .map((entry) => entry.relativeName);
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return [];
        throw error;
    }
}

/** Throw if a path segment used in a path.join is not a safe single segment. */
function requireSafeSegment(segment: unknown, label: string): void {
    if (!isSafeSegment(segment)) {
        throw new Error(`${label} must be a safe single-segment identifier (got ${JSON.stringify(segment)})`);
    }
}
