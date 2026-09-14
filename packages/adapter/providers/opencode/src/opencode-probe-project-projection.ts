/** Project-list projection into the existing Core probe graph and physical targets. */

import {
    canonicalProviderHostPathWithinAccessRoot,
    compareCodeUnitText as compareText,
    probeDiagnostic as diagnostic,
    hostPathApiFor,
    runtimeAbsolutePathToHost,
    uniqueSortedStrings as uniqueSorted,
} from "@oaam/adapter-framework";
import type {
    AdapterProbeResult,
    InstallationEvidence,
    OperationDiagnostic,
    PathLocatorEvidence,
    Platform,
    PlatformContext,
    ResourceAccessStatus,
    Sha256Digest,
    SourceRoot,
} from "@oaam/core";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";
import * as crypto from "node:crypto";
import { lstatSync } from "node:fs";
import { type OpencodePathRule, projectSourceLocatorKey } from "./opencode-paths";
import type { OpenCodeProjectRecord } from "./opencode-probe-project-discovery";
import {
    OPENCODE_CLI_PROJECT_GUIDANCE_BUILD_DECLARATION,
    resolveOpencodeTargetBuildCompatibility,
} from "./opencode-target-build-compatibility";

export interface OpenCodeProjectInstallationDisposition {
    readonly status: "available" | "not_found" | "needs_permission" | "unknown";
    readonly evidence: readonly InstallationEvidence[];
    readonly versionText?: string;
    readonly buildIdentity?: Sha256Digest | "";
    readonly platform?: Platform;
}

