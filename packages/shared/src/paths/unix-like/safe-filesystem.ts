import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import {
    filesystemEntryKind as entryKind,
    filesystemSystemCode as errnoCode,
    toSafeFilesystemError as safeError,
    sameFilesystemIdentity as sameIdentity,
    sameFilesystemStableSample as sameStableSample,
} from "../../filesystem/filesystem-facts";
import {
    DurableFilesystemMutationError,
    type BoundedDirectoryEntry,
    type EnsuredDirectory,
    type FilesystemCapacity,
    type PhysicalPathIdentity,
    SafeFilesystemError,
    type SafeFilesystemOperation,
    type StableDirectoryInventory,
    type StableDirectoryInventoryEntry,
    type StableRegularFileRangeRead,
    type StableRegularFileRead,
} from "../../filesystem/filesystem-types";
import { readFileDescriptorBounded } from "./bounded-io";
import { readOpenedDirectoryEntriesBounded } from "../directory-member-observation";
import {
    assertCanonicalAbsolutePath,
    assertSelectedFilesystemSupported,
    closeQuietly,
    descriptorPath,
    durableMutationError,
    inspectChildWithoutFollowing,
    type OpenedSafeEntry,
    openAbsolutePathNoFollow,
    openChildNoFollow,
    physicalIdentity,
} from "./descriptor-filesystem";
import { invokeLinuxEntryPublication } from "./linux-entry-publication";

export type {
    DurableMutationState,
    EnsuredDirectory,
    FilesystemCapacity,
    PhysicalPathIdentity,
    SafeFilesystemFailureKind,
    SafeFilesystemOperation,
    StableDirectoryInventory,
    StableDirectoryInventoryEntry,
    StableRegularFileRangeRead,
    StableRegularFileRead,
} from "../../filesystem/filesystem-types";
export { DurableFilesystemMutationError, SafeFilesystemError } from "../../filesystem/filesystem-types";

/**
 * Read one regular file without following any user-controlled path segment.
 * The returned bytes and identity come from the same descriptor. A metadata
 * change during the read is reported as `stale`, never as a successful sample.
 */
export function readRegularFileNoFollow(filePath: string, maximumBytes = Number.MAX_SAFE_INTEGER): StableRegularFileRead {
    const operation: SafeFilesystemOperation = "read_regular_file";
    const opened = openAbsolutePathNoFollow(filePath, "file", operation);
    try {
        const before = fs.fstatSync(opened.fd, { bigint: true });
        if (before.size > BigInt(maximumBytes)) {
            throw new SafeFilesystemError({
                failureKind: "resource_limit",
                operation,
                targetPath: filePath,
                message: "regular file exceeds the caller's bounded-read byte limit",
            });
        }
        const bytes = readFileDescriptorBounded(opened.fd, Number(before.size), maximumBytes, filePath);
        const after = fs.fstatSync(opened.fd, { bigint: true });
        if (!sameStableSample(before, after)) {
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation,
                targetPath: filePath,
                message: "regular file changed while it was being read",
            });
        }
        return {
            bytes,
            executable: (after.mode & 0o100n) !== 0n,
            identity: physicalIdentity(after),
        };
    } catch (error) {
        throw safeError(error, operation, filePath);
    } finally {
        closeQuietly(opened.fd);
    }
}

function requireRangeInteger(value: number, label: string, filePath: string, allowZero: boolean): number {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
        throw new SafeFilesystemError({
            failureKind: "resource_limit",
            operation: "read_regular_file",
            targetPath: filePath,
            systemCode: "INVALID_RANGE",
            message: `${label} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`,
        });
    }
    return value;
}

/**
 * Read one stable byte range without following any user-controlled path
 * segment. This is the scalable counterpart to the whole-file read above.
 */
