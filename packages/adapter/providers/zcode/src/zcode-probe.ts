/** ZCode App installation, source-root, and project discovery. This module never mutates disk. */

import * as path from "node:path";

import {
    canonicalProviderHostPathWithinAccessRoot,
    hostAbsolutePathToRuntime,
    hostPathApiFor,
    resolveProviderProbeEnvironment,
} from "@oaam/adapter-framework";
import type {
    AdapterProbeContext,
    AdapterProbeResult,
    ObservedAgentRuntime,
    OperationDiagnostic,
    ProjectDiscoveryStatus,
    SourceRoot,
} from "@oaam/core";
import { getHomeDir } from "@oaam/shared/paths";
import {
    createZcodeRuntimeConfigResolver,
    type ResolvedZcodeConfigPath,
    type ZcodeRuntimeConfigResolver,
    type ZcodeRuntimeConfigResolverInput,
} from "./zcode-probe-config-paths";
import {
    addZcodeSourceRoot,
    associateZcodeRootWithProject,
    diagnostic,
    makeZcodeResource,
    makeZcodeSourceRoot,
    makeZcodeUserRoot,
    type ResolvedZcodePath,
    stableZcodeId,
    uniqueSortedStrings,
} from "./zcode-probe-foundation";
import { findZcodeAppInstallation } from "./zcode-probe-installation";
import { resolveZcodeProjectMemoryRootFromConfig } from "./zcode-probe-memory-paths";
import { readZcodeProjectRegistry } from "./zcode-probe-project-registry";
/** Core routes selected WSL probes into Linux before invoking this Provider. */
export async function probeZcode(
    context: AdapterProbeContext,
    environment: NodeJS.ProcessEnv = process.env,
    homeDir: string = getHomeDir(),
    hostPlatform: NodeJS.Platform = process.platform,
): Promise<AdapterProbeResult> {
    const selected = resolveProviderProbeEnvironment(context.platformContext, environment, homeDir, hostPlatform);
    if (selected === null) return unreachablePlatformResult(context);

    environment = selected.environment;
    homeDir = selected.homePath;
    const paths = hostPathApiFor(homeDir) as Exclude<ReturnType<typeof hostPathApiFor>, null>;

    const diagnostics: OperationDiagnostic[] = [];

    const dataRoot: ResolvedZcodePath = {
        path: paths.join(homeDir, ".zcode"),
        locatorKind: "runtime_known_rule",
        locatorKey: "zcode_user_data_root",
    };
    const v2Root = resolveV2Root(environment, homeDir, context);
    if (v2Root === null) {
        const invalid = diagnostic(
            "zcode_data_base_override_invalid",
            "ZCODE_DATA_BASE_DIR must resolve inside the selected physical access root",
            "invalid_schema",
            "warning",
            environment.ZCODE_DATA_BASE_DIR?.trim() ?? "",
        );
        return { status: "partial", observation: emptyObservation(unknownRuntime(invalid)), diagnostics: [invalid] };
    }

    const sourceRoots = new Map<string, SourceRoot>();
    const runtimeSourceRootIds: string[] = [];
    const globalSkillRootIdsByPath = new Map<string, string>();
    const configResolverInput: ZcodeRuntimeConfigResolverInput = {
        environment,
        homeDir,
        platformContext: context.platformContext,
    };
    const configResolver = createZcodeRuntimeConfigResolver(configResolverInput);
    diagnostics.push(...configResolver.diagnostics);
    let sourceLocationsResolved = configResolver.complete;
    runtimeSourceRootIds.push(
        addZcodeSourceRoot(sourceRoots, makeZcodeSourceRoot(dataRoot, "config", "agent_runtime_private", "source_code")),
    );
    addSkillSourceRoot(
        sourceRoots,
        runtimeSourceRootIds,
        globalSkillRootIdsByPath,
        {
            path: paths.join(dataRoot.path, "skills"),
            locatorKind: "runtime_known_rule",
            locatorKey: "zcode_user_skill_root",
        },
        "agent_runtime_private",
    );
    addSkillSourceRoot(
        sourceRoots,
        runtimeSourceRootIds,
        globalSkillRootIdsByPath,
        {
            path: paths.join(homeDir, ".agents", "skills"),
            locatorKind: "runtime_known_rule",
            locatorKey: "zcode_shared_skill_root",
        },
        "family_shared",
    );
    for (const root of configResolver.global.skillRoots) {
        addSkillSourceRoot(sourceRoots, runtimeSourceRootIds, globalSkillRootIdsByPath, root, "external_managed");
    }
    if (configResolver.global.storageRoot !== null) {
        addGlobalAgentRoot(sourceRoots, runtimeSourceRootIds, configResolver.global.storageRoot);
    }
    runtimeSourceRootIds.push(
        addZcodeSourceRoot(
            sourceRoots,
            makeZcodeSourceRoot(
                {
                    path: paths.join(homeDir, ".agents", "commands"),
                    locatorKind: "runtime_known_rule",
                    locatorKey: "zcode_shared_command_root",
                },
                "source",
                "family_shared",
                "source_code",
            ),
        ),
    );
    const configResource = makeZcodeResource(
        {
            path: paths.join(dataRoot.path, "cli", "config.json"),
            locatorKind: "runtime_known_rule",
            locatorKey: "zcode_cli_config",
        },
        ["agent_runtime_data"],
    );
    const registryResource = makeZcodeResource(
        {
            path: paths.join(v2Root.path, "tasks-index.sqlite"),
            locatorKind: v2Root.locatorKind,
            locatorKey: `${v2Root.locatorKey}:tasks-index.sqlite`,
        },
        ["project_registry"],
    );
    const resources = [configResource, registryResource];

    const observedProjects: AdapterProbeResult["observation"]["observedProjects"] = [];
    const observedProjectIds: string[] = [];
    const memoryTargetRootIds = new Set<string>();
    let projectDiscoveryStatus: ProjectDiscoveryStatus = "not_found";
    if (context.authorizationScope === "project") {
        const projectPath = canonicalProviderHostPathWithinAccessRoot(context.projectRootPath, context.platformContext);
        if (projectPath === null) {
            projectDiscoveryStatus = "partial";
            diagnostics.push(
                diagnostic(
                    "zcode_project_root_invalid",
                    "The authorized ZCode project root is not canonical inside the selected access root",
                    "invalid_schema",
                    "error",
                    context.projectRootPath,
                ),
            );
        } else {
            const projectRoot = makeZcodeUserRoot(projectPath, "project_actual", "project_root", "probe_project_root");
            runtimeSourceRootIds.push(addZcodeSourceRoot(sourceRoots, projectRoot));
            const runtimePath =
                hostAbsolutePathToRuntime(
                    context.platformContext.platform,
                    context.platformContext.accessRootPath,
                    projectPath,
                ) ?? projectPath;
            const observedProjectId = stableZcodeId("project", runtimePath);
            observedProjectIds.push(observedProjectId);
            observedProjects.push({
                observedProjectId,
                runtimeProjectKey: runtimePath,
                displayName: paths.basename(projectPath),
                workspaces: [{ sourceRootId: projectRoot.sourceRootId, role: "primary" }],
                evidence: [{ evidenceKind: "invocation", locatorKey: "probe_project_root", evidenceLevel: "user_provided" }],
                diagnostics: projectRoot.diagnostics,
            });
            const projectSources = addProjectRuntimeSourceRoots(
                sourceRoots,
                runtimeSourceRootIds,
                diagnostics,
                configResolver,
                configResolverInput,
                projectPath,
                runtimePath,
                "user_provided_path",
                "user_selection",
                "user_provided",
            );
            sourceLocationsResolved = projectSources.complete && sourceLocationsResolved;
            if (projectSources.memorySourceRootId !== null) memoryTargetRootIds.add(projectSources.memorySourceRootId);
            projectDiscoveryStatus = projectStatusForRoot(projectRoot);
        }
    } else if (context.authorizationScope === "directory") {
        const directoryPath = canonicalProviderHostPathWithinAccessRoot(context.directoryRootPath, context.platformContext);
        if (directoryPath === null) {
            diagnostics.push(
                diagnostic(
                    "zcode_external_root_invalid",
                    "The authorized ZCode external root is not canonical inside the selected access root",
                    "invalid_schema",
                    "error",
                    context.directoryRootPath,
                ),
            );
        } else {
            runtimeSourceRootIds.push(
                addZcodeSourceRoot(
                    sourceRoots,
                    makeZcodeUserRoot(directoryPath, "source", "external_managed", "probe_directory_root"),
                ),
            );
        }
    } else {
        projectDiscoveryStatus = projectStatusForRegistry(registryResource.accessStatus);
        if (registryResource.accessStatus === "available") {
            const registry = readZcodeProjectRegistry(registryResource.path, context.platformContext);
            diagnostics.push(...registry.diagnostics);
            projectDiscoveryStatus = registry.status;
            for (const project of registry.projects) {
                const projectRoot = makeZcodeSourceRoot(
                    {
                        path: project.hostPath,
                        locatorKind: "project_registry_entry",
                        locatorKey: project.locatorKey,
                    },
                    "project_actual",
                    "project_root",
                    "local_artifact",
                );
                runtimeSourceRootIds.push(addZcodeSourceRoot(sourceRoots, projectRoot));
                const observedProjectId = stableZcodeId("project", `${project.runtimeProjectKey}\0${project.hostPath}`);
                observedProjectIds.push(observedProjectId);
                observedProjects.push({
                    observedProjectId,
                    runtimeProjectKey: project.runtimeProjectKey,
                    displayName: paths.basename(project.hostPath),
                    workspaces: [{ sourceRootId: projectRoot.sourceRootId, role: "primary" }],
                    evidence: [
                        {
                            evidenceKind: "agent_runtime_resource",
                            agentRuntimeResourceId: registryResource.agentRuntimeResourceId,
                            locatorKey: project.locatorKey,
                            evidenceLevel: "local_artifact",
                        },
                    ],
                    diagnostics: projectRoot.diagnostics,
                });
                const projectSources = addProjectRuntimeSourceRoots(
                    sourceRoots,
                    runtimeSourceRootIds,
                    diagnostics,
                    configResolver,
                    configResolverInput,
                    project.hostPath,
                    project.runtimePath,
                    "project_registry_entry",
                    project.locatorKey,
                    "local_artifact",
                );
                sourceLocationsResolved = projectSources.complete && sourceLocationsResolved;
                if (projectSources.memorySourceRootId !== null) memoryTargetRootIds.add(projectSources.memorySourceRootId);
            }
        }
    }

    if (configResolver.projectContextRequired && observedProjects.length === 0) {
        sourceLocationsResolved = false;
        diagnostics.push(
            diagnostic(
                "zcode_config_project_context_required",
                "Relative ZCode storage or Skill roots require an observed project and are withheld from this snapshot",
                "partial",
                "warning",
                "zcode_user_config",
            ),
        );
    }

    const installation = findZcodeAppInstallation(environment, homeDir, context.platformContext, context.installationRootPath);
    diagnostics.push(...installation.diagnostics);
    const dataSource = sourceRoots.get(runtimeSourceRootIds[0] as string);
    if (dataSource?.accessStatus === "available" && installation.status !== "available") {
        diagnostics.push(
            diagnostic(
                "zcode_residual_sources_without_installation",
                "ZCode source files exist but no verified App installation was found; source presence is not installation evidence",
                "partial",
                "warning",
                dataRoot.path,
            ),
        );
    }

    const projectTargetCandidates = observedProjects.map((project) => {
        const projectRoot = sourceRoots.get(project.workspaces[0]?.sourceRootId ?? "");
        return makeZcodeTargetCandidate(
            "target",
            project.observedProjectId,
            projectRoot,
            "project",
            project.displayName,
            installation,
        );
    });
    const globalTargetCandidates =
        dataSource?.accessStatus === "available" && dataSource.diagnostics.every((item) => item.severity !== "error")
            ? [
                  makeZcodeTargetCandidate(
                      "global-target",
                      dataSource.sourceRootId,
                      dataSource,
                      "global",
                      "ZCode global configuration",
                      installation,
                  ),
              ]
            : [];
    const globalSkillTargetCandidates = [...new Set(globalSkillRootIdsByPath.values())].flatMap((sourceRootId) => {
        const root = sourceRoots.get(sourceRootId);
        return root?.accessStatus === "available" && root.diagnostics.every((item) => item.severity !== "error")
            ? [
                  makeZcodeTargetCandidate(
                      "skill-target",
                      root.sourceRootId,
                      root,
                      "directory",
                      `ZCode Skill directory (${paths.basename(root.path)})`,
                      installation,
                  ),
              ]
            : [];
    });
    const memoryTargetCandidates = [...memoryTargetRootIds].sort().flatMap((sourceRootId) => {
        const root = sourceRoots.get(sourceRootId);
        // A deterministic project-keyed Memory directory is a valid target
        // even before the runtime (or OAAM) has created it. Unknown,
        // permission-denied, or structurally invalid roots remain withheld.
        return root !== undefined && sourceRootResolved(root) && root.diagnostics.every((item) => item.severity !== "error")
            ? [
                  makeZcodeTargetCandidate(
                      "memory-target",
                      root.sourceRootId,
                      root,
                      "directory",
                      `ZCode project Memory (${paths.basename(root.path)})`,
                      installation,
                  ),
              ]
            : [];
    });
    const targetCandidates = [
        ...projectTargetCandidates,
        ...globalTargetCandidates,
        ...globalSkillTargetCandidates,
        ...memoryTargetCandidates,
    ].sort((left, right) =>
        left.targetRootPath === right.targetRootPath
            ? left.targetCandidateId.localeCompare(right.targetCandidateId)
            : left.targetRootPath.localeCompare(right.targetRootPath),
    );

    const roots = [...sourceRoots.values()].sort((left, right) => left.sourceRootId.localeCompare(right.sourceRootId));
    diagnostics.push(...roots.flatMap((root) => root.diagnostics), ...resources.flatMap((resource) => resource.diagnostics));
    const runtime = observedRuntime(
        installation,
        uniqueSortedStrings(runtimeSourceRootIds),
        resources.map((resource) => resource.agentRuntimeResourceId),
        observedProjectIds,
        projectDiscoveryStatus,
    );
    const complete =
        runtime.installationStatus !== "unknown" &&
        runtime.installationStatus !== "needs_permission" &&
        runtime.projectDiscoveryStatus !== "unknown" &&
        runtime.projectDiscoveryStatus !== "partial" &&
        runtime.projectDiscoveryStatus !== "needs_permission" &&
        roots.every((root) => root.accessStatus !== "unknown" && root.accessStatus !== "needs_permission") &&
        resources.every((resource) => resource.accessStatus !== "unknown" && resource.accessStatus !== "needs_permission") &&
        sourceLocationsResolved;

    return {
        status: complete ? "complete" : "partial",
        observation: {
            observedAgentRuntimes: [runtime],
            sourceRoots: roots,
            agentRuntimeResources: resources,
            observedProjects,
            targetCandidates,
        },
        diagnostics,
    };
}

