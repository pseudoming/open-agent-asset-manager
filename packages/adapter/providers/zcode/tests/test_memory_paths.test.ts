import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createZcodeMemoryRootResolver, createZcodeProjectMemoryKey } from "../src/zcode-probe-memory-paths";

let sandbox = "";
let home = "";
let repository = "";
let project = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-zcode-memory-paths-"));
    home = path.join(sandbox, "home");
    repository = path.join(sandbox, "repository");
    project = path.join(repository, "packages", "project");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("ZCode project-keyed Memory paths", () => {
    it("matches exact installed slug and SHA-256 key vectors", () => {
        expect(createZcodeProjectMemoryKey("/repo/My Project", "linux")).toBe("my-project-7e796667526cb703");
        expect(createZcodeProjectMemoryKey("C:\\Repo\\My Project", "win32")).toBe("my-project-c69a4c06e4f7d0ef");
        expect(createZcodeProjectMemoryKey("/repo/a- b", "linux")).toBe("a--b-579293cb90a3f183");
        expect(createZcodeProjectMemoryKey(`/repo/${"a".repeat(47)}-z`, "linux")).toBe(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa--03a766f17141bf8a",
        );
        expect(createZcodeProjectMemoryKey("relative/project", "linux")).toBeNull();
        expect(createZcodeProjectMemoryKey("\0", "linux")).toBeNull();
    });

    it("uses the default storage root and does not append cli twice", () => {
        const defaultResolution = resolver({}).resolveProject(projectInput());
        const key = createZcodeProjectMemoryKey(project, "linux");
        expect(defaultResolution).toEqual({
            resolved: {
                path: path.join(home, ".zcode", "cli", "memories", "projects", key ?? "missing"),
                locatorKind: "runtime_known_rule",
                locatorKey: "zcode_default_storage_root",
            },
            diagnostics: [],
        });

        const cliRoot = path.join(sandbox, "declared", "cli");
        writeJson(path.join(home, ".zcode", "cli", "config.json"), { storage: { dir: cliRoot } });
        expect(resolver({}).resolveProject(projectInput()).resolved?.path).toBe(
            path.join(cliRoot, "memories", "projects", key ?? "missing"),
        );
    });

    it("applies user, ancestor, nested project, and environment storage precedence", () => {
        writeJson(path.join(home, ".zcode", "cli", "config.json"), {
            storage: { dir: path.join(sandbox, "user-storage") },
        });
        writeJson(path.join(repository, "zcode.json"), { storage: { dir: path.join(sandbox, "repository-storage") } });
        writeJson(path.join(project, ".zcode", "config.json"), { storage: { dir: "relative-storage" } });
        const key = createZcodeProjectMemoryKey(project, "linux") ?? "missing";

        const projectResolution = resolver({}).resolveProject(projectInput());
        expect(projectResolution.resolved).toMatchObject({
            path: path.join(project, "relative-storage", "cli", "memories", "projects", key),
            locatorKind: "runtime_declared_path",
            locatorKey: "storage.dir",
        });

        const environmentRoot = path.join(sandbox, "environment-storage");
        const environmentResolution = resolver({ ZCODE_STORAGE_DIR: environmentRoot }).resolveProject(projectInput());
        expect(environmentResolution.resolved).toMatchObject({
            path: path.join(environmentRoot, "cli", "memories", "projects", key),
            locatorKind: "runtime_declared_path",
            locatorKey: "storage.dir",
        });
    });

    it("resolves home-relative storage and rejects escaping or non-absolute project inputs", () => {
        writeJson(path.join(home, ".zcode", "cli", "config.json"), { storage: { dir: "~/memory-storage" } });
        expect(resolver({}).resolveProject(projectInput()).resolved?.path).toContain(
            path.join(home, "memory-storage", "cli", "memories", "projects"),
        );

        const selected = path.join(sandbox, "selected");
        const selectedHome = path.join(selected, "home");
        const selectedProject = path.join(selected, "project");
        fs.mkdirSync(path.join(selectedProject, ".git"), { recursive: true });
        const bounded = createZcodeMemoryRootResolver({
            environment: { ZCODE_STORAGE_DIR: path.join(sandbox, "foreign-storage") },
            homeDir: selectedHome,
            platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: selected },
        });
        const escaped = bounded.resolveProject({ hostProjectPath: selectedProject, runtimeProjectPath: selectedProject });
        expect(escaped.resolved).toBeNull();
        expect(escaped.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_config_storage_path_invalid" }));

        const relative = resolver({}).resolveProject({ hostProjectPath: project, runtimeProjectPath: "relative/project" });
        expect(relative.resolved).toBeNull();
        expect(relative.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_memory_project_path_invalid" }));
        expect(createZcodeProjectMemoryKey("/---", "linux")).toMatch(/^project-[0-9a-f]{16}$/u);
    });

    it("fails closed when an ancestor config boundary or worktree marker cannot be trusted", () => {
        const isolated = path.join(sandbox, "isolated");
        fs.mkdirSync(isolated);
        const bounded = createZcodeMemoryRootResolver({
            environment: {},
            homeDir: isolated,
            platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: isolated },
        }).resolveProject({ hostProjectPath: isolated, runtimeProjectPath: isolated });
        expect(bounded.resolved).toBeNull();
        expect(bounded.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_config_project_ancestor_unobserved" }));

        const symlinkRepository = path.join(sandbox, "symlink-repository");
        const symlinkProject = path.join(symlinkRepository, "project");
        fs.mkdirSync(symlinkProject, { recursive: true });
        fs.symlinkSync(repository, path.join(symlinkRepository, ".git"));
        const symlinked = resolver({}).resolveProject({
            hostProjectPath: symlinkProject,
            runtimeProjectPath: symlinkProject,
        });
        expect(symlinked.resolved).toBeNull();
        expect(symlinked.diagnostics).toContainEqual(
            expect.objectContaining({ code: "zcode_config_project_marker_symlink_untrusted" }),
        );
    });

    it("reports malformed declarations while following the runtime fallback", () => {
        writeJson(path.join(home, ".zcode", "cli", "config.json"), { storage: { dir: 3 } });
        const malformed = createZcodeMemoryRootResolver({
            environment: {},
            homeDir: home,
            platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: "/" },
        });
        expect(malformed.resolveProject(projectInput()).resolved?.path).toContain(path.join(home, ".zcode", "cli", "memories"));
        expect(malformed.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_config_invalid" }));

        fs.writeFileSync(path.join(home, ".zcode", "cli", "config.json"), "{not-json\n");
        const invalidJson = resolver({});
        expect(invalidJson.resolveProject(projectInput()).resolved?.path).toContain(path.join(home, ".zcode", "cli", "memories"));
        expect(invalidJson.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_config_invalid" }));

        fs.rmSync(path.join(home, ".zcode", "cli", "config.json"));
        fs.writeFileSync(path.join(repository, "zcode.json"), "{not-json\n");
        const invalidProjectConfig = resolver({}).resolveProject(projectInput());
        expect(invalidProjectConfig.resolved?.path).toContain(path.join(home, ".zcode", "cli", "memories"));
        expect(invalidProjectConfig.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_config_invalid" }));

        fs.rmSync(path.join(repository, "zcode.json"));
        fs.writeFileSync(path.join(home, ".zcode", "cli", "config.json"), "[]\n");
        const invalidTopLevel = resolver({});
        expect(invalidTopLevel.resolveProject(projectInput()).resolved?.path).toContain(path.join(home, ".zcode", "cli"));
        expect(invalidTopLevel.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_config_invalid" }));
        writeJson(path.join(home, ".zcode", "cli", "config.json"), { storage: "not-an-object" });
        const invalidStorage = resolver({});
        expect(invalidStorage.resolveProject(projectInput()).resolved?.path).toContain(path.join(home, ".zcode", "cli"));
        expect(invalidStorage.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_config_invalid" }));

        const blankEnvironment = createZcodeMemoryRootResolver({
            environment: { ZCODE_STORAGE_DIR: "   " },
            homeDir: home,
            platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: "/" },
        }).resolveProject(projectInput());
        expect(blankEnvironment.resolved).toBeNull();
        expect(blankEnvironment.diagnostics).toContainEqual(
            expect.objectContaining({ code: "zcode_config_storage_environment_invalid" }),
        );
    });
});

function resolver(environment: NodeJS.ProcessEnv) {
    return createZcodeMemoryRootResolver({
        environment,
        homeDir: home,
        platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: "/" },
    });
}

function projectInput() {
    return { hostProjectPath: project, runtimeProjectPath: project };
}

function writeJson(target: string, value: unknown): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(value)}\n`);
}
