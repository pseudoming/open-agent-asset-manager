import * as fs from "node:fs";
import {
    type LocalProcessExecutableIdentity,
    type LocalProcessObservation,
    validateLocalProcessExecutableObservationInput,
    validateLocalProcessObservationInput,
    validateLocalProcessTableEntryLimit,
} from "../path-environment";
import { SafeFilesystemError, type SafeFilesystemOperation } from "../../filesystem/filesystem-types";
import {
    sameFilesystemIdentity,
    samePhysicalPathIdentity,
    toSafeFilesystemError as safeError,
} from "../../filesystem/filesystem-facts";
import {
    closeQuietly,
    descriptorPath,
    openAbsolutePathNoFollow,
    openChildNoFollow,
    physicalIdentity,
    type OpenedSafeEntry,
} from "./descriptor-filesystem";
import { readVolatileDirectoryEntriesBounded } from "./safe-filesystem";

const PROCESS_STAT_MAXIMUM_BYTES = 16_384;
const OPERATION: SafeFilesystemOperation = "observe_local_process";

export function listLocalProcessIdsBounded(maximumEntries: number): number[] {
    validateLocalProcessTableEntryLimit(maximumEntries);
    return readVolatileDirectoryEntriesBounded("/proc", maximumEntries)
        .flatMap((entry) => {
            if (entry.entryKind !== "directory" || !/^[1-9][0-9]*$/u.test(entry.name)) return [];
            const processId = Number(entry.name);
            return Number.isSafeInteger(processId) ? [processId] : [];
        })
        .sort((left, right) => left - right);
}

/**
 * Return the conservative Unix-like candidate inventory for one executable.
 *
 * `/proc/<pid>/exe` physical identity remains the authority. Unlike Win32,
 * Linux has no lossless executable-name field in the directory inventory, so
 * this prefilter intentionally retains every PID and lets the exact observer
 * reject unrelated processes without weakening identity validation.
 */
export function listLocalProcessExecutableCandidateIdsBounded(expectedExecutablePath: string, maximumEntries: number): number[] {
    validateLocalProcessExecutableObservationInput(expectedExecutablePath);
    return listLocalProcessIdsBounded(maximumEntries);
}

function resourceLimit(targetPath: string, message: string): SafeFilesystemError {
    return new SafeFilesystemError({
        failureKind: "resource_limit",
        operation: OPERATION,
        targetPath,
        message,
    });
}

function stale(targetPath: string, message: string): SafeFilesystemError {
    return new SafeFilesystemError({
        failureKind: "stale",
        operation: OPERATION,
        targetPath,
        message,
    });
}

function readOpenedPseudoFileBounded(
    processDirectory: OpenedSafeEntry,
    childName: "cmdline" | "stat",
    maximumBytes: number,
    targetPath: string,
): Uint8Array {
    const opened = openChildNoFollow(processDirectory.fd, childName, "file", OPERATION, targetPath);
    try {
        const bytes = Buffer.allocUnsafe(maximumBytes + 1);
        let offset = 0;
        while (offset < bytes.byteLength) {
            const count = fs.readSync(opened.fd, bytes, offset, bytes.byteLength - offset, null);
            if (count === 0) break;
            offset += count;
        }
        if (offset > maximumBytes) {
            throw resourceLimit(targetPath, `${childName} exceeds the caller's bounded-read byte limit`);
        }
        return new Uint8Array(bytes.buffer, bytes.byteOffset, offset);
    } catch (error) {
        throw safeError(error, OPERATION, targetPath);
    } finally {
        closeQuietly(opened.fd);
    }
}

function parseStartTime(processId: number, statBytes: Uint8Array, targetPath: string): string {
    const stat = Buffer.from(statBytes).toString("latin1").trim();
    const prefix = `${processId} (`;
    const closingDelimiter = stat.lastIndexOf(") ");
    if (!stat.startsWith(prefix) || closingDelimiter < prefix.length) {
        throw new SafeFilesystemError({
            failureKind: "io_error",
            operation: OPERATION,
            targetPath,
            systemCode: "INVALID_PROC_STAT",
            message: "local process stat has an invalid identity prefix",
        });
    }
    const fieldsFromState = stat
        .slice(closingDelimiter + 2)
        .trim()
        .split(/\s+/u);
    const startTime = fieldsFromState[19];
    if (startTime === undefined || !/^[0-9]+$/u.test(startTime)) {
        throw new SafeFilesystemError({
            failureKind: "io_error",
            operation: OPERATION,
            targetPath,
            systemCode: "INVALID_PROC_STAT",
            message: "local process stat does not contain a valid lifecycle token",
        });
    }
    return startTime;
}

