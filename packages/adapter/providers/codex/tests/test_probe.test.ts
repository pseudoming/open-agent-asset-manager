import type { AdapterProbeContext, Platform } from "@oaam/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAdapterProbeResult } from "../../../core/src/adapters/adapter-contract-validator";
import { probeCodex } from "../src/codex-probe";
import { diagnoseMissingCodexCliVersion } from "../src/codex-probe-installation";
import { codexProvider } from "../src/codex-provider";

let sandbox = "";
let home = "";
let bin = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-codex-probe-"));
    home = path.join(sandbox, "home");
    bin = path.join(sandbox, "bin");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Codex probe", () => {
    it("preserves the exact executable, probe stage, and retry action when CLI version observation is missing", () => {
        const executable = "\\\\wsl.localhost\\Ubuntu\\home\\example\\.local\\bin\\codex";
        const installation = {
            status: "available" as const,
            evidence: [
                { kind: "executable" as const, path: executable, evidenceLevel: "local_artifact" as const, diagnostics: [] },
            ],
            diagnostics: [],
            versionText: "",
        };

        expect(diagnoseMissingCodexCliVersion(installation)).toMatchObject({
            status: "available",
            versionText: "",
            diagnostics: [
                {
                    code: "codex_cli_version_not_observed",
                    operation: "probe",
                    causeKind: "partial",
                    path: executable,
                    retryable: true,
                    suggestedActions: ["retry"],
                    rawSummary: "",
                },
            ],
        });
        expect(diagnoseMissingCodexCliVersion({ ...installation, versionText: "0.142.5" })).toEqual({
            ...installation,
            versionText: "0.142.5",
        });
        expect(JSON.stringify(diagnoseMissingCodexCliVersion(installation))).not.toMatch(/argv|stderr|environment/iu);
    });

    it("proves independent native CLI/App installation in a selected Windows context", async () => {
        writeMagic(path.join(bin, "codex.exe"), [0x4d, 0x5a, 0, 0]);
        const localAppData = path.join(home, "AppData", "Local");
        const appExecutable = path.join(localAppData, "OpenAI", "Codex", "bin", "build-a", "codex.exe");
        writeMagic(appExecutable, [0x4d, 0x5a, 0, 0]);

        const context = globalContext("win32");
        const result = await probeCodex(context, { PATH: bin, LOCALAPPDATA: localAppData }, home, "win32");
        expect(result.status).toBe("complete");
        expect(runtimeStatuses(result)).toEqual({ CODEX_CLI: "available", CODEX_APP: "available" });
        expect(runtime(result, "CODEX_CLI")?.installationEvidence).toEqual([
            expect.objectContaining({ kind: "executable", path: path.join(bin, "codex.exe") }),
        ]);
        expect(runtime(result, "CODEX_APP")?.installationEvidence).toEqual([
            expect.objectContaining({ kind: "install_root" }),
            expect.objectContaining({ kind: "executable", path: appExecutable }),
        ]);
        expect(validateAdapterProbeResult(codexProvider, result, context.platformContext)).toEqual([]);
    });

    it("attributes an unchecked WSL Project reference only to an independently available Windows App", async () => {
        const runtimePath = "\\\\wsl.localhost\\Ubuntu\\home\\example\\work\\project";
        const codexHome = path.join(home, ".codex");
        const localAppData = path.join(home, "AppData", "Local");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.writeFileSync(path.join(codexHome, "config.toml"), `[projects.'${runtimePath}']\ntrust_level = "trusted"\n`);
        writeMagic(path.join(localAppData, "OpenAI", "Codex", "bin", "build-a", "codex.exe"), [0x4d, 0x5a, 0, 0]);

        const context = globalContext("win32");
        const result = await probeCodex(context, { PATH: "", LOCALAPPDATA: localAppData }, home, "win32");

        expect(runtimeStatuses(result)).toEqual({ CODEX_CLI: "not_found", CODEX_APP: "available" });
        expect(result.observation.environmentReferences).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                referenceKind: "project",
                referencedEnvironment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                validationState: "not_checked",
                evidence: expect.objectContaining({ evidenceLevel: "local_artifact" }),
            }),
        ]);
        expect(result.observation.sourceRoots.map((root) => root.path)).not.toContain(runtimePath);
        expect(result.observation.observedProjects).toEqual([]);
        expect(result.observation.targetCandidates.map((candidate) => candidate.targetRootPath)).not.toContain(runtimePath);
        expect(JSON.stringify(result)).not.toContain(runtimePath);
        expect(validateAdapterProbeResult(codexProvider, result, context.platformContext)).toEqual([]);
    });

    it("does not borrow a CLI-only Windows installation to expose an App-owned WSL Project reference", async () => {
        const runtimePath = "\\\\wsl.localhost\\Ubuntu\\home\\example\\work\\project";
        const codexHome = path.join(home, ".codex");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.writeFileSync(path.join(codexHome, "config.toml"), `[projects.'${runtimePath}']\ntrust_level = "trusted"\n`);
        writeMagic(path.join(bin, "codex.exe"), [0x4d, 0x5a, 0, 0]);

        const context = globalContext("win32");
        const result = await probeCodex(context, { PATH: bin }, home, "win32");

        expect(runtimeStatuses(result)).toEqual({ CODEX_CLI: "available", CODEX_APP: "not_found" });
        expect(result.observation.environmentReferences).toBeUndefined();
        expect(result.observation.sourceRoots.map((root) => root.path)).not.toContain(runtimePath);
        expect(result.observation.observedProjects).toEqual([]);
        expect(result.observation.targetCandidates.map((candidate) => candidate.targetRootPath)).not.toContain(runtimePath);
        expect(JSON.stringify(result)).not.toContain(runtimePath);
        expect(validateAdapterProbeResult(codexProvider, result, context.platformContext)).toEqual([]);
    });

    it("offers an exact selected Windows Project to both installed target entries", async () => {
        writeMagic(path.join(bin, "codex.exe"), [0x4d, 0x5a, 0, 0]);
        const localAppData = path.join(home, "AppData", "Local");
        writeMagic(path.join(localAppData, "OpenAI", "Codex", "bin", "build-a", "codex.exe"), [0x4d, 0x5a, 0, 0]);
        const projectRoot = path.join(sandbox, "project");
        fs.mkdirSync(projectRoot);
        const context = projectContext(projectRoot, "win32");

        const result = await probeCodex(context, { PATH: bin, LOCALAPPDATA: localAppData }, home, "win32");

        expect(result.observation.targetCandidates[0]?.entryApplicabilities).toEqual([
            expect.objectContaining({ agentRuntimeId: "CODEX_CLI", status: "ready_for_plan", diagnostics: [] }),
            expect.objectContaining({ agentRuntimeId: "CODEX_APP", status: "ready_for_plan", diagnostics: [] }),
        ]);
        expect(validateAdapterProbeResult(codexProvider, result, context.platformContext)).toEqual([]);
    });

    it("offers independently authorized global configuration and Skill-directory targets", async () => {
        writeMagic(path.join(bin, "codex.exe"), [0x4d, 0x5a, 0, 0]);
        const localAppData = path.join(home, "AppData", "Local");
        writeMagic(path.join(localAppData, "OpenAI", "Codex", "bin", "build-a", "codex.exe"), [0x4d, 0x5a, 0, 0]);
        const codexHome = path.join(home, ".codex");
        const skillRoot = path.join(home, ".agents", "skills");
        const compatibilitySkillRoot = path.join(codexHome, "skills");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.mkdirSync(skillRoot, { recursive: true });
        fs.mkdirSync(compatibilitySkillRoot, { recursive: true });
        const context = globalContext("win32");

        const result = await probeCodex(context, { PATH: bin, LOCALAPPDATA: localAppData }, home, "win32");

        expect(result.observation.targetCandidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    targetRootPath: codexHome,
                    targetKind: "global",
                    entryApplicabilities: [
                        expect.objectContaining({ agentRuntimeId: "CODEX_CLI", status: "ready_for_plan" }),
                        expect.objectContaining({ agentRuntimeId: "CODEX_APP", status: "ready_for_plan" }),
                    ],
                }),
                expect.objectContaining({
                    targetRootPath: skillRoot,
                    targetKind: "directory",
                    entryApplicabilities: [
                        expect.objectContaining({ agentRuntimeId: "CODEX_CLI", status: "ready_for_plan" }),
                        expect.objectContaining({
                            agentRuntimeId: "CODEX_APP",
                            status: "invalid",
                            diagnostics: [expect.objectContaining({ code: "codex_app_shared_agent_skill_target_not_loaded" })],
                        }),
                    ],
                }),
                expect.objectContaining({
                    targetRootPath: compatibilitySkillRoot,
                    targetKind: "directory",
                    entryApplicabilities: [
                        expect.objectContaining({ agentRuntimeId: "CODEX_CLI", status: "ready_for_plan" }),
                        expect.objectContaining({ agentRuntimeId: "CODEX_APP", status: "ready_for_plan" }),
                    ],
                }),
            ]),
        );
        const sharedSkillRoot = result.observation.sourceRoots.find((root) => root.path === skillRoot);
        const compatibilityRoot = result.observation.sourceRoots.find((root) => root.path === compatibilitySkillRoot);
        expect(sharedSkillRoot).toBeDefined();
        expect(compatibilityRoot).toBeDefined();
        expect(runtime(result, "CODEX_CLI")?.sourceRootIds).toEqual(
            expect.arrayContaining([sharedSkillRoot?.sourceRootId, compatibilityRoot?.sourceRootId]),
        );
        expect(runtime(result, "CODEX_APP")?.sourceRootIds).not.toContain(sharedSkillRoot?.sourceRootId);
        expect(runtime(result, "CODEX_APP")?.sourceRootIds).toContain(compatibilityRoot?.sourceRootId);
        expect(validateAdapterProbeResult(codexProvider, result, context.platformContext)).toEqual([]);
    });

    it("separates source presence and shell wrappers from installation evidence", async () => {
        fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
        fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
        fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
        const result = await probeCodex(globalContext(), { PATH: bin }, home);

        expect(result.status).toBe("partial");
        expect(runtime(result, "CODEX_CLI")).toMatchObject({ installationStatus: "unknown", installationEvidence: [] });
        expect(runtime(result, "CODEX_APP")?.installationStatus).toBe("unknown");
        expect(result.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining([
                "codex_cli_launcher_not_native",
                "codex_app_linux_root_outside_selection",
                "codex_residual_sources_without_installation",
            ]),
        );
        expect(validateAdapterProbeResult(codexProvider, result, globalContext().platformContext)).toEqual([]);
    });

    it("uses CODEX_HOME only when the observed override stays inside the selected access root", async () => {
        const selectedRoot = path.join(sandbox, "selected");
        const selectedHome = path.join(selectedRoot, "home");
        const override = path.join(selectedRoot, "codex-home");
        const foreign = path.join(sandbox, "foreign-codex-home");
        fs.mkdirSync(selectedHome, { recursive: true });
        fs.mkdirSync(override, { recursive: true });
        const context = globalContext("linux", selectedRoot);

        const accepted = await probeCodex(context, { PATH: "", CODEX_HOME: override }, selectedHome);
        expect(accepted.observation.sourceRoots).toContainEqual(
            expect.objectContaining({
                path: override,
                rootRole: "config",
                sourceDomain: "family_shared",
                locatorEvidence: [expect.objectContaining({ locatorKind: "runtime_declared_path", locatorKey: "CODEX_HOME" })],
            }),
        );
        expect(validateAdapterProbeResult(codexProvider, accepted, context.platformContext)).toEqual([]);

        const rejected = await probeCodex(context, { PATH: "", CODEX_HOME: foreign }, selectedHome);
        expect(rejected.status).toBe("partial");
        expect(rejected.observation.sourceRoots).toEqual([]);
        expect(rejected.diagnostics).toEqual([expect.objectContaining({ code: "codex_home_invalid", path: foreign })]);
    });

    it("offers the exact selected Project to CLI while requiring independent App installation evidence", async () => {
        writeMagic(path.join(bin, "codex"), [0x7f, 0x45, 0x4c, 0x46]);
        const projectRoot = path.join(sandbox, "project");
        fs.mkdirSync(projectRoot);
        const context = projectContext(projectRoot);
        const result = await probeCodex(context, { PATH: bin }, home);
        const projectSource = result.observation.sourceRoots.find((root) => root.path === projectRoot);

        expect(projectSource).toMatchObject({ rootRole: "project_actual", sourceDomain: "project_root" });
        expect(result.observation.observedProjects).toEqual([
            expect.objectContaining({
                runtimeProjectKey: projectRoot,
                workspaces: [{ sourceRootId: projectSource?.sourceRootId, role: "primary" }],
            }),
        ]);
        expect(result.observation.targetCandidates[0]?.entryApplicabilities).toEqual([
            expect.objectContaining({ agentRuntimeId: "CODEX_CLI", status: "ready_for_plan", diagnostics: [] }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                status: "unknown",
                diagnostics: [expect.objectContaining({ code: "codex_app_target_build_evidence_unavailable" })],
            }),
        ]);
        expect(runtime(result, "CODEX_CLI")?.projectDiscoveryStatus).toBe("complete");
        expect(validateAdapterProbeResult(codexProvider, result, context.platformContext)).toEqual([]);
    });

    it("keeps missing, untrusted, and incomplete CLI observations ineligible for target planning", async () => {
        const projectRoot = path.join(sandbox, "project");
        fs.mkdirSync(projectRoot);
        const context = projectContext(projectRoot);

        const missing = await probeCodex(context, { PATH: "" }, home);
        expect(missing.observation.targetCandidates[0]?.entryApplicabilities[0]).toMatchObject({
            agentRuntimeId: "CODEX_CLI",
            status: "invalid",
            diagnostics: [expect.objectContaining({ code: "codex_cli_target_installation_not_found" })],
        });

        fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
        const untrusted = await probeCodex(context, { PATH: bin }, home);
        expect(untrusted.observation.targetCandidates[0]?.entryApplicabilities[0]).toMatchObject({
            agentRuntimeId: "CODEX_CLI",
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "codex_cli_target_build_evidence_unavailable" })],
        });

        writeMagic(path.join(bin, "codex"), [0x7f, 0x45, 0x4c, 0x46]);
        fs.rmSync(projectRoot, { recursive: true });
        const incomplete = await probeCodex(context, { PATH: bin }, home);
        expect(incomplete.observation.targetCandidates[0]?.entryApplicabilities[0]).toMatchObject({
            agentRuntimeId: "CODEX_CLI",
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "codex_cli_target_project_authority_incomplete" })],
        });
        expect(validateAdapterProbeResult(codexProvider, incomplete, context.platformContext)).toEqual([]);
    });

    it("uses a complete trusted registry Project but rejects a partial registry snapshot", async () => {
        const selectedRoot = path.join(sandbox, "selected");
        const selectedHome = path.join(selectedRoot, "home");
        const selectedBin = path.join(selectedRoot, "bin");
        const codexHome = path.join(selectedHome, ".codex");
        const firstProject = path.join(selectedRoot, "a-project");
        const secondProject = path.join(selectedRoot, "z-project");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.mkdirSync(firstProject);
        fs.mkdirSync(secondProject);
        writeMagic(path.join(selectedBin, "codex"), [0x7f, 0x45, 0x4c, 0x46]);
        const context = globalContext("linux", selectedRoot);

        fs.writeFileSync(
            path.join(codexHome, "config.toml"),
            `[projects."${secondProject}"]\ntrust_level = "trusted"\n` +
                `[projects."${firstProject}"]\ntrust_level = "trusted"\n`,
        );
        const complete = await probeCodex(context, { PATH: selectedBin }, selectedHome);
        expect(
            complete.observation.targetCandidates
                .filter((candidate) => candidate.targetKind === "project")
                .map((candidate) => candidate.targetRootPath),
        ).toEqual([firstProject, secondProject]);
        expect(
            complete.observation.targetCandidates
                .filter((candidate) => candidate.targetKind === "project")
                .every((candidate) => candidate.entryApplicabilities[0]?.status === "ready_for_plan"),
        ).toBe(true);
        expect(validateAdapterProbeResult(codexProvider, complete, context.platformContext)).toEqual([]);

        fs.writeFileSync(
            path.join(codexHome, "config.toml"),
            `[projects."${firstProject}"]\ntrust_level = "trusted"\n` +
                `[projects."${path.join(sandbox, "foreign-project")}"]\ntrust_level = "trusted"\n`,
        );
        const partial = await probeCodex(context, { PATH: selectedBin }, selectedHome);
        const partialProjectTargets = partial.observation.targetCandidates.filter(
            (candidate) => candidate.targetKind === "project",
        );
        expect(partialProjectTargets).toHaveLength(1);
        expect(partialProjectTargets[0]?.entryApplicabilities[0]).toMatchObject({
            agentRuntimeId: "CODEX_CLI",
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "codex_cli_target_project_authority_incomplete" })],
        });
        expect(validateAdapterProbeResult(codexProvider, partial, context.platformContext)).toEqual([]);
    });

    it("does not let unrelated registry and Skill paths degrade an exact project probe", async () => {
        const selectedRoot = path.join(sandbox, "selected");
        const selectedHome = path.join(selectedRoot, "home");
        const projectRoot = path.join(selectedRoot, "project");
        const codexHome = path.join(selectedHome, ".codex");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.mkdirSync(projectRoot);
        fs.writeFileSync(
            path.join(codexHome, "config.toml"),
            `[projects."${path.join(sandbox, "unrelated-project")}"]\ntrust_level = "trusted"\n` +
                `[[skills.config]]\npath = "${path.join(sandbox, "unrelated-skill", "SKILL.md")}"\nenabled = false\n`,
        );

        const context = projectContext(projectRoot, "linux", selectedRoot);
        const result = await probeCodex(context, { PATH: "" }, selectedHome);
        expect(result.observation.sourceRoots.map((root) => root.path)).not.toContain(path.join(sandbox, "unrelated-project"));
        const codes = result.diagnostics.map((item) => item.code);
        expect(codes).not.toContain("codex_project_registry_path_unreachable");
        expect(codes).not.toContain("codex_skill_config_path_unreachable");
        expect(codes).not.toContain("codex_skill_disabled_in_source_config");
        expect(runtime(result, "CODEX_CLI")?.projectDiscoveryStatus).toBe("complete");
        expect(validateAdapterProbeResult(codexProvider, result, context.platformContext)).toEqual([]);
    });

    it("turns trusted config projects into bounded anchors while excluding untrusted projects and exec policy", async () => {
        const codexHome = path.join(home, ".codex");
        const trustedProject = path.join(sandbox, "trusted-project");
        const untrustedProject = path.join(sandbox, "untrusted-project");
        fs.mkdirSync(path.join(codexHome, "rules"), { recursive: true });
        fs.mkdirSync(trustedProject);
        fs.writeFileSync(
            path.join(codexHome, "config.toml"),
            `[projects."${trustedProject}"]\ntrust_level = "trusted"\n` +
                `[projects."${untrustedProject}"]\ntrust_level = "untrusted"\n`,
        );
        const result = await probeCodex(globalContext(), { PATH: "" }, home);

        expect(result.observation.agentRuntimeResources).toEqual([
            expect.objectContaining({ roles: ["project_registry"], path: path.join(codexHome, "config.toml") }),
        ]);
        const projectRoot = result.observation.sourceRoots.find((root) => root.path === trustedProject);
        expect(projectRoot).toMatchObject({
            rootRole: "project_actual",
            sourceDomain: "project_root",
            locatorEvidence: expect.arrayContaining([expect.objectContaining({ locatorKind: "project_registry_entry" })]),
        });
        expect(projectRoot?.locatorEvidence[0]?.locatorKey).not.toContain(trustedProject);
        expect(result.observation.sourceRoots.map((root) => root.path)).not.toContain(untrustedProject);
        expect(result.observation.observedProjects).toEqual([
            expect.objectContaining({
                runtimeProjectKey: trustedProject,
                workspaces: [{ sourceRootId: projectRoot?.sourceRootId, role: "primary" }],
                evidence: [
                    expect.objectContaining({
                        evidenceKind: "agent_runtime_resource",
                        agentRuntimeResourceId: result.observation.agentRuntimeResources[0]?.agentRuntimeResourceId,
                    }),
                ],
            }),
        ]);
        expect(result.observation.sourceRoots.map((root) => root.path)).not.toContain(path.join(codexHome, "rules"));
        expect(result.diagnostics.map((item) => item.code)).toContain("codex_exec_policy_excluded");
        expect(result.diagnostics.map((item) => item.code)).not.toContain("codex_project_registry_parse_deferred");
        expect(runtime(result, "CODEX_CLI")?.projectDiscoveryStatus).toBe("complete");
        expect(validateAdapterProbeResult(codexProvider, result, globalContext().platformContext)).toEqual([]);
    });

    it("does not turn Codex plugin or builtin-managed paths into ordinary project sources", async () => {
        const codexHome = path.join(home, ".codex");
        const pluginProject = path.join(codexHome, "plugins", "cache", "managed-plugin");
        const builtinProject = path.join(codexHome, "skills", ".system", "builtin-skill");
        const ordinaryProject = path.join(sandbox, "projects", "managed-plugin");
        for (const target of [pluginProject, builtinProject, ordinaryProject]) fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(
            path.join(codexHome, "config.toml"),
            [pluginProject, builtinProject, ordinaryProject]
                .map((target) => `[projects."${target}"]\ntrust_level = "trusted"\n`)
                .join(""),
        );

        const result = await probeCodex(globalContext(), { PATH: "" }, home);

        expect(result.observation.sourceRoots.map((root) => root.path)).toContain(ordinaryProject);
        expect(result.observation.sourceRoots.map((root) => root.path)).not.toContain(pluginProject);
        expect(result.observation.sourceRoots.map((root) => root.path)).not.toContain(builtinProject);
        expect(result.observation.observedProjects.map((project) => project.runtimeProjectKey)).toEqual([ordinaryProject]);
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: "codex_managed_project_path_excluded", path: pluginProject }),
                expect.objectContaining({ code: "codex_managed_project_path_excluded", path: builtinProject }),
            ]),
        );
        expect(validateAdapterProbeResult(codexProvider, result, globalContext().platformContext)).toEqual([]);
    });

    it("requires Linux execution before probing a Windows-hosted WSL Environment", async () => {
        const wslHome = "\\\\wsl.localhost\\Ubuntu\\home\\example";
        const context: AdapterProbeContext = {
            authorizationScope: "global",
            platformContext: { platform: "wsl", platformInstanceId: "wsl:Ubuntu", accessRootPath: wslHome },
        };
        const result = await probeCodex(
            context,
            { PATH: "C:\\poison", CODEX_HOME: "C:\\poison-home", LOCALAPPDATA: "C:\\poison-app" },
            "C:\\Users\\poison",
            "win32",
        );
        expect(result.status).toBe("partial");
        expect(result.observation.sourceRoots).toEqual([]);
        expect(result.diagnostics).toEqual([expect.objectContaining({ code: "codex_probe_platform_unreachable" })]);
        expect(JSON.stringify(result)).not.toContain("poison");
    });

    it("rejects an escaping CLI symlink and a foreign project path", async () => {
        const selectedRoot = path.join(sandbox, "selected");
        const selectedHome = path.join(selectedRoot, "home");
        const selectedBin = path.join(selectedRoot, "bin");
        const foreignBinary = path.join(sandbox, "foreign-codex");
        fs.mkdirSync(selectedHome, { recursive: true });
        fs.mkdirSync(selectedBin, { recursive: true });
        writeMagic(foreignBinary, [0x7f, 0x45, 0x4c, 0x46]);
        fs.symlinkSync(foreignBinary, path.join(selectedBin, "codex"));
        const context = projectContext(path.join(sandbox, "foreign-project"), "linux", selectedRoot);
        const result = await probeCodex(context, { PATH: selectedBin }, selectedHome);

        expect(runtime(result, "CODEX_CLI")?.installationStatus).toBe("unknown");
        expect(runtime(result, "CODEX_CLI")?.installationEvidence).toEqual([]);
        expect(result.observation.observedProjects).toEqual([]);
        expect(result.diagnostics.map((item) => item.code)).toContain("codex_project_root_invalid");
        expect(validateAdapterProbeResult(codexProvider, result, context.platformContext)).toEqual([]);
    });

    it("reports an authorized external source root without inventing a project or target", async () => {
        const external = path.join(sandbox, "external");
        fs.mkdirSync(external);
        const context: AdapterProbeContext = {
            authorizationScope: "directory",
            platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox },
            directoryRootPath: external,
        };
        const result = await probeCodex(context, { PATH: "" }, home);
        expect(result.observation.sourceRoots).toContainEqual(
            expect.objectContaining({ path: external, rootRole: "source", sourceDomain: "external_managed" }),
        );
        expect(result.observation.observedProjects).toEqual([]);
        expect(result.observation.targetCandidates).toEqual([]);
    });

    it("fails closed for unreachable environments, invalid external roots, missing projects, and ambiguous config", async () => {
        const unreachable = await probeCodex(globalContext("darwin"), {}, home, "linux");
        expect(unreachable).toMatchObject({
            status: "partial",
            diagnostics: [expect.objectContaining({ code: "codex_probe_platform_unreachable" })],
        });

        const invalidDirectory: AdapterProbeContext = {
            authorizationScope: "directory",
            platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox },
            directoryRootPath: path.join(os.tmpdir(), "outside-selected-root"),
        };
        const invalid = await probeCodex(invalidDirectory, { PATH: "" }, home);
        expect(invalid.diagnostics.map((item) => item.code)).toContain("codex_external_root_invalid");

        const missingProject = path.join(sandbox, "missing-project");
        const missing = await probeCodex(projectContext(missingProject), { PATH: "" }, home);
        expect(runtime(missing, "CODEX_CLI")?.projectDiscoveryStatus).toBe("partial");

        const codexHome = path.join(home, ".codex");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.symlinkSync(path.join(sandbox, "missing-config"), path.join(codexHome, "config.toml"));
        const ambiguous = await probeCodex(globalContext(), { PATH: "" }, home);
        expect(runtime(ambiguous, "CODEX_CLI")?.projectDiscoveryStatus).toBe("unknown");
    });

    it("uses default process inputs only to reject an unreachable selected platform before filesystem inspection", async () => {
        const unreachablePlatform: Platform = process.platform === "win32" ? "linux" : "win32";
        const result = await probeCodex(globalContext(unreachablePlatform));
        expect(result).toMatchObject({
            status: "partial",
            observation: { sourceRoots: [], agentRuntimeResources: [], observedProjects: [], targetCandidates: [] },
            diagnostics: [expect.objectContaining({ code: "codex_probe_platform_unreachable" })],
        });
    });

    it("accepts native Mach-O CLI magic only for a Darwin context", async () => {
        writeMagic(path.join(bin, "codex"), [0xcf, 0xfa, 0xed, 0xfe]);
        const darwin = await probeCodex(globalContext("darwin"), { PATH: bin }, home, "darwin");
        expect(runtime(darwin, "CODEX_CLI")?.installationStatus).toBe("available");

        const linux = await probeCodex(globalContext(), { PATH: bin }, home, "linux");
        expect(runtime(linux, "CODEX_CLI")?.installationStatus).toBe("unknown");
    });
});

function globalContext(platform: Platform = "linux", accessRootPath = sandbox): AdapterProbeContext {
    return { authorizationScope: "global", platformContext: { platform, platformInstanceId: "fixture", accessRootPath } };
}

function projectContext(projectRootPath: string, platform: Platform = "linux", accessRootPath = sandbox): AdapterProbeContext {
    return {
        authorizationScope: "project",
        platformContext: { platform, platformInstanceId: "fixture", accessRootPath },
        projectRootPath,
    };
}

function runtime(result: Awaited<ReturnType<typeof probeCodex>>, id: "CODEX_CLI" | "CODEX_APP") {
    return result.observation.observedAgentRuntimes.find((entry) => entry.agentRuntimeId === id);
}

function runtimeStatuses(result: Awaited<ReturnType<typeof probeCodex>>): Record<string, string> {
    return Object.fromEntries(
        result.observation.observedAgentRuntimes.map((entry) => [entry.agentRuntimeId, entry.installationStatus]),
    );
}

function writeMagic(target: string, bytes: number[]): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(bytes), { mode: 0o755 });
}
