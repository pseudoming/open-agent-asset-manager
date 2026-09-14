import { describe, expect, it } from "vitest";
import {
    filesystemEntryKind,
    inspectFilesystemFailure,
    sameFilesystemIdentity,
    sameFilesystemStableSample,
    samePhysicalPathIdentity,
    toSafeFilesystemError,
    type FilesystemStatSample,
} from "../../src/filesystem/filesystem-facts";
import { SafeFilesystemError } from "../../src/filesystem/filesystem-types";

describe("shared filesystem failure facts", () => {
    it.each([
        ["ENOENT", "not_found"],
        ["EACCES", "permission_denied"],
        ["EPERM", "permission_denied"],
        ["ELOOP", "symlink_or_reparse"],
        ["ENOTDIR", "wrong_entry_type"],
        ["EISDIR", "wrong_entry_type"],
        ["ENOSYS", "unsupported_platform"],
        ["ENOTSUP", "unsupported_platform"],
        ["EOPNOTSUPP", "unsupported_platform"],
        ["EIO", "io_error"],
    ] as const)("classifies raw errno %s once", (systemCode, failureKind) => {
        expect(inspectFilesystemFailure(errno(systemCode))).toEqual({
            source: "node_errno_error",
            failureKind,
            systemCode,
        });
    });

    it("retains a typed SafeFilesystemError and rejects untyped lookalikes", () => {
        const safe = new SafeFilesystemError({
            failureKind: "resource_limit",
            operation: "read_regular_file",
            targetPath: "/target",
            systemCode: "CUSTOM",
            message: "bounded",
        });
        expect(inspectFilesystemFailure(safe)).toEqual({
            source: "safe_filesystem_error",
            failureKind: "resource_limit",
            systemCode: "CUSTOM",
        });
        expect(inspectFilesystemFailure({ code: "EACCES" })).toEqual({
            source: "unknown",
            failureKind: "io_error",
            systemCode: "UNKNOWN",
        });
        expect(inspectFilesystemFailure(new Error("unknown"))).toEqual({
            source: "unknown",
            failureKind: "io_error",
            systemCode: "UNKNOWN",
        });
        expect(inspectFilesystemFailure(errno(undefined))).toEqual({
            source: "node_errno_error",
            failureKind: "io_error",
            systemCode: "UNKNOWN",
        });
    });

    it("wraps raw failures once and passes typed failures through unchanged", () => {
        const wrapped = toSafeFilesystemError(errno("EACCES"), "inventory_directory", "/target");
        expect(wrapped).toEqual(
            expect.objectContaining({
                failureKind: "permission_denied",
                operation: "inventory_directory",
                targetPath: "/target",
                systemCode: "EACCES",
                message: "inventory_directory failed for /target (EACCES)",
            }),
        );
        expect(toSafeFilesystemError(wrapped, "read_regular_file", "/other")).toBe(wrapped);
    });
});

describe("shared physical sample facts", () => {
    it("classifies regular-file, directory, and unsupported entry samples", () => {
        expect(filesystemEntryKind(stat({ kind: "file" }))).toBe("file");
        expect(filesystemEntryKind(stat({ kind: "directory" }))).toBe("directory");
        expect(filesystemEntryKind(stat({ kind: "other" }))).toBeNull();
    });

    it("requires device, inode, and entry kind for physical identity", () => {
        const base = stat();
        expect(sameFilesystemIdentity(base, stat())).toBe(true);
        expect(sameFilesystemIdentity(base, stat({ dev: 2n }))).toBe(false);
        expect(sameFilesystemIdentity(base, stat({ ino: 2n }))).toBe(false);
        expect(sameFilesystemIdentity(base, stat({ kind: "directory" }))).toBe(false);
    });

    it("compares exported physical path identities without platform-specific stat shapes", () => {
        const base = { deviceId: "device", fileId: "file", entryKind: "file" as const };
        expect(samePhysicalPathIdentity(base, { ...base })).toBe(true);
        expect(samePhysicalPathIdentity(base, { ...base, deviceId: "other" })).toBe(false);
        expect(samePhysicalPathIdentity(base, { ...base, fileId: "other" })).toBe(false);
        expect(samePhysicalPathIdentity(base, { ...base, entryKind: "directory" })).toBe(false);
    });

    it("requires identity, mode, size, mtime, and ctime for one stable sample", () => {
        const base = stat();
        expect(sameFilesystemStableSample(base, stat())).toBe(true);
        expect(sameFilesystemStableSample(base, stat({ ino: 2n }))).toBe(false);
        expect(sameFilesystemStableSample(base, stat({ mode: 2n }))).toBe(false);
        expect(sameFilesystemStableSample(base, stat({ size: 2n }))).toBe(false);
        expect(sameFilesystemStableSample(base, stat({ mtimeNs: 2n }))).toBe(false);
        expect(sameFilesystemStableSample(base, stat({ ctimeNs: 2n }))).toBe(false);
    });
});

function errno(code: string | undefined): Error {
    return Object.assign(new Error("filesystem failure"), { code });
}

function stat(
    overrides: Partial<Omit<FilesystemStatSample, "isFile" | "isDirectory">> & {
        kind?: "file" | "directory" | "other";
    } = {},
): FilesystemStatSample {
    const kind = overrides.kind ?? "file";
    return {
        dev: overrides.dev ?? 1n,
        ino: overrides.ino ?? 1n,
        mode: overrides.mode ?? 1n,
        size: overrides.size ?? 1n,
        mtimeNs: overrides.mtimeNs ?? 1n,
        ctimeNs: overrides.ctimeNs ?? 1n,
        isFile: () => kind === "file",
        isDirectory: () => kind === "directory",
    };
}
