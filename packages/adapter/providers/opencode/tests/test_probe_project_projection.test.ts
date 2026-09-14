import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AdapterProbeObservation, ObservedProject, SourceRoot } from "@oaam/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPathRule } from "../src/opencode-paths";
import {
    buildGlobalTargetCandidates,
    buildProjectTargetCandidates,
    buildSharedSkillTargetCandidates,
    projectObservationsFromRuntimeList,
} from "../src/opencode-probe-project-projection";

let sandbox = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-project-projection-"));
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("OpenCode runtime project projection", () => {
    it("preserves projects while classifying directory, symlink, file and missing workspace roots", () => {
        const directory = path.join(sandbox, "directory");
        const symlink = path.join(sandbox, "symlink");
        const file = path.join(sandbox, "file");
        const missing = path.join(sandbox, "missing");
        fs.mkdirSync(directory);
        fs.symlinkSync(directory, symlink);
        fs.writeFileSync(file, "not a directory");
        const roots = new Map<string, SourceRoot>();
        const projected = projectObservationsFromRuntimeList(
            [
                record("directory", directory, "", [directory, symlink, file, missing]),
                record("symlink", symlink),
                record("file", file),
                record("missing", missing),
            ],
            registryResource(),
            "agent_runtime_verified",
            { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox },
            roots,
        );

        expect(projected.observedProjects).toHaveLength(4);
        expect(projected.observedProjects.find((project) => project.runtimeProjectKey === "directory")?.displayName).toBe(
            "directory",
        );
        expect([...roots.values()]).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ path: directory, accessStatus: "available", diagnostics: [] }),
                expect.objectContaining({
                    path: symlink,
                    accessStatus: "unknown",
                    diagnostics: [expect.objectContaining({ code: "opencode_probe_symlink_untrusted" })],
                }),
                expect.objectContaining({
                    path: file,
                    accessStatus: "unknown",
                    diagnostics: [expect.objectContaining({ code: "opencode_probe_resource_kind_mismatch" })],
                }),
                expect.objectContaining({ path: missing, accessStatus: "not_found", diagnostics: [] }),
            ]),
        );

        const targets = buildProjectTargetCandidates(projected.observedProjects, roots, pathRule(true), availableInstallation());
        expect(targets).toHaveLength(4);
        expect(targets.find((candidate) => candidate.targetRootPath === directory)?.entryApplicabilities[0]?.status).toBe(
            "ready_for_plan",
        );
        for (const rootPath of [symlink, file, missing]) {
            expect(targets.find((candidate) => candidate.targetRootPath === rootPath)?.entryApplicabilities[0]).toMatchObject({
                status: "unknown",
                diagnostics: [expect.objectContaining({ code: "opencode_target_project_authority_incomplete" })],
            });
        }

        const partialRoots = new Map<string, SourceRoot>();
        const partialAdditional = path.join(sandbox, "partial-additional");
        fs.mkdirSync(partialAdditional);
        const partial = projectObservationsFromRuntimeList(
            [record("partial", directory, "", [partialAdditional])],
            null,
            "local_artifact",
            { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox },
            partialRoots,
        );
        expect(partial.observedProjects[0]?.evidence).toEqual([
            expect.objectContaining({ evidenceKind: "invocation", evidenceLevel: "local_artifact" }),
        ]);
        expect([...partialRoots.values()]).toHaveLength(2);
        expect(
            [...partialRoots.values()].flatMap((root) => root.locatorEvidence.map((evidence) => evidence.evidenceLevel)),
        ).toEqual(["local_artifact", "local_artifact"]);
        expect(
            buildProjectTargetCandidates(partial.observedProjects, partialRoots, pathRule(true), availableInstallation())[0]
                ?.entryApplicabilities[0],
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "opencode_target_project_authority_incomplete" })],
        });
    });

    it("fails closed for incomplete authority and merges only an exact canonical physical target", () => {
        const root = sourceRoot("root", "/project", "available");
        const project = observedProject("project", root.sourceRootId);
        const roots = new Map([[root.sourceRootId, root]]);

        expect(
            buildProjectTargetCandidates([observedProject("no-primary", "", [])], roots, pathRule(true), availableInstallation()),
        ).toEqual([]);
        expect(
            buildProjectTargetCandidates(
                [observedProject("missing-root", "absent")],
                roots,
                pathRule(true),
                availableInstallation(),
            ),
        ).toEqual([]);
        expect(candidateStatus(project, root, pathRule(false), availableInstallation())).toMatchObject({
            status: "invalid",
            diagnostics: [expect.objectContaining({ code: "opencode_project_guidance_disabled" })],
        });
        expect(candidateStatus(project, root, pathRule(true), { status: "not_found", evidence: [] })).toMatchObject({
            status: "invalid",
            diagnostics: [expect.objectContaining({ code: "opencode_target_installation_not_found" })],
        });
        expect(candidateStatus(project, root, pathRule(true), { status: "needs_permission", evidence: [] })).toMatchObject({
            status: "unknown",
            diagnostics: [
                expect.objectContaining({ code: "opencode_target_build_evidence_unavailable", causeKind: "permission_denied" }),
            ],
        });
        expect(
            candidateStatus(project, root, pathRule(true), {
                status: "available",
                evidence: [{ kind: "install_root", path: "/install", evidenceLevel: "local_artifact", diagnostics: [] }],
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "opencode_target_build_evidence_unavailable" })],
        });
        expect(candidateStatus(project, root, pathRule(true), availableInstallation())).toMatchObject({
            status: "ready_for_plan",
            diagnostics: [expect.objectContaining({ code: "opencode_target_build_compatibility_inferred" })],
        });
        expect(
            candidateStatus(
                { ...project, evidence: [] },
                { ...root, accessStatus: "needs_permission" },
                pathRule(true),
                availableInstallation(),
            ),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [
                expect.objectContaining({ code: "opencode_target_project_authority_incomplete", causeKind: "permission_denied" }),
            ],
        });
        expect(
            candidateStatus(
                project,
                { ...root, diagnostics: [{ severity: "error", code: "fixture_error", message: "fixture error" }] },
                pathRule(true),
                availableInstallation(),
            ),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "opencode_target_project_authority_incomplete" })],
        });

        const collisionPath = path.join(sandbox, "collision");
        fs.mkdirSync(collisionPath);
        const collisionRoots = new Map<string, SourceRoot>();
        projectObservationsFromRuntimeList(
            [record("collision", collisionPath)],
            registryResource(),
            "agent_runtime_verified",
            { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox },
            collisionRoots,
        );
        const [collisionId, collisionRoot] = [...collisionRoots.entries()][0] ?? [];
        expect(collisionId).toBeTruthy();
        if (collisionId !== undefined && collisionRoot !== undefined) {
            collisionRoots.set(collisionId, { ...collisionRoot, rootRole: "config" });
        }
        expect(() =>
            projectObservationsFromRuntimeList(
                [record("collision", collisionPath)],
                registryResource(),
                "agent_runtime_verified",
                { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox },
                collisionRoots,
            ),
        ).toThrow("OpenCode project source-root identity collision");

        const first = sourceRoot("first", "\\\\wsl.localhost\\Ubuntu\\Project", "available", "debug_scrap:first:worktree");
        const second = sourceRoot("second", first.path, "available", "debug_scrap:second:worktree");
        const exactProjects = [observedProject("first", first.sourceRootId), observedProject("second", second.sourceRootId)];
        const exactRoots = new Map([
            [first.sourceRootId, first],
            [second.sourceRootId, second],
        ]);
        const buildExact = (projects: ObservedProject[]) =>
            buildProjectTargetCandidates(projects, exactRoots, { ...pathRule(true), platform: "win32" }, availableInstallation());
        const forward = buildExact(exactProjects);
        const reversed = buildExact([...exactProjects].reverse());
        expect(forward).toHaveLength(1);
        expect(forward[0]?.entryApplicabilities[0]?.locatorEvidence).toHaveLength(2);
        expect(forward).toEqual(reversed);

        const upper = sourceRoot("upper", "\\\\wsl.localhost\\Ubuntu\\Project", "available");
        const lower = sourceRoot("lower", "\\\\wsl.localhost\\Ubuntu\\project", "available");
        expect(
            buildProjectTargetCandidates(
                [observedProject("upper", upper.sourceRootId), observedProject("lower", lower.sourceRootId)],
                new Map([
                    [upper.sourceRootId, upper],
                    [lower.sourceRootId, lower],
                ]),
                { ...pathRule(true), platform: "win32" },
                availableInstallation(),
            ),
        ).toHaveLength(2);
    });

    it("routes project Guidance through the same build anchors used by render analysis", () => {
        const root = sourceRoot("root", "/project", "available");
        const project = observedProject("project", root.sourceRootId);
        const rule = pathRule(true);

        expect(candidateStatus(project, root, rule, availableInstallation())).toMatchObject({
            status: "ready_for_plan",
            diagnostics: [
                expect.objectContaining({
                    code: "opencode_target_build_compatibility_inferred",
                    message: expect.stringContaining("1.17.11"),
                }),
            ],
        });
        expect(
            candidateStatus(project, root, rule, {
                ...availableInstallation(),
                versionText: "1.17.10",
                buildIdentity: `sha256:${"b".repeat(64)}`,
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "opencode_target_build_older_than_supported" })],
        });
        expect(
            candidateStatus(project, root, rule, {
                ...availableInstallation(),
                versionText: "",
                buildIdentity: "",
            }),
        ).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "opencode_target_build_version_unverified" })],
        });
    });

    it("projects one exact global config root without borrowing installation evidence", () => {
        const root: SourceRoot = {
            sourceRootId: "global-root",
            rootRole: "config",
            sourceDomain: "agent_runtime_private",
            path: path.join(sandbox, "global-config"),
            accessStatus: "available",
            locatorEvidence: [
                {
                    locatorKind: "runtime_known_rule",
                    locatorKey: "opencode_global_config:default",
                    evidenceLevel: "source_code",
                },
            ],
            diagnostics: [],
        };
        const appInstallation = {
            status: "available" as const,
            evidence: [
                {
                    kind: "app_bundle" as const,
                    path: "/app/opencode",
                    evidenceLevel: "local_artifact" as const,
                    diagnostics: [],
                },
            ],
        };
        expect(buildGlobalTargetCandidates(root, availableInstallation(), appInstallation)).toEqual([
            expect.objectContaining({
                targetRootPath: root.path,
                targetKind: "global",
                entryApplicabilities: [
                    expect.objectContaining({ agentRuntimeId: "OPENCODE_CLI", status: "ready_for_plan" }),
                    expect.objectContaining({ agentRuntimeId: "OPENCODE_APP", status: "ready_for_plan" }),
                ],
            }),
        ]);
        expect(buildGlobalTargetCandidates(null, availableInstallation(), appInstallation)).toEqual([]);
        expect(buildGlobalTargetCandidates({ ...root, accessStatus: "not_found" }, availableInstallation())).toEqual([]);
        expect(
            buildGlobalTargetCandidates(
                { ...root, diagnostics: [{ severity: "error", code: "fixture_error", message: "fixture error" }] },
                availableInstallation(),
            ),
        ).toEqual([]);
        expect(
            buildGlobalTargetCandidates(
                root,
                { status: "needs_permission", evidence: [] },
                { status: "not_found", evidence: [] },
            )[0]?.entryApplicabilities,
        ).toEqual([
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_CLI",
                status: "unknown",
                diagnostics: [expect.objectContaining({ code: "opencode_global_target_build_evidence_unavailable" })],
            }),
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_APP",
                status: "invalid",
                diagnostics: [expect.objectContaining({ code: "opencode_app_global_target_installation_not_found" })],
            }),
        ]);
    });

    it("projects each trusted shared Skill root with entry-exact installation evidence", () => {
        const agents = sharedSkillRoot("agents", path.join(sandbox, "home", ".agents", "skills"));
        const claude = sharedSkillRoot("claude", path.join(sandbox, "home", ".claude", "skills"));
        const appInstallation = {
            status: "available" as const,
            evidence: [
                {
                    kind: "app_bundle" as const,
                    path: "/app/opencode",
                    evidenceLevel: "agent_runtime_verified" as const,
                    diagnostics: [],
                },
            ],
        };

        expect(buildSharedSkillTargetCandidates([claude, agents], availableInstallation(), appInstallation)).toEqual([
            expect.objectContaining({
                targetRootPath: agents.path,
                targetKind: "directory",
                entryApplicabilities: [
                    expect.objectContaining({ agentRuntimeId: "OPENCODE_CLI", status: "ready_for_plan" }),
                    expect.objectContaining({ agentRuntimeId: "OPENCODE_APP", status: "ready_for_plan" }),
                ],
            }),
            expect.objectContaining({
                targetRootPath: claude.path,
                targetKind: "directory",
                entryApplicabilities: [
                    expect.objectContaining({ agentRuntimeId: "OPENCODE_CLI", status: "ready_for_plan" }),
                    expect.objectContaining({ agentRuntimeId: "OPENCODE_APP", status: "ready_for_plan" }),
                ],
            }),
        ]);
    });

    it("fails closed for untrusted shared Skill roots and incomplete entry evidence", () => {
        const root = sharedSkillRoot("agents", path.join(sandbox, "home", ".agents", "skills"));
        expect(
            buildSharedSkillTargetCandidates(
                [
                    { ...root, rootRole: "config" },
                    { ...root, sourceDomain: "agent_runtime_private" },
                    { ...root, accessStatus: "not_found" },
                    { ...root, locatorEvidence: [] },
                    { ...root, diagnostics: [{ severity: "error", code: "fixture", message: "blocked" }] },
                ],
                availableInstallation(),
            ),
        ).toEqual([]);
        expect(
            buildSharedSkillTargetCandidates(
                [root],
                { status: "needs_permission", evidence: [] },
                { status: "not_found", evidence: [] },
            )[0]?.entryApplicabilities,
        ).toEqual([
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_CLI",
                status: "unknown",
                diagnostics: [expect.objectContaining({ code: "opencode_shared_skill_target_build_evidence_unavailable" })],
            }),
            expect.objectContaining({
                agentRuntimeId: "OPENCODE_APP",
                status: "invalid",
                diagnostics: [expect.objectContaining({ code: "opencode_app_shared_skill_target_installation_not_found" })],
            }),
        ]);
    });
});

