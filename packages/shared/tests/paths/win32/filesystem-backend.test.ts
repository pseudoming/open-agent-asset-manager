import { describe, expect, it, vi } from "vitest";
import {
    DurableFilesystemMutationError,
    SafeFilesystemError,
    type StableDirectoryInventory,
    type StableRegularFileRangeRead,
    type StableRegularFileRead,
} from "../../../src/filesystem/filesystem-types";
import type { LocalExecutableTreeInvocationResult } from "../../../src/paths/path-environment";
import { createWin32PhysicalFilesystemBackend } from "../../../src/paths/win32/filesystem-backend";
import { createWin32LocalExecutableInvocationMechanics } from "../../../src/paths/win32/local-executable-invocation";
import { loadWin32NativeFilesystemAddon, type Win32NativeFilesystemAddon } from "../../../src/paths/win32/native-addon";
import { createWin32RecycleWorkerBounded } from "../../../src/paths/win32/recycle-bin-worker-client";

const FILE_IDENTITY = Object.freeze({
    deviceId: "42",
    fileId: "0123456789abcdef0123456789abcdef",
    entryKind: "file" as const,
});
const DIRECTORY_IDENTITY = Object.freeze({
    deviceId: "42",
    fileId: "fedcba9876543210fedcba9876543210",
    entryKind: "directory" as const,
});
const OTHER_FILE_IDENTITY = Object.freeze({
    deviceId: "42",
    fileId: "11111111111111111111111111111111",
    entryKind: "file" as const,
});

function readResult(text = "oaam"): StableRegularFileRead {
    return {
        bytes: new TextEncoder().encode(text),
        executable: false,
        identity: FILE_IDENTITY,
    };
}

function rangeReadResult(text = "aa", byteOffset = 1, totalBytes = 4): StableRegularFileRangeRead {
    return {
        bytes: new TextEncoder().encode(text),
        byteOffset,
        totalBytes,
        executable: false,
        identity: FILE_IDENTITY,
    };
}

function inventoryResult(): StableDirectoryInventory {
    return {
        identity: DIRECTORY_IDENTITY,
        entries: [{ relativeName: "child.txt", identity: FILE_IDENTITY }],
    };
}

function invocationResult(overrides: Partial<LocalExecutableTreeInvocationResult> = {}): LocalExecutableTreeInvocationResult {
    return {
        status: "complete",
        exitCode: 0,
        signal: null,
        stdout: new TextEncoder().encode('{"schemaVersion":1,"status":"complete","removed":true}\n'),
        stderr: new Uint8Array(),
        rootProcess: { processId: 43, lifecycleToken: "100" },
        observedProcesses: [{ processId: 43, lifecycleToken: "100" }],
        cleanupComplete: true,
        invocationTokenAbsent: true,
        failureCode: "",
        ...overrides,
    };
}

function rawNativeAddon(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const lockToken = {};
    return {
        contractVersion: "oaam.win32.filesystem.v15",
        readRegularFile: () => readResult(),
        readRegularFileRange: () => rangeReadResult(),
        inspectRegularFile: () => FILE_IDENTITY,
        inspectDirectory: () => DIRECTORY_IDENTITY,
        inventoryDirectory: () => inventoryResult(),
        listLocalProcessExecutableCandidateIdsBounded: () => [42],
        listLocalProcessIdsBounded: () => [42],
        observeLocalProcessBounded: () => null,
        observeLocalProcessExecutableBounded: () => null,
        invokeLocalExecutableTreeBounded: () => ({
            status: "complete",
            exitCode: 0,
            signal: null,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            rootProcess: { processId: 43, lifecycleToken: "100" },
            observedProcesses: [{ processId: 43, lifecycleToken: "100" }],
            cleanupComplete: true,
            invocationTokenAbsent: true,
            failureCode: "",
        }),
        confirmDurableRegularFile: () => readResult(),
        confirmDurableDirectory: () => DIRECTORY_IDENTITY,
        confirmDurableDirectoryTree: () => DIRECTORY_IDENTITY,
        ensureDirectory: () => ({ identity: DIRECTORY_IDENTITY, created: true }),
        createFile: () => FILE_IDENTITY,
        replaceFile: () => FILE_IDENTITY,
        removeRegularFile: () => true,
        recycleRegularFileIfIdentity: () => true,
        permanentlyRemoveRegularFileIfIdentity: () => true,
        recycleDirectoryTreeIfIdentity: () => true,
        removeDirectoryTree: () => true,
        publishDirectory: () => DIRECTORY_IDENTITY,
        publishFile: () => FILE_IDENTITY,
        acquireLock: () => lockToken,
        releaseLock: () => undefined,
        ...overrides,
    };
}

