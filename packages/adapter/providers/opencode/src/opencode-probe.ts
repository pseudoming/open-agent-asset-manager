/** opencode CLI installation and source-root discovery. This module never mutates disk. */

import {
    canonicalHostPath,
    canonicalProviderHostPathWithinAccessRoot,
    compareCodeUnitText as compareText,
    probeDiagnostic as diagnostic,
    hostAbsolutePathToRuntime,
    hostPathApiFor,
    inspectProviderRegularFileNoFollow,
    type ProviderRegularFileIdentity,
    resolveProviderProbeEnvironment,
    sameProviderRegularFileIdentity,
    uniqueSortedStrings as uniqueSorted,
} from "@oaam/adapter-framework";
import type {
    AdapterProbeContext,
    AdapterProbeResult,
    InstallationEvidence,
    OperationDiagnostic,
    PathLocatorEvidence,
    PlatformContext,
    ResourceAccessStatus,
    SourceRoot,
} from "@oaam/core";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";
import { getHomeDir } from "@oaam/shared/paths";
import { lstatSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import {
    canonicalOpencodeAbsolutePath,
    getPathRule,
    type OpencodePathRule,
    projectSourceLocatorKey,
    type ResolvedOpencodePath,
} from "./opencode-paths";
import { findOpencodeAppInstallation } from "./opencode-probe-app-installation";
import { observeOpenCodeCliVersion, type OpenCodeCliInstallationObservation } from "./opencode-probe-cli-version";
import { hasNativeBinaryMagic, installationRequiresExecutableMode } from "./opencode-probe-executable";
import {
    discoverOpenCodeProjects,
    type OpenCodeProjectDiscoveryInput,
    type OpenCodeProjectDiscoveryResult,
} from "./opencode-probe-project-discovery";
import {
    buildGlobalTargetCandidates,
    buildProjectTargetCandidates,
    buildSharedSkillTargetCandidates,
    projectObservationsFromRuntimeList,
} from "./opencode-probe-project-projection";
import {
    addSourceRoot,
    deduplicateCandidates,
    emptyObservation,
    type OpenCodeInstallationCandidate,
    stableId,
} from "./opencode-probe-support";

interface VerifiedInstallation {
    path: string;
    identity: ProviderRegularFileIdentity;
}

interface InstallationSearch extends OpenCodeCliInstallationObservation {
    evidence: InstallationEvidence[];
    diagnostics: OperationDiagnostic[];
    executable: VerifiedInstallation | null;
}

interface Inspection {
    accessStatus: ResourceAccessStatus;
    diagnostics: OperationDiagnostic[];
}

export interface OpencodeProbeDependencies {
    readonly discoverProjects?: (input: OpenCodeProjectDiscoveryInput) => Promise<OpenCodeProjectDiscoveryResult>;
    readonly observeCliVersion?: typeof observeOpenCodeCliVersion;
}

const DEFAULT_DEPENDENCIES: OpencodeProbeDependencies = {
    discoverProjects: discoverOpenCodeProjects,
    observeCliVersion: observeOpenCodeCliVersion,
};

export async function probeOpencode(
    context: AdapterProbeContext,
    environment: NodeJS.ProcessEnv = process.env,
    homeDir: string = getHomeDir(),
    hostPlatform: NodeJS.Platform = process.platform,
    dependencies: OpencodeProbeDependencies = DEFAULT_DEPENDENCIES,
): Promise<AdapterProbeResult> {
    if (canonicalHostPath(homeDir) === null) {
        const invalid = diagnostic(
            "opencode_path_rule_invalid",
            "opencode config/data overrides must resolve to canonical absolute paths",
            "invalid_schema",
            "error",
            homeDir,
        );
        return {
            status: "failed",
            observation: emptyObservation(invalid),
            diagnostics: [invalid],
        };
    }
    const probeEnvironment = resolveProviderProbeEnvironment(context.platformContext, environment, homeDir, hostPlatform);
    if (probeEnvironment === null) {
        const mismatch = diagnostic(
            "opencode_probe_platform_unreachable",
            "The current process cannot inspect the requested platform filesystem",
            "partial",
            "warning",
            context.platformContext.accessRootPath,
        );
        return {
            status: "partial",
            observation: emptyObservation(mismatch),
            diagnostics: [mismatch],
        };
    }

    environment = probeEnvironment.environment;
    homeDir = probeEnvironment.homePath;
    const rule = getPathRule(context.platformContext.platform, environment, homeDir);
    if (rule === null) {
        const invalid = diagnostic(
            "opencode_path_rule_invalid",
            "opencode config/data overrides must resolve to canonical absolute paths",
            "invalid_schema",
            "error",
            "",
        );
        return {
            status: "failed",
            observation: emptyObservation(invalid),
            diagnostics: [invalid],
        };
    }
    if (!opencodeRuleWithinAccessRoot(rule, context.platformContext)) {
        const outside = diagnostic(
            "opencode_path_rule_outside_selected_environment",
            "An OpenCode path rule falls outside the selected physical access root",
            "partial",
            "warning",
            context.platformContext.accessRootPath,
        );
        return {
            status: "partial",
            observation: emptyObservation(outside),
            diagnostics: [outside],
        };
    }

    const diagnostics: OperationDiagnostic[] = [];

    const sourceRoots = new Map<string, SourceRoot>();
    const runtimeSourceRootIds: string[] = [];
    let activeGlobalConfigSourceRoot: SourceRoot | null = null;
    const activeSharedSkillSourceRoots: SourceRoot[] = [];
    for (const configRoot of rule.configRoots) {
        const sourceRoot = makeSourceRoot(configRoot, "config", "agent_runtime_private", "directory", "source_code");
        runtimeSourceRootIds.push(addSourceRoot(sourceRoots, sourceRoot));
        if (configRoot.path === rule.globalConfigRoot.path) {
            activeGlobalConfigSourceRoot = sourceRoot;
        }
    }
    for (const shared of rule.sharedSkillRoots) {
        const sourceRoot = makeSourceRoot(shared, "source", "family_shared", "directory", "source_code");
        runtimeSourceRootIds.push(addSourceRoot(sourceRoots, sourceRoot));
        activeSharedSkillSourceRoots.push(sourceRoot);
    }
    const globalGuidanceRoot = rule.globalConfigRoot;
    if (rule.claudeGuidanceRoot !== null) {
        const paths = hostPathApiFor(globalGuidanceRoot.path);
        if (paths === null) throw new TypeError("OpenCode global guidance root must be canonical absolute");
        const preferredGuidance =
            activeGlobalConfigSourceRoot?.accessStatus === "available"
                ? inspectPath(paths.join(globalGuidanceRoot.path, "AGENTS.md"), "file")
                : null;
        if (activeGlobalConfigSourceRoot?.accessStatus === "not_found" || preferredGuidance?.accessStatus === "not_found") {
            runtimeSourceRootIds.push(
                addSourceRoot(
                    sourceRoots,
                    makeSourceRoot(rule.claudeGuidanceRoot, "config", "family_shared", "directory", "source_code"),
                ),
            );
        }
        if (preferredGuidance?.accessStatus === "unknown" || preferredGuidance?.accessStatus === "needs_permission") {
            diagnostics.push(...preferredGuidance.diagnostics);
        }
    }

    const observedProjects: AdapterProbeResult["observation"]["observedProjects"] = [];
    let cliProjectDiscoveryStatus: AdapterProbeResult["observation"]["observedAgentRuntimes"][number]["projectDiscoveryStatus"] =
        "not_found";
    let appProjectDiscoveryStatus: AdapterProbeResult["observation"]["observedAgentRuntimes"][number]["projectDiscoveryStatus"] =
        cliProjectDiscoveryStatus;
    if (context.authorizationScope === "project") {
        const projectPath = canonicalProviderHostPathWithinAccessRoot(context.projectRootPath, context.platformContext);
        if (projectPath === null) {
            diagnostics.push(
                diagnostic(
                    "opencode_project_root_invalid",
                    "The authorized opencode project root is not canonical absolute",
                    "invalid_schema",
                    "error",
                    context.projectRootPath,
                ),
            );
            cliProjectDiscoveryStatus = "partial";
            appProjectDiscoveryStatus = "partial";
        } else {
            const locatorKey = projectSourceLocatorKey(rule);
            const projectRoot = makeUserRoot(projectPath, "project_actual", "project_root", locatorKey);
            projectRoot.locatorEvidence.push({
                locatorKind: "user_provided_path",
                locatorKey: "probe_project_root",
                evidenceLevel: "user_provided",
            });
            addSourceRoot(sourceRoots, projectRoot);
            if (rule.projectConfigEnabled || rule.externalSkillsEnabled) {
                runtimeSourceRootIds.push(projectRoot.sourceRootId);
            }
            const runtimeProjectPath =
                hostAbsolutePathToRuntime(
                    context.platformContext.platform,
                    context.platformContext.accessRootPath,
                    projectPath,
                ) ?? projectPath;
            const projectPaths = hostPathApiFor(projectPath);
            if (projectPaths === null) throw new TypeError("OpenCode project path must be canonical absolute");
            const observedProjectId = stableId("project", runtimeProjectPath);
            observedProjects.push({
                observedProjectId,
                runtimeProjectKey: runtimeProjectPath,
                displayName: projectPaths.basename(projectPath),
                workspaces: [{ sourceRootId: projectRoot.sourceRootId, role: "primary" }],
                evidence: [
                    {
                        evidenceKind: "invocation",
                        locatorKey,
                        evidenceLevel: "user_provided",
                    },
                    {
                        evidenceKind: "invocation",
                        locatorKey: "probe_project_root",
                        evidenceLevel: "user_provided",
                    },
                ],
                diagnostics: projectRoot.diagnostics,
            });
            cliProjectDiscoveryStatus =
                projectRoot.accessStatus === "available"
                    ? "complete"
                    : projectRoot.accessStatus === "needs_permission"
                      ? "needs_permission"
                      : "partial";
            appProjectDiscoveryStatus = cliProjectDiscoveryStatus;
        }
    } else if (context.authorizationScope === "directory") {
        const directoryPath = canonicalProviderHostPathWithinAccessRoot(context.directoryRootPath, context.platformContext);
        if (directoryPath === null) {
            diagnostics.push(
                diagnostic(
                    "opencode_external_root_invalid",
                    "The authorized opencode external source root is not canonical absolute",
                    "invalid_schema",
                    "error",
                    context.directoryRootPath,
                ),
            );
            cliProjectDiscoveryStatus = "partial";
            appProjectDiscoveryStatus = "partial";
        } else {
            runtimeSourceRootIds.push(
                addSourceRoot(sourceRoots, makeUserRoot(directoryPath, "source", "external_managed", "probe_directory_root")),
            );
        }
    }

    const resources: AdapterProbeResult["observation"]["agentRuntimeResources"] = [];
    const dataResource = makeResource(rule.dataRoot, ["agent_runtime_data"], "directory", "source_code");
    resources.push(dataResource);
    let projectRegistryResource: AdapterProbeResult["observation"]["agentRuntimeResources"][number] | null = null;
    if (rule.database !== null) {
        const database = makeResource(rule.database, ["project_registry"], "file", "source_code");
        resources.push(database);
        projectRegistryResource = database;
        if (context.authorizationScope === "global") {
            cliProjectDiscoveryStatus =
                database.accessStatus === "available"
                    ? "partial"
                    : database.accessStatus === "needs_permission"
                      ? "needs_permission"
                      : database.accessStatus === "not_found"
                        ? "not_found"
                        : "partial";
        }
    }

    const installationSearch = await findInstallation(
        environment,
        homeDir,
        context.platformContext,
        context.installationRootPath,
    );
    const installationPromise = (dependencies.observeCliVersion ?? observeOpenCodeCliVersion)(
        installationSearch,
        context.platformContext,
        hostPlatform,
        environment,
        homeDir,
    );
    const appInstallationPromise = findOpencodeAppInstallation(
        environment,
        homeDir,
        context.platformContext,
        installationRequiresExecutableMode(context.platformContext),
        context.installationRootPath,
    );
    const projectDiscoveryPromise =
        context.authorizationScope === "global" &&
        (installationSearch.executable !== null || projectRegistryResource?.accessStatus === "available")
            ? (dependencies.discoverProjects ?? discoverOpenCodeProjects)({
                  executable: installationSearch.executable,
                  environment,
                  workingDirectory: homeDir,
                  platformContext: context.platformContext,
                  hostPlatform,
                  diagnosticPath: projectRegistryResource?.path ?? installationSearch.executable?.path ?? "",
                  databasePath: projectRegistryResource?.accessStatus === "available" ? projectRegistryResource.path : null,
              })
            : null;
    const [installation, appInstallation, projectDiscovery] = await Promise.all([
        installationPromise,
        appInstallationPromise,
        projectDiscoveryPromise,
    ]);
    diagnostics.push(...installation.diagnostics);
    diagnostics.push(...appInstallation.diagnostics);
    if (context.authorizationScope === "global") {
        if (projectDiscovery !== null) {
            diagnostics.push(...projectDiscovery.diagnostics);
            cliProjectDiscoveryStatus = projectDiscovery.status;
            const projected = await projectObservationsFromRuntimeList(
                projectDiscovery.projects,
                projectRegistryResource?.accessStatus === "available" ? projectRegistryResource : null,
                projectDiscovery.evidenceLevel,
                context.platformContext,
                sourceRoots,
            );
            observedProjects.push(...projected.observedProjects);
            runtimeSourceRootIds.push(...projected.sourceRootIds);
            diagnostics.push(...projected.diagnostics);
            if (projected.diagnostics.length > 0) cliProjectDiscoveryStatus = "partial";
            if (
                projectRegistryResource?.accessStatus === "needs_permission" ||
                projectRegistryResource?.accessStatus === "unknown"
            ) {
                cliProjectDiscoveryStatus = "partial";
            }
        } else if (rule.database === null) {
            diagnostics.push(
                diagnostic(
                    "opencode_memory_database_has_no_persistent_registry",
                    "OPENCODE_DB=:memory: exposes no persistent project registry to OAAM",
                    "not_found",
                    "warning",
                    "",
                ),
            );
        }
        if (appInstallation.status === "available") {
            const appProjectDiagnostic = diagnostic(
                "opencode_app_project_discovery_unverified",
                "OpenCode Desktop installation is verified, but global Project registration has not been independently observed for this entry",
                "partial",
                "warning",
                appInstallation.evidence.find((item) => item.kind === "app_bundle")?.path ?? "",
            );
            appInstallation.diagnostics.push(appProjectDiagnostic);
            diagnostics.push(appProjectDiagnostic);
            appProjectDiscoveryStatus = "partial";
        } else {
            appProjectDiscoveryStatus =
                appInstallation.status === "not_found"
                    ? "not_found"
                    : appInstallation.status === "needs_permission"
                      ? "needs_permission"
                      : "unknown";
        }
    }
    const explicitConfigPath = environment.OPENCODE_CONFIG?.trim();
    if (explicitConfigPath) {
        diagnostics.push(
            diagnostic(
                "opencode_explicit_config_fragment_deferred",
                "OPENCODE_CONFIG points at a mixed config container; OAAM reports it but does not import fragments",
                "unsupported",
                "warning",
                explicitConfigPath,
            ),
        );
    }
    if (environment.OPENCODE_CONFIG_CONTENT?.trim()) {
        diagnostics.push(
            diagnostic(
                "opencode_inline_config_fragment_deferred",
                "OPENCODE_CONFIG_CONTENT is an inline mixed config container and is not persisted as an OAAM asset",
                "unsupported",
                "warning",
                "",
            ),
        );
    }
    if (
        installation.status !== "available" &&
        appInstallation.status !== "available" &&
        dataResource.accessStatus === "available"
    ) {
        diagnostics.push(
            diagnostic(
                "opencode_residual_data_without_installation",
                "opencode data exists but no verified CLI or Desktop entry was found; data presence is not installation evidence",
                "partial",
                "warning",
                dataResource.path,
            ),
        );
    }

    const targetCandidates = [
        ...buildProjectTargetCandidates(observedProjects, sourceRoots, rule, installation, appInstallation),
        ...buildGlobalTargetCandidates(activeGlobalConfigSourceRoot, installation, appInstallation),
        ...buildSharedSkillTargetCandidates(activeSharedSkillSourceRoots, installation, appInstallation),
    ].sort((left, right) =>
        compareText(`${left.targetRootPath}\0${left.targetCandidateId}`, `${right.targetRootPath}\0${right.targetCandidateId}`),
    );

    const observedProjectIds = observedProjects.map((project) => project.observedProjectId).sort(compareText);
    const sourceRootIds = uniqueSorted(runtimeSourceRootIds);
    const resourceIds = resources.map((resource) => resource.agentRuntimeResourceId).sort(compareText);
    const appResourceIds = resources
        .filter((resource) => !resource.roles.includes("project_registry"))
        .map((resource) => resource.agentRuntimeResourceId)
        .sort(compareText);

    const observation: AdapterProbeResult["observation"] = {
        observedAgentRuntimes: [
            {
                agentRuntimeId: "OPENCODE_CLI",
                versionText: installation.versionText,
                installationEvidence: [...installation.evidence],
                sourceRootIds,
                agentRuntimeResourceIds: resourceIds,
                observedProjectIds,
                installationStatus: installation.status,
                projectDiscoveryStatus: cliProjectDiscoveryStatus,
                diagnostics: [...installation.diagnostics],
            },
            {
                agentRuntimeId: "OPENCODE_APP",
                versionText: appInstallation.versionText,
                installationEvidence: appInstallation.evidence,
                sourceRootIds,
                agentRuntimeResourceIds: appResourceIds,
                observedProjectIds: context.authorizationScope === "project" ? observedProjectIds : [],
                installationStatus: appInstallation.status,
                projectDiscoveryStatus: appProjectDiscoveryStatus,
                diagnostics: appInstallation.diagnostics,
            },
        ],
        sourceRoots: [...sourceRoots.values()].sort((left, right) => compareText(left.sourceRootId, right.sourceRootId)),
        agentRuntimeResources: resources.sort((left, right) =>
            compareText(left.agentRuntimeResourceId, right.agentRuntimeResourceId),
        ),
        observedProjects,
        targetCandidates,
    };
    diagnostics.push(
        ...observation.sourceRoots.flatMap((root) => root.diagnostics),
        ...observation.agentRuntimeResources.flatMap((resource) => resource.diagnostics),
    );
    const projectDiscoveryComplete = [cliProjectDiscoveryStatus, appProjectDiscoveryStatus].every(
        (status) => status === "complete" || status === "not_found",
    );
    const accessDiscoveryComplete =
        installation.status !== "unknown" &&
        installation.status !== "needs_permission" &&
        appInstallation.status !== "unknown" &&
        appInstallation.status !== "needs_permission" &&
        observation.sourceRoots.every((root) => root.accessStatus !== "unknown" && root.accessStatus !== "needs_permission") &&
        observation.agentRuntimeResources.every(
            (resource) => resource.accessStatus !== "unknown" && resource.accessStatus !== "needs_permission",
        );
    return {
        status:
            diagnostics.every((item) => item.severity === "info") && projectDiscoveryComplete && accessDiscoveryComplete
                ? "complete"
                : "partial",
        observation,
        diagnostics,
    };
}

async function findInstallation(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
    installationRootPath?: string,
): Promise<InstallationSearch> {
    const platform = platformContext.platform;
    const diagnostics: OperationDiagnostic[] = [];
    const candidates: OpenCodeInstallationCandidate[] = [];
    let discoveryIncomplete = false;
    const executableName = platform === "win32" ? "opencode.exe" : "opencode";
    const runtimePaths = platform === "win32" ? path.win32 : path.posix;
    if (installationRootPath !== undefined) {
        const selectedPaths = hostPathApiFor(installationRootPath);
        if (selectedPaths === null) {
            discoveryIncomplete = true;
        } else {
            candidates.push({
                path: selectedPaths.join(installationRootPath, executableName),
                source: "user_selected",
            });
        }
    }
    const installDir = environment.OPENCODE_INSTALL_DIR?.trim();
    if (installationRootPath === undefined && installDir) {
        const canonical = canonicalOpencodeAbsolutePath(installDir);
        if (canonical === null) {
            discoveryIncomplete = true;
            diagnostics.push(
                diagnostic(
                    "opencode_install_dir_invalid",
                    "OPENCODE_INSTALL_DIR must be a canonical absolute path",
                    "invalid_schema",
                    "warning",
                    installDir,
                ),
            );
        } else {
            const paths = hostPathApiFor(canonical);
            if (paths !== null) candidates.push({ path: paths.join(canonical, executableName), source: "explicit_override" });
        }
    }
    for (const entry of installationRootPath === undefined
        ? (environment.PATH ?? environment.Path ?? "").split(runtimePaths.delimiter)
        : []) {
        if (entry.trim() === "") continue;
        const directory = canonicalOpencodeAbsolutePath(entry);
        if (directory !== null) {
            const paths = hostPathApiFor(directory);
            if (paths !== null) candidates.push({ path: paths.join(directory, executableName), source: "path" });
        } else {
            discoveryIncomplete = true;
            diagnostics.push(
                diagnostic(
                    "opencode_path_entry_invalid",
                    "A non-canonical PATH entry was not used for opencode installation discovery",
                    "invalid_schema",
                    "warning",
                    entry,
                ),
            );
        }
    }
    const home = installationRootPath === undefined ? canonicalOpencodeAbsolutePath(homeDir) : null;
    if (home !== null) {
        const paths = hostPathApiFor(home);
        if (paths !== null) {
            candidates.push({ path: paths.join(home, ".opencode", "bin", executableName), source: "home_default" });
        }
    }

    let outsidePathCandidate: string | null = null;
    const checkedCandidates = deduplicateCandidates(candidates).flatMap((candidate) => {
        const canonical = canonicalProviderHostPathWithinAccessRoot(candidate.path, platformContext);
        if (canonical === null) {
            if (candidate.source === "path") {
                outsidePathCandidate ??= candidate.path;
                return [];
            }
            discoveryIncomplete = true;
            diagnostics.push(
                diagnostic(
                    "opencode_install_candidate_outside_selected_environment",
                    "An OpenCode installation candidate lies outside the selected environment access root and was not inspected",
                    "partial",
                    "warning",
                    candidate.path,
                ),
            );
            return [];
        }
        return [canonical];
    });
    let needsPermission = false;
    let nonBinaryFound = false;
    for (const candidate of checkedCandidates) {
        let candidateEntryObserved = false;
        try {
            const link = lstatSync(candidate);
            candidateEntryObserved = true;
            const actualPath = canonicalProviderHostPathWithinAccessRoot(
                link.isSymbolicLink() ? realpathSync(candidate) : candidate,
                platformContext,
            );
            if (actualPath === null) {
                discoveryIncomplete = true;
                diagnostics.push(
                    diagnostic(
                        "opencode_install_symlink_target_outside_selected_environment",
                        "An OpenCode installation symlink resolves outside the selected environment access root",
                        "partial",
                        "warning",
                        candidate,
                    ),
                );
                continue;
            }
            const stat = link.isSymbolicLink() ? statSync(actualPath) : link;
            if (!stat.isFile()) continue;
            if (installationRequiresExecutableMode(platformContext) && (stat.mode & 0o111) === 0) continue;
            const identityBefore = inspectProviderRegularFileNoFollow(actualPath);
            if (!hasNativeBinaryMagic(actualPath, platform)) {
                nonBinaryFound = true;
                diagnostics.push(
                    diagnostic(
                        "opencode_launcher_is_not_native_binary",
                        "An opencode-named executable was found but it is not a verified native CLI binary",
                        "version_incompatible",
                        "warning",
                        actualPath,
                    ),
                );
                continue;
            }
            const identityAfter = inspectProviderRegularFileNoFollow(actualPath);
            if (!sameProviderRegularFileIdentity(identityBefore, identityAfter)) {
                discoveryIncomplete = true;
                diagnostics.push(
                    diagnostic(
                        "opencode_install_identity_changed",
                        "The OpenCode executable changed while installation evidence was collected",
                        "verification_failed",
                        "warning",
                        actualPath,
                    ),
                );
                continue;
            }
            return {
                status: "available",
                evidence: [
                    {
                        kind: "executable",
                        path: actualPath,
                        evidenceLevel: "local_artifact",
                        diagnostics: [],
                    },
                ],
                diagnostics,
                executable: { path: actualPath, identity: identityAfter },
            };
        } catch (error) {
            const failure = inspectFilesystemFailure(error);
            if (
                failure.source === "node_errno_error" &&
                (failure.systemCode === "ENOENT" || failure.systemCode === "ENOTDIR") &&
                !candidateEntryObserved
            ) {
                continue;
            }
            if (failure.source === "node_errno_error" && failure.failureKind === "permission_denied") {
                needsPermission = true;
                diagnostics.push(
                    diagnostic(
                        "opencode_install_probe_permission_denied",
                        "An opencode installation candidate could not be inspected",
                        "permission_denied",
                        "warning",
                        candidate,
                    ),
                );
                continue;
            }
            discoveryIncomplete = true;
            diagnostics.push(
                diagnostic(
                    candidateEntryObserved ? "opencode_install_symlink_target_unavailable" : "opencode_install_probe_io_error",
                    candidateEntryObserved
                        ? "An opencode installation symlink did not resolve to an inspectable target"
                        : "An opencode installation candidate could not be inspected reliably",
                    "partial",
                    "warning",
                    candidate,
                ),
            );
        }
    }
    if (outsidePathCandidate !== null) {
        discoveryIncomplete = true;
        diagnostics.push(
            diagnostic(
                "opencode_install_candidate_outside_selected_environment",
                "One or more OpenCode PATH candidates lie outside the selected environment access root and none of the inspected candidates proved an installation",
                "partial",
                "warning",
                outsidePathCandidate,
            ),
        );
    }

    const status = needsPermission ? "needs_permission" : discoveryIncomplete || nonBinaryFound ? "unknown" : "not_found";
    return {
        status,
        evidence:
            status === "not_found"
                ? checkedCandidates.map((candidate) => ({
                      kind: "executable" as const,
                      path: candidate,
                      evidenceLevel: "local_artifact" as const,
                      diagnostics: [],
                  }))
                : [],
        diagnostics,
        executable: null,
    };
}

export { installationRequiresExecutableMode } from "./opencode-probe-executable";

function opencodeRuleWithinAccessRoot(rule: OpencodePathRule, context: PlatformContext): boolean {
    const roots = [
        rule.globalConfigRoot,
        ...rule.configRoots,
        rule.dataRoot,
        ...rule.sharedSkillRoots,
        ...(rule.database === null ? [] : [rule.database]),
        ...(rule.claudeGuidanceRoot === null ? [] : [rule.claudeGuidanceRoot]),
    ];
    return roots.every((root) => canonicalProviderHostPathWithinAccessRoot(root.path, context) !== null);
}

function makeSourceRoot(
    resolved: ResolvedOpencodePath,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    expectedKind: "file" | "directory",
    evidenceLevel: PathLocatorEvidence["evidenceLevel"],
): SourceRoot {
    const inspection = inspectPath(resolved.path, expectedKind);
    return {
        sourceRootId: stableId("source-root", `${rootRole}\0${sourceDomain}\0${resolved.path}`),
        rootRole,
        sourceDomain,
        path: resolved.path,
        accessStatus: inspection.accessStatus,
        locatorEvidence: [
            {
                locatorKind: resolved.locatorKind,
                locatorKey: resolved.locatorKey,
                evidenceLevel,
            },
        ],
        diagnostics: inspection.diagnostics,
    };
}

function makeUserRoot(
    path: string,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    locatorKey: string,
): SourceRoot {
    const inspection = inspectPath(path, "directory");
    return {
        sourceRootId: stableId("source-root", `${rootRole}\0${sourceDomain}\0${path}`),
        rootRole,
        sourceDomain,
        path,
        accessStatus: inspection.accessStatus,
        locatorEvidence: [{ locatorKind: "user_provided_path", locatorKey, evidenceLevel: "user_provided" }],
        diagnostics: inspection.diagnostics,
    };
}

function makeResource(
    resolved: ResolvedOpencodePath,
    roles: AdapterProbeResult["observation"]["agentRuntimeResources"][number]["roles"],
    expectedKind: "file" | "directory",
    evidenceLevel: PathLocatorEvidence["evidenceLevel"],
): AdapterProbeResult["observation"]["agentRuntimeResources"][number] {
    const inspection = inspectPath(resolved.path, expectedKind);
    return {
        agentRuntimeResourceId: stableId("resource", `${roles.join(",")}\0${resolved.path}`),
        roles,
        path: resolved.path,
        accessStatus: inspection.accessStatus,
        locatorEvidence: [
            {
                locatorKind: resolved.locatorKind,
                locatorKey: resolved.locatorKey,
                evidenceLevel,
            },
        ],
        diagnostics: inspection.diagnostics,
    };
}

function inspectPath(path: string, expectedKind: "file" | "directory"): Inspection {
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
        const matches = expectedKind === "file" ? stat.isFile() : stat.isDirectory();
        return matches
            ? { accessStatus: "available", diagnostics: [] }
            : {
                  accessStatus: "unknown",
                  diagnostics: [
                      diagnostic(
                          "opencode_probe_resource_kind_mismatch",
                          `Expected a ${expectedKind} at the opencode path`,
                          "invalid_schema",
                          "warning",
                          path,
                      ),
                  ],
              };
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        if (failure.source === "node_errno_error" && (failure.systemCode === "ENOENT" || failure.systemCode === "ENOTDIR"))
            return { accessStatus: "not_found", diagnostics: [] };
        if (failure.source === "node_errno_error" && failure.failureKind === "permission_denied") {
            return {
                accessStatus: "needs_permission",
                diagnostics: [
                    diagnostic(
                        "opencode_probe_permission_denied",
                        "The opencode path could not be inspected because access was denied",
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
                diagnostic("opencode_probe_io_error", "Could not inspect the opencode path", "partial", "warning", path),
            ],
        };
    }
}

/** Narrow deep-module test seam; not exported from the Provider package barrel. */
export const OPENCODE_PROBE_FOR_TEST = Object.freeze({ findInstallation });
