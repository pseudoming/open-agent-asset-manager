import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeClaudeCode } from "../src/claudecode-probe";
import {
    createProjectRoot,
    globalContext,
    platformContext,
    projectContext,
    sanitizeForFixture,
} from "./claudecode-test-fixtures";
let sandbox = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-claudecode-provider-"));
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Claude Code probe", () => {
    it("finds an executable CLI candidate and emits config/project/memory roots without claiming App", async () => {
        const home = path.join(sandbox, "home");
        const project = path.join(sandbox, "project");
        const bin = path.join(sandbox, "bin");
        const config = path.join(home, ".claude");
        const memory = path.join(config, "projects", sanitizeForFixture(project), "memory");
        const executable = path.join(bin, "claude");
        fs.mkdirSync(bin, { recursive: true });
        createProjectRoot(project);
        fs.mkdirSync(memory, { recursive: true });
        fs.writeFileSync(executable, "#!/bin/sh\nprintf '2.1.220 (Claude Code)\\n'\n", { mode: 0o755 });

        const result = await probeClaudeCode({ ...projectContext(project), installationRootPath: bin }, { PATH: bin }, home);
        expect(result.status).toBe("partial");
        expect(result.observation.observedAgentRuntimes[0]).toMatchObject({
            agentRuntimeId: "CLAUDE_CODE_CLI",
            installationStatus: "available",
            projectDiscoveryStatus: "complete",
        });
        expect(result.observation.observedAgentRuntimes[0]?.installationEvidence[0]?.path).toBe(executable);
        expect(result.observation.observedAgentRuntimes[1]).toMatchObject({
            agentRuntimeId: "CLAUDE_CODE_APP",
            installationStatus: "unknown",
            projectDiscoveryStatus: "unknown",
        });
        expect(result.observation.sourceRoots.map((root) => [root.rootRole, root.sourceDomain])).toEqual(
            expect.arrayContaining([
                ["config", "agent_runtime_private"],
                ["project_actual", "project_root"],
                ["source", "project_keyed"],
            ]),
        );
        expect(result.observation.observedProjects).toHaveLength(1);
        const projectRoot = result.observation.sourceRoots.find((root) => root.sourceDomain === "project_root");
        const memoryRoot = result.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed");
        expect(result.observation.observedAgentRuntimes[0]?.sourceRootIds).toEqual(
            expect.arrayContaining([projectRoot?.sourceRootId, memoryRoot?.sourceRootId]),
        );
        expect(result.observation.observedAgentRuntimes[0]?.observedProjectIds).toEqual([
            result.observation.observedProjects[0]?.observedProjectId,
        ]);
        expect(result.observation.targetCandidates).toEqual([
            expect.objectContaining({
                targetRootPath: config,
                targetKind: "global",
                entryApplicabilities: [
                    expect.objectContaining({ agentRuntimeId: "CLAUDE_CODE_CLI", status: "ready_for_plan" }),
                    expect.objectContaining({ agentRuntimeId: "CLAUDE_CODE_APP", status: "unknown" }),
                ],
            }),
            expect.objectContaining({
                targetRootPath: memory,
                targetKind: "directory",
                entryApplicabilities: [
                    expect.objectContaining({ agentRuntimeId: "CLAUDE_CODE_CLI", status: "ready_for_plan" }),
                    expect.objectContaining({ agentRuntimeId: "CLAUDE_CODE_APP", status: "unknown" }),
                ],
            }),
            expect.objectContaining({
                targetRootPath: project,
                targetKind: "project",
                entryApplicabilities: [
                    expect.objectContaining({ agentRuntimeId: "CLAUDE_CODE_CLI", status: "ready_for_plan" }),
                    expect.objectContaining({ agentRuntimeId: "CLAUDE_CODE_APP", status: "unknown" }),
                ],
            }),
        ]);
    });

    it("uses the canonical Git root only for Claude project identity and memory lookup", async () => {
        const home = path.join(sandbox, "home");
        const config = path.join(home, ".claude");
        const repository = path.join(sandbox, "repository");
        const selectedProject = path.join(repository, "packages", "app");
        fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
        fs.mkdirSync(selectedProject, { recursive: true });
        const memory = path.join(config, "projects", sanitizeForFixture(repository), "memory");
        fs.mkdirSync(memory, { recursive: true });

        const result = await probeClaudeCode(projectContext(selectedProject), { PATH: "" }, home);
        expect(result.observation.observedProjects[0]).toMatchObject({
            runtimeProjectKey: sanitizeForFixture(repository),
            workspaces: [expect.objectContaining({ role: "primary" })],
        });
        expect(result.observation.sourceRoots.find((root) => root.sourceDomain === "project_root")?.path).toBe(selectedProject);
        expect(result.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed")).toMatchObject({
            path: memory,
            accessStatus: "available",
        });
    });

    it("shares Claude memory across a structurally valid Git worktree", async () => {
        const home = path.join(sandbox, "home");
        const config = path.join(home, ".claude");
        const repository = path.join(sandbox, "repository");
        const worktree = path.join(sandbox, "worktree");
        const worktreeGitDir = path.join(repository, ".git", "worktrees", "oaam-fixture");
        fs.mkdirSync(worktreeGitDir, { recursive: true });
        fs.mkdirSync(worktree, { recursive: true });
        fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
        fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
        fs.writeFileSync(path.join(worktreeGitDir, "gitdir"), `${path.join(worktree, ".git")}\n`);
        const memory = path.join(config, "projects", sanitizeForFixture(repository), "memory");
        fs.mkdirSync(memory, { recursive: true });

        const result = await probeClaudeCode(projectContext(worktree), { PATH: "" }, home);
        expect(result.observation.observedProjects[0]?.runtimeProjectKey).toBe(sanitizeForFixture(repository));
        expect(result.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed")?.path).toBe(memory);
        expect(result.diagnostics).not.toContainEqual(
            expect.objectContaining({
                code: "claudecode_git_worktree_identity_untrusted",
            }),
        );
    });

    it("does not borrow a foreign Git worktree identity", async () => {
        const home = path.join(sandbox, "home");
        const repository = path.join(sandbox, "repository");
        const legitimateWorktree = path.join(sandbox, "legitimate-worktree");
        const selectedProject = path.join(sandbox, "selected-project");
        const worktreeGitDir = path.join(repository, ".git", "worktrees", "legitimate");
        fs.mkdirSync(worktreeGitDir, { recursive: true });
        fs.mkdirSync(legitimateWorktree, { recursive: true });
        fs.mkdirSync(selectedProject, { recursive: true });
        fs.writeFileSync(path.join(legitimateWorktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
        fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
        fs.writeFileSync(path.join(worktreeGitDir, "gitdir"), `${path.join(legitimateWorktree, ".git")}\n`);
        fs.writeFileSync(path.join(selectedProject, ".git"), `gitdir: ${worktreeGitDir}\n`);

        const result = await probeClaudeCode(projectContext(selectedProject), { PATH: "" }, home);
        expect(result.observation.observedProjects[0]?.runtimeProjectKey).toBe(sanitizeForFixture(selectedProject));
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode_git_worktree_identity_untrusted",
            }),
        );
    });

    it("rejects a Git control path written in a foreign filesystem grammar", async () => {
        const home = path.join(sandbox, "home");
        const selectedProject = path.join(sandbox, "selected-project");
        fs.mkdirSync(selectedProject, { recursive: true });
        fs.writeFileSync(path.join(selectedProject, ".git"), "gitdir: C:\\foreign\\worktrees\\selected\n");

        const result = await probeClaudeCode(projectContext(selectedProject), { PATH: "" }, home);

        expect(result.observation.observedProjects[0]?.runtimeProjectKey).toBe(sanitizeForFixture(selectedProject));
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode_git_worktree_identity_untrusted",
            }),
        );
    });

    it("does not inspect config or Git-control paths outside the selected physical access root", async () => {
        const accessRoot = path.join(sandbox, "selected-root");
        const home = path.join(accessRoot, "home");
        const project = path.join(accessRoot, "project");
        const foreignConfig = path.join(sandbox, "foreign-config");
        const foreignGitDirectory = path.join(sandbox, "foreign-git", "worktrees", "selected");
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(project, { recursive: true });
        fs.mkdirSync(foreignConfig, { recursive: true });
        fs.mkdirSync(foreignGitDirectory, { recursive: true });
        fs.writeFileSync(path.join(project, ".git"), `gitdir: ${foreignGitDirectory}\n`);

        const context = {
            authorizationScope: "project",
            platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: accessRoot },
            projectRootPath: project,
        } as const;
        const result = await probeClaudeCode(context, { PATH: "", CLAUDE_CONFIG_DIR: foreignConfig }, home);

        expect(result.observation.sourceRoots.map((root) => root.path)).not.toContain(foreignConfig);
        expect(result.observation.observedProjects[0]?.runtimeProjectKey).toBe(sanitizeForFixture(project));
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: "claudecode_config_root_outside_selected_environment" }),
                expect.objectContaining({ code: "claudecode_git_worktree_identity_untrusted" }),
            ]),
        );
    });

    it("honors config and full-memory overrides as exact declared roots", async () => {
        const home = path.join(sandbox, "home");
        const project = path.join(sandbox, "project");
        const config = path.join(sandbox, "config");
        const memory = path.join(sandbox, "memory");
        createProjectRoot(project);
        fs.mkdirSync(config, { recursive: true });
        fs.mkdirSync(memory, { recursive: true });
        const result = await probeClaudeCode(
            projectContext(project),
            {
                PATH: "",
                CLAUDE_CONFIG_DIR: config,
                CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: memory,
            },
            home,
        );
        const configRoot = result.observation.sourceRoots.find((root) => root.rootRole === "config");
        const memoryRoot = result.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed");
        expect(configRoot).toMatchObject({ path: config, accessStatus: "available" });
        expect(configRoot?.locatorEvidence[0]).toMatchObject({
            locatorKind: "runtime_declared_path",
            locatorKey: "CLAUDE_CONFIG_DIR",
        });
        expect(memoryRoot).toMatchObject({ path: memory, accessStatus: "available" });
        expect(memoryRoot?.locatorEvidence.map((row) => row.locatorKey)).toEqual(["CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"]);
    });

    it("uses trusted autoMemoryDirectory before the remote/default location", async () => {
        const home = path.join(sandbox, "home");
        const project = path.join(sandbox, "project");
        const config = path.join(home, ".claude");
        const configuredMemory = path.join(sandbox, "configured-memory");
        createProjectRoot(project);
        fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
        fs.mkdirSync(config, { recursive: true });
        fs.mkdirSync(configuredMemory, { recursive: true });
        fs.writeFileSync(
            path.join(project, ".claude", "settings.local.json"),
            JSON.stringify({ autoMemoryDirectory: configuredMemory }),
        );
        const result = await probeClaudeCode(
            projectContext(project),
            {
                PATH: "",
                CLAUDE_CODE_REMOTE_MEMORY_DIR: path.join(sandbox, "remote"),
            },
            home,
        );
        expect(result.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed")?.path).toBe(configuredMemory);
    });

    it("reports invalid overrides instead of scanning a fallback memory root", async () => {
        const home = path.join(sandbox, "home");
        const project = path.join(sandbox, "project");
        createProjectRoot(project);
        fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
        const result = await probeClaudeCode(
            projectContext(project),
            {
                PATH: "",
                CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: "relative",
            },
            home,
        );
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode_memory_override_invalid",
                severity: "error",
            }),
        );
        expect(result.observation.sourceRoots.some((root) => root.sourceDomain === "project_keyed")).toBe(false);
    });

    it("uses a valid remote memory base and rejects an invalid one", async () => {
        const home = path.join(sandbox, "home");
        const project = path.join(sandbox, "project");
        const remote = path.join(sandbox, "remote");
        createProjectRoot(project);
        fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
        fs.mkdirSync(path.join(remote, "projects", sanitizeForFixture(project), "memory"), {
            recursive: true,
        });
        const valid = await probeClaudeCode(
            projectContext(project),
            {
                PATH: "",
                CLAUDE_CODE_REMOTE_MEMORY_DIR: remote,
            },
            home,
        );
        expect(valid.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed")).toMatchObject({
            path: path.join(remote, "projects", sanitizeForFixture(project), "memory"),
            accessStatus: "available",
        });

        const invalid = await probeClaudeCode(
            projectContext(project),
            {
                PATH: "",
                CLAUDE_CODE_REMOTE_MEMORY_DIR: "relative",
            },
            home,
        );
        expect(invalid.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode_memory_override_invalid",
            }),
        );
        expect(invalid.observation.sourceRoots.some((root) => root.sourceDomain === "project_keyed")).toBe(false);
    });

    it("uses the global trusted setting and reports malformed settings without guessing", async () => {
        const home = path.join(sandbox, "home");
        const project = path.join(sandbox, "project");
        const config = path.join(home, ".claude");
        const globalMemory = path.join(sandbox, "global-memory");
        createProjectRoot(project);
        fs.mkdirSync(config, { recursive: true });
        fs.mkdirSync(globalMemory, { recursive: true });
        fs.writeFileSync(
            path.join(config, "settings.json"),
            JSON.stringify({
                autoMemoryDirectory: globalMemory,
            }),
        );
        const configured = await probeClaudeCode(projectContext(project), { PATH: "" }, home);
        expect(configured.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed")?.path).toBe(globalMemory);

        fs.writeFileSync(path.join(config, "settings.json"), "{bad json");
        const malformed = await probeClaudeCode(projectContext(project), { PATH: "" }, home);
        expect(malformed.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode_memory_settings_unreadable",
            }),
        );
        expect(malformed.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed")?.path).toBe(
            path.join(config, "projects", sanitizeForFixture(project), "memory"),
        );

        fs.writeFileSync(
            path.join(config, "settings.json"),
            JSON.stringify({
                autoMemoryDirectory: "relative",
            }),
        );
        const invalidSetting = await probeClaudeCode(projectContext(project), { PATH: "" }, home);
        expect(invalidSetting.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode_memory_override_invalid",
            }),
        );
        expect(invalidSetting.observation.sourceRoots.some((root) => root.sourceDomain === "project_keyed")).toBe(false);
    });

    it("rejects an oversized trusted settings file before parsing it", async () => {
        const home = path.join(sandbox, "home");
        const project = path.join(sandbox, "project");
        const config = path.join(home, ".claude");
        createProjectRoot(project);
        fs.mkdirSync(config, { recursive: true });
        fs.writeFileSync(path.join(config, "settings.json"), "x".repeat(2 * 1024 * 1024 + 1));

        const result = await probeClaudeCode(projectContext(project), { PATH: "" }, home);

        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode_memory_settings_unreadable",
                causeKind: "invalid_schema",
            }),
        );
        expect(result.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed")?.path).toBe(
            path.join(config, "projects", sanitizeForFixture(project), "memory"),
        );
    });

    it("discovers the unique existing long-key memory directory", async () => {
        const home = path.join(sandbox, "home");
        const config = path.join(home, ".claude");
        const project = `/${"long-segment/".repeat(24)}`;
        const prefix = sanitizeForFixture(project).slice(0, 200);
        const existing = path.join(config, "projects", `${prefix}-runtimehash`, "memory");
        fs.mkdirSync(existing, { recursive: true });
        const result = await probeClaudeCode(projectContext(project), { PATH: "" }, home);
        expect(result.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed")).toMatchObject({
            path: existing,
            accessStatus: "available",
        });
    });

    it("does not guess between multiple long-key memory directories", async () => {
        const home = path.join(sandbox, "home");
        const config = path.join(home, ".claude");
        const project = path.join(sandbox, ...Array.from({ length: 24 }, (_, index) => `long-${index}`));
        createProjectRoot(project);
        const prefix = sanitizeForFixture(project).slice(0, 200);
        fs.mkdirSync(path.join(config, "projects", `${prefix}-runtime-a`, "memory"), {
            recursive: true,
        });
        fs.mkdirSync(path.join(config, "projects", `${prefix}-runtime-b`, "memory"), {
            recursive: true,
        });

        const result = await probeClaudeCode(projectContext(project), { PATH: "" }, home);
        const memoryRoot = result.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed");
        expect(memoryRoot?.path).not.toContain("runtime-a");
        expect(memoryRoot?.path).not.toContain("runtime-b");
        expect(memoryRoot?.accessStatus).toBe("not_found");
    });

    it("reports an over-cardinality project-key directory and keeps the deterministic fallback", async () => {
        const home = path.join(sandbox, "home");
        const config = path.join(home, ".claude");
        const project = `/${"bounded-long-segment/".repeat(24)}`;
        const projects = path.join(config, "projects");
        fs.mkdirSync(projects, { recursive: true });
        for (let index = 0; index < 4097; index += 1) {
            fs.mkdirSync(path.join(projects, `unrelated-${index}`));
        }

        const result = await probeClaudeCode(projectContext(project), { PATH: "" }, home);

        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode_memory_project_directory_too_large",
                causeKind: "invalid_schema",
            }),
        );
        const memoryRoot = result.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed");
        const repeated = await probeClaudeCode(projectContext(project), { PATH: "" }, home);
        expect(memoryRoot).toMatchObject({
            accessStatus: "not_found",
            locatorEvidence: [expect.objectContaining({ locatorKey: "claude_project_memory_default" })],
        });
        expect(memoryRoot?.path.startsWith(`${projects}${path.sep}`)).toBe(true);
        expect(repeated.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed")?.path).toBe(
            memoryRoot?.path,
        );
    });

    it("rejects an oversized Git control file instead of borrowing worktree identity", async () => {
        const home = path.join(sandbox, "home");
        const project = path.join(sandbox, "oversized-git-control");
        fs.mkdirSync(project, { recursive: true });
        fs.writeFileSync(path.join(project, ".git"), "x".repeat(64 * 1024 + 1));

        const result = await probeClaudeCode(projectContext(project), { PATH: "" }, home);

        expect(result.observation.observedProjects[0]?.runtimeProjectKey).toBe(sanitizeForFixture(project));
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode_git_worktree_identity_untrusted",
            }),
        );
    });

    it("keeps a normal Git submodule rooted at its authorized worktree", async () => {
        const home = path.join(sandbox, "home");
        const project = path.join(sandbox, "submodule");
        const gitDirectory = path.join(sandbox, "parent-git", "modules", "submodule");
        fs.mkdirSync(project, { recursive: true });
        fs.mkdirSync(gitDirectory, { recursive: true });
        fs.writeFileSync(path.join(project, ".git"), `gitdir: ${gitDirectory}\n`);

        const result = await probeClaudeCode(projectContext(project), { PATH: "" }, home);
        expect(result.observation.observedProjects[0]?.runtimeProjectKey).toBe(sanitizeForFixture(project));
        expect(result.diagnostics).not.toContainEqual(
            expect.objectContaining({
                code: "claudecode_git_worktree_identity_untrusted",
            }),
        );
    });

    it("ignores symlinked or non-file memory settings before using trusted config", async () => {
        const home = path.join(sandbox, "home");
        const project = path.join(sandbox, "project");
        const config = path.join(home, ".claude");
        const configuredMemory = path.join(sandbox, "configured-memory");
        const untrusted = path.join(sandbox, "untrusted-settings.json");
        createProjectRoot(project);
        fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
        fs.mkdirSync(configuredMemory, { recursive: true });
        fs.mkdirSync(config, { recursive: true });
        fs.writeFileSync(untrusted, JSON.stringify({ autoMemoryDirectory: "/wrong" }));
        fs.symlinkSync(untrusted, path.join(project, ".claude", "settings.local.json"));
        fs.writeFileSync(
            path.join(config, "settings.json"),
            JSON.stringify({
                autoMemoryDirectory: configuredMemory,
            }),
        );

        const fromSymlink = await probeClaudeCode(projectContext(project), { PATH: "" }, home);
        expect(fromSymlink.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed")?.path).toBe(
            configuredMemory,
        );

        fs.rmSync(path.join(project, ".claude", "settings.local.json"));
        fs.mkdirSync(path.join(project, ".claude", "settings.local.json"));
        const fromDirectory = await probeClaudeCode(projectContext(project), { PATH: "" }, home);
        expect(fromDirectory.observation.sourceRoots.find((root) => root.sourceDomain === "project_keyed")?.path).toBe(
            configuredMemory,
        );
    });

    it("treats relative project/directory/config paths as invalid authority", async () => {
        const home = path.join(sandbox, "home");
        const project = await probeClaudeCode(
            projectContext("relative"),
            {
                PATH: "",
                CLAUDE_CONFIG_DIR: "relative",
            },
            home,
        );
        expect(project.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining(["claudecode_config_root_invalid", "claudecode_project_root_invalid"]),
        );
        expect(project.observation.sourceRoots).toEqual([]);

        const directory = await probeClaudeCode(
            {
                authorizationScope: "directory",
                platformContext: platformContext(),
                directoryRootPath: "relative",
            },
            { PATH: "" },
            home,
        );
        expect(directory.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode_external_root_invalid",
            }),
        );
    });

    it("distinguishes available project-registry storage from a missing one", async () => {
        const home = path.join(sandbox, "home");
        const config = path.join(home, ".claude");
        fs.mkdirSync(path.join(config, "projects"), { recursive: true });
        const available = await probeClaudeCode(globalContext(), { PATH: "" }, home);
        expect(available.observation.observedAgentRuntimes[0]?.projectDiscoveryStatus).toBe("partial");

        fs.rmSync(path.join(config, "projects"), { recursive: true });
        const missing = await probeClaudeCode(globalContext(), { PATH: "" }, home);
        expect(missing.observation.observedAgentRuntimes[0]?.projectDiscoveryStatus).toBe("not_found");
    });

    it("rejects non-directory config and non-executable CLI candidates", async () => {
        const home = path.join(sandbox, "home");
        const bin = path.join(sandbox, "bin");
        const configFile = path.join(sandbox, "config-file");
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, "claude"), "not executable", { mode: 0o644 });
        fs.writeFileSync(configFile, "not a directory");
        const result = await probeClaudeCode(
            globalContext(),
            {
                PATH: bin,
                CLAUDE_CONFIG_DIR: configFile,
            },
            home,
        );
        expect(result.observation.observedAgentRuntimes[0]?.installationStatus).toBe("not_found");
        expect(result.observation.observedAgentRuntimes[0]?.installationEvidence).toContainEqual(
            expect.objectContaining({
                kind: "executable",
                path: path.join(bin, "claude"),
                evidenceLevel: "local_artifact",
            }),
        );
        expect(result.observation.sourceRoots[0]).toMatchObject({
            accessStatus: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_source_root_not_directory" })],
        });
    });

    it("resolves an executable symlink and keeps undefined-PATH evidence truthful", async () => {
        const home = path.join(sandbox, "home");
        const bin = path.join(sandbox, "bin");
        const actual = path.join(sandbox, "claude-real");
        fs.mkdirSync(bin, { recursive: true });
        fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
        fs.writeFileSync(actual, "#!/bin/sh\nprintf '2.1.220 (Claude Code)\\n'\n", { mode: 0o755 });
        fs.symlinkSync(actual, path.join(bin, "claude"));
        const linked = await probeClaudeCode(globalContext(), { PATH: bin }, home);
        expect(linked.observation.observedAgentRuntimes[0]?.installationEvidence[0]?.path).toBe(actual);

        const noPath = await probeClaudeCode(globalContext(), {}, home);
        const runtime = noPath.observation.observedAgentRuntimes[0];
        if (runtime?.installationStatus === "available") {
            expect(runtime.installationEvidence.length).toBeGreaterThan(0);
        } else {
            expect(runtime?.installationStatus).toBe("not_found");
            expect(runtime?.installationEvidence.length).toBeGreaterThan(0);
        }
    });

    it("keeps a user-authorized external directory separate from project discovery", async () => {
        const home = path.join(sandbox, "home");
        const external = path.join(sandbox, "external");
        fs.mkdirSync(external, { recursive: true });
        const result = await probeClaudeCode(
            {
                authorizationScope: "directory",
                platformContext: platformContext(),
                directoryRootPath: external,
            },
            { PATH: "" },
            home,
        );
        expect(result.observation.sourceRoots).toContainEqual(
            expect.objectContaining({
                rootRole: "source",
                sourceDomain: "external_managed",
                path: external,
            }),
        );
        expect(result.observation.observedProjects).toEqual([]);
    });

    it("does not follow a symlinked config root", async () => {
        const home = path.join(sandbox, "home");
        const actual = path.join(sandbox, "actual");
        const linked = path.join(sandbox, "linked");
        fs.mkdirSync(actual, { recursive: true });
        fs.symlinkSync(actual, linked, "dir");
        const result = await probeClaudeCode(
            globalContext(),
            {
                PATH: "",
                CLAUDE_CONFIG_DIR: linked,
            },
            home,
        );
        expect(result.observation.sourceRoots[0]).toMatchObject({
            path: linked,
            accessStatus: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_source_root_symlink" })],
        });
    });
});
