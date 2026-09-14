import * as fs from "node:fs";
import { isAbsolute, normalize } from "node:path";
import {
    DurableFilesystemMutationError,
    SafeFilesystemError,
    type DurableMutationState,
    type PhysicalPathIdentity,
    type SafeFilesystemOperation,
} from "../../filesystem/filesystem-types";
import {
    filesystemEntryKind as entryKind,
    sameFilesystemIdentity as sameIdentity,
    toSafeFilesystemError as safeError,
} from "../../filesystem/filesystem-facts";

export type BigIntStats = fs.BigIntStats;
export type ExpectedEntryKind = PhysicalPathIdentity["entryKind"];

export interface OpenedSafeEntry {
    fd: number;
    stat: BigIntStats;
}

const DESCRIPTOR_ROOT = "/proc/self/fd";

function hasSelectedFilesystemPrimitives(): boolean {
    return (
        process.platform === "linux" &&
        fs.constants.O_NOFOLLOW !== undefined &&
        fs.constants.O_DIRECTORY !== undefined &&
        fs.existsSync(DESCRIPTOR_ROOT)
    );
}

export function descriptorPath(fd: number, childName?: string): string {
    return childName === undefined ? `${DESCRIPTOR_ROOT}/${fd}` : `${DESCRIPTOR_ROOT}/${fd}/${childName}`;
}

export function assertSelectedFilesystemSupported(operation: SafeFilesystemOperation, targetPath: string): void {
    if (hasSelectedFilesystemPrimitives()) return;
    throw new SafeFilesystemError({
        failureKind: "unsupported_platform",
        operation,
        targetPath,
        message: "descriptor-safe filesystem operations are not available on this platform",
    });
}

export function assertCanonicalAbsolutePath(targetPath: string, operation: SafeFilesystemOperation): void {
    if (
        targetPath.includes("\0") ||
        !isAbsolute(targetPath) ||
        (targetPath.length > 1 && targetPath.endsWith("/")) ||
        normalize(targetPath) !== targetPath
    ) {
        throw new SafeFilesystemError({
            failureKind: "invalid_path",
            operation,
            targetPath,
            message: `${operation} requires a canonical absolute path`,
        });
    }
}

export function physicalIdentity(stat: BigIntStats): PhysicalPathIdentity {
    const kind = entryKind(stat);
    if (kind === null) {
        throw new Error("physicalIdentity requires a regular file or directory");
    }
    return {
        deviceId: stat.dev.toString(10),
        fileId: stat.ino.toString(10),
        entryKind: kind,
    };
}

export function closeQuietly(fd: number): void {
    try {
        fs.closeSync(fd);
    } catch {
        // Best effort only; preserve the operation's primary failure.
    }
}

export function inspectChildWithoutFollowing(
    parentFd: number,
    childName: string,
    operation: SafeFilesystemOperation,
    targetPath: string,
): BigIntStats {
    const childPath = descriptorPath(parentFd, childName);
    let stat: BigIntStats;
    try {
        stat = fs.lstatSync(childPath, { bigint: true });
    } catch (error) {
        throw safeError(error, operation, targetPath);
    }
    if (stat.isSymbolicLink()) {
        throw new SafeFilesystemError({
            failureKind: "symlink_or_reparse",
            operation,
            targetPath,
            message: `${operation} rejected a symbolic-link path segment`,
        });
    }
    return stat;
}

export function openChildNoFollow(
    parentFd: number,
    childName: string,
    expectedKind: ExpectedEntryKind,
    operation: SafeFilesystemOperation,
    targetPath: string,
): OpenedSafeEntry {
    const before = inspectChildWithoutFollowing(parentFd, childName, operation, targetPath);
    if (entryKind(before) !== expectedKind) {
        throw new SafeFilesystemError({
            failureKind: "wrong_entry_type",
            operation,
            targetPath,
            message: `${operation} expected a regular ${expectedKind}`,
        });
    }

    const flags =
        fs.constants.O_RDONLY |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK |
        (expectedKind === "directory" ? fs.constants.O_DIRECTORY : 0);
    let fd: number;
    try {
        fd = fs.openSync(descriptorPath(parentFd, childName), flags);
    } catch (error) {
        try {
            const afterFailure = fs.lstatSync(descriptorPath(parentFd, childName), {
                bigint: true,
            });
            if (afterFailure.isSymbolicLink()) {
                throw new SafeFilesystemError({
                    failureKind: "symlink_or_reparse",
                    operation,
                    targetPath,
                    message: `${operation} rejected a replaced symbolic-link entry`,
                });
            }
        } catch (diagnosticError) {
            if (diagnosticError instanceof SafeFilesystemError) {
                throw diagnosticError;
            }
        }
        throw safeError(error, operation, targetPath);
    }

    try {
        const after = fs.fstatSync(fd, { bigint: true });
        if (!sameIdentity(before, after) || entryKind(after) !== expectedKind) {
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation,
                targetPath,
                message: `${operation} observed an identity replacement while opening`,
            });
        }
        return { fd, stat: after };
    } catch (error) {
        closeQuietly(fd);
        throw safeError(error, operation, targetPath);
    }
}

export function openAbsolutePathNoFollow(
    targetPath: string,
    expectedKind: ExpectedEntryKind,
    operation: SafeFilesystemOperation,
): OpenedSafeEntry {
    assertSelectedFilesystemSupported(operation, targetPath);
    assertCanonicalAbsolutePath(targetPath, operation);

    let currentFd: number;
    try {
        currentFd = fs.openSync("/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    } catch (error) {
        throw safeError(error, operation, targetPath);
    }

    const segments = targetPath.split("/").filter((segment) => segment !== "");
    if (segments.length === 0) {
        const stat = fs.fstatSync(currentFd, { bigint: true });
        if (expectedKind !== "directory") {
            closeQuietly(currentFd);
            throw new SafeFilesystemError({
                failureKind: "wrong_entry_type",
                operation,
                targetPath,
                message: `${operation} expected a regular ${expectedKind}`,
            });
        }
        return { fd: currentFd, stat };
    }

    try {
        for (const [index, segment] of segments.entries()) {
            const isFinal = index === segments.length - 1;
            const next = openChildNoFollow(currentFd, segment, isFinal ? expectedKind : "directory", operation, targetPath);
            closeQuietly(currentFd);
            currentFd = next.fd;
            if (isFinal) return next;
        }
    } catch (error) {
        closeQuietly(currentFd);
        throw safeError(error, operation, targetPath);
    }

    closeQuietly(currentFd);
    throw new SafeFilesystemError({
        failureKind: "io_error",
        operation,
        targetPath,
        message: `${operation} did not resolve a final path entry`,
    });
}

export function durableMutationError(
    error: unknown,
    targetPath: string,
    mutationState: DurableMutationState,
    operation: SafeFilesystemOperation = "durable_replace_file",
): DurableFilesystemMutationError {
    const source = safeError(error, operation, targetPath);
    return new DurableFilesystemMutationError({
        operation,
        failureKind: source.failureKind,
        targetPath,
        systemCode: source.systemCode,
        message: source.message,
        mutationState,
    });
}