export function readRegularFileRangeNoFollow(
    filePath: string,
    byteOffset: number,
    maximumBytes: number,
): StableRegularFileRangeRead {
    const operation: SafeFilesystemOperation = "read_regular_file";
    const offset = requireRangeInteger(byteOffset, "byteOffset", filePath, true);
    const limit = requireRangeInteger(maximumBytes, "maximumBytes", filePath, false);
    const opened = openAbsolutePathNoFollow(filePath, "file", operation);
    try {
        const before = fs.fstatSync(opened.fd, { bigint: true });
        if (before.size > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(offset) > before.size) {
            throw new SafeFilesystemError({
                failureKind: "resource_limit",
                operation,
                targetPath: filePath,
                message: "byteOffset is outside the safely addressable regular file",
            });
        }
        const totalBytes = Number(before.size);
        const rangeLength = Math.min(limit, totalBytes - offset);
        const bytes = Buffer.allocUnsafe(rangeLength);
        let consumed = 0;
        while (consumed < rangeLength) {
            const read = fs.readSync(opened.fd, bytes, consumed, rangeLength - consumed, offset + consumed);
            if (read === 0) {
                throw new SafeFilesystemError({
                    failureKind: "stale",
                    operation,
                    targetPath: filePath,
                    message: "regular file became shorter while a byte range was being read",
                });
            }
            consumed += read;
        }
        const after = fs.fstatSync(opened.fd, { bigint: true });
        if (!sameStableSample(before, after)) {
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation,
                targetPath: filePath,
                message: "regular file changed while a byte range was being read",
            });
        }
        return {
            bytes,
            byteOffset: offset,
            totalBytes,
            executable: (after.mode & 0o100n) !== 0n,
            identity: physicalIdentity(after),
        };
    } catch (error) {
        throw safeError(error, operation, filePath);
    } finally {
        closeQuietly(opened.fd);
    }
}

function boundedCapacity(value: bigint): number {
    return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

/** Read filesystem capacity from the already opened directory descriptor. */
export function inspectFilesystemCapacity(directoryPath: string): FilesystemCapacity {
    const operation: SafeFilesystemOperation = "inspect_filesystem_capacity";
    const opened = openAbsolutePathNoFollow(directoryPath, "directory", operation);
    try {
        const before = fs.fstatSync(opened.fd, { bigint: true });
        const capacity = fs.statfsSync(descriptorPath(opened.fd), { bigint: true });
        const after = fs.fstatSync(opened.fd, { bigint: true });
        if (!sameStableSample(before, after)) {
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation,
                targetPath: directoryPath,
                message: "directory changed while filesystem capacity was inspected",
            });
        }
        return {
            availableBytes: boundedCapacity(capacity.bavail * capacity.bsize),
            totalBytes: boundedCapacity(capacity.blocks * capacity.bsize),
        };
    } catch (error) {
        throw safeError(error, operation, directoryPath);
    } finally {
        closeQuietly(opened.fd);
    }
}

/**
 * Confirm the physical identity of one regular file without reading its body.
 *
 * The exact path is opened no-follow and sampled twice through the same
 * descriptor. This is intended for large structured stores whose own parser
 * will read the body after the caller binds that parse to the returned
 * identity.
 */
export function inspectRegularFileNoFollow(filePath: string): PhysicalPathIdentity {
    const operation: SafeFilesystemOperation = "inspect_regular_file";
    const opened = openAbsolutePathNoFollow(filePath, "file", operation);
    try {
        const before = fs.fstatSync(opened.fd, { bigint: true });
        const after = fs.fstatSync(opened.fd, { bigint: true });
        if (!sameStableSample(before, after)) {
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation,
                targetPath: filePath,
                message: "regular file changed while its identity was being inspected",
            });
        }
        return physicalIdentity(after);
    } catch (error) {
        throw safeError(error, operation, filePath);
    } finally {
        closeQuietly(opened.fd);
    }
}

