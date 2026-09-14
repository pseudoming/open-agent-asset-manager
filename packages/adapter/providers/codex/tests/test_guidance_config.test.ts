import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeCodex } from "../src/codex-probe";
import { materializeCodexConfig, readCodexGuidanceConfig, readCodexProbeConfig } from "../src/codex-probe-guidance-config";

let sandbox = "";
let home = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-codex-guidance-config-"));
    home = path.join(sandbox, "home");
    fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Codex Guidance config", () => {
    it("reports configured fallback names without corrupting project-root locator evidence", async () => {
        const codexHome = path.join(home, ".codex");
        const project = path.join(sandbox, "project");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.mkdirSync(project);
        fs.writeFileSync(
            path.join(codexHome, "config.toml"),
            'project_doc_fallback_filenames = ["TEAM_GUIDE.md", ".agents.md", "TEAM_GUIDE.md", "AGENTS.md"]\n',
        );

        const result = await probeCodex(
            {
                authorizationScope: "project",
                platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox },
                projectRootPath: project,
            },
            { PATH: "" },
            home,
        );
        const root = result.observation.sourceRoots.find((item) => item.path === project);
        expect(result.status).toBe("partial");
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: "codex_guidance_fallback_read_deferred", causeKind: "unsupported" }),
        );
        expect(root?.locatorEvidence).toEqual([
            expect.objectContaining({ locatorKind: "user_provided_path", locatorKey: "probe_project_root" }),
        ]);
    });

    it("treats a missing config as an exact empty fallback list", () => {
        expect(readCodexGuidanceConfig(path.join(sandbox, "missing.toml"), "not_found")).toEqual({
            snapshot: { state: "known", filenames: [] },
            diagnostics: [],
        });
    });

    it("rejects malformed, unsafe, non-UTF-8, and oversized configuration without guessing", () => {
        const config = path.join(sandbox, "config.toml");
        const invalidValues = [
            "project_doc_fallback_filenames = true\n",
            'project_doc_fallback_filenames = ["../escape.md"]\n',
            `project_doc_fallback_filenames = ["${"x".repeat(256)}"]\n`,
            `project_doc_fallback_filenames = [${Array.from({ length: 65 }, (_, index) => `"guide-${index}.md"`).join(", ")}]\n`,
            "project_doc_fallback_filenames = [\n",
        ];
        for (const value of invalidValues) {
            fs.writeFileSync(config, value);
            expect(readCodexGuidanceConfig(config, "available")).toMatchObject({
                snapshot: { state: "unknown", filenames: [] },
                diagnostics: [expect.objectContaining({ code: "codex_guidance_config_invalid" })],
            });
        }
        fs.writeFileSync(config, Buffer.from([0xff]));
        expect(readCodexGuidanceConfig(config, "available").snapshot.state).toBe("unknown");
        fs.writeFileSync(config, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
        expect(readCodexGuidanceConfig(config, "available").snapshot.state).toBe("unknown");
    });

    it("fails closed for unavailable config access", () => {
        expect(readCodexGuidanceConfig("/fixture/config.toml", "needs_permission")).toMatchObject({
            snapshot: { state: "unknown" },
            diagnostics: [expect.objectContaining({ code: "codex_guidance_config_unavailable", causeKind: "permission_denied" })],
        });
    });
});

