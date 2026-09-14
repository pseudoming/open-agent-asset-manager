import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        fsyncSync: vi.fn((...args: Parameters<typeof actual.fsyncSync>) => actual.fsyncSync(...args)),
    };
});

import { readFileDescriptorBounded } from "../../src/paths/unix-like/bounded-io";
import {
    assertDirectoryTreeRecycleSupported,
    confirmDurableDirectoryNoFollow,
    confirmDurableDirectoryTreeNoFollow,
    confirmDurableRegularFileNoFollow,
    DurableFilesystemMutationError,
    durableCreateFile,
    durableEnsureDirectory,
    durablePublishDirectory,
    durableRecycleDirectoryTreeIfIdentity,
    durableRemoveDirectoryTree,
    durableRemoveRegularFile,
    durableReplaceFile,
    inspectFilesystemCapacity,
    inspectRegularFileNoFollow,
    inventoryDirectoryNoFollow,
    permanentlyRemoveRegularFileIfIdentity,
    readDirectoryEntriesBounded,
    readRegularFileBounded,
    readRegularFileNoFollow,
    readRegularFileRangeNoFollow,
    SafeFilesystemError,
} from "../../src/paths/unix-like/filesystem-target-entry";

function createTempDir(): string {
    const dir = path.join(os.tmpdir(), `oaam-test-fs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function captureSafeFilesystemError(action: () => unknown): SafeFilesystemError {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(SafeFilesystemError);
        return error as SafeFilesystemError;
    }
    throw new Error("expected a SafeFilesystemError");
}

describe("selected Unix-like safe filesystem primitives", () => {
    it("reads bytes, executable state, and physical identity from one regular-file handle", () => {
        const dir = createTempDir();
        try {
            const file = path.join(dir, "script.sh");
            fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o700 });

            const result = readRegularFileNoFollow(file);

            expect(Buffer.from(result.bytes).toString("utf-8")).toBe("#!/bin/sh\n");
            expect(result.executable).toBe(true);
            expect(result.identity).toEqual({
                deviceId: expect.stringMatching(/^\d+$/),
                fileId: expect.stringMatching(/^\d+$/),
                entryKind: "file",
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("inspects one regular-file identity without reading its body", () => {
        const dir = createTempDir();
        const readSpy = vi.spyOn(fs, "readSync");
        try {
            const file = path.join(dir, "large-state.db");
            fs.writeFileSync(file, Buffer.alloc(1024 * 1024, 7));

            const identity = inspectRegularFileNoFollow(file);

            expect(identity).toEqual({
                deviceId: expect.stringMatching(/^\d+$/),
                fileId: expect.stringMatching(/^\d+$/),
                entryKind: "file",
            });
            expect(readSpy).not.toHaveBeenCalled();
        } finally {
            readSpy.mockRestore();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("inspects finite filesystem capacity through the opened directory", () => {
        const dir = createTempDir();
        try {
            const capacity = inspectFilesystemCapacity(dir);

            expect(capacity.availableBytes).toBeGreaterThan(0);
            expect(capacity.totalBytes).toBeGreaterThanOrEqual(capacity.availableBytes);
            expect(Number.isSafeInteger(capacity.availableBytes)).toBe(true);
            expect(Number.isSafeInteger(capacity.totalBytes)).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("accepts an exact bounded read and rejects a file above the byte limit before returning bytes", () => {
        const dir = createTempDir();
        try {
            const file = path.join(dir, "bounded.txt");
            fs.writeFileSync(file, "12345");
            expect(Buffer.from(readRegularFileNoFollow(file, 5).bytes).toString()).toBe("12345");
            expect(captureSafeFilesystemError(() => readRegularFileNoFollow(file, 4))).toEqual(
                expect.objectContaining({ failureKind: "resource_limit" }),
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reads stable regular-file ranges without loading unrelated bytes", () => {
        const dir = createTempDir();
        try {
            const file = path.join(dir, "range.txt");
            fs.writeFileSync(file, "0123456789");

            const middle = readRegularFileRangeNoFollow(file, 3, 4);
            expect(Buffer.from(middle.bytes).toString()).toBe("3456");
            expect(middle).toEqual(
                expect.objectContaining({
                    byteOffset: 3,
                    totalBytes: 10,
                    executable: false,
                    identity: expect.objectContaining({ entryKind: "file" }),
                }),
            );
            expect(Buffer.from(readRegularFileRangeNoFollow(file, 8, 8).bytes).toString()).toBe("89");
            expect(readRegularFileRangeNoFollow(file, 10, 1).bytes).toHaveLength(0);
            expect(captureSafeFilesystemError(() => readRegularFileRangeNoFollow(file, 11, 1))).toEqual(
                expect.objectContaining({ failureKind: "resource_limit" }),
            );
            expect(captureSafeFilesystemError(() => readRegularFileRangeNoFollow(file, 0, 0))).toEqual(
                expect.objectContaining({ failureKind: "resource_limit", systemCode: "INVALID_RANGE" }),
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reads only the pre-read sample plus one overflow byte when a file grows", () => {
        const dir = createTempDir();
        const file = path.join(dir, "growing.txt");
        let fd: number | null = null;
        const readSpy = vi.spyOn(fs, "readSync");
        try {
            fs.writeFileSync(file, "a");
            fd = fs.openSync(file, fs.constants.O_RDONLY);
            const expectedBytes = fs.fstatSync(fd).size;
            fs.appendFileSync(file, "b".repeat(1024 * 1024));

            const error = captureSafeFilesystemError(() => readFileDescriptorBounded(fd as number, expectedBytes, 1, file));

            expect(error.failureKind).toBe("resource_limit");
            const requestedBytes = readSpy.mock.calls
                .filter((call) => call[0] === fd)
                .reduce((total, call) => total + call[3], 0);
            expect(requestedBytes).toBe(2);
        } finally {
            readSpy.mockRestore();
            if (fd !== null) fs.closeSync(fd);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("stops directory iteration at the first overflow entry and closes the iterator", () => {
        const dir = createTempDir();
        const readSpy = vi.spyOn(fs.Dir.prototype, "readSync");
        const closeSpy = vi.spyOn(fs.Dir.prototype, "closeSync");
        try {
            for (const name of ["a", "b", "c", "d"]) {
                fs.writeFileSync(path.join(dir, name), name);
            }

            const error = captureSafeFilesystemError(() => readDirectoryEntriesBounded(dir, 1));

            expect(error.failureKind).toBe("resource_limit");
            expect(readSpy).toHaveBeenCalledTimes(2);
            expect(closeSpy).toHaveBeenCalledTimes(1);
        } finally {
            closeSpy.mockRestore();
            readSpy.mockRestore();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns stable bytes through the portable bounded probe reader", () => {
        const dir = createTempDir();
        try {
            const file = path.join(dir, "probe.json");
            fs.writeFileSync(file, '{"ok":true}');

            const bytes = readRegularFileBounded(file, 11);
            expect(bytes).toBeInstanceOf(Uint8Array);
            expect(Buffer.isBuffer(bytes)).toBe(false);
            expect(Buffer.from(bytes).toString("utf-8")).toBe('{"ok":true}');
            expect(captureSafeFilesystemError(() => readRegularFileBounded(file, 10))).toEqual(
                expect.objectContaining({ failureKind: "resource_limit" }),
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("accepts an exact bounded inventory and rejects a directory above the entry limit", () => {
        const dir = createTempDir();
        try {
            fs.writeFileSync(path.join(dir, "a.txt"), "a");
            fs.writeFileSync(path.join(dir, "b.txt"), "b");
            expect(inventoryDirectoryNoFollow(dir, 2).entries).toHaveLength(2);
            expect(captureSafeFilesystemError(() => inventoryDirectoryNoFollow(dir, 1))).toEqual(
                expect.objectContaining({ failureKind: "resource_limit" }),
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects a symbolic-link file without reading its target", () => {
        const dir = createTempDir();
        try {
            const target = path.join(dir, "target.txt");
            const link = path.join(dir, "link.txt");
            fs.writeFileSync(target, "secret");
            fs.symlinkSync(target, link);

            const error = captureSafeFilesystemError(() => readRegularFileNoFollow(link));

            expect(error.failureKind).toBe("symlink_or_reparse");
            expect(error.operation).toBe("read_regular_file");
            expect(captureSafeFilesystemError(() => inspectRegularFileNoFollow(link))).toEqual(
                expect.objectContaining({
                    failureKind: "symlink_or_reparse",
                    operation: "inspect_regular_file",
                }),
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects a symbolic-link ancestor without entering the linked directory", () => {
        const dir = createTempDir();
        try {
            const actualDirectory = path.join(dir, "actual");
            const linkedDirectory = path.join(dir, "linked");
            fs.mkdirSync(actualDirectory);
            fs.writeFileSync(path.join(actualDirectory, "secret.txt"), "secret");
            fs.symlinkSync(actualDirectory, linkedDirectory);

            const error = captureSafeFilesystemError(() => readRegularFileNoFollow(path.join(linkedDirectory, "secret.txt")));

            expect(error.failureKind).toBe("symlink_or_reparse");
            expect(error.targetPath).toBe(path.join(linkedDirectory, "secret.txt"));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects a directory when a regular file is required", () => {
        const dir = createTempDir();
        try {
            const childDir = path.join(dir, "child");
            fs.mkdirSync(childDir);

            const error = captureSafeFilesystemError(() => readRegularFileNoFollow(childDir));

            expect(error.failureKind).toBe("wrong_entry_type");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns a typed not_found failure for a missing file", () => {
        const dir = createTempDir();
        try {
            const missing = path.join(dir, "missing.txt");

            const error = captureSafeFilesystemError(() => readRegularFileNoFollow(missing));

            expect(error.failureKind).toBe("not_found");
            expect(error.systemCode).toBe("ENOENT");
            expect(error.targetPath).toBe(missing);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects a non-canonical absolute path before filesystem access", () => {
        const error = captureSafeFilesystemError(() => readRegularFileNoFollow("/tmp/../tmp/file.txt"));

        expect(error.failureKind).toBe("invalid_path");
        expect(error.systemCode).toBe("UNKNOWN");
    });

    it("observes a different physical identity after path replacement", () => {
        const dir = createTempDir();
        try {
            const file = path.join(dir, "identity.txt");
            const retired = path.join(dir, "identity.retired.txt");
            fs.writeFileSync(file, "first");
            const first = readRegularFileNoFollow(file);

            fs.renameSync(file, retired);
            fs.writeFileSync(file, "second");
            const second = readRegularFileNoFollow(file);

            expect(second.identity).not.toEqual(first.identity);
            expect(Buffer.from(second.bytes).toString("utf-8")).toBe("second");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns a sorted complete one-level directory inventory", () => {
        const dir = createTempDir();
        try {
            fs.writeFileSync(path.join(dir, "z.txt"), "z");
            fs.mkdirSync(path.join(dir, "a-dir"));

            const result = inventoryDirectoryNoFollow(dir);

            expect(result.identity.entryKind).toBe("directory");
            expect(result.entries.map((entry) => entry.relativeName)).toEqual(["a-dir", "z.txt"]);
            expect(result.entries.map((entry) => entry.identity.entryKind)).toEqual(["directory", "file"]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("re-confirms durable file bytes and parent-directory identity without changing content", () => {
        const dir = createTempDir();
        const fsyncMock = vi.mocked(fs.fsyncSync);
        const callsBefore = fsyncMock.mock.calls.length;
        try {
            const file = path.join(dir, "published.bin");
            fs.writeFileSync(file, new Uint8Array([0, 1, 2, 255]), { mode: 0o700 });

            const confirmedFile = confirmDurableRegularFileNoFollow(file);
            const confirmedDirectory = confirmDurableDirectoryNoFollow(dir);

            expect(Array.from(confirmedFile.bytes)).toEqual([0, 1, 2, 255]);
            expect(confirmedFile.executable).toBe(true);
            expect(confirmedFile.identity.entryKind).toBe("file");
            expect(confirmedDirectory.entryKind).toBe("directory");
            expect(fsyncMock.mock.calls.length - callsBefore).toBe(2);
            expect(Array.from(fs.readFileSync(file))).toEqual([0, 1, 2, 255]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects a file path replaced while its original descriptor is being flushed", () => {
        const dir = createTempDir();
        const fsyncMock = vi.mocked(fs.fsyncSync);
        const realImplementation = fsyncMock.getMockImplementation();
        if (realImplementation === undefined) {
            throw new Error("fsyncSync mock must retain its real implementation");
        }
        try {
            const file = path.join(dir, "state.json");
            const displaced = path.join(dir, "state.old.json");
            fs.writeFileSync(file, "old");
            let replaced = false;
            fsyncMock.mockImplementation((fd) => {
                realImplementation(fd);
                if (!replaced) {
                    replaced = true;
                    fs.renameSync(file, displaced);
                    fs.writeFileSync(file, "replacement");
                }
            });

            const error = captureSafeFilesystemError(() => confirmDurableRegularFileNoFollow(file));

            expect(error.failureKind).toBe("stale");
            expect(error.operation).toBe("confirm_durable_file");
            expect(fs.readFileSync(file, "utf-8")).toBe("replacement");
        } finally {
            fsyncMock.mockImplementation(realImplementation);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reports a typed durability failure without replacing the file", () => {
        const dir = createTempDir();
        const fsyncMock = vi.mocked(fs.fsyncSync);
        const realImplementation = fsyncMock.getMockImplementation();
        if (realImplementation === undefined) {
            throw new Error("fsyncSync mock must retain its real implementation");
        }
        try {
            const file = path.join(dir, "state.json");
            fs.writeFileSync(file, "unchanged");
            fsyncMock.mockImplementation(() => {
                throw Object.assign(new Error("injected durability failure"), { code: "EIO" });
            });

            const error = captureSafeFilesystemError(() => confirmDurableRegularFileNoFollow(file));

            expect(error.failureKind).toBe("io_error");
            expect(error.operation).toBe("confirm_durable_file");
            expect(fs.readFileSync(file, "utf-8")).toBe("unchanged");
        } finally {
            fsyncMock.mockImplementation(realImplementation);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("fails the whole inventory when one child is a symbolic link", () => {
        const dir = createTempDir();
        try {
            fs.writeFileSync(path.join(dir, "a-regular.txt"), "safe");
            const target = path.join(dir, "target.txt");
            fs.writeFileSync(target, "target");
            fs.symlinkSync(target, path.join(dir, "z-link.txt"));

            const error = captureSafeFilesystemError(() => inventoryDirectoryNoFollow(dir));

            expect(error.failureKind).toBe("symlink_or_reparse");
            expect(error.operation).toBe("inventory_directory");
            expect(error.targetPath).toBe(path.join(dir, "z-link.txt"));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("creates and reopens one direct directory without following the child path", () => {
        const dir = createTempDir();
        try {
            const created = durableEnsureDirectory(dir, "state");
            const reopened = durableEnsureDirectory(dir, "state");

            expect(created.created).toBe(true);
            expect(created.identity.entryKind).toBe("directory");
            expect(reopened).toEqual({ identity: created.identity, created: false });
            expect(fs.statSync(path.join(dir, "state")).mode & 0o777).toBe(0o700);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects a symbolic-link directory child and unsafe child names", () => {
        const dir = createTempDir();
        try {
            const external = path.join(dir, "external");
            fs.mkdirSync(external);
            fs.symlinkSync(external, path.join(dir, "linked"));
            const linked = captureSafeFilesystemError(() => durableEnsureDirectory(dir, "linked"));
            expect(linked.failureKind).toBe("symlink_or_reparse");
            for (const name of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
                const error = captureSafeFilesystemError(() => durableEnsureDirectory(dir, name));
                expect(error.failureKind).toBe("invalid_path");
                expect((error as DurableFilesystemMutationError).mutationState).toBe("not_applied");
            }
            expect(fs.readdirSync(external)).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reports may_have_applied when directory fsync fails after mkdir", () => {
        const dir = createTempDir();
        const fsyncMock = vi.mocked(fs.fsyncSync);
        const realImplementation = fsyncMock.getMockImplementation();
        if (realImplementation === undefined) throw new Error("fsyncSync mock must retain its real implementation");
        try {
            fsyncMock.mockImplementation(() => {
                throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
            });
            const error = captureSafeFilesystemError(() =>
                durableEnsureDirectory(dir, "maybe-created"),
            ) as DurableFilesystemMutationError;
            expect(error.mutationState).toBe("may_have_applied");
            expect(fs.statSync(path.join(dir, "maybe-created")).isDirectory()).toBe(true);
        } finally {
            fsyncMock.mockImplementation(realImplementation);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("durably replaces a regular file and publishes a new physical identity", () => {
        const dir = createTempDir();
        try {
            const file = path.join(dir, "state.json");
            fs.writeFileSync(file, "old", { mode: 0o640 });
            const oldIdentity = readRegularFileNoFollow(file).identity;

            const newIdentity = durableReplaceFile(file, "new");

            expect(fs.readFileSync(file, "utf-8")).toBe("new");
            expect(newIdentity).not.toEqual(oldIdentity);
            expect(fs.statSync(file).mode & 0o777).toBe(0o640);
            expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("durably creates a missing regular file with private default mode", () => {
        const dir = createTempDir();
        try {
            const file = path.join(dir, "new-state.bin");

            const identity = durableReplaceFile(file, new Uint8Array([0, 1, 2, 255]));

            expect(identity.entryKind).toBe("file");
            expect(Array.from(fs.readFileSync(file))).toEqual([0, 1, 2, 255]);
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("durably creates an immutable output without replacing an existing path", () => {
        const dir = createTempDir();
        try {
            const file = path.join(dir, "backup.zip");
            const identity = durableCreateFile(file, new Uint8Array([1, 2, 3]));

            expect(identity.entryKind).toBe("file");
            expect(Array.from(fs.readFileSync(file))).toEqual([1, 2, 3]);
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);

            const error = captureSafeFilesystemError(() => durableCreateFile(file, new Uint8Array([4])));
            expect(error).toEqual(
                expect.objectContaining({
                    failureKind: "stale",
                    operation: "durable_create_file",
                    systemCode: "DESTINATION_EXISTS",
                }),
            );
            expect(Array.from(fs.readFileSync(file))).toEqual([1, 2, 3]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reports not_applied when the replacement parent does not exist", () => {
        const dir = createTempDir();
        try {
            const file = path.join(dir, "missing-parent", "state.json");

            const error = captureSafeFilesystemError(() => durableReplaceFile(file, "new"));

            expect(error).toBeInstanceOf(DurableFilesystemMutationError);
            expect((error as DurableFilesystemMutationError).mutationState).toBe("not_applied");
            expect(error.failureKind).toBe("not_found");
            expect(fs.existsSync(file)).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects a symbolic-link replacement destination before mutation", () => {
        const dir = createTempDir();
        try {
            const target = path.join(dir, "target.txt");
            const link = path.join(dir, "state.txt");
            fs.writeFileSync(target, "unchanged");
            fs.symlinkSync(target, link);

            const error = captureSafeFilesystemError(() => durableReplaceFile(link, "new"));

            expect(error).toBeInstanceOf(DurableFilesystemMutationError);
            expect((error as DurableFilesystemMutationError).mutationState).toBe("not_applied");
            expect(error.failureKind).toBe("symlink_or_reparse");
            expect(fs.readFileSync(target, "utf-8")).toBe("unchanged");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reports may_have_applied when parent fsync fails after rename", () => {
        const dir = createTempDir();
        const fsyncMock = vi.mocked(fs.fsyncSync);
        const realImplementation = fsyncMock.getMockImplementation();
        if (realImplementation === undefined) {
            throw new Error("fsyncSync mock must retain its real implementation");
        }
        try {
            const file = path.join(dir, "state.json");
            fs.writeFileSync(file, "old");
            let callCount = 0;
            fsyncMock.mockImplementation((fd) => {
                callCount += 1;
                if (callCount === 2) {
                    throw Object.assign(new Error("injected parent fsync failure"), {
                        code: "EIO",
                    });
                }
                return realImplementation(fd);
            });

            const error = captureSafeFilesystemError(() => durableReplaceFile(file, "new"));

            expect(error).toBeInstanceOf(DurableFilesystemMutationError);
            expect((error as DurableFilesystemMutationError).mutationState).toBe("may_have_applied");
            expect(error.failureKind).toBe("io_error");
            expect(fs.readFileSync(file, "utf-8")).toBe("new");
        } finally {
            fsyncMock.mockImplementation(realImplementation);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("durably removes a regular file and reports an already-absent marker", () => {
        const dir = createTempDir();
        try {
            const file = path.join(dir, "journal.json");
            fs.writeFileSync(file, "marker");

            expect(durableRemoveRegularFile(file)).toBe(true);
            expect(fs.existsSync(file)).toBe(false);
            expect(durableRemoveRegularFile(file)).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("permanently removes only the exact identity-bound regular file", () => {
        const dir = createTempDir();
        try {
            const file = path.join(dir, "ordinary-log.jsonl");
            fs.writeFileSync(file, "owned log");
            const expectedIdentity = inspectRegularFileNoFollow(file);

            expect(permanentlyRemoveRegularFileIfIdentity(file, expectedIdentity)).toBe(true);
            expect(fs.existsSync(file)).toBe(false);
            expect(permanentlyRemoveRegularFileIfIdentity(file, expectedIdentity)).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects stale identity, directories, and symlinks before permanent removal", () => {
        const dir = createTempDir();
        try {
            const file = path.join(dir, "ordinary-log.jsonl");
            fs.writeFileSync(file, "keep");
            const expectedIdentity = inspectRegularFileNoFollow(file);
            const stale = captureSafeFilesystemError(() =>
                permanentlyRemoveRegularFileIfIdentity(file, {
                    ...expectedIdentity,
                    fileId: `${expectedIdentity.fileId}-stale`,
                }),
            );
            expect(stale).toEqual(
                expect.objectContaining({
                    failureKind: "stale",
                    operation: "permanent_remove_file",
                }),
            );
            expect(fs.readFileSync(file, "utf-8")).toBe("keep");

            const directory = path.join(dir, "directory");
            fs.mkdirSync(directory);
            const wrongKind = captureSafeFilesystemError(() =>
                permanentlyRemoveRegularFileIfIdentity(directory, {
                    ...expectedIdentity,
                    entryKind: "directory",
                }),
            );
            expect(wrongKind).toEqual(
                expect.objectContaining({
                    failureKind: "wrong_entry_type",
                    operation: "permanent_remove_file",
                }),
            );

            const target = path.join(dir, "target.txt");
            const link = path.join(dir, "linked.jsonl");
            fs.writeFileSync(target, "keep target");
            fs.symlinkSync(target, link);
            const linked = captureSafeFilesystemError(() => permanentlyRemoveRegularFileIfIdentity(link, expectedIdentity));
            expect(linked).toEqual(
                expect.objectContaining({
                    failureKind: "symlink_or_reparse",
                    operation: "permanent_remove_file",
                }),
            );
            expect(fs.readFileSync(target, "utf-8")).toBe("keep target");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects symlinked removal paths without deleting the link target", () => {
        const dir = createTempDir();
        try {
            const target = path.join(dir, "outside.txt");
            const link = path.join(dir, "journal.json");
            fs.writeFileSync(target, "keep");
            fs.symlinkSync(target, link);

            const error = captureSafeFilesystemError(() => durableRemoveRegularFile(link)) as DurableFilesystemMutationError;

            expect(error.mutationState).toBe("not_applied");
            expect(error.failureKind).toBe("symlink_or_reparse");
            expect(fs.readFileSync(target, "utf-8")).toBe("keep");
            expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reports may_have_applied when marker parent fsync fails after unlink", () => {
        const dir = createTempDir();
        const fsyncMock = vi.mocked(fs.fsyncSync);
        const realImplementation = fsyncMock.getMockImplementation();
        if (realImplementation === undefined) {
            throw new Error("fsyncSync mock must retain its real implementation");
        }
        try {
            const file = path.join(dir, "journal.json");
            fs.writeFileSync(file, "marker");
            fsyncMock.mockImplementation(() => {
                throw Object.assign(new Error("injected removal fsync failure"), { code: "EIO" });
            });

            const error = captureSafeFilesystemError(() => durableRemoveRegularFile(file)) as DurableFilesystemMutationError;

            expect(error.mutationState).toBe("may_have_applied");
            expect(error.failureKind).toBe("io_error");
            expect(fs.existsSync(file)).toBe(false);
        } finally {
            fsyncMock.mockImplementation(realImplementation);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects a directory or symlinked parent as a regular-file removal target", () => {
        const dir = createTempDir();
        try {
            const childDirectory = path.join(dir, "journal.json");
            fs.mkdirSync(childDirectory);
            const wrongKind = captureSafeFilesystemError(() => durableRemoveRegularFile(childDirectory));
            expect(wrongKind.failureKind).toBe("wrong_entry_type");

            const outside = path.join(dir, "outside");
            const linkedParent = path.join(dir, "linked");
            fs.mkdirSync(outside);
            fs.writeFileSync(path.join(outside, "journal.json"), "keep");
            fs.symlinkSync(outside, linkedParent);
            const linked = captureSafeFilesystemError(() => durableRemoveRegularFile(path.join(linkedParent, "journal.json")));
            expect(linked.failureKind).toBe("symlink_or_reparse");
            expect(fs.readFileSync(path.join(outside, "journal.json"), "utf-8")).toBe("keep");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("confirms a complete bounded directory tree and rejects partial or symlinked trees", () => {
        const dir = createTempDir();
        try {
            const tree = path.join(dir, "tree");
            const nested = path.join(tree, "nested");
            fs.mkdirSync(nested, { recursive: true });
            fs.writeFileSync(path.join(tree, "root.txt"), "root");
            fs.writeFileSync(path.join(nested, "child.txt"), "child");

            expect(confirmDurableDirectoryTreeNoFollow(tree, 3).entryKind).toBe("directory");
            expect(captureSafeFilesystemError(() => confirmDurableDirectoryTreeNoFollow(tree, 2))).toEqual(
                expect.objectContaining({
                    failureKind: "resource_limit",
                    operation: "confirm_durable_tree",
                }),
            );

            const outside = path.join(dir, "outside.txt");
            fs.writeFileSync(outside, "keep");
            fs.symlinkSync(outside, path.join(tree, "linked.txt"));
            expect(captureSafeFilesystemError(() => confirmDurableDirectoryTreeNoFollow(tree, 4))).toEqual(
                expect.objectContaining({
                    failureKind: "symlink_or_reparse",
                    operation: "confirm_durable_tree",
                }),
            );
            expect(fs.readFileSync(outside, "utf-8")).toBe("keep");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("stages and removes one descriptor-bound internal directory tree", () => {
        const dir = createTempDir();
        try {
            const tree = path.join(dir, "tree");
            const nested = path.join(tree, "nested");
            fs.mkdirSync(nested, { recursive: true });
            fs.writeFileSync(path.join(tree, "root.txt"), "root");
            fs.writeFileSync(path.join(nested, "child.txt"), "child");

            expect(durableRemoveDirectoryTree(tree, 3)).toBe(true);
            expect(fs.existsSync(tree)).toBe(false);
            expect(fs.readdirSync(dir).filter((name) => name.startsWith(".oaam-recycle-"))).toEqual([]);
            expect(durableRemoveDirectoryTree(tree, 3)).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects user-facing directory Trash on an unverified Unix-like target without deleting the tree", () => {
        const dir = createTempDir();
        try {
            const tree = path.join(dir, "user-owned-tree");
            fs.mkdirSync(tree);
            fs.writeFileSync(path.join(tree, "member.txt"), "keep");
            const identity = confirmDurableDirectoryTreeNoFollow(tree, 1);

            for (const action of [
                () => assertDirectoryTreeRecycleSupported(tree),
                () => durableRecycleDirectoryTreeIfIdentity(tree, identity, 1),
            ]) {
                expect(captureSafeFilesystemError(action)).toEqual(
                    expect.objectContaining({
                        failureKind: "unsupported_platform",
                        operation: "durable_remove_tree",
                        systemCode: "IDENTITY_BOUND_TRASH_NOT_AVAILABLE",
                    }),
                );
            }
            expect(fs.readFileSync(path.join(tree, "member.txt"), "utf-8")).toBe("keep");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("leaves a recoverable staged tree and reports may_have_applied after a post-rename fault", () => {
        const dir = createTempDir();
        const fsyncMock = vi.mocked(fs.fsyncSync);
        const realFsync = fsyncMock.getMockImplementation();
        if (realFsync === undefined) throw new Error("fsyncSync mock must retain its real implementation");
        const realRename = fs.renameSync;
        const renameSpy = vi.spyOn(fs, "renameSync");
        let staged = false;
        try {
            const tree = path.join(dir, "tree");
            fs.mkdirSync(tree);
            fs.writeFileSync(path.join(tree, "child.txt"), "child");
            renameSpy.mockImplementation((source, destination) => {
                realRename(source, destination);
                staged = true;
            });
            fsyncMock.mockImplementation((fd) => {
                if (staged) {
                    throw Object.assign(new Error("injected post-stage durability failure"), { code: "EIO" });
                }
                realFsync(fd);
            });

            const error = captureSafeFilesystemError(() => durableRemoveDirectoryTree(tree, 1)) as DurableFilesystemMutationError;

            expect(error.mutationState).toBe("may_have_applied");
            expect(fs.existsSync(tree)).toBe(false);
            const stagedNames = fs.readdirSync(dir).filter((name) => name.startsWith(".oaam-recycle-"));
            expect(stagedNames).toHaveLength(1);
            expect(fs.readFileSync(path.join(dir, stagedNames[0] as string, "child.txt"), "utf-8")).toBe("child");
        } finally {
            renameSpy.mockRestore();
            fsyncMock.mockImplementation(realFsync);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("publishes a staged directory through descriptor-bound parents", () => {
        const dir = createTempDir();
        try {
            const stagingParent = path.join(dir, "staging");
            const targetParent = path.join(dir, "assets");
            const staged = path.join(stagingParent, "txn");
            fs.mkdirSync(staged, { recursive: true });
            fs.mkdirSync(targetParent);
            fs.writeFileSync(path.join(staged, "state.json"), "ok");

            const identity = durablePublishDirectory(staged, targetParent, "asset");

            expect(identity.entryKind).toBe("directory");
            expect(fs.existsSync(staged)).toBe(false);
            expect(fs.readFileSync(path.join(targetParent, "asset", "state.json"), "utf-8")).toBe("ok");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects an existing target and a symbolic-link target parent before rename", () => {
        const dir = createTempDir();
        try {
            const stagingParent = path.join(dir, "staging");
            const targetParent = path.join(dir, "assets");
            fs.mkdirSync(path.join(stagingParent, "txn"), { recursive: true });
            fs.mkdirSync(path.join(targetParent, "asset"), { recursive: true });
            const existing = captureSafeFilesystemError(() =>
                durablePublishDirectory(path.join(stagingParent, "txn"), targetParent, "asset"),
            ) as DurableFilesystemMutationError;
            expect(existing.mutationState).toBe("not_applied");
            expect(fs.existsSync(path.join(stagingParent, "txn"))).toBe(true);

            const linkedParent = path.join(dir, "linked-assets");
            fs.symlinkSync(targetParent, linkedParent);
            const linked = captureSafeFilesystemError(() =>
                durablePublishDirectory(path.join(stagingParent, "txn"), linkedParent, "new-asset"),
            );
            expect(linked.failureKind).toBe("symlink_or_reparse");
            expect(linked.operation).toBe("durable_publish_directory");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects unsafe publication names without moving the source", () => {
        const dir = createTempDir();
        try {
            const staged = path.join(dir, "staged");
            const target = path.join(dir, "target");
            fs.mkdirSync(staged);
            fs.mkdirSync(target);
            for (const name of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
                const error = captureSafeFilesystemError(() =>
                    durablePublishDirectory(staged, target, name),
                ) as DurableFilesystemMutationError;
                expect(error.mutationState).toBe("not_applied");
                expect(error.failureKind).toBe("invalid_path");
            }
            expect(fs.existsSync(staged)).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reports may_have_applied when directory-parent fsync fails after rename", () => {
        const dir = createTempDir();
        const fsyncMock = vi.mocked(fs.fsyncSync);
        const realImplementation = fsyncMock.getMockImplementation();
        if (realImplementation === undefined) throw new Error("fsyncSync mock must retain its real implementation");
        try {
            const staged = path.join(dir, "staged");
            const target = path.join(dir, "target");
            fs.mkdirSync(staged);
            fs.mkdirSync(target);
            fsyncMock.mockImplementation(() => {
                throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
            });

            const error = captureSafeFilesystemError(() =>
                durablePublishDirectory(staged, target, "published"),
            ) as DurableFilesystemMutationError;
            expect(error.mutationState).toBe("may_have_applied");
            expect(fs.existsSync(path.join(target, "published"))).toBe(true);
        } finally {
            fsyncMock.mockImplementation(realImplementation);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
