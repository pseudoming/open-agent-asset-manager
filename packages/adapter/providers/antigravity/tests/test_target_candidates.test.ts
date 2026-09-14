import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AdapterProbeResult, OperationDiagnostic } from "@oaam/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureGlobalProbeContext as globalContext, fixtureProjectProbeContext as projectContext } from "../../../test-support";
import { materializeAntigravityTargetCandidates, probeAntigravity } from "../src/antigravity-probe";
import { findAntigravityCliInstallation } from "../src/antigravity-probe-installation";
import { antigravityAppAsar } from "./antigravity-app-asar-fixture";

let sandbox = "";
let home = "";
let bin = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-antigravity-target-"));
    home = path.join(sandbox, "home");
    bin = path.join(sandbox, "bin");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Antigravity target candidates", () => {
    it("uses one user-selected CLI folder and does not borrow an unrelated PATH installation", () => {
        const selectedRoot = path.join(sandbox, "selected-antigravity");
        const emptyRoot = path.join(sandbox, "empty-antigravity");
        writeNative(path.join(selectedRoot, "agy"));
        writeNative(path.join(bin, "agy"));
        fs.mkdirSync(emptyRoot);
        const context = globalContext().platformContext;

        expect(findAntigravityCliInstallation({ PATH: bin }, home, context, selectedRoot)).toMatchObject({
            status: "available",
            evidence: [expect.objectContaining({ path: path.join(selectedRoot, "agy") })],
        });
        expect(findAntigravityCliInstallation({ PATH: bin }, home, context, emptyRoot)).toMatchObject({
            status: "not_found",
            evidence: [expect.objectContaining({ path: path.join(emptyRoot, "agy") })],
        });
    });

    it("makes complete project-scoped CLI, App, and IDE observations ready for target planning", async () => {
        const projectRoot = path.join(sandbox, "registered-project");
        fs.mkdirSync(projectRoot);
        writeNative(path.join(bin, "agy"));
        const appRoot = path.join(home, "Antigravity-x64");
        writeNative(path.join(appRoot, "antigravity"));
        writeFile(path.join(appRoot, "resources", "app.asar"), antigravityAppAsar("2.2.1"));
        writeFile(path.join(appRoot, "resources", "app-update.yml"), "version: 2.2.1");
        writeNative(path.join(appRoot, "resources", "bin", "language_server"));
        const ideRoot = path.join(home, "Antigravity IDE");
        writeNative(path.join(ideRoot, "antigravity-ide"));
        writeFile(
            path.join(ideRoot, "resources", "app", "product.json"),
            JSON.stringify({ applicationName: "antigravity-ide", version: "1.107.0" }),
        );
        writeFile(path.join(ideRoot, "resources", "app", "out", "cli.js"), "");
        writeFile(path.join(ideRoot, "resources", "app", "package.json"), "{}");
        writeFile(
            path.join(home, ".gemini", "config", "projects", "registered.json"),
            JSON.stringify({
                id: "registered-project",
                name: "Registered project",
                projectResources: { resources: [{ folderUri: projectRoot }] },
            }),
        );
        const unrelatedRoot = path.join(sandbox, "historical-project");
        fs.mkdirSync(unrelatedRoot);
        writeFile(
            path.join(home, ".gemini", "config", "projects", "historical.json"),
            JSON.stringify({
                id: "historical-project",
                name: "Historical project",
                projectResources: { resources: [{ folderUri: unrelatedRoot }] },
            }),
        );

        const global = await probeAntigravity(globalContext(), { PATH: bin }, home);
        expect(
            global.observation.targetCandidates
                .find((item) => item.targetRootPath === projectRoot)
                ?.entryApplicabilities.find((item) => item.agentRuntimeId === "ANTIGRAVITY_CLI"),
        ).toMatchObject({
            status: "ready_for_plan",
            diagnostics: [],
        });
        expect(
            global.observation.targetCandidates
                .find((item) => item.targetRootPath === path.join(home, ".gemini"))
                ?.entryApplicabilities.find((item) => item.agentRuntimeId === "ANTIGRAVITY_CLI"),
        ).toMatchObject({ status: "ready_for_plan", diagnostics: [] });

        const result = await probeAntigravity(projectContext(projectRoot), { PATH: bin }, home);
        expect(result.observation.targetCandidates.some((item) => item.targetRootPath === unrelatedRoot)).toBe(false);
        expect(result.observation.observedProjects.every((project) => project.displayName !== "Historical project")).toBe(true);
        const candidate = result.observation.targetCandidates.find((item) => item.targetRootPath === projectRoot);
        expect(candidate?.entryApplicabilities).toEqual([
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_CLI",
                status: "ready_for_plan",
                diagnostics: [],
                locatorEvidence: expect.arrayContaining([
                    {
                        locatorKind: "user_provided_path",
                        locatorKey: "probe_project_root",
                        evidenceLevel: "user_provided",
                    },
                ]),
            }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_APP",
                status: "ready_for_plan",
                diagnostics: [],
                locatorEvidence: expect.arrayContaining([
                    {
                        locatorKind: "user_provided_path",
                        locatorKey: "probe_project_root",
                        evidenceLevel: "user_provided",
                    },
                ]),
            }),
            expect.objectContaining({
                agentRuntimeId: "ANTIGRAVITY_IDE",
                status: "ready_for_plan",
                diagnostics: [],
                locatorEvidence: expect.arrayContaining([
                    {
                        locatorKind: "user_provided_path",
                        locatorKey: "probe_project_root",
                        evidenceLevel: "user_provided",
                    },
                ]),
            }),
        ]);
    });

    it("binds the exact user-authorized Project without borrowing a sibling registry", async () => {
        const projectRoot = path.join(sandbox, "registered-project");
        fs.mkdirSync(projectRoot);
        writeNative(path.join(bin, "agy"));
        const appRoot = path.join(home, "Antigravity-x64");
        writeNative(path.join(appRoot, "antigravity"));
        writeFile(path.join(appRoot, "resources", "app.asar"), antigravityAppAsar("2.2.1"));
        writeFile(path.join(appRoot, "resources", "app-update.yml"), "version: 2.2.1");
        writeNative(path.join(appRoot, "resources", "bin", "language_server"));
        const ideRoot = path.join(home, "Antigravity IDE");
        writeNative(path.join(ideRoot, "antigravity-ide"));
        writeFile(
            path.join(ideRoot, "resources", "app", "product.json"),
            JSON.stringify({ applicationName: "antigravity-ide", version: "1.107.0" }),
        );
        writeFile(path.join(ideRoot, "resources", "app", "out", "cli.js"), "");
        writeFile(path.join(ideRoot, "resources", "app", "package.json"), "{}");
        writeFile(
            path.join(home, ".gemini", "config", "projects", "unrelated-incomplete.json"),
            JSON.stringify({ id: "", projectResources: { resources: [] } }),
        );

        const result = await probeAntigravity(projectContext(projectRoot), { PATH: bin }, home);
        const candidate = result.observation.targetCandidates.find((item) => item.targetRootPath === projectRoot);
        const sourceRoot = result.observation.sourceRoots.find((item) => item.path === projectRoot);
        expect(sourceRoot?.locatorEvidence).toEqual([
            {
                locatorKind: "user_provided_path",
                locatorKey: "probe_project_root",
                evidenceLevel: "user_provided",
            },
        ]);
        expect(candidate?.entryApplicabilities).toEqual(
            ["ANTIGRAVITY_CLI", "ANTIGRAVITY_APP", "ANTIGRAVITY_IDE"].map((agentRuntimeId) =>
                expect.objectContaining({
                    agentRuntimeId,
                    status: "ready_for_plan",
                    diagnostics: [],
                    locatorEvidence: [
                        expect.objectContaining({
                            locatorKind: "user_provided_path",
                            locatorKey: "probe_project_root",
                            evidenceLevel: "user_provided",
                        }),
                    ],
                }),
            ),
        );
        expect(result.observation.observedProjects).toEqual([
            expect.objectContaining({
                evidence: [
                    {
                        evidenceKind: "invocation",
                        locatorKey: "probe_project_root",
                        evidenceLevel: "user_provided",
                    },
                ],
            }),
        ]);
        expect(result.diagnostics).not.toContainEqual(
            expect.objectContaining({ code: "antigravity_project_registry_entry_incomplete" }),
        );
    });

    it("keeps CLI target readiness closed for incomplete installation and tainted project bindings", () => {
        const root = {
            sourceRootId: "project-root",
            rootRole: "project_actual" as const,
            sourceDomain: "project_root" as const,
            path: path.join(sandbox, "project"),
            accessStatus: "available" as const,
            locatorEvidence: [
                {
                    locatorKind: "project_registry_entry" as const,
                    locatorKey: "project",
                    evidenceLevel: "local_artifact" as const,
                },
            ],
            diagnostics: [],
        };
        const project = {
            observedProjectId: "project",
            runtimeProjectKey: "project",
            displayName: "Project",
            workspaces: [{ sourceRootId: root.sourceRootId, role: "primary" as const }],
            evidence: [
                {
                    evidenceKind: "agent_runtime_resource" as const,
                    agentRuntimeResourceId: "registry",
                    locatorKey: "project",
                    evidenceLevel: "local_artifact" as const,
                },
            ],
            diagnostics: [],
        };
        const runtime = {
            ...emptyCliRuntime(),
            installationStatus: "available" as const,
            projectDiscoveryStatus: "complete" as const,
            installationEvidence: [
                {
                    kind: "executable" as const,
                    path: path.join(bin, "agy"),
                    evidenceLevel: "local_artifact" as const,
                    diagnostics: [],
                },
            ],
            agentRuntimeResourceIds: ["registry"],
            observedProjectIds: [project.observedProjectId],
        };
        const resource = {
            agentRuntimeResourceId: "registry",
            roles: ["project_registry" as const],
            path: path.join(home, ".gemini", "config", "projects"),
            accessStatus: "available" as const,
            locatorEvidence: [
                {
                    locatorKind: "runtime_known_rule" as const,
                    locatorKey: "projects",
                    evidenceLevel: "local_artifact" as const,
                },
            ],
            diagnostics: [],
        };
        const status = (
            candidateRoot: typeof root,
            candidateProject: typeof project,
            candidateRuntime: typeof runtime,
            candidateResource: typeof resource | undefined,
        ) =>
            materializeAntigravityTargetCandidates(
                [candidateProject],
                new Map([[candidateRoot.sourceRootId, candidateRoot]]),
                candidateRuntime,
                new Map(candidateResource === undefined ? [] : [[candidateResource.agentRuntimeResourceId, candidateResource]]),
            )[0]?.entryApplicabilities[0];

        expect(
            status(root, project, { ...runtime, installationStatus: "unknown", installationEvidence: [] }, resource),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_cli_target_build_evidence_unavailable" })],
        });
        expect(
            status(
                root,
                project,
                {
                    ...runtime,
                    installationEvidence: [
                        {
                            ...runtime.installationEvidence[0],
                            diagnostics: [errorDiagnostic("tainted")],
                        },
                    ],
                },
                resource,
            ),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_cli_target_build_evidence_unavailable" })],
        });
        expect(status(root, project, { ...runtime, projectDiscoveryStatus: "partial" }, resource)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_cli_target_project_discovery_incomplete" })],
        });
        expect(status(root, project, { ...runtime, diagnostics: [errorDiagnostic("runtime-tainted")] }, resource)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_cli_target_project_discovery_incomplete" })],
        });
        expect(status({ ...root, diagnostics: [errorDiagnostic("root-tainted")] }, project, runtime, resource)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_cli_target_project_binding_unverified" })],
        });
        expect(status(root, { ...project, diagnostics: [errorDiagnostic("project-tainted")] }, runtime, resource)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_cli_target_project_binding_unverified" })],
        });
        expect(
            status(
                root,
                {
                    ...project,
                    evidence: [{ evidenceKind: "invocation", locatorKey: "project", evidenceLevel: "user_provided" }],
                },
                runtime,
                resource,
            ),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_cli_target_project_binding_unverified" })],
        });
        expect(status(root, project, runtime, { ...resource, diagnostics: [errorDiagnostic("resource-tainted")] })).toMatchObject(
            {
                status: "unknown",
                diagnostics: [expect.objectContaining({ code: "antigravity_cli_target_project_binding_unverified" })],
            },
        );
        expect(status(root, project, runtime, undefined)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_cli_target_project_binding_unverified" })],
        });

        const authorizedProject = {
            ...project,
            evidence: [
                {
                    evidenceKind: "invocation" as const,
                    locatorKey: "probe_project_root",
                    evidenceLevel: "user_provided" as const,
                },
            ],
        };
        const authorizedRoot = {
            ...root,
            locatorEvidence: [
                {
                    locatorKind: "user_provided_path" as const,
                    locatorKey: "probe_project_root",
                    evidenceLevel: "user_provided" as const,
                },
            ],
        };
        expect(status(authorizedRoot, authorizedProject, runtime, resource)).toMatchObject({
            status: "ready_for_plan",
            diagnostics: [],
        });
        expect(
            status(
                {
                    ...authorizedRoot,
                    locatorEvidence: [
                        {
                            locatorKind: "project_registry_entry",
                            locatorKey: "probe_project_root",
                            evidenceLevel: "user_provided",
                        },
                    ],
                },
                authorizedProject,
                runtime,
                resource,
            ),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_cli_target_project_binding_unverified" })],
        });

        const unrelatedRoot = {
            ...root,
            sourceRootId: "unrelated-root",
            path: path.join(sandbox, "unrelated"),
        };
        const unrelatedProject = {
            ...project,
            observedProjectId: "unrelated-project",
            runtimeProjectKey: "unrelated-project",
            workspaces: [{ sourceRootId: unrelatedRoot.sourceRootId, role: "primary" as const }],
            evidence: [{ evidenceKind: "invocation" as const, locatorKey: "unrelated", evidenceLevel: "user_provided" as const }],
        };
        const unrelatedCandidate = materializeAntigravityTargetCandidates(
            [project, unrelatedProject],
            new Map([
                [root.sourceRootId, root],
                [unrelatedRoot.sourceRootId, unrelatedRoot],
            ]),
            runtime,
            new Map([[resource.agentRuntimeResourceId, resource]]),
        ).find((candidate) => candidate.targetRootPath === unrelatedRoot.path);
        expect(unrelatedCandidate?.entryApplicabilities[0]).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_cli_target_project_binding_unverified" })],
        });

        const globalRoot = {
            ...root,
            sourceRootId: "global-root",
            rootRole: "config" as const,
            sourceDomain: "family_shared" as const,
            path: path.join(home, ".gemini"),
            locatorEvidence: [
                {
                    locatorKind: "runtime_known_rule" as const,
                    locatorKey: "family-root",
                    evidenceLevel: "local_artifact" as const,
                },
            ],
        };
        const globalStatus = (candidateRoot: typeof globalRoot, candidateRuntime: typeof runtime) =>
            materializeAntigravityTargetCandidates(
                [],
                new Map([[candidateRoot.sourceRootId, candidateRoot]]),
                candidateRuntime,
                new Map(),
            )[0]?.entryApplicabilities[0];
        const globalRuntime = { ...runtime, sourceRootIds: [globalRoot.sourceRootId] };
        expect(globalStatus(globalRoot, globalRuntime)).toMatchObject({ status: "ready_for_plan", diagnostics: [] });
        expect(globalStatus(globalRoot, { ...globalRuntime, installationStatus: "not_found" })).toMatchObject({
            status: "invalid",
            diagnostics: [expect.objectContaining({ code: "antigravity_cli_global_target_installation_not_found" })],
        });
        expect(
            globalStatus(globalRoot, {
                ...globalRuntime,
                installationEvidence: [{ ...globalRuntime.installationEvidence[0], diagnostics: [errorDiagnostic("tainted")] }],
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_cli_global_target_build_evidence_unavailable" })],
        });
        expect(globalStatus({ ...globalRoot, locatorEvidence: [] }, globalRuntime)).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "antigravity_cli_global_target_build_evidence_unavailable" })],
        });
    });

    it("keeps malformed project roots individually visible to the existing fail-closed validator", () => {
        const candidates = materializeAntigravityTargetCandidates(
            [
                {
                    observedProjectId: "missing-primary",
                    runtimeProjectKey: "missing-primary",
                    displayName: "Missing primary",
                    workspaces: [],
                    evidence: [],
                    diagnostics: [],
                },
                {
                    observedProjectId: "missing-source-root",
                    runtimeProjectKey: "missing-source-root",
                    displayName: "Missing source root",
                    workspaces: [{ sourceRootId: "unknown-root", role: "primary" }],
                    evidence: [],
                    diagnostics: [],
                },
                {
                    observedProjectId: "empty-source-root",
                    runtimeProjectKey: "empty-source-root",
                    displayName: "Empty source root",
                    workspaces: [{ sourceRootId: "empty-root", role: "primary" }],
                    evidence: [],
                    diagnostics: [],
                },
            ],
            new Map([
                [
                    "empty-root",
                    {
                        sourceRootId: "empty-root",
                        rootRole: "project_actual",
                        sourceDomain: "project_root",
                        path: "",
                        accessStatus: "unknown",
                        locatorEvidence: [],
                        diagnostics: [],
                    },
                ],
            ]),
            emptyCliRuntime(),
            new Map(),
        );

        expect(candidates).toHaveLength(3);
        expect(candidates.every((candidate) => candidate.targetRootPath === "")).toBe(true);
        expect(new Set(candidates.map((candidate) => candidate.targetCandidateId)).size).toBe(3);
        expect(
            candidates
                .flatMap((candidate) => candidate.entryApplicabilities[0]?.locatorEvidence.map((item) => item.locatorKey) ?? [])
                .sort(),
        ).toEqual(["empty-source-root", "missing-primary", "missing-source-root"]);
    });
});

function emptyCliRuntime(): AdapterProbeResult["observation"]["observedAgentRuntimes"][number] {
    return {
        agentRuntimeId: "ANTIGRAVITY_CLI",
        versionText: "",
        installationEvidence: [],
        sourceRootIds: [],
        agentRuntimeResourceIds: [],
        observedProjectIds: [],
        installationStatus: "not_found",
        projectDiscoveryStatus: "not_found",
        diagnostics: [],
    };
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

function writeNative(target: string): void {
    writeFile(target, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), 0o755);
}

function writeFile(target: string, content: string | Uint8Array, mode?: number): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, mode === undefined ? undefined : { mode });
}