function typedNativeAddon(overrides: Partial<Win32NativeFilesystemAddon> = {}): Win32NativeFilesystemAddon {
    return {
        readRegularFile: () => readResult(),
        readRegularFileRange: () => rangeReadResult(),
        inspectRegularFile: () => FILE_IDENTITY,
        inspectDirectory: () => DIRECTORY_IDENTITY,
        inventoryDirectory: () => inventoryResult(),
        listLocalProcessExecutableCandidateIdsBounded: () => [42],
        listLocalProcessIdsBounded: () => [42],
        observeLocalProcessBounded: () => null,
        observeLocalProcessExecutableBounded: () => null,
        invokeLocalExecutableTreeBounded: () => ({
            status: "complete",
            exitCode: 0,
            signal: null,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            rootProcess: { processId: 43, lifecycleToken: "100" },
            observedProcesses: [{ processId: 43, lifecycleToken: "100" }],
            cleanupComplete: true,
            invocationTokenAbsent: true,
            failureCode: "",
        }),
        confirmDurableRegularFile: () => readResult(),
        confirmDurableDirectory: () => DIRECTORY_IDENTITY,
        confirmDurableDirectoryTree: () => DIRECTORY_IDENTITY,
        ensureDirectory: () => ({ identity: DIRECTORY_IDENTITY, created: true }),
        createFile: () => FILE_IDENTITY,
        replaceFile: () => FILE_IDENTITY,
        removeRegularFile: () => true,
        recycleRegularFileIfIdentity: () => true,
        permanentlyRemoveRegularFileIfIdentity: () => true,
        recycleDirectoryTreeIfIdentity: () => true,
        removeDirectoryTree: () => true,
        publishDirectory: () => DIRECTORY_IDENTITY,
        publishFile: () => FILE_IDENTITY,
        acquireLock: () => () => undefined,
        ...overrides,
    };
}

