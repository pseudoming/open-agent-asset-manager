import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { getHomeDir, resolveHome, isWsl } from "../../../src/paths/unix-like/path-environment";

describe("unix-paths", () => {
    describe("getHomeDir", () => {
        it("returns a non-empty string", () => {
            const home = getHomeDir();
            expect(typeof home).toBe("string");
            expect(home.length).toBeGreaterThan(0);
        });

        it("matches os.homedir()", () => {
            expect(getHomeDir()).toBe(os.homedir());
        });
    });

    describe("resolveHome", () => {
        it("resolves ~/path to home directory", () => {
            const result = resolveHome("~/test/path");
            expect(result).toBe(path.resolve(os.homedir(), "test/path"));
        });

        it("resolves ~/ alone to home directory", () => {
            const result = resolveHome("~/");
            expect(result).toBe(os.homedir());
        });

        it("returns an absolute host path unchanged", () => {
            // A leading slash omits the drive on Windows; use a fully qualified host path.
            const absolutePath = path.join(path.parse(process.cwd()).root, "absolute", "path");
            const result = resolveHome(absolutePath);
            expect(result).toBe(absolutePath);
        });

        it("resolves relative path relative to cwd", () => {
            const result = resolveHome("relative/path");
            expect(result).toBe(path.resolve("relative/path"));
        });

        it("does not expand ~ in the middle of a path (spec: only ~/ prefix)", () => {
            const absolutePath = path.join(path.parse(process.cwd()).root, "path", "~", "file");
            const result = resolveHome(absolutePath);
            expect(result).toBe(absolutePath);
        });
    });

    describe("isWsl", () => {
        const originalEnv = { ...process.env };

        afterEach(() => {
            process.env = { ...originalEnv };
        });

        it("returns true when WSL_DISTRO_NAME is set", () => {
            process.env.WSL_DISTRO_NAME = "Ubuntu";
            expect(isWsl()).toBe(true);
        });

        // The following three tests are environment-dependent: they only make
        // assertions when the real /proc/version matches the expected pattern.
        // On non-matching environments they are skipped (not silently passing
        // with zero assertions) to avoid "test theater" — the mocked tests in
        // test_platform.test.ts already cover isWsl deterministically.

        it.skipIf(!fs.existsSync("/proc/version") || !/microsoft|Microsoft/i.test(fs.readFileSync("/proc/version", "utf-8")))(
            "returns true when /proc/version contains Microsoft (kernel check)",
            () => {
                delete process.env.WSL_DISTRO_NAME;
                expect(isWsl()).toBe(true);
            },
        );

        it.skipIf(!fs.existsSync("/proc/version") || /microsoft|Microsoft/i.test(fs.readFileSync("/proc/version", "utf-8")))(
            "returns false when /proc/version has no Microsoft and no env var",
            () => {
                delete process.env.WSL_DISTRO_NAME;
                expect(isWsl()).toBe(false);
            },
        );

        it.skipIf(fs.existsSync("/proc/version"))("returns false when /proc/version does not exist and no env var", () => {
            delete process.env.WSL_DISTRO_NAME;
            expect(isWsl()).toBe(false);
        });
    });
});
