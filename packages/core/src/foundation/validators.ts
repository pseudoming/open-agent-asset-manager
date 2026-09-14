/**
 * Shared strict validators for manifest / payload / staging layers.
 *
 * These enforce the "strict JSON, no extra keys, no null, no extension bag"
 * contract (ASSET_SPECS §2.3) plus path-safety guards reused across
 * asset-manifest / version-manifest / payload-store / staging-commit.
 *
 * All check functions are total — they never throw on malformed input; they
 * return boolean / push diagnostics so callers can collect all problems
 * instead of bailing on the first one.
 */

import * as path from "node:path";
import { isCanonicalPhysicalAccessPath } from "@oaam/shared/paths";

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * POSIX-relative path forbidden forms (ASSET_SPECS §5 + CORE_DATA_MODEL §7):
 * absolute, `..` segment, `.` segment, backslash, trailing `/`. Also rejects
 * empty string and embedded NUL.
 */
const POSIX_REL_FORBIDDEN = /(^|\/)\.\.(\/|$)|(^|\/)\.(\/|$)|\\|^\//;

/**
 * A "safe single segment" identifier for filesystem dir names that must NOT
 * allow path traversal: letters/digits/dash/underscore only, non-empty, no
 * slash/backslash/dot/space. Used for staging txnId and asset/version UUIDs
 * passed to path.join.
 */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

export function isUuidV4(s: unknown): s is string {
    return typeof s === "string" && UUID_V4_RE.test(s);
}

export function isSha256Digest(s: unknown): s is string {
    return typeof s === "string" && SHA256_RE.test(s);
}

/**
 * Validate a POSIX-relative path (logicalPath / scopePath). Rejects empty,
 * absolute, `..`, `.`, backslash, trailing `/`, embedded NUL. Returns true iff
 * the path is a non-empty POSIX-relative path with none of the forbidden forms.
 *
 * Note: project-root assets use scopePath === "" (allowed at a higher level —
 * this function rejects empty; the scope validator treats "" specially).
 */
export function isPosixRelativePath(s: unknown): s is string {
    if (typeof s !== "string") return false;
    if (s.length === 0) return false;
    if (s.includes("\0")) return false;
    if (POSIX_REL_FORBIDDEN.test(s)) return false;
    if (s.endsWith("/")) return false;
    return true;
}

/**
 * Canonical POSIX-relative path: isPosixRelativePath AND `path.posix.normalize`
 * leaves the path unchanged.
 *
 * Rejects collapsible aliases that `isPosixRelativePath` alone permits, e.g.
 * `a//b.md` (collapsed to `a/b.md`), which would otherwise bypass the
 * single-writer occupancy/lock queries: those match on the raw stored string,
 * so a plan/baseline row carrying `a//b.md` would neither collide with another
 * deployment owning `a/b.md` nor be deduplicated by raw-string set logic.
 *
 * Used for every relativePath that enters locks / occupancy / journal / CAS
 * (plan.targetFiles[].relativePath and active DeploymentFile.relativePath
 * rows), so that a stored path is its own canonical form and cannot slip past
 * raw-string matching.
 *
 * Safe on empty string (isPosixRelativePath already rejects it; `path.posix.
 * normalize("")` returns `"."` but is never reached).
 */
export function isCanonicalRelativePath(s: unknown): s is string {
    if (!isPosixRelativePath(s)) return false;
    return path.posix.normalize(s as string) === (s as string);
}

/**
 * Canonical absolute Host-visible Deployment target root plus a known logical
 * Platform. Path grammar follows the actual root rather than Platform because
 * a Host can reach another environment through a different grammar (for
 * example logical WSL through a Win32 UNC root). Target-built Shared I/O still
 * rejects paths its physical backend cannot safely access.
 */
export function isCanonicalTargetRootPath(value: unknown, platform: unknown): value is string {
    if (platform !== "win32" && platform !== "darwin" && platform !== "linux" && platform !== "wsl") return false;
    return isCanonicalPhysicalAccessPath(value);
}

/**
 * Validate a safe single-segment filesystem identifier (for staging txnId,
 * assetId, versionId when used in path joins). Rejects path separators, dots,
 * spaces — defends against traversal even if a caller passes a malformed id.
 */
export function isSafeSegment(s: unknown): s is string {
    return typeof s === "string" && SAFE_SEGMENT_RE.test(s);
}

/**
 * Strict-object check: value must be a non-null plain object (not array, not
 * null) whose keys are EXACTLY the allowed set — no extra keys, no missing
 * keys. Returns true iff the object's key set equals `allowed`.
 *
 * Per ASSET_SPECS §2.3: "未声明字段视为错误". This rejects extension bags.
 */
export function hasExactKeys(value: unknown, allowed: readonly string[]): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const obj = value as Record<string, unknown>;
    const actual = Object.keys(obj);
    if (actual.length !== allowed.length) return false;
    const allowedSet = new Set(allowed);
    for (const k of actual) {
        if (!allowedSet.has(k)) return false;
    }
    return true;
}

/**
 * Strict-object check allowing a subset of allowed keys (no extras). Used for
 * discriminated-union typeData where the active variant has a subset of a
 * larger declared field set.
 */
export function hasNoExtraKeys(value: unknown, allowed: readonly string[]): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const obj = value as Record<string, unknown>;
    const allowedSet = new Set(allowed);
    for (const k of Object.keys(obj)) {
        if (!allowedSet.has(k)) return false;
    }
    return true;
}

/**
 * Check that a value is a non-null object (not array). Does not check keys —
 * use hasExactKeys / hasNoExtraKeys for that. Used as a precondition before
 * accessing nested fields so validators don't throw on null/undefined.
 */
export function isStrictObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check that a value is an array (not null, not object).
 */
export function isStrictArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

/**
 * Check that a value is a non-null string.
 */
export function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

/**
 * Check that a value is a non-negative integer (epoch millis / byteSize /
 * revision / sortOrder).
 */
export function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Check that a value is a positive integer (>= 1) (revision).
 */
export function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
