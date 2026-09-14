import { describe, expect, it, vi } from "vitest";
import type { StableDirectoryInventory, StableRegularFileRead } from "../../../src/filesystem/filesystem-types";
import type { Win32NativeFilesystemAddon } from "../../../src/paths/win32/native-addon";
import { createWin32LocalProcessObservationMechanics } from "../../../src/paths/win32/process-observation";

const executableIdentity = {
    deviceId: "42",
    fileId: "0123456789abcdef0123456789abcdef",
    entryKind: "file" as const,
};
const directoryIdentity = {
    deviceId: "42",
    fileId: "fedcba9876543210fedcba9876543210",
    entryKind: "directory" as const,
};
const observation = {
    processId: 42,
    lifecycleToken: "1337",
    executableIdentity,
    commandLineBytes: new TextEncoder().encode("fixture-runtime\0serve\0"),
} as const;

function nativeAddon(overrides: Partial<Win32NativeFilesystemAddon> = {}): Win32NativeFilesystemAddon {
    const read = {
        bytes: new Uint8Array(),
        executable: false,
        identity: executableIdentity,
    } satisfies StableRegularFileRead;
    const inventory = {
        identity: directoryIdentity,
        entries: [],
    } satisfies StableDirectoryInventory;
    return {
        readRegularFile: () => read,
        readRegularFileRange: () => ({ ...read, byteOffset: 0, totalBytes: 0 }),
        inspectRegularFile: () => executableIdentity,
        inventoryDirectory: () => inventory,
        listLocalProcessExecutableCandidateIdsBounded: () => [42],
        listLocalProcessIdsBounded: () => [42],
        observeLocalProcessBounded: () => observation,
        observeLocalProcessExecutableBounded: () => observation,
        invokeLocalExecutableTreeBounded: () => ({
            status: "complete",
            exitCode: 0,
            signal: null,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            rootProcess: { processId: 42, lifecycleToken: "1337" },
            observedProcesses: [{ processId: 42, lifecycleToken: "1337" }],
            cleanupComplete: true,
            invocationTokenAbsent: true,
            failureCode: "",
        }),
        confirmDurableRegularFile: () => read,
        confirmDurableDirectory: () => directoryIdentity,
        confirmDurableDirectoryTree: () => directoryIdentity,
        ensureDirectory: () => ({ identity: directoryIdentity, created: true }),
        createFile: () => executableIdentity,
        replaceFile: () => executableIdentity,
        removeRegularFile: () => false,
        permanentlyRemoveRegularFileIfIdentity: () => false,
        recycleRegularFileIfIdentity: () => false,
        recycleDirectoryTreeIfIdentity: () => false,
        removeDirectoryTree: () => false,
        publishDirectory: () => directoryIdentity,
        publishFile: () => directoryIdentity,
        acquireLock: () => null,
        ...overrides,
    };
}

describe("Win32 local process observation", () => {
    it("validates bounds before lazily loading the native implementation", () => {
        const loadNative = vi.fn(() => nativeAddon());
        const mechanics = createWin32LocalProcessObservationMechanics(loadNative);

        expect(() => mechanics.listLocalProcessIdsBounded(0)).toThrow(RangeError);
        expect(() => mechanics.listLocalProcessExecutableCandidateIdsBounded("", 65_536)).toThrow(TypeError);
        expect(() => mechanics.listLocalProcessExecutableCandidateIdsBounded("C:\\fixture\\runtime.exe", 0)).toThrow(RangeError);
        expect(() => mechanics.observeLocalProcessBounded(0, executableIdentity, 1_024)).toThrow(RangeError);
        expect(() => mechanics.observeLocalProcessExecutableBounded(42, "", executableIdentity, 1_024)).toThrow(TypeError);
        expect(loadNative).not.toHaveBeenCalled();
    });

    it("routes bounded inventory and both identity observations through one native instance", () => {
        const list = vi.fn(() => [7, 42]);
        const listCandidates = vi.fn(() => [42]);
        const observe = vi.fn(() => observation);
        const observeExecutable = vi.fn(() => observation);
        const loadNative = vi.fn(() =>
            nativeAddon({
                listLocalProcessIdsBounded: list,
                listLocalProcessExecutableCandidateIdsBounded: listCandidates,
                observeLocalProcessBounded: observe,
                observeLocalProcessExecutableBounded: observeExecutable,
            }),
        );
        const mechanics = createWin32LocalProcessObservationMechanics(loadNative);

        expect(mechanics.listLocalProcessIdsBounded(65_536)).toEqual([7, 42]);
        expect(mechanics.listLocalProcessExecutableCandidateIdsBounded("C:\\fixture\\runtime.exe", 65_536)).toEqual([42]);
        expect(mechanics.observeLocalProcessBounded(42, executableIdentity, 65_536)).toEqual(observation);
        expect(
            mechanics.observeLocalProcessExecutableBounded(42, "C:\\fixture\\runtime.exe", executableIdentity, 65_536),
        ).toEqual(observation);
        expect(loadNative).toHaveBeenCalledTimes(1);
        expect(list).toHaveBeenCalledWith(65_536);
        expect(listCandidates).toHaveBeenCalledWith("C:\\fixture\\runtime.exe", 65_536);
        expect(observe).toHaveBeenCalledWith(42, executableIdentity, 65_536);
        expect(observeExecutable).toHaveBeenCalledWith(42, "C:\\fixture\\runtime.exe", executableIdentity, 65_536);
    });

    it("preserves an unmatched executable as null", () => {
        const mechanics = createWin32LocalProcessObservationMechanics(() =>
            nativeAddon({
                observeLocalProcessExecutableBounded: () => null,
            }),
        );
        expect(
            mechanics.observeLocalProcessExecutableBounded(42, "C:\\fixture\\other.exe", executableIdentity, 1_024),
        ).toBeNull();
    });
});
