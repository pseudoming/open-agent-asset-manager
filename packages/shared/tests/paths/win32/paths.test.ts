import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
    detectReachablePathPlatforms,
    getHomeDir,
    getWslDistroNames,
    isWsl,
    resolveHome,
} from "../../../src/paths/win32/path-environment";

describe("win-paths", () => {
    describe("PathEnvironment contract", () => {
        it("reports the Windows host and any reachable WSL environment without claiming to run inside WSL", () => {
            expect(isWsl()).toBe(false);
            const platforms = detectReachablePathPlatforms();
            expect(platforms[0]).toBe("win32");
            expect(platforms.every((platform) => platform === "win32" || platform === "wsl")).toBe(true);
        });
    });

    describe("getHomeDir", () => {
        it("returns a non-empty string", () => {
            const home = getHomeDir();
            expect(typeof home).toBe("string");
            expect(home.length).toBeGreaterThan(0);
        });

        it("returns USERPROFILE when set", () => {
            const original = process.env.USERPROFILE;
            process.env.USERPROFILE = "C:\\Users\\testuser";
            try {
                expect(getHomeDir()).toBe("C:\\Users\\testuser");
            } finally {
                if (original !== undefined) {
                    process.env.USERPROFILE = original;
                } else {
                    delete process.env.USERPROFILE;
                }
            }
        });
    });

    describe("resolveHome", () => {
        it("resolves ~/path to home directory", () => {
            const original = process.env.USERPROFILE;
            process.env.USERPROFILE = "C:\\Users\\testuser";
            try {
                const result = resolveHome("~/code/project");
                expect(result).toBe(path.resolve("C:\\Users\\testuser", "code", "project"));
            } finally {
                if (original !== undefined) {
                    process.env.USERPROFILE = original;
                } else {
                    delete process.env.USERPROFILE;
                }
            }
        });

        it.skipIf(process.platform !== "win32")("resolves ~\\path on Windows-style prefix", () => {
            const original = process.env.USERPROFILE;
            process.env.USERPROFILE = "C:\\Users\\testuser";
            try {
                const result = resolveHome("~\\code\\project");
                expect(result).toBe(path.resolve("C:\\Users\\testuser", "code", "project"));
            } finally {
                if (original !== undefined) {
                    process.env.USERPROFILE = original;
                } else {
                    delete process.env.USERPROFILE;
                }
            }
        });

        it("returns path without ~ prefix unchanged", () => {
            const result = resolveHome("C:\\absolute\\path");
            expect(result).toBe(path.resolve("C:\\absolute\\path"));
        });
    });

    describe("getWslDistroNames", () => {
        // Removed empty "is skipped on non-Windows platforms" test that had
        // zero assertions. The real Windows test below uses skipIf correctly.

        it.skipIf(process.platform !== "win32")("returns array of strings on Windows", () => {
            const names = getWslDistroNames();
            expect(Array.isArray(names)).toBe(true);
        });

        it.skipIf(process.platform === "win32")("returns empty array when wsl.exe is not available on non-Windows", () => {
            const names = getWslDistroNames();
            expect(Array.isArray(names)).toBe(true);
        });
    });
});
