import { describe, expect, it, vi } from "vitest";
import type { PhysicalFilesystemBackend } from "../../../src/filesystem/physical-filesystem-backend";
import { createWin32PhysicalFilesystemBackend } from "../../../src/paths/win32/filesystem-backend";

const FILE_IDENTITY = Object.freeze({ deviceId: "42", fileId: "file", entryKind: "file" as const });
const DIRECTORY_IDENTITY = Object.freeze({ deviceId: "42", fileId: "directory", entryKind: "directory" as const });
const TARGET = "\\\\wsl.localhost\\Ubuntu\\home\\oaam\\project\\CLAUDE.md";
const directCalls: readonly [string, (backend: PhysicalFilesystemBackend, target: string) => unknown][] = [
    ["create", (b, p) => b.durableCreateFile(p, "desired")],
    ["replace", (b, p) => b.durableReplaceFile(p, "desired")],
    ["overwrite", (b, p) => b.durableOverwriteFile(p, "desired")],
    ["create executable", (b, p) => b.durableCreateFile(p, "desired", true)],
    ["remove file", (b, p) => b.durableRemoveRegularFile(p)],
    ["ensure directory", (b, p) => b.durableEnsureDirectory(p, "child")],
    ["remove empty directory", (b, p) => b.durableRemoveDirectoryTree(p, 0)],
    ["remove tree", (b, p) => b.durableRemoveDirectoryTree(p, 1)],
    ["permanent remove", (b, p) => b.permanentlyRemoveRegularFileIfIdentity(p, FILE_IDENTITY)],
    ["recycle file", (b, p) => b.durableRecycleRegularFileIfIdentity(p, FILE_IDENTITY)],
    ["recycle tree", (b, p) => b.durableRecycleDirectoryTreeIfIdentity(p, DIRECTORY_IDENTITY, 1)],
    ["confirm file", (b, p) => b.confirmDurableRegularFileNoFollow(p)],
    ["confirm directory", (b, p) => b.confirmDurableDirectoryNoFollow(p)],
    ["confirm tree", (b, p) => b.confirmDurableDirectoryTreeNoFollow(p, 1)],
    ["publish file", (b, p) => b.durablePublishRegularFile(p, p, "child")],
    ["publish file to WSL", (b, p) => b.durablePublishRegularFile("C:\\fixture\\source", p, "child")],
    ["publish directory", (b, p) => b.durablePublishDirectory(p, p, "child")],
    ["publish directory to WSL", (b, p) => b.durablePublishDirectory("C:\\fixture\\source", p, "child")],
    ["compare filesystems", (b, p) => b.directoriesShareFilesystem(p, p)],
    ["executable support", (b, p) => b.assertExecutableStateSupported(p, false)],
    ["chmod", (b, p) => b.chmodIfDifferent(p, true)],
];

describe("Win32 direct selected-WSL mutation boundary", () => {
    it.each(directCalls)("rejects %s before native or helper access", (_name, call) => {
        const loadNative = vi.fn(),
            recycle = vi.fn();
        const backend = createWin32PhysicalFilesystemBackend(loadNative, recycle);
        for (const target of [
            TARGET,
            TARGET.replace("Ubuntu", "ubuntu"),
            TARGET.replace("Ubuntu", "Debian"),
            TARGET.replace("wsl.localhost", "wsl$"),
        ])
            expect(() => call(backend, target)).toThrowError(expect.objectContaining({ failureKind: "unsupported_platform" }));
        expect(loadNative).not.toHaveBeenCalled();
        expect(recycle).not.toHaveBeenCalled();
    });
    it("rejects direct selected-WSL full, range and batch reads before native access", () => {
        const loadNative = vi.fn();
        const backend = createWin32PhysicalFilesystemBackend(loadNative);
        for (const read of [
            () => backend.readRegularFileNoFollow(TARGET, 7),
            () => backend.readRegularFileRangeNoFollow(TARGET, 0, 7),
            () => backend.readRegularFilesNoFollow([{ filePath: TARGET, maximumBytes: 7 }], 7),
        ]) {
            expect(read).toThrowError(
                expect.objectContaining({ failureKind: "unsupported_platform", systemCode: "WSL_READ_REQUIRES_LINUX_EXECUTION" }),
            );
        }
        expect(loadNative).not.toHaveBeenCalled();
    });
});
