import type { OperationDiagnostic } from "@oaam/core";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAdapterProbeResult } from "../../../core/src/adapters/adapter-contract-validator";
import { CLAUDECODE_PROBE_FOR_TEST, probeClaudeCode } from "../src/claudecode-probe";
import * as appInstallation from "../src/claudecode-probe-app-installation";
import { claudecodeProvider } from "../src/claudecode-provider";
import { materializeClaudeCodeTargetCandidates } from "../src/claudecode-target-candidates";
import { createProjectRoot, globalContext, projectContext, sanitizeForFixture } from "./claudecode-test-fixtures";

let sandbox = "";
let home = "";
let bin = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-claudecode-target-"));
    home = path.join(sandbox, "home");
    bin = path.join(sandbox, "bin");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

function observeMissingFixtureApp(): void {
    const find = appInstallation.findClaudeCodeAppInstallation;
    const missingRoot = path.join(sandbox, "missing-app");
    expect(fs.existsSync(missingRoot)).toBe(false);
    vi.spyOn(appInstallation, "findClaudeCodeAppInstallation").mockImplementation((environment, homeDir, context) =>
        find(environment, homeDir, context, missingRoot),
    );
}

describe("Claude Code target candidates", () => {
    it("uses one user-selected installation folder without falling back to another PATH candidate", async () => {
        const selectedRoot = path.join(sandbox, "selected-claude");
        const unrelatedRoot = path.join(sandbox, "unrelated-claude");
        const emptyRoot = path.join(sandbox, "empty-claude");
        writeExecutable(path.join(selectedRoot, "claude"));
        writeExecutable(path.join(unrelatedRoot, "claude"));
        fs.mkdirSync(emptyRoot);

        const selected = await probeClaudeCode(
            { ...globalContext(), installationRootPath: selectedRoot },
            { PATH: unrelatedRoot },
            home,
        );
        expect(
            selected.observation.observedAgentRuntimes.find((runtime) => runtime.agentRuntimeId === "CLAUDE_CODE_CLI"),
        ).toMatchObject({
            installationStatus: "available",
            installationEvidence: [expect.objectContaining({ path: path.join(selectedRoot, "claude") })],
        });

        const rejected = await probeClaudeCode(
            { ...globalContext(), installationRootPath: emptyRoot },
            { PATH: unrelatedRoot },
            home,
        );
        expect(
            rejected.observation.observedAgentRuntimes.find((runtime) => runtime.agentRuntimeId === "CLAUDE_CODE_CLI"),
        ).toMatchObject({
            installationStatus: "not_found",
            diagnostics: [expect.objectContaining({ code: "claudecode_executable_not_found", path: emptyRoot })],
        });
    });

    it("projects one exact user-authorized project without reversing the flattened runtime key", async () => {
        observeMissingFixtureApp();
        const repository = path.join(sandbox, "repository");
        const project = path.join(repository, "packages", "app");
        createProjectRoot(repository);
        fs.mkdirSync(project, { recursive: true });
        writeExecutable(path.join(bin, "claude"));

        const context = projectContext(project);
        const result = await probeClaudeCode(context, { PATH: bin }, home);
        expect(result.observation.observedProjects[0]).toMatchObject({
            runtimeProjectKey: sanitizeForFixture(repository),
            workspaces: [expect.objectContaining({ role: "primary" })],
        });
        expect(result.observation.targetCandidates).toEqual([
            expect.objectContaining({
                targetRootPath: project,
                targetKind: "project",
                displayName: "app",
                entryApplicabilities: [
                    {
                        agentRuntimeId: "CLAUDE_CODE_CLI",
                        status: "ready_for_plan",
                        locatorEvidence: [
                            {
                                locatorKind: "user_provided_path",
                                locatorKey: "probe_project_root",
                                evidenceLevel: "user_provided",
                            },
                        ],
                        diagnostics: [],
                    },
                    expect.objectContaining({
                        agentRuntimeId: "CLAUDE_CODE_APP",
                        status: "invalid",
                        diagnostics: [expect.objectContaining({ code: "claudecode_app_target_installation_not_found" })],
                    }),
                ],
            }),
        ]);
        expect(validateAdapterProbeResult(claudecodeProvider, result, context.platformContext)).toEqual([]);
    });

    it("retains source discovery while an exact target version observation fails closed", async () => {
        const project = path.join(sandbox, "version-unavailable-project");
        createProjectRoot(project);
        const executablePath = path.join(bin, "claude");
        writeExecutable(executablePath);

        const result = await CLAUDECODE_PROBE_FOR_TEST.probeClaudeCodeForTest(
            projectContext(project),
            { PATH: bin },
            home,
            "linux",
            {
                invokeLocal: async () => ({
                    status: "timed_out",
                    exitCode: null,
                    signal: null,
                    stdout: new Uint8Array(),
                    stderr: new Uint8Array(),
                    rootProcess: null,
                    observedProcesses: [],
                    cleanupComplete: true,
                    invocationTokenAbsent: true,
                    failureCode: "timeout",
                    executableSha256: `sha256:${createHash("sha256").update(fs.readFileSync(executablePath)).digest("hex")}`,
                }),
            },
        );

        expect(result.observation.sourceRoots).toContainEqual(
            expect.objectContaining({ path: project, accessStatus: "available" }),
        );
        expect(result.observation.observedAgentRuntimes[0]).toMatchObject({
            agentRuntimeId: "CLAUDE_CODE_CLI",
            installationStatus: "available",
            versionText: "",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_version_observation_timed_out" })],
        });
        expect(result.observation.targetCandidates[0]?.entryApplicabilities[0]).toMatchObject({
            agentRuntimeId: "CLAUDE_CODE_CLI",
            status: "ready_for_plan",
        });
    });

    it("projects one available project-keyed Memory directory without conflating it with the Project root", async () => {
        observeMissingFixtureApp();
        const project = path.join(sandbox, "memory-project");
        const memory = path.join(sandbox, "memory-root");
        createProjectRoot(project);
        fs.mkdirSync(memory, { recursive: true });
        writeExecutable(path.join(bin, "claude"));

        const context = projectContext(project);
        const result = await probeClaudeCode(
            context,
            {
                PATH: bin,
                CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: memory,
            },
            home,
        );
        const candidate = required(result.observation.targetCandidates.find((item) => item.targetKind === "directory"));
        expect(candidate).toMatchObject({
            targetRootPath: memory,
            targetKind: "directory",
            displayName: "memory-project Claude Code Memory",
            entryApplicabilities: [
                {
                    agentRuntimeId: "CLAUDE_CODE_CLI",
                    status: "ready_for_plan",
                    locatorEvidence: [
                        {
                            locatorKind: "runtime_declared_path",
                            locatorKey: "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE",
                            evidenceLevel: "agent_runtime_verified",
                        },
                    ],
                    diagnostics: [],
                },
                expect.objectContaining({
                    agentRuntimeId: "CLAUDE_CODE_APP",
                    status: "invalid",
                    diagnostics: [expect.objectContaining({ code: "claudecode_app_memory_target_installation_not_found" })],
                }),
            ],
        });
        expect(result.observation.targetCandidates.find((item) => item.targetKind === "project")?.targetRootPath).toBe(project);
        expect(validateAdapterProbeResult(claudecodeProvider, result, context.platformContext)).toEqual([]);

        const root = required(result.observation.sourceRoots.find((item) => item.path === memory));
        const projectObservation = required(result.observation.observedProjects[0]);
        const runtime = required(
            result.observation.observedAgentRuntimes.find((item) => item.agentRuntimeId === "CLAUDE_CODE_CLI"),
        );
        const applicability = (candidateRoot = root, candidateProject = projectObservation, candidateRuntime = runtime) =>
            required(
                required(
                    materializeClaudeCodeTargetCandidates([candidateRoot], [candidateProject], candidateRuntime).find(
                        (item) => item.targetKind === "directory",
                    ),
                ).entryApplicabilities.find((item) => item.agentRuntimeId === "CLAUDE_CODE_CLI"),
            );
        expect(
            applicability(root, projectObservation, {
                ...runtime,
                installationStatus: "needs_permission",
                installationEvidence: [],
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [
                expect.objectContaining({
                    code: "claudecode_cli_memory_target_build_evidence_unavailable",
                    causeKind: "permission_denied",
                }),
            ],
        });
        expect(
            applicability(root, projectObservation, {
                ...runtime,
                installationEvidence: runtime.installationEvidence.map((evidence) => ({
                    ...evidence,
                    diagnostics: [errorDiagnostic("tainted-memory-build")],
                })),
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_memory_target_build_evidence_unavailable" })],
        });
        expect(applicability(root, projectObservation, { ...runtime, projectDiscoveryStatus: "partial" })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_memory_target_authority_incomplete" })],
        });
        expect(
            applicability(root, projectObservation, {
                ...runtime,
                diagnostics: [errorDiagnostic("tainted-memory-runtime")],
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_memory_target_authority_incomplete" })],
        });
        expect(
            applicability(root, { ...projectObservation, diagnostics: [errorDiagnostic("tainted-memory-project")] }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_memory_target_authority_incomplete" })],
        });
        expect(applicability(root, { ...projectObservation, evidence: [] })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_memory_target_authority_incomplete" })],
        });
        expect(
            materializeClaudeCodeTargetCandidates(
                [{ ...root, diagnostics: [errorDiagnostic("tainted-memory-root")] }],
                [projectObservation],
                runtime,
            ).filter((item) => item.targetKind === "directory"),
        ).toEqual([]);

        const missingCli = await probeClaudeCode(context, { PATH: "", CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: memory }, home);
        expect(
            missingCli.observation.targetCandidates
                .find((item) => item.targetKind === "directory")
                ?.entryApplicabilities.find((item) => item.agentRuntimeId === "CLAUDE_CODE_CLI"),
        ).toMatchObject({
            status: "invalid",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_memory_target_installation_not_found" })],
        });
    });

    it("keeps missing or incomplete CLI evidence fail-closed while retaining the exact candidate", async () => {
        const project = path.join(sandbox, "project");
        createProjectRoot(project);

        const context = projectContext(project);
        const missing = await probeClaudeCode(context, { PATH: "" }, home);
        expect(missing.observation.targetCandidates[0]?.entryApplicabilities[0]).toMatchObject({
            agentRuntimeId: "CLAUDE_CODE_CLI",
            status: "invalid",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_target_installation_not_found" })],
        });
        expect(validateAdapterProbeResult(claudecodeProvider, missing, context.platformContext)).toEqual([]);

        const unavailableProject = path.join(sandbox, "unavailable-project");
        writeExecutable(path.join(bin, "claude"));
        const unavailable = await probeClaudeCode(projectContext(unavailableProject), { PATH: bin }, home);
        expect(unavailable.observation.targetCandidates[0]?.entryApplicabilities[0]).toMatchObject({
            agentRuntimeId: "CLAUDE_CODE_CLI",
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_target_project_authority_incomplete" })],
        });
    });

    it("never invents project targets from flattened keys while retaining the exact available global config root", async () => {
        observeMissingFixtureApp();
        fs.mkdirSync(path.join(home, ".claude", "projects", "-flattened-project"), { recursive: true });
        writeExecutable(path.join(bin, "claude"));

        const global = await probeClaudeCode(globalContext(), { PATH: bin }, home);
        expect(global.observation.targetCandidates).toEqual([
            expect.objectContaining({
                targetRootPath: path.join(home, ".claude"),
                targetKind: "global",
                entryApplicabilities: [
                    expect.objectContaining({ agentRuntimeId: "CLAUDE_CODE_CLI", status: "ready_for_plan" }),
                    expect.objectContaining({
                        agentRuntimeId: "CLAUDE_CODE_APP",
                        status: "invalid",
                        diagnostics: [expect.objectContaining({ code: "claudecode_app_global_target_installation_not_found" })],
                    }),
                ],
            }),
        ]);

        const directory = await probeClaudeCode(
            {
                authorizationScope: "directory",
                platformContext: globalContext().platformContext,
                directoryRootPath: path.join(sandbox, "external"),
            },
            { PATH: bin },
            home,
        );
        expect(directory.observation.targetCandidates).toEqual([
            expect.objectContaining({
                targetRootPath: path.join(home, ".claude"),
                targetKind: "global",
            }),
        ]);
    });

    it("keeps a global config target bound to the exact readable root and trustworthy CLI evidence", async () => {
        fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
        writeExecutable(path.join(bin, "claude"));
        const probed = await probeClaudeCode(globalContext(), { PATH: bin }, home);
        const root = required(probed.observation.sourceRoots.find((item) => item.rootRole === "config"));
        const runtime = required(
            probed.observation.observedAgentRuntimes.find((item) => item.agentRuntimeId === "CLAUDE_CODE_CLI"),
        );
        const applicability = (candidateRoot = root, candidateRuntime = runtime) =>
            required(
                required(materializeClaudeCodeTargetCandidates([candidateRoot], [], candidateRuntime)[0]).entryApplicabilities[0],
            );

        expect(root.locatorEvidence).toEqual([
            {
                locatorKind: "runtime_known_rule",
                locatorKey: "claude_config_default",
                evidenceLevel: "source_code",
            },
        ]);
        expect(applicability()).toMatchObject({
            status: "ready_for_plan",
            locatorEvidence: [
                {
                    locatorKind: "runtime_known_rule",
                    locatorKey: "claude_config_default",
                    evidenceLevel: "local_artifact",
                },
            ],
            diagnostics: [],
        });
        expect(validateAdapterProbeResult(claudecodeProvider, probed, globalContext().platformContext)).toEqual([]);
        expect(applicability(root, { ...runtime, installationStatus: "not_found", installationEvidence: [] })).toMatchObject({
            status: "invalid",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_global_target_installation_not_found" })],
        });
        expect(
            applicability(root, {
                ...runtime,
                installationEvidence: [
                    {
                        kind: "launcher",
                        path: path.join(bin, "claude"),
                        evidenceLevel: "agent_runtime_verified",
                        diagnostics: [errorDiagnostic("tainted-global-build")],
                    },
                ],
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_global_target_build_evidence_unavailable" })],
        });
        expect(applicability(root, { ...runtime, diagnostics: [errorDiagnostic("global-runtime-tainted")] })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_global_target_build_evidence_unavailable" })],
        });
        expect(materializeClaudeCodeTargetCandidates([{ ...root, accessStatus: "unknown" }], [], runtime)).toEqual([]);
        expect(materializeClaudeCodeTargetCandidates([root], [], { ...runtime, sourceRootIds: [] })).toEqual([]);
    });

    it("keeps every tainted authority branch unknown and preserves deterministic physical ordering", async () => {
        const firstPath = path.join(sandbox, "first");
        const secondPath = path.join(sandbox, "second");
        createProjectRoot(firstPath);
        createProjectRoot(secondPath);
        writeExecutable(path.join(bin, "claude"));

        const probed = await probeClaudeCode(projectContext(firstPath), { PATH: bin }, home);
        const runtime = required(
            probed.observation.observedAgentRuntimes.find((item) => item.agentRuntimeId === "CLAUDE_CODE_CLI"),
        );
        const root = required(probed.observation.sourceRoots.find((item) => item.path === firstPath));
        const project = required(probed.observation.observedProjects[0]);
        const applicability = (candidateRoot = root, candidateProject = project, candidateRuntime = runtime) =>
            required(
                required(materializeClaudeCodeTargetCandidates([candidateRoot], [candidateProject], candidateRuntime)[0])
                    .entryApplicabilities[0],
            );

        expect(
            applicability(root, project, {
                ...runtime,
                installationStatus: "needs_permission",
                installationEvidence: [],
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_target_build_evidence_unavailable" })],
        });
        expect(
            applicability(root, project, {
                ...runtime,
                installationEvidence: [
                    {
                        kind: "launcher",
                        path: path.join(bin, "claude"),
                        evidenceLevel: "agent_runtime_verified",
                        diagnostics: [errorDiagnostic("tainted-build")],
                    },
                ],
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_target_build_evidence_unavailable" })],
        });
        expect(applicability(root, project, { ...runtime, projectDiscoveryStatus: "partial" })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_target_project_authority_incomplete" })],
        });
        expect(applicability(root, project, { ...runtime, diagnostics: [errorDiagnostic("runtime-tainted")] })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_target_project_authority_incomplete" })],
        });
        expect(applicability({ ...root, diagnostics: [errorDiagnostic("root-tainted")] })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_target_project_authority_incomplete" })],
        });
        expect(applicability(root, { ...project, diagnostics: [errorDiagnostic("project-tainted")] })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_target_project_authority_incomplete" })],
        });
        expect(
            applicability(root, {
                ...project,
                evidence: [{ evidenceKind: "invocation", locatorKey: "other", evidenceLevel: "user_provided" }],
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_cli_target_project_authority_incomplete" })],
        });
        expect(materializeClaudeCodeTargetCandidates([root], [project], { ...runtime, observedProjectIds: [] })).toEqual([]);

        const secondRoot = {
            ...root,
            sourceRootId: "second-root",
            path: secondPath,
        };
        const secondProject = {
            ...project,
            observedProjectId: "second-project",
            displayName: "second",
            workspaces: [{ sourceRootId: secondRoot.sourceRootId, role: "primary" as const }],
        };
        const ordered = materializeClaudeCodeTargetCandidates([secondRoot, root], [secondProject, project], {
            ...runtime,
            observedProjectIds: [secondProject.observedProjectId, project.observedProjectId],
            installationEvidence: [
                {
                    kind: "launcher",
                    path: path.join(bin, "claude"),
                    evidenceLevel: "agent_runtime_verified",
                    diagnostics: [],
                },
            ],
        });
        expect(ordered.map((candidate) => candidate.targetRootPath)).toEqual([firstPath, secondPath]);
        expect(ordered.every((candidate) => candidate.entryApplicabilities[0]?.status === "ready_for_plan")).toBe(true);
    });

    it("makes only an exact installed App engine plus exact Project authority ready for planning", async () => {
        const projectPath = path.join(sandbox, "app-project");
        const memoryPath = path.join(sandbox, "app-memory");
        createProjectRoot(projectPath);
        fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
        fs.mkdirSync(memoryPath, { recursive: true });
        writeExecutable(path.join(bin, "claude"));
        const probed = await probeClaudeCode(
            projectContext(projectPath),
            { PATH: bin, CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: memoryPath },
            home,
        );
        const cliRuntime = required(
            probed.observation.observedAgentRuntimes.find((item) => item.agentRuntimeId === "CLAUDE_CODE_CLI"),
        );
        const root = required(probed.observation.sourceRoots.find((item) => item.path === projectPath));
        const configRoot = required(probed.observation.sourceRoots.find((item) => item.rootRole === "config"));
        const memoryRoot = required(probed.observation.sourceRoots.find((item) => item.path === memoryPath));
        const project = required(probed.observation.observedProjects[0]);
        const appExecutable = path.join(sandbox, "Claude-3p", "claude-code", "2.1.219", "claude.exe");
        const appRuntime = {
            ...cliRuntime,
            agentRuntimeId: "CLAUDE_CODE_APP" as const,
            versionText: "2.1.219",
            installationEvidence: [
                {
                    kind: "executable" as const,
                    path: appExecutable,
                    evidenceLevel: "agent_runtime_verified" as const,
                    diagnostics: [],
                },
            ],
            sourceRootIds: [configRoot.sourceRootId, root.sourceRootId, memoryRoot.sourceRootId],
            observedProjectIds: [project.observedProjectId],
            installationStatus: "available" as const,
            projectDiscoveryStatus: "complete" as const,
            diagnostics: [],
        };
        const appExecutableEvidence = required(appRuntime.installationEvidence[0]);
        const applicability = (candidateRuntime = appRuntime, candidateRoot = root, candidateProject = project) =>
            required(
                required(
                    materializeClaudeCodeTargetCandidates([candidateRoot], [candidateProject], cliRuntime, candidateRuntime)[0],
                ).entryApplicabilities.find((item) => item.agentRuntimeId === "CLAUDE_CODE_APP"),
            );
        const memoryApplicability = (candidateRuntime = appRuntime, candidateRoot = memoryRoot, candidateProject = project) =>
            required(
                required(
                    materializeClaudeCodeTargetCandidates([candidateRoot], [candidateProject], cliRuntime, candidateRuntime).find(
                        (candidate) => candidate.targetKind === "directory",
                    ),
                ).entryApplicabilities.find((item) => item.agentRuntimeId === "CLAUDE_CODE_APP"),
            );
        const globalApplicability = (candidateRuntime = appRuntime, candidateRoot = configRoot) =>
            required(
                required(
                    materializeClaudeCodeTargetCandidates(
                        [candidateRoot],
                        [],
                        { ...cliRuntime, sourceRootIds: [candidateRoot.sourceRootId] },
                        candidateRuntime,
                    )[0],
                ).entryApplicabilities.find((item) => item.agentRuntimeId === "CLAUDE_CODE_APP"),
            );

        expect(applicability()).toEqual({
            agentRuntimeId: "CLAUDE_CODE_APP",
            status: "ready_for_plan",
            locatorEvidence: root.locatorEvidence,
            diagnostics: [],
        });
        expect(applicability({ ...appRuntime, installationStatus: "not_found", installationEvidence: [] })).toMatchObject({
            status: "invalid",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_target_installation_not_found" })],
        });
        expect(applicability({ ...appRuntime, installationStatus: "needs_permission", installationEvidence: [] })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_target_build_evidence_unavailable" })],
        });
        expect(
            applicability({
                ...appRuntime,
                installationEvidence: [
                    {
                        ...appExecutableEvidence,
                        diagnostics: [errorDiagnostic("tainted-app-build")],
                    },
                ],
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_target_build_evidence_unavailable" })],
        });
        expect(applicability({ ...appRuntime, observedProjectIds: [] })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_target_project_authority_incomplete" })],
        });
        expect(applicability({ ...appRuntime, sourceRootIds: [] })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_target_project_authority_incomplete" })],
        });
        expect(
            applicability({
                ...appRuntime,
                installationEvidence: [{ ...appExecutableEvidence, kind: "install_root", evidenceLevel: "local_artifact" }],
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_target_build_evidence_unavailable" })],
        });
        expect(applicability({ ...appRuntime, diagnostics: [errorDiagnostic("tainted-app-runtime")] })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_target_project_authority_incomplete" })],
        });
        expect(applicability({ ...appRuntime, projectDiscoveryStatus: "partial" })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_target_project_authority_incomplete" })],
        });
        expect(applicability(appRuntime, { ...root, accessStatus: "needs_permission" })).toMatchObject({
            status: "unknown",
            diagnostics: [
                expect.objectContaining({
                    code: "claudecode_app_target_project_authority_incomplete",
                    causeKind: "permission_denied",
                }),
            ],
        });
        expect(applicability(appRuntime, { ...root, diagnostics: [errorDiagnostic("tainted-app-root")] })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_target_project_authority_incomplete" })],
        });
        expect(applicability(appRuntime, root, { ...project, evidence: [] })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_target_project_authority_incomplete" })],
        });
        expect(applicability(appRuntime, root, { ...project, diagnostics: [errorDiagnostic("tainted-project")] })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_target_project_authority_incomplete" })],
        });
        expect(memoryApplicability()).toEqual({
            agentRuntimeId: "CLAUDE_CODE_APP",
            status: "ready_for_plan",
            locatorEvidence: memoryRoot.locatorEvidence,
            diagnostics: [],
        });
        expect(memoryApplicability({ ...appRuntime, installationStatus: "not_found", installationEvidence: [] })).toMatchObject({
            status: "invalid",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_memory_target_installation_not_found" })],
        });
        expect(
            memoryApplicability({ ...appRuntime, installationStatus: "needs_permission", installationEvidence: [] }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [
                expect.objectContaining({
                    code: "claudecode_app_memory_target_build_evidence_unavailable",
                    causeKind: "permission_denied",
                }),
            ],
        });
        expect(memoryApplicability({ ...appRuntime, sourceRootIds: [root.sourceRootId] })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_memory_target_authority_incomplete" })],
        });
        expect(
            memoryApplicability({ ...appRuntime, diagnostics: [errorDiagnostic("tainted-memory-app-runtime")] }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_memory_target_authority_incomplete" })],
        });
        expect(
            memoryApplicability({
                ...appRuntime,
                installationEvidence: [{ ...appExecutableEvidence, diagnostics: [errorDiagnostic("tainted-memory-app-build")] }],
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_memory_target_build_evidence_unavailable" })],
        });
        expect(
            memoryApplicability(appRuntime, memoryRoot, {
                ...project,
                diagnostics: [errorDiagnostic("tainted-memory-project")],
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_memory_target_authority_incomplete" })],
        });
        expect(globalApplicability()).toEqual({
            agentRuntimeId: "CLAUDE_CODE_APP",
            status: "ready_for_plan",
            locatorEvidence: [
                {
                    locatorKind: "runtime_known_rule",
                    locatorKey: "claude_config_default",
                    evidenceLevel: "local_artifact",
                },
            ],
            diagnostics: [],
        });
        expect(globalApplicability({ ...appRuntime, installationStatus: "not_found", installationEvidence: [] })).toMatchObject({
            status: "invalid",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_global_target_installation_not_found" })],
        });
        expect(
            globalApplicability({
                ...appRuntime,
                installationStatus: "needs_permission",
                installationEvidence: [],
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [
                expect.objectContaining({
                    code: "claudecode_app_global_target_build_evidence_unavailable",
                    causeKind: "permission_denied",
                }),
            ],
        });
        expect(globalApplicability({ ...appRuntime, sourceRootIds: [root.sourceRootId] })).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_global_target_build_evidence_unavailable" })],
        });
        expect(
            globalApplicability({
                ...appRuntime,
                installationEvidence: [{ ...appExecutableEvidence, diagnostics: [errorDiagnostic("tainted-global-app-build")] }],
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "claudecode_app_global_target_build_evidence_unavailable" })],
        });
    });
});

function writeExecutable(target: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "#!/bin/sh\nprintf '2.1.220 (Claude Code)\\n'\n", { mode: 0o755 });
}

function errorDiagnostic(code: string): OperationDiagnostic {
    return {
        operation: "probe",
        code,
        severity: "error",
        message: code,
        path: "",
        traceId: "",
        causeKind: "verification_failed",
        retryable: false,
        suggestedActions: [],
        rawSummary: code,
    };
}

function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("required fixture value is missing");
    return value;
}
