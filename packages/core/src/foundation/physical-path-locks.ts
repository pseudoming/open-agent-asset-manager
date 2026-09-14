/**
 * Operational physical-key + OS lock management for deployment target paths.
 *
 * Single-writer invariant (CORE_DATA_MODEL_DRAFT §8.11 l.1730-1755): the same
 * Platform + canonical absolute target path may be owned by only one active
 * Deployment writer at a time. v1 enforces
 * this via per-path OS locks (`@oaam/shared/filesystem` `lockFile`) acquired in a
 * deterministic sorted order, plus a SQLite BEGIN IMMEDIATE occupancy query
 * (lives in deployment-state-ops.ts, called by the executor after locks are
 * held).
 *
 * Scope (this module ONLY):
 *   - compute operational physical keys + sort them deterministically
 *   - map each key to a filesystem-safe lockfile path
 *   - acquire all locks in order; release everything acquired so far if any
 *     acquisition fails (so the caller sees all-or-nothing)
 *   - return a release() that drops all held locks
 *
 * Out of scope (handled elsewhere):
 *   - journal files, runtime file contents, SQL, recovery decisions
 *
 * v1 limitation (§8.11 l.1730-1732): the physical key canonicalizes only the
 * already-validated root + POSIX-relative lexical path. Symlink / junction /
 * Win32-WSL alias resolution is NOT promised.
 *
 * Lock semantics are selected by the Shared target build.
 * Linux and Win32 implementations hold kernel leases over persistent neutral
 * files and release without unlinking them. Other Unix-like targets retain
 * their separate exclusive-create behavior and evidence. The occupancy query
 * is authoritative only after the selected lock is acquired;
 * Core does not infer one platform's stale-entry behavior for the other.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import { durableEnsureDirectory, lockFile } from "@oaam/shared/filesystem";
import { joinPhysicalAccessPath } from "@oaam/shared/paths";
import type { Platform } from "../types";

// ============================================================
// Physical key computation
// ============================================================

/**
 * Build operational physical keys for a set of target paths and sort them so
 * multi-path ordering is deterministic across processes (deadlock-avoidance:
 * every process acquires in the same order).
 *
 * Each key is `platform\0canonicalAbsolutePath`. Joining before keying is
 * important: `/root` + `a/file` and `/root/a` + `file` must contend on the
 * same lock even when two source/target roots describe the path differently.
 *
 * Sort order: JavaScript default `.sort()` (UTF-16 code unit order). For the
 * ASCII paths that OAAM v1 targets this is identical to UTF-8 byte order; v1
 * does not promise non-ASCII path alias resolution (§8.11 l.1740-1742), so a
 * stricter byte-order sort is not warranted.
 */
export function computePhysicalKeys(platform: string, targetRootPath: string, relativePaths: string[]): string[] {
    return [...new Set(relativePaths.map((relativePath) => computePhysicalKey(platform, targetRootPath, relativePath)))].sort();
}

/** One lexical physical path key shared by source readers and target writers. */
export function computePhysicalKey(platform: string, rootPath: string, relativePath: string): string {
    const absolutePath = joinPhysicalAccessPath(rootPath, relativePath);
    return `${platform}\0${absolutePath}`;
}

export interface PhysicalLockTarget {
    relativePath: string;
    entryKind: "file" | "directory";
    /** Every extra managed/enumerated directory boundary containing the path. */
    containingDirectoryBoundaries?: readonly string[];
}

/** Per-Deployment operation lock acquired before any physical path lock. */
export function computeDeploymentOperationKey(deploymentId: string): string {
    return `deployment\0${deploymentId}`;
}

/**
 * Build the complete path-lock closure required by the source/read contract:
 *
 * - a file always contributes its own path and its immediate parent;
 * - a listed/enumerated directory contributes the directory path;
 * - every additional containing managed/enumerated boundary is included;
 * - all keys are deduplicated and globally sorted before acquisition.
 */
export function computePhysicalClosureKeys(platform: string, rootPath: string, targets: readonly PhysicalLockTarget[]): string[] {
    const relativePaths = new Set<string>();
    for (const target of targets) {
        relativePaths.add(target.relativePath);
        if (target.entryKind === "file") {
            const parent = path.posix.dirname(target.relativePath);
            relativePaths.add(parent === "." ? "" : parent);
        }
        for (const boundary of target.containingDirectoryBoundaries ?? []) {
            relativePaths.add(boundary);
        }
    }
    return computePhysicalKeys(platform, rootPath, [...relativePaths]);
}

/**
 * Source-read lock closure for a Host-visible physical path.
 *
 * The logical Platform remains the ownership namespace, while Shared derives
 * the join grammar from the canonical Host-visible root. Thus a logical WSL
 * read through a Win32 UNC root still contends with a WSL Deployment targeting
 * that same physical spelling without using Platform as a grammar selector.
 */
export function computePhysicalAccessClosureKeys(
    logicalPlatform: Platform,
    rootPath: string,
    targets: readonly PhysicalLockTarget[],
): string[] {
    return computePhysicalClosureKeys(logicalPlatform, rootPath, targets);
}

