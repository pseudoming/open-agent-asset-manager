import type {
    BoundedDirectoryEntry,
    EnsuredDirectory,
    FilesystemCapacity,
    PhysicalPathIdentity,
    StableDirectoryInventory,
    StableRegularFileRangeRead,
    StableRegularFileRead,
} from "./filesystem-types";
import type { BoundedRegularFileReadInput } from "./regular-file-read-batch";
import type { CommittedSqliteSnapshotDependencies } from "../paths/committed-sqlite-snapshot";

/**
 * Complete physical-filesystem implementation selected by the product build.
 *
 * The contract contains no optional operations. A target that cannot provide
 * one operation must supply an explicit typed failure implementation; it may
 * not omit the function, return a fake success, or select another platform at
 * runtime.
 */
export interface PhysicalFilesystemBackend {
    readonly readCommittedSqliteSnapshot: (filePath: string, overrides?: Partial<CommittedSqliteSnapshotDependencies>) => Buffer;
    readonly readRegularFileNoFollow: (filePath: string, maximumBytes?: number) => StableRegularFileRead;
    readonly readRegularFilesNoFollow: (
        inputs: readonly BoundedRegularFileReadInput[],
        maximumTotalBytes: number,
    ) => StableRegularFileRead[];
    readonly readRegularFileRangeNoFollow: (
        filePath: string,
        byteOffset: number,
        maximumBytes: number,
    ) => StableRegularFileRangeRead;
    readonly inspectRegularFileNoFollow: (filePath: string) => PhysicalPathIdentity;
    readonly inspectDirectoryNoFollow: (directoryPath: string) => PhysicalPathIdentity;
    /** Actual filesystem identity; selected-WSL compares Linux device IDs, not UNC volume projections. */
    readonly directoriesShareFilesystem: (firstPath: string, secondPath: string) => boolean;
    readonly inspectFilesystemCapacity: (directoryPath: string) => FilesystemCapacity;
    readonly inventoryDirectoryNoFollow: (directoryPath: string, maximumEntries?: number) => StableDirectoryInventory;
    readonly confirmDurableRegularFileNoFollow: (filePath: string) => StableRegularFileRead;
    readonly confirmDurableDirectoryNoFollow: (directoryPath: string) => PhysicalPathIdentity;
    readonly confirmDurableDirectoryTreeNoFollow: (directoryPath: string, maximumEntries?: number) => PhysicalPathIdentity;
    readonly durableEnsureDirectory: (parentPath: string, childName: string) => EnsuredDirectory;
    readonly durableCreateFile: (filePath: string, data: string | Uint8Array, executable?: boolean) => PhysicalPathIdentity;
    readonly durableReplaceFile: (filePath: string, data: string | Uint8Array, executable?: boolean) => PhysicalPathIdentity;
    /** One staged replacement that accepts the current regular-file value, including a later creation. */
    readonly durableOverwriteFile: (filePath: string, data: string | Uint8Array, executable?: boolean) => PhysicalPathIdentity;
    readonly durableRemoveRegularFile: (filePath: string) => boolean;
    readonly permanentlyRemoveRegularFileIfIdentity: (filePath: string, expectedIdentity: PhysicalPathIdentity) => boolean;
    readonly durableRecycleRegularFileIfIdentity: (filePath: string, expectedIdentity: PhysicalPathIdentity) => boolean;
    readonly durableRemoveDirectoryTree: (directoryPath: string, maximumEntries?: number) => boolean;
    readonly assertDirectoryTreeRecycleSupported: (directoryPath: string) => void;
    readonly durableRecycleDirectoryTreeIfIdentity: (
        directoryPath: string,
        expectedIdentity: PhysicalPathIdentity,
        maximumEntries?: number,
    ) => boolean;
    readonly durablePublishRegularFile: (
        sourcePath: string,
        targetParentPath: string,
        targetName: string,
    ) => PhysicalPathIdentity;
    readonly durablePublishDirectory: (
        stagedDirectoryPath: string,
        targetParentPath: string,
        targetName: string,
    ) => PhysicalPathIdentity;
    readonly readRegularFileBounded: (filePath: string, maximumBytes: number) => Uint8Array;
    readonly observeDirectoryMembersBounded: (directoryPath: string, maximumEntries: number) => BoundedDirectoryEntry[];
    readonly readDirectoryEntriesBounded: (directoryPath: string, maximumEntries: number) => BoundedDirectoryEntry[];
    readonly readVolatileDirectoryEntriesBounded: (directoryPath: string, maximumEntries: number) => BoundedDirectoryEntry[];
    readonly atomicWriteFile: (destinationPath: string, data: string | Uint8Array) => void;
    readonly lockFile: (lockPath: string) => (() => void) | null;
    readonly assertExecutableStateSupported: (filePath: string, executable: boolean) => void;
    readonly chmodIfDifferent: (filePath: string, executable: boolean) => boolean;
}