describe("Codex project and Skill config", () => {
    it("parses trusted project anchors and exact Skill enablement without treating untrusted projects as sources", () => {
        const config = path.join(sandbox, "config.toml");
        const trusted = path.join(sandbox, "trusted");
        const untrusted = path.join(sandbox, "untrusted");
        const skill = path.join(trusted, ".agents", "skills", "demo", "SKILL.md");
        fs.writeFileSync(
            config,
            `[projects."${trusted}"]\ntrust_level = "trusted"\n` +
                `[projects."${untrusted}"]\ntrust_level = "untrusted"\n` +
                `[[skills.config]]\npath = "${skill}"\nenabled = false\n`,
        );

        const parsed = readCodexProbeConfig(config, "available");
        expect(parsed).toMatchObject({
            trustedProjects: { state: "known", runtimePaths: [trusted] },
            skills: { state: "known", entries: [{ configuredPath: skill, enabled: false }] },
            diagnostics: [],
        });
        const materialized = materializeCodexConfig(parsed, {
            platform: "linux",
            platformInstanceId: "fixture",
            accessRootPath: sandbox,
        });
        expect(materialized).toMatchObject({
            trustedProjects: { state: "known", entries: [{ runtimePath: trusted, hostPath: trusted }] },
            skills: { state: "known", entries: [{ entryPath: skill, enabled: false }] },
            diagnostics: [expect.objectContaining({ code: "codex_skill_disabled_in_source_config", severity: "info" })],
        });
    });

    it("keeps valid section entries while reporting malformed project and Skill rows as partial", () => {
        const config = path.join(sandbox, "config.toml");
        const project = path.join(sandbox, "project");
        const skill = path.join(project, "skill", "SKILL.md");
        fs.writeFileSync(
            config,
            `[projects."${project}"]\ntrust_level = "trusted"\n` +
                `[projects."${path.join(sandbox, "invalid")}"]\ntrust_level = "sometimes"\n` +
                `[[skills.config]]\npath = "${skill}"\nenabled = true\n` +
                `[[skills.config]]\npath = "${path.join(sandbox, "invalid-skill")}"\nenabled = "yes"\n`,
        );
        const parsed = readCodexProbeConfig(config, "available");
        expect(parsed.trustedProjects).toEqual({ state: "partial", runtimePaths: [project] });
        expect(parsed.skills).toEqual({ state: "partial", entries: [{ configuredPath: skill, enabled: true }] });
        expect(parsed.diagnostics.map((item) => item.code)).toEqual([
            "codex_project_registry_entry_invalid",
            "codex_skill_config_invalid",
        ]);
    });

    it("does not choose one of multiple enablement rows for the same Skill", () => {
        const config = path.join(sandbox, "config.toml");
        const skill = path.join(sandbox, "skills", "demo", "SKILL.md");
        fs.writeFileSync(
            config,
            `[[skills.config]]\npath = "${skill}"\nenabled = true\n` + `[[skills.config]]\npath = "${skill}"\nenabled = false\n`,
        );
        const parsed = readCodexProbeConfig(config, "available");
        expect(parsed.skills).toEqual({ state: "partial", entries: [] });
        expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ code: "codex_skill_config_invalid" }));
    });

    it("rejects malformed project and Skill section containers independently", () => {
        const config = path.join(sandbox, "config.toml");
        fs.writeFileSync(config, "projects = []\nskills = true\n");
        const invalidTables = readCodexProbeConfig(config, "available");
        expect(invalidTables.trustedProjects).toEqual({ state: "unknown", runtimePaths: [] });
        expect(invalidTables.skills).toEqual({ state: "unknown", entries: [] });
        expect(invalidTables.diagnostics.map((item) => item.code)).toEqual([
            "codex_project_registry_invalid",
            "codex_skill_config_invalid",
        ]);

        fs.writeFileSync(config, "[skills]\nconfig = true\n");
        expect(readCodexProbeConfig(config, "available").skills).toEqual({ state: "unknown", entries: [] });
    });

    it("bounds project and Skill config cardinality and path byte length", () => {
        const config = path.join(sandbox, "config.toml");
        const projectRows = Array.from(
            { length: 1025 },
            (_, index) => `[projects."${path.join(sandbox, `project-${index}`)}"]\ntrust_level = "trusted"\n`,
        ).join("");
        const skillRows = Array.from(
            { length: 1025 },
            (_, index) => `[[skills.config]]\npath = "${path.join(sandbox, `skill-${index}`, "SKILL.md")}"\nenabled = true\n`,
        ).join("");
        fs.writeFileSync(config, `${projectRows}${skillRows}`);
        const oversized = readCodexProbeConfig(config, "available");
        expect(oversized.trustedProjects).toEqual({ state: "unknown", runtimePaths: [] });
        expect(oversized.skills).toEqual({ state: "unknown", entries: [] });
        expect(oversized.diagnostics.map((item) => item.code)).toEqual([
            "codex_project_registry_invalid",
            "codex_skill_config_invalid",
        ]);

        const longPath = `/${"x".repeat(4096)}`;
        fs.writeFileSync(
            config,
            `[projects."${longPath}"]\ntrust_level = "trusted"\n` + `[[skills.config]]\npath = "${longPath}"\nenabled = true\n`,
        );
        const unboundedPath = readCodexProbeConfig(config, "available");
        expect(unboundedPath.trustedProjects).toEqual({ state: "partial", runtimePaths: [] });
        expect(unboundedPath.skills).toEqual({ state: "partial", entries: [] });
        expect(unboundedPath.diagnostics.map((item) => item.code)).toEqual([
            "codex_project_registry_entry_invalid",
            "codex_skill_config_invalid",
        ]);
    });

    it("rejects colliding Windows Skill paths instead of choosing by case", () => {
        const materialized = materializeCodexConfig(
            {
                guidance: { state: "known", filenames: [] },
                trustedProjects: { state: "known", runtimePaths: [] },
                skills: {
                    state: "known",
                    entries: [
                        { configuredPath: "C:\\Users\\Demo\\Skill\\SKILL.md", enabled: true },
                        { configuredPath: "C:\\Users\\Demo\\skill\\SKILL.md", enabled: false },
                        { configuredPath: "C:\\Users\\Demo\\SKILL\\SKILL.md", enabled: true },
                    ],
                },
                diagnostics: [],
            },
            { platform: "win32", platformInstanceId: "fixture", accessRootPath: "C:\\Users\\Demo" },
        );
        expect(materialized.skills).toEqual({ state: "partial", entries: [] });
        expect(materialized.diagnostics).toContainEqual(expect.objectContaining({ code: "codex_skill_config_duplicate_path" }));
    });

    it("rejects colliding Windows project anchors instead of choosing one registry identity", () => {
        const materialized = materializeCodexConfig(
            {
                guidance: { state: "known", filenames: [] },
                trustedProjects: {
                    state: "known",
                    runtimePaths: ["C:\\Users\\Demo\\Project", "C:\\Users\\Demo\\project"],
                },
                skills: { state: "known", entries: [] },
                diagnostics: [],
            },
            { platform: "win32", platformInstanceId: "fixture", accessRootPath: "C:\\Users\\Demo" },
        );
        expect(materialized.trustedProjects).toEqual({ state: "partial", entries: [] });
        expect(materialized.diagnostics).toContainEqual(
            expect.objectContaining({ code: "codex_project_registry_duplicate_path" }),
        );
    });

    it.each([
        [String.raw`\\wsl.localhost\Ubuntu\home\agent\work\project`, "Ubuntu"],
        [String.raw`\\wsl$\Ubuntu\home\agent\work\project`, "Ubuntu"],
        [String.raw`\\?\UNC\wsl.localhost\Ubuntu\home\agent\work\project`, "Ubuntu"],
        [String.raw`\\?\unc\wsl$\ubuntu\home\agent\work\project`, "ubuntu"],
        [String.raw`\\WSL.LOCALHOST\Ubuntu\home\agent\work\project`, "Ubuntu"],
    ])("classifies Windows-side WSL Project reference %s without reading or materializing its filesystem", (runtimePath, platformInstanceId) => {
        const filesystemReads = [
            vi.spyOn(fs, "accessSync"),
            vi.spyOn(fs, "lstatSync"),
            vi.spyOn(fs, "openSync"),
            vi.spyOn(fs, "readdirSync"),
            vi.spyOn(fs, "readFileSync"),
            vi.spyOn(fs, "readSync"),
            vi.spyOn(fs, "realpathSync"),
            vi.spyOn(fs, "statSync"),
        ];

        try {
            const materialized = materializeCodexConfig(
                {
                    guidance: { state: "known", filenames: [] },
                    trustedProjects: { state: "known", runtimePaths: [runtimePath] },
                    skills: { state: "known", entries: [] },
                    diagnostics: [],
                },
                { platform: "win32", platformInstanceId: "fixture", accessRootPath: "C:\\Users\\Demo" },
            );

            expect(materialized).toEqual({
                trustedProjects: { state: "known", entries: [] },
                skills: { state: "known", entries: [] },
                uncheckedWslProjectReferences: [{ runtimePath, platformInstanceId }],
                diagnostics: [],
            });
            expect(filesystemReads.every((read) => read.mock.calls.length === 0)).toBe(true);
            expect(materialized.diagnostics).not.toContainEqual(
                expect.objectContaining({ code: "codex_project_registry_path_unreachable", path: runtimePath }),
            );
        } finally {
            for (const read of filesystemReads) read.mockRestore();
        }
    });

    it("rejects non-canonical WSL-like, device, root-only, unsafe, and overlong Project references", () => {
        const rejectedPaths = [
            "\\\\server\\share\\project",
            String.raw`\\?\UNC\server\Ubuntu\home\agent\project`,
            String.raw`\\?\wsl$\Ubuntu\home\agent\project`,
            String.raw`\\wsl$\Ubuntu\home\..\project`,
            String.raw`\\?\UNC\wsl$\Ubuntu`,
            "/home/example/project",
            "\\\\.\\wsl.localhost\\Ubuntu\\home\\example\\project",
            "\\\\wsl.localhost\\Ubuntu",
            "\\\\wsl.localhost\\Ubuntu\\",
            "\\\\wsl.localhost\\Ubuntu.\\home\\example\\project",
            "\\\\wsl.localhost\\Ubuntu\\home\\..\\project",
            `\\\\wsl.localhost\\Ubuntu\\${"x".repeat(4096)}`,
        ];

        for (const runtimePath of rejectedPaths) {
            const materialized = materializeCodexConfig(
                {
                    guidance: { state: "known", filenames: [] },
                    trustedProjects: { state: "known", runtimePaths: [runtimePath] },
                    skills: { state: "known", entries: [] },
                    diagnostics: [],
                },
                { platform: "win32", platformInstanceId: "fixture", accessRootPath: "C:\\Users\\Demo" },
            );
            expect(materialized.uncheckedWslProjectReferences, runtimePath).toEqual([]);
            expect(materialized.trustedProjects, runtimePath).toEqual({ state: "partial", entries: [] });
        }
    });

    it("does not project untrusted WSL config rows or choose between case-conflicting distro identities", () => {
        const config = path.join(sandbox, "config.toml");
        const untrustedPath = "\\\\wsl.localhost\\Debian\\home\\example\\private";
        fs.writeFileSync(config, `[projects.'${untrustedPath}']\ntrust_level = "untrusted"\n`);

        const untrusted = materializeCodexConfig(readCodexProbeConfig(config, "available"), {
            platform: "win32",
            platformInstanceId: "fixture",
            accessRootPath: "C:\\Users\\Demo",
        });
        expect(untrusted.uncheckedWslProjectReferences).toEqual([]);

        const conflicting = materializeCodexConfig(
            {
                guidance: { state: "known", filenames: [] },
                trustedProjects: {
                    state: "known",
                    runtimePaths: [
                        "\\\\wsl.localhost\\Ubuntu\\home\\example\\first",
                        "\\\\wsl.localhost\\ubuntu\\home\\example\\second",
                    ],
                },
                skills: { state: "known", entries: [] },
                diagnostics: [],
            },
            { platform: "win32", platformInstanceId: "fixture", accessRootPath: "C:\\Users\\Demo" },
        );
        expect(conflicting.uncheckedWslProjectReferences).toEqual([]);
    });

    it("accepts the documented SKILL.md path and a compatibility folder path, but rejects aliases and escape paths", () => {
        const skillFile = path.join(sandbox, "skills", "file", "SKILL.md");
        const skillFolder = path.join(sandbox, "skills", "folder");
        const parsed = {
            guidance: { state: "known" as const, filenames: [] },
            trustedProjects: { state: "known" as const, runtimePaths: [path.join(sandbox, "project"), `${sandbox}/a/../alias`] },
            skills: {
                state: "known" as const,
                entries: [
                    { configuredPath: skillFile, enabled: false },
                    { configuredPath: skillFolder, enabled: true },
                    { configuredPath: `${sandbox}/skills/x/../file/SKILL.md`, enabled: true },
                    { configuredPath: path.join(path.dirname(sandbox), "outside", "SKILL.md"), enabled: true },
                ],
            },
            diagnostics: [],
        };
        const materialized = materializeCodexConfig(parsed, {
            platform: "linux",
            platformInstanceId: "fixture",
            accessRootPath: sandbox,
        });
        expect(materialized.trustedProjects).toEqual({
            state: "partial",
            entries: [{ runtimePath: path.join(sandbox, "project"), hostPath: path.join(sandbox, "project") }],
        });
        expect(materialized.skills).toEqual({
            state: "partial",
            entries: [
                { entryPath: skillFile, enabled: false },
                { entryPath: path.join(skillFolder, "SKILL.md"), enabled: true },
            ],
        });
        expect(materialized.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining(["codex_project_registry_path_unreachable", "codex_skill_config_path_unreachable"]),
        );
    });

    it("maps canonical WSL runtime paths into one selected Windows-visible root", () => {
        const accessRootPath = "\\\\wsl.localhost\\Ubuntu\\home\\example";
        const materialized = materializeCodexConfig(
            {
                guidance: { state: "known", filenames: [] },
                trustedProjects: { state: "known", runtimePaths: ["/home/example/work/project"] },
                skills: {
                    state: "known",
                    entries: [{ configuredPath: "/home/example/work/project/.agents/skills/demo/SKILL.md", enabled: true }],
                },
                diagnostics: [],
            },
            { platform: "wsl", platformInstanceId: "wsl:Ubuntu", accessRootPath },
        );
        expect(materialized.trustedProjects.entries[0]?.hostPath).toBe("\\\\wsl.localhost\\Ubuntu\\home\\example\\work\\project");
        expect(materialized.skills.entries[0]?.entryPath).toBe(
            "\\\\wsl.localhost\\Ubuntu\\home\\example\\work\\project\\.agents\\skills\\demo\\SKILL.md",
        );
    });

    it("treats SKILL.md case according to the selected host path environment", () => {
        const unixLowercase = path.join(sandbox, "skills", "skill.md");
        const unix = materializeCodexConfig(
            {
                guidance: { state: "known", filenames: [] },
                trustedProjects: { state: "known", runtimePaths: [] },
                skills: { state: "known", entries: [{ configuredPath: unixLowercase, enabled: true }] },
                diagnostics: [],
            },
            { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox },
        );
        expect(unix.skills.entries).toEqual([{ entryPath: path.join(unixLowercase, "SKILL.md"), enabled: true }]);

        const windows = materializeCodexConfig(
            {
                guidance: { state: "known", filenames: [] },
                trustedProjects: { state: "known", runtimePaths: [] },
                skills: { state: "known", entries: [{ configuredPath: "C:\\Users\\Demo\\skill.md", enabled: true }] },
                diagnostics: [],
            },
            { platform: "win32", platformInstanceId: "fixture", accessRootPath: "C:\\Users\\Demo" },
        );
        expect(windows.skills.entries).toEqual([{ entryPath: "C:\\Users\\Demo\\skill.md", enabled: true }]);
    });
});
