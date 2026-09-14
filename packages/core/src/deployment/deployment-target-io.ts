/**
 * Runtime target-file I/O foundation for deployment: context + I/O dispatch
 * + rollback-to-old + target-path helpers.
 *
 * This module is the shared base for the deployment target layer:
 *   - deployment-target-entries.ts : build/populate journal entries
 *   - deployment-target-cas.ts     : CAS write/delete
 *   - deployment-target-verify.ts  : post-write verify
 *
 * All four share `TargetIoContext` + the internal I/O dispatch. The context is
 * INTENTIONALLY opaque to executor/recovery: it exposes only targetRootPath.
 * Logical Platform is deliberately absent from construction and is not retained as a
 * physical-filesystem selector. Deployment state validates that business fact before this
 * physical I/O handle is created. The fault-injection I/O port (fsHooks) is stored in a module-private
 * WeakMap keyed by the context object, so:
 *   - executor/recovery never see `fsHooks` / `FsHooks` in the context type
 *   - production contexts (createTargetIo) have no port registered
 *   - only createTargetIoForTest() (imported only by test files:
 *     test_deployment_target_io.test.ts and test_deployment_recovery.test.ts,
 *     enforced by the Group 9 arch guard) registers a port
 *
 * Scope (this module ONLY):
 *   - TargetIoContext type (opaque to callers) + createTargetIo / createTargetIoForTest
 *   - internal I/O dispatch (read/write/delete/exists) used by entries/cas/verify
 *   - rollbackToOld (restore + read-back verification on conflict abort,
 *     INCLUDING removal entries)
 *   - target-path helpers shared across the target layer
 *
 * Out of scope: SQL, OS locks, journal file I/O, recovery decisions,
 * transactionId allocation, DeploymentFile row writes.
 */

import {
    type PhysicalPathIdentity,
    type StableRegularFileRead,
    SafeFilesystemError,
    assertExecutableStateSupported,
    chmodIfDifferent,
    durableCreateFile,
    durableEnsureDirectory,
    durableRemoveDirectoryTree,
    durableRemoveRegularFile,
    durableReplaceFile,
    durableOverwriteFile,
    inspectDirectoryNoFollow,
    inspectFilesystemFailure,
    readRegularFileNoFollow,
    samePhysicalPathIdentity,
} from "@oaam/shared/filesystem";
import { base64ToBytes, sha256Bytes } from "../foundation/crypto-bytes";
import {
    isCanonicalPhysicalAccessPath,
    joinPhysicalAccessPath,
    relatePhysicalAccessPaths,
    splitPhysicalAccessPath,
} from "@oaam/shared/paths";
import { getJournalRuntimeRollbackState, type JournalDirectoryEntry, type JournalEntry } from "./deployment-journal";
import { managedDirectoryAncestorPaths } from "./deployment-managed-directory-graph";

// ============================================================
// Public context type — opaque to executor/recovery (no fsHooks field)
// ============================================================

/**
 * Opaque context for deployment target operations. Production callers receive
 * this from createTargetIo(); executor/recovery never inspect its fields beyond
 * treating it as an opaque handle passed back into target-layer functions.
 *
 * The fault-injection I/O port is NOT a field here — it lives in a module-
 * private WeakMap (see fsHooksByContext below) so the type visible to
 * executor/recovery cannot even name fsHooks.
 */
export interface TargetIoContext {
    targetRootPath: string;
}

/** Production factory: target-built Shared filesystem, no fault-injection port.
 *  This is the only constructor executor/recovery may call. */
export function createTargetIo(targetRootPath: string): TargetIoContext {
    if (!isCanonicalPhysicalAccessPath(targetRootPath)) {
        throw new Error("Deployment target root must be a canonical absolute Host-visible path");
    }
    const ctx: TargetIoContext = { targetRootPath };
    return ctx;
}

// ============================================================
// Internal fault-injection port (module-private; NOT exported)
// ============================================================

/** Low-level runtime file actions. Production uses the target-built Shared
 *  filesystem; tests inject a fault-inducing variant via createTargetIoForTest.
 *  Each hook may throw to simulate a failure (readFile throws ENOENT-style when
 *  the file is absent, matching the production contract). */
