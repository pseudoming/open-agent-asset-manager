import * as fs from "node:fs";
import { SafeFilesystemError, type BoundedDirectoryEntry, type SafeFilesystemOperation } from "../filesystem/filesystem-types";
import {
    sameFilesystemStableSample as sameStableSample,
    toSafeFilesystemError as safeError,
} from "../filesystem/filesystem-facts";

function assertLimit(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(label + " must be a non-negative safe integer");
}
function resourceLimit(operation: SafeFilesystemOperation, targetPath: string, message: string): SafeFilesystemError {
    return new SafeFilesystemError({ failureKind: "resource_limit", operation, targetPath, message });
}
function stale(operation: SafeFilesystemOperation, targetPath: string, message: string): SafeFilesystemError {
    return new SafeFilesystemError({ failureKind: "stale", operation, targetPath, message });
}
type BigIntStats = fs.BigIntStats;

/**
 * Bounded one-level name/kind observation. Rejects a link at the observed root
 * and rechecks its metadata; children are never opened or followed. This is
 * not a descriptor-bound inventory or a content-integrity snapshot.
 */
export function observeDirectoryMembersBounded(directoryPath: string, maximumEntries: number): BoundedDirectoryEntry[] {
    const operation: SafeFilesystemOperation = "inventory_directory";
    assertLimit(maximumEntries, "maximumEntries");
    let before: BigIntStats;
    try {
        before = fs.lstatSync(directoryPath, { bigint: true });
        if (before.isSymbolicLink()) {
            throw new SafeFilesystemError({
                failureKind: "symlink_or_reparse",
                operation,
                targetPath: directoryPath,
                message: "bounded directory enumeration rejected a symbolic link",
            });
        }
        if (!before.isDirectory()) {
            throw new SafeFilesystemError({
                failureKind: "wrong_entry_type",
                operation,
                targetPath: directoryPath,
                message: "bounded directory enumeration expected a directory",
            });
        }
    } catch (error) {
        throw safeError(error, operation, directoryPath);
    }

    try {
        const entries = readOpenedDirectoryEntriesBounded(directoryPath, maximumEntries, directoryPath);
        const after = fs.lstatSync(directoryPath, { bigint: true });
        if (after.isSymbolicLink() || !sameStableSample(before, after)) {
            throw stale(operation, directoryPath, "bounded directory changed while it was being enumerated");
        }
        return entries;
    } catch (error) {
        throw safeError(error, operation, directoryPath);
    }
}

/**
 * Enumerate a path that already denotes a caller-bound directory handle, such
 * as Linux `/proc/self/fd/<fd>`. This direct-module helper deliberately omits
 * path ownership checks; only the selected safe-filesystem implementation may
 * supply descriptor paths.
 */
export function readOpenedDirectoryEntriesBounded(
    openedDirectoryPath: string,
    maximumEntries: number,
    diagnosticPath: string,
): BoundedDirectoryEntry[] {
    const operation: SafeFilesystemOperation = "inventory_directory";
    assertLimit(maximumEntries, "maximumEntries");
    let directory: fs.Dir;
    try {
        directory = fs.opendirSync(openedDirectoryPath);
    } catch (error) {
        throw safeError(error, operation, diagnosticPath);
    }

    const entries: BoundedDirectoryEntry[] = [];
    let failure: SafeFilesystemError | null = null;
    try {
        while (true) {
            const entry = directory.readSync();
            if (entry === null) break;
            if (entries.length === maximumEntries) {
                throw resourceLimit(operation, diagnosticPath, "directory exceeds the caller's bounded-inventory entry limit");
            }
            entries.push({
                name: entry.name,
                entryKind: entry.isSymbolicLink()
                    ? "other"
                    : entry.isFile()
                      ? "file"
                      : entry.isDirectory()
                        ? "directory"
                        : "other",
            });
        }
    } catch (error) {
        failure = safeError(error, operation, diagnosticPath);
    } finally {
        try {
            directory.closeSync();
        } catch (error) {
            // Preserve the primary failure while still reporting a failed successful-read close.
            failure ??= safeError(error, operation, diagnosticPath);
        }
    }
    if (failure !== null) throw failure;
    return entries;
}
