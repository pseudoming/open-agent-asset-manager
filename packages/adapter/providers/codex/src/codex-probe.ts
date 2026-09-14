/** Codex family installation, source-root, and project discovery. This module never mutates disk. */

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
import { createSelectedWslPathProjection, getHomeDir, physicalAccessPathContains } from "@oaam/shared/paths";
import {
    addCodexSourceRoot,
    diagnostic,
    inspectCodexPath,
    makeCodexResource,
    makeCodexSourceRoot,
    makeCodexUserRoot,
    type ResolvedCodexPath,
    stableCodexId,
    uniqueSortedStrings,
} from "./codex-probe-foundation";
import { materializeCodexConfig, readCodexProbeConfig } from "./codex-probe-guidance-config";
import { observeCodexProbeInputs } from "./codex-probe-inputs";
import {
    type CodexInstallationSearch,
    diagnoseMissingCodexCliVersion,
    findCodexAppInstallation,
    findCodexCliInstallation,
    retainCodexCliCurrentBuildObservation,
} from "./codex-probe-installation";

export async function probeCodex(
    context: AdapterProbeContext,
    environment: NodeJS.ProcessEnv = process.env,
    homeDir: string = getHomeDir(),
    hostPlatform: NodeJS.Platform = process.platform,
): Promise<AdapterProbeResult> {
    return probeCodexInCurrentProcess(context, environment, homeDir, hostPlatform);
}

/** Provider-private coordinate binding for Bootstrap's selected Windows-to-WSL execution. */
export async function probeCodexForSelectedWslHost(
    context: AdapterProbeContext,
    hostContext: AdapterProbeContext["platformContext"],
    environment: NodeJS.ProcessEnv = process.env,
    homeDir: string = getHomeDir(),
    hostPlatform: NodeJS.Platform = process.platform,
): Promise<AdapterProbeResult> {
    const host = structuredClone(hostContext);
    const projection = createSelectedWslPathProjection(host.platformInstanceId, host.accessRootPath);
    if (
        host.platform !== "wsl" ||
        hostPlatform !== "linux" ||
        context.platformContext.platform !== "wsl" ||
        context.platformContext.platformInstanceId !== host.platformInstanceId ||
        context.platformContext.accessRootPath !== projection.executionAccessRootPath
    )
        throw new Error("Codex probe identity coordinates must bind the exact selected WSL Environment");
    return probeCodexInCurrentProcess(context, environment, homeDir, hostPlatform, projection.toHost);
}