function record(
    runtimeProjectKey: string,
    primaryRuntimePath: string,
    displayName = runtimeProjectKey,
    additionalRuntimePaths: readonly string[] = [],
) {
    return {
        runtimeProjectKey,
        displayName,
        primaryRuntimePath,
        additionalRuntimePaths,
        locatorKey: `debug_scrap:${runtimeProjectKey}`,
    };
}

function registryResource(): AdapterProbeObservation["agentRuntimeResources"][number] {
    return {
        agentRuntimeResourceId: "registry",
        roles: ["project_registry"],
        path: path.join(sandbox, "opencode.db"),
        accessStatus: "available",
        locatorEvidence: [
            {
                locatorKind: "runtime_known_rule",
                locatorKey: "opencode_database_default",
                evidenceLevel: "agent_runtime_verified",
            },
        ],
        diagnostics: [],
    };
}

function sourceRoot(
    sourceRootId: string,
    rootPath: string,
    accessStatus: SourceRoot["accessStatus"],
    locatorKey = "debug_scrap:project:worktree",
): SourceRoot {
    return {
        sourceRootId,
        rootRole: "project_actual",
        sourceDomain: "project_root",
        path: rootPath,
        accessStatus,
        locatorEvidence: [
            {
                locatorKind: "project_registry_entry",
                locatorKey,
                evidenceLevel: "agent_runtime_verified",
            },
        ],
        diagnostics: [],
    };
}