function readStartTime(processId: number, processDirectory: OpenedSafeEntry, targetPath: string): string {
    return parseStartTime(
        processId,
        readOpenedPseudoFileBounded(processDirectory, "stat", PROCESS_STAT_MAXIMUM_BYTES, targetPath),
        targetPath,
    );
}

function inspectExecutable(processDirectory: OpenedSafeEntry, targetPath: string): LocalProcessObservation["executableIdentity"] {
    const executableLinkPath = descriptorPath(processDirectory.fd, "exe");
    try {
        const link = fs.lstatSync(executableLinkPath, { bigint: true });
        if (!link.isSymbolicLink()) {
            throw new SafeFilesystemError({
                failureKind: "wrong_entry_type",
                operation: OPERATION,
                targetPath,
                systemCode: "INVALID_PROC_EXE",
                message: "local process executable reference is not the expected kernel-owned link",
            });
        }

        const fd = fs.openSync(executableLinkPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        try {
            const before = fs.fstatSync(fd, { bigint: true });
            const after = fs.fstatSync(fd, { bigint: true });
            if (!before.isFile() || !after.isFile()) {
                throw new SafeFilesystemError({
                    failureKind: "wrong_entry_type",
                    operation: OPERATION,
                    targetPath,
                    systemCode: "INVALID_PROC_EXE",
                    message: "local process executable reference did not resolve to a regular file",
                });
            }
            if (!sameFilesystemIdentity(before, after)) {
                throw stale(targetPath, "local process executable identity changed while it was inspected");
            }
            return physicalIdentity(after) as LocalProcessObservation["executableIdentity"];
        } finally {
            closeQuietly(fd);
        }
    } catch (error) {
        throw safeError(error, OPERATION, targetPath);
    }
}

/**
 * Bind one Linux/WSL process observation to a single `/proc/<pid>` directory.
 *
 * The fixed kernel `exe` link is the only intentionally followed entry. PID
 * lifecycle and executable identity are sampled around the bounded command
 * line read so a reused PID or concurrent exec fails closed.
 */
export function observeLocalProcessBounded(
    processId: number,
    expectedExecutableIdentity: LocalProcessExecutableIdentity,
    maximumCommandLineBytes: number,
): LocalProcessObservation | null {
    validateLocalProcessObservationInput(processId, expectedExecutableIdentity, maximumCommandLineBytes);
    const targetPath = `/proc/${processId}`;
    const processDirectory = openAbsolutePathNoFollow(targetPath, "directory", OPERATION);
    try {
        const directoryBefore = fs.fstatSync(processDirectory.fd, { bigint: true });
        const lifecycleBefore = readStartTime(processId, processDirectory, targetPath);
        const executableBefore = inspectExecutable(processDirectory, targetPath);
        if (!samePhysicalPathIdentity(executableBefore, expectedExecutableIdentity)) {
            return null;
        }
        const commandLineBytes = readOpenedPseudoFileBounded(processDirectory, "cmdline", maximumCommandLineBytes, targetPath);
        const executableAfter = inspectExecutable(processDirectory, targetPath);
        const lifecycleAfter = readStartTime(processId, processDirectory, targetPath);
        const directoryAfter = fs.fstatSync(processDirectory.fd, { bigint: true });

        if (
            lifecycleBefore !== lifecycleAfter ||
            !sameFilesystemIdentity(directoryBefore, directoryAfter) ||
            !samePhysicalPathIdentity(executableBefore, executableAfter) ||
            !samePhysicalPathIdentity(executableAfter, expectedExecutableIdentity)
        ) {
            throw stale(targetPath, "local process identity changed while it was observed");
        }

        return {
            processId,
            lifecycleToken: lifecycleAfter,
            executableIdentity: executableAfter,
            commandLineBytes,
        };
    } catch (error) {
        throw safeError(error, OPERATION, targetPath);
    } finally {
        closeQuietly(processDirectory.fd);
    }
}

/**
 * Path-aware process observation used by cross-platform callers.
 *
 * Linux/WSL binds the running image through `/proc/<pid>/exe` physical
 * identity. The expected path remains an input-integrity assertion here;
 * Win32 additionally uses it for a name prefilter before opening a process.
 */
export function observeLocalProcessExecutableBounded(
    processId: number,
    expectedExecutablePath: string,
    expectedExecutableIdentity: LocalProcessExecutableIdentity,
    maximumCommandLineBytes: number,
): LocalProcessObservation | null {
    validateLocalProcessExecutableObservationInput(expectedExecutablePath);
    return observeLocalProcessBounded(processId, expectedExecutableIdentity, maximumCommandLineBytes);
}