async function probeCodexInCurrentProcess(
    context: AdapterProbeContext,
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    hostPlatform: NodeJS.Platform,
    projectRegistryIdentityPath: (executionPath: string) => string = (executionPath) => executionPath,
): Promise<AdapterProbeResult> {
    const selectedEnvironment = resolveProviderProbeEnvironment(context.platformContext, environment, homeDir, hostPlatform);
    if (selectedEnvironment === null) {
        const mismatch = diagnostic(
            "codex_probe_platform_unreachable",
            "The current process cannot inspect the selected platform filesystem",
            "partial",
            "warning",
            context.platformContext.accessRootPath,
        );
        return {
            status: "partial",
            observation: emptyObservation([unknownRuntime("CODEX_CLI", mismatch), unknownRuntime("CODEX_APP", mismatch)]),
            diagnostics: [mismatch],
        };
    }

    environment = selectedEnvironment.environment;
    homeDir = selectedEnvironment.homePath;
    const paths = hostPathApiFor(homeDir);
    const codexHome = paths === null ? null : resolveCodexHome(environment, homeDir, context);
    if (paths === null || codexHome === null) {
        const invalid = diagnostic(
            "codex_home_invalid",
            "CODEX_HOME must resolve to a canonical absolute directory inside the selected access root",
            "invalid_schema",
            "warning",
            environment.CODEX_HOME?.trim() ?? homeDir,
        );
        return {
            status: "partial",
            observation: emptyObservation([unknownRuntime("CODEX_CLI", invalid), unknownRuntime("CODEX_APP", invalid)]),
            diagnostics: [invalid],
        };
    }

    const diagnostics: OperationDiagnostic[] = [];

    const configResource = makeCodexResource(
        {
            path: paths.join(codexHome.path, "config.toml"),
            locatorKind: codexHome.locatorKind,
            locatorKey: `${codexHome.locatorKey}:config.toml`,
        },
        ["project_registry"],
    );
    const resources = [configResource];
    const { config, cliInstall, appInstall } = await observeCodexProbeInputs({
        config: async () => readCodexProbeConfig(configResource.path, configResource.accessStatus),
        cli: async () =>
            diagnoseMissingCodexCliVersion(
                await retainCodexCliCurrentBuildObservation(
                    await findCodexCliInstallation(environment, homeDir, context.platformContext, context.installationRootPath),
                    context.platformContext,
                    hostPlatform,
                ),
            ),
        app: () => findCodexAppInstallation(environment, homeDir, context.platformContext, context.installationRootPath),
    });
    const usesProjectRegistry = context.authorizationScope === "global";
    const materializedConfig = usesProjectRegistry
        ? materializeCodexConfig(config, context.platformContext)
        : {
              trustedProjects: { state: "known" as const, entries: [] },
              skills: { state: "known" as const, entries: [] },
              uncheckedWslProjectReferences: [],
              diagnostics: [],
          };
    diagnostics.push(...configDiagnosticsForScope(config.diagnostics, usesProjectRegistry), ...materializedConfig.diagnostics);
    if (config.guidance.state === "known" && config.guidance.filenames.length > 0) {
        diagnostics.push(
            diagnostic(
                "codex_guidance_fallback_read_deferred",
                "Configured Codex project Guidance fallback filenames are visible, but the current read contract cannot bind their values to a project root",
                "unsupported",
                "warning",
                configResource.path,
            ),
        );
    }

    const roots = new Map<string, SourceRoot>();
    const sharedRootIds: string[] = [];
    sharedRootIds.push(
        addCodexSourceRoot(roots, makeCodexSourceRoot(codexHome, "config", "family_shared", codexHomeEvidence(codexHome))),
    );
    const sharedSkills = knownPath(paths.join(homeDir, ".agents", "skills"), "codex_shared_agent_skills");
    sharedRootIds.push(addCodexSourceRoot(roots, makeCodexSourceRoot(sharedSkills, "source", "family_shared", "docs_declared")));
    const compatibilitySkills = knownPath(paths.join(codexHome.path, "skills"), "codex_home_compatibility_skills");
    sharedRootIds.push(
        addCodexSourceRoot(roots, makeCodexSourceRoot(compatibilitySkills, "source", "family_shared", "local_artifact")),
    );

    const observedProjects: AdapterProbeResult["observation"]["observedProjects"] = [];
    const observedProjectIds: string[] = [];
    let projectDiscoveryStatus: ProjectDiscoveryStatus = "not_found";
    if (context.authorizationScope === "project") {
        const projectPath = canonicalProviderHostPathWithinAccessRoot(context.projectRootPath, context.platformContext);
        if (projectPath === null) {
            projectDiscoveryStatus = "partial";
            diagnostics.push(
                diagnostic(
                    "codex_project_root_invalid",
                    "The authorized Codex project root is not canonical inside the selected access root",
                    "invalid_schema",
                    "error",
                    context.projectRootPath,
                ),
            );
        } else {
            const projectRoot = makeCodexUserRoot(projectPath, "project_actual", "project_root", "probe_project_root");
            sharedRootIds.push(addCodexSourceRoot(roots, projectRoot));
            const runtimeProjectPath =
                hostAbsolutePathToRuntime(
                    context.platformContext.platform,
                    context.platformContext.accessRootPath,
                    projectPath,
                ) ?? projectPath;
            const observedProjectId = stableCodexId("project", runtimeProjectPath);
            observedProjectIds.push(observedProjectId);
            observedProjects.push({
                observedProjectId,
                runtimeProjectKey: runtimeProjectPath,
                displayName: paths.basename(projectPath),
                workspaces: [{ sourceRootId: projectRoot.sourceRootId, role: "primary" }],
                evidence: [{ evidenceKind: "invocation", locatorKey: "probe_project_root", evidenceLevel: "user_provided" }],
                diagnostics: projectRoot.diagnostics,
            });
            projectDiscoveryStatus = projectStatusForRoot(projectRoot);
        }
    } else if (context.authorizationScope === "directory") {
        const directoryPath = canonicalProviderHostPathWithinAccessRoot(context.directoryRootPath, context.platformContext);
        if (directoryPath === null) {
            diagnostics.push(
                diagnostic(
                    "codex_external_root_invalid",
                    "The authorized Codex external root is not canonical inside the selected access root",
                    "invalid_schema",
                    "error",
                    context.directoryRootPath,
                ),
            );
        } else {
            sharedRootIds.push(
                addCodexSourceRoot(roots, makeCodexUserRoot(directoryPath, "source", "external_managed", "probe_directory_root")),
            );
        }
    } else {
        for (const project of materializedConfig.trustedProjects.entries) {
            if (codexManagedProjectRoot(project.hostPath, codexHome.path, paths)) {
                diagnostics.push(
                    diagnostic(
                        "codex_managed_project_path_excluded",
                        "A Codex plugin or builtin-managed path was excluded from ordinary project discovery",
                        "unsupported",
                        "info",
                        project.hostPath,
                    ),
                );
                continue;
            }
            const locatorKey = stableCodexId(
                "project-registry-entry",
                `${stableCodexId("resource", `${configResource.roles.join(",")}\0${projectRegistryIdentityPath(configResource.path)}`)}\0${project.runtimePath}`,
            );
            const projectRoot = makeCodexSourceRoot(
                {
                    path: project.hostPath,
                    locatorKind: "project_registry_entry",
                    locatorKey,
                },
                "project_actual",
                "project_root",
                "local_artifact",
            );
            sharedRootIds.push(addCodexSourceRoot(roots, projectRoot));
            const observedProjectId = stableCodexId("project", project.runtimePath);
            observedProjectIds.push(observedProjectId);
            observedProjects.push({
                observedProjectId,
                runtimeProjectKey: project.runtimePath,
                displayName: paths.basename(project.hostPath),
                workspaces: [{ sourceRootId: projectRoot.sourceRootId, role: "primary" }],
                evidence: [
                    {
                        evidenceKind: "agent_runtime_resource",
                        agentRuntimeResourceId: configResource.agentRuntimeResourceId,
                        locatorKey,
                        evidenceLevel: "local_artifact",
                    },
                ],
                diagnostics: projectRoot.diagnostics,
            });
        }
        projectDiscoveryStatus = projectStatusForConfig(
            materializedConfig.trustedProjects.state,
            materializedConfig.trustedProjects.entries.length,
            configResource.accessStatus,
        );
    }

    const rulesPath = paths.join(codexHome.path, "rules");
    if (inspectCodexPath(rulesPath, "directory").accessStatus === "available") {
        diagnostics.push(
            diagnostic(
                "codex_exec_policy_excluded",
                "Codex .rules execution policy is intentionally excluded from OAAM Rule discovery",
                "unsupported",
                "warning",
                rulesPath,
            ),
        );
    }

    diagnostics.push(...cliInstall.diagnostics, ...appInstall.diagnostics);
    const codexHomeRoot = roots.get(sharedRootIds[0] as string);
    if (codexHomeRoot?.accessStatus === "available" && cliInstall.status !== "available" && appInstall.status !== "available") {
        diagnostics.push(
            diagnostic(
                "codex_residual_sources_without_installation",
                "Codex source files exist but no verified Codex entry installation was found; source presence is not installation evidence",
                "partial",
                "warning",
                codexHome.path,
            ),
        );
    }

    const targetCandidates = materializeCodexTargetCandidates(
        observedProjects,
        roots,
        configResource,
        cliInstall,
        appInstall,
        projectDiscoveryStatus,
    );

    const rootIds = uniqueSortedStrings(sharedRootIds);
    const appRootIds = rootIds.filter((rootId) => {
        const root = roots.get(rootId);
        return root === undefined || !isCliOnlySharedAgentSkillRoot(root);
    });
    const resourceIds = resources.map((resource) => resource.agentRuntimeResourceId);
    const observedAgentRuntimes: ObservedAgentRuntime[] = [
        observedRuntime("CODEX_CLI", cliInstall, rootIds, resourceIds, observedProjectIds, projectDiscoveryStatus),
        observedRuntime("CODEX_APP", appInstall, appRootIds, resourceIds, observedProjectIds, projectDiscoveryStatus),
    ];
    const environmentReferences: NonNullable<AdapterProbeResult["observation"]["environmentReferences"]> =
        appInstall.status === "available"
            ? materializedConfig.uncheckedWslProjectReferences.map((reference) => {
                  const locatorKey = stableCodexId(
                      "project-environment-reference",
                      `${configResource.agentRuntimeResourceId}\0${reference.runtimePath}`,
                  );
                  return {
                      referenceId: stableCodexId("environment-reference", `CODEX_APP\0wsl\0${reference.platformInstanceId}`),
                      agentRuntimeId: "CODEX_APP" as const,
                      referenceKind: "project" as const,
                      referencedEnvironment: {
                          platform: "wsl" as const,
                          platformInstanceId: reference.platformInstanceId,
                      },
                      validationState: "not_checked" as const,
                      evidence: {
                          agentRuntimeResourceId: configResource.agentRuntimeResourceId,
                          locatorKey,
                          evidenceLevel: "local_artifact" as const,
                      },
                  };
              })
            : [];
    const sourceRoots = [...roots.values()].sort((left, right) => left.sourceRootId.localeCompare(right.sourceRootId));
    diagnostics.push(
        ...sourceRoots.flatMap((root) => root.diagnostics),
        ...resources.flatMap((resource) => resource.diagnostics),
    );
    const complete =
        observedAgentRuntimes.every(
            (runtime) =>
                runtime.installationStatus !== "unknown" &&
                runtime.installationStatus !== "needs_permission" &&
                runtime.projectDiscoveryStatus !== "unknown" &&
                runtime.projectDiscoveryStatus !== "partial" &&
                runtime.projectDiscoveryStatus !== "needs_permission",
        ) &&
        sourceRoots.every((root) => root.accessStatus !== "unknown" && root.accessStatus !== "needs_permission") &&
        resources.every((resource) => resource.accessStatus !== "unknown" && resource.accessStatus !== "needs_permission") &&
        config.guidance.state === "known" &&
        config.guidance.filenames.length === 0 &&
        (!usesProjectRegistry ||
            (materializedConfig.trustedProjects.state === "known" && materializedConfig.skills.state === "known"));

    return {
        status: complete ? "complete" : "partial",
        observation: {
            observedAgentRuntimes,
            sourceRoots,
            agentRuntimeResources: resources,
            observedProjects,
            targetCandidates,
            ...(environmentReferences.length === 0 ? {} : { environmentReferences }),
        },
        diagnostics,
    };
}