interface FsHooks {
    readFile(filePath: string): Uint8Array;
    writeFile(dest: string, data: Uint8Array | string): void;
    deleteFile(filePath: string): void;
    fileExists(filePath: string): boolean;
    fileExecutable?(filePath: string): boolean;
    assertExecutableStateSupported?(filePath: string, executable: boolean): void;
    chmodIfDifferent?(filePath: string, executable: boolean): boolean;
    fileIdentity?(filePath: string): PhysicalPathIdentity;
}

/** Module-private registry of fault-injection ports. Keyed by context object
 *  so the port is reachable from ioRead/ioWrite/ioDelete/ioExists without ever
 *  appearing on the TargetIoContext type. A production context has no entry. */
const fsHooksByContext = new WeakMap<TargetIoContext, FsHooks>();

// ============================================================
// Internal I/O dispatch (used by entries / cas / verify / rollback)
// ============================================================

/**
 * @internal — sibling target-layer module use only (entries/cas/verify/recovery).
 * Executor must not call this directly; it goes through the high-level APIs in
 * those sibling modules. Recovery is an allowed sibling because it needs precise
 * per-target control (converge-to-new / restore-to-old with third-value detect
 * and fail-stop) that the high-level APIs do not cover. Read runtime bytes.
 * Throws on failure.
 */
export function ioRead(ctx: TargetIoContext, abs: string): Uint8Array {
    return ioReadStable(ctx, abs).bytes;
}

/** @internal — stable bytes/executable/identity sample for action-time CAS. */
export function ioReadStable(ctx: TargetIoContext, abs: string, maximumBytes = Number.MAX_SAFE_INTEGER): StableRegularFileRead {
    const hooks = fsHooksByContext.get(ctx);
    if (hooks) {
        const bytes = hooks.readFile(abs);
        if (bytes.byteLength > maximumBytes) throw new Error("fault-injection file exceeds the bounded read limit");
        return {
            bytes,
            executable: hooks.fileExecutable?.(abs) ?? false,
            identity: hooks.fileIdentity?.(abs) ?? {
                deviceId: "test-device",
                fileId: abs,
                entryKind: "file",
            },
        };
    }
    return readRegularFileNoFollow(abs, maximumBytes);
}

/** @internal One fresh sample owns presence, content and executable state within this target-layer step. */
export function ioReadStableIfPresent(ctx: TargetIoContext, abs: string): StableRegularFileRead | null {
    const hooks = fsHooksByContext.get(ctx);
    if (hooks !== undefined && !hooks.fileExists(abs)) return null;
    try {
        return ioReadStable(ctx, abs);
    } catch (error) {
        if (inspectFilesystemFailure(error).failureKind === "not_found") return null;
        throw error;
    }
}

/**
 * @internal — sibling target-layer module use only. Write runtime bytes
 * (atomic). Throws on failure.
 */
export function ioWrite(
    ctx: TargetIoContext,
    abs: string,
    data: Uint8Array | string,
    disposition: "create" | "replace" | "overwrite" = "replace",
    executable?: boolean,
): void {
    const hooks = fsHooksByContext.get(ctx);
    if (hooks) {
        if (disposition === "create" && hooks.fileExists(abs)) {
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation: "durable_create_file",
                targetPath: abs,
                systemCode: "EEXIST",
                message: "Create-only target appeared before the test mutation",
            });
        }
        hooks.writeFile(abs, data);
        if (executable !== undefined) hooks.chmodIfDifferent?.(abs, executable);
        return;
    }
    ensureTargetParentDirectories(ctx, abs);
    if (disposition === "create") durableCreateFile(abs, data, executable);
    else if (disposition === "overwrite") durableOverwriteFile(abs, data, executable);
    else durableReplaceFile(abs, data, executable);
}

