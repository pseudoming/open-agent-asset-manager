import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecFileSync, mockExecSync } = vi.hoisted(() => ({
    mockExecFileSync: vi.fn(),
    mockExecSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
    execFileSync: mockExecFileSync,
    execSync: mockExecSync,
}));

import {
    detectReachablePathPlatforms,
    getRunningWslDistroNames,
    getWslAccessRootPath,
    getWslDistroNames,
    resolveWslHomePath,
    withPathEnvironmentObservation,
} from "../../../src/paths/win32/path-environment";

describe("Win32 WSL path-environment mechanics", () => {
    afterEach(() => {
        vi.resetAllMocks();
    });

    it("decodes the real UTF-16LE wsl.exe distribution-list shape", () => {
        mockExecSync.mockReturnValue(Buffer.from("Ubuntu\r\ndocker-desktop\r\n", "utf16le"));

        expect(getWslDistroNames()).toEqual(["Ubuntu", "docker-desktop"]);
        expect(mockExecSync).toHaveBeenCalledWith("wsl.exe -l -q", { timeout: 5000 });
    });

    it("uses the running-only command for reachability without treating installed distros as reachable", () => {
        mockExecSync.mockImplementation((command: string) =>
            Buffer.from(command.includes("--running") ? "" : "Ubuntu\r\n", "utf16le"),
        );

        expect(getWslDistroNames()).toEqual(["Ubuntu"]);
        expect(getRunningWslDistroNames()).toEqual([]);
        expect(detectReachablePathPlatforms()).toEqual(["win32"]);
        expect(mockExecSync).toHaveBeenCalledWith("wsl.exe -l --running -q", { timeout: 5000 });
    });

    it("returns WSL reachability only when the running-only query contains a safe distribution", () => {
        mockExecSync.mockReturnValue(Buffer.from("Ubuntu\r\n", "utf16le"));

        expect(detectReachablePathPlatforms()).toEqual(["win32", "wsl"]);
    });

    it("deduplicates safe names and rejects path-like or control-bearing output", () => {
        mockExecSync.mockReturnValue(Buffer.from("Ubuntu\r\nUbuntu\r\n../escape\r\nbad/name\r\nbad\u0001name\r\n", "utf8"));

        expect(getWslDistroNames()).toEqual(["Ubuntu"]);
    });

    it("constructs one canonical wsl.localhost access root", () => {
        expect(getWslAccessRootPath("Ubuntu-24.04")).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\");
        expect(() => getWslAccessRootPath("../Ubuntu")).toThrow(TypeError);
    });

    it("resolves the selected distribution home only after confirming installation", () => {
        mockExecSync.mockReturnValue(Buffer.from("Ubuntu\r\n", "utf16le"));
        mockExecFileSync.mockReturnValue(Buffer.from("/home/example\n", "utf8"));

        expect(resolveWslHomePath("Ubuntu")).toEqual({
            status: "available",
            homePath: "\\\\wsl.localhost\\Ubuntu\\home\\example",
        });
        expect(mockExecFileSync).toHaveBeenCalledWith("wsl.exe", ["-d", "Ubuntu", "--exec", "printenv", "HOME"], {
            timeout: 5000,
        });
    });

    it("fails closed for invalid, absent, failed and noncanonical home resolutions", () => {
        expect(resolveWslHomePath("../Ubuntu")).toEqual({ status: "unavailable", reason: "invalid_distro_name" });

        mockExecSync.mockReturnValueOnce(Buffer.from("Debian\r\n", "utf16le"));
        expect(resolveWslHomePath("Ubuntu")).toEqual({ status: "unavailable", reason: "not_installed" });

        mockExecSync.mockReturnValueOnce(Buffer.from("Ubuntu\r\n", "utf16le"));
        mockExecFileSync.mockImplementationOnce(() => {
            throw new Error("wsl unavailable");
        });
        expect(resolveWslHomePath("Ubuntu")).toEqual({ status: "unavailable", reason: "command_failed" });

        mockExecSync.mockReturnValueOnce(Buffer.from("Ubuntu\r\n", "utf16le"));
        mockExecFileSync.mockReturnValueOnce(Buffer.from("/home/../root\n", "utf8"));
        expect(resolveWslHomePath("Ubuntu")).toEqual({ status: "unavailable", reason: "invalid_home" });
    });
});