describe("Win32 native filesystem addon wrapper", () => {
    it("validates the exact ABI and validates every result shape", async () => {
        const rawBytes = new TextEncoder().encode("oaam");
        const releaseLock = vi.fn();
        const addon = loadWin32NativeFilesystemAddon(() =>
            rawNativeAddon({
                readRegularFile: () => ({
                    bytes: rawBytes,
                    executable: false,
                    identity: FILE_IDENTITY,
                }),
                readRegularFileRange: () => rangeReadResult(),
                releaseLock,
            }),
        );

        const read = addon.readRegularFile("C:\\fixture\\payload.txt", 4);
        rawBytes[0] = 0;
        expect(new TextDecoder().decode(read.bytes)).toBe("oaam");
        expect(addon.readRegularFileRange("C:\\fixture\\payload.txt", 1, 2)).toEqual(rangeReadResult());
        expect(addon.inspectRegularFile("C:\\fixture\\payload.txt")).toEqual(FILE_IDENTITY);
        expect(addon.inspectDirectory("C:\\fixture")).toEqual(DIRECTORY_IDENTITY);
        expect(addon.inventoryDirectory("C:\\fixture", 1)).toEqual(inventoryResult());
        expect(addon.listLocalProcessExecutableCandidateIdsBounded("C:\\fixture\\oaam.exe", 2)).toEqual([42]);
        expect(addon.listLocalProcessIdsBounded(2)).toEqual([42]);
        expect(addon.observeLocalProcessBounded(42, FILE_IDENTITY, 16)).toBeNull();
        expect(addon.observeLocalProcessExecutableBounded(42, "C:\\fixture\\oaam.exe", FILE_IDENTITY, 16)).toBeNull();
        expect(
            addon.invokeLocalExecutableTreeBounded(
                "C:\\fixture\\oaam.exe",
                FILE_IDENTITY,
                ["--version"],
                "C:\\fixture",
                [{ name: "SystemRoot", value: "C:\\Windows" }],
                "a".repeat(64),
                1_000,
                1_024,
            ),
        ).toEqual({
            status: "complete",
            exitCode: 0,
            signal: null,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            rootProcess: { processId: 43, lifecycleToken: "100" },
            observedProcesses: [{ processId: 43, lifecycleToken: "100" }],
            cleanupComplete: true,
            invocationTokenAbsent: true,
            failureCode: "",
        });
        const cleanNonZeroAddon = loadWin32NativeFilesystemAddon(() =>
            rawNativeAddon({
                invokeLocalExecutableTreeBounded: () => ({
                    status: "failed",
                    exitCode: 2,
                    signal: null,
                    stdout: new Uint8Array(),
                    stderr: new TextEncoder().encode("unknown command"),
                    rootProcess: { processId: 43, lifecycleToken: "100" },
                    observedProcesses: [{ processId: 43, lifecycleToken: "100" }],
                    cleanupComplete: true,
                    invocationTokenAbsent: true,
                    failureCode: "exit",
                }),
            }),
        );
        expect(
            cleanNonZeroAddon.invokeLocalExecutableTreeBounded(
                "C:\\fixture\\oaam.exe",
                FILE_IDENTITY,
                ["--version"],
                "C:\\fixture",
                [{ name: "SystemRoot", value: "C:\\Windows" }],
                "a".repeat(64),
                1_000,
                1_024,
            ).stderr,
        ).toEqual(new TextEncoder().encode("unknown command"));
        const unsafeFailureOutputAddon = loadWin32NativeFilesystemAddon(() =>
            rawNativeAddon({
                invokeLocalExecutableTreeBounded: () => ({
                    status: "timed_out",
                    exitCode: null,
                    signal: null,
                    stdout: new Uint8Array(),
                    stderr: new TextEncoder().encode("must not escape"),
                    rootProcess: { processId: 43, lifecycleToken: "100" },
                    observedProcesses: [{ processId: 43, lifecycleToken: "100" }],
                    cleanupComplete: true,
                    invocationTokenAbsent: true,
                    failureCode: "timeout",
                }),
            }),
        );
        expect(() =>
            unsafeFailureOutputAddon.invokeLocalExecutableTreeBounded(
                "C:\\fixture\\oaam.exe",
                FILE_IDENTITY,
                ["--version"],
                "C:\\fixture",
                [{ name: "SystemRoot", value: "C:\\Windows" }],
                "a".repeat(64),
                1_000,
                1_024,
            ),
        ).toThrowError(
            expect.objectContaining({
                systemCode: "NATIVE_PROTOCOL_VIOLATION",
            }),
        );
        expect(addon.confirmDurableRegularFile("C:\\fixture\\payload.txt")).toEqual(readResult());
        expect(addon.confirmDurableDirectory("C:\\fixture")).toEqual(DIRECTORY_IDENTITY);
        expect(addon.confirmDurableDirectoryTree("C:\\fixture", 1)).toEqual(DIRECTORY_IDENTITY);
        expect(addon.ensureDirectory("C:\\fixture", "child")).toEqual({
            identity: DIRECTORY_IDENTITY,
            created: true,
        });
        expect(addon.createFile("C:\\fixture\\new-payload.txt", "bytes")).toEqual(FILE_IDENTITY);
        expect(addon.replaceFile("C:\\fixture\\payload.txt", "bytes")).toEqual(FILE_IDENTITY);
        expect(addon.removeRegularFile("C:\\fixture\\payload.txt")).toBe(true);
        expect(addon.recycleRegularFileIfIdentity("C:\\fixture\\payload.txt", FILE_IDENTITY)).toBe(true);
        expect(addon.permanentlyRemoveRegularFileIfIdentity("C:\\fixture\\payload.txt", FILE_IDENTITY)).toBe(true);
        expect(addon.recycleDirectoryTreeIfIdentity("C:\\fixture\\tree", DIRECTORY_IDENTITY, 2)).toBe(true);
        expect(addon.removeDirectoryTree("C:\\fixture\\tree", 2)).toBe(true);
        expect(addon.publishDirectory("C:\\staged", "C:\\fixture", "published", 2)).toEqual(DIRECTORY_IDENTITY);

        const release = addon.acquireLock("C:\\fixture\\lock");
        expect(release).toBeTypeOf("function");
        release?.();
        release?.();
        expect(releaseLock).toHaveBeenCalledTimes(1);
    });

    it("preserves typed read failures and fail-closes malformed mutation results", () => {
        const nativeReadFailure = Object.assign(new Error("missing"), {
            failureKind: "not_found",
            systemCode: "ERROR_FILE_NOT_FOUND",
        });
        const nativeMutationFailure = Object.assign(new Error("denied"), {
            failureKind: "permission_denied",
            systemCode: "ERROR_ACCESS_DENIED",
            mutationState: "not_applied",
        });
        const addon = loadWin32NativeFilesystemAddon(() =>
            rawNativeAddon({
                readRegularFile: () => {
                    throw nativeReadFailure;
                },
                readRegularFileRange: () => ({
                    ...rangeReadResult(),
                    totalBytes: 1,
                }),
                replaceFile: () => {
                    throw nativeMutationFailure;
                },
                removeRegularFile: () => "yes",
                permanentlyRemoveRegularFileIfIdentity: () => "yes",
                inventoryDirectory: () => ({
                    identity: DIRECTORY_IDENTITY,
                    entries: [{ relativeName: "..", identity: DIRECTORY_IDENTITY }],
                }),
                listLocalProcessIdsBounded: () => [42, 42],
                listLocalProcessExecutableCandidateIdsBounded: () => [42, 42],
                observeLocalProcessBounded: () => ({
                    processId: 42,
                    lifecycleToken: "7",
                    executableIdentity: OTHER_FILE_IDENTITY,
                    commandLineBytes: new Uint8Array(),
                }),
            }),
        );

        expect(() => addon.readRegularFile("C:\\fixture\\missing.txt", 1)).toThrowError(
            expect.objectContaining({
                failureKind: "not_found",
                operation: "read_regular_file",
                systemCode: "ERROR_FILE_NOT_FOUND",
            }),
        );
        expect(() => addon.readRegularFileRange("C:\\fixture\\payload.txt", 1, 2)).toThrowError(
            expect.objectContaining({
                failureKind: "io_error",
                systemCode: "NATIVE_PROTOCOL_VIOLATION",
            }),
        );
        expect(() => addon.replaceFile("C:\\fixture\\state.json", "new")).toThrowError(
            expect.objectContaining({
                failureKind: "permission_denied",
                mutationState: "not_applied",
            }),
        );
        const malformedMutation = (() => {
            try {
                addon.removeRegularFile("C:\\fixture\\state.json");
            } catch (error) {
                return error;
            }
            throw new Error("expected a mutation failure");
        })();
        expect(malformedMutation).toBeInstanceOf(DurableFilesystemMutationError);
        expect(malformedMutation).toEqual(
            expect.objectContaining({
                systemCode: "NATIVE_PROTOCOL_VIOLATION",
                mutationState: "may_have_applied",
            }),
        );
        expect(() => addon.permanentlyRemoveRegularFileIfIdentity("C:\\fixture\\state.json", FILE_IDENTITY)).toThrowError(
            expect.objectContaining({
                operation: "permanent_remove_file",
                systemCode: "NATIVE_PROTOCOL_VIOLATION",
                mutationState: "may_have_applied",
            }),
        );
        expect(() => addon.inventoryDirectory("C:\\fixture", 1)).toThrowError(
            expect.objectContaining({
                failureKind: "io_error",
                systemCode: "NATIVE_PROTOCOL_VIOLATION",
            }),
        );
        expect(() => addon.listLocalProcessIdsBounded(2)).toThrowError(
            expect.objectContaining({
                failureKind: "io_error",
                systemCode: "NATIVE_PROTOCOL_VIOLATION",
            }),
        );
        expect(() => addon.listLocalProcessExecutableCandidateIdsBounded("C:\\fixture\\oaam.exe", 2)).toThrowError(
            expect.objectContaining({
                failureKind: "io_error",
                systemCode: "NATIVE_PROTOCOL_VIOLATION",
            }),
        );
        expect(() => addon.observeLocalProcessBounded(42, FILE_IDENTITY, 16)).toThrowError(
            expect.objectContaining({
                failureKind: "io_error",
                systemCode: "NATIVE_PROTOCOL_VIOLATION",
            }),
        );
        expect(() => loadWin32NativeFilesystemAddon(() => ({ contractVersion: "wrong" }))).toThrowError(
            /native addon export contract is invalid/u,
        );
    });

    it("rejects case-insensitive environment collisions before loading the native invocation", async () => {
        const invokeNative = vi.fn();
        const loadNative = vi.fn(() => typedNativeAddon({ invokeLocalExecutableTreeBounded: invokeNative }));
        const mechanics = createWin32LocalExecutableInvocationMechanics(loadNative);
        const invoke = (environmentEntries: Array<{ name: string; value: string }>) =>
            mechanics.invokeLocalExecutableTreeBounded(
                "C:\\fixture\\oaam.exe",
                FILE_IDENTITY,
                ["--version"],
                "C:\\fixture",
                environmentEntries,
                "a".repeat(64),
                1_000,
                1_024,
            );

        await expect(invoke([{ name: "oaam_invocation_token", value: "caller-controlled" }])).rejects.toThrow(TypeError);
        await expect(
            invoke([
                { name: "PATH", value: "C:\\Windows\\System32" },
                { name: "Path", value: "C:\\foreign" },
            ]),
        ).rejects.toThrow(TypeError);
        expect(loadNative).not.toHaveBeenCalled();
        expect(invokeNative).not.toHaveBeenCalled();
    });

    it("returns null when the native lock is busy", () => {
        const addon = loadWin32NativeFilesystemAddon(() => rawNativeAddon({ acquireLock: () => null }));
        expect(addon.acquireLock("C:\\fixture\\lock")).toBeNull();
    });
});