function ensureTargetParentDirectories(ctx: TargetIoContext, abs: string): void {
    const parentPath = splitPhysicalAccessPath(abs).parentPath;
    const relation = relatePhysicalAccessPaths(ctx.targetRootPath, parentPath);
    if (relation.kind === "equal") return;
    if (relation.kind !== "root_contains_candidate") {
        throw new SafeFilesystemError({
            failureKind: "invalid_path",
            operation: "durable_ensure_directory",
            targetPath: abs,
            systemCode: "TARGET_PATH_OUTSIDE_ROOT",
            message: "Runtime target path escaped its canonical target root",
        });
    }
    let currentParent = ctx.targetRootPath;
    for (const segment of relation.relativePath.split("/")) {
        durableEnsureDirectory(currentParent, segment);
        currentParent = joinPhysicalAccessPath(currentParent, segment);
    }
}

/** Build the exact ordered parent-directory pre-state for every new target file. */
export function planTargetDirectories(
    ctx: TargetIoContext,
    entries: JournalEntry[],
    unmanagedDirectoryRemovals: readonly { relativePath: string; expectedIdentity: PhysicalPathIdentity }[] = [],
    managedDirectoryBoundaries: readonly string[] = [],
    exactDesiredManagedDirectoryPaths?: readonly string[],
): JournalDirectoryEntry[] {
    const relativePaths = new Set<string>();
    const managedFileParentPaths = new Set<string>();
    for (const entry of entries) {
        if (entry.isRemoval) continue;
        const containingBoundaries = managedDirectoryBoundaries.filter(
            (boundary) => entry.relativePath === boundary || entry.relativePath.startsWith(`${boundary}/`),
        );
        if (containingBoundaries.length > 1) {
            throw new Error("one target file cannot belong to overlapping managed-directory boundaries");
        }
        const managedBoundary = containingBoundaries[0];
        const segments = entry.relativePath.split("/");
        segments.pop();
        let current = "";
        for (const segment of segments) {
            current = current === "" ? segment : `${current}/${segment}`;
            if (managedBoundary !== undefined && current !== managedBoundary && !current.startsWith(`${managedBoundary}/`)) {
                continue;
            }
            relativePaths.add(current);
            if (managedBoundary !== undefined) managedFileParentPaths.add(current);
        }
    }
    if (exactDesiredManagedDirectoryPaths !== undefined) {
        const desiredPaths = new Set(exactDesiredManagedDirectoryPaths);
        if (desiredPaths.size !== exactDesiredManagedDirectoryPaths.length) {
            throw new Error("exact desired managed-directory paths must be unique");
        }
        for (const relativePath of desiredPaths) {
            const containingBoundaries = managedDirectoryBoundaries.filter(
                (boundary) => relativePath === boundary || relativePath.startsWith(`${boundary}/`),
            );
            if (containingBoundaries.length !== 1) {
                throw new Error("one exact desired directory must belong to exactly one managed-directory boundary");
            }
            if (entries.some((entry) => !entry.isRemoval && entry.relativePath === relativePath)) {
                throw new Error("one managed target path cannot be both a file and a directory");
            }
            const boundary = containingBoundaries[0] as string;
            if (relativePath !== boundary) {
                const parent = relativePath.slice(0, relativePath.lastIndexOf("/"));
                if (!desiredPaths.has(parent)) {
                    throw new Error("exact desired managed-directory paths must contain every directory parent");
                }
            }
            relativePaths.add(relativePath);
        }
        if ([...managedFileParentPaths].some((relativePath) => !desiredPaths.has(relativePath))) {
            throw new Error("exact desired managed-directory paths do not cover every managed target-file parent");
        }
    }
    const removalByPath = new Map(unmanagedDirectoryRemovals.map((entry) => [entry.relativePath, entry.expectedIdentity]));
    if ([...removalByPath.keys()].some((relativePath) => relativePaths.has(relativePath))) {
        throw new Error("one target directory cannot be both desired and removed");
    }
    const ancestors = managedDirectoryAncestorPaths(managedDirectoryBoundaries.filter((boundary) => relativePaths.has(boundary)));
    return [...new Set([...relativePaths, ...ancestors, ...removalByPath.keys()])]
        .sort((left, right) => {
            const depth = left.split("/").length - right.split("/").length;
            return depth || Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
        })
        .map((relativePath): JournalDirectoryEntry | null => {
            const desiredState = removalByPath.has(relativePath) ? ("missing" as const) : ("present" as const);
            try {
                const oldIdentity = inspectDirectoryNoFollow(absPath(ctx, relativePath));
                // Existing shared parents are not managed content. Only missing ancestors get
                // creation receipts, so rollback can remove exactly our own still-empty nodes.
                if (!relativePaths.has(relativePath) && !removalByPath.has(relativePath)) return null;
                const expectedIdentity = removalByPath.get(relativePath);
                if (expectedIdentity !== undefined && !samePhysicalPathIdentity(oldIdentity, expectedIdentity)) {
                    throw new SafeFilesystemError({
                        failureKind: "stale",
                        operation: "inspect_directory",
                        targetPath: absPath(ctx, relativePath),
                        systemCode: "TARGET_DIRECTORY_IDENTITY_CHANGED",
                        message: "Runtime target directory changed after its reviewed preview",
                    });
                }
                return {
                    relativePath,
                    oldState: "present" as const,
                    desiredState,
                    oldIdentity,
                    createdIdentity: null,
                };
            } catch (error) {
                if (inspectFilesystemFailure(error).failureKind !== "not_found") throw error;
                if (desiredState === "missing") {
                    throw new SafeFilesystemError({
                        failureKind: "stale",
                        operation: "inspect_directory",
                        targetPath: absPath(ctx, relativePath),
                        systemCode: "TARGET_DIRECTORY_DISAPPEARED",
                        message: "A reviewed runtime target directory disappeared before removal",
                    });
                }
                return {
                    relativePath,
                    oldState: "missing" as const,
                    desiredState,
                    oldIdentity: null,
                    createdIdentity: null,
                };
            }
        })
        .filter((entry): entry is JournalDirectoryEntry => entry !== null);
}

