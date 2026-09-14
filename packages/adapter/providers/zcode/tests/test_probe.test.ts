import type { AdapterProbeContext, Platform } from "@oaam/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAdapterProbeResult } from "../../../core/src/adapters/adapter-contract-validator";
import { probeZcode } from "../src/zcode-probe";
import { createZcodeProjectMemoryKey } from "../src/zcode-probe-memory-paths";
import { zcodeProvider } from "../src/zcode-provider";
import { zcodeAppAsar } from "./zcode-app-asar-fixture";
import { createProjectRegistry } from "./zcode-registry-fixtures";

let sandbox = "";
let home = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-zcode-probe-"));
    home = path.join(sandbox, "home");
    fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("ZCode probe", () => {
    it("verifies the native Windows App structure independently from source data", async () => {
        const localAppData = path.join(home, "AppData", "Local");
        const installRoot = path.join(localAppData, "Programs", "ZCode");
        writeMagic(path.join(installRoot, "ZCode.exe"), [0x4d, 0x5a, 0, 0]);
        writeFile(path.join(installRoot, "resources", "app.asar"), zcodeAppAsar("3.5.3"));
        writeFile(path.join(installRoot, "resources", "glm", "zcode.cjs"), "consumer bundle");

        const context = globalContext("win32");
        const result = await probeZcode(context, { LOCALAPPDATA: localAppData }, home, "win32");
        expect(result.status).toBe("complete");
        expect(runtime(result)).toMatchObject({
            installationStatus: "available",
            projectDiscoveryStatus: "not_found",
            versionText: "3.5.3",
        });
        expect(runtime(result)?.installationEvidence).toEqual([
            expect.objectContaining({ kind: "install_root", path: installRoot }),
            expect.objectContaining({ kind: "app_bundle", path: path.join(installRoot, "resources", "glm", "zcode.cjs") }),
        ]);
        expect(validateAdapterProbeResult(zcodeProvider, result, context.platformContext)).toEqual([]);
    });

    it("projects available global config and Skill-directory targets only after the exact App bundle is verified", async () => {
        const localAppData = path.join(home, "AppData", "Local");
        const installRoot = path.join(localAppData, "Programs", "ZCode");
        const globalConfig = path.join(home, ".zcode");
        const privateSkills = path.join(globalConfig, "skills");
        const sharedSkills = path.join(home, ".agents", "skills");
        writeMagic(path.join(installRoot, "ZCode.exe"), [0x4d, 0x5a, 0, 0]);
        writeFile(path.join(installRoot, "resources", "app.asar"), zcodeAppAsar("3.5.3"));
        writeFile(path.join(installRoot, "resources", "glm", "zcode.cjs"), "consumer bundle");
        fs.mkdirSync(privateSkills, { recursive: true });
        fs.mkdirSync(sharedSkills, { recursive: true });

        const context = globalContext("win32");
        const result = await probeZcode(context, { LOCALAPPDATA: localAppData }, home, "win32");
        expect(result.observation.targetCandidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    targetRootPath: globalConfig,
                    targetKind: "global",
                    entryApplicabilities: [expect.objectContaining({ status: "ready_for_plan" })],
                }),
                expect.objectContaining({
                    targetRootPath: privateSkills,
                    targetKind: "directory",
                    entryApplicabilities: [expect.objectContaining({ status: "ready_for_plan" })],
                }),
                expect.objectContaining({
                    targetRootPath: sharedSkills,
                    targetKind: "directory",
                    entryApplicabilities: [expect.objectContaining({ status: "ready_for_plan" })],
                }),
            ]),
        );
        expect(result.observation.targetCandidates).toHaveLength(3);
        expect(validateAdapterProbeResult(zcodeProvider, result, context.platformContext)).toEqual([]);
    });

    it("makes an authorized project target ready only after the exact Windows App bundle is verified", async () => {
        const projectRoot = path.join(sandbox, "project");
        const localAppData = path.join(home, "AppData", "Local");
        const installRoot = path.join(localAppData, "Programs", "ZCode");
        fs.mkdirSync(projectRoot, { recursive: true });
        writeMagic(path.join(installRoot, "ZCode.exe"), [0x4d, 0x5a, 0, 0]);
        writeFile(path.join(installRoot, "resources", "app.asar"), zcodeAppAsar("3.5.3"));
        writeFile(path.join(installRoot, "resources", "glm", "zcode.cjs"), "consumer bundle");

        const context = projectContext(projectRoot, "win32");
        const result = await probeZcode(context, { LOCALAPPDATA: localAppData }, home, "win32");
        const memoryRoot = path.join(
            home,
            ".zcode",
            "cli",
            "memories",
            "projects",
            createZcodeProjectMemoryKey(projectRoot, "win32") ?? "missing",
        );
        expect(runtime(result)).toMatchObject({ installationStatus: "available" });
        expect(result.observation.targetCandidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    targetRootPath: projectRoot,
                    targetKind: "project",
                    entryApplicabilities: [
                        expect.objectContaining({ agentRuntimeId: "ZCODE_APP", status: "ready_for_plan", diagnostics: [] }),
                    ],
                }),
                expect.objectContaining({
                    targetRootPath: memoryRoot,
                    targetKind: "directory",
                    displayName: expect.stringContaining("ZCode project Memory"),
                    entryApplicabilities: [
                        expect.objectContaining({ agentRuntimeId: "ZCODE_APP", status: "ready_for_plan", diagnostics: [] }),
                    ],
                }),
            ]),
        );
        expect(result.observation.targetCandidates).toHaveLength(2);
        expect(validateAdapterProbeResult(zcodeProvider, result, context.platformContext)).toEqual([]);
    });

    it("keeps target readiness unknown when a ZCode-named Windows candidate has unverified structure", async () => {
        const projectRoot = path.join(sandbox, "project");
        const localAppData = path.join(home, "AppData", "Local");
        const installRoot = path.join(localAppData, "Programs", "ZCode");
        fs.mkdirSync(projectRoot, { recursive: true });
        writeMagic(path.join(installRoot, "ZCode.exe"), [0x7f, 0x45, 0x4c, 0x46]);
        writeFile(path.join(installRoot, "resources", "app.asar"), "archive");

        const result = await probeZcode(projectContext(projectRoot, "win32"), { LOCALAPPDATA: localAppData }, home, "win32");
        expect(runtime(result)).toMatchObject({ installationStatus: "unknown" });
        expect(result.observation.targetCandidates[0]?.entryApplicabilities).toEqual([
            expect.objectContaining({
                agentRuntimeId: "ZCODE_APP",
                status: "unknown",
                diagnostics: [expect.objectContaining({ code: "zcode_target_build_evidence_unavailable" })],
            }),
        ]);
    });

    it("reports residual user sources without upgrading installation", async () => {
        fs.mkdirSync(path.join(home, ".zcode"), { recursive: true });
        const result = await probeZcode(globalContext("linux"), {}, home, "linux");
        expect(runtime(result)?.installationStatus).toBe("not_found");
        expect(result.diagnostics.map((item) => item.code)).toContain("zcode_residual_sources_without_installation");
        expect(result.observation.sourceRoots).toContainEqual(
            expect.objectContaining({ path: path.join(home, ".zcode"), sourceDomain: "agent_runtime_private" }),
        );
    });

    it("reports both default Skill roots independently even when one exists or is untrusted", async () => {
        const shared = path.join(home, ".agents", "skills");
        const preferred = path.join(home, ".zcode", "skills");
        fs.mkdirSync(shared, { recursive: true });

        const fallback = await probeZcode(globalContext("linux"), {}, home, "linux");
        expect(fallback.observation.sourceRoots).toContainEqual(
            expect.objectContaining({ path: shared, sourceDomain: "family_shared", accessStatus: "available" }),
        );

        fs.mkdirSync(preferred, { recursive: true });
        const preferredResult = await probeZcode(globalContext("linux"), {}, home, "linux");
        expect(preferredResult.observation.sourceRoots.some((root) => root.path === shared)).toBe(true);
        expect(preferredResult.observation.sourceRoots.some((root) => root.path === preferred)).toBe(true);

        fs.rmSync(preferred, { recursive: true });
        fs.symlinkSync(shared, preferred);
        const untrusted = await probeZcode(globalContext("linux"), {}, home, "linux");
        expect(untrusted.status).toBe("partial");
        expect(untrusted.observation.sourceRoots.some((root) => root.path === shared)).toBe(true);
        expect(untrusted.observation.targetCandidates.some((candidate) => candidate.targetRootPath === preferred)).toBe(false);
        expect(untrusted.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_probe_symlink_untrusted" }));
    });

    it("uses configured global Skill roots and derives global Subagents from the effective storage root", async () => {
        const storage = path.join(sandbox, "declared-storage");
        const configuredSkills = path.join(sandbox, "declared-skills");
        fs.mkdirSync(path.join(storage, "agents"), { recursive: true });
        fs.mkdirSync(configuredSkills, { recursive: true });
        writeFile(
            path.join(home, ".zcode", "cli", "config.json"),
            `${JSON.stringify({
                storage: { dir: storage },
                skills: { roots: [configuredSkills, path.join(home, ".zcode", "skills")] },
            })}\n`,
        );

        const result = await probeZcode(globalContext("linux"), {}, home, "linux");
        expect(result.observation.sourceRoots).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: configuredSkills,
                    rootRole: "source",
                    sourceDomain: "external_managed",
                    locatorEvidence: [expect.objectContaining({ locatorKey: "skills.roots" })],
                }),
                expect.objectContaining({
                    path: path.join(storage, "agents"),
                    rootRole: "source",
                    sourceDomain: "agent_runtime_private",
                    locatorEvidence: [expect.objectContaining({ locatorKey: "storage.dir" })],
                }),
            ]),
        );
        expect(result.observation.sourceRoots.some((root) => root.path === path.join(home, ".zcode", "agents"))).toBe(false);
        const defaultPrivateSkillRoots = result.observation.sourceRoots.filter(
            (root) => root.path === path.join(home, ".zcode", "skills"),
        );
        expect(defaultPrivateSkillRoots).toHaveLength(1);
        expect(defaultPrivateSkillRoots[0]?.locatorEvidence).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ locatorKind: "runtime_known_rule", locatorKey: "zcode_user_skill_root" }),
                expect.objectContaining({ locatorKind: "runtime_declared_path", locatorKey: "skills.roots" }),
            ]),
        );
    });

    it("projects every worktree Skill root and project-relative configured source under one project association", async () => {
        const repository = path.join(sandbox, "repository");
        const projectRoot = path.join(repository, "packages", "project");
        fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
        fs.mkdirSync(path.join(projectRoot, ".zcode"), { recursive: true });
        writeFile(
            path.join(projectRoot, ".zcode", "config.json"),
            `${JSON.stringify({
                storage: { dir: "runtime-storage" },
                skills: { roots: ["configured-skills", ".zcode/skills"] },
            })}\n`,
        );

        const context = projectContext(projectRoot);
        const result = await probeZcode(context, {}, home, "linux");
        for (const base of [repository, path.join(repository, "packages"), projectRoot]) {
            for (const relative of [".zcode/skills", ".agents/skills"]) {
                expect(result.observation.sourceRoots).toContainEqual(
                    expect.objectContaining({
                        path: path.join(base, ...relative.split("/")),
                        sourceDomain: "project_root",
                        locatorEvidence: expect.arrayContaining([
                            expect.objectContaining({ locatorKind: "runtime_known_rule" }),
                            expect.objectContaining({ locatorKind: "user_provided_path", locatorKey: "user_selection" }),
                        ]),
                    }),
                );
            }
        }
        expect(result.observation.sourceRoots).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: path.join(projectRoot, "configured-skills"),
                    sourceDomain: "external_managed",
                    locatorEvidence: expect.arrayContaining([
                        expect.objectContaining({ locatorKind: "runtime_declared_path", locatorKey: "skills.roots" }),
                        expect.objectContaining({ locatorKind: "user_provided_path", locatorKey: "user_selection" }),
                    ]),
                }),
                expect.objectContaining({
                    path: path.join(projectRoot, "runtime-storage", "agents"),
                    sourceDomain: "agent_runtime_private",
                    locatorEvidence: expect.arrayContaining([
                        expect.objectContaining({ locatorKind: "runtime_declared_path", locatorKey: "storage.dir" }),
                        expect.objectContaining({ locatorKind: "user_provided_path", locatorKey: "user_selection" }),
                    ]),
                }),
            ]),
        );
        const currentPrivateSkillRoots = result.observation.sourceRoots.filter(
            (root) => root.path === path.join(projectRoot, ".zcode", "skills"),
        );
        expect(currentPrivateSkillRoots).toHaveLength(1);
        expect(currentPrivateSkillRoots[0]?.locatorEvidence).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ locatorKind: "runtime_known_rule", locatorKey: "zcode_project_skill_root" }),
                expect.objectContaining({ locatorKind: "runtime_declared_path", locatorKey: "skills.roots" }),
                expect.objectContaining({ locatorKind: "user_provided_path", locatorKey: "user_selection" }),
            ]),
        );
        expect(validateAdapterProbeResult(zcodeProvider, result, context.platformContext)).toEqual([]);
    });

    it("reports relative user source declarations as unresolved until a project is observed", async () => {
        writeFile(
            path.join(home, ".zcode", "cli", "config.json"),
            `${JSON.stringify({ storage: { dir: "relative-storage" }, skills: { roots: ["relative-skills"] } })}\n`,
        );
        const result = await probeZcode(globalContext("linux"), {}, home, "linux");
        expect(result.status).toBe("partial");
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_config_project_context_required" }));
        expect(result.observation.sourceRoots.some((root) => root.path.includes("relative-storage"))).toBe(false);
        expect(result.observation.sourceRoots.some((root) => root.path.includes("relative-skills"))).toBe(false);
    });

    it("reports relative environment storage as unresolved until a project is observed", async () => {
        const result = await probeZcode(globalContext("linux"), { ZCODE_STORAGE_DIR: "relative-storage" }, home, "linux");
        expect(result.status).toBe("partial");
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_config_project_context_required" }));
        expect(result.observation.sourceRoots.some((root) => root.path.includes("relative-storage"))).toBe(false);
    });

    it("projects current workspace locations without reading task content", async () => {
        const registry = path.join(home, ".zcode", "v2", "tasks-index.sqlite");
        const project = path.join(sandbox, "registered-project");
        fs.mkdirSync(project);
        createProjectRegistry(registry, [{ workspaceKey: "workspace-1", workspacePath: project }]);
        const result = await probeZcode(globalContext("linux"), {}, home, "linux");
        expect(result.status).toBe("complete");
        expect(result.observation.agentRuntimeResources).toContainEqual(
            expect.objectContaining({ path: registry, roles: ["project_registry"], accessStatus: "available" }),
        );
        expect(runtime(result)?.projectDiscoveryStatus).toBe("complete");
        expect(result.observation.observedProjects).toEqual([
            expect.objectContaining({
                runtimeProjectKey: "workspace-1",
                workspaces: [expect.objectContaining({ role: "primary" })],
            }),
        ]);
        expect(result.observation.sourceRoots).toContainEqual(
            expect.objectContaining({
                path: path.join(
                    home,
                    ".zcode",
                    "cli",
                    "memories",
                    "projects",
                    createZcodeProjectMemoryKey(project, "linux") ?? "missing",
                ),
                rootRole: "source",
                sourceDomain: "project_keyed",
                locatorEvidence: expect.arrayContaining([expect.objectContaining({ locatorKind: "project_registry_entry" })]),
            }),
        );
        expect(JSON.stringify(result)).not.toContain("task-0");
        expect(validateAdapterProbeResult(zcodeProvider, result, globalContext("linux").platformContext)).toEqual([]);
    });

    it("records one exact authorized project and blocks target planning when the App is not installed", async () => {
        const projectRoot = path.join(sandbox, "project");
        fs.mkdirSync(projectRoot);
        const context = projectContext(projectRoot);
        const result = await probeZcode(context, {}, home);
        const projectSource = result.observation.sourceRoots.find((root) => root.path === projectRoot);
        const memorySource = result.observation.sourceRoots.find(
            (root) => root.sourceDomain === "project_keyed" && root.rootRole === "source",
        );
        expect(projectSource).toMatchObject({ rootRole: "project_actual", sourceDomain: "project_root" });
        expect(memorySource).toMatchObject({
            path: path.join(
                home,
                ".zcode",
                "cli",
                "memories",
                "projects",
                createZcodeProjectMemoryKey(projectRoot, "linux") ?? "missing",
            ),
            accessStatus: "not_found",
            locatorEvidence: expect.arrayContaining([
                expect.objectContaining({ locatorKind: "user_provided_path", locatorKey: "user_selection" }),
            ]),
        });
        expect(result.observation.observedProjects).toEqual([
            expect.objectContaining({
                runtimeProjectKey: projectRoot,
                workspaces: [{ sourceRootId: projectSource?.sourceRootId, role: "primary" }],
            }),
        ]);
        expect(result.observation.targetCandidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    targetRootPath: projectRoot,
                    entryApplicabilities: [
                        expect.objectContaining({
                            agentRuntimeId: "ZCODE_APP",
                            status: "invalid",
                            diagnostics: [expect.objectContaining({ code: "zcode_target_installation_not_found" })],
                        }),
                    ],
                }),
                expect.objectContaining({
                    targetRootPath: memorySource?.path,
                    targetKind: "directory",
                    entryApplicabilities: [
                        expect.objectContaining({
                            agentRuntimeId: "ZCODE_APP",
                            status: "invalid",
                            diagnostics: [expect.objectContaining({ code: "zcode_target_installation_not_found" })],
                        }),
                    ],
                }),
            ]),
        );
        expect(result.observation.targetCandidates).toHaveLength(2);
        expect(runtime(result)?.projectDiscoveryStatus).toBe("complete");
        expect(validateAdapterProbeResult(zcodeProvider, result, context.platformContext)).toEqual([]);
    });

    it("reports an authorized external root without inventing a project", async () => {
        const external = path.join(sandbox, "external");
        fs.mkdirSync(external);
        const context: AdapterProbeContext = {
            authorizationScope: "directory",
            platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: "/" },
            directoryRootPath: external,
        };
        const result = await probeZcode(context, {}, home);
        expect(result.observation.sourceRoots).toContainEqual(
            expect.objectContaining({ path: external, rootRole: "source", sourceDomain: "external_managed" }),
        );
        expect(result.observation.observedProjects).toEqual([]);
        expect(result.observation.targetCandidates).toEqual([]);
    });

    it("accepts only an in-root ZCODE_DATA_BASE_DIR override", async () => {
        const selectedRoot = path.join(sandbox, "selected");
        const selectedHome = path.join(selectedRoot, "home");
        const dataBase = path.join(selectedRoot, "data");
        fs.mkdirSync(selectedHome, { recursive: true });
        const context = globalContext("linux", selectedRoot);
        const accepted = await probeZcode(context, { ZCODE_DATA_BASE_DIR: dataBase }, selectedHome);
        expect(accepted.observation.agentRuntimeResources).toContainEqual(
            expect.objectContaining({
                path: path.join(dataBase, ".zcode", "v2", "tasks-index.sqlite"),
                locatorEvidence: [
                    expect.objectContaining({
                        locatorKind: "runtime_declared_path",
                        locatorKey: "ZCODE_DATA_BASE_DIR:tasks-index.sqlite",
                    }),
                ],
            }),
        );

        const rejected = await probeZcode(context, { ZCODE_DATA_BASE_DIR: path.join(sandbox, "foreign") }, selectedHome);
        expect(rejected).toMatchObject({
            status: "partial",
            diagnostics: [expect.objectContaining({ code: "zcode_data_base_override_invalid" })],
        });
    });

    it("rejects foreign project and external paths", async () => {
        const selectedRoot = path.join(sandbox, "selected");
        const selectedHome = path.join(selectedRoot, "home");
        fs.mkdirSync(selectedHome, { recursive: true });
        const foreign = path.join(sandbox, "foreign");
        const invalidProject = await probeZcode(projectContext(foreign, "linux", selectedRoot), {}, selectedHome);
        expect(invalidProject.diagnostics.map((item) => item.code)).toContain("zcode_project_root_invalid");
        expect(invalidProject.observation.observedProjects).toEqual([]);

        const invalidDirectory: AdapterProbeContext = {
            authorizationScope: "directory",
            platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: selectedRoot },
            directoryRootPath: foreign,
        };
        const result = await probeZcode(invalidDirectory, {}, selectedHome);
        expect(result.diagnostics.map((item) => item.code)).toContain("zcode_external_root_invalid");

        const missingProject = path.join(selectedRoot, "missing-project");
        const missing = await probeZcode(projectContext(missingProject, "linux", selectedRoot), {}, selectedHome);
        expect(runtime(missing)?.projectDiscoveryStatus).toBe("partial");
    });

    it("requires Linux execution before probing a Windows-hosted WSL Environment", async () => {
        const wslHome = "\\\\wsl.localhost\\Ubuntu\\home\\example";
        const context: AdapterProbeContext = {
            authorizationScope: "global",
            platformContext: { platform: "wsl", platformInstanceId: "wsl:Ubuntu", accessRootPath: wslHome },
        };
        const result = await probeZcode(
            context,
            { ZCODE_DATA_BASE_DIR: "C:\\poison", LOCALAPPDATA: "C:\\poison" },
            "C:\\Users\\poison",
            "win32",
        );
        expect(result.status).toBe("partial");
        expect(result.observation.sourceRoots).toEqual([]);
        expect(result.diagnostics).toEqual([expect.objectContaining({ code: "zcode_probe_platform_unreachable" })]);
        expect(JSON.stringify(result)).not.toContain("poison");
    });

    it("fails closed for an unreachable selected platform", async () => {
        const platform: Platform = process.platform === "win32" ? "linux" : "win32";
        const result = await probeZcode(globalContext(platform));
        expect(result).toMatchObject({
            status: "partial",
            observation: { sourceRoots: [], agentRuntimeResources: [], observedProjects: [], targetCandidates: [] },
            diagnostics: [expect.objectContaining({ code: "zcode_probe_platform_unreachable" })],
        });
    });
});

function globalContext(platform: Platform = "linux", accessRootPath = "/"): AdapterProbeContext {
    return {
        authorizationScope: "global",
        platformContext: { platform, platformInstanceId: "fixture", accessRootPath },
    };
}

function projectContext(projectRootPath: string, platform: Platform = "linux", accessRootPath = "/"): AdapterProbeContext {
    return {
        authorizationScope: "project",
        platformContext: { platform, platformInstanceId: "fixture", accessRootPath },
        projectRootPath,
    };
}

function runtime(result: Awaited<ReturnType<typeof probeZcode>>) {
    return result.observation.observedAgentRuntimes[0];
}

function writeMagic(target: string, bytes: number[]): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(bytes), { mode: 0o755 });
}

function writeFile(target: string, content: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}