function codexManagedProjectRoot(
    projectPath: string,
    codexHomePath: string,
    paths: NonNullable<ReturnType<typeof hostPathApiFor>>,
): boolean {
    return [paths.join(codexHomePath, "plugins"), paths.join(codexHomePath, "skills", ".system")].some((root) =>
        physicalAccessPathContains(root, projectPath),
    );
}

type CodexObservedProject = AdapterProbeResult["observation"]["observedProjects"][number];
type CodexRuntimeResource = AdapterProbeResult["observation"]["agentRuntimeResources"][number];
type CodexTargetCandidate = AdapterProbeResult["observation"]["targetCandidates"][number];
type CodexTargetApplicability = CodexTargetCandidate["entryApplicabilities"][number];

export function materializeCodexTargetCandidates(
    observedProjects: CodexObservedProject[],
    roots: ReadonlyMap<string, SourceRoot>,
    projectRegistry: CodexRuntimeResource,
    cliInstallation: CodexInstallationSearch,
    appInstallation: ReturnType<typeof findCodexAppInstallation>,
    projectDiscoveryStatus: ProjectDiscoveryStatus,
): CodexTargetCandidate[] {
    const projectCandidates = observedProjects.flatMap((project) => {
        const primary = project.workspaces.find((workspace) => workspace.role === "primary");
        const projectRoot = primary === undefined ? undefined : roots.get(primary.sourceRootId);
        if (projectRoot === undefined) return [];
        const locatorEvidence = targetLocatorEvidence(projectRoot);
        return [
            {
                targetCandidateId: stableCodexId("target", projectRoot.sourceRootId),
                targetRootPath: projectRoot.path,
                targetKind: "project" as const,
                displayName: project.displayName,
                entryApplicabilities: [
                    codexTargetApplicability(
                        "CODEX_CLI",
                        "Codex CLI",
                        projectRoot,
                        project,
                        projectRegistry,
                        cliInstallation,
                        projectDiscoveryStatus,
                        locatorEvidence,
                    ),
                    codexTargetApplicability(
                        "CODEX_APP",
                        "Codex App",
                        projectRoot,
                        project,
                        projectRegistry,
                        appInstallation,
                        projectDiscoveryStatus,
                        locatorEvidence,
                    ),
                ],
                diagnostics: [],
            },
        ];
    });
    const globalCandidates = [...roots.values()]
        .filter(
            (root) =>
                root.rootRole === "config" &&
                root.sourceDomain === "family_shared" &&
                root.accessStatus === "available" &&
                root.diagnostics.every((item) => item.severity !== "error"),
        )
        .map((root) =>
            codexNonProjectTargetCandidate(root, "global", "Codex global configuration", cliInstallation, appInstallation),
        );
    const skillDirectoryCandidates = [...roots.values()]
        .filter(
            (root) =>
                root.rootRole === "source" &&
                root.sourceDomain === "family_shared" &&
                root.accessStatus === "available" &&
                root.diagnostics.every((item) => item.severity !== "error"),
        )
        .map((root) =>
            codexNonProjectTargetCandidate(root, "directory", "Codex user Skill directory", cliInstallation, appInstallation),
        );
    return [...projectCandidates, ...globalCandidates, ...skillDirectoryCandidates].sort((left, right) =>
        left.targetRootPath === right.targetRootPath
            ? left.targetCandidateId.localeCompare(right.targetCandidateId)
            : left.targetRootPath.localeCompare(right.targetRootPath),
    );
}

