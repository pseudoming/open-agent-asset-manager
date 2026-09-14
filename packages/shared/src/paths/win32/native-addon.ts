import { createRequire } from "node:module";
import * as path from "node:path";
import { samePhysicalPathIdentity } from "../../filesystem/filesystem-facts";
import {
    DurableFilesystemMutationError,
    type DurableMutationState,
    type EnsuredDirectory,
    type PhysicalPathIdentity,
    SafeFilesystemError,
    type SafeFilesystemFailureKind,
    type SafeFilesystemOperation,
    type StableDirectoryInventory,
    type StableDirectoryInventoryEntry,
    type StableRegularFileRangeRead,
    type StableRegularFileRead,
} from "../../filesystem/filesystem-types";
import type {
    LocalExecutableEnvironmentEntry,
    LocalExecutableTreeInvocationResult,
    LocalProcessExecutableIdentity,
    LocalProcessObservation,
    OwnedInvocationProcessIdentity,
} from "../path-environment";
import type { Win32NativeFilesystemAddon } from "./native-addon-contract";

export type { Win32NativeFilesystemAddon } from "./native-addon-contract";

const CONTRACT_VERSION = "oaam.win32.filesystem.v15";
const FAILURE_KINDS = new Set<SafeFilesystemFailureKind>([
    "invalid_path",
    "not_found",
    "permission_denied",
    "symlink_or_reparse",
    "wrong_entry_type",
    "resource_limit",
    "stale",
    "unsupported_platform",
    "io_error",
]);
const MUTATION_STATES = new Set<DurableMutationState>(["not_applied", "may_have_applied"]);
const RAW_EXPORT_NAMES = [
    "acquireLock",
    "confirmDurableDirectory",
    "confirmDurableDirectoryTree",
    "confirmDurableRegularFile",
    "contractVersion",
    "createFile",
    "ensureDirectory",
    "inspectDirectory",
    "inspectRegularFile",
    "inventoryDirectory",
    "invokeLocalExecutableTreeBounded",
    "listLocalProcessExecutableCandidateIdsBounded",
    "listLocalProcessIdsBounded",
    "observeLocalProcessBounded",
    "observeLocalProcessExecutableBounded",
    "publishDirectory",
    "publishFile",
    "readRegularFile",
    "readRegularFileRange",
    "releaseLock",
    "recycleDirectoryTreeIfIdentity",
    "removeDirectoryTree",
    "removeRegularFile",
    "permanentlyRemoveRegularFileIfIdentity",
    "recycleRegularFileIfIdentity",
    "replaceFile",
] as const;