/** Inspect only the exact directory entry; child contents are deliberately not enumerated. */
export function inspectDirectoryNoFollow(directoryPath: string): PhysicalPathIdentity {
    const operation: SafeFilesystemOperation = "inspect_directory";
    const opened = openAbsolutePathNoFollow(directoryPath, "directory", operation);
    try {
        const before = fs.fstatSync(opened.fd, { bigint: true });
        const after = fs.fstatSync(opened.fd, { bigint: true });
        if (!sameStableSample(before, after)) {
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation,
                targetPath: directoryPath,
                message: "directory changed while its identity was being inspected",
            });
        }
        return physicalIdentity(after);
    } catch (error) {
        throw safeError(error, operation, directoryPath);
    } finally {
        closeQuietly(opened.fd);
    }
}

/**
 * Enumerate exactly one directory level. Every child is opened no-follow and
 * bound to a physical identity. One unsafe/unreadable child fails the entire
 * operation, so callers can never mistake a partial list for a full inventory.
 */
export function inventoryDirectoryNoFollow(
    directoryPath: string,
    maximumEntries = Number.MAX_SAFE_INTEGER,
): StableDirectoryInventory {
    const operation: SafeFilesystemOperation = "inventory_directory";
    const opened = openAbsolutePathNoFollow(directoryPath, "directory", operation);
    try {
        const before = fs.fstatSync(opened.fd, { bigint: true });
        const names = readOpenedDirectoryNamesBounded(opened, maximumEntries, directoryPath);
        const entries: StableDirectoryInventoryEntry[] = [];

        for (const relativeName of names) {
            const childPath = join(directoryPath, relativeName);
            const childBefore = inspectChildWithoutFollowing(opened.fd, relativeName, operation, childPath);
            const kind = entryKind(childBefore);
            if (kind === null) {
                throw new SafeFilesystemError({
                    failureKind: "wrong_entry_type",
                    operation,
                    targetPath: childPath,
                    message: "directory inventory accepts only regular files and directories",
                });
            }
            const child = openChildNoFollow(opened.fd, relativeName, kind, operation, childPath);
            try {
                entries.push({
                    relativeName,
                    identity: physicalIdentity(child.stat),
                });
            } finally {
                closeQuietly(child.fd);
            }
        }

        const after = fs.fstatSync(opened.fd, { bigint: true });
        if (!sameStableSample(before, after)) {
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation,
                targetPath: directoryPath,
                message: "directory changed while it was being inventoried",
            });
        }
        return {
            identity: physicalIdentity(after),
            entries,
        };
    } catch (error) {
        throw safeError(error, operation, directoryPath);
    } finally {
        closeQuietly(opened.fd);
    }
}

/**
 * Keep the low-level `/proc/self/fd` directory reader behind this selected
 * safe-filesystem owner even when a higher-level tree operation already holds
 * the descriptor.
 */
export function readOpenedDirectoryNamesBounded(
    opened: Pick<OpenedSafeEntry, "fd">,
    maximumEntries: number,
    diagnosticPath: string,
): string[] {
    return readOpenedDirectoryEntriesBounded(descriptorPath(opened.fd), maximumEntries, diagnosticPath)
        .map((entry) => entry.name)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Enumerate a directory whose membership may legitimately change while it is
 * open. The path is still opened segment-by-segment without following links,
 * but this observation deliberately makes no stable-membership claim.
 */
export function readVolatileDirectoryEntriesBounded(directoryPath: string, maximumEntries: number): BoundedDirectoryEntry[] {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
        throw new RangeError("maximumEntries must be a non-negative safe integer");
    }
    const operation: SafeFilesystemOperation = "inventory_directory";
    const opened = openAbsolutePathNoFollow(directoryPath, "directory", operation);
    try {
        return readOpenedDirectoryEntriesBounded(descriptorPath(opened.fd), maximumEntries, directoryPath).sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        );
    } catch (error) {
        throw safeError(error, operation, directoryPath);
    } finally {
        closeQuietly(opened.fd);
    }
}

/**
 * Re-confirm that one already-published regular file is both descriptor-stable
 * and flushed to the backing filesystem. The path is opened no-follow, the
 * bytes are sampled from that descriptor, the descriptor is fsynced, and the
 * path is then reopened no-follow to reject a concurrent rename/replacement.
 *
 * This does not publish or mutate file contents. It is the recovery-side
 * durability barrier used before a previously published file is trusted
 * after a process crash.
 */
