import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import {
    SafeFilesystemError,
    type PhysicalPathIdentity,
    type SafeFilesystemOperation,
    type StableDirectoryInventory,
} from "../../filesystem/filesystem-types";
import {
    filesystemEntryKind as entryKind,
    filesystemSystemCode as errnoCode,
    sameFilesystemIdentity as sameIdentity,
    toSafeFilesystemError as safeError,
} from "../../filesystem/filesystem-facts";
import {
    assertCanonicalAbsolutePath,
    assertSelectedFilesystemSupported,
    closeQuietly,
    descriptorPath,
    durableMutationError,
    inspectChildWithoutFollowing,
    openAbsolutePathNoFollow,
    openChildNoFollow,
    type OpenedSafeEntry,
} from "./descriptor-filesystem";
import {
    confirmDurableDirectoryNoFollow,
    confirmDurableRegularFileNoFollow,
    inventoryDirectoryNoFollow,
    readOpenedDirectoryNamesBounded,
} from "./safe-filesystem";

function requireTreeEntryLimit(maximumEntries: number, operation: SafeFilesystemOperation, targetPath: string): number {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
        throw new SafeFilesystemError({
            failureKind: "resource_limit",
            operation,
            targetPath,
            systemCode: "INVALID_LIMIT",
            message: "maximumEntries must be a non-negative safe integer",
        });
    }
    return maximumEntries;
}

function sameDirectoryInventory(left: StableDirectoryInventory, right: StableDirectoryInventory): boolean {
    return (
        left.identity.deviceId === right.identity.deviceId &&
        left.identity.fileId === right.identity.fileId &&
        left.entries.length === right.entries.length &&
        left.entries.every((entry, index) => {
            const other = right.entries[index];
            return (
                other !== undefined &&
                entry.relativeName === other.relativeName &&
                entry.identity.deviceId === other.identity.deviceId &&
                entry.identity.fileId === other.identity.fileId &&
                entry.identity.entryKind === other.identity.entryKind
            );
        })
    );
}

function confirmDurableDirectoryTreeRecursive(directoryPath: string, budget: { remaining: number }): PhysicalPathIdentity {
    const before = inventoryDirectoryNoFollow(directoryPath, budget.remaining);
    for (const entry of before.entries) {
        if (budget.remaining === 0) {
            throw new SafeFilesystemError({
                failureKind: "resource_limit",
                operation: "confirm_durable_tree",
                targetPath: directoryPath,
                systemCode: "TREE_ENTRY_LIMIT_EXCEEDED",
                message: "directory tree exceeds the caller's bounded-entry limit",
            });
        }
        budget.remaining -= 1;
        const childPath = join(directoryPath, entry.relativeName);
        if (entry.identity.entryKind === "directory") {
            confirmDurableDirectoryTreeRecursive(childPath, budget);
        } else {
            confirmDurableRegularFileNoFollow(childPath);
        }
    }

    const identity = confirmDurableDirectoryNoFollow(directoryPath);
    const after = inventoryDirectoryNoFollow(directoryPath, before.entries.length);
    if (!sameDirectoryInventory(before, after)) {
        throw new SafeFilesystemError({
            failureKind: "stale",
            operation: "confirm_durable_tree",
            targetPath: directoryPath,
            systemCode: "TREE_CHANGED",
            message: "directory tree changed during durability confirmation",
        });
    }
    return identity;
}

export function confirmDurableDirectoryTreeNoFollow(
    directoryPath: string,
    maximumEntries = Number.MAX_SAFE_INTEGER,
): PhysicalPathIdentity {
    const operation: SafeFilesystemOperation = "confirm_durable_tree";
    requireTreeEntryLimit(maximumEntries, operation, directoryPath);
    try {
        return confirmDurableDirectoryTreeRecursive(directoryPath, {
            remaining: maximumEntries,
        });
    } catch (error) {
        const source = safeError(error, operation, directoryPath);
        throw new SafeFilesystemError({
            failureKind: source.failureKind,
            operation,
            targetPath: source.targetPath,
            systemCode: source.systemCode,
            message: source.message,
        });
    }
}