function unreachablePlatformResult(context: AdapterProbeContext): AdapterProbeResult {
    const mismatch = diagnostic(
        "zcode_probe_platform_unreachable",
        "The current process cannot inspect the selected platform filesystem",
        "partial",
        "warning",
        context.platformContext.accessRootPath,
    );
    return { status: "partial", observation: emptyObservation(unknownRuntime(mismatch)), diagnostics: [mismatch] };
}

function makeZcodeTargetCandidate(
    idKind: string,
    idValue: string,
    root: SourceRoot | undefined,
    targetKind: "project" | "global" | "directory",
    displayName: string,
    installation: ReturnType<typeof findZcodeAppInstallation>,
): AdapterProbeResult["observation"]["targetCandidates"][number] {
    const hasExactConsumer = installation.evidence.some((evidence) => evidence.kind === "app_bundle");
    const status =
        root === undefined
            ? ("invalid" as const)
            : installation.status === "available" && hasExactConsumer
              ? ("ready_for_plan" as const)
              : installation.status === "not_found"
                ? ("invalid" as const)
                : ("unknown" as const);
    return {
        targetCandidateId: stableZcodeId(idKind, idValue),
        targetRootPath: root?.path ?? "",
        targetKind,
        displayName,
        entryApplicabilities: [
            {
                agentRuntimeId: "ZCODE_APP",
                status,
                locatorEvidence: observedTargetLocatorEvidence(root),
                diagnostics:
                    status === "ready_for_plan"
                        ? []
                        : [
                              diagnostic(
                                  status === "invalid"
                                      ? "zcode_target_installation_not_found"
                                      : "zcode_target_build_evidence_unavailable",
                                  status === "invalid"
                                      ? "ZCode targets cannot be planned without an installed ZCode App and an exact target root"
                                      : "ZCode targets need one readable exact consumer bundle before planning",
                                  status === "invalid" ? "not_found" : "partial",
                                  "warning",
                                  root?.path ?? "",
                              ),
                          ],
            },
        ],
        diagnostics: [],
    };
}

