import type { AgentRuntimeId } from "@oaam/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    fixtureDirectoryProbeContext as directoryContext,
    fixtureGlobalProbeContext as globalContext,
    fixtureProjectProbeContext as projectContext,
} from "../../../test-support";
import { parseSummariesProjects, probeAntigravity } from "../src/antigravity-probe";
import {
    findAntigravityAppInstallation,
    findAntigravityCliInstallation,
    findAntigravityIdeInstallation,
} from "../src/antigravity-probe-installation";
import { materializeAntigravityProjects } from "../src/antigravity-probe-projects";
import { antigravityProvider } from "../src/antigravity-provider";
import { antigravityAppAsar } from "./antigravity-app-asar-fixture";

let sandbox = "";
let home = "";
let bin = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-antigravity-provider-"));
    home = path.join(sandbox, "home");
    bin = path.join(sandbox, "bin");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Antigravity probe", () => {
    it("routes an unreachable foreign platform through the frozen Provider probe facade", async () => {
        const foreignPlatform = process.platform === "win32" ? "linux" : "win32";
        await expect(antigravityProvider.probe(globalContext(foreignPlatform))).resolves.toMatchObject({
            status: "partial",
            diagnostics: [expect.objectContaining({ code: "antigravity_probe_platform_unreachable" })],
        });
    });

    it("recognizes complete native CLI/App/IDE installation fixtures", async () => {
        writeNative(path.join(bin, "agy"));
        const app = path.join(home, "Antigravity-x64");
        writeNative(path.join(app, "antigravity"));
        writeFile(path.join(app, "resources", "app.asar"), antigravityAppAsar("1.2.4"));
        writeFile(path.join(app, "resources", "app-update.yml"), "version: 1");
        writeNative(path.join(app, "resources", "bin", "language_server"));
        const ide = path.join(home, "Antigravity IDE");
        writeNative(path.join(ide, "antigravity-ide"));
        writeFile(
            path.join(ide, "resources", "app", "product.json"),
            JSON.stringify({
                applicationName: "antigravity-ide",
                version: "1.2.3",
            }),
        );
        writeFile(path.join(ide, "resources", "app", "out", "cli.js"), "");
        writeFile(path.join(ide, "resources", "app", "package.json"), "{}");
        const result = await probeAntigravity(globalContext(), { PATH: bin }, home);
        expect(runtimeStatuses(result)).toEqual({
            ANTIGRAVITY_CLI: "available",
            ANTIGRAVITY_APP: "available",
            ANTIGRAVITY_IDE: "available",
        });
        expect(
            result.observation.observedAgentRuntimes.find((entry) => entry.agentRuntimeId === "ANTIGRAVITY_APP")?.versionText,
        ).toBe("1.2.4");
        expect(
            result.observation.observedAgentRuntimes.find((entry) => entry.agentRuntimeId === "ANTIGRAVITY_IDE")?.versionText,
        ).toBe("1.2.3");
    });

    it("keeps a structurally complete App installation partial when its bounded ASAR identity is invalid", async () => {
        const app = path.join(home, "Antigravity-x64");
        const appAsar = path.join(app, "resources", "app.asar");
        writeNative(path.join(app, "antigravity"));
        writeFile(path.join(app, "resources", "app-update.yml"), "version: 1");
        writeNative(path.join(app, "resources", "bin", "language_server"));

        const invalidArchives = [
            Uint8Array.of(0),
            antigravityAppAsar("not-a-version"),
            antigravityAppAsar("2.2.1", { name: "another-product" }),
            antigravityAppAsar("2.2.1", {}, { size: 0 }),
            antigravityAppAsar("2.2.1", {}, { offset: "9999999999999999" }),
            (() => {
                const bytes = Buffer.from(antigravityAppAsar("2.2.1"));
                bytes.writeUInt32LE(5, 0);
                return bytes;
            })(),
        ];
        for (const archive of invalidArchives) {
            writeFile(appAsar, archive);
            expect(await findAntigravityAppInstallation({}, home, globalContext().platformContext)).toMatchObject({
                status: "available",
                versionText: "",
                diagnostics: [expect.objectContaining({ code: "antigravity_app_version_metadata_unavailable" })],
            });
        }

        fs.chmodSync(appAsar, 0o000);
        try {
            expect(await findAntigravityAppInstallation({}, home, globalContext().platformContext)).toMatchObject({
                status: "available",
                versionText: "",
                diagnostics: [expect.objectContaining({ code: "antigravity_app_version_metadata_unavailable" })],
            });
        } finally {
            fs.chmodSync(appAsar, 0o600);
        }
    });

    it("does not classify executable shell wrappers as an installation", async () => {
        writeFile(path.join(bin, "agy"), "#!/bin/sh\nexit 0\n", 0o755);
        const result = await probeAntigravity(globalContext(), { PATH: bin }, home);
        expect(
            result.observation.observedAgentRuntimes.find((entry) => entry.agentRuntimeId === "ANTIGRAVITY_CLI")
                ?.installationStatus,
        ).toBe("not_found");
        expect(
            result.observation.observedAgentRuntimes.find((entry) => entry.agentRuntimeId === "ANTIGRAVITY_CLI")
                ?.installationEvidence,
        ).toContainEqual(
            expect.objectContaining({
                kind: "executable",
                path: path.join(bin, "agy"),
                evidenceLevel: "local_artifact",
            }),
        );
    });

    it("reports residual data separately while retaining the CLI project-index resource", async () => {
        fs.mkdirSync(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
        writeFile(path.join(home, ".gemini", "antigravity-cli", "conversation_summaries.db"), "SQLite format 3\0");
        const result = await probeAntigravity(globalContext(), { PATH: "" }, home);
        const cli = result.observation.observedAgentRuntimes.find((entry) => entry.agentRuntimeId === "ANTIGRAVITY_CLI");
        expect(result.status).toBe("partial");
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "antigravity_project_registry_partially_observed",
                causeKind: "partial",
                severity: "warning",
            }),
        );
        expect(cli?.installationStatus).toBe("not_found");
        expect(cli?.projectDiscoveryStatus).toBe("partial");
        expect(cli?.diagnostics.map((item) => item.code)).toContain("antigravity_cli_residual_data");
        expect(result.observation.agentRuntimeResources).toContainEqual(
            expect.objectContaining({
                path: path.join(home, ".gemini", "antigravity-cli", "conversation_summaries.db"),
                roles: ["project_registry"],
                accessStatus: "available",
            }),
        );
    });

    it("discovers project registries without promoting permission-only trusted workspaces", async () => {
        const projectA = path.join(sandbox, "project-a");
        const projectB = path.join(sandbox, "project-b");
        const projectC = path.join(sandbox, "project-c");
        for (const project of [projectA, projectB, projectC]) fs.mkdirSync(project, { recursive: true });
        writeFile(
            path.join(home, ".gemini", "config", "projects", "a.json"),
            JSON.stringify({
                id: "shared-a",
                name: "Shared A",
                projectResources: { resources: [{ gitFolder: { folderUri: pathToFileUri(projectA) } }] },
            }),
        );
        writeFile(
            path.join(home, ".gemini", "antigravity-cli", "settings.json"),
            JSON.stringify({
                trustedWorkspaces: [projectB],
            }),
        );
        writeFile(
            path.join(home, ".gemini", "antigravity", "agyhub_summaries_proto.pb"),
            Buffer.from(projectProto("pb-c", projectC)),
        );
        const result = await probeAntigravity(globalContext(), { PATH: "" }, home);
        const appSkillRoot = result.observation.sourceRoots.find(
            (root) => root.path === path.join(home, ".gemini", "antigravity", "skills"),
        );
        expect(appSkillRoot).toBeDefined();
        expect(
            result.observation.observedAgentRuntimes.find((entry) => entry.agentRuntimeId === "ANTIGRAVITY_APP")?.sourceRootIds,
        ).toContain(appSkillRoot?.sourceRootId);
        expect(
            result.observation.observedAgentRuntimes.find((entry) => entry.agentRuntimeId === "ANTIGRAVITY_IDE")?.sourceRootIds,
        ).not.toContain(appSkillRoot?.sourceRootId);
        const projectKeys = result.observation.observedProjects.map((project) => project.runtimeProjectKey);
        expect(projectKeys).toHaveLength(2);
        expect(projectKeys).toEqual(expect.arrayContaining(["pb-c", "shared-a"]));
        expect(result.observation.sourceRoots.map((root) => root.path)).toEqual(expect.arrayContaining([projectA, projectC]));
        expect(result.observation.sourceRoots.map((root) => root.path)).not.toContain(projectB);
        expect(runtimeProjectKeys(result, "ANTIGRAVITY_CLI")).toEqual(["shared-a"]);
        expect(runtimeProjectKeys(result, "ANTIGRAVITY_CLI")).not.toContain("pb-c");
        expect(runtimeProjectKeys(result, "ANTIGRAVITY_APP")).toEqual(expect.arrayContaining(["shared-a", "pb-c"]));
        expect(runtimeProjectKeys(result, "ANTIGRAVITY_IDE")).toEqual(["shared-a"]);
    });

    it("completes an observed shared registry when optional indexes are physically absent", async () => {
        const project = path.join(sandbox, "shared-only");
        fs.mkdirSync(project);
        writeFile(
            path.join(home, ".gemini", "config", "projects", "shared.json"),
            JSON.stringify({
                id: "shared-only",
                projectResources: { resources: [{ gitFolder: { folderUri: pathToFileUri(project) } }] },
            }),
        );
        const result = await probeAntigravity(globalContext(), { PATH: "" }, home);
        expect(result.observation.observedAgentRuntimes.map((entry) => entry.projectDiscoveryStatus)).toEqual([
            "complete",
            "complete",
            "complete",
        ]);
        expect(runtimeProjectKeys(result, "ANTIGRAVITY_CLI")).toEqual(["shared-only"]);
        const optional = result.observation.agentRuntimeResources.filter(
            (resource) => resource.roles.includes("project_registry") && !resource.path.endsWith(path.join("config", "projects")),
        );
        expect(optional.map((resource) => path.relative(home, resource.path)).sort()).toEqual(
            [
                path.join(".gemini", "antigravity-cli", "conversation_summaries.db"),
                path.join(".gemini", "antigravity-cli", "settings.json"),
                path.join(".gemini", "antigravity", "agyhub_summaries_proto.pb"),
                path.join(".gemini", "antigravity-ide", "agyhub_summaries_proto.pb"),
            ].sort(),
        );
        for (const resource of optional) {
            expect(resource.accessStatus).toBe("not_found");
            expect(fs.existsSync(resource.path)).toBe(false);
        }
        expect(result.diagnostics.map((item) => item.code)).not.toContain("antigravity_project_registry_partially_observed");
    });

    it("reports project discovery not found when no project index exists on disk", async () => {
        const result = await probeAntigravity(globalContext(), { PATH: "" }, home);
        expect(result.observation.observedAgentRuntimes.map((entry) => entry.projectDiscoveryStatus)).toEqual([
            "not_found",
            "not_found",
            "not_found",
        ]);
        expect(result.observation.observedProjects).toEqual([]);
    });

    it("binds only the exact user-authorized Project without borrowing another observed Project", async () => {
        const appOnlyRoot = path.join(sandbox, "app-only");
        const invocationRoot = path.join(sandbox, "invocation-only");
        fs.mkdirSync(appOnlyRoot);
        fs.mkdirSync(invocationRoot);
        writeNative(path.join(bin, "agy"));
        writeFile(path.join(home, ".gemini", "antigravity", "agyhub_summaries_proto.pb"), projectProto("app-only", appOnlyRoot));

        const appOnly = await probeAntigravity(projectContext(appOnlyRoot), { PATH: bin }, home);
        expect(
            appOnly.observation.targetCandidates
                .find((item) => item.targetRootPath === appOnlyRoot)
                ?.entryApplicabilities.find((item) => item.agentRuntimeId === "ANTIGRAVITY_CLI"),
        ).toMatchObject({
            status: "ready_for_plan",
            diagnostics: [],
        });

        const invocationOnly = await probeAntigravity(projectContext(invocationRoot), { PATH: bin }, home);
        expect(invocationOnly.observation.targetCandidates.some((item) => item.targetRootPath === appOnlyRoot)).toBe(false);
        expect(
            invocationOnly.observation.targetCandidates
                .find((item) => item.targetRootPath === invocationRoot)
                ?.entryApplicabilities.find((item) => item.agentRuntimeId === "ANTIGRAVITY_CLI"),
        ).toMatchObject({
            status: "ready_for_plan",
            diagnostics: [],
        });
    });

    it("parses protobuf project records and rejects malformed wire data", () => {
        expect(parseSummariesProjects(projectProto("project-id", path.join(sandbox, "project")))).toEqual([
            {
                projectId: "project-id",
                workspacePath: path.join(sandbox, "project"),
            },
        ]);
        expect(
            parseSummariesProjects(
                concat(
                    projectProto("project-z", path.join(sandbox, "project-z")),
                    projectProto("project-a", path.join(sandbox, "project-a")),
                ),
            ),
        ).toEqual([
            { projectId: "project-a", workspacePath: path.join(sandbox, "project-a") },
            { projectId: "project-z", workspacePath: path.join(sandbox, "project-z") },
        ]);
        expect(
            parseSummariesProjects(projectProto("child-project", path.join(sandbox, "child-project"), "parent-conversation")),
        ).toEqual([]);
        expect(() => parseSummariesProjects(new Uint8Array([0x0f]))).toThrow(/wire type/);
        expect(() => parseSummariesProjects(new Uint8Array([0x0a, 0x80]))).toThrow(/varint/);
    });

    it("uses an authorized project root without requiring historical registry data", async () => {
        const project = path.join(sandbox, "authorized-project");
        fs.mkdirSync(project);
        const result = await probeAntigravity(
            projectContext(project),
            {
                PATH: "",
                ANTIGRAVITY_PROJECT_ID: "active-project",
            },
            home,
        );
        expect(result.observation.observedProjects).toEqual([
            expect.objectContaining({ runtimeProjectKey: "active-project", displayName: "authorized-project" }),
        ]);
        expect(result.observation.observedAgentRuntimes.map((entry) => entry.agentRuntimeId).sort()).toEqual(
            ["ANTIGRAVITY_APP", "ANTIGRAVITY_CLI", "ANTIGRAVITY_IDE"].sort(),
        );
        expect(result.observation.observedAgentRuntimes.every((entry) => entry.projectDiscoveryStatus === "complete")).toBe(true);
    });

    it("adds only the user-authorized external directory and never scans private brain roots", async () => {
        const external = path.join(sandbox, "external");
        fs.mkdirSync(external);
        fs.mkdirSync(path.join(home, ".gemini", "antigravity", "brain", "conversation"), { recursive: true });
        const result = await probeAntigravity(directoryContext(external), { PATH: "" }, home);
        expect(
            result.observation.sourceRoots.some((root) => root.path === external && root.sourceDomain === "external_managed"),
        ).toBe(true);
        expect(result.observation.sourceRoots.some((root) => root.path.includes(`${path.sep}brain${path.sep}`))).toBe(false);
    });

    it("fails safely for invalid roots and returns partial for unreachable platforms", async () => {
        const invalid = await probeAntigravity(directoryContext("relative"), { PATH: "" }, home);
        expect(invalid.status).toBe("failed");
        expect(invalid.diagnostics.map((item) => item.code)).toContain("antigravity_external_root_invalid");
        const unreachable = await probeAntigravity(
            {
                authorizationScope: "global",
                platformContext: { platform: "darwin", platformInstanceId: "remote", accessRootPath: "/" },
            },
            { PATH: "" },
            home,
        );
        expect(unreachable.status).toBe("partial");
        expect(unreachable.observation.observedAgentRuntimes.map((entry) => entry.agentRuntimeId).sort()).toEqual(
            ["ANTIGRAVITY_APP", "ANTIGRAVITY_CLI", "ANTIGRAVITY_IDE"].sort(),
        );
        expect(unreachable.observation.observedAgentRuntimes.every((entry) => entry.installationStatus === "unknown")).toBe(true);
    });

    it("rejects a relative home/project root and accepts the locally inspectable WSL platform", async () => {
        const invalidHome = await probeAntigravity(globalContext(), { PATH: "" }, "relative-home");
        expect(invalidHome.status).toBe("failed");
        expect(invalidHome.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "antigravity_home_root_invalid",
            }),
        );

        const invalidProject = await probeAntigravity(projectContext("relative-project"), { PATH: "" }, home);
        expect(invalidProject.status).toBe("failed");
        expect(invalidProject.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "antigravity_project_root_invalid",
            }),
        );

        const wsl = await probeAntigravity(globalContext("wsl"), { PATH: "" }, home);
        expect(wsl.observation.observedAgentRuntimes.map((entry) => entry.agentRuntimeId).sort()).toEqual(
            ["ANTIGRAVITY_APP", "ANTIGRAVITY_CLI", "ANTIGRAVITY_IDE"].sort(),
        );
        expect(wsl.observation.observedAgentRuntimes.every((entry) => entry.installationStatus === "not_found")).toBe(true);
        expect(wsl.observation.observedAgentRuntimes.every((entry) => entry.installationEvidence.length > 0)).toBe(true);
    });

    it("requires Linux execution before probing a Windows-hosted WSL Environment", async () => {
        const wslHome = "\\\\wsl.localhost\\Ubuntu\\home\\example";
        const result = await probeAntigravity(
            {
                authorizationScope: "global",
                platformContext: { platform: "wsl", platformInstanceId: "wsl:Ubuntu", accessRootPath: wslHome },
            },
            { PATH: "C:\\poison-bin", ANTIGRAVITY_CONFIG_DIR: "C:\\poison-config" },
            "C:\\Users\\poison",
            "win32",
        );
        expect(result.status).toBe("partial");
        expect(result.observation.sourceRoots).toEqual([]);
        expect(result.diagnostics).toEqual([expect.objectContaining({ code: "antigravity_probe_platform_unreachable" })]);
        expect(JSON.stringify(result)).not.toContain("poison");
    });

    it("maps runtime-native registry workspaces into the selected WSL UNC root and rejects foreign paths", () => {
        const context = {
            platform: "wsl",
            platformInstanceId: "wsl:Ubuntu",
            accessRootPath: "\\\\wsl.localhost\\Ubuntu\\",
        } as const;
        const sourceRoots = new Map();
        const mapped = materializeAntigravityProjects(
            [
                {
                    runtimeProjectKey: "runtime-project",
                    displayName: "project",
                    agentRuntimeIds: ["ANTIGRAVITY_CLI"],
                    workspaces: [{ path: "/work/project", role: "primary" }],
                    evidence: [
                        {
                            evidenceKind: "registry_record",
                            locatorKey: "fixture",
                            evidenceLevel: "local_artifact",
                        },
                    ],
                    diagnostics: [],
                },
            ],
            sourceRoots,
            context,
        );
        expect(mapped.observedProjects[0]?.workspaces).toEqual([expect.objectContaining({ role: "primary" })]);
        expect([...sourceRoots.values()][0]?.path).toBe("\\\\wsl.localhost\\Ubuntu\\work\\project");

        const alreadyPhysical = materializeAntigravityProjects(
            [
                {
                    runtimeProjectKey: "physical-project",
                    displayName: "physical",
                    agentRuntimeIds: ["ANTIGRAVITY_CLI"],
                    workspaces: [{ path: "\\\\wsl.localhost\\Ubuntu\\work\\physical", role: "primary" }],
                    evidence: [],
                    diagnostics: [],
                },
            ],
            sourceRoots,
            context,
        );
        expect(alreadyPhysical.observedProjects).toHaveLength(1);
        expect([...sourceRoots.values()].map((root) => root.path)).toContain("\\\\wsl.localhost\\Ubuntu\\work\\physical");

        const local = materializeAntigravityProjects(
            [
                {
                    runtimeProjectKey: "local-project",
                    displayName: "local",
                    agentRuntimeIds: ["ANTIGRAVITY_CLI"],
                    workspaces: [{ path: "/work/local", role: "primary" }],
                    evidence: [],
                    diagnostics: [],
                },
            ],
            new Map(),
            { platform: "linux", platformInstanceId: "local", accessRootPath: "/" },
        );
        expect(local.observedProjects).toHaveLength(1);

        const windowsCrossGrammar = materializeAntigravityProjects(
            [
                {
                    runtimeProjectKey: "cross-grammar",
                    displayName: "cross-grammar",
                    agentRuntimeIds: ["ANTIGRAVITY_CLI"],
                    workspaces: [{ path: "/work/linux-only", role: "primary" }],
                    evidence: [],
                    diagnostics: [],
                },
            ],
            new Map(),
            { platform: "win32", platformInstanceId: "win32:local", accessRootPath: "C:\\Users\\agent" },
        );
        expect(windowsCrossGrammar.observedProjects).toEqual([]);

        const rejected = materializeAntigravityProjects(
            [
                {
                    runtimeProjectKey: "foreign",
                    displayName: "foreign",
                    agentRuntimeIds: ["ANTIGRAVITY_CLI"],
                    workspaces: [{ path: "C:\\outside", role: "primary" }],
                    evidence: [],
                    diagnostics: [],
                },
            ],
            new Map(),
            context,
        );
        expect(rejected.observedProjects).toEqual([]);
        expect(rejected.diagnostics).toContainEqual(
            expect.objectContaining({ code: "antigravity_project_workspace_unreachable", path: "C:\\outside" }),
        );

        const foreignDistro = materializeAntigravityProjects(
            [
                {
                    runtimeProjectKey: "foreign-distro",
                    displayName: "foreign-distro",
                    agentRuntimeIds: ["ANTIGRAVITY_CLI"],
                    workspaces: [{ path: "\\\\wsl.localhost\\Debian\\work", role: "primary" }],
                    evidence: [],
                    diagnostics: [],
                },
            ],
            new Map(),
            context,
        );
        expect(foreignDistro.observedProjects).toEqual([]);
    });

    it("returns typed unknown installation results for non-canonical homes", async () => {
        const linuxContext = { platform: "linux", platformInstanceId: "local", accessRootPath: "/" } as const;
        const win32Context = { platform: "win32", platformInstanceId: "local", accessRootPath: "C:\\" } as const;
        expect(await findAntigravityAppInstallation({}, "relative", linuxContext)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_app_home_path_invalid" })],
        });
        expect(await findAntigravityIdeInstallation({}, "relative", linuxContext)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_ide_home_path_invalid" })],
        });
        expect(findAntigravityCliInstallation({ PATH: "relative" }, home, linuxContext)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_cli_executable_discovery_incomplete" })],
        });
        const crossGrammar = findAntigravityCliInstallation({ PATH: "C:\\foreign-bin" }, home, linuxContext);
        expect(crossGrammar.status).toBe("unknown");
        expect(crossGrammar.evidence.every((item) => !item.path.startsWith("C:\\"))).toBe(true);
        const selectedRoot = path.join(sandbox, "selected-install-root");
        const selectedHome = path.join(selectedRoot, "home");
        const foreignBin = path.join(sandbox, "foreign-bin");
        fs.mkdirSync(selectedHome, { recursive: true });
        writeNative(path.join(foreignBin, "agy"));
        const narrowContext = { platform: "linux", platformInstanceId: "selected", accessRootPath: selectedRoot } as const;
        const sameGrammarOutsideRoot = findAntigravityCliInstallation({ PATH: foreignBin }, selectedHome, narrowContext);
        expect(sameGrammarOutsideRoot.status).toBe("unknown");
        expect(sameGrammarOutsideRoot.evidence).toEqual([]);

        const selectedBin = path.join(selectedRoot, "bin");
        fs.mkdirSync(selectedBin);
        fs.symlinkSync(path.join(foreignBin, "agy"), path.join(selectedBin, "agy"));
        const symlinkEscapesRoot = findAntigravityCliInstallation({ PATH: selectedBin }, selectedHome, narrowContext);
        expect(symlinkEscapesRoot.status).toBe("unknown");
        expect(symlinkEscapesRoot.evidence).toEqual([]);

        const incompleteApp = await findAntigravityAppInstallation({ PATH: foreignBin }, selectedHome, narrowContext);
        expect(incompleteApp.status).toBe("unknown");
        expect(incompleteApp.diagnostics).toContainEqual(
            expect.objectContaining({ code: "antigravity_app_install_discovery_incomplete" }),
        );
        expect(await findAntigravityAppInstallation({}, "C:\\Users\\tester", win32Context)).toMatchObject({
            status: "not_found",
            diagnostics: [expect.objectContaining({ code: "antigravity_app_install_not_found" })],
        });
        expect(await findAntigravityIdeInstallation({}, "C:\\Users\\tester", win32Context)).toMatchObject({
            status: "not_found",
            diagnostics: [expect.objectContaining({ code: "antigravity_ide_install_not_found" })],
        });
    });

    it("rejects symlinked discovery roots/resources and reports wrong filesystem kinds", async () => {
        const actualFamily = path.join(sandbox, "actual-family");
        fs.mkdirSync(actualFamily);
        fs.symlinkSync(actualFamily, path.join(home, ".gemini"), "dir");
        const symlinked = await probeAntigravity(globalContext(), { PATH: "" }, home);
        expect(symlinked.observation.sourceRoots.find((root) => root.path === path.join(home, ".gemini"))).toMatchObject({
            accessStatus: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_probe_symlink_rejected" })],
        });

        fs.rmSync(path.join(home, ".gemini"));
        writeFile(path.join(home, ".gemini", "config", "projects"), "not a directory");
        fs.mkdirSync(path.join(home, ".gemini", "antigravity"), { recursive: true });
        fs.mkdirSync(path.join(home, ".gemini", "antigravity", "agyhub_summaries_proto.pb"));
        const wrongKinds = await probeAntigravity(globalContext(), { PATH: "" }, home);
        expect(wrongKinds.observation.agentRuntimeResources).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: path.join(home, ".gemini", "config", "projects"),
                    accessStatus: "unknown",
                    diagnostics: [expect.objectContaining({ code: "antigravity_probe_path_kind_invalid" })],
                }),
                expect.objectContaining({
                    path: path.join(home, ".gemini", "antigravity", "agyhub_summaries_proto.pb"),
                    accessStatus: "unknown",
                }),
            ]),
        );
    });

    it("bounds and validates shared project JSON and CLI trusted workspaces", async () => {
        const project = path.join(sandbox, "direct-project");
        fs.mkdirSync(project);
        const registry = path.join(home, ".gemini", "config", "projects");
        writeFile(
            path.join(registry, "valid.json"),
            JSON.stringify({
                id: "direct",
                projectResources: {
                    resources: [
                        { folderUri: pathToFileUri(project) },
                        { gitFolder: { folderUri: pathToFileUri(project) } },
                        null,
                        { folderUri: "file://%" },
                        { folderUri: "relative" },
                    ],
                },
            }),
        );
        writeFile(path.join(registry, "missing.json"), JSON.stringify({ name: "missing" }));
        writeFile(path.join(registry, "malformed.json"), "{");
        writeFile(path.join(registry, "oversized.json"), "x".repeat(2 * 1024 * 1024 + 1));
        writeFile(
            path.join(home, ".gemini", "antigravity-cli", "settings.json"),
            JSON.stringify({
                trustedWorkspaces: [project, path.join(project, "nested"), "relative", 42],
            }),
        );
        const result = await probeAntigravity(globalContext(), { PATH: "" }, home);
        expect(result.observation.observedProjects.map((item) => item.runtimeProjectKey)).toEqual(["direct"]);
        expect(result.observation.observedProjects).toHaveLength(1);
        expect(result.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining(["antigravity_project_registry_entry_incomplete", "antigravity_json_source_invalid"]),
        );
    });

    it("fails closed when the project registry exceeds its bounded entry count", async () => {
        const registry = path.join(home, ".gemini", "config", "projects");
        fs.mkdirSync(registry, { recursive: true });
        for (let index = 0; index < 4097; index += 1) {
            fs.writeFileSync(path.join(registry, `${index}.json`), "{}");
        }
        const result = await probeAntigravity(globalContext(), { PATH: "" }, home);
        expect(result.status).toBe("failed");
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "antigravity_project_registry_too_large",
            }),
        );
    });

    it("surfaces malformed summaries bytes from App and IDE resources", async () => {
        writeFile(path.join(home, ".gemini", "antigravity", "agyhub_summaries_proto.pb"), new Uint8Array([0x0f]));
        writeFile(path.join(home, ".gemini", "antigravity-ide", "agyhub_summaries_proto.pb"), new Uint8Array([0x0a, 0x80]));
        const result = await probeAntigravity(globalContext(), { PATH: "" }, home);
        expect(result.status).toBe("failed");
        expect(result.diagnostics.filter((item) => item.code === "antigravity_summaries_schema_invalid")).toHaveLength(2);
    });

    it("parses protobuf unknown scalar fields, deduplicates records, and rejects every unsafe wire shape", () => {
        const valid = projectProto("project-id", path.join(sandbox, "project"));
        const withUnknownFields = concat(protoVarint(3, 1n), protoFixed64(4), protoFixed32(5), valid, valid);
        expect(parseSummariesProjects(withUnknownFields)).toEqual([
            {
                projectId: "project-id",
                workspacePath: path.join(sandbox, "project"),
            },
        ]);
        expect(parseSummariesProjects(protoBytes(1, protoBytes(2, new Uint8Array())))).toEqual([]);
        expect(
            parseSummariesProjects(
                protoBytes(
                    1,
                    protoBytes(
                        2,
                        protoBytes(17, concat(protoBytes(18, new Uint8Array([0xff])), protoBytes(7, Buffer.from("relative")))),
                    ),
                ),
            ),
        ).toEqual([]);
        expect(() => parseSummariesProjects(new Uint8Array([0x00]))).toThrow(/invalid field tag/);
        expect(() => parseSummariesProjects(new Uint8Array([0x09]))).toThrow(/fixed64/);
        expect(() => parseSummariesProjects(new Uint8Array([0x0d]))).toThrow(/fixed32/);
        expect(() => parseSummariesProjects(new Uint8Array([0x0a, 0x02, 0x01]))).toThrow(/bytes field/);
        expect(() => parseSummariesProjects(new Uint8Array([0x0b]))).toThrow(/wire type/);
        expect(() =>
            parseSummariesProjects(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80])),
        ).toThrow(/varint/);
    });

    it("resolves executable symlinks but rejects binaries for a different platform", async () => {
        const actual = path.join(sandbox, "actual-agy");
        writeNative(actual);
        fs.symlinkSync(actual, path.join(bin, "agy"));
        const linked = await probeAntigravity(globalContext(), { PATH: bin }, home);
        expect(
            linked.observation.observedAgentRuntimes.find((entry) => entry.agentRuntimeId === "ANTIGRAVITY_CLI"),
        ).toMatchObject({
            installationStatus: "available",
            installationEvidence: [expect.objectContaining({ path: actual })],
        });

        fs.rmSync(path.join(bin, "agy"));
        writeFile(path.join(bin, "agy"), new Uint8Array([0x4d, 0x5a, 0, 0]), 0o755);
        expect(runtimeStatuses(await probeAntigravity(globalContext(), { PATH: bin }, home)).ANTIGRAVITY_CLI).toBe("not_found");

        writeFile(path.join(bin, "agy"), new Uint8Array([0xfe, 0xed, 0xfa, 0xcf]), 0o755);
        expect(runtimeStatuses(await probeAntigravity(globalContext(), { PATH: bin }, home)).ANTIGRAVITY_CLI).toBe("not_found");

        writeFile(path.join(bin, "agy"), new Uint8Array([1]), 0o755);
        expect(runtimeStatuses(await probeAntigravity(globalContext(), { PATH: bin }, home)).ANTIGRAVITY_CLI).toBe("not_found");
        writeFile(path.join(bin, "agy"), new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), 0o644);
        fs.chmodSync(path.join(bin, "agy"), 0o644);
        expect(runtimeStatuses(await probeAntigravity(globalContext(), { PATH: bin }, home)).ANTIGRAVITY_CLI).toBe("not_found");
    });

    it("validates CLI magic and keeps cross-grammar App/IDE install discovery fail closed", async () => {
        writeFile(path.join(bin, "agy"), new Uint8Array([0xfe, 0xed, 0xfa, 0xcf]), 0o755);
        const darwin = await probeAntigravity(globalContext("darwin"), { PATH: bin }, home, "darwin");
        expect(runtimeStatuses(darwin)).toEqual({
            ANTIGRAVITY_CLI: "available",
            ANTIGRAVITY_APP: "unknown",
            ANTIGRAVITY_IDE: "unknown",
        });
        expect(darwin.status).toBe("partial");

        writeFile(path.join(bin, "agy.exe"), new Uint8Array([0x4d, 0x5a, 0, 0]), 0o755);
        const windows = await probeAntigravity(globalContext("win32"), { PATH: bin }, home, "win32");
        expect(runtimeStatuses(windows)).toEqual({
            ANTIGRAVITY_CLI: "available",
            ANTIGRAVITY_APP: "not_found",
            ANTIGRAVITY_IDE: "not_found",
        });
        expect(windows.diagnostics.map((item) => item.code)).not.toEqual(
            expect.arrayContaining(["antigravity_app_home_path_invalid", "antigravity_ide_home_path_invalid"]),
        );
    });

    it("requires the complete structured App/IDE install shape and reads the IDE version only from valid product JSON", async () => {
        const app = path.join(home, "Antigravity-x64");
        writeNative(path.join(app, "antigravity"));
        writeFile(path.join(app, "resources", "app.asar"), antigravityAppAsar("2.2.1"));
        writeFile(path.join(app, "resources", "app-update.yml"), "version: 1");
        let result = await probeAntigravity(globalContext(), { PATH: "" }, home);
        expect(runtimeStatuses(result).ANTIGRAVITY_APP).toBe("not_found");
        writeNative(path.join(app, "resources", "bin", "language_server"));

        const ide = path.join(home, "Antigravity IDE");
        writeNative(path.join(ide, "antigravity-ide"));
        writeFile(path.join(ide, "resources", "app", "product.json"), "[]");
        writeFile(path.join(ide, "resources", "app", "out", "cli.js"), "");
        writeFile(path.join(ide, "resources", "app", "package.json"), "{}");
        result = await probeAntigravity(globalContext(), { PATH: "" }, home);
        expect(runtimeStatuses(result)).toMatchObject({ ANTIGRAVITY_APP: "available", ANTIGRAVITY_IDE: "not_found" });

        writeFile(
            path.join(ide, "resources", "app", "product.json"),
            JSON.stringify({
                applicationName: "antigravity-ide",
                version: 7,
            }),
        );
        result = await probeAntigravity(globalContext(), { PATH: "" }, home);
        expect(runtimeStatuses(result).ANTIGRAVITY_IDE).toBe("available");
        expect(
            result.observation.observedAgentRuntimes.find((entry) => entry.agentRuntimeId === "ANTIGRAVITY_IDE")?.versionText,
        ).toBe("");

        fs.chmodSync(path.join(app, "antigravity"), 0o644);
        fs.chmodSync(path.join(ide, "antigravity-ide"), 0o644);
        result = await probeAntigravity(globalContext(), { PATH: "" }, home);
        expect(runtimeStatuses(result)).toMatchObject({
            ANTIGRAVITY_APP: "not_found",
            ANTIGRAVITY_IDE: "not_found",
        });
    });

    it("merges duplicate project evidence while preserving primary/additional workspaces", async () => {
        const first = path.join(sandbox, "first");
        const second = path.join(sandbox, "second");
        fs.mkdirSync(first);
        fs.mkdirSync(second);
        writeFile(
            path.join(home, ".gemini", "config", "projects", "same.json"),
            JSON.stringify({
                id: "same",
                name: "Merged",
                projectResources: { resources: [{ folderUri: first }, { gitFolder: { folderUri: second } }] },
            }),
        );
        writeFile(path.join(home, ".gemini", "antigravity", "agyhub_summaries_proto.pb"), projectProto("same", first));
        const result = await probeAntigravity(globalContext(), { PATH: "" }, home);
        expect(result.observation.observedProjects).toEqual([
            expect.objectContaining({
                runtimeProjectKey: "same",
                workspaces: [expect.objectContaining({ role: "primary" }), expect.objectContaining({ role: "additional" })],
                evidence: expect.arrayContaining([
                    expect.objectContaining({ locatorKey: "same.json" }),
                    expect.objectContaining({ locatorKey: expect.stringContaining("app:tag18=same") }),
                ]),
            }),
        ]);
        expect(result.observation.targetCandidates[0]).toMatchObject({
            targetRootPath: first,
            entryApplicabilities: [
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_CLI",
                    status: "invalid",
                    diagnostics: [expect.objectContaining({ code: "antigravity_cli_target_installation_not_found" })],
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_APP",
                    status: "invalid",
                    diagnostics: [expect.objectContaining({ code: "antigravity_app_target_installation_not_found" })],
                }),
                expect.objectContaining({
                    agentRuntimeId: "ANTIGRAVITY_IDE",
                    status: "invalid",
                    diagnostics: [expect.objectContaining({ code: "antigravity_ide_target_installation_not_found" })],
                }),
            ],
        });
    });

    it("projects one stable physical target while preserving distinct same-root project observations", async () => {
        const sharedRoot = path.join(sandbox, "shared-root");
        const distinctRoot = path.join(sandbox, "distinct-root");
        const registry = path.join(home, ".gemini", "config", "projects");
        fs.mkdirSync(sharedRoot);
        fs.mkdirSync(distinctRoot);

        const alpha = {
            id: "history-alpha",
            name: "Alpha",
            projectResources: { resources: [{ folderUri: sharedRoot }] },
        };
        const beta = {
            id: "history-beta",
            name: "Beta",
            projectResources: { resources: [{ folderUri: sharedRoot }] },
        };
        const distinct = {
            id: "history-distinct",
            name: "Distinct",
            projectResources: { resources: [{ folderUri: distinctRoot }] },
        };
        writeFile(path.join(registry, "a.json"), JSON.stringify(beta));
        writeFile(path.join(registry, "m.json"), JSON.stringify(distinct));
        writeFile(path.join(registry, "z.json"), JSON.stringify(alpha));

        const first = await probeAntigravity(globalContext(), { PATH: "" }, home);
        expect(first.observation.observedProjects).toHaveLength(3);
        expect(first.observation.observedProjects.map((project) => project.runtimeProjectKey).sort()).toEqual([
            "history-alpha",
            "history-beta",
            "history-distinct",
        ]);
        const sameRootProjects = first.observation.observedProjects.filter(
            (project) =>
                first.observation.sourceRoots.find(
                    (root) =>
                        root.sourceRootId === project.workspaces.find((workspace) => workspace.role === "primary")?.sourceRootId,
                )?.path === sharedRoot,
        );
        expect(sameRootProjects).toHaveLength(2);
        expect(new Set(sameRootProjects.map((project) => project.workspaces[0]?.sourceRootId)).size).toBe(1);
        expect(sameRootProjects.every((project) => project.evidence.length > 0)).toBe(true);
        for (const agentRuntimeId of ["ANTIGRAVITY_CLI", "ANTIGRAVITY_APP", "ANTIGRAVITY_IDE"] as const) {
            expect(runtimeProjectKeys(first, agentRuntimeId)).toEqual(["history-alpha", "history-beta", "history-distinct"]);
        }

        expect(first.observation.targetCandidates).toHaveLength(3);
        const sharedCandidate = first.observation.targetCandidates.find((candidate) => candidate.targetRootPath === sharedRoot);
        expect(sharedCandidate?.entryApplicabilities).toHaveLength(3);
        for (const applicability of sharedCandidate?.entryApplicabilities ?? []) {
            expect(applicability.locatorEvidence).toEqual([
                {
                    locatorKind: "project_registry_entry",
                    locatorKey: "history-alpha",
                    evidenceLevel: "agent_runtime_verified",
                },
                {
                    locatorKind: "project_registry_entry",
                    locatorKey: "history-beta",
                    evidenceLevel: "agent_runtime_verified",
                },
            ]);
        }
        expect(first.observation.targetCandidates.map((candidate) => candidate.targetRootPath).sort()).toEqual([
            distinctRoot,
            path.join(home, ".gemini"),
            sharedRoot,
        ]);

        writeFile(path.join(registry, "a.json"), JSON.stringify(alpha));
        writeFile(path.join(registry, "z.json"), JSON.stringify(beta));
        const permuted = await probeAntigravity(globalContext(), { PATH: "" }, home);
        expect(permuted.observation.targetCandidates).toEqual(first.observation.targetCandidates);
        expect(permuted.observation.observedProjects).toHaveLength(3);
    });
});

