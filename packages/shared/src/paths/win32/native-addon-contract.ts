import type {
    EnsuredDirectory,
    PhysicalPathIdentity,
    StableDirectoryInventory,
    StableRegularFileRangeRead,
    StableRegularFileRead,
} from "../../filesystem/filesystem-types";
import type {
    LocalExecutableEnvironmentEntry,
    LocalExecutableTreeInvocationResult,
    LocalProcessExecutableIdentity,
    LocalProcessObservation,
} from "../path-environment";

export interface Win32NativeFilesystemAddon {
    readonly readRegularFile: (filePath: string, maximumBytes: number) => StableRegularFileRead;
    readonly readRegularFileRange: (filePath: string, byteOffset: number, maximumBytes: number) => StableRegularFileRangeRead;
    readonly inspectRegularFile: (filePath: string) => PhysicalPathIdentity;
    readonly inspectDirectory: (directoryPath: string) => PhysicalPathIdentity;
    readonly inventoryDirectory: (directoryPath: string, maximumEntries: number) => StableDirectoryInventory;
    readonly listLocalProcessExecutableCandidateIdsBounded: (expectedExecutablePath: string, maximumEntries: number) => number[];
    readonly listLocalProcessIdsBounded: (maximumEntries: number) => number[];
    readonly observeLocalProcessBounded: (
        processId: number,
        expectedExecutableIdentity: LocalProcessExecutableIdentity,
        maximumCommandLineBytes: number,
    ) => LocalProcessObservation | null;
    readonly observeLocalProcessExecutableBounded: (
        processId: number,
        expectedExecutablePath: string,
        expectedExecutableIdentity: LocalProcessExecutableIdentity,
        maximumCommandLineBytes: number,
    ) => LocalProcessObservation | null;
    readonly invokeLocalExecutableTreeBounded: (
        executablePath: string,
        expectedExecutableIdentity: LocalProcessExecutableIdentity,
        arguments_: readonly string[],
        workingDirectory: string,
        environmentEntries: readonly LocalExecutableEnvironmentEntry[],
        invocationToken: string,
        timeoutMilliseconds: number,
        maximumOutputBytes: number,
    ) => LocalExecutableTreeInvocationResult;
    readonly confirmDurableRegularFile: (filePath: string) => StableRegularFileRead;
    readonly confirmDurableDirectory: (directoryPath: string) => PhysicalPathIdentity;
    readonly confirmDurableDirectoryTree: (directoryPath: string, maximumEntries: number) => PhysicalPathIdentity;
    readonly ensureDirectory: (parentPath: string, childName: string) => EnsuredDirectory;
    readonly createFile: (filePath: string, data: string | Uint8Array) => PhysicalPathIdentity;
    readonly replaceFile: (filePath: string, data: string | Uint8Array) => PhysicalPathIdentity;
    readonly removeRegularFile: (filePath: string) => boolean;
    readonly permanentlyRemoveRegularFileIfIdentity: (filePath: string, expectedIdentity: PhysicalPathIdentity) => boolean;
    readonly recycleRegularFileIfIdentity: (filePath: string, expectedIdentity: PhysicalPathIdentity) => boolean;
    readonly recycleDirectoryTreeIfIdentity: (
        directoryPath: string,
        expectedIdentity: PhysicalPathIdentity,
        maximumEntries: number,
    ) => boolean;
    readonly removeDirectoryTree: (directoryPath: string, maximumEntries: number) => boolean;
    readonly publishFile: (sourcePath: string, targetParentPath: string, targetName: string) => PhysicalPathIdentity;
    readonly publishDirectory: (
        stagedDirectoryPath: string,
        targetParentPath: string,
        targetName: string,
        maximumEntries: number,
    ) => PhysicalPathIdentity;
    readonly acquireLock: (lockPath: string) => (() => void) | null;
}