function observedTargetLocatorEvidence(root: SourceRoot | undefined): SourceRoot["locatorEvidence"] {
    return (root?.locatorEvidence ?? []).map((evidence) =>
        evidence.evidenceLevel === "source_code" || evidence.evidenceLevel === "docs_declared"
            ? { ...evidence, evidenceLevel: "local_artifact" as const }
            : evidence,
    );
}

function addGlobalSourceRoot(
    roots: Map<string, SourceRoot>,
    sourceRootIds: string[],
    resolved: ResolvedZcodePath,
    sourceDomain: "agent_runtime_private" | "family_shared" | "external_managed",
): void {
    sourceRootIds.push(addZcodeSourceRoot(roots, makeZcodeSourceRoot(resolved, "source", sourceDomain, "source_code")));
}

function addSkillSourceRoot(
    roots: Map<string, SourceRoot>,
    sourceRootIds: string[],
    rootIdsByPath: Map<string, string>,
    resolved: ResolvedZcodePath,
    sourceDomain: "agent_runtime_private" | "family_shared" | "project_root" | "external_managed",
    association?: {
        locatorKind: "project_registry_entry" | "user_provided_path";
        locatorKey: string;
        evidenceLevel: "local_artifact" | "user_provided";
    },
): SourceRoot {
    const candidate = makeZcodeSourceRoot(resolved, "source", sourceDomain, "source_code");
    const root =
        association === undefined
            ? candidate
            : associatedProjectRoot(candidate, association.locatorKind, association.locatorKey, association.evidenceLevel);
    const pathIdentity = skillRootPathIdentity(root.path);
    const existingId = rootIdsByPath.get(pathIdentity);
    const existing = existingId === undefined ? undefined : roots.get(existingId);
    if (existing !== undefined) {
        const locatorEvidence = [...existing.locatorEvidence];
        for (const evidence of root.locatorEvidence) {
            if (
                !locatorEvidence.some(
                    (item) =>
                        item.locatorKind === evidence.locatorKind &&
                        item.locatorKey === evidence.locatorKey &&
                        item.evidenceLevel === evidence.evidenceLevel,
                )
            ) {
                locatorEvidence.push(evidence);
            }
        }
        roots.set(existing.sourceRootId, { ...existing, locatorEvidence });
        return existing;
    }
    sourceRootIds.push(addZcodeSourceRoot(roots, root));
    rootIdsByPath.set(pathIdentity, root.sourceRootId);
    return root;
}