export function confirmDurableRegularFileNoFollow(filePath: string): StableRegularFileRead {
    const operation: SafeFilesystemOperation = "confirm_durable_file";
    const opened = openAbsolutePathNoFollow(filePath, "file", operation);
    try {
        const before = fs.fstatSync(opened.fd, { bigint: true });
        const expectedBytes = Number(before.size);
        const bytes = readFileDescriptorBounded(opened.fd, expectedBytes, expectedBytes, filePath, operation);
        fs.fsyncSync(opened.fd);
        const afterFlush = fs.fstatSync(opened.fd, { bigint: true });
        if (!sameStableSample(before, afterFlush)) {
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation,
                targetPath: filePath,
                message: "regular file identity or bytes changed during durability confirmation",
            });
        }

        const reopened = openAbsolutePathNoFollow(filePath, "file", operation);
        try {
            const reopenedBefore = fs.fstatSync(reopened.fd, { bigint: true });
            const reopenedExpectedBytes = Number(reopenedBefore.size);
            const reopenedBytes = readFileDescriptorBounded(
                reopened.fd,
                reopenedExpectedBytes,
                reopenedExpectedBytes,
                filePath,
                operation,
            );
            const reopenedAfter = fs.fstatSync(reopened.fd, { bigint: true });
            if (!sameStableSample(afterFlush, reopenedAfter) || !Buffer.from(reopenedBytes).equals(Buffer.from(bytes))) {
                throw new SafeFilesystemError({
                    failureKind: "stale",
                    operation,
                    targetPath: filePath,
                    message: "regular file path was replaced after durability confirmation",
                });
            }
            return {
                bytes: reopenedBytes,
                executable: (reopenedAfter.mode & 0o100n) !== 0n,
                identity: physicalIdentity(reopenedAfter),
            };
        } finally {
            closeQuietly(reopened.fd);
        }
    } catch (error) {
        throw safeError(error, operation, filePath);
    } finally {
        closeQuietly(opened.fd);
    }
}

/**
 * Re-confirm that one already-published directory entry is durable and still
 * resolves to the same physical directory after fsync. Callers enumerate and
 * confirm child authorities separately; this primitive owns only the exact
 * directory identity/barrier.
 */
export function confirmDurableDirectoryNoFollow(directoryPath: string): PhysicalPathIdentity {
    const operation: SafeFilesystemOperation = "confirm_durable_directory";
    const opened = openAbsolutePathNoFollow(directoryPath, "directory", operation);
    try {
        const before = fs.fstatSync(opened.fd, { bigint: true });
        fs.fsyncSync(opened.fd);
        const afterFlush = fs.fstatSync(opened.fd, { bigint: true });
        if (!sameIdentity(before, afterFlush)) {
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation,
                targetPath: directoryPath,
                message: "directory identity changed during durability confirmation",
            });
        }

        const reopened = openAbsolutePathNoFollow(directoryPath, "directory", operation);
        try {
            const reopenedAfter = fs.fstatSync(reopened.fd, { bigint: true });
            if (!sameIdentity(afterFlush, reopenedAfter)) {
                throw new SafeFilesystemError({
                    failureKind: "stale",
                    operation,
                    targetPath: directoryPath,
                    message: "directory path was replaced after durability confirmation",
                });
            }
            return physicalIdentity(reopenedAfter);
        } finally {
            closeQuietly(reopened.fd);
        }
    } catch (error) {
        throw safeError(error, operation, directoryPath);
    } finally {
        closeQuietly(opened.fd);
    }
}

/**
 * Ensure one direct child directory exists beneath a descriptor-bound parent.
 * Existing directories are reopened no-follow; missing directories are made
 * through the parent descriptor and the parent is fsynced before success.
 */
