import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
    canonicalHostPath,
    canonicalProviderHostPathWithinAccessRoot,
    hostAbsolutePathToRuntime,
    hostPathApiFor,
    isWindowsHostedWslContext,
    isWslUncHostPath,
    resolveProviderHostPathReference,
    resolveProviderProbeEnvironment,
    runtimeAbsolutePathToHost,
} from "../src/probe-paths";

const WSL_HOME = "\\\\wsl.localhost\\Ubuntu\\home\\example";
const WSL_CONTEXT = { platform: "wsl", platformInstanceId: "Ubuntu", accessRootPath: WSL_HOME } as const;
const WSL_ROOT_CONTEXT = {
    platform: "wsl",
    platformInstanceId: "Ubuntu",
    accessRootPath: "\\\\wsl.localhost\\Ubuntu\\",
} as const;

describe("Provider probe Host-path mechanics", () => {
    it("selects only one canonical absolute grammar", () => {
        expect(hostPathApiFor("/home/example")).toBe(posix);
        expect(hostPathApiFor(WSL_HOME)).toBe(win32);
        expect(hostPathApiFor("C:\\Users\\agent")).toBe(win32);
        expect(hostPathApiFor("relative")).toBeNull();
        expect(hostPathApiFor("\\root-relative")).toBeNull();
        expect(hostPathApiFor("\\\\?\\C:\\opaque")).toBeNull();
        expect(canonicalHostPath("/home/example")).toBe("/home/example");
        expect(canonicalHostPath("/home/../agent")).toBeNull();
        expect(canonicalHostPath("bad\0path")).toBeNull();
    });

    it("consumes the current process environment only in its own physical context", () => {
        const environment = { PATH: "/fixture/bin", CLAUDE_CONFIG_DIR: "/fixture/config" };
        expect(resolveProviderProbeEnvironment(WSL_CONTEXT, environment, "C:\\Users\\agent", "win32")).toBeNull();
        expect(
            resolveProviderProbeEnvironment(
                { platform: "wsl", platformInstanceId: "Ubuntu", accessRootPath: "/" },
                environment,
                "/home/example",
                "linux",
            ),
        ).toEqual({ environment, homePath: "/home/example" });
        expect(
            resolveProviderProbeEnvironment(
                { platform: "darwin", platformInstanceId: "remote", accessRootPath: "/" },
                environment,
                "/Users/agent",
                "linux",
            ),
        ).toBeNull();
        expect(
            resolveProviderProbeEnvironment(
                { platform: "wsl", platformInstanceId: "fake", accessRootPath: "C:\\Users\\agent" },
                environment,
                "C:\\Users\\agent",
                "win32",
            ),
        ).toBeNull();
        expect(
            resolveProviderProbeEnvironment(
                { platform: "linux", platformInstanceId: "bounded", accessRootPath: "/selected" },
                environment,
                "/foreign/home",
                "linux",
            ),
        ).toBeNull();
    });

    it("maps runtime WSL paths through the selected distro share without inventing aliases", () => {
        expect(runtimeAbsolutePathToHost("wsl", WSL_HOME, "/home/example/project")).toBe(
            "\\\\wsl.localhost\\Ubuntu\\home\\example\\project",
        );
        expect(hostAbsolutePathToRuntime("wsl", WSL_HOME, "\\\\wsl.localhost\\Ubuntu\\home\\example\\project")).toBe(
            "/home/example/project",
        );
        expect(runtimeAbsolutePathToHost("wsl", WSL_HOME, "/")).toBe("\\\\wsl.localhost\\Ubuntu\\");
        expect(hostAbsolutePathToRuntime("wsl", WSL_HOME, "\\\\wsl.localhost\\Ubuntu\\")).toBe("/");
        expect(hostAbsolutePathToRuntime("wsl", WSL_HOME, "\\\\wsl.localhost\\Debian\\home\\example")).toBeNull();
        expect(hostAbsolutePathToRuntime("wsl", "C:\\Users\\agent", "C:\\Users\\agent\\project")).toBeNull();
        expect(runtimeAbsolutePathToHost("wsl", WSL_HOME, "/home/../secret")).toBeNull();
        expect(runtimeAbsolutePathToHost("linux", "/", "/home/example")).toBe("/home/example");
        expect(hostAbsolutePathToRuntime("linux", "/", "/home/example")).toBe("/home/example");
        expect(isWindowsHostedWslContext(WSL_CONTEXT, "win32")).toBe(true);
        expect(isWindowsHostedWslContext(WSL_CONTEXT, "linux")).toBe(false);
        expect(isWslUncHostPath(WSL_HOME)).toBe(true);
        expect(isWslUncHostPath("\\\\server\\share\\home\\example")).toBe(false);
        expect(
            isWindowsHostedWslContext({ platform: "wsl", platformInstanceId: "local", accessRootPath: "/home/example" }, "win32"),
        ).toBe(false);
    });

    it("resolves Host, runtime, and relative references without crossing path grammars", () => {
        const posixContext = { platform: "linux", platformInstanceId: "local", accessRootPath: "/" } as const;
        expect(resolveProviderHostPathReference("/repo/.git", "/repo/.git/worktrees/a", posixContext)).toBe(
            "/repo/.git/worktrees/a",
        );
        expect(resolveProviderHostPathReference(WSL_HOME, "/work/project", WSL_ROOT_CONTEXT)).toBe(
            "\\\\wsl.localhost\\Ubuntu\\work\\project",
        );
        expect(resolveProviderHostPathReference(`${WSL_HOME}\\repo`, "../shared", WSL_CONTEXT)).toBe(`${WSL_HOME}\\shared`);
        expect(
            resolveProviderHostPathReference(`${WSL_HOME}\\repo`, "\\\\wsl.localhost\\Debian\\secret", WSL_CONTEXT),
        ).toBeNull();
        expect(resolveProviderHostPathReference(`${WSL_HOME}\\repo`, "C:\\secret", WSL_CONTEXT)).toBeNull();
        expect(resolveProviderHostPathReference("\\\\wsl.localhost\\Debian\\repo", "child", WSL_CONTEXT)).toBeNull();
        expect(resolveProviderHostPathReference("/repo", "C:\\foreign", posixContext)).toBeNull();
        expect(resolveProviderHostPathReference("/repo", "/repo/../escape", posixContext)).toBeNull();
        expect(resolveProviderHostPathReference("relative", "child", WSL_CONTEXT)).toBeNull();
        expect(resolveProviderHostPathReference("/repo", "bad\0path", posixContext)).toBeNull();
        expect(canonicalProviderHostPathWithinAccessRoot(`${WSL_HOME}\\repo`, WSL_CONTEXT)).toBe(`${WSL_HOME}\\repo`);
        expect(canonicalProviderHostPathWithinAccessRoot("\\\\wsl.localhost\\Ubuntu-24.04\\repo", WSL_CONTEXT)).toBeNull();
    });
});