function skillRootPathIdentity(value: string): string {
    return hostPathApiFor(value) === path.win32 ? value.toLowerCase() : value;
}

function addGlobalAgentRoot(roots: Map<string, SourceRoot>, sourceRootIds: string[], storageRoot: ResolvedZcodeConfigPath): void {
    const paths = hostPathApiFor(storageRoot.path);
    if (paths === null) return;
    addGlobalSourceRoot(
        roots,
        sourceRootIds,
        { ...storageRoot, path: paths.join(storageRoot.path, "agents") },
        "agent_runtime_private",
    );
}

function addProjectRuntimeSourceRoots(
    roots: Map<string, SourceRoot>,
    sourceRootIds: string[],
    diagnostics: OperationDiagnostic[],
    configResolver: ZcodeRuntimeConfigResolver,
    configResolverInput: ZcodeRuntimeConfigResolverInput,
    hostProjectPath: string,
    runtimeProjectPath: string,
    projectLocatorKind: "project_registry_entry" | "user_provided_path",
    projectLocatorKey: string,
    projectEvidenceLevel: "local_artifact" | "user_provided",
): { complete: boolean; memorySourceRootId: string | null } {
    const project = { hostProjectPath, runtimeProjectPath };
    const config = configResolver.resolveProject(project);
    diagnostics.push(...config.diagnostics);
    let complete = config.complete;
    const paths = hostPathApiFor(hostProjectPath);
    if (paths === null) return { complete: false, memorySourceRootId: null };
    const skillRootIdsByPath = new Map<string, string>();
    const defaultBases = config.projectConfigDirectories.length > 0 ? config.projectConfigDirectories : [hostProjectPath];
    for (const base of defaultBases) {
        for (const [relativePath, locatorKey] of [
            [".zcode/skills", "zcode_project_skill_root"],
            [".agents/skills", "zcode_project_shared_skill_root"],
        ] as const) {
            const root = addSkillSourceRoot(
                roots,
                sourceRootIds,
                skillRootIdsByPath,
                {
                    path: paths.join(base, ...relativePath.split("/")),
                    locatorKind: "runtime_known_rule",
                    locatorKey,
                },
                "project_root",
                {
                    locatorKind: projectLocatorKind,
                    locatorKey: projectLocatorKey,
                    evidenceLevel: projectEvidenceLevel,
                },
            );
            complete = sourceRootResolved(root) && complete;
        }
    }
    for (const configuredRoot of config.skillRoots.filter((root) => root.association === "project")) {
        const root = addSkillSourceRoot(roots, sourceRootIds, skillRootIdsByPath, configuredRoot, "external_managed", {
            locatorKind: projectLocatorKind,
            locatorKey: projectLocatorKey,
            evidenceLevel: projectEvidenceLevel,
        });
        complete = sourceRootResolved(root) && complete;
    }
    if (config.storageRoot?.association === "project") {
        const storagePaths = hostPathApiFor(config.storageRoot.path);
        if (storagePaths === null) {
            complete = false;
        } else {
            const root = associatedProjectRoot(
                makeZcodeSourceRoot(
                    { ...config.storageRoot, path: storagePaths.join(config.storageRoot.path, "agents") },
                    "source",
                    "agent_runtime_private",
                    "source_code",
                ),
                projectLocatorKind,
                projectLocatorKey,
                projectEvidenceLevel,
            );
            sourceRootIds.push(addZcodeSourceRoot(roots, root));
            complete = sourceRootResolved(root) && complete;
        }
    }
    const memory = resolveZcodeProjectMemoryRootFromConfig(configResolverInput, project, config);
    diagnostics.push(...memory.diagnostics);
    if (memory.resolved === null) return { complete: false, memorySourceRootId: null };
    const memoryRoot = associatedProjectRoot(
        makeZcodeSourceRoot(memory.resolved, "source", "project_keyed", "source_code"),
        projectLocatorKind,
        projectLocatorKey,
        projectEvidenceLevel,
    );
    const memorySourceRootId = addZcodeSourceRoot(roots, memoryRoot);
    sourceRootIds.push(memorySourceRootId);
    return { complete: sourceRootResolved(memoryRoot) && complete, memorySourceRootId };
}

