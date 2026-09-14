import { describe, expect, it, vi } from "vitest";
import { discoverDesktopPlatformContexts } from "../src/main/platform-contexts";

describe("Desktop platform-context discovery", () => {
    it("keeps Windows first and exposes only reviewed running WSL candidates", () => {
        const getRunningWslDistroNames = vi.fn(() => [
            "Ubuntu-24.04",
            "docker-desktop",
            "Ubuntu",
            "docker-desktop-data",
            "Ubuntu",
        ]);
        const getWslAccessRootPath = vi.fn((distroName: string) => `\\\\wsl.localhost\\${distroName}\\`);

        expect(
            discoverDesktopPlatformContexts({
                hostPlatform: "win32",
                homePath: "C:\\Users\\person",
                getRunningWslDistroNames,
                getWslAccessRootPath,
            }),
        ).toEqual([
            { platform: "win32", platformInstanceId: "desktop-local", accessRootPath: "C:\\" },
            { platform: "wsl", platformInstanceId: "Ubuntu", accessRootPath: "\\\\wsl.localhost\\Ubuntu\\" },
            {
                platform: "wsl",
                platformInstanceId: "Ubuntu-24.04",
                accessRootPath: "\\\\wsl.localhost\\Ubuntu-24.04\\",
            },
        ]);
        expect(getRunningWslDistroNames).toHaveBeenCalledOnce();
        expect(getWslAccessRootPath.mock.calls).toEqual([["Ubuntu"], ["Ubuntu-24.04"]]);
    });

    it("never enumerates WSL from a non-Windows Desktop Host", () => {
        const getRunningWslDistroNames = vi.fn(() => ["Ubuntu"]);
        const getWslAccessRootPath = vi.fn(() => "unexpected");

        expect(
            discoverDesktopPlatformContexts({
                hostPlatform: "linux",
                homePath: "/home/person",
                getRunningWslDistroNames,
                getWslAccessRootPath,
            }),
        ).toEqual([{ platform: "linux", platformInstanceId: "desktop-local", accessRootPath: "/" }]);
        expect(getRunningWslDistroNames).not.toHaveBeenCalled();
        expect(getWslAccessRootPath).not.toHaveBeenCalled();
    });

    it("rejects a relative home path that cannot establish a local context", () => {
        expect(() =>
            discoverDesktopPlatformContexts({
                hostPlatform: "win32",
                homePath: "Users\\person",
                getRunningWslDistroNames: () => [],
                getWslAccessRootPath: () => "",
            }),
        ).toThrow("must be absolute");
    });
});
