/** Linux process-lifetime locks over persistent neutral files; never reclaim by unlinking a PID marker. */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname } from "node:path";
import { sameFilesystemIdentity, toSafeFilesystemError } from "../../filesystem/filesystem-facts";
import { SafeFilesystemError } from "../../filesystem/filesystem-types";
import {
    assertCanonicalAbsolutePath,
    closeQuietly,
    descriptorPath,
    inspectChildWithoutFollowing,
    openAbsolutePathNoFollow,
} from "./descriptor-filesystem";

interface NativeLock {
    readonly contractVersion: "oaam.linux.file-lock.v1";
    tryAcquire(fd: number): boolean;
}
let native: NativeLock | undefined;

function loadNative(): NativeLock {
    if (native !== undefined) return native;
    const value: unknown = createRequire(__filename)("./native/oaam_file_lock.node");
    if (
        value === null ||
        typeof value !== "object" ||
        Object.keys(value).sort().join(",") !== "contractVersion,tryAcquire" ||
        !("contractVersion" in value) ||
        value.contractVersion !== "oaam.linux.file-lock.v1" ||
        !("tryAcquire" in value) ||
        typeof value.tryAcquire !== "function"
    ) {
        throw new Error("Linux lock module contract is invalid");
    }
    native = value as NativeLock;
    return native;
}

export function acquireLinuxFileLock(lockPath: string): (() => void) | null {
    return acquire(lockPath, loadNative, () => {});
}

/** Private deterministic fault seam; never exported by Shared's public entries. */
export function acquireLinuxFileLockForTest(
    lockPath: string,
    nativeLoader: () => NativeLock,
    beforeAcquire: () => void = () => {},
): (() => void) | null {
    return acquire(lockPath, nativeLoader, beforeAcquire);
}

function acquire(lockPath: string, nativeLoader: () => NativeLock, beforeAcquire: () => void): (() => void) | null {
    assertCanonicalAbsolutePath(lockPath, "lock_file");
    let backend: NativeLock;
    try {
        backend = nativeLoader();
    } catch (error) {
        throw new SafeFilesystemError({
            operation: "lock_file",
            failureKind: "unsupported_platform",
            targetPath: lockPath,
            systemCode: "LINUX_LOCK_MODULE_UNAVAILABLE",
            message: `Linux process-lifetime lock module is unavailable: ${String(error)}`,
        });
    }
    const parent = openAbsolutePathNoFollow(dirname(lockPath), "directory", "lock_file");
    let fd: number | null = null;
    try {
        fd = fs.openSync(
            descriptorPath(parent.fd, basename(lockPath)),
            fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
            0o600,
        );
        const original = fs.fstatSync(fd, { bigint: true });
        requireNeutralFile(original, lockPath);
        beforeAcquire();
        const acquired = backend.tryAcquire(fd);
        if (acquired === false) return null;
        if (acquired !== true)
            throw new SafeFilesystemError({
                operation: "lock_file",
                failureKind: "io_error",
                targetPath: lockPath,
                systemCode: "LOCK_MODULE_RESULT_INVALID",
                message: "Linux lock module returned an invalid acquisition result",
            });
        const current = inspectChildWithoutFollowing(parent.fd, basename(lockPath), "lock_file", lockPath);
        requireNeutralFile(current, lockPath);
        if (!sameFilesystemIdentity(original, current))
            throw new SafeFilesystemError({
                operation: "lock_file",
                failureKind: "stale",
                targetPath: lockPath,
                systemCode: "LOCK_IDENTITY_CHANGED",
                message: "lock file identity changed during acquisition",
            });
        const currentParent = openAbsolutePathNoFollow(dirname(lockPath), "directory", "lock_file");
        try {
            if (!sameFilesystemIdentity(parent.stat, currentParent.stat))
                throw new SafeFilesystemError({
                    operation: "lock_file",
                    failureKind: "stale",
                    targetPath: lockPath,
                    systemCode: "LOCK_PARENT_CHANGED",
                    message: "lock parent identity changed during acquisition",
                });
        } finally {
            closeQuietly(currentParent.fd);
        }
        let ownedFd: number | null = fd;
        fd = null;
        return () => {
            if (ownedFd === null) return;
            const held = ownedFd;
            ownedFd = null;
            fs.closeSync(held);
        };
    } catch (error) {
        throw toSafeFilesystemError(error, "lock_file", lockPath);
    } finally {
        if (fd !== null) closeQuietly(fd);
        closeQuietly(parent.fd);
    }
}

function requireNeutralFile(stat: fs.BigIntStats, lockPath: string): void {
    if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!()) || stat.size !== 0n) {
        throw new SafeFilesystemError({
            operation: "lock_file",
            failureKind: "wrong_entry_type",
            targetPath: lockPath,
            systemCode: "LOCK_FILE_NOT_OWNED_NEUTRAL",
            message: "lock requires one owned regular empty file; existing marker remains unchanged",
        });
    }
}