/** Ensure one planned direct-child directory and preserve its physical identity. */
export function ensureTargetDirectory(
    ctx: TargetIoContext,
    entry: JournalDirectoryEntry,
): { created: boolean; identity: PhysicalPathIdentity } {
    if (entry.desiredState !== "present") throw new Error("cannot ensure a directory whose desired state is missing");
    const segments = entry.relativePath.split("/");
    const childName = segments.pop() as string;
    const parentPath = segments.length === 0 ? ctx.targetRootPath : absPath(ctx, segments.join("/"));
    const ensured = durableEnsureDirectory(parentPath, childName);
    if (entry.oldState === "present") {
        if (ensured.created || entry.oldIdentity === null || !samePhysicalPathIdentity(ensured.identity, entry.oldIdentity)) {
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation: "durable_ensure_directory",
                targetPath: absPath(ctx, entry.relativePath),
                systemCode: "TARGET_DIRECTORY_IDENTITY_CHANGED",
                message: "Runtime target directory changed after its journal preflight",
            });
        }
    } else if (entry.createdIdentity === null && !ensured.created) {
        throw new SafeFilesystemError({
            failureKind: "stale",
            operation: "durable_ensure_directory",
            targetPath: absPath(ctx, entry.relativePath),
            systemCode: "TARGET_DIRECTORY_APPEARED",
            message: "A missing runtime target directory appeared before OAAM could create it",
        });
    } else if (
        entry.createdIdentity !== null &&
        !ensured.created &&
        !samePhysicalPathIdentity(ensured.identity, entry.createdIdentity)
    ) {
        throw new SafeFilesystemError({
            failureKind: "stale",
            operation: "durable_ensure_directory",
            targetPath: absPath(ctx, entry.relativePath),
            systemCode: "TARGET_CREATED_DIRECTORY_IDENTITY_CHANGED",
            message: "An OAAM-created runtime target directory changed identity",
        });
    }
    return { created: ensured.created, identity: ensured.identity };
}

/** Recreate one directory that was present before the transaction but was
 * removed on the tentative new side. Existing directories must retain their
 * journaled physical identity; a missing directory is recreated only after
 * its parent has already been restored. */