interface RawWin32NativeAddon {
    readonly contractVersion: unknown;
    readonly readRegularFile: (filePath: string, maximumBytes: number) => unknown;
    readonly readRegularFileRange: (filePath: string, byteOffset: number, maximumBytes: number) => unknown;
    readonly inspectRegularFile: (filePath: string) => unknown;
    readonly inspectDirectory: (directoryPath: string) => unknown;
    readonly inventoryDirectory: (directoryPath: string, maximumEntries: number) => unknown;
    readonly listLocalProcessExecutableCandidateIdsBounded: (expectedExecutablePath: string, maximumEntries: number) => unknown;
    readonly listLocalProcessIdsBounded: (maximumEntries: number) => unknown;
    readonly observeLocalProcessBounded: (
        processId: number,
        expectedExecutableIdentity: LocalProcessExecutableIdentity,
        maximumCommandLineBytes: number,
    ) => unknown;
    readonly observeLocalProcessExecutableBounded: (
        processId: number,
        expectedExecutablePath: string,
        expectedExecutableIdentity: LocalProcessExecutableIdentity,
        maximumCommandLineBytes: number,
    ) => unknown;
    readonly invokeLocalExecutableTreeBounded: (
        executablePath: string,
        expectedExecutableIdentity: LocalProcessExecutableIdentity,
        arguments_: readonly string[],
        workingDirectory: string,
        environmentEntries: readonly LocalExecutableEnvironmentEntry[],
        invocationToken: string,
        timeoutMilliseconds: number,
        maximumOutputBytes: number,
    ) => unknown;
    readonly confirmDurableRegularFile: (filePath: string) => unknown;
    readonly confirmDurableDirectory: (directoryPath: string) => unknown;
    readonly confirmDurableDirectoryTree: (directoryPath: string, maximumEntries: number) => unknown;
    readonly ensureDirectory: (parentPath: string, childName: string) => unknown;
    readonly createFile: (filePath: string, bytes: Buffer) => unknown;
    readonly replaceFile: (filePath: string, bytes: Buffer) => unknown;
    readonly removeRegularFile: (filePath: string) => unknown;
    readonly permanentlyRemoveRegularFileIfIdentity: (filePath: string, expectedIdentity: PhysicalPathIdentity) => unknown;
    readonly recycleRegularFileIfIdentity: (filePath: string, expectedIdentity: PhysicalPathIdentity) => unknown;
    readonly recycleDirectoryTreeIfIdentity: (
        directoryPath: string,
        expectedIdentity: PhysicalPathIdentity,
        maximumEntries: number,
    ) => unknown;
    readonly removeDirectoryTree: (directoryPath: string, maximumEntries: number) => unknown;
    readonly publishFile: (sourcePath: string, targetParentPath: string, targetName: string) => PhysicalPathIdentity;
    readonly publishDirectory: (
        stagedDirectoryPath: string,
        targetParentPath: string,
        targetName: string,
        maximumEntries: number,
    ) => unknown;
    readonly acquireLock: (lockPath: string) => unknown;
    readonly releaseLock: (lockToken: unknown) => unknown;
}

type NativeRequire = (specifier: string) => unknown;

function protocolFailure(operation: SafeFilesystemOperation, targetPath: string, message: string): SafeFilesystemError {
    return new SafeFilesystemError({
        failureKind: "io_error",
        operation,
        targetPath,
        systemCode: "NATIVE_PROTOCOL_VIOLATION",
        message,
    });
}

function translateNativeFailure(
    error: unknown,
    operation: SafeFilesystemOperation,
    targetPath: string,
    mutation: boolean,
): SafeFilesystemError {
    if (error instanceof DurableFilesystemMutationError) return error;
    if (error instanceof SafeFilesystemError) {
        if (!mutation) return error;
        return new DurableFilesystemMutationError({
            operation,
            failureKind: error.failureKind,
            targetPath,
            systemCode: error.systemCode,
            message: error.message,
            mutationState: "may_have_applied",
        });
    }
    if (error instanceof Error) {
        const failureKind = "failureKind" in error ? (error as { failureKind?: unknown }).failureKind : undefined;
        const systemCode = "systemCode" in error ? (error as { systemCode?: unknown }).systemCode : undefined;
        const mutationState = "mutationState" in error ? (error as { mutationState?: unknown }).mutationState : undefined;
        if (
            typeof failureKind === "string" &&
            FAILURE_KINDS.has(failureKind as SafeFilesystemFailureKind) &&
            typeof systemCode === "string" &&
            systemCode.length > 0
        ) {
            if (mutation) {
                return new DurableFilesystemMutationError({
                    operation,
                    failureKind: failureKind as SafeFilesystemFailureKind,
                    targetPath,
                    systemCode,
                    message: error.message,
                    mutationState:
                        typeof mutationState === "string" && MUTATION_STATES.has(mutationState as DurableMutationState)
                            ? (mutationState as DurableMutationState)
                            : "may_have_applied",
                });
            }
            return new SafeFilesystemError({
                failureKind: failureKind as SafeFilesystemFailureKind,
                operation,
                targetPath,
                systemCode,
                message: error.message,
            });
        }
    }
    const protocol = protocolFailure(operation, targetPath, `${operation} received an untyped native failure`);
    if (!mutation) return protocol;
    return new DurableFilesystemMutationError({
        operation,
        failureKind: protocol.failureKind,
        targetPath,
        systemCode: protocol.systemCode,
        message: protocol.message,
        mutationState: "may_have_applied",
    });
}