function removeDirectoryContentsNoFollow(opened: OpenedSafeEntry, directoryPath: string, budget: { remaining: number }): void {
    const operation: SafeFilesystemOperation = "durable_remove_tree";
    const entries = readOpenedDirectoryNamesBounded(opened, budget.remaining, directoryPath);

    for (const relativeName of entries) {
        if (budget.remaining === 0) {
            throw new SafeFilesystemError({
                failureKind: "resource_limit",
                operation,
                targetPath: directoryPath,
                systemCode: "TREE_ENTRY_LIMIT_EXCEEDED",
                message: "directory tree exceeds the caller's bounded-entry limit",
            });
        }
        budget.remaining -= 1;
        const childPath = join(directoryPath, relativeName);
        const before = inspectChildWithoutFollowing(opened.fd, relativeName, operation, childPath);
        const kind = entryKind(before);
        if (kind === null) {
            throw new SafeFilesystemError({
                failureKind: "wrong_entry_type",
                operation,
                targetPath: childPath,
                message: "directory-tree removal accepts only regular files and directories",
            });
        }

        const child = openChildNoFollow(opened.fd, relativeName, kind, operation, childPath);
        try {
            if (!sameIdentity(before, child.stat)) {
                throw new SafeFilesystemError({
                    failureKind: "stale",
                    operation,
                    targetPath: childPath,
                    message: "directory-tree child identity changed before removal",
                });
            }
            if (kind === "directory") {
                removeDirectoryContentsNoFollow(child, childPath, budget);
            }
        } finally {
            closeQuietly(child.fd);
        }

        const immediatelyBeforeRemoval = inspectChildWithoutFollowing(opened.fd, relativeName, operation, childPath);
        if (!sameIdentity(before, immediatelyBeforeRemoval)) {
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation,
                targetPath: childPath,
                message: "directory-tree child identity changed at removal time",
            });
        }
        if (kind === "directory") {
            fs.rmdirSync(descriptorPath(opened.fd, relativeName));
        } else {
            fs.unlinkSync(descriptorPath(opened.fd, relativeName));
        }
    }
    fs.fsyncSync(opened.fd);
}

export function durableRemoveDirectoryTree(directoryPath: string, maximumEntries = Number.MAX_SAFE_INTEGER): boolean {
    const operation: SafeFilesystemOperation = "durable_remove_tree";
    assertSelectedFilesystemSupported(operation, directoryPath);
    assertCanonicalAbsolutePath(directoryPath, operation);
    requireTreeEntryLimit(maximumEntries, operation, directoryPath);
    if (directoryPath === "/") {
        throw durableMutationError(
            new SafeFilesystemError({
                failureKind: "invalid_path",
                operation,
                targetPath: directoryPath,
                message: "directory-tree removal requires a non-root path",
            }),
            directoryPath,
            "not_applied",
            operation,
        );
    }

    try {
        confirmDurableDirectoryTreeNoFollow(directoryPath, maximumEntries);
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") {
            return false;
        }
        throw durableMutationError(error, directoryPath, "not_applied", operation);
    }

    const parentPath = dirname(directoryPath);
    const name = basename(directoryPath);
    const stagedName = `.oaam-recycle-${crypto.randomBytes(16).toString("hex")}`;
    let parent: OpenedSafeEntry;
    try {
        parent = openAbsolutePathNoFollow(parentPath, "directory", operation);
    } catch (error) {
        throw durableMutationError(error, directoryPath, "not_applied", operation);
    }

    let staged = false;
    let stagedRoot: OpenedSafeEntry | null = null;
    try {
        const source = openChildNoFollow(parent.fd, name, "directory", operation, directoryPath);
        stagedRoot = source;
        const sourceIdentity = source.stat;
        try {
            fs.lstatSync(descriptorPath(parent.fd, stagedName));
            throw new SafeFilesystemError({
                failureKind: "io_error",
                operation,
                targetPath: directoryPath,
                systemCode: "RECYCLE_STAGE_EXISTS",
                message: "private recycle staging path already exists",
            });
        } catch (error) {
            if (errnoCode(error) !== "ENOENT") {
                throw error;
            }
        }

        fs.renameSync(descriptorPath(parent.fd, name), descriptorPath(parent.fd, stagedName));
        staged = true;
        fs.fsyncSync(parent.fd);
        const stagedPath = join(parentPath, stagedName);
        removeDirectoryContentsNoFollow(stagedRoot, stagedPath, {
            remaining: maximumEntries,
        });
        const immediatelyBeforeRemoval = inspectChildWithoutFollowing(parent.fd, stagedName, operation, stagedPath);
        if (!sameIdentity(sourceIdentity, immediatelyBeforeRemoval)) {
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation,
                targetPath: stagedPath,
                message: "staged directory identity changed before final removal",
            });
        }
        closeQuietly(stagedRoot.fd);
        stagedRoot = null;
        fs.rmdirSync(descriptorPath(parent.fd, stagedName));
        fs.fsyncSync(parent.fd);
        try {
            fs.lstatSync(descriptorPath(parent.fd, stagedName));
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation,
                targetPath: stagedPath,
                message: "staged directory was recreated during removal verification",
            });
        } catch (error) {
            if (errnoCode(error) !== "ENOENT") throw error;
        }
        return true;
    } catch (error) {
        throw durableMutationError(error, directoryPath, staged ? "may_have_applied" : "not_applied", operation);
    } finally {
        if (stagedRoot !== null) closeQuietly(stagedRoot.fd);
        closeQuietly(parent.fd);
    }
}