function codexNonProjectTargetCandidate(
    root: SourceRoot,
    targetKind: "global" | "directory",
    displayName: string,
    cliInstallation: CodexInstallationSearch,
    appInstallation: ReturnType<typeof findCodexAppInstallation>,
): CodexTargetCandidate {
    const locatorEvidence = targetLocatorEvidence(root, true);
    return {
        targetCandidateId: stableCodexId(`${targetKind}-target`, root.sourceRootId),
        targetRootPath: root.path,
        targetKind,
        displayName,
        entryApplicabilities: [
            codexNonProjectTargetApplicability("CODEX_CLI", "Codex CLI", root, cliInstallation, locatorEvidence),
            codexNonProjectTargetApplicability("CODEX_APP", "Codex App", root, appInstallation, locatorEvidence),
        ],
        diagnostics: [],
    };
}

function codexNonProjectTargetApplicability(
    agentRuntimeId: CodexTargetApplicability["agentRuntimeId"],
    displayName: string,
    root: SourceRoot,
    installation: CodexInstallationSearch,
    locatorEvidence: SourceRoot["locatorEvidence"],
): CodexTargetApplicability {
    const base = { agentRuntimeId, locatorEvidence };
    const codePrefix = agentRuntimeId.toLowerCase();
    if (agentRuntimeId === "CODEX_APP" && isCliOnlySharedAgentSkillRoot(root)) {
        return {
            ...base,
            status: "invalid",
            diagnostics: [
                diagnostic(
                    "codex_app_shared_agent_skill_target_not_loaded",
                    "This Codex App build does not load user Skills from the shared .agents directory; use its CODEX_HOME Skill directory",
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
                    `${codePrefix}_global_target_installation_not_found`,
                    `${displayName} global targets require an installed entry`,
                    "not_found",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        installation.status !== "available" ||
        root.accessStatus !== "available" ||
        root.diagnostics.some((item) => item.severity === "error") ||
        locatorEvidence.length === 0 ||
        !installation.evidence.some(
            (evidence) =>
                evidence.kind === "executable" &&
                (evidence.evidenceLevel === "agent_runtime_verified" || evidence.evidenceLevel === "local_artifact") &&
                !evidence.diagnostics.some((item) => item.severity === "error"),
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    `${codePrefix}_global_target_authority_incomplete`,
                    `${displayName} global target planning requires one exact readable root and build`,
                    root.accessStatus === "needs_permission" ? "permission_denied" : "verification_failed",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    return { ...base, status: "ready_for_plan", diagnostics: [] };
}

function isCliOnlySharedAgentSkillRoot(root: SourceRoot): boolean {
    return (
        root.rootRole === "source" &&
        root.sourceDomain === "family_shared" &&
        root.locatorEvidence.some(
            (evidence) => evidence.locatorKind === "runtime_known_rule" && evidence.locatorKey === "codex_shared_agent_skills",
        )
    );
}

function codexTargetApplicability(
    agentRuntimeId: CodexTargetApplicability["agentRuntimeId"],
    displayName: string,
    root: SourceRoot,
    project: CodexObservedProject,
    projectRegistry: CodexRuntimeResource,
    installation: CodexInstallationSearch,
    projectDiscoveryStatus: ProjectDiscoveryStatus,
    locatorEvidence: SourceRoot["locatorEvidence"],
): CodexTargetApplicability {
    const base = {
        agentRuntimeId,
        locatorEvidence,
    };
    const codePrefix = agentRuntimeId.toLowerCase();
    if (installation.status === "not_found") {
        return {
            ...base,
            status: "invalid",
            diagnostics: [
                diagnostic(
                    `${codePrefix}_target_installation_not_found`,
                    `${displayName} project targets cannot be planned without an installed entry`,
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
                evidence.kind === "executable" &&
                (evidence.evidenceLevel === "agent_runtime_verified" || evidence.evidenceLevel === "local_artifact") &&
                !evidence.diagnostics.some((item) => item.severity === "error"),
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    `${codePrefix}_target_build_evidence_unavailable`,
                    `${displayName} target planning needs one readable build-bearing installation observation`,
                    installation.status === "needs_permission" ? "permission_denied" : "partial",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        projectDiscoveryStatus !== "complete" ||
        root.accessStatus !== "available" ||
        root.diagnostics.some((item) => item.severity === "error") ||
        project.diagnostics.some((item) => item.severity === "error") ||
        !hasTrustedCodexProjectBinding(project, root, projectRegistry)
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    `${codePrefix}_target_project_authority_incomplete`,
                    `${displayName} target planning requires one exact readable project observation`,
                    root.accessStatus === "needs_permission" ? "permission_denied" : "verification_failed",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    return { ...base, status: "ready_for_plan", diagnostics: [] };
}

function hasTrustedCodexProjectBinding(
    project: CodexObservedProject,
    root: SourceRoot,
    projectRegistry: CodexRuntimeResource,
): boolean {
    const exactInvocation =
        project.evidence.some(
            (evidence) =>
                evidence.evidenceKind === "invocation" &&
                evidence.locatorKey === "probe_project_root" &&
                evidence.evidenceLevel === "user_provided",
        ) &&
        root.locatorEvidence.some(
            (evidence) =>
                evidence.locatorKind === "user_provided_path" &&
                evidence.locatorKey === "probe_project_root" &&
                evidence.evidenceLevel === "user_provided",
        );
    if (exactInvocation) return true;

    const registryEvidence = project.evidence.some(
        (evidence) =>
            evidence.evidenceKind === "agent_runtime_resource" &&
            evidence.agentRuntimeResourceId === projectRegistry.agentRuntimeResourceId &&
            (evidence.evidenceLevel === "agent_runtime_verified" || evidence.evidenceLevel === "local_artifact"),
    );
    return (
        registryEvidence &&
        projectRegistry.accessStatus === "available" &&
        projectRegistry.roles.includes("project_registry") &&
        !projectRegistry.diagnostics.some((item) => item.severity === "error") &&
        root.locatorEvidence.some(
            (evidence) =>
                evidence.locatorKind === "project_registry_entry" &&
                (evidence.evidenceLevel === "agent_runtime_verified" || evidence.evidenceLevel === "local_artifact"),
        )
    );
}

function resolveCodexHome(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    context: AdapterProbeContext,
): ResolvedCodexPath | null {
    const paths = hostPathApiFor(homeDir);
    if (paths === null) return null;
    const override = environment.CODEX_HOME?.trim();
    const rawPath = override && override !== "" ? override : paths.join(homeDir, ".codex");
    const canonical = canonicalProviderHostPathWithinAccessRoot(rawPath, context.platformContext);
    if (canonical === null || hostPathApiFor(canonical) !== paths) return null;
    return {
        path: canonical,
        locatorKind: override && override !== "" ? "runtime_declared_path" : "runtime_known_rule",
        locatorKey: override && override !== "" ? "CODEX_HOME" : "codex_home_default",
    };
}

function knownPath(targetPath: string, locatorKey: string): ResolvedCodexPath {
    return { path: targetPath, locatorKind: "runtime_known_rule", locatorKey };
}

function codexHomeEvidence(path: ResolvedCodexPath): "user_provided" | "docs_declared" {
    return path.locatorKind === "runtime_declared_path" ? "user_provided" : "docs_declared";
}

function projectStatusForRoot(root: SourceRoot): ProjectDiscoveryStatus {
    if (root.accessStatus === "available") return "complete";
    if (root.accessStatus === "needs_permission") return "needs_permission";
    return "partial";
}

function projectStatusForConfig(
    state: "known" | "partial" | "unknown",
    entryCount: number,
    accessStatus: AdapterProbeResult["observation"]["agentRuntimeResources"][number]["accessStatus"],
): ProjectDiscoveryStatus {
    if (accessStatus === "needs_permission") return "needs_permission";
    if (state === "unknown") return "unknown";
    if (state === "partial") return "partial";
    return entryCount === 0 ? "not_found" : "complete";
}

function configDiagnosticsForScope(diagnostics: OperationDiagnostic[], usesProjectRegistry: boolean): OperationDiagnostic[] {
    if (usesProjectRegistry) return diagnostics;
    return diagnostics.filter((item) => item.code.startsWith("codex_guidance_") || item.code.startsWith("codex_source_config_"));
}

function targetLocatorEvidence(root: SourceRoot | undefined, observedRoot = false): SourceRoot["locatorEvidence"] {
    const locator = root?.locatorEvidence[0];
    if (locator === undefined) return [];
    return [
        observedRoot && (locator.evidenceLevel === "docs_declared" || locator.evidenceLevel === "source_code")
            ? { ...locator, evidenceLevel: "local_artifact" as const }
            : locator,
    ];
}

function observedRuntime(
    agentRuntimeId: "CODEX_CLI" | "CODEX_APP",
    installation: CodexInstallationSearch,
    sourceRootIds: string[],
    agentRuntimeResourceIds: string[],
    observedProjectIds: string[],
    projectDiscoveryStatus: ProjectDiscoveryStatus,
): ObservedAgentRuntime {
    return {
        agentRuntimeId,
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

function unknownRuntime(agentRuntimeId: "CODEX_CLI" | "CODEX_APP", item: OperationDiagnostic): ObservedAgentRuntime {
    return {
        agentRuntimeId,
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

function emptyObservation(observedAgentRuntimes: ObservedAgentRuntime[]): AdapterProbeResult["observation"] {
    return {
        observedAgentRuntimes,
        sourceRoots: [],
        agentRuntimeResources: [],
        observedProjects: [],
        targetCandidates: [],
    };
}
