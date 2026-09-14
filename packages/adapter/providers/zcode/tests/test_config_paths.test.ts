import fs, { lstatSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createZcodeRuntimeConfigResolver } from "../src/zcode-probe-config-paths";

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

let sandbox = "";
let home = "";
let repository = "";
let project = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-zcode-config-paths-"));
    home = path.join(sandbox, "home");
    repository = path.join(sandbox, "repository");
    project = path.join(repository, "packages", "project");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
});

afterEach(() => {
    vi.mocked(lstatSync).mockReset().mockImplementation(fs.lstatSync);
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("ZCode bounded runtime configuration", () => {
    it("returns the exact default storage root when no declaration exists", () => {
        const resolved = resolver({});
        expect(resolved).toMatchObject({
            complete: true,
            projectContextRequired: false,
            diagnostics: [],
            global: {
                storageRoot: {
                    path: path.join(home, ".zcode"),
                    locatorKind: "runtime_known_rule",
                    locatorKey: "zcode_default_storage_root",
                    association: "global",
                },
                skillRoots: [],
            },
        });
    });

    it("resolves and de-duplicates absolute and home-relative user declarations as global roots", () => {
        const absoluteSkill = path.join(sandbox, "absolute-skill-root");
        writeUserConfig({
            storage: { dir: "~/declared-storage" },
            skills: { roots: ["~/shared-skills", absoluteSkill, absoluteSkill] },
        });

        const resolved = resolver({});
        expect(resolved.complete).toBe(true);
        expect(resolved.global.storageRoot).toEqual({
            path: path.join(home, "declared-storage"),
            locatorKind: "runtime_declared_path",
            locatorKey: "storage.dir",
            association: "global",
        });
        expect(resolved.global.skillRoots).toEqual([
            {
                path: absoluteSkill,
                locatorKind: "runtime_declared_path",
                locatorKey: "skills.roots",
                association: "global",
            },
            {
                path: path.join(home, "shared-skills"),
                locatorKind: "runtime_declared_path",
                locatorKey: "skills.roots",
                association: "global",
            },
        ]);
    });

    it("applies root-to-project config precedence and lets an empty array clear inherited Skill roots", () => {
        writeUserConfig({
            storage: { dir: path.join(sandbox, "user-storage") },
            skills: { roots: [path.join(sandbox, "user-skills")] },
        });
        writeJson(path.join(repository, "zcode.json"), {
            storage: { dir: "repository-storage" },
            skills: { roots: ["repository-skills"] },
        });
        writeJson(path.join(project, ".zcode", "config.json"), {
            storage: { dir: "project-storage" },
            skills: { roots: [] },
        });

        const resolved = resolver({}).resolveProject(projectInput());
        expect(resolved.complete).toBe(true);
        expect(resolved.projectConfigDirectories).toEqual([repository, path.join(repository, "packages"), project]);
        expect(resolved.storageRoot).toEqual({
            path: path.join(project, "project-storage"),
            locatorKind: "runtime_declared_path",
            locatorKey: "storage.dir",
            association: "project",
        });
        expect(resolved.skillRoots).toEqual([]);
    });

    it("associates relative user roots and all project-config roots with the selected project", () => {
        writeUserConfig({ storage: { dir: "user-relative" }, skills: { roots: ["", "user-relative-skills"] } });
        const projectAbsolute = path.join(sandbox, "project-absolute-skills");
        writeJson(path.join(repository, ".zcode", "config.json"), {
            skills: { roots: [projectAbsolute, "repository-relative-skills"] },
        });

        const configResolver = resolver({});
        expect(configResolver).toMatchObject({
            complete: true,
            projectContextRequired: true,
            global: { storageRoot: null, skillRoots: [] },
        });
        const resolved = configResolver.resolveProject(projectInput());
        expect(resolved.storageRoot).toMatchObject({ path: path.join(project, "user-relative"), association: "project" });
        expect(resolved.skillRoots).toEqual([
            expect.objectContaining({ path: projectAbsolute, association: "project" }),
            expect.objectContaining({ path: path.join(project, "repository-relative-skills"), association: "project" }),
        ]);
    });

    it("gives an observed environment storage declaration final precedence", () => {
        const userStorage = path.join(sandbox, "user-storage");
        const projectStorage = path.join(sandbox, "project-storage");
        const environmentStorage = path.join(sandbox, "environment-storage");
        writeUserConfig({ storage: { dir: userStorage } });
        writeJson(path.join(project, "zcode.json"), { storage: { dir: projectStorage } });

        const resolved = resolver({ ZCODE_STORAGE_DIR: environmentStorage }).resolveProject(projectInput());
        expect(resolved.storageRoot).toEqual({
            path: environmentStorage,
            locatorKind: "runtime_declared_path",
            locatorKey: "storage.dir",
            association: "global",
        });
    });

    it("requires a project context before resolving a relative environment storage declaration", () => {
        const configResolver = resolver({ ZCODE_STORAGE_DIR: "relative-environment-storage" });
        expect(configResolver).toMatchObject({
            complete: true,
            projectContextRequired: true,
            global: { storageRoot: null },
        });
        expect(configResolver.resolveProject(projectInput()).storageRoot).toEqual({
            path: path.join(project, "relative-environment-storage"),
            locatorKind: "runtime_declared_path",
            locatorKey: "storage.dir",
            association: "project",
        });
    });

    it("falls back from malformed config files while reporting an incomplete observation", () => {
        for (const malformed of [
            [],
            { storage: "wrong" },
            { storage: { dir: 3 } },
            { skills: "wrong" },
            { skills: { roots: "wrong" } },
            { skills: { roots: ["valid", 3] } },
        ]) {
            writeUserConfig(malformed);
            const resolved = resolver({});
            expect(resolved.complete).toBe(false);
            expect(resolved.global.storageRoot?.path).toBe(path.join(home, ".zcode"));
            expect(resolved.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_config_invalid" }));
        }

        fs.writeFileSync(userConfigPath(), "{not-json\n");
        const invalidJson = resolver({});
        expect(invalidJson.complete).toBe(false);
        expect(invalidJson.global.storageRoot?.path).toBe(path.join(home, ".zcode"));
    });

    it("accepts empty config sections and treats a missing intermediate config directory as absent", () => {
        writeUserConfig({ storage: {}, skills: {} });
        const emptySections = resolver({});
        expect(emptySections.complete).toBe(true);
        expect(emptySections.global.storageRoot?.path).toBe(path.join(home, ".zcode"));
        expect(emptySections.global.skillRoots).toEqual([]);

        fs.rmSync(path.join(home, ".zcode"), { recursive: true });
        fs.writeFileSync(path.join(home, ".zcode"), "not-a-directory\n");
        const missingIntermediate = resolver({});
        expect(missingIntermediate.complete).toBe(true);
        expect(missingIntermediate.diagnostics).toEqual([]);
        expect(missingIntermediate.global.storageRoot?.path).toBe(path.join(home, ".zcode"));
    });

    it("rejects blank environment storage and declared paths outside the physical access root", () => {
        const selected = path.join(sandbox, "selected");
        const selectedHome = path.join(selected, "home");
        const selectedProject = path.join(selected, "project");
        fs.mkdirSync(path.join(selectedProject, ".git"), { recursive: true });

        const blank = createZcodeRuntimeConfigResolver({
            environment: { ZCODE_STORAGE_DIR: "  " },
            homeDir: selectedHome,
            platformContext: linuxPlatform(selected),
        });
        expect(blank.complete).toBe(false);
        expect(blank.global.storageRoot).toBeNull();
        expect(blank.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_config_storage_environment_invalid" }));

        fs.mkdirSync(path.dirname(path.join(selectedHome, ".zcode", "cli", "config.json")), { recursive: true });
        writeJson(path.join(selectedHome, ".zcode", "cli", "config.json"), {
            storage: { dir: path.join(sandbox, "outside-storage") },
            skills: { roots: [path.join(sandbox, "outside-skills"), "bad\0path"] },
        });
        const escaped = createZcodeRuntimeConfigResolver({
            environment: {},
            homeDir: selectedHome,
            platformContext: linuxPlatform(selected),
        }).resolveProject({ hostProjectPath: selectedProject, runtimeProjectPath: selectedProject });
        expect(escaped.complete).toBe(false);
        expect(escaped.storageRoot).toBeNull();
        expect(escaped.skillRoots).toEqual([]);
        expect(escaped.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining(["zcode_config_storage_path_invalid", "zcode_config_skill_root_invalid"]),
        );
    });

    it("accepts a file worktree marker and stops config inheritance at that repository", () => {
        fs.rmSync(path.join(repository, ".git"), { recursive: true });
        fs.writeFileSync(path.join(repository, ".git"), "gitdir: elsewhere\n");
        const worktree = resolver({}).resolveProject(projectInput());
        expect(worktree.projectConfigDirectories).toEqual([repository, path.join(repository, "packages"), project]);
    });

    it.each([false, true])("inherits ancestor configuration only with a worktree marker (present=%s)", (hasMarker) => {
        const ancestor = path.join(sandbox, "ancestor");
        const nestedProject = path.join(ancestor, "nested");
        fs.mkdirSync(nestedProject, { recursive: true });
        writeJson(path.join(ancestor, "zcode.json"), { storage: { dir: "inherited-storage" } });
        if (hasMarker) fs.mkdirSync(path.join(ancestor, ".git"));
        const markerInspection = hideUnownedAncestorGitMarkers();

        const resolved = resolver({}).resolveProject({
            hostProjectPath: nestedProject,
            runtimeProjectPath: nestedProject,
        });
        expect(resolved.complete).toBe(true);
        expect(resolved.diagnostics).toEqual([]);
        expect(resolved.projectConfigDirectories).toEqual(hasMarker ? [ancestor, nestedProject] : [nestedProject]);
        expect(resolved.storageRoot?.path).toBe(
            hasMarker ? path.join(nestedProject, "inherited-storage") : path.join(home, ".zcode"),
        );
        if (hasMarker) {
            expect(markerInspection).not.toHaveBeenCalledWith(path.join(sandbox, ".git"));
        } else {
            expect(markerInspection).toHaveBeenCalledWith(path.join(path.parse(sandbox).root, ".git"));
        }
    });

    it("keeps the filesystem root as the sole project config directory without a worktree marker", () => {
        hideUnownedAncestorGitMarkers();
        const filesystemRoot = resolver({}).resolveProject({ hostProjectPath: "/", runtimeProjectPath: "/" });
        expect(filesystemRoot.projectConfigDirectories).toEqual(["/"]);
    });

    it("rejects a project path outside the selected physical access root", () => {
        const selected = path.join(sandbox, "selected-boundary");
        const selectedHome = path.join(selected, "home");
        fs.mkdirSync(selectedHome, { recursive: true });
        const resolved = createZcodeRuntimeConfigResolver({
            environment: {},
            homeDir: selectedHome,
            platformContext: linuxPlatform(selected),
        }).resolveProject({ hostProjectPath: project, runtimeProjectPath: project });
        expect(resolved).toMatchObject({ complete: false, projectConfigDirectories: [], storageRoot: null, skillRoots: [] });
        expect(resolved.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_config_project_boundary_invalid" }));
    });
});

function hideUnownedAncestorGitMarkers() {
    const hiddenMarkers = new Set<string>();
    let ancestor = path.dirname(sandbox);
    for (;;) {
        hiddenMarkers.add(path.join(ancestor, ".git"));
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
    }
    return vi.mocked(lstatSync).mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
        // Keep owned marker inspection real without borrowing the host temporary directory's Git state.
        if (hiddenMarkers.has(String(args[0]))) throw Object.assign(new Error("absent fixture ancestor"), { code: "ENOENT" });
        return fs.lstatSync(...args);
    });
}

function resolver(environment: NodeJS.ProcessEnv) {
    return createZcodeRuntimeConfigResolver({
        environment,
        homeDir: home,
        platformContext: linuxPlatform(),
    });
}

function linuxPlatform(accessRootPath = "/") {
    return { platform: "linux" as const, platformInstanceId: "fixture", accessRootPath };
}

function projectInput() {
    return { hostProjectPath: project, runtimeProjectPath: project };
}

function userConfigPath(): string {
    return path.join(home, ".zcode", "cli", "config.json");
}

function writeUserConfig(value: unknown): void {
    writeJson(userConfigPath(), value);
}

function writeJson(target: string, value: unknown): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(value)}\n`);
}
