import { describe, expect, it, vi } from "vitest";
import type { PlatformContextRegularFileReadInput } from "../../../src/paths/path-environment";
import { createWin32PlatformContextRegularFileReader } from "../../../src/paths/win32/platform-context-regular-file";

const local: PlatformContextRegularFileReadInput = {
    platform: "win32",
    platformInstanceId: "desktop-local",
    accessRootPath: "C:\\fixture",
    filePath: "C:\\fixture\\asset.md",
    maximumBytes: 128,
};

function fixture() {
    const snapshot = {
        bytes: new Uint8Array([1, 2]),
        executable: false,
        identity: { deviceId: "1", fileId: "2", entryKind: "file" as const },
    };
    const readRegularFileNoFollow = vi.fn(() => snapshot);
    return { read: createWin32PlatformContextRegularFileReader({ readRegularFileNoFollow }), readRegularFileNoFollow, snapshot };
}

describe("Windows-local platform-context file reads", () => {
    it("retains the native no-follow identity, bytes and caller bound", () => {
        const f = fixture();
        expect(f.read(local)).toBe(f.snapshot);
        expect(f.readRegularFileNoFollow).toHaveBeenCalledOnce();
        expect(f.readRegularFileNoFollow).toHaveBeenCalledWith(local.filePath, 128);
    });

    it.each(["wsl.localhost", "wsl$", "WSL.LOCALHOST"])("requires Linux execution for %s without native file access", (host) => {
        const f = fixture();
        const accessRootPath = `\\\\${host}\\Ubuntu\\`;
        expect(() =>
            f.read({
                ...local,
                platform: "wsl",
                platformInstanceId: "Ubuntu",
                accessRootPath,
                filePath: `${accessRootPath}home\\example\\asset.md`,
            }),
        ).toThrowError(expect.objectContaining({ systemCode: "WSL_READ_REQUIRES_LINUX_EXECUTION" }));
        expect(f.readRegularFileNoFollow).not.toHaveBeenCalled();
    });

    it("rejects an unselected WSL projection even when labeled Windows", () => {
        const f = fixture();
        const accessRootPath = "\\\\wsl.localhost\\Ubuntu\\";
        expect(() => f.read({ ...local, accessRootPath, filePath: `${accessRootPath}tmp\\asset.md` })).toThrow();
        expect(f.readRegularFileNoFollow).not.toHaveBeenCalled();
    });

    it.each([
        { maximumBytes: -1 },
        { maximumBytes: Number.NaN },
    ])("rejects invalid byte bounds before native file access: %j", (change) => {
        const f = fixture();
        expect(() => f.read({ ...local, ...change })).toThrow();
        expect(f.readRegularFileNoFollow).not.toHaveBeenCalled();
    });

    it("preserves the exact native failure", () => {
        const denied = new Error("native permission denied");
        const read = createWin32PlatformContextRegularFileReader({
            readRegularFileNoFollow: () => {
                throw denied;
            },
        });
        expect(() => read(local)).toThrow(denied);
    });
});
