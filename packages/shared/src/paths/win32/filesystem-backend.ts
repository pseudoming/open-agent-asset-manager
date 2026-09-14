import * as fs from "node:fs";
import { observeDirectoryMembersBounded } from "../directory-member-observation";
import { samePhysicalPathIdentity } from "../../filesystem/filesystem-facts";
import {
    type BoundedDirectoryEntry,
    DurableFilesystemMutationError,
    type FilesystemCapacity,
    type PhysicalPathIdentity,
    SafeFilesystemError,
    type SafeFilesystemOperation,
    type StableDirectoryInventory,
    type StableRegularFileRangeRead,
    type StableRegularFileRead,
} from "../../filesystem/filesystem-types";
import type { PhysicalFilesystemBackend } from "../../filesystem/physical-filesystem-backend";
import { readRegularFileBatchSequentially, validateRegularFileReadBatch } from "../../filesystem/regular-file-read-batch";
import { captureCommittedSqliteSnapshot } from "../committed-sqlite-snapshot";
import { loadWin32NativeFilesystemAddon, type Win32NativeFilesystemAddon } from "./native-addon";
import { invokeWin32RecycleWorkerBounded, type Win32RecycleWorker } from "./recycle-bin-worker-client";
import { isAnyWslPath } from "./selected-wsl-helper-paths";

type NativeLoader = () => Win32NativeFilesystemAddon;

const MAXIMUM_WINDOWS_DIRECTORY_ENTRIES = 0xffff_ffff;

function boundedCapacity(value: bigint): number {
    return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

function requireLimit(value: number, label: string, operation: SafeFilesystemOperation, targetPath: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new SafeFilesystemError({
            failureKind: "resource_limit",
            operation,
            targetPath,
            systemCode: "INVALID_LIMIT",
            message: `${label} must be a non-negative safe integer`,
        });
    }
    return value;
}

function unsupportedTargetMutation(operation: SafeFilesystemOperation, targetPath: string): never {
    throw new SafeFilesystemError({
        failureKind: "unsupported_platform",
        operation,
        targetPath,
        systemCode: "WINDOWS_RUNTIME_TARGET_MUTATION_NOT_ACTIVATED",
        message: `${operation} remains blocked for this Windows runtime-target build`,
    });
}

function unsupportedVolatileDirectoryObservation(directoryPath: string): never {
    throw new SafeFilesystemError({
        failureKind: "unsupported_platform",
        operation: "inventory_directory",
        targetPath: directoryPath,
        systemCode: "VOLATILE_DIRECTORY_OBSERVATION_NOT_REVIEWED",
        message: "volatile directory observation is not reviewed for this Windows Shared target",
    });
}

function preflightRecycleIdentity(
    operation: SafeFilesystemOperation,
    targetPath: string,
    inspect: () => PhysicalPathIdentity,
): PhysicalPathIdentity | null {
    try {
        return inspect();
    } catch (error) {
        if (!(error instanceof SafeFilesystemError)) throw error;
        if (error.failureKind === "not_found") return null;
        throw new DurableFilesystemMutationError({
            operation,
            failureKind: error.failureKind,
            targetPath,
            systemCode: error.systemCode,
            message: error.message,
            mutationState: "not_applied",
        });
    }
}

