import { describe, expect, it } from "vitest";
import { canonicalOpencodeAbsolutePath, getPathRule, projectSourceLocatorKey } from "../src/opencode-paths";

describe("OpenCode path rules", () => {
    const wslHome = "\\\\wsl.localhost\\Ubuntu\\home\\fixture";

    it("accepts only canonical absolute OpenCode paths", () => {
        expect(canonicalOpencodeAbsolutePath("/home/fixture")).toBe("/home/fixture");
        expect(canonicalOpencodeAbsolutePath("relative")).toBeNull();
        expect(canonicalOpencodeAbsolutePath("/home/../fixture")).toBeNull();
        expect(canonicalOpencodeAbsolutePath("/home/fixture\0tail")).toBeNull();
    });

    it("derives XDG defaults without consulting the real user environment", () => {
        const rule = getPathRule("linux", {}, "/home/fixture");
        expect(rule).toMatchObject({
            platform: "linux",
            globalConfigRoot: {
                path: "/home/fixture/.config/opencode",
                locatorKey: "opencode_global_config:opencode_config_default",
            },
            configRoots: [
                {
                    path: "/home/fixture/.config/opencode",
                    locatorKind: "runtime_known_rule",
                    locatorKey: "opencode_global_config:opencode_config_default",
                },
                {
                    path: "/home/fixture/.opencode",
                    locatorKind: "runtime_known_rule",
                    locatorKey: "opencode_home_config",
                },
            ],
            dataRoot: { path: "/home/fixture/.local/share/opencode" },
            database: { path: "/home/fixture/.local/share/opencode/opencode.db" },
            claudeGuidanceRoot: {
                path: "/home/fixture/.claude",
                locatorKey: "opencode_claude_compat_guidance",
            },
            projectConfigEnabled: true,
            externalSkillsEnabled: true,
            claudePromptEnabled: true,
            claudeSkillsEnabled: true,
        });
        expect(rule?.sharedSkillRoots.map((root) => root.path)).toEqual([
            "/home/fixture/.agents/skills",
            "/home/fixture/.claude/skills",
        ]);
    });

    it("derives default roots with the selected Host-visible WSL UNC grammar", () => {
        const rule = getPathRule("wsl", {}, wslHome);
        expect(rule).toMatchObject({
            globalConfigRoot: { path: `${wslHome}\\.config\\opencode` },
            dataRoot: { path: `${wslHome}\\.local\\share\\opencode` },
            database: { path: `${wslHome}\\.local\\share\\opencode\\opencode.db` },
        });
        expect(rule?.sharedSkillRoots.map((root) => root.path)).toEqual([
            `${wslHome}\\.agents\\skills`,
            `${wslHome}\\.claude\\skills`,
        ]);
    });

    it("makes OPENCODE_CONFIG_DIR the active global config root while retaining other declaration roots", () => {
        const rule = getPathRule("linux", { OPENCODE_CONFIG_DIR: "/opt/opencode-config" }, "/home/fixture");
        expect(rule?.globalConfigRoot).toEqual({
            path: "/opt/opencode-config",
            locatorKind: "runtime_declared_path",
            locatorKey: "opencode_global_config:OPENCODE_CONFIG_DIR",
        });
        expect(rule?.configRoots).toEqual([
            {
                path: "/opt/opencode-config",
                locatorKind: "runtime_declared_path",
                locatorKey: "opencode_global_config:OPENCODE_CONFIG_DIR",
            },
            expect.objectContaining({
                path: "/home/fixture/.config/opencode",
                locatorKind: "runtime_known_rule",
            }),
            expect.objectContaining({
                path: "/home/fixture/.opencode",
                locatorKind: "runtime_known_rule",
            }),
        ]);
    });

    it("deduplicates an override that equals the default config root", () => {
        const rule = getPathRule("linux", { OPENCODE_CONFIG_DIR: "/home/fixture/.config/opencode" }, "/home/fixture");
        expect(rule?.configRoots).toHaveLength(2);
        expect(rule?.configRoots[0]?.locatorKey).toBe("opencode_global_config:OPENCODE_CONFIG_DIR");
    });

    it("honors XDG config/data roots and marks them runtime-declared", () => {
        const rule = getPathRule("linux", { XDG_CONFIG_HOME: "/xdg/config", XDG_DATA_HOME: "/xdg/data" }, "/home/fixture");
        expect(rule?.configRoots[0]).toEqual({
            path: "/xdg/config/opencode",
            locatorKind: "runtime_declared_path",
            locatorKey: "opencode_global_config:XDG_CONFIG_HOME",
        });
        expect(rule?.dataRoot).toEqual({
            path: "/xdg/data/opencode",
            locatorKind: "runtime_declared_path",
            locatorKey: "XDG_DATA_HOME",
        });
    });

    it("resolves a relative OPENCODE_DB under the active data root", () => {
        const rule = getPathRule("linux", { XDG_DATA_HOME: "/xdg/data", OPENCODE_DB: "channel.db" }, "/home/fixture");
        expect(rule?.database).toEqual({
            path: "/xdg/data/opencode/channel.db",
            locatorKind: "runtime_declared_path",
            locatorKey: "OPENCODE_DB",
        });
    });

    it("accepts an absolute database and represents :memory: as no persistent registry", () => {
        expect(getPathRule("linux", { OPENCODE_DB: "/db/opencode.sqlite" }, "/home/fixture")?.database).toMatchObject({
            path: "/db/opencode.sqlite",
            locatorKind: "runtime_declared_path",
        });
        expect(getPathRule("linux", { OPENCODE_DB: ":memory:" }, "/home/fixture")?.database).toBeNull();
    });

    it("rejects non-canonical roots and NUL database values", () => {
        expect(getPathRule("linux", { OPENCODE_CONFIG_DIR: "relative" }, "/home/fixture")).toBeNull();
        expect(getPathRule("linux", { XDG_CONFIG_HOME: "/x/../config" }, "/home/fixture")).toBeNull();
        expect(getPathRule("linux", { OPENCODE_DB: "bad\0db" }, "/home/fixture")).toBeNull();
        expect(getPathRule("linux", {}, "relative-home")).toBeNull();
    });

    it("applies OpenCode source-disabling environment flags", () => {
        const noExternal = getPathRule(
            "linux",
            { OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
            "/home/fixture",
        );
        expect(noExternal?.sharedSkillRoots).toEqual([]);
        expect(noExternal).toMatchObject({
            projectConfigEnabled: false,
            externalSkillsEnabled: false,
            claudePromptEnabled: true,
            claudeSkillsEnabled: false,
        });
        if (noExternal === null) throw new Error("expected OpenCode path rule");
        expect(projectSourceLocatorKey(noExternal)).toBe(
            "probe_project_root:project_config_off:external_skills_off:claude_prompt_on:claude_skills_off",
        );

        const noClaude = getPathRule("linux", { OPENCODE_DISABLE_CLAUDE_CODE: "1" }, "/home/fixture");
        expect(noClaude?.sharedSkillRoots.map((root) => root.path)).toEqual(["/home/fixture/.agents/skills"]);
        expect(noClaude?.claudeGuidanceRoot).toBeNull();

        const promptOnly = getPathRule("linux", { OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true" }, "/home/fixture");
        expect(promptOnly).toMatchObject({
            claudeGuidanceRoot: null,
            claudePromptEnabled: false,
            claudeSkillsEnabled: true,
        });
    });

    it("accepts every known platform key and rejects a foreign key", () => {
        expect(getPathRule("darwin", {}, "/home/fixture")?.platform).toBe("darwin");
        expect(getPathRule("wsl", {}, "/home/fixture")?.platform).toBe("wsl");
        expect(getPathRule("win32", {}, "/home/fixture")?.platform).toBe("win32");
    });
});