describe("Win32 physical filesystem backend", () => {
    it("loads the native addon lazily once and routes internal-state mechanics", () => {
        const readRegularFile = vi.fn(() => readResult());
        const readRegularFileRange = vi.fn(() => rangeReadResult());
        const inspectRegularFile = vi.fn(() => FILE_IDENTITY);
        const inspectDirectory = vi.fn(() => DIRECTORY_IDENTITY);
        const inventoryDirectory = vi.fn(() => inventoryResult());
        const confirmDurableDirectoryTree = vi.fn(() => DIRECTORY_IDENTITY);
        const removeRegularFile = vi.fn(() => true);
        const removeDirectoryTree = vi.fn(() => true);
        const recycleDirectoryTreeIfIdentity = vi.fn(() => true);
        const recycleRegularFileIfIdentity = vi.fn(() => true);
        const permanentlyRemoveRegularFileIfIdentity = vi.fn(() => true);
        const publishDirectory = vi.fn(() => DIRECTORY_IDENTITY);
        const recycleWorker = vi.fn(() => true);
        const loadNative = vi.fn(() =>
            typedNativeAddon({
                readRegularFile,
                readRegularFileRange,
                inspectRegularFile,
                inspectDirectory,
                inventoryDirectory,
                confirmDurableDirectoryTree,
                removeRegularFile,
                removeDirectoryTree,
                recycleDirectoryTreeIfIdentity,
                recycleRegularFileIfIdentity,
                permanentlyRemoveRegularFileIfIdentity,
                publishDirectory,
            }),
        );
        const backend = createWin32PhysicalFilesystemBackend(loadNative, recycleWorker);

        expect(new TextDecoder().decode(backend.readRegularFileNoFollow("C:\\fixture\\payload.txt").bytes)).toBe("oaam");
        expect(backend.readRegularFileRangeNoFollow("C:\\fixture\\payload.txt", 1, 2)).toEqual(rangeReadResult());
        expect(backend.inspectRegularFileNoFollow("C:\\fixture\\payload.txt")).toEqual(FILE_IDENTITY);
        expect(backend.inspectDirectoryNoFollow("C:\\fixture")).toEqual(DIRECTORY_IDENTITY);
        expect(new TextDecoder().decode(backend.readRegularFileBounded("C:\\fixture\\payload.txt", 4))).toBe("oaam");
        expect(backend.inventoryDirectoryNoFollow("C:\\fixture")).toEqual(inventoryResult());
        expect(backend.readDirectoryEntriesBounded("C:\\fixture", 1)).toEqual([{ name: "child.txt", entryKind: "file" }]);
        expect(backend.confirmDurableDirectoryTreeNoFollow("C:\\fixture")).toEqual(DIRECTORY_IDENTITY);
        expect(backend.durableRemoveDirectoryTree("C:\\fixture\\tree", 2)).toBe(true);
        expect(backend.durableRemoveRegularFile("C:\\fixture\\direct-payload.txt")).toBe(true);
        expect(backend.durableRecycleDirectoryTreeIfIdentity("C:\\fixture\\tree", DIRECTORY_IDENTITY, 2)).toBe(true);
        expect(backend.durableRecycleRegularFileIfIdentity("C:\\fixture\\payload.txt", FILE_IDENTITY)).toBe(true);
        expect(backend.permanentlyRemoveRegularFileIfIdentity("C:\\fixture\\payload.txt", FILE_IDENTITY)).toBe(true);
        expect(backend.durablePublishDirectory("C:\\staged", "C:\\fixture", "published")).toEqual(DIRECTORY_IDENTITY);
        expect(loadNative).toHaveBeenCalledTimes(1);
        expect(inspectRegularFile).toHaveBeenCalledWith("C:\\fixture\\payload.txt");
        expect(inspectDirectory).toHaveBeenCalledWith("C:\\fixture");
        expect(readRegularFile).toHaveBeenLastCalledWith("C:\\fixture\\payload.txt", 4);
        expect(readRegularFileRange).toHaveBeenCalledWith("C:\\fixture\\payload.txt", 1, 2);
        expect(inventoryDirectory).toHaveBeenNthCalledWith(1, "C:\\fixture", 0xffff_ffff);
        expect(confirmDurableDirectoryTree).toHaveBeenNthCalledWith(1, "C:\\fixture", 0xffff_ffff);
        expect(confirmDurableDirectoryTree).toHaveBeenNthCalledWith(2, "C:\\fixture\\tree", 2);
        expect(removeRegularFile).not.toHaveBeenCalled();
        expect(removeDirectoryTree).not.toHaveBeenCalled();
        expect(recycleWorker).toHaveBeenNthCalledWith(1, expect.any(Object), {
            targetPath: "C:\\fixture\\tree",
            expectedIdentity: DIRECTORY_IDENTITY,
            maximumEntries: 2,
        });
        expect(recycleWorker).toHaveBeenNthCalledWith(2, expect.any(Object), {
            targetPath: "C:\\fixture\\direct-payload.txt",
            expectedIdentity: FILE_IDENTITY,
            maximumEntries: 0,
        });
        expect(recycleWorker).toHaveBeenNthCalledWith(3, expect.any(Object), {
            targetPath: "C:\\fixture\\tree",
            expectedIdentity: DIRECTORY_IDENTITY,
            maximumEntries: 2,
        });
        expect(recycleWorker).toHaveBeenNthCalledWith(4, expect.any(Object), {
            targetPath: "C:\\fixture\\payload.txt",
            expectedIdentity: FILE_IDENTITY,
            maximumEntries: 0,
        });
        expect(recycleDirectoryTreeIfIdentity).not.toHaveBeenCalled();
        expect(recycleRegularFileIfIdentity).not.toHaveBeenCalled();
        expect(permanentlyRemoveRegularFileIfIdentity).toHaveBeenCalledWith("C:\\fixture\\payload.txt", FILE_IDENTITY);
        expect(publishDirectory).toHaveBeenCalledWith("C:\\staged", "C:\\fixture", "published", 0xffff_ffff);
    });

    it("rejects invalid limits before loading native code", () => {
        const loadNative = vi.fn(() => typedNativeAddon());
        const backend = createWin32PhysicalFilesystemBackend(loadNative);

        expect(() => backend.readRegularFileBounded("C:\\fixture\\payload.txt", -1)).toThrowError(
            expect.objectContaining({ failureKind: "resource_limit", systemCode: "INVALID_LIMIT" }),
        );
        expect(() => backend.readRegularFileRangeNoFollow("C:\\fixture\\payload.txt", -1, 1)).toThrowError(
            expect.objectContaining({ failureKind: "resource_limit", systemCode: "INVALID_LIMIT" }),
        );
        expect(() => backend.readRegularFileRangeNoFollow("C:\\fixture\\payload.txt", 0, 0)).toThrowError(
            expect.objectContaining({ failureKind: "resource_limit", systemCode: "INVALID_LIMIT" }),
        );
        expect(() => backend.readDirectoryEntriesBounded("C:\\fixture", 1.5)).toThrowError(
            expect.objectContaining({ failureKind: "resource_limit", systemCode: "INVALID_LIMIT" }),
        );
        expect(() => backend.readVolatileDirectoryEntriesBounded("C:\\fixture", 1)).toThrowError(
            expect.objectContaining({
                failureKind: "unsupported_platform",
                operation: "inventory_directory",
                systemCode: "VOLATILE_DIRECTORY_OBSERVATION_NOT_REVIEWED",
            }),
        );
        expect(() => backend.confirmDurableDirectoryTreeNoFollow("C:\\fixture", Number.NaN)).toThrowError(
            expect.objectContaining({ operation: "confirm_durable_tree", systemCode: "INVALID_LIMIT" }),
        );
        expect(() => backend.durableRemoveDirectoryTree("C:\\fixture", -1)).toThrowError(
            expect.objectContaining({ operation: "durable_remove_tree", systemCode: "INVALID_LIMIT" }),
        );
        expect(loadNative).not.toHaveBeenCalled();
    });

    it("returns false for absent direct removals and types preflight failures as not applied", () => {
        const missingFile = new SafeFilesystemError({
            failureKind: "not_found",
            operation: "inspect_regular_file",
            targetPath: "C:\\fixture\\missing.txt",
            systemCode: "ERROR_FILE_NOT_FOUND",
            message: "missing",
        });
        const deniedTree = new SafeFilesystemError({
            failureKind: "permission_denied",
            operation: "confirm_durable_tree",
            targetPath: "C:\\fixture\\denied-tree",
            systemCode: "ERROR_ACCESS_DENIED",
            message: "denied",
        });
        const recycleWorker = vi.fn(() => true);
        const backend = createWin32PhysicalFilesystemBackend(
            () =>
                typedNativeAddon({
                    inspectRegularFile: () => {
                        throw missingFile;
                    },
                    confirmDurableDirectoryTree: () => {
                        throw deniedTree;
                    },
                }),
            recycleWorker,
        );

        expect(backend.durableRemoveRegularFile("C:\\fixture\\missing.txt")).toBe(false);
        expect(() => backend.durableRemoveDirectoryTree("C:\\fixture\\denied-tree", 2)).toThrowError(
            expect.objectContaining({
                name: "DurableFilesystemMutationError",
                operation: "durable_remove_tree",
                failureKind: "permission_denied",
                systemCode: "ERROR_ACCESS_DENIED",
                mutationState: "not_applied",
            }),
        );
        expect(recycleWorker).not.toHaveBeenCalled();
    });

    it("treats executable=false as a truthful no-op and rejects true before native loading", () => {
        const loadNative = vi.fn(() => typedNativeAddon());
        const backend = createWin32PhysicalFilesystemBackend(loadNative);
        expect(() => backend.assertExecutableStateSupported("C:\\fixture\\payload.txt", false)).not.toThrow();
        expect(backend.chmodIfDifferent("C:\\fixture\\payload.txt", false)).toBe(false);
        expect(loadNative).not.toHaveBeenCalled();
        expect(() => backend.assertExecutableStateSupported("C:\\fixture\\payload.txt", true)).toThrowError(
            expect.objectContaining({
                failureKind: "unsupported_platform",
                operation: "chmod_file",
                systemCode: "WINDOWS_RUNTIME_TARGET_MUTATION_NOT_ACTIVATED",
            }),
        );
        expect(loadNative).not.toHaveBeenCalled();
    });

    it("keeps runtime-target atomic-write and executable=true surfaces explicitly fail-closed", () => {
        const backend = createWin32PhysicalFilesystemBackend(
            () => typedNativeAddon(),
            () => true,
        );
        expect(() => backend.atomicWriteFile("C:\\fixture\\payload.txt", "bytes")).toThrowError(
            expect.objectContaining({
                failureKind: "unsupported_platform",
                operation: "atomic_write_file",
                systemCode: "WINDOWS_RUNTIME_TARGET_MUTATION_NOT_ACTIVATED",
            }),
        );
        expect(() => backend.chmodIfDifferent("C:\\fixture\\payload.txt", true)).toThrowError(
            expect.objectContaining({
                failureKind: "unsupported_platform",
                operation: "chmod_file",
                systemCode: "WINDOWS_RUNTIME_TARGET_MUTATION_NOT_ACTIVATED",
            }),
        );
        expect(backend.confirmDurableRegularFileNoFollow("C:\\fixture\\payload.txt")).toEqual(readResult());
        expect(backend.confirmDurableDirectoryNoFollow("C:\\fixture")).toEqual(DIRECTORY_IDENTITY);
        expect(backend.durableEnsureDirectory("C:\\fixture", "child").created).toBe(true);
        expect(backend.durableCreateFile("C:\\fixture\\new-payload.txt", "bytes")).toEqual(FILE_IDENTITY);
        expect(backend.durableReplaceFile("C:\\fixture\\payload.txt", "bytes")).toEqual(FILE_IDENTITY);
        expect(backend.durableRemoveRegularFile("C:\\fixture\\payload.txt")).toBe(true);
        expect(backend.durableRecycleRegularFileIfIdentity("C:\\fixture\\payload.txt", FILE_IDENTITY)).toBe(true);
        expect(backend.permanentlyRemoveRegularFileIfIdentity("C:\\fixture\\payload.txt", FILE_IDENTITY)).toBe(true);
        expect(backend.lockFile("C:\\fixture\\lock")).toBeTypeOf("function");
    });
});