function runtimeStatuses(result: Awaited<ReturnType<typeof probeAntigravity>>): Record<AgentRuntimeId, string> {
    return Object.fromEntries(
        result.observation.observedAgentRuntimes.map((entry) => [entry.agentRuntimeId, entry.installationStatus]),
    ) as Record<AgentRuntimeId, string>;
}

function runtimeProjectKeys(result: Awaited<ReturnType<typeof probeAntigravity>>, agentRuntimeId: AgentRuntimeId): string[] {
    const runtime = result.observation.observedAgentRuntimes.find((entry) => entry.agentRuntimeId === agentRuntimeId);
    const ids = new Set(runtime?.observedProjectIds ?? []);
    return result.observation.observedProjects
        .filter((project) => ids.has(project.observedProjectId))
        .map((project) => project.runtimeProjectKey)
        .sort();
}

function writeNative(target: string): void {
    writeFile(target, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), 0o755);
}

function writeFile(target: string, content: string | Uint8Array, mode?: number): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, mode === undefined ? undefined : { mode });
}

function pathToFileUri(value: string): string {
    return `file://${value}`;
}

function projectProto(projectId: string, workspacePath: string, parentConversationId = ""): Uint8Array {
    const config = concat(
        ...(parentConversationId === "" ? [] : [protoBytes(5, Buffer.from(parentConversationId))]),
        protoBytes(18, Buffer.from(projectId)),
        protoBytes(7, Buffer.from(workspacePath)),
    );
    const metadata = protoBytes(17, config);
    const entry = concat(protoBytes(1, Buffer.from(`conversation:${projectId}`)), protoBytes(2, metadata));
    return protoBytes(1, entry);
}

function protoBytes(tag: number, bytes: Uint8Array): Uint8Array {
    return concat(varint(BigInt((tag << 3) | 2)), varint(BigInt(bytes.length)), bytes);
}

function protoVarint(tag: number, value: bigint): Uint8Array {
    return concat(varint(BigInt(tag << 3)), varint(value));
}

function protoFixed64(tag: number): Uint8Array {
    return concat(varint(BigInt((tag << 3) | 1)), new Uint8Array(8));
}

function protoFixed32(tag: number): Uint8Array {
    return concat(varint(BigInt((tag << 3) | 5)), new Uint8Array(4));
}

function varint(value: bigint): Uint8Array {
    const bytes: number[] = [];
    let remaining = value;
    do {
        let byte = Number(remaining & 0x7fn);
        remaining >>= 7n;
        if (remaining > 0n) byte |= 0x80;
        bytes.push(byte);
    } while (remaining > 0n);
    return new Uint8Array(bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const length = parts.reduce((total, part) => total + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}