function requireRecord(
    value: unknown,
    operation: SafeFilesystemOperation,
    targetPath: string,
    label: string,
): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw protocolFailure(operation, targetPath, `${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireIdentity(
    value: unknown,
    expectedKind: PhysicalPathIdentity["entryKind"],
    operation: SafeFilesystemOperation,
    targetPath: string,
): PhysicalPathIdentity {
    const record = requireRecord(value, operation, targetPath, "native identity");
    if (
        typeof record.deviceId !== "string" ||
        !/^\d+$/u.test(record.deviceId) ||
        typeof record.fileId !== "string" ||
        !/^[0-9a-f]{32}$/u.test(record.fileId) ||
        record.entryKind !== expectedKind
    ) {
        throw protocolFailure(operation, targetPath, "native identity does not match the reviewed contract");
    }
    return {
        deviceId: record.deviceId,
        fileId: record.fileId,
        entryKind: expectedKind,
    };
}

function requireReadResult(value: unknown, targetPath: string, maximumBytes: number): StableRegularFileRead {
    const operation = "read_regular_file";
    const record = requireRecord(value, operation, targetPath, "native read result");
    if (
        !(record.bytes instanceof Uint8Array) ||
        record.bytes.byteLength > maximumBytes ||
        typeof record.executable !== "boolean"
    ) {
        throw protocolFailure(operation, targetPath, "native read result does not match the reviewed contract");
    }
    return {
        bytes: new Uint8Array(record.bytes),
        executable: record.executable,
        identity: requireIdentity(record.identity, "file", operation, targetPath),
    };
}

function requireConfirmedReadResult(value: unknown, targetPath: string): StableRegularFileRead {
    return requireReadResult(value, targetPath, Number.MAX_SAFE_INTEGER);
}

function requireRangeReadResult(
    value: unknown,
    targetPath: string,
    byteOffset: number,
    maximumBytes: number,
): StableRegularFileRangeRead {
    const operation = "read_regular_file";
    const record = requireRecord(value, operation, targetPath, "native range read result");
    if (
        !(record.bytes instanceof Uint8Array) ||
        record.bytes.byteLength > maximumBytes ||
        record.byteOffset !== byteOffset ||
        !Number.isSafeInteger(record.totalBytes) ||
        (record.totalBytes as number) < byteOffset + record.bytes.byteLength ||
        typeof record.executable !== "boolean"
    ) {
        throw protocolFailure(operation, targetPath, "native range read result does not match the reviewed contract");
    }
    return {
        bytes: new Uint8Array(record.bytes),
        byteOffset,
        totalBytes: record.totalBytes as number,
        executable: record.executable,
        identity: requireIdentity(record.identity, "file", operation, targetPath),
    };
}

function requireInventoryResult(value: unknown, targetPath: string, maximumEntries: number): StableDirectoryInventory {
    const operation = "inventory_directory";
    const record = requireRecord(value, operation, targetPath, "native inventory result");
    if (!Array.isArray(record.entries) || record.entries.length > maximumEntries) {
        throw protocolFailure(operation, targetPath, "native inventory entries exceed the reviewed contract");
    }
    const entries: StableDirectoryInventoryEntry[] = [];
    let previousName: string | null = null;
    for (const rawEntry of record.entries) {
        const entry = requireRecord(rawEntry, operation, targetPath, "native inventory entry");
        if (
            typeof entry.relativeName !== "string" ||
            entry.relativeName.length === 0 ||
            entry.relativeName === "." ||
            entry.relativeName === ".." ||
            entry.relativeName.includes("/") ||
            entry.relativeName.includes("\\") ||
            entry.relativeName.includes("\0") ||
            (previousName !== null && previousName >= entry.relativeName)
        ) {
            throw protocolFailure(operation, targetPath, "native inventory names are not canonical and strictly ordered");
        }
        const identityRecord = requireRecord(entry.identity, operation, targetPath, "native inventory identity");
        if (identityRecord.entryKind !== "file" && identityRecord.entryKind !== "directory") {
            throw protocolFailure(operation, targetPath, "native inventory entry has an unsupported kind");
        }
        entries.push({
            relativeName: entry.relativeName,
            identity: requireIdentity(entry.identity, identityRecord.entryKind, operation, targetPath),
        });
        previousName = entry.relativeName;
    }
    return {
        identity: requireIdentity(record.identity, "directory", operation, targetPath),
        entries,
    };
}

function requireProcessIds(value: unknown, maximumEntries: number): number[] {
    const operation = "observe_local_process";
    const targetPath = "process-table";
    if (!Array.isArray(value) || value.length > maximumEntries) {
        throw protocolFailure(operation, targetPath, "native process inventory exceeds the reviewed contract");
    }
    let previous = 0;
    return value.map((processId) => {
        if (!Number.isSafeInteger(processId) || processId <= previous) {
            throw protocolFailure(operation, targetPath, "native process inventory is not strictly ordered");
        }
        previous = processId;
        return processId;
    });
}

function requireProcessObservation(
    value: unknown,
    processId: number,
    expectedExecutableIdentity: LocalProcessExecutableIdentity,
    maximumCommandLineBytes: number,
): LocalProcessObservation | null {
    if (value === null) return null;
    const operation = "observe_local_process";
    const targetPath = `process:${processId}`;
    const record = requireRecord(value, operation, targetPath, "native process observation");
    if (
        record.processId !== processId ||
        typeof record.lifecycleToken !== "string" ||
        !/^[0-9]+$/u.test(record.lifecycleToken) ||
        !(record.commandLineBytes instanceof Uint8Array) ||
        record.commandLineBytes.byteLength > maximumCommandLineBytes
    ) {
        throw protocolFailure(operation, targetPath, "native process observation does not match the reviewed contract");
    }
    const executableIdentity = requireIdentity(
        record.executableIdentity,
        "file",
        operation,
        targetPath,
    ) as LocalProcessExecutableIdentity;
    if (!samePhysicalPathIdentity(executableIdentity, expectedExecutableIdentity)) {
        throw protocolFailure(operation, targetPath, "native process observation returned an unexpected executable identity");
    }
    return {
        processId,
        lifecycleToken: record.lifecycleToken,
        executableIdentity,
        commandLineBytes: new Uint8Array(record.commandLineBytes),
    };
}

function requireOwnedProcessIdentity(
    value: unknown,
    operation: SafeFilesystemOperation,
    targetPath: string,
): OwnedInvocationProcessIdentity {
    const record = requireRecord(value, operation, targetPath, "owned invocation process identity");
    if (
        !Number.isSafeInteger(record.processId) ||
        (record.processId as number) <= 0 ||
        typeof record.lifecycleToken !== "string" ||
        !/^[0-9]+$/u.test(record.lifecycleToken)
    ) {
        throw protocolFailure(operation, targetPath, "owned invocation process identity is invalid");
    }
    return {
        processId: record.processId as number,
        lifecycleToken: record.lifecycleToken,
    };
}

/** @internal Revalidate the same native receipt after private worker transfer; not a public package export. */
export function requireLocalExecutableTreeInvocationResult(
    value: unknown,
    executablePath: string,
    maximumOutputBytes: number,
): LocalExecutableTreeInvocationResult {
    const operation = "invoke_local_executable";
    const record = requireRecord(value, operation, executablePath, "native executable invocation result");
    if (
        !["complete", "failed", "timed_out", "cleanup_failed"].includes(String(record.status)) ||
        (record.exitCode !== null && (!Number.isSafeInteger(record.exitCode) || (record.exitCode as number) < 0)) ||
        record.signal !== null ||
        !(record.stdout instanceof Uint8Array) ||
        !(record.stderr instanceof Uint8Array) ||
        record.stdout.byteLength + record.stderr.byteLength > maximumOutputBytes ||
        !Array.isArray(record.observedProcesses) ||
        record.observedProcesses.length > 65_536 ||
        typeof record.cleanupComplete !== "boolean" ||
        typeof record.invocationTokenAbsent !== "boolean" ||
        typeof record.failureCode !== "string"
    ) {
        throw protocolFailure(operation, executablePath, "native executable invocation result is invalid");
    }
    const rootProcess = requireOwnedProcessIdentity(record.rootProcess, operation, executablePath);
    const observedProcesses = record.observedProcesses.map((item) =>
        requireOwnedProcessIdentity(item, operation, executablePath),
    );
    const matchingRootProcesses = observedProcesses.filter(
        (item) => item.processId === rootProcess.processId && item.lifecycleToken === rootProcess.lifecycleToken,
    );
    const retainsNaturalExitStderr =
        record.status === "failed" &&
        record.failureCode === "exit" &&
        typeof record.exitCode === "number" &&
        record.exitCode !== 0 &&
        record.cleanupComplete === true &&
        record.invocationTokenAbsent === true;
    if (
        observedProcesses.length === 0 ||
        matchingRootProcesses.length !== 1 ||
        observedProcesses.some((item, index) => index > 0 && item.processId <= (observedProcesses[index - 1]?.processId ?? 0)) ||
        (record.status === "complete" &&
            (record.exitCode !== 0 ||
                record.cleanupComplete !== true ||
                record.invocationTokenAbsent !== true ||
                record.failureCode !== "")) ||
        (record.status !== "complete" &&
            (record.stdout.byteLength !== 0 || (!retainsNaturalExitStderr && record.stderr.byteLength !== 0)))
    ) {
        throw protocolFailure(operation, executablePath, "native executable invocation result is inconsistent");
    }
    return {
        status: record.status as LocalExecutableTreeInvocationResult["status"],
        exitCode: record.exitCode as number | null,
        signal: null,
        stdout: new Uint8Array(record.stdout),
        stderr: new Uint8Array(record.stderr),
        rootProcess,
        observedProcesses,
        cleanupComplete: record.cleanupComplete,
        invocationTokenAbsent: record.invocationTokenAbsent,
        failureCode: record.failureCode,
    };
}

function requireEnsuredDirectory(value: unknown, targetPath: string): EnsuredDirectory {
    const operation = "durable_ensure_directory";
    const record = requireRecord(value, operation, targetPath, "native ensured-directory result");
    if (typeof record.created !== "boolean") {
        throw protocolFailure(operation, targetPath, "native ensured-directory result has an invalid created flag");
    }
    return {
        identity: requireIdentity(record.identity, "directory", operation, targetPath),
        created: record.created,
    };
}

function requireBoolean(value: unknown, operation: SafeFilesystemOperation, targetPath: string): boolean {
    if (typeof value !== "boolean") {
        throw protocolFailure(operation, targetPath, "native operation did not return a boolean");
    }
    return value;
}

function requireRawAddon(value: unknown): RawWin32NativeAddon {
    const record = requireRecord(value, "read_regular_file", "<native-addon>", "native addon");
    if (
        JSON.stringify(Object.getOwnPropertyNames(record).sort()) !== JSON.stringify([...RAW_EXPORT_NAMES].sort()) ||
        record.contractVersion !== CONTRACT_VERSION ||
        RAW_EXPORT_NAMES.some((name) => name !== "contractVersion" && typeof record[name] !== "function")
    ) {
        throw protocolFailure("read_regular_file", "<native-addon>", "native addon export contract is invalid");
    }
    return record as unknown as RawWin32NativeAddon;
}

function invoke<T>(operation: SafeFilesystemOperation, targetPath: string, mutation: boolean, action: () => T): T {
    try {
        return action();
    } catch (error) {
        throw translateNativeFailure(error, operation, targetPath, mutation);
    }
}

export function loadWin32NativeFilesystemAddon(
    requireNative: NativeRequire = createRequire(__filename),
): Win32NativeFilesystemAddon {
    const native = requireRawAddon(requireNative("./native/oaam_windows_filesystem.node"));
    const addon: Win32NativeFilesystemAddon = {
        readRegularFile(filePath, maximumBytes) {
            return invoke("read_regular_file", filePath, false, () =>
                requireReadResult(native.readRegularFile(filePath, maximumBytes), filePath, maximumBytes),
            );
        },
        readRegularFileRange(filePath, byteOffset, maximumBytes) {
            return invoke("read_regular_file", filePath, false, () =>
                requireRangeReadResult(
                    native.readRegularFileRange(filePath, byteOffset, maximumBytes),
                    filePath,
                    byteOffset,
                    maximumBytes,
                ),
            );
        },
        inspectRegularFile(filePath) {
            return invoke("inspect_regular_file", filePath, false, () =>
                requireIdentity(native.inspectRegularFile(filePath), "file", "inspect_regular_file", filePath),
            );
        },
        inspectDirectory(directoryPath) {
            return invoke("inspect_directory", directoryPath, false, () =>
                requireIdentity(native.inspectDirectory(directoryPath), "directory", "inspect_directory", directoryPath),
            );
        },
        inventoryDirectory(directoryPath, maximumEntries) {
            return invoke("inventory_directory", directoryPath, false, () =>
                requireInventoryResult(native.inventoryDirectory(directoryPath, maximumEntries), directoryPath, maximumEntries),
            );
        },
        listLocalProcessExecutableCandidateIdsBounded(expectedExecutablePath, maximumEntries) {
            return invoke("observe_local_process", "process-table", false, () =>
                requireProcessIds(
                    native.listLocalProcessExecutableCandidateIdsBounded(expectedExecutablePath, maximumEntries),
                    maximumEntries,
                ),
            );
        },
        listLocalProcessIdsBounded(maximumEntries) {
            return invoke("observe_local_process", "process-table", false, () =>
                requireProcessIds(native.listLocalProcessIdsBounded(maximumEntries), maximumEntries),
            );
        },
        observeLocalProcessBounded(processId, expectedExecutableIdentity, maximumCommandLineBytes) {
            return invoke("observe_local_process", `process:${processId}`, false, () =>
                requireProcessObservation(
                    native.observeLocalProcessBounded(processId, expectedExecutableIdentity, maximumCommandLineBytes),
                    processId,
                    expectedExecutableIdentity,
                    maximumCommandLineBytes,
                ),
            );
        },
        observeLocalProcessExecutableBounded(
            processId,
            expectedExecutablePath,
            expectedExecutableIdentity,
            maximumCommandLineBytes,
        ) {
            return invoke("observe_local_process", `process:${processId}`, false, () =>
                requireProcessObservation(
                    native.observeLocalProcessExecutableBounded(
                        processId,
                        expectedExecutablePath,
                        expectedExecutableIdentity,
                        maximumCommandLineBytes,
                    ),
                    processId,
                    expectedExecutableIdentity,
                    maximumCommandLineBytes,
                ),
            );
        },
        invokeLocalExecutableTreeBounded(
            executablePath,
            expectedExecutableIdentity,
            arguments_,
            workingDirectory,
            environmentEntries,
            invocationToken,
            timeoutMilliseconds,
            maximumOutputBytes,
        ) {
            return invoke("invoke_local_executable", executablePath, false, () =>
                requireLocalExecutableTreeInvocationResult(
                    native.invokeLocalExecutableTreeBounded(
                        executablePath,
                        expectedExecutableIdentity,
                        arguments_,
                        workingDirectory,
                        environmentEntries,
                        invocationToken,
                        timeoutMilliseconds,
                        maximumOutputBytes,
                    ),
                    executablePath,
                    maximumOutputBytes,
                ),
            );
        },
        confirmDurableRegularFile(filePath) {
            return invoke("confirm_durable_file", filePath, false, () =>
                requireConfirmedReadResult(native.confirmDurableRegularFile(filePath), filePath),
            );
        },
        confirmDurableDirectory(directoryPath) {
            return invoke("confirm_durable_directory", directoryPath, false, () =>
                requireIdentity(
                    native.confirmDurableDirectory(directoryPath),
                    "directory",
                    "confirm_durable_directory",
                    directoryPath,
                ),
            );
        },
        confirmDurableDirectoryTree(directoryPath, maximumEntries) {
            return invoke("confirm_durable_tree", directoryPath, false, () =>
                requireIdentity(
                    native.confirmDurableDirectoryTree(directoryPath, maximumEntries),
                    "directory",
                    "confirm_durable_tree",
                    directoryPath,
                ),
            );
        },
        ensureDirectory(parentPath, childName) {
            const targetPath = path.win32.join(parentPath, childName);
            return invoke("durable_ensure_directory", targetPath, true, () =>
                requireEnsuredDirectory(native.ensureDirectory(parentPath, childName), targetPath),
            );
        },
        createFile(filePath, data) {
            return invoke("durable_create_file", filePath, true, () =>
                requireIdentity(native.createFile(filePath, Buffer.from(data)), "file", "durable_create_file", filePath),
            );
        },
        replaceFile(filePath, data) {
            return invoke("durable_replace_file", filePath, true, () =>
                requireIdentity(native.replaceFile(filePath, Buffer.from(data)), "file", "durable_replace_file", filePath),
            );
        },
        removeRegularFile(filePath) {
            return invoke("durable_remove_file", filePath, true, () =>
                requireBoolean(native.removeRegularFile(filePath), "durable_remove_file", filePath),
            );
        },
        permanentlyRemoveRegularFileIfIdentity(filePath, expectedIdentity) {
            return invoke("permanent_remove_file", filePath, true, () =>
                requireBoolean(
                    native.permanentlyRemoveRegularFileIfIdentity(filePath, expectedIdentity),
                    "permanent_remove_file",
                    filePath,
                ),
            );
        },
        recycleRegularFileIfIdentity(filePath, expectedIdentity) {
            return invoke("durable_remove_file", filePath, true, () =>
                requireBoolean(native.recycleRegularFileIfIdentity(filePath, expectedIdentity), "durable_remove_file", filePath),
            );
        },
        recycleDirectoryTreeIfIdentity(directoryPath, expectedIdentity, maximumEntries) {
            return invoke("durable_remove_tree", directoryPath, true, () =>
                requireBoolean(
                    native.recycleDirectoryTreeIfIdentity(directoryPath, expectedIdentity, maximumEntries),
                    "durable_remove_tree",
                    directoryPath,
                ),
            );
        },
        removeDirectoryTree(directoryPath, maximumEntries) {
            return invoke("durable_remove_tree", directoryPath, true, () =>
                requireBoolean(native.removeDirectoryTree(directoryPath, maximumEntries), "durable_remove_tree", directoryPath),
            );
        },
        publishFile(sourcePath, targetParentPath, targetName) {
            const targetPath = path.win32.join(targetParentPath, targetName);
            return invoke("durable_publish_file", targetPath, true, () =>
                requireIdentity(
                    native.publishFile(sourcePath, targetParentPath, targetName),
                    "file",
                    "durable_publish_file",
                    targetPath,
                ),
            );
        },
        publishDirectory(stagedDirectoryPath, targetParentPath, targetName, maximumEntries) {
            const targetPath = path.win32.join(targetParentPath, targetName);
            return invoke("durable_publish_directory", targetPath, true, () =>
                requireIdentity(
                    native.publishDirectory(stagedDirectoryPath, targetParentPath, targetName, maximumEntries),
                    "directory",
                    "durable_publish_directory",
                    targetPath,
                ),
            );
        },
        acquireLock(lockPath) {
            return invoke("lock_file", lockPath, false, () => {
                const token = native.acquireLock(lockPath);
                if (token === null) return null;
                if ((typeof token !== "object" && typeof token !== "function") || token === undefined) {
                    throw protocolFailure("lock_file", lockPath, "native lock token is invalid");
                }
                let released = false;
                return () => {
                    if (released) return;
                    released = true;
                    invoke("lock_file", lockPath, false, () => {
                        const result = native.releaseLock(token);
                        if (result !== undefined) {
                            throw protocolFailure("lock_file", lockPath, "native lock release must return undefined");
                        }
                    });
                };
            });
        },
    };
    return Object.freeze(addon);
}