export function durableEnsureDirectory(parentPath: string, childName: string): EnsuredDirectory {
    const operation: SafeFilesystemOperation = "durable_ensure_directory";
    assertSelectedFilesystemSupported(operation, parentPath);
    assertCanonicalAbsolutePath(parentPath, operation);
    const targetPath = join(parentPath, childName);
    if (
        childName.length === 0 ||
        childName === "." ||
        childName === ".." ||
        childName.includes("/") ||
        childName.includes("\\") ||
        childName.includes("\0")
    ) {
        throw durableMutationError(
            new SafeFilesystemError({
                failureKind: "invalid_path",
                operation,
                targetPath,
                message: "directory childName must be one safe path segment",
            }),
            targetPath,
            "not_applied",
            operation,
        );
    }

    let parent: OpenedSafeEntry;
    try {
        parent = openAbsolutePathNoFollow(parentPath, "directory", operation);
    } catch (error) {
        throw durableMutationError(error, targetPath, "not_applied", operation);
    }

    let created = false;
    try {
        try {
            const existing = openChildNoFollow(parent.fd, childName, "directory", operation, targetPath);
            try {
                return { identity: physicalIdentity(existing.stat), created: false };
            } finally {
                closeQuietly(existing.fd);
            }
        } catch (error) {
            if (!(error instanceof SafeFilesystemError && error.failureKind === "not_found") && errnoCode(error) !== "ENOENT") {
                throw error;
            }
        }

        fs.mkdirSync(descriptorPath(parent.fd, childName), { mode: 0o700 });
        created = true;
        fs.fsyncSync(parent.fd);
        const ensured = openChildNoFollow(parent.fd, childName, "directory", operation, targetPath);
        try {
            return { identity: physicalIdentity(ensured.stat), created: true };
        } finally {
            closeQuietly(ensured.fd);
        }
    } catch (error) {
        throw durableMutationError(error, targetPath, created ? "may_have_applied" : "not_applied", operation);
    } finally {
        closeQuietly(parent.fd);
    }
}

/**
 * Replace one regular file using temp-file fsync -> rename -> parent fsync,
 * then re-open the destination no-follow and compare exact bytes.
 *
 * This is a durable publication primitive, not a conditional CAS. Callers
 * must hold their own higher-level mutex and validate expected state before use.
 * Parent directories must already exist; creating a durable directory tree is
 * deliberately outside this primitive.
 */
