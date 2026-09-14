import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SafeFilesystemError } from "../src/filesystem/filesystem-types";
import { readRegularFileBatchSequentially, validateRegularFileReadBatch } from "../src/filesystem/regular-file-read-batch";
import { readRegularFilesNoFollow } from "../src/paths/unix-like/filesystem-target-entry";
import { createWin32PhysicalFilesystemBackend } from "../src/paths/win32/filesystem-backend";
import type { Win32NativeFilesystemAddon } from "../src/paths/win32/native-addon";

describe("ordered bounded file reads", () => {
    let root: string;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-read-batch-"));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("returns fresh no-follow Unix bytes and executable state in request order", () => {
        const first = path.join(root, "first"),
            second = path.join(root, "second");
        fs.writeFileSync(first, "a", { mode: 0o600 });
        fs.writeFileSync(second, "bc", { mode: 0o700 });
        const request = [
            { filePath: second, maximumBytes: 2 },
            { filePath: first, maximumBytes: 1 },
        ];
        const result = readRegularFilesNoFollow(request, 3);
        expect(result.map((entry) => Buffer.from(entry.bytes).toString())).toEqual(["bc", "a"]);
        expect(result.map((entry) => entry.executable)).toEqual([true, false]);
        fs.writeFileSync(first, "z");
        expect(Buffer.from(readRegularFilesNoFollow(request, 3)[1]!.bytes).toString()).toBe("z");
        fs.symlinkSync(first, path.join(root, "alias"));
        expect(() => readRegularFilesNoFollow([{ filePath: path.join(root, "alias"), maximumBytes: 1 }], 1)).toThrowError(
            expect.objectContaining({ failureKind: "symlink_or_reparse" }),
        );
    });

    it("distinguishes total batch capacity from the caller's real per-file limit", () => {
        const first = path.join(root, "first"),
            second = path.join(root, "second");
        fs.writeFileSync(first, "aa");
        fs.writeFileSync(second, "bb");
        expect(() =>
            readRegularFilesNoFollow(
                [
                    { filePath: first, maximumBytes: 2 },
                    { filePath: second, maximumBytes: 2 },
                ],
                2,
            ),
        ).toThrowError(expect.objectContaining({ systemCode: "READ_BATCH_CAPACITY" }));
        try {
            readRegularFilesNoFollow([{ filePath: first, maximumBytes: 1 }], 4);
            throw new Error("expected per-file limit failure");
        } catch (error) {
            expect(error).toBeInstanceOf(SafeFilesystemError);
            expect((error as SafeFilesystemError).failureKind).toBe("resource_limit");
            expect((error as SafeFilesystemError).systemCode).not.toBe("READ_BATCH_CAPACITY");
        }
    });

    it("clears a partial serial result and preserves the actual failure", () => {
        const bytes = Buffer.from("first");
        const denied = new SafeFilesystemError({
            failureKind: "permission_denied",
            operation: "read_regular_file",
            targetPath: "/two",
            message: "denied",
        });
        const read = vi.fn((filePath: string) => {
            if (filePath === "/two") throw denied;
            return { bytes, executable: false, identity: { deviceId: "1", fileId: "1", entryKind: "file" as const } };
        });
        expect(() =>
            readRegularFileBatchSequentially(
                [
                    { filePath: "/one", maximumBytes: 5 },
                    { filePath: "/two", maximumBytes: 5 },
                ],
                10,
                read,
            ),
        ).toThrow(denied);
        expect(bytes.every((byte) => byte === 0)).toBe(true);
    });

    it("accepts zero-byte files and rejects invalid aggregate bounds before any reader", () => {
        const filePath = path.join(root, "empty");
        fs.writeFileSync(filePath, "");
        expect(readRegularFilesNoFollow([{ filePath, maximumBytes: 0 }], 0)[0]!.bytes).toHaveLength(0);
        for (const limit of [-1, 0.5, Number.NaN, 128 * 1_024 * 1_024 + 1]) {
            expect(() => validateRegularFileReadBatch([{ filePath, maximumBytes: 0 }], limit)).toThrow();
        }
        expect(() => validateRegularFileReadBatch(null as never, 1)).toThrow();
        expect(() => validateRegularFileReadBatch([null] as never, 1)).toThrow();
        expect(() => validateRegularFileReadBatch([{ filePath, maximumBytes: Number.NaN }], 1)).toThrow();
    });

    it("reads Windows-local batches and rejects selected WSL files before native access", () => {
        const nativeRead = vi.fn((filePath: string) => ({
            bytes: Buffer.from("x"),
            executable: false,
            identity: { deviceId: "host", fileId: filePath, entryKind: "file" as const },
        }));
        const loadNative = vi.fn(() => ({ readRegularFile: nativeRead }) as unknown as Win32NativeFilesystemAddon);
        const backend = createWin32PhysicalFilesystemBackend(loadNative);
        const selected = [{ filePath: "\\\\wsl.localhost\\Ubuntu\\tmp\\a", maximumBytes: 1 }];
        expect(() => backend.readRegularFilesNoFollow(selected, 1)).toThrowError(
            expect.objectContaining({ systemCode: "WSL_READ_REQUIRES_LINUX_EXECUTION" }),
        );
        expect(loadNative).not.toHaveBeenCalled();
        expect(backend.readRegularFilesNoFollow([], 0)).toEqual([]);
        const local = [
            { filePath: "C:\\oaam\\a", maximumBytes: 1 },
            { filePath: "C:\\oaam\\b", maximumBytes: 1 },
        ];
        expect(backend.readRegularFilesNoFollow(local, 2).map((entry) => entry.identity.fileId)).toEqual(
            local.map((entry) => entry.filePath),
        );
        expect(nativeRead).toHaveBeenCalledTimes(2);
    });
});