describe("Win32 bounded Recycle Bin worker", () => {
    const dependencies = Object.freeze({
        executablePath: "C:\\OAAM\\node.exe",
        workerPath: "C:\\OAAM\\resources\\app.asar\\node_modules\\@oaam\\shared\\dist\\paths\\win32\\recycle-bin-worker.js",
        environmentEntries: [{ name: "SystemRoot", value: "C:\\Windows" }],
        createInvocationToken: () => "a".repeat(64),
    });

    function workerAddon(result: LocalExecutableTreeInvocationResult): {
        readonly addon: Win32NativeFilesystemAddon;
        readonly invoke: ReturnType<typeof vi.fn>;
        readonly inspect: ReturnType<typeof vi.fn>;
    } {
        const invoke = vi.fn(() => result);
        const inspect = vi.fn((filePath: string) => (filePath.endsWith("node.exe") ? FILE_IDENTITY : OTHER_FILE_IDENTITY));
        return {
            addon: typedNativeAddon({ inspectRegularFile: inspect, invokeLocalExecutableTreeBounded: invoke }),
            invoke,
            inspect,
        };
    }

    it("binds the current executable and worker identities around a successful fixed invocation", () => {
        const { addon, invoke, inspect } = workerAddon(invocationResult());
        const worker = createWin32RecycleWorkerBounded(dependencies);

        expect(
            worker(addon, {
                targetPath: "C:\\OAAM\\state\\payload.txt",
                expectedIdentity: FILE_IDENTITY,
                maximumEntries: 0,
            }),
        ).toBe(true);
        expect(invoke).toHaveBeenCalledWith(
            "C:\\OAAM\\node.exe",
            FILE_IDENTITY,
            [
                "C:\\OAAM\\resources\\app.asar.unpacked\\node_modules\\@oaam\\shared\\dist\\paths\\win32\\recycle-bin-worker.js",
                "file",
                "C:\\OAAM\\state\\payload.txt",
                FILE_IDENTITY.deviceId,
                FILE_IDENTITY.fileId,
                "file",
                "0",
                "a".repeat(64),
            ],
            "C:\\OAAM",
            dependencies.environmentEntries,
            "a".repeat(64),
            10_000,
            8 * 1_024,
        );
        expect(inspect).toHaveBeenCalledTimes(4);
    });

    it("preserves a typed worker failure and fail-closes timeout or cleanup uncertainty", () => {
        const worker = createWin32RecycleWorkerBounded(dependencies);
        const typedFailure = invocationResult({
            status: "failed",
            exitCode: 70,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode(
                '{"schemaVersion":1,"status":"failed","failureKind":"stale","systemCode":"WINDOWS_STALE","mutationState":"not_applied","message":"identity changed"}\n',
            ),
            failureCode: "exit",
        });
        expect(() =>
            worker(workerAddon(typedFailure).addon, {
                targetPath: "C:\\OAAM\\state\\payload.txt",
                expectedIdentity: FILE_IDENTITY,
                maximumEntries: 0,
            }),
        ).toThrowError(
            expect.objectContaining({
                failureKind: "stale",
                systemCode: "WINDOWS_STALE",
                mutationState: "not_applied",
            }),
        );

        const timeout = invocationResult({
            status: "timed_out",
            exitCode: null,
            stdout: new Uint8Array(),
            failureCode: "timeout",
        });
        expect(() =>
            worker(workerAddon(timeout).addon, {
                targetPath: "C:\\OAAM\\state\\tree",
                expectedIdentity: DIRECTORY_IDENTITY,
                maximumEntries: 12,
            }),
        ).toThrowError(
            expect.objectContaining({
                systemCode: "WINDOWS_RECYCLE_WORKER_TIMEOUT",
                mutationState: "may_have_applied",
            }),
        );

        const cleanupFailure = invocationResult({
            status: "cleanup_failed",
            exitCode: null,
            stdout: new Uint8Array(),
            cleanupComplete: false,
            invocationTokenAbsent: false,
            failureCode: "cleanup",
        });
        expect(() =>
            worker(workerAddon(cleanupFailure).addon, {
                targetPath: "C:\\OAAM\\state\\tree",
                expectedIdentity: DIRECTORY_IDENTITY,
                maximumEntries: 12,
            }),
        ).toThrowError(expect.objectContaining({ systemCode: "WINDOWS_RECYCLE_WORKER_CLEANUP_FAILED" }));
    });

    it("rejects malformed output, non-file worker identities and identity drift", () => {
        const worker = createWin32RecycleWorkerBounded(dependencies);
        expect(() =>
            worker(workerAddon(invocationResult({ stdout: new TextEncoder().encode("{}\n") })).addon, {
                targetPath: "C:\\OAAM\\state\\payload.txt",
                expectedIdentity: FILE_IDENTITY,
                maximumEntries: 0,
            }),
        ).toThrowError(expect.objectContaining({ systemCode: "WINDOWS_RECYCLE_WORKER_PROTOCOL_FAILURE" }));

        const directoryWorkerIdentity = typedNativeAddon({ inspectRegularFile: () => DIRECTORY_IDENTITY });
        expect(() =>
            worker(directoryWorkerIdentity, {
                targetPath: "C:\\OAAM\\state\\payload.txt",
                expectedIdentity: FILE_IDENTITY,
                maximumEntries: 0,
            }),
        ).toThrowError(
            expect.objectContaining({
                systemCode: "WINDOWS_RECYCLE_WORKER_IDENTITY_INVALID",
                mutationState: "not_applied",
            }),
        );

        let inspections = 0;
        const driftingAddon = typedNativeAddon({
            inspectRegularFile: () => {
                inspections += 1;
                if (inspections <= 2) return FILE_IDENTITY;
                return OTHER_FILE_IDENTITY;
            },
            invokeLocalExecutableTreeBounded: () => invocationResult(),
        });
        expect(() =>
            worker(driftingAddon, {
                targetPath: "C:\\OAAM\\state\\payload.txt",
                expectedIdentity: FILE_IDENTITY,
                maximumEntries: 0,
            }),
        ).toThrowError(expect.objectContaining({ systemCode: "WINDOWS_RECYCLE_WORKER_IDENTITY_CHANGED" }));
    });
});