function observedProject(
    observedProjectId: string,
    sourceRootId: string,
    workspaces: ObservedProject["workspaces"] = [{ sourceRootId, role: "primary" }],
): ObservedProject {
    return {
        observedProjectId,
        runtimeProjectKey: observedProjectId,
        displayName: observedProjectId,
        workspaces,
        evidence: [
            {
                evidenceKind: "agent_runtime_resource",
                agentRuntimeResourceId: "registry",
                locatorKey: `debug_scrap:${observedProjectId}`,
                evidenceLevel: "agent_runtime_verified",
            },
        ],
        diagnostics: [],
    };
}

function pathRule(projectConfigEnabled: boolean) {
    const rule = getPathRule("linux", {}, path.join(sandbox, "home"));
    if (rule === null) throw new TypeError("fixture path rule must resolve");
    return { ...rule, projectConfigEnabled };
}

function availableInstallation() {
    return {
        status: "available" as const,
        evidence: [
            { kind: "executable" as const, path: "/bin/opencode", evidenceLevel: "local_artifact" as const, diagnostics: [] },
        ],
        versionText: "1.18.11",
        buildIdentity: `sha256:${"8eb15fe87080dd11aa095cc0391eb3536d55a46fa9e4427c6a8b664d390ac089"}` as const,
        platform: "wsl" as const,
    };
}

function sharedSkillRoot(sourceRootId: string, rootPath: string): SourceRoot {
    return {
        sourceRootId,
        rootRole: "source",
        sourceDomain: "family_shared",
        path: rootPath,
        accessStatus: "available",
        locatorEvidence: [
            {
                locatorKind: "runtime_known_rule",
                locatorKey: `opencode_shared_skill_root:${sourceRootId}`,
                evidenceLevel: "source_code",
            },
        ],
        diagnostics: [],
    };
}

function candidateStatus(
    project: ObservedProject,
    root: SourceRoot,
    rule: NonNullable<ReturnType<typeof getPathRule>>,
    installation: Parameters<typeof buildProjectTargetCandidates>[3],
) {
    return buildProjectTargetCandidates([project], new Map([[root.sourceRootId, root]]), rule, installation)[0]
        ?.entryApplicabilities[0];
}