export function restoreTargetDirectory(
    ctx: TargetIoContext,
    entry: JournalDirectoryEntry,
): { created: boolean; identity: PhysicalPathIdentity } {
    if (entry.oldState !== "present" || entry.oldIdentity === null) {
        throw new Error("cannot restore a directory whose old state was missing");
    }
    const absolutePath = absPath(ctx, entry.relativePath);
    try {
        const current = inspectDirectoryNoFollow(absolutePath);
        if (!samePhysicalPathIdentity(current, entry.oldIdentity)) {
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation: "durable_ensure_directory",
                targetPath: absolutePath,
                systemCode: "TARGET_DIRECTORY_IDENTITY_CHANGED",
                message: "Runtime target directory changed after journal publication",
            });
        }
        return { created: false, identity: current };
    } catch (error) {
        if (inspectFilesystemFailure(error).failureKind !== "not_found") throw error;
    }
    const segments = entry.relativePath.split("/");
    const childName = segments.pop() as string;
    const parentPath = segments.length === 0 ? ctx.targetRootPath : absPath(ctx, segments.join("/"));
    const restored = durableEnsureDirectory(parentPath, childName);
    if (!restored.created) {
        throw new SafeFilesystemError({
            failureKind: "stale",
            operation: "durable_ensure_directory",
            targetPath: absolutePath,
            systemCode: "TARGET_DIRECTORY_APPEARED",
            message: "Runtime target directory appeared while recovery was restoring it",
        });
    }
    return restored;
}

/** Remove only missing-before directories whose exact created identity was journaled. */
export function cleanupTargetDirectories(ctx: TargetIoContext, entries: JournalDirectoryEntry[]): RollbackResult {
    const failedRelativePaths: string[] = [];
    for (const entry of [...entries].reverse()) {
        if (entry.oldState === "present" || entry.desiredState !== "present") continue;
        const abs = absPath(ctx, entry.relativePath);
        let current: PhysicalPathIdentity;
        try {
            current = inspectDirectoryNoFollow(abs);
        } catch (error) {
            if (inspectFilesystemFailure(error).failureKind === "not_found") continue;
            failedRelativePaths.push(entry.relativePath);
            continue;
        }
        if (entry.createdIdentity === null || !samePhysicalPathIdentity(current, entry.createdIdentity)) {
            failedRelativePaths.push(entry.relativePath);
            continue;
        }
        try {
            if (!durableRemoveDirectoryTree(abs, 0)) {
                failedRelativePaths.push(entry.relativePath);
                continue;
            }
            try {
                inspectDirectoryNoFollow(abs);
                failedRelativePaths.push(entry.relativePath);
            } catch (error) {
                if (inspectFilesystemFailure(error).failureKind !== "not_found") {
                    failedRelativePaths.push(entry.relativePath);
                }
            }
        } catch {
            failedRelativePaths.push(entry.relativePath);
        }
    }
    return { ok: failedRelativePaths.length === 0, failedRelativePaths };
}

/** Remove reviewed extra directories deepest-first, only after their files are absent. */
export function removeTargetDirectories(ctx: TargetIoContext, entries: JournalDirectoryEntry[]): RollbackResult {
    const failedRelativePaths: string[] = [];
    const removals = entries
        .filter((entry) => entry.desiredState === "missing")
        .sort((left, right) => {
            const depth = right.relativePath.split("/").length - left.relativePath.split("/").length;
            return depth || Buffer.compare(Buffer.from(right.relativePath, "utf8"), Buffer.from(left.relativePath, "utf8"));
        });
    for (const entry of removals) {
        const abs = absPath(ctx, entry.relativePath);
        try {
            const current = inspectDirectoryNoFollow(abs);
            if (entry.oldIdentity === null || !samePhysicalPathIdentity(current, entry.oldIdentity)) {
                failedRelativePaths.push(entry.relativePath);
                continue;
            }
            if (!durableRemoveDirectoryTree(abs, 0)) {
                failedRelativePaths.push(entry.relativePath);
            }
        } catch (error) {
            if (inspectFilesystemFailure(error).failureKind !== "not_found") failedRelativePaths.push(entry.relativePath);
        }
    }
    return { ok: failedRelativePaths.length === 0, failedRelativePaths };
}

/**
 * @internal — sibling target-layer module use only. Delete runtime file.
 * Throws on failure.
 */
