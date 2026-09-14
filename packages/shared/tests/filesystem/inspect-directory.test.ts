import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => ({
    ...(await importOriginal<typeof import("node:fs")>()),
}));

import { inspectDirectoryNoFollow, SafeFilesystemError } from "../../src/paths/unix-like/filesystem-target-entry";

function createTempDir(): string {
    const dir = path.join(os.tmpdir(), `oaam-test-inspect-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("exact directory inspection", () => {
    it("does not enumerate legitimate linked children and still rejects a linked root", () => {
        const dir = createTempDir();
        const readDirectorySpy = vi.spyOn(fs, "readdirSync");
        try {
            const workspace = path.join(dir, "workspace");
            const sharedData = path.join(dir, "shared-data");
            const linkedWorkspace = path.join(dir, "workspace-link");
            fs.mkdirSync(workspace);
            fs.mkdirSync(sharedData);
            fs.symlinkSync(sharedData, path.join(workspace, "test-data"), "dir");

            expect(inspectDirectoryNoFollow(workspace)).toEqual({
                deviceId: expect.stringMatching(/^\d+$/),
                fileId: expect.stringMatching(/^\d+$/),
                entryKind: "directory",
            });
            expect(readDirectorySpy).not.toHaveBeenCalled();

            fs.symlinkSync(workspace, linkedWorkspace, "dir");
            expect(captureSafeFilesystemError(() => inspectDirectoryNoFollow(linkedWorkspace))).toEqual(
                expect.objectContaining({
                    failureKind: "symlink_or_reparse",
                    operation: "inspect_directory",
                    targetPath: linkedWorkspace,
                }),
            );
        } finally {
            readDirectorySpy.mockRestore();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