function associatedProjectRoot(
    root: SourceRoot,
    locatorKind: "project_registry_entry" | "user_provided_path",
    locatorKey: string,
    evidenceLevel: "local_artifact" | "user_provided",
): SourceRoot {
    return associateZcodeRootWithProject(root, locatorKind, locatorKey, evidenceLevel);
}

function sourceRootResolved(root: SourceRoot): boolean {
    return root.accessStatus !== "unknown" && root.accessStatus !== "needs_permission";
}

function resolveV2Root(environment: NodeJS.ProcessEnv, homeDir: string, context: AdapterProbeContext): ResolvedZcodePath | null {
    const paths = hostPathApiFor(homeDir) as Exclude<ReturnType<typeof hostPathApiFor>, null>;
    const override = environment.ZCODE_DATA_BASE_DIR?.trim();
    const base = override || homeDir;
    const candidate = paths.join(base, ".zcode", "v2");
    const canonical = canonicalProviderHostPathWithinAccessRoot(candidate, context.platformContext);
    if (canonical === null || hostPathApiFor(canonical) !== paths) return null;
    return {
        path: canonical,
        locatorKind: override ? "runtime_declared_path" : "runtime_known_rule",
        locatorKey: override ? "ZCODE_DATA_BASE_DIR" : "zcode_v2_data_root",
    };
}