export function ioDelete(ctx: TargetIoContext, abs: string): void {
    const hooks = fsHooksByContext.get(ctx);
    if (hooks) {
        hooks.deleteFile(abs);
        return;
    }
    if (!durableRemoveRegularFile(abs)) {
        throw new SafeFilesystemError({
            failureKind: "not_found",
            operation: "durable_remove_file",
            targetPath: abs,
            systemCode: "TARGET_ALREADY_MISSING",
            message: "Runtime target disappeared before durable removal",
        });
    }
}

/** @internal — sibling target-layer module use only. Test runtime file existence. */
export function ioExists(ctx: TargetIoContext, abs: string): boolean {
    const hooks = fsHooksByContext.get(ctx);
    if (hooks) return hooks.fileExists(abs);
    try {
        readRegularFileNoFollow(abs);
        return true;
    } catch (error) {
        if (inspectFilesystemFailure(error).failureKind === "not_found") return false;
        throw error;
    }
}

/** @internal — read the owner-executable bit used by action-time CAS. */
export function ioExecutable(ctx: TargetIoContext, abs: string): boolean {
    const hooks = fsHooksByContext.get(ctx);
    if (hooks !== undefined) {
        if (hooks.fileExecutable === undefined) return false;
        return hooks.fileExecutable(abs);
    }
    return readRegularFileNoFollow(abs).executable;
}

/** @internal — reject an unsupported executable state before target mutation. */
export function ioAssertExecutableStateSupported(ctx: TargetIoContext, abs: string, executable: boolean): void {
    const hooks = fsHooksByContext.get(ctx);
    if (hooks !== undefined) {
        if (executable && hooks.chmodIfDifferent === undefined) {
            throw new Error("fault-injection I/O port models only executable=false");
        }
        if (hooks.assertExecutableStateSupported !== undefined) {
            hooks.assertExecutableStateSupported(abs, executable);
            return;
        }
        return;
    }
    assertExecutableStateSupported(abs, executable);
}

/** @internal — reconcile executable state through the selected backend. */
export function ioChmodIfDifferent(ctx: TargetIoContext, abs: string, executable: boolean): boolean {
    const hooks = fsHooksByContext.get(ctx);
    if (hooks !== undefined) {
        if (hooks.chmodIfDifferent !== undefined) return hooks.chmodIfDifferent(abs, executable);
        if (executable) throw new Error("fault-injection I/O port models only executable=false");
        return false;
    }
    return chmodIfDifferent(abs, executable);
}

// ============================================================
// Rollback to old (verified, on conflict abort)
// ============================================================

export interface RollbackResult {
    ok: boolean;
    failedRelativePaths: string[];
}

/**
 * Restore and verify each entry against its pre-deploy (old) state. Used by the
 * executor when CAS aborts on a third_value partway through a batch: the
 * entries written before the stop are rolled back to old. The journal is NOT
 * deleted by this function — the executor decides whether to leave it
 * unresolved.
 *
 * Handles BOTH entry kinds. Absence is determined by `oldHash === ""` (no
 * previous baseline = file did not exist pre-deploy), NOT by `oldBytesBase64`
 * — a zero-byte old file legitimately has `oldBytesBase64 === ""` and must be
 * restored as an empty file, not deleted.
 *   - oldHash === "" (file did not exist pre-deploy): delete only the exact
 *     new state written by this transaction.
 *   - oldHash !== "" (file existed pre-deploy, including zero-byte files):
 *     write back base64ToBytes(oldBytesBase64) (empty b64 → restore a
 *     zero-byte file) + restore executable bit. Applies to deploy entries
 *     that were overwritten AND removal entries whose file was deleted.
 *
 * Per-path mutation failures are caught so every written path gets a rollback
 * attempt. The function then verifies the exact old content/absence and the
 * executable fact reported by the selected backend. The executor may delete
 * the journal only when `ok=true`; otherwise recovery remains the authoritative
 * converging path and the journal must stay unresolved.
 */
