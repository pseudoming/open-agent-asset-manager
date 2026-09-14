import { describe, expect, it } from "vitest";
import {
    MAX_SANITIZED_PROJECT_KEY_LENGTH,
    getPathRule,
    resolveClaudeConfigRoot,
    resolveFullMemoryOverride,
    resolveProjectMemoryRoot,
    sanitizePath,
} from "../src/claudecode-paths";

describe("Claude Code path rules", () => {
    const wslHome = "\\\\wsl.localhost\\Ubuntu\\home\\tester";
    const wslContext = {
        platform: "wsl",
        platformInstanceId: "wsl:Ubuntu",
        accessRootPath: "\\\\wsl.localhost\\Ubuntu\\",
    } as const;
    const win32Context = {
        platform: "win32",
        platformInstanceId: "win32:local",
        accessRootPath: "C:\\",
    } as const;

    it("matches the installed one-for-one project-key sanitizer", () => {
        expect(sanitizePath("/home//agent/project_with.dot")).toBe("-home--agent-project-with-dot");
        expect(sanitizePath("abc_X9")).toBe("abc-X9");
        expect(sanitizePath("a😀b")).toBe("a--b");
        expect(sanitizePath("")).toBe("");
    });

    it("bounds long project keys with a deterministic suffix", () => {
        const input = `/${"a/".repeat(130)}`;
        const first = sanitizePath(input);
        expect(first).toBe(sanitizePath(input));
        expect(first.slice(0, MAX_SANITIZED_PROJECT_KEY_LENGTH)).toBe(
            input.replaceAll("/", "-").slice(0, MAX_SANITIZED_PROJECT_KEY_LENGTH),
        );
        expect(first.length).toBeGreaterThan(MAX_SANITIZED_PROJECT_KEY_LENGTH);
    });

    it("resolves the default and environment-declared config roots", () => {
        expect(resolveClaudeConfigRoot({}, "/home/tester")).toEqual({
            path: "/home/tester/.claude",
            locatorKind: "runtime_known_rule",
            locatorKey: "claude_config_default",
        });
        expect(resolveClaudeConfigRoot({ CLAUDE_CONFIG_DIR: "/opt/claude-config" }, "/home/tester")).toEqual({
            path: "/opt/claude-config",
            locatorKind: "runtime_declared_path",
            locatorKey: "CLAUDE_CONFIG_DIR",
        });
        expect(resolveClaudeConfigRoot({ CLAUDE_CONFIG_DIR: "relative" }, "/home/tester")).toBeNull();
        expect(resolveClaudeConfigRoot({ CLAUDE_CONFIG_DIR: "  " }, "/home/tester")?.path).toBe("/home/tester/.claude");
        expect(resolveClaudeConfigRoot({}, wslHome)?.path).toBe(`${wslHome}\\.claude`);
        expect(resolveClaudeConfigRoot({}, "relative")).toBeNull();
    });

    it("resolves safe full-memory overrides and rejects broad/non-absolute roots", () => {
        expect(resolveFullMemoryOverride("~/memory", "setting", true, "/home/tester")).toEqual({
            path: "/home/tester/memory",
            locatorKind: "runtime_declared_path",
            locatorKey: "setting",
        });
        expect(resolveFullMemoryOverride("relative", "setting", false, "/home/tester")).toBeNull();
        expect(resolveFullMemoryOverride("/", "setting", false, "/home/tester")).toBeNull();
        expect(resolveFullMemoryOverride("~/../", "setting", true, "/home/tester")).toBeNull();
        expect(resolveFullMemoryOverride("~/..", "setting", true, "/home/tester")).toBeNull();
        expect(resolveFullMemoryOverride("~/", "setting", true, "/home/tester")).toBeNull();
        expect(resolveFullMemoryOverride("~\\", "setting", true, "C:\\Users\\tester")).toBeNull();
        expect(resolveFullMemoryOverride(undefined, "setting", true, "/home/tester")).toBeNull();
        expect(resolveFullMemoryOverride("  ", "setting", true, "/home/tester")).toBeNull();
        expect(resolveFullMemoryOverride("/safe\0bad", "setting", false, "/home/tester")).toBeNull();
        expect(resolveFullMemoryOverride("//server/share", "setting", false, "/home/tester")).toBeNull();
        expect(resolveFullMemoryOverride("\\\\server\\share", "setting", false, "C:\\Users\\tester")).toBeNull();
        expect(resolveFullMemoryOverride("C:\\", "setting", false, "C:\\Users\\tester")).toBeNull();
        expect(resolveFullMemoryOverride("C:\\safe-memory", "setting", false, "C:\\Users\\tester")?.path).toBe("C:\\safe-memory");
        expect(resolveFullMemoryOverride("~/memory", "setting", true, wslHome)?.path).toBe(`${wslHome}\\memory`);
        expect(resolveFullMemoryOverride(`${wslHome}\\memory`, "setting", false, wslHome, wslContext)?.path).toBe(
            `${wslHome}\\memory`,
        );
        expect(resolveFullMemoryOverride("/opt/memory", "setting", false, wslHome, wslContext)?.path).toBe(
            "\\\\wsl.localhost\\Ubuntu\\opt\\memory",
        );
        expect(resolveFullMemoryOverride("C:\\foreign", "setting", false, wslHome, wslContext)).toBeNull();
        expect(resolveFullMemoryOverride("\\\\wsl.localhost\\Debian\\memory", "setting", false, wslHome, wslContext)).toBeNull();
        expect(resolveFullMemoryOverride("\\\\wsl.localhost\\Ubuntu\\", "setting", false, wslHome, wslContext)).toBeNull();
        expect(resolveFullMemoryOverride("C:\\safe-memory", "setting", false, "C:\\Users\\tester", win32Context)?.path).toBe(
            "C:\\safe-memory",
        );
        expect(resolveFullMemoryOverride("/foreign", "setting", false, "C:\\Users\\tester", win32Context)).toBeNull();
    });

    it("derives project memory roots from the default or remote base", () => {
        expect(
            resolveProjectMemoryRoot({
                configRoot: "/home/tester/.claude",
                projectRootPath: "/work/repo",
                homeDir: "/home/tester",
            }),
        ).toEqual({
            path: "/home/tester/.claude/projects/-work-repo/memory",
            locatorKind: "runtime_known_rule",
            locatorKey: "claude_project_memory_default",
        });
        expect(
            resolveProjectMemoryRoot({
                configRoot: "/home/tester/.claude",
                projectRootPath: "/work/repo",
                remoteMemoryBase: "/remote",
                homeDir: "/home/tester",
            }),
        ).toEqual({
            path: "/remote/projects/-work-repo/memory",
            locatorKind: "runtime_declared_path",
            locatorKey: "CLAUDE_CODE_REMOTE_MEMORY_DIR",
        });
        expect(
            resolveProjectMemoryRoot({
                configRoot: "relative",
                projectRootPath: "/work/repo",
                homeDir: "/home/tester",
            }),
        ).toBeNull();
        expect(
            resolveProjectMemoryRoot({
                configRoot: `${wslHome}\\.claude`,
                projectRootPath: "/work/repo",
                homeDir: wslHome,
            })?.path,
        ).toBe(`${wslHome}\\.claude\\projects\\-work-repo\\memory`);
        expect(
            resolveProjectMemoryRoot({
                configRoot: "/tmp/claude",
                projectRootPath: "/work/repo",
            })?.path,
        ).toBe("/tmp/claude/projects/-work-repo/memory");
        expect(
            resolveProjectMemoryRoot({
                configRoot: `${wslHome}\\.claude`,
                projectRootPath: "/work/repo",
                remoteMemoryBase: "/opt/claude-memory",
                homeDir: wslHome,
                platformContext: wslContext,
            })?.path,
        ).toBe("\\\\wsl.localhost\\Ubuntu\\opt\\claude-memory\\projects\\-work-repo\\memory");
    });

    it("provides config-root rules for the four declared platforms", () => {
        for (const platform of ["linux", "darwin", "wsl", "win32"] as const) {
            const rule = getPathRule(platform, {}, "/home/tester");
            expect(rule).toMatchObject({
                platform,
                configRoot: "/home/tester/.claude",
                projectsDir: "/home/tester/.claude/projects",
            });
        }
        expect(getPathRule("linux", { CLAUDE_CONFIG_DIR: "relative" }, "/home/tester")).toBeNull();
        expect(getPathRule("linux", {}, "relative")).toBeNull();
        expect(getPathRule("wsl", {}, wslHome)).toMatchObject({
            configRoot: `${wslHome}\\.claude`,
            projectsDir: `${wslHome}\\.claude\\projects`,
        });
    });
});