describe("operation-local selected WSL HOME observations", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockExecSync.mockReturnValue(Buffer.from("Ubuntu\r\n", "utf16le"));
        mockExecFileSync.mockReturnValue(Buffer.from("/home/example\n", "utf8"));
    });

    afterEach(() => vi.resetAllMocks());

    it("keeps unscoped resolutions fresh instead of installing a process-wide cache", () => {
        resolveWslHomePath("Ubuntu");
        mockExecFileSync.mockReturnValue(Buffer.from("/home/changed\n", "utf8"));
        expect(resolveWslHomePath("Ubuntu")).toEqual({
            status: "available",
            homePath: "\\\\wsl.localhost\\Ubuntu\\home\\changed",
        });
        expect(mockExecSync).toHaveBeenCalledTimes(2);
        expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    });

    it("resolves six overlapping consumers once and gives each an independent value", async () => {
        await withPathEnvironmentObservation(async () => {
            const resolutions = await Promise.all(
                Array.from({ length: 6 }, async () => {
                    await Promise.resolve();
                    return resolveWslHomePath("Ubuntu");
                }),
            );
            const expected = { status: "available", homePath: "\\\\wsl.localhost\\Ubuntu\\home\\example" };
            expect(resolutions).toEqual(Array.from({ length: 6 }, () => expected));
            expect(new Set(resolutions).size).toBe(6);
            (resolutions[0] as { homePath: string }).homePath = "C:\\foreign";
            expect(resolutions[1]).toEqual(expected);
            expect(resolveWslHomePath("Ubuntu")).toEqual(expected);
        });
        expect(mockExecSync).toHaveBeenCalledTimes(1);
        expect(mockExecFileSync).toHaveBeenCalledTimes(1);
        expect(mockExecSync).toHaveBeenCalledWith("wsl.exe -l -q", { timeout: 5000 });
        expect(mockExecFileSync).toHaveBeenCalledWith("wsl.exe", ["-d", "Ubuntu", "--exec", "printenv", "HOME"], {
            timeout: 5000,
        });
    });

    it("does not merge exact distribution names or borrow a different distribution's HOME", async () => {
        mockExecSync.mockReturnValue(Buffer.from("Ubuntu\r\nDebian\r\nubuntu\r\n", "utf16le"));
        mockExecFileSync.mockImplementation((_executable: string, arguments_: readonly string[]) =>
            Buffer.from(`/home/${arguments_[1]}\n`, "utf8"),
        );
        await withPathEnvironmentObservation(async () => {
            for (const distroName of ["Ubuntu", "Debian", "ubuntu", "Ubuntu", "Debian", "ubuntu"]) {
                expect(resolveWslHomePath(distroName)).toEqual({
                    status: "available",
                    homePath: `\\\\wsl.localhost\\${distroName}\\home\\${distroName}`,
                });
            }
        });
        expect(mockExecSync).toHaveBeenCalledTimes(3);
        expect(mockExecFileSync).toHaveBeenCalledTimes(3);
    });

    it("retains one unavailable observation only until the current operation settles", async () => {
        mockExecFileSync.mockImplementation(() => {
            throw new Error("selected distribution unavailable");
        });
        await withPathEnvironmentObservation(async () => {
            expect(resolveWslHomePath("Ubuntu")).toEqual({ status: "unavailable", reason: "command_failed" });
            mockExecFileSync.mockReturnValue(Buffer.from("/home/restored\n", "utf8"));
            expect(resolveWslHomePath("Ubuntu")).toEqual({ status: "unavailable", reason: "command_failed" });
        });
        expect(mockExecFileSync).toHaveBeenCalledTimes(1);
        await withPathEnvironmentObservation(async () => {
            expect(resolveWslHomePath("Ubuntu")).toEqual({
                status: "available",
                homePath: "\\\\wsl.localhost\\Ubuntu\\home\\restored",
            });
        });
        expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    });

    it("isolates simultaneous operations even when they use the same exact distribution", async () => {
        let releaseFirst = (): void => {};
        const gate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const first = withPathEnvironmentObservation(async () => {
            const original = resolveWslHomePath("Ubuntu");
            await gate;
            expect(resolveWslHomePath("Ubuntu")).toEqual(original);
            return original;
        });
        mockExecFileSync.mockReturnValue(Buffer.from("/home/second\n", "utf8"));
        try {
            await withPathEnvironmentObservation(async () => {
                expect(resolveWslHomePath("Ubuntu")).toEqual({
                    status: "available",
                    homePath: "\\\\wsl.localhost\\Ubuntu\\home\\second",
                });
            });
        } finally {
            releaseFirst();
        }
        await expect(first).resolves.toMatchObject({ homePath: "\\\\wsl.localhost\\Ubuntu\\home\\example" });
        expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    });

    it("gives nested operations a fresh observation and restores the live outer scope", async () => {
        await withPathEnvironmentObservation(async () => {
            const outer = resolveWslHomePath("Ubuntu");
            mockExecFileSync.mockReturnValue(Buffer.from("/home/nested\n", "utf8"));
            await withPathEnvironmentObservation(async () => {
                expect(resolveWslHomePath("Ubuntu")).toMatchObject({ homePath: "\\\\wsl.localhost\\Ubuntu\\home\\nested" });
            });
            expect(resolveWslHomePath("Ubuntu")).toEqual(outer);
        });
        expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    });

    it.each([false, true])("retires cached facts for late descendants after failure=%s", async (fail) => {
        let releaseLate = (): void => {};
        const gate = new Promise<void>((resolve) => {
            releaseLate = resolve;
        });
        let late: Promise<ReturnType<typeof resolveWslHomePath>> | undefined;
        const operation = withPathEnvironmentObservation(async () => {
            resolveWslHomePath("Ubuntu");
            late = gate.then(() => resolveWslHomePath("Ubuntu"));
            if (fail) throw new Error("caller failed");
            return "complete";
        });
        if (fail) await expect(operation).rejects.toThrow("caller failed");
        else await expect(operation).resolves.toBe("complete");
        mockExecFileSync.mockReturnValue(Buffer.from("/home/after\n", "utf8"));
        releaseLate();
        await expect(late).resolves.toEqual({ status: "available", homePath: "\\\\wsl.localhost\\Ubuntu\\home\\after" });
        expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    });

    it("preserves installed-only action-time behavior instead of claiming a new running-state check", async () => {
        mockExecSync.mockImplementation((command: string) =>
            Buffer.from(command.includes("--running") ? "" : "Ubuntu\r\n", "utf16le"),
        );
        expect(getRunningWslDistroNames()).toEqual([]);
        await withPathEnvironmentObservation(async () => {
            expect(resolveWslHomePath("Ubuntu")).toMatchObject({ status: "available" });
            expect(resolveWslHomePath("Ubuntu")).toMatchObject({ status: "available" });
        });
        expect(mockExecSync.mock.calls.map(([command]) => command)).toEqual(["wsl.exe -l --running -q", "wsl.exe -l -q"]);
        expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });
});