export function rollbackToOld(entries: JournalEntry[], ctx: TargetIoContext): RollbackResult {
    const unsupported = unsupportedRollbackExecutablePaths(entries, ctx);
    if (unsupported.length > 0) return { ok: false, failedRelativePaths: unsupported };
    const failedRelativePaths: string[] = [];
    for (const entry of entries) {
        const abs = absPath(ctx, entry.relativePath);
        const runtimeOld = getJournalRuntimeRollbackState(entry);
        try {
            const current = ioReadStableIfPresent(ctx, abs);
            const currentHash = current === null ? "" : sha256Bytes(current.bytes);
            const currentExecutable = current?.executable ?? false;
            if (currentHash === runtimeOld.contentHash && currentExecutable === runtimeOld.executable) continue;
            if (currentHash !== entry.newHash || currentExecutable !== entry.newExecutable) {
                failedRelativePaths.push(entry.relativePath);
                continue;
            }
            if (runtimeOld.state === "missing") {
                // An absent current file already matched the missing old state above.
                ioDelete(ctx, abs);
            } else {
                // File existed pre-deploy (oldHash is a real sha256). Restore
                // old bytes — including zero-byte — and its executable bit.
                ioWrite(ctx, abs, base64ToBytes(runtimeOld.bytesBase64), current === null ? "create" : "replace");
                ioChmodIfDifferent(ctx, abs, runtimeOld.executable);
            }
        } catch {
            // Continue so every previously-written path gets an attempt. The
            // read-back verification below records this path as failed.
        }
        if (!matchesOldState(entry, ctx, abs)) {
            failedRelativePaths.push(entry.relativePath);
        }
    }
    return { ok: failedRelativePaths.length === 0, failedRelativePaths };
}

function matchesOldState(entry: JournalEntry, ctx: TargetIoContext, abs: string): boolean {
    try {
        const runtimeOld = getJournalRuntimeRollbackState(entry);
        if (runtimeOld.state === "missing") return !ioExists(ctx, abs);
        if (!ioExists(ctx, abs) || sha256Bytes(ioRead(ctx, abs)) !== runtimeOld.contentHash) return false;
        return ioExecutable(ctx, abs) === runtimeOld.executable;
    } catch {
        return false;
    }
}

function unsupportedRollbackExecutablePaths(entries: JournalEntry[], ctx: TargetIoContext): string[] {
    const failures: string[] = [];
    for (const entry of entries) {
        const runtimeOld = getJournalRuntimeRollbackState(entry);
        if (runtimeOld.state === "missing") continue;
        try {
            ioAssertExecutableStateSupported(ctx, absPath(ctx, entry.relativePath), runtimeOld.executable);
        } catch {
            failures.push(entry.relativePath);
        }
    }
    return failures;
}

// ============================================================
// Codec + path helpers (shared by entries / cas / verify)
// ============================================================

/** @internal — sibling target-layer module use only. Resolve a relative path
 *  against the context's targetRootPath. */
export function absPath(ctx: TargetIoContext, relativePath: string): string {
    return joinPhysicalAccessPath(ctx.targetRootPath, relativePath);
}

// ============================================================
// TEST-ONLY factory — NOT exported via barrel; only
// test_deployment_target_io.test.ts (and the split test files) import this.
// Executor/recovery must not.
// ============================================================

/**
 * Test-only factory: register a fault-injection I/O port for a context so
 * entries/cas/verify/rollback run against the injected hooks instead of the
 * real fs. Used to simulate CAS write/delete/read/verify failures.
 *
 * This function is intentionally NOT re-exported through any barrel. The port
 * is stored in a module-private WeakMap so even if executor/recovery imported
 * this module they could not read or construct a port through the context type.
 */
export function createTargetIoForTest(
    targetRootPath: string,
    fsHooks: {
        readFile(filePath: string): Uint8Array;
        writeFile(dest: string, data: Uint8Array | string): void;
        deleteFile(filePath: string): void;
        fileExists(filePath: string): boolean;
        fileExecutable?(filePath: string): boolean;
        assertExecutableStateSupported?(filePath: string, executable: boolean): void;
        chmodIfDifferent?(filePath: string, executable: boolean): boolean;
    },
): TargetIoContext {
    const ctx: TargetIoContext = { targetRootPath };
    fsHooksByContext.set(ctx, fsHooks);
    return ctx;
}