function durablePublishFileBytes(
    filePath: string,
    data: string | Uint8Array,
    disposition: "create" | "replace",
    executable?: boolean,
): PhysicalPathIdentity {
    const operation: SafeFilesystemOperation = disposition === "create" ? "durable_create_file" : "durable_replace_file";
    assertSelectedFilesystemSupported(operation, filePath);
    assertCanonicalAbsolutePath(filePath, operation);
    if (filePath === "/") {
        throw durableMutationError(
            new SafeFilesystemError({
                failureKind: "invalid_path",
                operation,
                targetPath: filePath,
                message: "durable replacement requires a file basename",
            }),
            filePath,
            "not_applied",
            operation,
        );
    }

    const parentPath = dirname(filePath);
    const name = basename(filePath);
    const bytes = Buffer.from(data);
    let parent: OpenedSafeEntry;
    try {
        parent = openAbsolutePathNoFollow(parentPath, "directory", operation);
    } catch (error) {
        throw durableMutationError(error, filePath, "not_applied", operation);
    }

    let tempFd: number | null = null;
    let tempPath = "";
    let renamed = false;
    let replacementMode = 0o600;
    try {
        try {
            const existing = fs.lstatSync(descriptorPath(parent.fd, name), {
                bigint: true,
            });
            if (existing.isSymbolicLink()) {
                throw new SafeFilesystemError({
                    failureKind: "symlink_or_reparse",
                    operation,
                    targetPath: filePath,
                    message: "durable replacement rejected a symbolic-link destination",
                });
            }
            if (!existing.isFile()) {
                throw new SafeFilesystemError({
                    failureKind: "wrong_entry_type",
                    operation,
                    targetPath: filePath,
                    message: "durable replacement destination is not a regular file",
                });
            }
            if (disposition === "create") {
                throw new SafeFilesystemError({
                    failureKind: "stale",
                    operation,
                    targetPath: filePath,
                    systemCode: "DESTINATION_EXISTS",
                    message: "durable create refuses to replace an existing destination",
                });
            }
            replacementMode = Number(existing.mode & 0o777n);
        } catch (error) {
            if (errnoCode(error) !== "ENOENT") throw error;
        }

        const tempName = `.${name}.${crypto.randomBytes(12).toString("hex")}.tmp`;
        tempPath = descriptorPath(parent.fd, tempName);
        tempFd = fs.openSync(
            tempPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            replacementMode,
        );
        fs.writeFileSync(tempFd, bytes);
        if (executable !== undefined) fs.fchmodSync(tempFd, executable ? replacementMode | 0o100 : replacementMode & ~0o111);
        fs.fsyncSync(tempFd);
        fs.closeSync(tempFd);
        tempFd = null;

        if (disposition === "create") {
            fs.linkSync(tempPath, descriptorPath(parent.fd, name));
            renamed = true;
            fs.unlinkSync(tempPath);
            tempPath = "";
        } else {
            fs.renameSync(tempPath, descriptorPath(parent.fd, name));
            renamed = true;
        }
        fs.fsyncSync(parent.fd);

        const published = openChildNoFollow(parent.fd, name, "file", operation, filePath);
        try {
            const actual = readFileDescriptorBounded(
                published.fd,
                Number(published.stat.size),
                bytes.byteLength,
                filePath,
                operation,
            );
            const after = fs.fstatSync(published.fd, { bigint: true });
            if (
                !sameStableSample(published.stat, after) ||
                !Buffer.from(actual).equals(bytes) ||
                (executable !== undefined && ((after.mode & 0o100n) !== 0n) !== executable)
            ) {
                throw new SafeFilesystemError({
                    failureKind: "stale",
                    operation,
                    targetPath: filePath,
                    message: "durable replacement verification did not match published bytes",
                });
            }
            return physicalIdentity(after);
        } finally {
            closeQuietly(published.fd);
        }
    } catch (error) {
        throw durableMutationError(error, filePath, renamed ? "may_have_applied" : "not_applied", operation);
    } finally {
        if (tempFd !== null) closeQuietly(tempFd);
        if (!renamed && tempPath !== "") {
            try {
                fs.unlinkSync(tempPath);
            } catch {
                // Best-effort cleanup; the typed primary failure is authoritative.
            }
        }
        closeQuietly(parent.fd);
    }
}

/**
 * Durably create one immutable regular file. Existing destinations are never
 * replaced, including when they appear between preflight and publication.
 */
export function durableCreateFile(filePath: string, data: string | Uint8Array, executable?: boolean): PhysicalPathIdentity {
    return durablePublishFileBytes(filePath, data, "create", executable);
}

export function durableReplaceFile(filePath: string, data: string | Uint8Array, executable?: boolean): PhysicalPathIdentity {
    return durablePublishFileBytes(filePath, data, "replace", executable);
}

/**
 * Durably remove one regular file through a descriptor-bound parent.
 *
 * The final entry is opened with O_NOFOLLOW before unlink. A static symlink,
 * directory, or unsafe intermediate segment is rejected. If the entry is
 * replaced after validation, unlink can remove only the entry at the anchored
 * parent/name; it never follows a replacement symlink to its target.
 *
 * @returns true when this call removed the file, false when it was already
 * absent. A failure after unlink is reported as `may_have_applied` so callers
 * must re-open/reconcile rather than assuming the marker still exists.
 */