export function createWin32PhysicalFilesystemBackend(
    loadNative: NativeLoader = loadWin32NativeFilesystemAddon,
    recycleWorker: Win32RecycleWorker = invokeWin32RecycleWorkerBounded,
): PhysicalFilesystemBackend {
    let native: Win32NativeFilesystemAddon | null = null;
    const getNative = (): Win32NativeFilesystemAddon => {
        native ??= loadNative();
        return native;
    };
    const rejectDirectWslRead = (filePath: string): void => {
        if (isAnyWslPath(filePath)) {
            throw new SafeFilesystemError({
                failureKind: "unsupported_platform",
                operation: "read_regular_file",
                targetPath: filePath,
                systemCode: "WSL_READ_REQUIRES_LINUX_EXECUTION",
                message: "selected WSL files must be read in their Linux execution context",
            });
        }
    };
    const rejectDirectWslMutation = (operation: SafeFilesystemOperation, targetPath: string): void => {
        if (isAnyWslPath(targetPath)) unsupportedTargetMutation(operation, targetPath);
    };
    const readRegularFileNoFollow = (filePath: string, maximumBytes = Number.MAX_SAFE_INTEGER): StableRegularFileRead => {
        const limit = requireLimit(maximumBytes, "maximumBytes", "read_regular_file", filePath);
        rejectDirectWslRead(filePath);
        return getNative().readRegularFile(filePath, limit);
    };
    const readRegularFileRangeNoFollow = (
        filePath: string,
        byteOffset: number,
        maximumBytes: number,
    ): StableRegularFileRangeRead => {
        const offset = requireLimit(byteOffset, "byteOffset", "read_regular_file", filePath);
        const limit = requireLimit(maximumBytes, "maximumBytes", "read_regular_file", filePath);
        if (limit === 0) {
            throw new SafeFilesystemError({
                failureKind: "resource_limit",
                operation: "read_regular_file",
                targetPath: filePath,
                systemCode: "INVALID_LIMIT",
                message: "maximumBytes must be a positive safe integer",
            });
        }
        rejectDirectWslRead(filePath);
        return getNative().readRegularFileRange(filePath, offset, limit);
    };
    const inventoryDirectoryNoFollow = (
        directoryPath: string,
        maximumEntries = MAXIMUM_WINDOWS_DIRECTORY_ENTRIES,
    ): StableDirectoryInventory => {
        const limit = requireLimit(maximumEntries, "maximumEntries", "inventory_directory", directoryPath);
        return getNative().inventoryDirectory(directoryPath, limit);
    };

    const backend: PhysicalFilesystemBackend = {
        readRegularFileNoFollow,
        readRegularFilesNoFollow(inputs, maximumTotalBytes) {
            const request = validateRegularFileReadBatch(inputs, maximumTotalBytes);
            if (request.length === 0) return [];
            return readRegularFileBatchSequentially(request, maximumTotalBytes, readRegularFileNoFollow);
        },
        readRegularFileRangeNoFollow,
        inspectRegularFileNoFollow(filePath) {
            return getNative().inspectRegularFile(filePath);
        },
        inspectDirectoryNoFollow(directoryPath) {
            return getNative().inspectDirectory(directoryPath);
        },
        inspectFilesystemCapacity(directoryPath): FilesystemCapacity {
            const operation = "inspect_filesystem_capacity";
            const before = getNative().confirmDurableDirectory(directoryPath);
            try {
                const capacity = fs.statfsSync(directoryPath, { bigint: true });
                const after = getNative().confirmDurableDirectory(directoryPath);
                if (!samePhysicalPathIdentity(before, after)) {
                    throw new SafeFilesystemError({
                        failureKind: "stale",
                        operation,
                        targetPath: directoryPath,
                        message: "directory identity changed while filesystem capacity was inspected",
                    });
                }
                return {
                    availableBytes: boundedCapacity(capacity.bavail * capacity.bsize),
                    totalBytes: boundedCapacity(capacity.blocks * capacity.bsize),
                };
            } catch (error) {
                if (error instanceof SafeFilesystemError) throw error;
                throw new SafeFilesystemError({
                    failureKind: "io_error",
                    operation,
                    targetPath: directoryPath,
                    systemCode: error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN",
                    message: `filesystem capacity inspection failed: ${String(error)}`,
                });
            }
        },
        inventoryDirectoryNoFollow,
        confirmDurableRegularFileNoFollow(filePath) {
            rejectDirectWslMutation("confirm_durable_file", filePath);
            return getNative().confirmDurableRegularFile(filePath);
        },
        confirmDurableDirectoryNoFollow(directoryPath) {
            rejectDirectWslMutation("confirm_durable_directory", directoryPath);
            return getNative().confirmDurableDirectory(directoryPath);
        },
        confirmDurableDirectoryTreeNoFollow(directoryPath, maximumEntries = MAXIMUM_WINDOWS_DIRECTORY_ENTRIES) {
            const limit = requireLimit(maximumEntries, "maximumEntries", "confirm_durable_tree", directoryPath);
            rejectDirectWslMutation("confirm_durable_tree", directoryPath);
            return getNative().confirmDurableDirectoryTree(directoryPath, limit);
        },
        durableEnsureDirectory(parentPath, childName) {
            rejectDirectWslMutation("durable_ensure_directory", parentPath);
            return getNative().ensureDirectory(parentPath, childName);
        },
        durableCreateFile(filePath, data, executable) {
            if (executable !== undefined) backend.assertExecutableStateSupported(filePath, executable);
            rejectDirectWslMutation("durable_create_file", filePath);
            return getNative().createFile(filePath, data);
        },
        durableReplaceFile(filePath, data, executable) {
            if (executable !== undefined) backend.assertExecutableStateSupported(filePath, executable);
            if (isAnyWslPath(filePath)) unsupportedTargetMutation("durable_replace_file", filePath);
            return getNative().replaceFile(filePath, data);
        },
        durableOverwriteFile(filePath, data, executable) {
            if (executable !== undefined) backend.assertExecutableStateSupported(filePath, executable);
            if (isAnyWslPath(filePath)) unsupportedTargetMutation("durable_replace_file", filePath);
            return getNative().replaceFile(filePath, data);
        },
        durableRemoveRegularFile(filePath) {
            if (isAnyWslPath(filePath)) unsupportedTargetMutation("durable_remove_file", filePath);
            const native = getNative();
            const expectedIdentity = preflightRecycleIdentity("durable_remove_file", filePath, () =>
                native.inspectRegularFile(filePath),
            );
            if (expectedIdentity === null) return false;
            return recycleWorker(native, { targetPath: filePath, expectedIdentity, maximumEntries: 0 });
        },
        permanentlyRemoveRegularFileIfIdentity(filePath, expectedIdentity) {
            rejectDirectWslMutation("permanent_remove_file", filePath);
            return getNative().permanentlyRemoveRegularFileIfIdentity(filePath, expectedIdentity);
        },
        durableRecycleRegularFileIfIdentity(filePath, expectedIdentity) {
            rejectDirectWslMutation("durable_remove_file", filePath);
            return recycleWorker(getNative(), { targetPath: filePath, expectedIdentity, maximumEntries: 0 });
        },
        durableRemoveDirectoryTree(directoryPath, maximumEntries = MAXIMUM_WINDOWS_DIRECTORY_ENTRIES) {
            rejectDirectWslMutation("durable_remove_tree", directoryPath);
            const limit = requireLimit(maximumEntries, "maximumEntries", "durable_remove_tree", directoryPath);
            const native = getNative();
            const expectedIdentity = preflightRecycleIdentity("durable_remove_tree", directoryPath, () =>
                native.confirmDurableDirectoryTree(directoryPath, limit),
            );
            if (expectedIdentity === null) return false;
            return recycleWorker(native, { targetPath: directoryPath, expectedIdentity, maximumEntries: limit });
        },
        assertDirectoryTreeRecycleSupported() {
            // Target selection proves this backend has the reviewed native Recycle Bin contract.
        },
        durableRecycleDirectoryTreeIfIdentity(
            directoryPath,
            expectedIdentity,
            maximumEntries = MAXIMUM_WINDOWS_DIRECTORY_ENTRIES,
        ) {
            rejectDirectWslMutation("durable_remove_tree", directoryPath);
            const limit = requireLimit(maximumEntries, "maximumEntries", "durable_remove_tree", directoryPath);
            return recycleWorker(getNative(), { targetPath: directoryPath, expectedIdentity, maximumEntries: limit });
        },
        durablePublishRegularFile(sourcePath, targetParentPath, targetName) {
            rejectDirectWslMutation("durable_publish_file", sourcePath);
            rejectDirectWslMutation("durable_publish_file", targetParentPath);
            return getNative().publishFile(sourcePath, targetParentPath, targetName);
        },
        directoriesShareFilesystem(firstPath, secondPath) {
            rejectDirectWslMutation("inspect_directory", firstPath);
            rejectDirectWslMutation("inspect_directory", secondPath);
            return getNative().inspectDirectory(firstPath).deviceId === getNative().inspectDirectory(secondPath).deviceId;
        },
        durablePublishDirectory(stagedDirectoryPath, targetParentPath, targetName) {
            rejectDirectWslMutation("durable_publish_directory", stagedDirectoryPath);
            rejectDirectWslMutation("durable_publish_directory", targetParentPath);
            return getNative().publishDirectory(
                stagedDirectoryPath,
                targetParentPath,
                targetName,
                MAXIMUM_WINDOWS_DIRECTORY_ENTRIES,
            );
        },
        readCommittedSqliteSnapshot(filePath, overrides) {
            return captureCommittedSqliteSnapshot(filePath, backend.readRegularFileBounded, overrides);
        },
        readRegularFileBounded(filePath, maximumBytes) {
            return readRegularFileNoFollow(filePath, maximumBytes).bytes;
        },
        observeDirectoryMembersBounded,
        readDirectoryEntriesBounded(directoryPath, maximumEntries): BoundedDirectoryEntry[] {
            return inventoryDirectoryNoFollow(directoryPath, maximumEntries).entries.map((entry) => ({
                name: entry.relativeName,
                entryKind: entry.identity.entryKind,
            }));
        },
        readVolatileDirectoryEntriesBounded(directoryPath) {
            return unsupportedVolatileDirectoryObservation(directoryPath);
        },
        atomicWriteFile(filePath) {
            return unsupportedTargetMutation("atomic_write_file", filePath);
        },
        lockFile(lockPath) {
            return getNative().acquireLock(lockPath);
        },
        assertExecutableStateSupported(filePath, executable) {
            if (isAnyWslPath(filePath)) unsupportedTargetMutation("chmod_file", filePath);
            if (executable) unsupportedTargetMutation("chmod_file", filePath);
        },
        chmodIfDifferent(filePath, executable) {
            backend.assertExecutableStateSupported(filePath, executable);
            return false;
        },
    };
    return Object.freeze(backend);
}

export const win32PhysicalFilesystemBackend = createWin32PhysicalFilesystemBackend();
