/**
 * Platform detection tests — migrated from core/tests/legacy/test_platform.test.ts
 * in Step 4 (detection moved from core/platform.ts to shared/unix-paths).
 *
 * Uses vi.mock on node:fs and node:child_process to cover runtime detection
 * branches (isWsl / probeCurrentPlatform / getWslDistroNames) unreachable on
 * genuine Linux.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadFileSync, mockExecSync, mockExistsSync } = vi.hoisted(() => ({
    mockReadFileSync: vi.fn(),
    mockExecSync: vi.fn(),
    mockExistsSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
    default: {
        readFileSync: mockReadFileSync,
        existsSync: mockExistsSync,
    },
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
}));

vi.mock("node:child_process", () => ({
    execSync: mockExecSync,
}));

import {
    detectReachablePathPlatforms,
    getRunningWslDistroNames,
    getWslAccessRootPath,
    getWslDistroNames,
    isWsl,
    resolveWslHomePath,
} from "../../../src/paths/unix-like/path-environment";

describe("Unix-like reachable path environments", () => {
    let origPlatform: string;

    beforeEach(() => {
        origPlatform = process.platform;
    });

    afterEach(() => {
        vi.resetAllMocks();
        delete process.env.WSL_DISTRO_NAME;
        Object.defineProperty(process, "platform", {
            value: origPlatform,
            configurable: true,
            writable: true,
        });
    });

    const setPlatform = (p: string) => {
        Object.defineProperty(process, "platform", {
            value: p,
            configurable: true,
            writable: true,
        });
    };

    it("returns [win32, wsl] when wsl.exe has distros", () => {
        setPlatform("win32");
        mockExecSync.mockReturnValue(Buffer.from("Ubuntu\r\nDebian\r\n", "utf16le"));
        const platforms = detectReachablePathPlatforms();
        expect(platforms).toEqual(["win32", "wsl"]);
        expect(mockExecSync).toHaveBeenCalledWith("wsl.exe -l --running -q", { timeout: 5000 });
    });

    it("returns [win32] when wsl.exe has no output", () => {
        setPlatform("win32");
        mockExecSync.mockReturnValue("");
        const platforms = detectReachablePathPlatforms();
        expect(platforms).toEqual(["win32"]);
    });

    it("returns [win32] when wsl.exe throws", () => {
        setPlatform("win32");
        mockExecSync.mockImplementation(() => {
            throw new Error("not found");
        });
        const platforms = detectReachablePathPlatforms();
        expect(platforms).toEqual(["win32"]);
    });

    it("returns [darwin] without probing WSL on macOS", () => {
        setPlatform("darwin");
        mockReadFileSync.mockReturnValue("Linux ... microsoft ...");
        mockExistsSync.mockReturnValue(true);
        expect(detectReachablePathPlatforms()).toEqual(["darwin"]);
        expect(mockReadFileSync).not.toHaveBeenCalled();
        expect(mockExistsSync).not.toHaveBeenCalled();
        expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("returns [wsl, win32] when /mnt/c/ exists", () => {
        setPlatform("linux");
        mockReadFileSync.mockReturnValue("Linux ... microsoft ...");
        mockExistsSync.mockReturnValue(true);
        const platforms = detectReachablePathPlatforms();
        expect(platforms).toEqual(["wsl", "win32"]);
    });

    it("returns [wsl] when /mnt/c/ missing", () => {
        setPlatform("linux");
        mockReadFileSync.mockReturnValue("Linux ... microsoft ...");
        mockExistsSync.mockReturnValue(false);
        const platforms = detectReachablePathPlatforms();
        expect(platforms).toEqual(["wsl"]);
    });

    it("returns [wsl] via WSL_DISTRO_NAME when /proc/version throws", () => {
        setPlatform("linux");
        mockReadFileSync.mockImplementation(() => {
            throw new Error("ENOENT");
        });
        process.env.WSL_DISTRO_NAME = "Ubuntu";
        const platforms = detectReachablePathPlatforms();
        expect(platforms).toEqual(["wsl"]);
    });

    it("returns [linux] for genuine Linux", () => {
        setPlatform("linux");
        mockReadFileSync.mockReturnValue("Linux version 5.15 genuine");
        const platforms = detectReachablePathPlatforms();
        expect(platforms).toEqual(["linux"]);
    });
});

describe("platform: getWslDistroNames", () => {
    afterEach(() => {
        vi.resetAllMocks();
    });

    it("parses wsl.exe output", () => {
        mockExecSync.mockReturnValue("Ubuntu\nDebian\n");
        expect(getWslDistroNames()).toEqual(["Ubuntu", "Debian"]);
    });

    it("uses a separate running-distribution query", () => {
        mockExecSync.mockReturnValue(Buffer.from("Ubuntu\r\n", "utf16le"));
        expect(getRunningWslDistroNames()).toEqual(["Ubuntu"]);
        expect(mockExecSync).toHaveBeenCalledWith("wsl.exe -l --running -q", { timeout: 5000 });
    });

    it("returns empty on exec error", () => {
        mockExecSync.mockImplementation(() => {
            throw new Error("not found");
        });
        expect(getWslDistroNames()).toEqual([]);
    });
});

describe("platform: isWsl", () => {
    afterEach(() => {
        vi.resetAllMocks();
        delete process.env.WSL_DISTRO_NAME;
    });

    it("returns true when WSL_DISTRO_NAME env is set", () => {
        process.env.WSL_DISTRO_NAME = "Ubuntu";
        expect(isWsl()).toBe(true);
    });

    it("returns true when /proc/version mentions microsoft", () => {
        delete process.env.WSL_DISTRO_NAME;
        mockReadFileSync.mockReturnValue("Linux version ... microsoft ...");
        expect(isWsl()).toBe(true);
    });

    it("returns false when /proc/version throws and no WSL_DISTRO_NAME", () => {
        delete process.env.WSL_DISTRO_NAME;
        mockReadFileSync.mockImplementation(() => {
            throw new Error("ENOENT");
        });
        expect(isWsl()).toBe(false);
    });

    it("returns false on genuine Linux /proc/version", () => {
        delete process.env.WSL_DISTRO_NAME;
        mockReadFileSync.mockReturnValue("Linux version 5.15 genuine");
        expect(isWsl()).toBe(false);
    });
});

describe("Unix-like WSL context paths", () => {
    afterEach(() => {
        vi.resetAllMocks();
        delete process.env.WSL_DISTRO_NAME;
    });

    it("returns the current WSL root and home only for the exact current distribution", () => {
        process.env.WSL_DISTRO_NAME = "Ubuntu";
        expect(getWslAccessRootPath("Ubuntu")).toBe("/");
        expect(resolveWslHomePath("Ubuntu")).toMatchObject({ status: "available" });
        expect(resolveWslHomePath("Debian")).toEqual({ status: "unavailable", reason: "wrong_host" });
    });

    it("rejects unsafe or foreign distribution root requests", () => {
        expect(resolveWslHomePath("../Ubuntu")).toEqual({ status: "unavailable", reason: "invalid_distro_name" });
        expect(() => getWslAccessRootPath("../Ubuntu")).toThrow(TypeError);
        expect(() => getWslAccessRootPath("Ubuntu")).toThrow(TypeError);
    });
});