export function durableRemoveRegularFile(filePath: string): boolean {
    const operation: SafeFilesystemOperation = "durable_remove_file";
    assertSelectedFilesystemSupported(operation, filePath);
    assertCanonicalAbsolutePath(filePath, operation);
    if (filePath === "/") {
        throw durableMutationError(
            new SafeFilesystemError({
                failureKind: "invalid_path",
                operation,
                targetPath: filePath,
                message: "durable removal requires a file basename",
            }),
            filePath,
            "not_applied",
            operation,
        );
    }

    let parent: OpenedSafeEntry;
    try {
        parent = openAbsolutePathNoFollow(dirname(filePath), "directory", operation);
    } catch (error) {
        throw durableMutationError(error, filePath, "not_applied", operation);
    }

    const name = basename(filePath);
    let removed = false;
    try {
        let opened: OpenedSafeEntry;
        try {
            opened = openChildNoFollow(parent.fd, name, "file", operation, filePath);
        } catch (error) {
            if (error instanceof SafeFilesystemError && error.failureKind === "not_found") {
                return false;
            }
            throw error;
        }
        closeQuietly(opened.fd);
        fs.unlinkSync(descriptorPath(parent.fd, name));
        removed = true;
        fs.fsyncSync(parent.fd);
        try {
            fs.lstatSync(descriptorPath(parent.fd, name));
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation,
                targetPath: filePath,
                message: "durable removal destination was recreated during verification",
            });
        } catch (error) {
            if (errnoCode(error) !== "ENOENT") throw error;
        }
        return true;
    } catch (error) {
        throw durableMutationError(error, filePath, removed ? "may_have_applied" : "not_applied", operation);
    } finally {
        closeQuietly(parent.fd);
    }
}

/**
 * Permanently remove one regular file only after action-time no-follow
 * validation proves that the directory entry still names the caller's
 * expected physical file.
 *
 * This is intentionally narrower than the general durable removal primitive.
 * It exists for owners whose reviewed contract explicitly permits permanent
 * deletion of their own bounded files.
 */
export function permanentlyRemoveRegularFileIfIdentity(filePath: string, expectedIdentity: PhysicalPathIdentity): boolean {
    const operation: SafeFilesystemOperation = "permanent_remove_file";
    assertSelectedFilesystemSupported(operation, filePath);
    assertCanonicalAbsolutePath(filePath, operation);
    if (filePath === "/") {
        throw durableMutationError(
            new SafeFilesystemError({
                failureKind: "invalid_path",
                operation,
                targetPath: filePath,
                message: "permanent removal requires a file basename",
            }),
            filePath,
            "not_applied",
            operation,
        );
    }

    let parent: OpenedSafeEntry;
    try {
        parent = openAbsolutePathNoFollow(dirname(filePath), "directory", operation);
    } catch (error) {
        throw durableMutationError(error, filePath, "not_applied", operation);
    }

    const name = basename(filePath);
    let removed = false;
    try {
        let opened: OpenedSafeEntry;
        try {
            opened = openChildNoFollow(parent.fd, name, "file", operation, filePath);
        } catch (error) {
            if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return false;
            throw error;
        }
        try {
            const actualIdentity = physicalIdentity(opened.stat);
            if (
                actualIdentity.deviceId !== expectedIdentity.deviceId ||
                actualIdentity.fileId !== expectedIdentity.fileId ||
                expectedIdentity.entryKind !== "file"
            ) {
                throw new SafeFilesystemError({
                    failureKind: "stale",
                    operation,
                    targetPath: filePath,
                    message: "permanent removal target does not match the expected physical identity",
                });
            }
            const actionTime = fs.lstatSync(descriptorPath(parent.fd, name), { bigint: true });
            if (!sameIdentity(opened.stat, actionTime)) {
                throw new SafeFilesystemError({
                    failureKind: "stale",
                    operation,
                    targetPath: filePath,
                    message: "permanent removal target changed after identity validation",
                });
            }
            fs.unlinkSync(descriptorPath(parent.fd, name));
            removed = true;
            fs.fsyncSync(parent.fd);
        } finally {
            closeQuietly(opened.fd);
        }
        try {
            fs.lstatSync(descriptorPath(parent.fd, name));
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation,
                targetPath: filePath,
                message: "permanent removal destination was recreated during verification",
            });
        } catch (error) {
            if (errnoCode(error) !== "ENOENT") throw error;
        }
        return true;
    } catch (error) {
        throw durableMutationError(error, filePath, removed ? "may_have_applied" : "not_applied", operation);
    } finally {
        closeQuietly(parent.fd);
    }
}