/**
 * Filesystem-safe lockfile path for a physical key. The physical key contains
 * null bytes and (on win32) backslashes, so it is SHA-256-hashed to a stable
 * hex filename. Same key → same lockfile path (deterministic).
 *
 * Layout: `<transactionsRoot>/locks/<sha256-hex>.lock`.
 */
export function lockFilePath(transactionsRoot: string, physicalKey: string): string {
    const hashed = crypto.createHash("sha256").update(physicalKey, "utf-8").digest("hex");
    return path.join(transactionsRoot, "locks", `${hashed}.lock`);
}

// ============================================================
// Acquire / release
// ============================================================

/** Handle returned by acquireAllLocks; calling release() drops all held locks. */
export interface LockHandle {
    /** Drop all locks acquired in this batch. Best-effort: per-lock release
     *  failures are swallowed; the selected Shared implementation retains its
     *  own fail-closed release semantics. Idempotent. */
    release: () => void;
}

/**
 * Acquire per-path OS locks in sorted order. All-or-nothing: if any lock is
 * already held, every lock acquired so far is released and null is returned,
 * so the caller can cleanly branch to "target locked".
 *
 * Returns null (does not throw) when a lock is already held; throws on
 * unexpected errors (permission denied, lock dir unwritable).
 *
 * Caller responsibility: the caller must hold the returned handle until it is
 * done with the protected paths, then call release(). The handle does NOT
 * infer release from file presence; the selected backend owns process-lifetime semantics.
 */
export function acquireAllLocks(transactionsRoot: string, physicalKeys: string[]): LockHandle | null {
    return acquireWithLockFn(transactionsRoot, physicalKeys, lockFile);
}

/**
 * Shared acquisition core: acquire each lock by calling `lockFn(lockfilePath)`.
 *
 * - lockFn returns a release callback on success, or null when the lock is
 *   already held (EEXIST-style). A null return releases everything acquired so
 *   far and makes the whole call return null (clean "target locked" branch).
 * - Any unexpected throw from lockFn (or ensureDir) is caught: every lock
 *   acquired so far is released via releaseAllBestEffort, then the error is
 *   re-thrown so the caller learns acquisition failed abnormally and no
 *   lockfile leaks behind.
 */
function acquireWithLockFn(
    transactionsRoot: string,
    physicalKeys: string[],
    lockFn: (lockfilePath: string) => (() => void) | null,
): LockHandle | null {
    const releases: Array<() => void> = [];
    try {
        for (const key of physicalKeys) {
            const lp = lockFilePath(transactionsRoot, key);
            ensureLockDirectory(transactionsRoot);
            const release = lockFn(lp);
            if (release === null) {
                // already held — release everything we got and report failure
                releaseAllBestEffort(releases);
                return null;
            }
            releases.push(release);
        }
        return { release: () => releaseAllBestEffort(releases) };
    } catch (err) {
        // Unexpected throw (EACCES on ensureDir, lockFn non-EEXIST error).
        // Release all previously acquired locks to avoid lockfile leakage,
        // then re-throw so the caller knows acquisition failed abnormally.
        releaseAllBestEffort(releases);
        throw err;
    }
}

/** Release every acquired lock, swallowing per-lock failures. */
function releaseAllBestEffort(releases: Array<() => void>): void {
    for (const r of releases) {
        try {
            r();
        } catch {
            // Best-effort cleanup. Shared owns the selected platform's exact
            // persistent/stale entry semantics; Core must not fake release.
        }
    }
}

function ensureLockDirectory(transactionsRoot: string): void {
    durableEnsureDirectory(path.dirname(transactionsRoot), path.basename(transactionsRoot));
    durableEnsureDirectory(transactionsRoot, "locks");
}

// ============================================================
// TEST-ONLY entry — NOT exported via barrel; only test_physical_path_locks.test.ts
// imports this. Arch guard (Group 9e) enforces no other core/src file uses it.
// ============================================================

/**
 * Test-only variant of acquireAllLocks that takes an injected `lockFn` instead
 * of calling the real shared `lockFile`. Used to drive the unexpected-throw
 * cleanup branch deterministically (a test cannot reliably force the real
 * `lockFile`'s openSync(wx) to throw EACCES via chmod on every sandbox FS, and
 * the prior chmod-based test fell back to `expect(true).toBe(true)` — a伪通过
 * that violated the test-truthfulness rule).
 *
 * The injected `lockFn` mirrors the real `lockFile` contract: return a release
 * callback on success, or null when the lockfile already exists (EEXIST). Any
 * other throw is treated as an unexpected acquisition error: previously held
 * locks are released, then the error is re-thrown.
 *
 * Production callers MUST use acquireAllLocks(); this entry exists only so a
 * test can prove "second lockFn throws unexpected → first release called +
 * re-thrown" without depending on FS permission quirks.
 */
export function acquireAllLocksForTest(
    transactionsRoot: string,
    physicalKeys: string[],
    lockFn: (lockfilePath: string) => (() => void) | null,
): LockHandle | null {
    return acquireWithLockFn(transactionsRoot, physicalKeys, lockFn);
}
