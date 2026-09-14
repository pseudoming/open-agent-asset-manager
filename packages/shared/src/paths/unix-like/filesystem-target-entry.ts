import { type PhysicalPathIdentity, SafeFilesystemError } from "../../filesystem/filesystem-types";
import type { PhysicalFilesystemBackend } from "../../filesystem/physical-filesystem-backend";
import { captureCommittedSqliteSnapshot, type CommittedSqliteSnapshotDependencies } from "../committed-sqlite-snapshot";
import { readRegularFileBatchSequentially, type BoundedRegularFileReadInput } from "../../filesystem/regular-file-read-batch";
import { readRegularFileBounded } from "./bounded-io";
import { observeDirectoryMembersBounded } from "../directory-member-observation";
const readDirectoryEntriesBounded = observeDirectoryMembersBounded;
import { confirmDurableDirectoryTreeNoFollow, durableRemoveDirectoryTree } from "./directory-tree-filesystem";
import { assertExecutableStateSupported, atomicWriteFile, chmodIfDifferent, lockFile } from "./filesystem-mechanics";
import {
    confirmDurableDirectoryNoFollow,
    confirmDurableRegularFileNoFollow,
    durableCreateFile,
    durableEnsureDirectory,
    durablePublishDirectory,
    durablePublishRegularFile,
    durableRemoveRegularFile,
    durableReplaceFile,
    inspectDirectoryNoFollow,
    inspectFilesystemCapacity,
    inspectRegularFileNoFollow,
    inventoryDirectoryNoFollow,
    permanentlyRemoveRegularFileIfIdentity,
    readRegularFileNoFollow,
    readRegularFileRangeNoFollow,
    readVolatileDirectoryEntriesBounded,
} from "./safe-filesystem";

function readRegularFilesNoFollow(inputs: readonly BoundedRegularFileReadInput[], maximumTotalBytes: number) {
    return readRegularFileBatchSequentially(inputs, maximumTotalBytes, readRegularFileNoFollow);
}
function directoriesShareFilesystem(firstPath: string, secondPath: string): boolean {
    return inspectDirectoryNoFollow(firstPath).deviceId === inspectDirectoryNoFollow(secondPath).deviceId;
}
const durableOverwriteFile = durableReplaceFile;

export function readCommittedSqliteSnapshot(
    filePath: string,
    overrides: Partial<CommittedSqliteSnapshotDependencies> = {},
): Buffer {
    return captureCommittedSqliteSnapshot(filePath, readRegularFileBounded, overrides);
}
export {
    CommittedSqliteSnapshotError,
    type CommittedSqliteSnapshotDependencies,
} from "../committed-sqlite-snapshot";

function durableRecycleRegularFileIfIdentity(filePath: string, _expectedIdentity: PhysicalPathIdentity): never {
    throw new SafeFilesystemError({
        failureKind: "unsupported_platform",
        operation: "durable_remove_file",
        targetPath: filePath,
        systemCode: "IDENTITY_BOUND_TRASH_NOT_AVAILABLE",
        message: "identity-bound Trash is not available in this Unix-like Shared target",
    });
}

function assertDirectoryTreeRecycleSupported(directoryPath: string): never {
    throw new SafeFilesystemError({
        failureKind: "unsupported_platform",
        operation: "durable_remove_tree",
        targetPath: directoryPath,
        systemCode: "IDENTITY_BOUND_TRASH_NOT_AVAILABLE",
        message: "identity-bound Trash is not available in this Unix-like Shared target",
    });
}

function durableRecycleDirectoryTreeIfIdentity(
    directoryPath: string,
    _expectedIdentity: PhysicalPathIdentity,
    _maximumEntries = Number.MAX_SAFE_INTEGER,
): never {
    return assertDirectoryTreeRecycleSupported(directoryPath);
}

/**
 * Complete public physical-filesystem surface for the Unix-like build.
 *
 * The package manifest selects this module at build time. The local object
 * keeps interface completeness next to the implementation without adding a
 * second aggregation module.
 */
const unixLikePhysicalFilesystemBackend = Object.freeze({
    readCommittedSqliteSnapshot,
    readRegularFileNoFollow,
    readRegularFilesNoFollow,
    readRegularFileRangeNoFollow,
    inspectRegularFileNoFollow,
    inspectDirectoryNoFollow,
    inspectFilesystemCapacity,
    inventoryDirectoryNoFollow,
    directoriesShareFilesystem,
    durableOverwriteFile,
    confirmDurableRegularFileNoFollow,
    confirmDurableDirectoryNoFollow,
    confirmDurableDirectoryTreeNoFollow,
    durableEnsureDirectory,
    durableCreateFile,
    durableReplaceFile,
    durableRemoveRegularFile,
    permanentlyRemoveRegularFileIfIdentity,
    durableRecycleRegularFileIfIdentity,
    durableRemoveDirectoryTree,
    assertDirectoryTreeRecycleSupported,
    durableRecycleDirectoryTreeIfIdentity,
    durablePublishDirectory,
    durablePublishRegularFile,
    readRegularFileBounded,
    readDirectoryEntriesBounded,
    observeDirectoryMembersBounded,
    readVolatileDirectoryEntriesBounded,
    atomicWriteFile,
    lockFile,
    assertExecutableStateSupported,
    chmodIfDifferent,
}) satisfies PhysicalFilesystemBackend;

export {
    directoriesShareFilesystem,
    durableOverwriteFile,
    assertDirectoryTreeRecycleSupported,
    assertExecutableStateSupported,
    atomicWriteFile,
    chmodIfDifferent,
    confirmDurableDirectoryNoFollow,
    confirmDurableDirectoryTreeNoFollow,
    confirmDurableRegularFileNoFollow,
    durableCreateFile,
    durableEnsureDirectory,
    durablePublishDirectory,
    durablePublishRegularFile,
    durableRecycleDirectoryTreeIfIdentity,
    durableRecycleRegularFileIfIdentity,
    durableRemoveDirectoryTree,
    durableRemoveRegularFile,
    durableReplaceFile,
    inspectDirectoryNoFollow,
    inspectFilesystemCapacity,
    inspectRegularFileNoFollow,
    inventoryDirectoryNoFollow,
    lockFile,
    permanentlyRemoveRegularFileIfIdentity,
    readDirectoryEntriesBounded,
    observeDirectoryMembersBounded,
    readRegularFileBounded,
    readRegularFileNoFollow,
    readRegularFilesNoFollow,
    readRegularFileRangeNoFollow,
    readVolatileDirectoryEntriesBounded,
};

void unixLikePhysicalFilesystemBackend;

export type {
    FilesystemFailureInspection,
    FilesystemFailureSource,
} from "../../filesystem/filesystem-facts";
export { inspectFilesystemFailure, samePhysicalPathIdentity } from "../../filesystem/filesystem-facts";
export type {
    BoundedDirectoryEntry,
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
export {
    DurableFilesystemMutationError,
    SafeFilesystemError,
} from "../../filesystem/filesystem-types";

export type { PhysicalFilesystemBackend } from "../../filesystem/physical-filesystem-backend";
export type { BoundedRegularFileReadInput } from "../../filesystem/regular-file-read-batch";
