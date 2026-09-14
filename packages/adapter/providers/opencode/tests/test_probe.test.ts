import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAdapterProbeResult } from "../../../core/src/adapters/adapter-contract-validator";
import { findObservedProjectBindingEvidence } from "../../../core/src/render/native-project-target-evidence";
import {
    fixtureDirectoryProbeContext as directoryContext,
    fixtureGlobalProbeContext as globalContext,
    fixtureProjectProbeContext as projectContext,
} from "../../../test-support";
import { installationRequiresExecutableMode, probeOpencode } from "../src/opencode-probe";
import { opencodeProvider } from "../src/opencode-provider";
import { opencodeAppAsar } from "./opencode-app-asar-fixture";

let sandbox = "";
let home = "";
let bin = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-probe-"));
    home = path.join(sandbox, "home");
    bin = path.join(sandbox, "bin");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("OpenCode probe", () => {
    it("requires native executable permission evidence for Linux and WSL", () => {
        expect(installationRequiresExecutableMode(globalContext("linux").platformContext)).toBe(true);
        expect(installationRequiresExecutableMode(globalContext("wsl").platformContext)).toBe(true);
        expect(installationRequiresExecutableMode(globalContext("win32").platformContext)).toBe(false);
        expect(
            installationRequiresExecutableMode({
                platform: "wsl",
                platformInstanceId: "Ubuntu",
                accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example",
            }),
        ).toBe(true);
    });

    it("produces trusted checked-path evidence for a complete not-found result", async () => {
        const result = await probeOpencode(globalContext(), { PATH: "" }, home);
        expect(result.status).toBe("complete");
        expect(result.observation.observedAgentRuntimes[0]).toMatchObject({
            installationStatus: "not_found",
            installationEvidence: [
                expect.objectContaining({
                    path: path.join(home, ".opencode", "bin", "opencode"),
                    evidenceLevel: "local_artifact",
                }),
            ],
        });
        expect(validateAdapterProbeResult(opencodeProvider, result, globalContext().platformContext)).toEqual([]);
    });

    it("separates verified installation evidence from source/data presence", async () => {
        writeNative(path.join(bin, "opencode"));
        fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
        fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
        fs.mkdirSync(path.join(home, ".local", "share", "opencode"), { recursive: true });
        const registryPath = path.join(home, ".local", "share", "opencode", "opencode.db");
        const opaqueRegistry = Buffer.from("not a SQLite database; the Provider must not open or rewrite these bytes");
        fs.writeFileSync(registryPath, opaqueRegistry);
        const beforeInventory = fs.readdirSync(path.dirname(registryPath)).sort();
        const result = await probeOpencode(globalContext(), { PATH: bin }, home, process.platform, {
            discoverProjects: async (input) => ({
                status: "partial",
                projects: [],
                evidenceLevel: "local_artifact",
                diagnostics: [
                    {
                        severity: "warning",
                        code: "opencode_running_build_not_found",
                        message: "The fixture does not select a running OpenCode process",
                        path: input.diagnosticPath,
                        traceId: "",
                        operation: "probe",
                        causeKind: "partial",
                        retryable: false,
                        suggestedActions: [],
                        rawSummary: "",
                    },
                ],
            }),
        });
        const runtime = result.observation.observedAgentRuntimes[0];
        expect(runtime).toMatchObject({
            agentRuntimeId: "OPENCODE_CLI",
            installationStatus: "available",
            projectDiscoveryStatus: "partial",
        });
        expect(runtime?.installationEvidence).toEqual([
            expect.objectContaining({ kind: "executable", path: path.join(bin, "opencode") }),
        ]);
        expect(result.observation.sourceRoots).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: path.join(home, ".config", "opencode"),
                    rootRole: "config",
                    sourceDomain: "agent_runtime_private",
                }),
                expect.objectContaining({
                    path: path.join(home, ".agents", "skills"),
                    rootRole: "source",
                    sourceDomain: "family_shared",
                }),
                expect.objectContaining({
                    path: path.join(home, ".opencode"),
                    rootRole: "config",
                    sourceDomain: "agent_runtime_private",
                }),
                expect.objectContaining({
                    path: path.join(home, ".claude"),
                    rootRole: "config",
                    sourceDomain: "family_shared",
                }),
            ]),
        );
        expect(result.observation.agentRuntimeResources).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    roles: ["agent_runtime_data"],
                    accessStatus: "available",
                }),
                expect.objectContaining({ roles: ["project_registry"], accessStatus: "available" }),
            ]),
        );
        expect(result.observation.observedProjects).toEqual([]);
        expect(result.observation.targetCandidates).toEqual([
            expect.objectContaining({
                targetRootPath: path.join(home, ".agents", "skills"),
                targetKind: "directory",
                entryApplicabilities: [
                    expect.objectContaining({ agentRuntimeId: "OPENCODE_CLI", status: "ready_for_plan" }),
                    expect.objectContaining({ agentRuntimeId: "OPENCODE_APP", status: "invalid" }),
                ],
            }),
            expect.objectContaining({
                targetRootPath: path.join(home, ".config", "opencode"),
                targetKind: "global",
                entryApplicabilities: [
                    expect.objectContaining({ agentRuntimeId: "OPENCODE_CLI", status: "ready_for_plan" }),
                    expect.objectContaining({ agentRuntimeId: "OPENCODE_APP", status: "invalid" }),
                ],
            }),
        ]);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "opencode_running_build_not_found",
                path: registryPath,
            }),
        );
        expect(fs.readFileSync(registryPath)).toEqual(opaqueRegistry);
        expect(fs.readdirSync(path.dirname(registryPath)).sort()).toEqual(beforeInventory);
        expect(validateAdapterProbeResult(opencodeProvider, result, globalContext().platformContext)).toEqual([]);
    });

    it("preserves runtime project identities while deduplicating physical target roots", async () => {
        writeNative(path.join(bin, "opencode"));
        const registryPath = path.join(home, ".local", "share", "opencode", "opencode.db");
        const sharedRoot = path.join(sandbox, "shared-project");
        const sharedSandbox = path.join(sandbox, "shared-sandbox");
        const distinctRoot = path.join(sandbox, "distinct-project");
        fs.mkdirSync(path.dirname(registryPath), { recursive: true });
        fs.writeFileSync(registryPath, "fixture registry");
        for (const directory of [sharedRoot, sharedSandbox, distinctRoot]) fs.mkdirSync(directory);
        const projects = [
            {
                runtimeProjectKey: "project-b",
                displayName: "Shared B",
                primaryRuntimePath: sharedRoot,
                additionalRuntimePaths: [sharedSandbox],
                locatorKey: "debug_scrap:project-b",
            },
            {
                runtimeProjectKey: "project-a",
                displayName: "Shared A",
                primaryRuntimePath: sharedRoot,
                additionalRuntimePaths: [],
                locatorKey: "debug_scrap:project-a",
            },
            {
                runtimeProjectKey: "project-c",
                displayName: "Distinct",
                primaryRuntimePath: distinctRoot,
                additionalRuntimePaths: [],
                locatorKey: "debug_scrap:project-c",
            },
        ];
        const run = async (records: typeof projects) =>
            probeOpencode(globalContext(), { PATH: bin }, home, "linux", {
                discoverProjects: async () => ({
                    status: "complete",
                    projects: records,
                    diagnostics: [],
                    evidenceLevel: "agent_runtime_verified",
                }),
            });

        const forward = await run(projects);
        const reversed = await run([...projects].reverse());
        expect(forward.observation.observedProjects.map((project) => project.runtimeProjectKey).sort()).toEqual([
            "project-a",
            "project-b",
            "project-c",
        ]);
        expect(
            forward.observation.observedProjects.find((project) => project.runtimeProjectKey === "project-b")?.workspaces,
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ role: "primary" }),
                expect.objectContaining({ role: "additional" }),
            ]),
        );
        expect(forward.observation.targetCandidates).toHaveLength(2);
        const sharedTarget = forward.observation.targetCandidates.find((candidate) => candidate.targetRootPath === sharedRoot);
        expect(sharedTarget?.entryApplicabilities).toEqual([
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_CLI",
                status: "unknown",
                diagnostics: [expect.objectContaining({ code: "opencode_target_build_version_unverified" })],
                locatorEvidence: expect.arrayContaining([
                    expect.objectContaining({ locatorKey: "debug_scrap:project-a:worktree" }),
                    expect.objectContaining({ locatorKey: "debug_scrap:project-b:worktree" }),
                ]),
            }),
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_APP",
                status: "invalid",
                diagnostics: [expect.objectContaining({ code: "opencode_app_target_installation_not_found" })],
            }),
        ]);
        expect(forward.observation).toEqual(reversed.observation);
        expect(validateAdapterProbeResult(opencodeProvider, forward, globalContext().platformContext)).toEqual([]);
    });

    it("keeps valid runtime projects when another registry workspace escapes the selected access root", async () => {
        const selectedRoot = path.join(sandbox, "selected");
        const selectedHome = path.join(selectedRoot, "home");
        const selectedBin = path.join(selectedRoot, "bin");
        const project = path.join(selectedRoot, "project");
        const registryPath = path.join(selectedHome, ".local", "share", "opencode", "opencode.db");
        fs.mkdirSync(path.dirname(registryPath), { recursive: true });
        fs.mkdirSync(project, { recursive: true });
        fs.mkdirSync(selectedBin, { recursive: true });
        fs.writeFileSync(registryPath, "fixture registry");
        writeNative(path.join(selectedBin, "opencode"));
        const context = {
            authorizationScope: "global" as const,
            platformContext: { platform: "linux" as const, platformInstanceId: "selected", accessRootPath: selectedRoot },
        };
        const result = await probeOpencode(context, { PATH: selectedBin }, selectedHome, "linux", {
            discoverProjects: async () => ({
                status: "complete",
                projects: [
                    {
                        runtimeProjectKey: "valid",
                        displayName: "Valid",
                        primaryRuntimePath: project,
                        additionalRuntimePaths: [path.join(sandbox, "outside-sandbox")],
                        locatorKey: "debug_scrap:valid",
                    },
                    {
                        runtimeProjectKey: "outside",
                        displayName: "Outside",
                        primaryRuntimePath: path.join(sandbox, "outside"),
                        additionalRuntimePaths: [],
                        locatorKey: "debug_scrap:outside",
                    },
                ],
                diagnostics: [],
                evidenceLevel: "agent_runtime_verified",
            }),
        });
        expect(result.observation.observedProjects.map((item) => item.runtimeProjectKey)).toEqual(["valid"]);
        expect(result.observation.targetCandidates.map((item) => item.targetRootPath)).toEqual([project]);
        expect(result.observation.targetCandidates[0]?.entryApplicabilities[0]).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "opencode_target_build_version_unverified" })],
        });
        expect(result.observation.observedAgentRuntimes[0]?.projectDiscoveryStatus).toBe("partial");
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_project_workspace_outside_selected_environment" }),
        );
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_project_sandbox_outside_selected_environment" }),
        );
        expect(validateAdapterProbeResult(opencodeProvider, result, context.platformContext)).toEqual([]);
    });

    it("does not interpret a stopped registry without one exact installed OpenCode build", async () => {
        const registryPath = path.join(home, ".local", "share", "opencode", "opencode.db");
        fs.mkdirSync(path.dirname(registryPath), { recursive: true });
        fs.writeFileSync(registryPath, "fixture registry");
        const result = await probeOpencode(globalContext(), { PATH: "" }, home);
        expect(result.observation.observedAgentRuntimes[0]).toMatchObject({
            installationStatus: "not_found",
            projectDiscoveryStatus: "partial",
        });
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "opencode_stopped_exact_build_unavailable",
                path: registryPath,
            }),
        );
    });

    it("uses global config AGENTS before the Claude-compatible fallback root", async () => {
        const config = path.join(home, ".config", "opencode");
        fs.mkdirSync(config, { recursive: true });
        fs.writeFileSync(path.join(config, "AGENTS.md"), "# Preferred global guidance\n");
        fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
        fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# Fallback\n");

        const preferred = await probeOpencode(globalContext(), { PATH: "" }, home);
        expect(preferred.observation.sourceRoots.map((root) => root.path)).not.toContain(path.join(home, ".claude"));

        fs.rmSync(path.join(config, "AGENTS.md"));
        const fallback = await probeOpencode(globalContext(), { PATH: "" }, home);
        expect(fallback.observation.sourceRoots).toContainEqual(
            expect.objectContaining({
                path: path.join(home, ".claude"),
                sourceDomain: "family_shared",
            }),
        );

        fs.symlinkSync(path.join(sandbox, "unresolved-guidance"), path.join(config, "AGENTS.md"));
        const unresolved = await probeOpencode(globalContext(), { PATH: "" }, home);
        expect(unresolved.observation.sourceRoots.map((root) => root.path)).not.toContain(path.join(home, ".claude"));
        expect(unresolved.diagnostics.map((item) => item.code)).toContain("opencode_probe_symlink_untrusted");

        const override = path.join(sandbox, "active-opencode-config");
        fs.mkdirSync(override);
        fs.writeFileSync(path.join(override, "AGENTS.md"), "# Override Guidance\n");
        const activeOverride = await probeOpencode(globalContext(), { PATH: "", OPENCODE_CONFIG_DIR: override }, home);
        expect(activeOverride.observation.sourceRoots.map((root) => root.path)).not.toContain(path.join(home, ".claude"));
        expect(
            activeOverride.observation.sourceRoots.find((root) => root.path === override)?.locatorEvidence[0]?.locatorKey,
        ).toBe("opencode_global_config:OPENCODE_CONFIG_DIR");

        fs.rmSync(path.join(override, "AGENTS.md"));
        const overrideFallback = await probeOpencode(globalContext(), { PATH: "", OPENCODE_CONFIG_DIR: override }, home);
        expect(overrideFallback.observation.sourceRoots.map((root) => root.path)).toContain(path.join(home, ".claude"));

        const symlinkTarget = path.join(sandbox, "real-config-without-guidance");
        const symlinkConfig = path.join(sandbox, "symlink-config");
        fs.mkdirSync(symlinkTarget);
        fs.symlinkSync(symlinkTarget, symlinkConfig);
        const untrustedParent = await probeOpencode(globalContext(), { PATH: "", OPENCODE_CONFIG_DIR: symlinkConfig }, home);
        expect(untrustedParent.observation.sourceRoots.map((root) => root.path)).not.toContain(path.join(home, ".claude"));
        expect(untrustedParent.observation.sourceRoots.find((root) => root.path === symlinkConfig)).toMatchObject({
            accessStatus: "unknown",
        });
    });

    it("does not treat a shell wrapper or residual data as installation", async () => {
        fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
        fs.mkdirSync(path.join(home, ".local", "share", "opencode"), { recursive: true });
        const result = await probeOpencode(globalContext(), { PATH: bin }, home);
        expect(result.observation.observedAgentRuntimes[0]?.installationStatus).toBe("unknown");
        expect(result.observation.observedAgentRuntimes[0]?.installationEvidence).toEqual([]);
        expect(result.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining(["opencode_launcher_is_not_native_binary", "opencode_residual_data_without_installation"]),
        );
    });

    it("records a project root and blocks its target when project Guidance is disabled", async () => {
        const project = path.join(sandbox, "project");
        const registryPath = path.join(home, ".local", "share", "opencode", "opencode.db");
        const opaqueRegistry = Buffer.from("project-scoped probes must not open this registry");
        fs.mkdirSync(project, { recursive: true });
        fs.mkdirSync(path.dirname(registryPath), { recursive: true });
        fs.writeFileSync(registryPath, opaqueRegistry);
        const result = await probeOpencode(
            projectContext(project),
            {
                PATH: "",
                OPENCODE_DISABLE_PROJECT_CONFIG: "1",
                OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
            },
            home,
        );
        const root = result.observation.sourceRoots.find((item) => item.path === project);
        expect(root?.locatorEvidence[0]?.locatorKey).toBe(
            "probe_project_root:project_config_off:external_skills_off:claude_prompt_on:claude_skills_off",
        );
        expect(result.observation.observedProjects[0]?.workspaces).toEqual([
            { sourceRootId: root?.sourceRootId, role: "primary" },
        ]);
        expect(result.observation.observedAgentRuntimes[0]?.sourceRootIds).not.toContain(root?.sourceRootId);
        expect(result.observation.targetCandidates[0]?.entryApplicabilities[0]).toMatchObject({
            status: "invalid",
            diagnostics: [expect.objectContaining({ code: "opencode_project_guidance_disabled" })],
        });
        expect(result.observation.observedAgentRuntimes[0]?.projectDiscoveryStatus).toBe("complete");
        expect(result.diagnostics.map((item) => item.code)).not.toContain("opencode_project_registry_parse_deferred");
        expect(fs.readFileSync(registryPath)).toEqual(opaqueRegistry);
    });

    it("binds the explicit Project in Core while preserving the source feature gates", async () => {
        const project = path.join(sandbox, "selected-project");
        fs.mkdirSync(project);
        writeNative(path.join(bin, "opencode"));
        const result = await probeOpencode(
            projectContext(project),
            {
                PATH: bin,
                OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
            },
            home,
            "linux",
            {
                observeCliVersion: async (installation, platformContext) => ({
                    ...installation,
                    versionText: "1.17.11",
                    buildIdentity: "fixture",
                    platform: platformContext.platform,
                }),
            },
        );
        const runtime = result.observation.observedAgentRuntimes.find((entry) => entry.agentRuntimeId === "OPENCODE_CLI");
        if (runtime === undefined) throw new Error("missing fixture CLI observation");
        const root = result.observation.sourceRoots.find((entry) => entry.path === project);
        expect(root?.locatorEvidence).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    locatorKey: "probe_project_root:project_config_on:external_skills_on:claude_prompt_on:claude_skills_off",
                }),
                { locatorKind: "user_provided_path", locatorKey: "probe_project_root", evidenceLevel: "user_provided" },
            ]),
        );
        const bind = (observation: typeof result.observation, targetRootPath = project) =>
            findObservedProjectBindingEvidence(
                observation,
                runtime.observedProjectIds,
                runtime.sourceRootIds,
                runtime.agentRuntimeResourceIds,
                targetRootPath,
            );
        expect(bind(result.observation)).toBe("user_provided");
        expect(bind(result.observation, path.join(sandbox, "other-project"))).toBeNull();
        for (const removeFrom of ["root", "project"] as const) {
            const unbound = structuredClone(result.observation);
            if (removeFrom === "root")
                for (const source of unbound.sourceRoots) {
                    source.locatorEvidence = source.locatorEvidence.filter((entry) => entry.locatorKey !== "probe_project_root");
                }
            else
                for (const observed of unbound.observedProjects) {
                    observed.evidence = observed.evidence.filter((entry) => entry.locatorKey !== "probe_project_root");
                }
            expect(bind(unbound)).toBeNull();
        }
        expect(validateAdapterProbeResult(opencodeProvider, result, projectContext(project).platformContext)).toEqual([]);
    });

    it("keeps project source/read evidence available when only target build version is unverifiable", async () => {
        const project = path.join(sandbox, "source-only-project");
        fs.mkdirSync(project);
        fs.writeFileSync(path.join(project, "AGENTS.md"), "# Source remains readable\n");
        writeNative(path.join(bin, "opencode"));
        const context = projectContext(project, "wsl");
        const result = await probeOpencode(context, { PATH: bin }, home, "linux", {
            observeCliVersion: async (installation, platformContext) => ({
                ...installation,
                versionText: "",
                buildIdentity: "",
                platform: platformContext.platform,
            }),
        });

        expect(result.observation.observedAgentRuntimes[0]).toMatchObject({
            installationStatus: "available",
            versionText: "",
        });
        expect(result.observation.sourceRoots).toContainEqual(
            expect.objectContaining({ path: project, accessStatus: "available", sourceDomain: "project_root" }),
        );
        expect(result.observation.targetCandidates[0]?.entryApplicabilities[0]).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "opencode_target_build_version_unverified" })],
        });
        expect(validateAdapterProbeResult(opencodeProvider, result, context.platformContext)).toEqual([]);
    });

    it("binds a verified Desktop package to the selected project without borrowing CLI installation evidence", async () => {
        const project = path.join(sandbox, "project");
        const appRoot = path.join(sandbox, "opencode-app");
        const appExecutable = path.join(appRoot, "ai.opencode.desktop");
        fs.mkdirSync(project);
        writeNative(appExecutable);
        fs.mkdirSync(path.join(appRoot, "resources"), { recursive: true });
        fs.writeFileSync(path.join(appRoot, "resources", "app.asar"), opencodeAppAsar("1.18.15"));

        const result = await probeOpencode(projectContext(project), { PATH: "", OPENCODE_APP_INSTALL_DIR: appRoot }, home);

        expect(result.observation.observedAgentRuntimes).toEqual([
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_CLI",
                installationStatus: "not_found",
                versionText: "",
            }),
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_APP",
                installationStatus: "available",
                projectDiscoveryStatus: "complete",
                versionText: "1.18.15",
                installationEvidence: expect.arrayContaining([
                    expect.objectContaining({ kind: "app_bundle", path: path.join(appRoot, "resources", "app.asar") }),
                ]),
            }),
        ]);
        expect(result.observation.targetCandidates[0]?.entryApplicabilities).toEqual([
            expect.objectContaining({ agentRuntimeId: "OPENCODE_CLI", status: "invalid" }),
            expect.objectContaining({ agentRuntimeId: "OPENCODE_APP", status: "ready_for_plan", diagnostics: [] }),
        ]);
        expect(validateAdapterProbeResult(opencodeProvider, result, projectContext(project).platformContext)).toEqual([]);
    });

    it("keeps Desktop global Project discovery partial instead of borrowing the CLI registry", async () => {
        const appRoot = path.join(sandbox, "opencode-app");
        writeNative(path.join(appRoot, "ai.opencode.desktop"));
        fs.mkdirSync(path.join(appRoot, "resources"), { recursive: true });
        fs.writeFileSync(path.join(appRoot, "resources", "app.asar"), opencodeAppAsar("1.18.15"));

        const result = await probeOpencode(globalContext(), { PATH: "", OPENCODE_APP_INSTALL_DIR: appRoot }, home);
        const appRuntime = result.observation.observedAgentRuntimes.find((runtime) => runtime.agentRuntimeId === "OPENCODE_APP");

        expect(result.status).toBe("partial");
        expect(appRuntime).toMatchObject({
            installationStatus: "available",
            projectDiscoveryStatus: "partial",
            observedProjectIds: [],
            diagnostics: [expect.objectContaining({ code: "opencode_app_project_discovery_unverified" })],
        });
        expect(
            appRuntime?.agentRuntimeResourceIds.some((resourceId) =>
                result.observation.agentRuntimeResources
                    .find((resource) => resource.agentRuntimeResourceId === resourceId)
                    ?.roles.includes("project_registry"),
            ),
        ).toBe(false);
        expect(validateAdapterProbeResult(opencodeProvider, result, globalContext().platformContext)).toEqual([]);
    });

    it("adds XDG and OPENCODE_CONFIG_DIR roots without scanning the real home", async () => {
        const xdg = path.join(sandbox, "xdg");
        const extra = path.join(sandbox, "extra-config");
        fs.mkdirSync(path.join(xdg, "opencode"), { recursive: true });
        fs.mkdirSync(extra, { recursive: true });
        const result = await probeOpencode(
            globalContext(),
            {
                PATH: "",
                XDG_CONFIG_HOME: xdg,
                OPENCODE_CONFIG_DIR: extra,
                OPENCODE_CONFIG: path.join(sandbox, "mixed.json"),
                OPENCODE_CONFIG_CONTENT: '{"agent":{}}',
            },
            home,
        );
        expect(result.observation.sourceRoots.map((root) => root.path)).toEqual(
            expect.arrayContaining([path.join(xdg, "opencode"), extra]),
        );
        expect(result.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining(["opencode_explicit_config_fragment_deferred", "opencode_inline_config_fragment_deferred"]),
        );
        expect(JSON.stringify(result)).not.toContain('{"agent":{}}');
    });

    it("represents an in-memory database without inventing a persistent project registry", async () => {
        const result = await probeOpencode(globalContext(), { PATH: "", OPENCODE_DB: ":memory:" }, home);
        expect(result.observation.agentRuntimeResources.some((item) => item.roles.includes("project_registry"))).toBe(false);
        expect(result.diagnostics.map((item) => item.code)).toContain("opencode_memory_database_has_no_persistent_registry");
    });

    it.each([
        ["a missing registry path", { PATH: "" }, true],
        ["an in-memory database", { PATH: "", OPENCODE_DB: ":memory:" }, false],
    ] as const)("discovers running projects with %s", async (_label, databaseEnvironment, projectsRegistryResource) => {
        writeNative(path.join(bin, "opencode"));
        const project = path.join(sandbox, "running-project");
        fs.mkdirSync(project);
        let calls = 0;
        const result = await probeOpencode(globalContext(), { ...databaseEnvironment, PATH: bin }, home, "linux", {
            discoverProjects: async () => {
                calls += 1;
                return {
                    status: "complete",
                    projects: [
                        {
                            runtimeProjectKey: "running",
                            displayName: "Running",
                            primaryRuntimePath: project,
                            additionalRuntimePaths: [],
                            locatorKey: "debug_scrap:running",
                        },
                    ],
                    diagnostics: [],
                    evidenceLevel: "agent_runtime_verified",
                };
            },
        });

        expect(calls).toBe(1);
        expect(result.observation.agentRuntimeResources.some((item) => item.roles.includes("project_registry"))).toBe(
            projectsRegistryResource,
        );
        expect(result.observation.observedProjects).toEqual([
            expect.objectContaining({
                runtimeProjectKey: "running",
                evidence: [
                    {
                        evidenceKind: "invocation",
                        locatorKey: "debug_scrap:running",
                        evidenceLevel: "agent_runtime_verified",
                    },
                ],
            }),
        ]);
        expect(result.observation.targetCandidates[0]?.entryApplicabilities[0]).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "opencode_target_build_version_unverified" })],
        });
        expect(result.observation.observedAgentRuntimes[0]?.projectDiscoveryStatus).toBe("complete");
        expect(result.diagnostics.map((item) => item.code)).not.toContain("opencode_memory_database_has_no_persistent_registry");
        expect(validateAdapterProbeResult(opencodeProvider, result, globalContext().platformContext)).toEqual([]);
    });

    it("fails closed for invalid roots and an unreachable platform", async () => {
        const invalidHome = await probeOpencode(globalContext(), { PATH: "" }, "relative-home");
        expect(invalidHome.status).toBe("failed");
        expect(invalidHome.diagnostics[0]?.code).toBe("opencode_path_rule_invalid");

        const invalidProject = await probeOpencode(projectContext("relative"), { PATH: "" }, home);
        expect(invalidProject.status).toBe("partial");
        expect(invalidProject.diagnostics.map((item) => item.code)).toContain("opencode_project_root_invalid");

        const nonCanonicalProject = await probeOpencode(projectContext(`${sandbox}/project/../project`), { PATH: "" }, home);
        expect(nonCanonicalProject.diagnostics.map((item) => item.code)).toContain("opencode_project_root_invalid");

        const nulProject = await probeOpencode(projectContext(`${sandbox}/project\0tail`), { PATH: "" }, home);
        expect(nulProject.diagnostics.map((item) => item.code)).toContain("opencode_project_root_invalid");

        const unreachable = await probeOpencode(globalContext("darwin"), { PATH: "" }, home, "linux");
        expect(unreachable.status).toBe("partial");
        expect(unreachable.observation.observedAgentRuntimes[0]?.installationStatus).toBe("unknown");

        const selectedRoot = path.join(sandbox, "selected-root");
        const selectedHome = path.join(selectedRoot, "home");
        const foreignConfig = path.join(sandbox, "foreign-config");
        fs.mkdirSync(selectedHome, { recursive: true });
        fs.mkdirSync(foreignConfig, { recursive: true });
        const outsideSelectedRoot = await probeOpencode(
            {
                authorizationScope: "global",
                platformContext: { platform: "linux", platformInstanceId: "selected", accessRootPath: selectedRoot },
            },
            { PATH: "", OPENCODE_CONFIG_DIR: foreignConfig },
            selectedHome,
        );
        expect(outsideSelectedRoot.status).toBe("partial");
        expect(outsideSelectedRoot.observation.sourceRoots).toEqual([]);
        expect(outsideSelectedRoot.diagnostics).toEqual([
            expect.objectContaining({ code: "opencode_path_rule_outside_selected_environment" }),
        ]);

        const foreignBin = path.join(sandbox, "foreign-bin");
        const selectedBin = path.join(selectedRoot, "bin");
        fs.mkdirSync(foreignBin);
        fs.mkdirSync(selectedBin);
        writeNative(path.join(foreignBin, "opencode"));
        fs.symlinkSync(path.join(foreignBin, "opencode"), path.join(selectedBin, "opencode"));
        const escapingInstallLink = await probeOpencode(
            {
                authorizationScope: "global",
                platformContext: { platform: "linux", platformInstanceId: "selected", accessRootPath: selectedRoot },
            },
            { PATH: selectedBin },
            selectedHome,
        );
        expect(escapingInstallLink.observation.observedAgentRuntimes[0]?.installationStatus).toBe("unknown");
        expect(escapingInstallLink.observation.observedAgentRuntimes[0]?.installationEvidence).toEqual([]);
        expect(escapingInstallLink.diagnostics.map((item) => item.code)).toContain(
            "opencode_install_symlink_target_outside_selected_environment",
        );

        const outsideInstallDirectory = await probeOpencode(
            {
                authorizationScope: "global",
                platformContext: { platform: "linux", platformInstanceId: "selected", accessRootPath: selectedRoot },
            },
            { PATH: "", OPENCODE_INSTALL_DIR: foreignBin },
            selectedHome,
        );
        expect(outsideInstallDirectory.observation.observedAgentRuntimes[0]?.installationStatus).toBe("unknown");
        expect(outsideInstallDirectory.observation.observedAgentRuntimes[0]?.installationEvidence).toEqual([]);
        expect(outsideInstallDirectory.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "opencode_install_candidate_outside_selected_environment",
                path: path.join(foreignBin, "opencode"),
            }),
        );

        fs.rmSync(path.join(selectedBin, "opencode"));
        writeNative(path.join(selectedBin, "opencode"));
        const selectedInstallWithForeignPath = await probeOpencode(
            {
                authorizationScope: "global",
                platformContext: { platform: "linux", platformInstanceId: "selected", accessRootPath: selectedRoot },
            },
            { PATH: `${foreignBin}${path.delimiter}${selectedBin}` },
            selectedHome,
            "linux",
            {
                discoverProjects: async () => ({
                    status: "complete",
                    projects: [],
                    diagnostics: [],
                    evidenceLevel: "agent_runtime_verified",
                }),
            },
        );
        expect(selectedInstallWithForeignPath.observation.observedAgentRuntimes[0]?.installationStatus).toBe("available");
        expect(selectedInstallWithForeignPath.diagnostics.map((item) => item.code)).not.toContain(
            "opencode_install_candidate_outside_selected_environment",
        );

        fs.rmSync(path.join(selectedBin, "opencode"));
        const onlyForeignPath = await probeOpencode(
            {
                authorizationScope: "global",
                platformContext: { platform: "linux", platformInstanceId: "selected", accessRootPath: selectedRoot },
            },
            { PATH: foreignBin },
            selectedHome,
        );
        expect(onlyForeignPath.observation.observedAgentRuntimes[0]?.installationStatus).toBe("unknown");
        expect(
            onlyForeignPath.diagnostics.filter((item) => item.code === "opencode_install_candidate_outside_selected_environment"),
        ).toEqual([
            expect.objectContaining({
                path: path.join(foreignBin, "opencode"),
            }),
        ]);
    });

    it("requires Linux execution before probing a Windows-hosted WSL Environment", async () => {
        const wslHome = "\\\\wsl.localhost\\Ubuntu\\home\\example";
        const result = await probeOpencode(
            {
                authorizationScope: "global",
                platformContext: { platform: "wsl", platformInstanceId: "Ubuntu", accessRootPath: wslHome },
            },
            {
                PATH: "C:\\poison-bin",
                OPENCODE_CONFIG_DIR: "C:\\poison-config",
                XDG_CONFIG_HOME: "C:\\poison-xdg",
            },
            "C:\\Users\\poison",
            "win32",
        );
        expect(result.status).toBe("partial");
        expect(result.observation.sourceRoots).toEqual([]);
        expect(result.diagnostics).toEqual([expect.objectContaining({ code: "opencode_probe_platform_unreachable" })]);
        expect(JSON.stringify(result)).not.toContain("poison");
    });

    it("requires Linux execution before probing a Windows-hosted WSL project", async () => {
        const wslHome = "\\\\wsl.localhost\\Ubuntu\\home\\example";
        const project = `${wslHome}\\project`;
        const result = await probeOpencode(
            {
                authorizationScope: "project",
                platformContext: { platform: "wsl", platformInstanceId: "Ubuntu", accessRootPath: wslHome },
                projectRootPath: project,
            },
            {},
            "C:\\Users\\poison",
            "win32",
        );
        expect(result.status).toBe("partial");
        expect(result.observation.sourceRoots).toEqual([]);
        expect(result.diagnostics).toEqual([expect.objectContaining({ code: "opencode_probe_platform_unreachable" })]);
        expect(JSON.stringify(result)).not.toContain("poison");
    });

    it("reports an authorized external directory without claiming target support", async () => {
        const external = path.join(sandbox, "external");
        fs.mkdirSync(external, { recursive: true });
        const result = await probeOpencode(directoryContext(external), { PATH: "" }, home);
        expect(result.observation.sourceRoots).toContainEqual(
            expect.objectContaining({
                path: external,
                rootRole: "source",
                sourceDomain: "external_managed",
                accessStatus: "available",
            }),
        );
        expect(result.observation.targetCandidates).toEqual([]);
    });

    it("recognizes native ELF, Mach-O, and PE binaries only on the requested inspectable platform", async () => {
        writeMagic(path.join(bin, "opencode"), [0xfe, 0xed, 0xfa, 0xce]);
        const darwin = await probeOpencode(globalContext("darwin"), { PATH: bin }, home, "darwin");
        expect(darwin.observation.observedAgentRuntimes[0]?.installationStatus).toBe("available");

        // Modern 64-bit Mach-O files normally store MH_MAGIC_64 in little-endian byte order.
        writeMagic(path.join(bin, "opencode"), [0xcf, 0xfa, 0xed, 0xfe]);
        const darwin64 = await probeOpencode(globalContext("darwin"), { PATH: bin }, home, "darwin");
        expect(darwin64.observation.observedAgentRuntimes[0]?.installationStatus).toBe("available");

        writeMagic(path.join(bin, "opencode"), [0xca, 0xfe, 0xba, 0xbe]);
        const universal = await probeOpencode(globalContext("darwin"), { PATH: bin }, home, "darwin");
        expect(universal.observation.observedAgentRuntimes[0]?.installationStatus).toBe("available");

        writeMagic(path.join(bin, "opencode.exe"), [0x4d, 0x5a, 0, 0]);
        const windows = await probeOpencode(globalContext("win32"), { PATH: bin }, home, "win32");
        expect(windows.observation.observedAgentRuntimes[0]?.installationStatus).toBe("available");

        writeNative(path.join(bin, "opencode"));
        const wsl = await probeOpencode(globalContext("wsl"), { PATH: bin }, home, "linux");
        expect(wsl.observation.observedAgentRuntimes[0]?.installationStatus).toBe("available");

        writeMagic(path.join(bin, "opencode"), [0xcf, 0xfa, 0xed, 0xfe]);
        const machOnLinux = await probeOpencode(globalContext(), { PATH: bin }, home);
        expect(machOnLinux.observation.observedAgentRuntimes[0]?.installationStatus).toBe("unknown");
        expect(machOnLinux.diagnostics.map((item) => item.code)).toContain("opencode_launcher_is_not_native_binary");

        writeNative(path.join(bin, "opencode"));
        const elfOnDarwin = await probeOpencode(globalContext("darwin"), { PATH: bin }, home, "darwin");
        expect(elfOnDarwin.observation.observedAgentRuntimes[0]?.installationStatus).toBe("unknown");
    });

    it("rejects invalid launchers but accepts a symlink only after resolving a native binary", async () => {
        fs.writeFileSync(path.join(bin, "opencode"), Buffer.from([0x7f]), { mode: 0o755 });
        const short = await probeOpencode(globalContext(), { PATH: bin, OPENCODE_INSTALL_DIR: "relative" }, home);
        expect(short.observation.observedAgentRuntimes[0]?.installationStatus).toBe("unknown");
        expect(short.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining(["opencode_install_dir_invalid", "opencode_launcher_is_not_native_binary"]),
        );

        fs.writeFileSync(path.join(bin, "opencode"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]), {
            mode: 0o644,
        });
        fs.chmodSync(path.join(bin, "opencode"), 0o644);
        const nonExecutable = await probeOpencode(globalContext(), { PATH: bin }, home);
        expect(nonExecutable.observation.observedAgentRuntimes[0]?.installationStatus).toBe("not_found");
        expect(nonExecutable.observation.observedAgentRuntimes[0]?.installationEvidence).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: path.join(bin, "opencode"),
                    evidenceLevel: "local_artifact",
                }),
            ]),
        );

        fs.rmSync(path.join(bin, "opencode"));
        const native = path.join(sandbox, "native-opencode");
        writeNative(native);
        fs.symlinkSync(native, path.join(bin, "opencode"));
        const symlink = await probeOpencode(globalContext(), { PATH: bin }, home);
        expect(symlink.observation.observedAgentRuntimes[0]?.installationStatus).toBe("available");
        expect(symlink.observation.observedAgentRuntimes[0]?.installationEvidence).toEqual([
            expect.objectContaining({ path: native, evidenceLevel: "local_artifact" }),
        ]);

        fs.rmSync(path.join(bin, "opencode"));
        fs.symlinkSync(path.join(sandbox, "missing-native"), path.join(bin, "opencode"));
        const brokenSymlink = await probeOpencode(globalContext(), { PATH: bin }, home);
        expect(brokenSymlink.observation.observedAgentRuntimes[0]?.installationStatus).toBe("unknown");
        expect(brokenSymlink.diagnostics.map((item) => item.code)).toContain("opencode_install_symlink_target_unavailable");

        fs.rmSync(path.join(bin, "opencode"));
        writeNative(path.join(bin, "opencode"));
        const pathAlias = await probeOpencode(
            globalContext(),
            {
                Path: `${path.join(sandbox, "relative", "..")}${path.delimiter}${bin}`,
                OPENCODE_INSTALL_DIR: bin,
            },
            home,
        );
        expect(pathAlias.observation.observedAgentRuntimes[0]?.installationStatus).toBe("available");
        expect(pathAlias.observation.observedAgentRuntimes[0]?.installationEvidence).toHaveLength(1);
    });
});

function writeNative(target: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), { mode: 0o755 });
}

function writeMagic(target: string, bytes: number[]): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(bytes), { mode: 0o755 });
}