function projectStatusForRoot(root: SourceRoot): ProjectDiscoveryStatus {
    if (root.accessStatus === "available") return "complete";
    if (root.accessStatus === "needs_permission") return "needs_permission";
    return "partial";
}

function projectStatusForRegistry(
    accessStatus: AdapterProbeResult["observation"]["agentRuntimeResources"][number]["accessStatus"],
): ProjectDiscoveryStatus {
    if (accessStatus === "available") return "partial";
    if (accessStatus === "needs_permission") return "needs_permission";
    if (accessStatus === "unknown") return "unknown";
    return "not_found";
}

function observedRuntime(
    installation: ReturnType<typeof findZcodeAppInstallation>,
    sourceRootIds: string[],
    agentRuntimeResourceIds: string[],
    observedProjectIds: string[],
    projectDiscoveryStatus: ProjectDiscoveryStatus,
): ObservedAgentRuntime {
    return {
        agentRuntimeId: "ZCODE_APP",
        versionText: installation.versionText,
        installationEvidence: installation.evidence,
        sourceRootIds,
        agentRuntimeResourceIds,
        observedProjectIds,
        installationStatus: installation.status,
        projectDiscoveryStatus,
        diagnostics: installation.diagnostics,
    };
}

function unknownRuntime(item: OperationDiagnostic): ObservedAgentRuntime {
    return {
        agentRuntimeId: "ZCODE_APP",
        versionText: "",
        installationEvidence: [],
        sourceRootIds: [],
        agentRuntimeResourceIds: [],
        observedProjectIds: [],
        installationStatus: "unknown",
        projectDiscoveryStatus: "unknown",
        diagnostics: [item],
    };
}

function emptyObservation(observedAgentRuntime: ObservedAgentRuntime): AdapterProbeResult["observation"] {
    return {
        observedAgentRuntimes: [observedAgentRuntime],
        sourceRoots: [],
        agentRuntimeResources: [],
        observedProjects: [],
        targetCandidates: [],
    };
}

/** Narrow deep-module test seam; not exported from the Provider package barrel. */
