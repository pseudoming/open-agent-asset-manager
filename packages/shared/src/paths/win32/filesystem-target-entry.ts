import type { PhysicalFilesystemBackend } from "../../filesystem/physical-filesystem-backend";
import { win32PhysicalFilesystemBackend } from "./filesystem-backend";

const selectedPhysicalFilesystemBackend: PhysicalFilesystemBackend = win32PhysicalFilesystemBackend;
export const directoriesShareFilesystem = selectedPhysicalFilesystemBackend.directoriesShareFilesystem;
export const durableOverwriteFile = selectedPhysicalFilesystemBackend.durableOverwriteFile;

export const readCommittedSqliteSnapshot = selectedPhysicalFilesystemBackend.readCommittedSqliteSnapshot;
export {
    CommittedSqliteSnapshotError,
    type CommittedSqliteSnapshotDependencies,
} from "../committed-sqlite-snapshot";

export const readRegularFileNoFollow = selectedPhysicalFilesystemBackend.readRegularFileNoFollow;
export const readRegularFilesNoFollow = selectedPhysicalFilesystemBackend.readRegularFilesNoFollow;
export const readRegularFileRangeNoFollow = selectedPhysicalFilesystemBackend.readRegularFileRangeNoFollow;
export const inspectRegularFileNoFollow = selectedPhysicalFilesystemBackend.inspectRegularFileNoFollow;
export const inspectDirectoryNoFollow = selectedPhysicalFilesystemBackend.inspectDirectoryNoFollow;
export const inspectFilesystemCapacity = selectedPhysicalFilesystemBackend.inspectFilesystemCapacity;
export const inventoryDirectoryNoFollow = selectedPhysicalFilesystemBackend.inventoryDirectoryNoFollow;
export const confirmDurableRegularFileNoFollow = selectedPhysicalFilesystemBackend.confirmDurableRegularFileNoFollow;
export const confirmDurableDirectoryNoFollow = selectedPhysicalFilesystemBackend.confirmDurableDirectoryNoFollow;
export const confirmDurableDirectoryTreeNoFollow = selectedPhysicalFilesystemBackend.confirmDurableDirectoryTreeNoFollow;
export const durableEnsureDirectory = selectedPhysicalFilesystemBackend.durableEnsureDirectory;
export const durableCreateFile = selectedPhysicalFilesystemBackend.durableCreateFile;
export const durableReplaceFile = selectedPhysicalFilesystemBackend.durableReplaceFile;
export const durableRemoveRegularFile = selectedPhysicalFilesystemBackend.durableRemoveRegularFile;
export const permanentlyRemoveRegularFileIfIdentity = selectedPhysicalFilesystemBackend.permanentlyRemoveRegularFileIfIdentity;
export const durableRecycleRegularFileIfIdentity = selectedPhysicalFilesystemBackend.durableRecycleRegularFileIfIdentity;
export const durableRemoveDirectoryTree = selectedPhysicalFilesystemBackend.durableRemoveDirectoryTree;
export const assertDirectoryTreeRecycleSupported = selectedPhysicalFilesystemBackend.assertDirectoryTreeRecycleSupported;
export const durableRecycleDirectoryTreeIfIdentity = selectedPhysicalFilesystemBackend.durableRecycleDirectoryTreeIfIdentity;
export const durablePublishRegularFile = selectedPhysicalFilesystemBackend.durablePublishRegularFile;
export const durablePublishDirectory = selectedPhysicalFilesystemBackend.durablePublishDirectory;
export const readRegularFileBounded = selectedPhysicalFilesystemBackend.readRegularFileBounded;
export const observeDirectoryMembersBounded = selectedPhysicalFilesystemBackend.observeDirectoryMembersBounded;
export const readDirectoryEntriesBounded = selectedPhysicalFilesystemBackend.readDirectoryEntriesBounded;
export const readVolatileDirectoryEntriesBounded = selectedPhysicalFilesystemBackend.readVolatileDirectoryEntriesBounded;
export const atomicWriteFile = selectedPhysicalFilesystemBackend.atomicWriteFile;
export const lockFile = selectedPhysicalFilesystemBackend.lockFile;
export const assertExecutableStateSupported = selectedPhysicalFilesystemBackend.assertExecutableStateSupported;
export const chmodIfDifferent = selectedPhysicalFilesystemBackend.chmodIfDifferent;
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
