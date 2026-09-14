import * as fs from "node:fs";
import { SafeFilesystemError, type SafeFilesystemOperation } from "../../filesystem/filesystem-types";
import {
    sameFilesystemIdentity as sameIdentity,
    sameFilesystemStableSample as sameStableSample,
    toSafeFilesystemError as safeError,
} from "../../filesystem/filesystem-facts";

function assertLimit(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${label} must be a non-negative safe integer`);
    }
}

function resourceLimit(operation: SafeFilesystemOperation, targetPath: string, message: string): SafeFilesystemError {
    return new SafeFilesystemError({
        failureKind: "resource_limit",
        operation,
        targetPath,
        message,
    });
}

function stale(operation: SafeFilesystemOperation, targetPath: string, message: string): SafeFilesystemError {
    return new SafeFilesystemError({
        failureKind: "stale",
        operation,
        targetPath,
        message,
    });
}

type BigIntStats = fs.BigIntStats;

function closeFileQuietly(fd: number): void {
    try {
        fs.closeSync(fd);
    } catch {
        // Preserve the operation's primary failure.
    }
}

/**
 * Read an already-open regular-file descriptor into one allocation sized from
 * the caller's stable pre-read sample. At most one additional byte is read as
 * an overflow sentinel; a growing file is never materialized in full.
 *
 * This is an internal physical-I/O mechanism. Callers still own their policy
 * limits, path authorization, diagnostics, and post-read stability checks.
 */
export function readFileDescriptorBounded(
    fd: number,
    expectedBytes: number,
    maximumBytes: number,
    targetPath: string,
    operation: SafeFilesystemOperation = "read_regular_file",
): Uint8Array {
    assertLimit(expectedBytes, "expectedBytes");
    assertLimit(maximumBytes, "maximumBytes");
    if (expectedBytes > maximumBytes) {
        throw resourceLimit(operation, targetPath, "regular file exceeds the caller's bounded-read byte limit");
    }

    let bytes: Buffer;
    try {
        bytes = Buffer.allocUnsafe(expectedBytes);
    } catch (error) {
        throw safeError(error, operation, targetPath);
    }

    let offset = 0;
    try {
        while (offset < expectedBytes) {
            const count = fs.readSync(fd, bytes, offset, expectedBytes - offset, offset);
            if (count === 0) break;
            offset += count;
        }

        if (offset === expectedBytes) {
            const overflowSentinel = Buffer.allocUnsafe(1);
            const overflow = fs.readSync(fd, overflowSentinel, 0, 1, offset);
            if (overflow !== 0) {
                if (expectedBytes === maximumBytes) {
                    throw resourceLimit(operation, targetPath, "regular file grew beyond the caller's bounded-read byte limit");
                }
                throw stale(operation, targetPath, "regular file grew after the caller's stable pre-read sample");
            }
        }

        return new Uint8Array(bytes.buffer, bytes.byteOffset, offset);
    } catch (error) {
        throw safeError(error, operation, targetPath);
    }
}

/**
 * Portable bounded regular-file read for probe/config discovery. It rejects a
 * symlink seen at either path inspection, binds the read to one opened file
 * identity, and delegates physical allocation to readFileDescriptorBounded.
 */
export function readRegularFileBounded(filePath: string, maximumBytes: number): Uint8Array {
    const operation: SafeFilesystemOperation = "read_regular_file";
    assertLimit(maximumBytes, "maximumBytes");
    let before: BigIntStats;
    try {
        before = fs.lstatSync(filePath, { bigint: true });
        if (before.isSymbolicLink()) {
            throw new SafeFilesystemError({
                failureKind: "symlink_or_reparse",
                operation,
                targetPath: filePath,
                message: "bounded regular-file read rejected a symbolic link",
            });
        }
        if (!before.isFile()) {
            throw new SafeFilesystemError({
                failureKind: "wrong_entry_type",
                operation,
                targetPath: filePath,
                message: "bounded regular-file read expected a regular file",
            });
        }
        if (before.size > BigInt(maximumBytes)) {
            throw resourceLimit(operation, filePath, "regular file exceeds the caller's bounded-read byte limit");
        }
    } catch (error) {
        throw safeError(error, operation, filePath);
    }

    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
    let fd: number;
    try {
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonblock);
    } catch (error) {
        throw safeError(error, operation, filePath);
    }

    try {
        const opened = fs.fstatSync(fd, { bigint: true });
        const pathAfterOpen = fs.lstatSync(filePath, { bigint: true });
        if (
            pathAfterOpen.isSymbolicLink() ||
            !opened.isFile() ||
            !sameIdentity(before, opened) ||
            !sameIdentity(opened, pathAfterOpen)
        ) {
            throw stale(operation, filePath, "bounded regular-file path changed while it was being opened");
        }
        if (opened.size > BigInt(maximumBytes)) {
            throw resourceLimit(
                operation,
                filePath,
                "regular file grew beyond the caller's bounded-read byte limit before reading",
            );
        }
        const bytes = readFileDescriptorBounded(fd, Number(opened.size), maximumBytes, filePath);
        const after = fs.fstatSync(fd, { bigint: true });
        const pathAfterRead = fs.lstatSync(filePath, { bigint: true });
        if (pathAfterRead.isSymbolicLink() || !sameStableSample(opened, after) || !sameStableSample(after, pathAfterRead)) {
            throw stale(operation, filePath, "bounded regular file changed while it was being read");
        }
        return bytes;
    } catch (error) {
        throw safeError(error, operation, filePath);
    } finally {
        closeFileQuietly(fd);
    }
}