/**
 * Atomically publish one already-durable directory into an existing trusted
 * parent without following any source/target path segment. The caller owns
 * staged-tree fsync; this primitive owns descriptor-bound rename, both parent
 * fsyncs, and no-follow destination verification.
 */
export function durablePublishDirectory(
    stagedDirectoryPath: string,
    targetParentPath: string,
    targetName: string,
): PhysicalPathIdentity {
    return durablePublishEntry(stagedDirectoryPath, targetParentPath, targetName, "directory");
}

export function durablePublishRegularFile(
    sourcePath: string,
    targetParentPath: string,
    targetName: string,
): PhysicalPathIdentity {
    return durablePublishEntry(sourcePath, targetParentPath, targetName, "file");
}

function durablePublishEntry(
    stagedDirectoryPath: string,
    targetParentPath: string,
    targetName: string,
    kind: "file" | "directory",
): PhysicalPathIdentity {
    const operation: SafeFilesystemOperation = kind === "directory" ? "durable_publish_directory" : "durable_publish_file";
    assertSelectedFilesystemSupported(operation, targetParentPath);
    assertCanonicalAbsolutePath(stagedDirectoryPath, operation);
    assertCanonicalAbsolutePath(targetParentPath, operation);
    if (
        targetName.length === 0 ||
        targetName === "." ||
        targetName === ".." ||
        targetName.includes("/") ||
        targetName.includes("\\") ||
        targetName.includes("\0")
    ) {
        throw durableMutationError(
            new SafeFilesystemError({
                failureKind: "invalid_path",
                operation,
                targetPath: targetParentPath,
                message: "directory publication targetName must be one safe path segment",
            }),
            join(targetParentPath, targetName),
            "not_applied",
            operation,
        );
    }

    const sourceParentPath = dirname(stagedDirectoryPath);
    const sourceName = basename(stagedDirectoryPath);
    const targetPath = join(targetParentPath, targetName);
    let sourceParent: OpenedSafeEntry | null = null;
    let targetParent: OpenedSafeEntry | null = null;
    let renamed = false;
    try {
        sourceParent = openAbsolutePathNoFollow(sourceParentPath, "directory", operation);
        targetParent = openAbsolutePathNoFollow(targetParentPath, "directory", operation);
        const source = openChildNoFollow(sourceParent.fd, sourceName, kind, operation, stagedDirectoryPath);
        closeQuietly(source.fd);
        try {
            fs.lstatSync(descriptorPath(targetParent.fd, targetName));
            throw new SafeFilesystemError({
                failureKind: "io_error",
                operation,
                targetPath,
                message: "directory publication target already exists",
            });
        } catch (error) {
            if (errnoCode(error) !== "ENOENT") throw error;
        }

        invokeLinuxEntryPublication(
            {
                sourcePath: stagedDirectoryPath,
                destinationPath: targetPath,
                sourceIdentity: physicalIdentity(source.stat),
                sourceParentIdentity: physicalIdentity(sourceParent.stat),
                destinationParentIdentity: physicalIdentity(targetParent.stat),
            },
            readRegularFileNoFollow,
        );
        renamed = true;
        fs.fsyncSync(sourceParent.fd);
        fs.fsyncSync(targetParent.fd);
        const published = openChildNoFollow(targetParent.fd, targetName, kind, operation, targetPath);
        try {
            if (!sameIdentity(source.stat, published.stat)) {
                throw new SafeFilesystemError({
                    failureKind: "stale",
                    operation,
                    targetPath,
                    message: "directory publication source identity changed before rename",
                });
            }
            return physicalIdentity(published.stat);
        } finally {
            closeQuietly(published.fd);
        }
    } catch (error) {
        if (error instanceof DurableFilesystemMutationError) throw error;
        throw durableMutationError(error, targetPath, renamed ? "may_have_applied" : "not_applied", operation);
    } finally {
        if (sourceParent !== null) closeQuietly(sourceParent.fd);
        if (targetParent !== null) closeQuietly(targetParent.fd);
    }
}