export function projectObservationsFromRuntimeList(
    records: readonly OpenCodeProjectRecord[],
    registryResource: AdapterProbeResult["observation"]["agentRuntimeResources"][number] | null,
    evidenceLevel: "agent_runtime_verified" | "local_artifact",
    platformContext: PlatformContext,
    sourceRoots: Map<string, SourceRoot>,
): {
    observedProjects: AdapterProbeResult["observation"]["observedProjects"];
    sourceRootIds: string[];
    diagnostics: OperationDiagnostic[];
} {
    const observedProjects: AdapterProbeResult["observation"]["observedProjects"] = [];
    const sourceRootIds: string[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    const ordered = [...records].sort((left, right) =>
        compareText(
            `${left.runtimeProjectKey}\0${left.primaryRuntimePath}`,
            `${right.runtimeProjectKey}\0${right.primaryRuntimePath}`,
        ),
    );
    for (const record of ordered) {
        const primaryPath = runtimeProjectPathToHost(record.primaryRuntimePath, platformContext);
        if (primaryPath === null) {
            diagnostics.push(
                diagnostic(
                    "opencode_project_workspace_outside_selected_environment",
                    "An OpenCode project workspace falls outside the selected physical access root",
                    "partial",
                    "warning",
                    record.primaryRuntimePath,
                ),
            );
            continue;
        }
        const workspaces: AdapterProbeResult["observation"]["observedProjects"][number]["workspaces"] = [];
        const primaryRoot = makeRegistryProjectRoot(primaryPath, `${record.locatorKey}:worktree`, evidenceLevel);
        const primaryTargetKey = physicalTargetKey(primaryPath);
        mergeProjectSourceRoot(sourceRoots, primaryRoot);
        sourceRootIds.push(primaryRoot.sourceRootId);
        workspaces.push({ sourceRootId: primaryRoot.sourceRootId, role: "primary" });

        const additional = new Map<string, string>();
        for (const runtimePath of record.additionalRuntimePaths) {
            const hostPath = runtimeProjectPathToHost(runtimePath, platformContext);
            if (hostPath === null) {
                diagnostics.push(
                    diagnostic(
                        "opencode_project_sandbox_outside_selected_environment",
                        "An OpenCode project sandbox falls outside the selected physical access root",
                        "partial",
                        "warning",
                        runtimePath,
                    ),
                );
                continue;
            }
            if (physicalTargetKey(hostPath) !== primaryTargetKey) additional.set(physicalTargetKey(hostPath), hostPath);
        }
        for (const hostPath of [...additional.values()].sort(compareText)) {
            const root = makeRegistryProjectRoot(hostPath, `${record.locatorKey}:sandbox:${hostPath}`, evidenceLevel);
            mergeProjectSourceRoot(sourceRoots, root);
            sourceRootIds.push(root.sourceRootId);
            workspaces.push({ sourceRootId: root.sourceRootId, role: "additional" });
        }

        const paths = hostPathApiFor(primaryPath);
        if (paths === null) throw new TypeError("OpenCode project path must be canonical absolute");
        observedProjects.push({
            observedProjectId: stableId("project", `${record.runtimeProjectKey}\0${primaryRoot.sourceRootId}`),
            runtimeProjectKey: record.runtimeProjectKey,
            displayName: record.displayName || paths.basename(primaryPath),
            workspaces,
            evidence:
                registryResource === null
                    ? [
                          {
                              evidenceKind: "invocation",
                              locatorKey: record.locatorKey,
                              evidenceLevel,
                          },
                      ]
                    : [
                          {
                              evidenceKind: "agent_runtime_resource",
                              agentRuntimeResourceId: registryResource.agentRuntimeResourceId,
                              locatorKey: record.locatorKey,
                              evidenceLevel,
                          },
                      ],
            diagnostics: primaryRoot.diagnostics,
        });
    }
    observedProjects.sort((left, right) => compareText(left.observedProjectId, right.observedProjectId));
    return { observedProjects, sourceRootIds: uniqueSorted(sourceRootIds), diagnostics };
}

export function buildProjectTargetCandidates(
    projects: AdapterProbeResult["observation"]["observedProjects"],
    sourceRoots: ReadonlyMap<string, SourceRoot>,
    rule: OpencodePathRule,
    cliInstallation: OpenCodeProjectInstallationDisposition,
    appInstallation: OpenCodeProjectInstallationDisposition = { status: "not_found", evidence: [] },
): AdapterProbeResult["observation"]["targetCandidates"] {
    const groups = new Map<string, { roots: SourceRoot[]; projects: typeof projects }>();
    for (const project of projects) {
        const workspace = project.workspaces.find((item) => item.role === "primary");
        const root = workspace === undefined ? undefined : sourceRoots.get(workspace.sourceRootId);
        if (root === undefined) continue;
        const targetKey = physicalTargetKey(root.path);
        const group = groups.get(targetKey);
        if (group === undefined) {
            groups.set(targetKey, { roots: [root], projects: [project] });
        } else {
            group.roots.push(root);
            group.projects.push(project);
        }
    }
    return [...groups.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([targetKey, group]) => {
            const projectsForRoot = [...group.projects].sort((left, right) =>
                compareText(left.observedProjectId, right.observedProjectId),
            );
            const rootsForTarget = [...group.roots].sort((left, right) =>
                compareText(`${left.path}\0${left.sourceRootId}`, `${right.path}\0${right.sourceRootId}`),
            );
            const root = rootsForTarget[0];
            if (root === undefined) throw new TypeError("OpenCode target group must retain one physical root");
            const locatorEvidence = uniqueLocatorEvidence(rootsForTarget.flatMap((item) => item.locatorEvidence));
            return {
                targetCandidateId: stableId("target", targetKey),
                targetRootPath: root.path,
                targetKind: "project" as const,
                displayName: projectsForRoot[0]?.displayName ?? "",
                entryApplicabilities: [
                    projectGuidanceTargetApplicability(
                        "OPENCODE_CLI",
                        "OpenCode CLI",
                        rule,
                        cliInstallation,
                        root,
                        projectsForRoot,
                        locatorEvidence,
                        true,
                    ),
                    projectGuidanceTargetApplicability(
                        "OPENCODE_APP",
                        "OpenCode App",
                        rule,
                        appInstallation,
                        root,
                        projectsForRoot,
                        locatorEvidence,
                        false,
                    ),
                ],
                diagnostics: [],
            };
        });
}

export function buildGlobalTargetCandidates(
    root: SourceRoot | null,
    cliInstallation: OpenCodeProjectInstallationDisposition,
    appInstallation: OpenCodeProjectInstallationDisposition = { status: "not_found", evidence: [] },
): AdapterProbeResult["observation"]["targetCandidates"] {
    if (
        root === null ||
        root.rootRole !== "config" ||
        root.sourceDomain !== "agent_runtime_private" ||
        root.accessStatus !== "available" ||
        root.locatorEvidence.length === 0 ||
        root.diagnostics.some((item) => item.severity === "error")
    ) {
        return [];
    }
    return [
        {
            targetCandidateId: stableId("global-target", physicalTargetKey(root.path)),
            targetRootPath: root.path,
            targetKind: "global",
            displayName: "OpenCode global configuration",
            entryApplicabilities: [
                globalTargetApplicability("OPENCODE_CLI", "OpenCode CLI", cliInstallation, root),
                globalTargetApplicability("OPENCODE_APP", "OpenCode App", appInstallation, root),
            ],
            diagnostics: [],
        },
    ];
}

export function buildSharedSkillTargetCandidates(
    roots: readonly SourceRoot[],
    cliInstallation: OpenCodeProjectInstallationDisposition,
    appInstallation: OpenCodeProjectInstallationDisposition = { status: "not_found", evidence: [] },
): AdapterProbeResult["observation"]["targetCandidates"] {
    return roots
        .filter(
            (root) =>
                root.rootRole === "source" &&
                root.sourceDomain === "family_shared" &&
                root.accessStatus === "available" &&
                root.locatorEvidence.length > 0 &&
                !root.diagnostics.some((item) => item.severity === "error"),
        )
        .sort((left, right) => compareText(`${left.path}\0${left.sourceRootId}`, `${right.path}\0${right.sourceRootId}`))
        .map((root) => ({
            targetCandidateId: stableId("shared-skill-target", physicalTargetKey(root.path)),
            targetRootPath: root.path,
            targetKind: "directory" as const,
            displayName: "OpenCode shared Skill directory",
            entryApplicabilities: [
                sharedSkillTargetApplicability("OPENCODE_CLI", "OpenCode CLI", cliInstallation, root),
                sharedSkillTargetApplicability("OPENCODE_APP", "OpenCode App", appInstallation, root),
            ],
            diagnostics: [],
        }));
}

function sharedSkillTargetApplicability(
    agentRuntimeId: "OPENCODE_CLI" | "OPENCODE_APP",
    displayName: string,
    installation: OpenCodeProjectInstallationDisposition,
    root: SourceRoot,
): AdapterProbeResult["observation"]["targetCandidates"][number]["entryApplicabilities"][number] {
    const base = { agentRuntimeId, locatorEvidence: observedTargetLocatorEvidence(root) };
    const codePrefix = agentRuntimeId === "OPENCODE_CLI" ? "opencode" : "opencode_app";
    if (installation.status === "not_found") {
        return {
            ...base,
            status: "invalid",
            diagnostics: [
                diagnostic(
                    `${codePrefix}_shared_skill_target_installation_not_found`,
                    `${displayName} shared Skill targets require an installed entry`,
                    "not_found",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    const evidenceKind = agentRuntimeId === "OPENCODE_APP" ? "app_bundle" : "executable";
    if (
        installation.status !== "available" ||
        !installation.evidence.some(
            (evidence) =>
                evidence.kind === evidenceKind &&
                (evidence.evidenceLevel === "agent_runtime_verified" || evidence.evidenceLevel === "local_artifact") &&
                !evidence.diagnostics.some((item) => item.severity === "error"),
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    `${codePrefix}_shared_skill_target_build_evidence_unavailable`,
                    `${displayName} shared Skill target planning needs one readable build-bearing entry observation`,
                    installation.status === "needs_permission" ? "permission_denied" : "partial",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    return { ...base, status: "ready_for_plan", diagnostics: [] };
}

function globalTargetApplicability(
    agentRuntimeId: "OPENCODE_CLI" | "OPENCODE_APP",
    displayName: string,
    installation: OpenCodeProjectInstallationDisposition,
    root: SourceRoot,
): AdapterProbeResult["observation"]["targetCandidates"][number]["entryApplicabilities"][number] {
    const base = { agentRuntimeId, locatorEvidence: observedTargetLocatorEvidence(root) };
    const codePrefix = agentRuntimeId === "OPENCODE_CLI" ? "opencode" : "opencode_app";
    if (installation.status === "not_found") {
        return {
            ...base,
            status: "invalid",
            diagnostics: [
                diagnostic(
                    `${codePrefix}_global_target_installation_not_found`,
                    `${displayName} global targets require an installed entry`,
                    "not_found",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    const evidenceKind = agentRuntimeId === "OPENCODE_APP" ? "app_bundle" : "executable";
    if (
        installation.status !== "available" ||
        !installation.evidence.some(
            (evidence) =>
                evidence.kind === evidenceKind &&
                (evidence.evidenceLevel === "agent_runtime_verified" || evidence.evidenceLevel === "local_artifact") &&
                !evidence.diagnostics.some((item) => item.severity === "error"),
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    `${codePrefix}_global_target_build_evidence_unavailable`,
                    `${displayName} global target planning needs one readable build-bearing entry observation`,
                    installation.status === "needs_permission" ? "permission_denied" : "partial",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    return { ...base, status: "ready_for_plan", diagnostics: [] };
}

function observedTargetLocatorEvidence(root: SourceRoot): PathLocatorEvidence[] {
    return uniqueLocatorEvidence(
        root.locatorEvidence.map((evidence) =>
            evidence.evidenceLevel === "source_code" ? { ...evidence, evidenceLevel: "local_artifact" as const } : evidence,
        ),
    );
}

function projectGuidanceTargetApplicability(
    agentRuntimeId: "OPENCODE_CLI" | "OPENCODE_APP",
    displayName: string,
    rule: OpencodePathRule,
    installation: OpenCodeProjectInstallationDisposition,
    root: SourceRoot,
    projects: AdapterProbeResult["observation"]["observedProjects"],
    locatorEvidence: SourceRoot["locatorEvidence"],
    acceptsRegistryAuthority: boolean,
): AdapterProbeResult["observation"]["targetCandidates"][number]["entryApplicabilities"][number] {
    const base = {
        agentRuntimeId,
        locatorEvidence,
    };
    const codePrefix = agentRuntimeId === "OPENCODE_CLI" ? "opencode" : "opencode_app";
    if (!rule.projectConfigEnabled) {
        return {
            ...base,
            status: "invalid",
            diagnostics: [
                diagnostic(
                    `${codePrefix}_project_guidance_disabled`,
                    `${displayName} project Guidance is disabled by OPENCODE_DISABLE_PROJECT_CONFIG`,
                    "unsupported",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (installation.status === "not_found") {
        return {
            ...base,
            status: "invalid",
            diagnostics: [
                diagnostic(
                    `${codePrefix}_target_installation_not_found`,
                    `${displayName} project Guidance cannot be planned without an installed entry`,
                    "not_found",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        installation.status !== "available" ||
        !installation.evidence.some(
            (evidence) =>
                evidence.kind === (agentRuntimeId === "OPENCODE_APP" ? "app_bundle" : "executable") &&
                (evidence.evidenceLevel === "agent_runtime_verified" || evidence.evidenceLevel === "local_artifact"),
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    `${codePrefix}_target_build_evidence_unavailable`,
                    `${displayName} target planning needs one readable build-bearing entry observation`,
                    installation.status === "needs_permission" ? "permission_denied" : "partial",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        root.accessStatus !== "available" ||
        root.diagnostics.some((item) => item.severity === "error") ||
        !hasProjectAuthority(projects, rule, acceptsRegistryAuthority)
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    `${codePrefix}_target_project_authority_incomplete`,
                    `${displayName} target planning requires one exact readable user-selected project root`,
                    root.accessStatus === "needs_permission" ? "permission_denied" : "verification_failed",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (agentRuntimeId !== "OPENCODE_CLI") return { ...base, status: "ready_for_plan", diagnostics: [] };
    if (
        installation.versionText === undefined ||
        installation.versionText === "" ||
        installation.buildIdentity === undefined ||
        installation.buildIdentity === "" ||
        installation.platform === undefined
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    "opencode_target_build_version_unverified",
                    "OpenCode CLI project Guidance planning needs one trustworthy exact-build version observation",
                    "version_incompatible",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    const resolution = resolveOpencodeTargetBuildCompatibility(
        {
            agentRuntimeId,
            versionText: installation.versionText,
            buildIdentity: installation.buildIdentity,
            platform: installation.platform,
        },
        OPENCODE_CLI_PROJECT_GUIDANCE_BUILD_DECLARATION,
    );
    if (resolution.status === "blocked") {
        const code =
            resolution.reason === "denied_build"
                ? "opencode_target_build_denied"
                : resolution.reason === "older_than_earliest_anchor"
                  ? "opencode_target_build_older_than_supported"
                  : "opencode_target_build_unverifiable";
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    code,
                    "The observed OpenCode CLI build cannot be routed to a verified project Guidance contract",
                    "version_incompatible",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    return {
        ...base,
        status: "ready_for_plan",
        diagnostics:
            resolution.status === "compatible"
                ? [
                      diagnostic(
                          "opencode_target_build_compatibility_inferred",
                          `OpenCode ${installation.versionText} uses the nearest verified ${resolution.anchor.versionText} project Guidance contract; this build has not been re-verified`,
                          "partial",
                          "warning",
                          root.path,
                      ),
                  ]
                : [],
    };
}

function hasProjectAuthority(
    projects: AdapterProbeResult["observation"]["observedProjects"],
    rule: OpencodePathRule,
    acceptsRegistryAuthority: boolean,
): boolean {
    return projects.some((project) =>
        project.evidence.some((evidence) => {
            if (evidence.evidenceKind === "invocation") {
                if (evidence.evidenceLevel === "user_provided" && evidence.locatorKey === projectSourceLocatorKey(rule)) {
                    return true;
                }
                return acceptsRegistryAuthority && evidence.evidenceLevel === "agent_runtime_verified";
            }
            return (
                acceptsRegistryAuthority &&
                evidence.evidenceKind === "agent_runtime_resource" &&
                evidence.evidenceLevel === "agent_runtime_verified"
            );
        }),
    );
}

function runtimeProjectPathToHost(runtimePath: string, platformContext: PlatformContext): string | null {
    const hostPath = runtimeAbsolutePathToHost(platformContext.platform, platformContext.accessRootPath, runtimePath);
    return hostPath === null ? null : canonicalProviderHostPathWithinAccessRoot(hostPath, platformContext);
}

function makeRegistryProjectRoot(
    path: string,
    locatorKey: string,
    evidenceLevel: "agent_runtime_verified" | "local_artifact",
): SourceRoot {
    const inspection = inspectDirectory(path);
    return {
        sourceRootId: stableId("source-root", `project_actual\0project_root\0${path}`),
        rootRole: "project_actual",
        sourceDomain: "project_root",
        path,
        accessStatus: inspection.accessStatus,
        locatorEvidence: [
            {
                locatorKind: "project_registry_entry",
                locatorKey,
                evidenceLevel,
            },
        ],
        diagnostics: inspection.diagnostics,
    };
}

function mergeProjectSourceRoot(roots: Map<string, SourceRoot>, root: SourceRoot): void {
    const existing = roots.get(root.sourceRootId);
    if (existing === undefined) {
        roots.set(root.sourceRootId, root);
        return;
    }
    if (
        existing.path !== root.path ||
        existing.rootRole !== root.rootRole ||
        existing.sourceDomain !== root.sourceDomain ||
        existing.accessStatus !== root.accessStatus
    ) {
        throw new TypeError("OpenCode project source-root identity collision");
    }
    roots.set(root.sourceRootId, {
        ...existing,
        locatorEvidence: uniqueLocatorEvidence([...existing.locatorEvidence, ...root.locatorEvidence]),
        diagnostics: uniqueDiagnostics([...existing.diagnostics, ...root.diagnostics]),
    });
}

function inspectDirectory(path: string): { accessStatus: ResourceAccessStatus; diagnostics: OperationDiagnostic[] } {
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
            return {
                accessStatus: "unknown",
                diagnostics: [
                    diagnostic(
                        "opencode_probe_symlink_untrusted",
                        "Probe found a symlink/reparse candidate; Core read authority must resolve it fail-closed",
                        "partial",
                        "warning",
                        path,
                    ),
                ],
            };
        }
        if (stat.isDirectory()) return { accessStatus: "available", diagnostics: [] };
        return {
            accessStatus: "unknown",
            diagnostics: [
                diagnostic(
                    "opencode_probe_resource_kind_mismatch",
                    "Expected a directory at the OpenCode project path",
                    "invalid_schema",
                    "warning",
                    path,
                ),
            ],
        };
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        if (failure.source === "node_errno_error" && (failure.systemCode === "ENOENT" || failure.systemCode === "ENOTDIR")) {
            return { accessStatus: "not_found", diagnostics: [] };
        }
        if (failure.source === "node_errno_error" && failure.failureKind === "permission_denied") {
            return {
                accessStatus: "needs_permission",
                diagnostics: [
                    diagnostic(
                        "opencode_probe_permission_denied",
                        "The OpenCode project path could not be inspected because access was denied",
                        "permission_denied",
                        "warning",
                        path,
                    ),
                ],
            };
        }
        return {
            accessStatus: "unknown",
            diagnostics: [
                diagnostic("opencode_probe_io_error", "Could not inspect the OpenCode project path", "partial", "warning", path),
            ],
        };
    }
}

function uniqueLocatorEvidence(values: readonly PathLocatorEvidence[]): PathLocatorEvidence[] {
    const evidence = new Map<string, PathLocatorEvidence>();
    for (const value of values) {
        evidence.set(`${value.locatorKind}\0${value.locatorKey}\0${value.evidenceLevel}`, value);
    }
    return [...evidence.entries()].sort(([left], [right]) => compareText(left, right)).map(([, value]) => value);
}

function uniqueDiagnostics(values: readonly OperationDiagnostic[]): OperationDiagnostic[] {
    const diagnostics = new Map<string, OperationDiagnostic>();
    for (const value of values) diagnostics.set(`${value.code}\0${value.path}\0${value.message}`, value);
    return [...diagnostics.entries()].sort(([left], [right]) => compareText(left, right)).map(([, value]) => value);
}

function physicalTargetKey(value: string): string {
    return value;
}

function stableId(namespace: string, value: string): string {
    return `${namespace}:${crypto.createHash("sha256").update(`${namespace}\0${value}`, "utf8").digest("hex")}`;
}
