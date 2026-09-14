/** Claude Code installation and source-root discovery. This module is read-only. */

import {
    canonicalHostPath,
    canonicalProviderHostPathWithinAccessRoot,
    compareCodeUnitText as compareText,
    probeDiagnostic as diagnostic,
    hostAbsolutePathToRuntime,
    hostPathApiFor,
    inspectProviderRegularFileNoFollow,
    readProviderRegularFileNoFollow,
    isPlainRecord as isRecord,
    resolveProviderProbeEnvironment,
    runtimeAbsolutePathToHost,
    uniqueSortedStrings as uniqueSorted,
} from "@oaam/adapter-framework";
import type {
    AdapterProbeContext,
    AdapterProbeResult,
    OperationDiagnostic,
    PathLocatorEvidence,
    PlatformContext,
    ResourceAccessStatus,
    SourceRoot,
} from "@oaam/core";
import {
    inspectFilesystemFailure,
    readDirectoryEntriesBounded,
    readRegularFileBounded,
    SafeFilesystemError,
} from "@oaam/shared/filesystem";
import { getHomeDir } from "@oaam/shared/paths";
import * as crypto from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import {
    MAX_SANITIZED_PROJECT_KEY_LENGTH,
    resolveClaudeConfigRoot,
    type ResolvedClaudePath,
    resolveFullMemoryOverride,
    resolveProjectMemoryRoot,
    sanitizePath,
} from "./claudecode-paths";
import { findClaudeCodeAppInstallation } from "./claudecode-probe-app-installation";
import { populateClaudeAppProjects } from "./claudecode-probe-app-projects";
import {
    type ClaudeCodeCliVersionDependencies,
    observeClaudeCodeCliVersion,
    observeClaudeCodeCliVersionForTest,
} from "./claudecode-probe-cli-version";
import {
    availableClaudeExecutable,
    type ClaudeExecutableSearch,
    unavailableClaudeExecutable,
} from "./claudecode-probe-installation-result";
import { resolveClaudeRuntimeProjectBase } from "./claudecode-probe-project-base";
import { materializeClaudeRegistryProjects, readClaudeProjectRegistry } from "./claudecode-probe-project-registry";
import { materializeClaudeCodeTargetCandidates } from "./claudecode-target-candidates";

interface DirectoryInspection {
    accessStatus: ResourceAccessStatus;
    diagnostics: OperationDiagnostic[];
}

interface MemoryResolution {
    resolved: ResolvedClaudePath | null;
    diagnostics: OperationDiagnostic[];
}

const MAX_PROBE_SETTINGS_BYTES = 2 * 1024 * 1024;
const MAX_PROJECT_KEY_DIRECTORY_ENTRIES = 4096;

async function observeClaudeInstallations<TCli, TApp>(
    observeCli: () => Promise<TCli>,
    observeApp: () => Promise<TApp>,
): Promise<readonly [TCli, TApp]> {
    return Promise.all([observeCli(), observeApp()]);
}

export async function probeClaudeCode(
    context: AdapterProbeContext,
    environment: NodeJS.ProcessEnv = process.env,
    homeDir: string = getHomeDir(),
    hostPlatform: NodeJS.Platform = process.platform,
): Promise<AdapterProbeResult> {
    return probeClaudeCodeForTest(context, environment, homeDir, hostPlatform);
}

async function probeClaudeCodeForTest(
    context: AdapterProbeContext,
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    hostPlatform: NodeJS.Platform,
    versionOverrides?: Partial<ClaudeCodeCliVersionDependencies>,
): Promise<AdapterProbeResult> {
    const probeEnvironment = resolveProviderProbeEnvironment(context.platformContext, environment, homeDir, hostPlatform);
    if (probeEnvironment === null) {
        const mismatch = diagnostic(
            "claudecode_probe_platform_unreachable",
            "The current process cannot inspect the requested platform filesystem",
            "partial",
            "warning",
            context.platformContext.accessRootPath,
        );
        return {
            status: "partial",
            observation: {
                observedAgentRuntimes: [runtimeUnknown("CLAUDE_CODE_CLI", mismatch), runtimeUnknown("CLAUDE_CODE_APP", mismatch)],
                sourceRoots: [],
                agentRuntimeResources: [],
                observedProjects: [],
                targetCandidates: [],
            },
            diagnostics: [mismatch],
        };
    }

    environment = probeEnvironment.environment;
    homeDir = probeEnvironment.homePath;
    const diagnostics: OperationDiagnostic[] = [];

    const sourceRoots: SourceRoot[] = [];
    const observedProjects: AdapterProbeResult["observation"]["observedProjects"] = [];
    const agentRuntimeResources: AdapterProbeResult["observation"]["agentRuntimeResources"] = [];
    const cliRootIds: string[] = [];
    const appRootIds: string[] = [];
    const [executable, appInstallation] = await observeClaudeInstallations(
        async () => {
            const discoveredExecutable = await findClaudeExecutable(
                environment,
                homeDir,
                context.platformContext,
                context.installationRootPath,
            );
            return versionOverrides === undefined
                ? observeClaudeCodeCliVersion(discoveredExecutable, context.platformContext, hostPlatform, environment, homeDir)
                : observeClaudeCodeCliVersionForTest(
                      discoveredExecutable,
                      context.platformContext,
                      hostPlatform,
                      environment,
                      homeDir,
                      versionOverrides,
                  );
        },
        () => findClaudeCodeAppInstallation(environment, homeDir, context.platformContext, context.installationRootPath),
    );
    diagnostics.push(...executable.diagnostics, ...appInstallation.diagnostics);

    const resolvedConfig = resolveClaudeConfigRoot(environment, homeDir);
    const config =
        resolvedConfig !== null &&
        canonicalProviderHostPathWithinAccessRoot(resolvedConfig.path, context.platformContext) !== null
            ? resolvedConfig
            : null;
    if (config === null) {
        diagnostics.push(
            diagnostic(
                resolvedConfig === null
                    ? "claudecode_config_root_invalid"
                    : "claudecode_config_root_outside_selected_environment",
                resolvedConfig === null
                    ? "CLAUDE_CONFIG_DIR is not a canonical absolute path"
                    : "The Claude config root falls outside the selected physical access root",
                "invalid_schema",
                "error",
                resolvedConfig?.path ?? environment.CLAUDE_CONFIG_DIR ?? "",
            ),
        );
    } else {
        const configRoot = makeSourceRoot(
            config.path,
            "config",
            "agent_runtime_private",
            locatorEvidence(config, config.locatorKind === "runtime_declared_path" ? "agent_runtime_verified" : "source_code"),
        );
        sourceRoots.push(configRoot);
        cliRootIds.push(configRoot.sourceRootId);
        if (context.platformContext.platform === "win32" && appInstallation.status === "available") {
            appRootIds.push(configRoot.sourceRootId);
        }
    }

    let projectDiscoveryStatus: "complete" | "partial" | "not_found" | "needs_permission" = "not_found";
    if (context.authorizationScope === "project") {
        const projectPath = canonicalProviderHostPathWithinAccessRoot(context.projectRootPath, context.platformContext);
        if (projectPath === null) {
            diagnostics.push(
                diagnostic(
                    "claudecode_project_root_invalid",
                    "The authorized Claude Code project root is not canonical absolute",
                    "invalid_schema",
                    "error",
                    context.projectRootPath,
                ),
            );
            projectDiscoveryStatus = "partial";
        } else {
            const physicalProjectBase = await resolveRuntimeProjectBase(projectPath, context.platformContext);
            diagnostics.push(...physicalProjectBase.diagnostics);
            const runtimeProjectBase =
                hostAbsolutePathToRuntime(
                    context.platformContext.platform,
                    context.platformContext.accessRootPath,
                    physicalProjectBase.path,
                ) ?? physicalProjectBase.path;
            const projectRoot = makeSourceRoot(projectPath, "project_actual", "project_root", [
                {
                    locatorKind: "user_provided_path",
                    locatorKey: "probe_project_root",
                    evidenceLevel: "user_provided",
                },
            ]);
            sourceRoots.push(projectRoot);
            cliRootIds.push(projectRoot.sourceRootId);
            if (context.platformContext.platform === "win32") appRootIds.push(projectRoot.sourceRootId);
            const observedProjectId = stableId("project", runtimeProjectBase);
            observedProjects.push({
                observedProjectId,
                runtimeProjectKey: sanitizePath(runtimeProjectBase),
                displayName: basename(projectPath),
                workspaces: [{ sourceRootId: projectRoot.sourceRootId, role: "primary" }],
                evidence: [
                    {
                        evidenceKind: "invocation",
                        locatorKey: "probe_project_root",
                        evidenceLevel: "user_provided",
                    },
                ],
                diagnostics: [],
            });
            projectDiscoveryStatus =
                projectRoot.accessStatus === "available"
                    ? "complete"
                    : projectRoot.accessStatus === "needs_permission"
                      ? "needs_permission"
                      : "partial";

            if (config !== null) {
                const memory = await resolveMemoryRoot(
                    config,
                    projectPath,
                    runtimeProjectBase,
                    environment,
                    homeDir,
                    context.platformContext,
                );
                diagnostics.push(...memory.diagnostics);
                if (memory.resolved !== null) {
                    const memoryRoot = makeSourceRoot(memory.resolved.path, "source", "project_keyed", [
                        ...locatorEvidence(
                            memory.resolved,
                            memory.resolved.locatorKind === "runtime_declared_path" ? "agent_runtime_verified" : "source_code",
                        ),
                    ]);
                    sourceRoots.push(memoryRoot);
                    cliRootIds.push(memoryRoot.sourceRootId);
                    if (context.platformContext.platform === "win32") appRootIds.push(memoryRoot.sourceRootId);
                }
            }
        }
    } else if (context.authorizationScope === "directory") {
        const directoryPath = canonicalProviderHostPathWithinAccessRoot(context.directoryRootPath, context.platformContext);
        if (directoryPath === null) {
            diagnostics.push(
                diagnostic(
                    "claudecode_external_root_invalid",
                    "The authorized external source root is not canonical absolute",
                    "invalid_schema",
                    "error",
                    context.directoryRootPath,
                ),
            );
            projectDiscoveryStatus = "partial";
        } else {
            const externalRoot = makeSourceRoot(directoryPath, "source", "external_managed", [
                {
                    locatorKind: "user_provided_path",
                    locatorKey: "probe_directory_root",
                    evidenceLevel: "user_provided",
                },
            ]);
            sourceRoots.push(externalRoot);
            cliRootIds.push(externalRoot.sourceRootId);
        }
    } else if (config !== null) {
        const registry = await readClaudeProjectRegistry(
            config.path,
            homeDir,
            environment,
            context.platformContext,
            async (filePath, limit) => readBoundedText(filePath, limit),
        );
        diagnostics.push(...registry.diagnostics);
        projectDiscoveryStatus = registry.status;
        const discovered = materializeClaudeRegistryProjects(registry, makeSourceRoot, stableId);
        sourceRoots.push(...discovered.sourceRoots);
        cliRootIds.push(...discovered.sourceRoots.map((root) => root.sourceRootId));
        observedProjects.push(...discovered.observedProjects);
        agentRuntimeResources.push(...discovered.agentRuntimeResources);
        if (registry.status === "not_found") {
            const projectsDirectory = inspectDirectory(joinHost(config.path, "projects"));
            diagnostics.push(...projectsDirectory.diagnostics);
            projectDiscoveryStatus =
                projectsDirectory.accessStatus === "not_found"
                    ? "not_found"
                    : projectsDirectory.accessStatus === "needs_permission"
                      ? "needs_permission"
                      : "partial";
            if (projectDiscoveryStatus === "partial")
                diagnostics.push(
                    diagnostic(
                        "claudecode_project_index_missing",
                        "Claude project storage exists but its path index was not found; select a Project explicitly",
                        "partial",
                        "warning",
                        joinHost(config.path, "projects"),
                    ),
                );
        }
    }

    const cliDiagnostics = executable.diagnostics;
    const observedProjectIds = observedProjects.map((project) => project.observedProjectId);
    const cliRuntime: AdapterProbeResult["observation"]["observedAgentRuntimes"][number] = {
        agentRuntimeId: "CLAUDE_CODE_CLI",
        versionText: executable.versionText,
        installationEvidence: executable.evidence,
        sourceRootIds: uniqueSorted(cliRootIds),
        agentRuntimeResourceIds: agentRuntimeResources.map((resource) => resource.agentRuntimeResourceId),
        observedProjectIds,
        installationStatus: executable.status,
        projectDiscoveryStatus,
        diagnostics: cliDiagnostics,
    };
    const appRuntime: AdapterProbeResult["observation"]["observedAgentRuntimes"][number] = {
        agentRuntimeId: "CLAUDE_CODE_APP",
        versionText: appInstallation.versionText,
        installationEvidence: appInstallation.evidence,
        sourceRootIds: uniqueSorted(appRootIds),
        agentRuntimeResourceIds: [],
        observedProjectIds:
            context.platformContext.platform === "win32" && context.authorizationScope === "project" ? observedProjectIds : [],
        installationStatus: appInstallation.status,
        projectDiscoveryStatus:
            context.platformContext.platform === "win32" && context.authorizationScope === "project"
                ? projectDiscoveryStatus
                : context.platformContext.platform === "win32"
                  ? "not_found"
                  : "unknown",
        diagnostics: appInstallation.diagnostics,
    };
    const environmentReferences = await populateClaudeAppProjects(
        context,
        environment,
        homeDir,
        appRuntime,
        { sourceRoots, observedProjects, agentRuntimeResources },
        diagnostics,
        (filePath, limit) =>
            Promise.resolve(Buffer.from(readProviderRegularFileNoFollow(filePath, limit).bytes).toString("utf8")),
        makeSourceRoot,
        stableId,
    );
    const observation: AdapterProbeResult["observation"] = {
        observedAgentRuntimes: [cliRuntime, appRuntime],
        sourceRoots: sourceRoots.sort((left, right) => compareText(left.sourceRootId, right.sourceRootId)),
        agentRuntimeResources,
        observedProjects,
        environmentReferences,
        targetCandidates: materializeClaudeCodeTargetCandidates(sourceRoots, observedProjects, cliRuntime, appRuntime),
    };
    const complete =
        observation.observedAgentRuntimes.every(
            (runtime) =>
                runtime.installationStatus !== "unknown" &&
                runtime.installationStatus !== "needs_permission" &&
                runtime.projectDiscoveryStatus !== "unknown" &&
                runtime.projectDiscoveryStatus !== "partial" &&
                runtime.projectDiscoveryStatus !== "needs_permission",
        ) && sourceRoots.every((root) => root.accessStatus !== "unknown" && root.accessStatus !== "needs_permission");
    return { status: complete ? "complete" : "partial", observation, diagnostics };
}

async function resolveMemoryRoot(
    config: ResolvedClaudePath,
    authorizedProjectRootPath: string,
    runtimeProjectBase: string,
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
): Promise<MemoryResolution> {
    const diagnostics: OperationDiagnostic[] = [];
    if (environment.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE?.trim()) {
        const resolved = resolveFullMemoryOverride(
            environment.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE,
            "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE",
            true,
            homeDir,
            platformContext,
        );
        if (resolved === null) diagnostics.push(invalidMemoryOverride("CLAUDE_COWORK_MEMORY_PATH_OVERRIDE"));
        return { resolved, diagnostics };
    }

    const setting = await readTrustedMemorySetting(authorizedProjectRootPath, config.path, diagnostics);
    if (setting !== undefined) {
        const resolved = resolveFullMemoryOverride(setting, "autoMemoryDirectory", true, homeDir, platformContext);
        if (resolved === null) diagnostics.push(invalidMemoryOverride("autoMemoryDirectory"));
        return { resolved, diagnostics };
    }

    const remoteBase = environment.CLAUDE_CODE_REMOTE_MEMORY_DIR?.trim();
    if (remoteBase) {
        const resolved = resolveProjectMemoryRoot({
            configRoot: config.path,
            projectRootPath: runtimeProjectBase,
            remoteMemoryBase: remoteBase,
            homeDir,
            platformContext,
        });
        if (resolved === null) diagnostics.push(invalidMemoryOverride("CLAUDE_CODE_REMOTE_MEMORY_DIR"));
        return { resolved, diagnostics };
    }

    let resolved = resolveProjectMemoryRoot({
        configRoot: config.path,
        projectRootPath: runtimeProjectBase,
        homeDir,
        platformContext,
    });
    if (resolved !== null && sanitizePath(runtimeProjectBase).length > MAX_SANITIZED_PROJECT_KEY_LENGTH) {
        resolved = findExistingLongProjectMemoryRoot(config.path, runtimeProjectBase, diagnostics) ?? resolved;
    }
    return { resolved, diagnostics };
}

async function resolveRuntimeProjectBase(
    projectRootPath: string,
    platformContext: PlatformContext,
    filesystem?: Parameters<typeof resolveClaudeRuntimeProjectBase>[3],
) {
    return resolveClaudeRuntimeProjectBase(
        projectRootPath,
        platformContext,
        async (filePath, maximumBytes) => readBoundedText(filePath, maximumBytes),
        filesystem,
    );
}

async function readTrustedMemorySetting(
    projectRootPath: string,
    configRoot: string,
    diagnostics: OperationDiagnostic[],
): Promise<string | undefined> {
    for (const path of [joinHost(projectRootPath, ".claude", "settings.local.json"), joinHost(configRoot, "settings.json")]) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(await readBoundedText(path, MAX_PROBE_SETTINGS_BYTES));
        } catch (error) {
            if (isNotFound(error)) continue;
            if (
                error instanceof SafeFilesystemError &&
                (error.failureKind === "symlink_or_reparse" || error.failureKind === "wrong_entry_type")
            ) {
                continue;
            }
            diagnostics.push(
                diagnostic(
                    "claudecode_memory_settings_unreadable",
                    "A trusted Claude settings file could not be read or parsed",
                    isPermission(error) ? "permission_denied" : "invalid_schema",
                    "warning",
                    path,
                ),
            );
            continue;
        }
        if (isRecord(parsed) && typeof parsed.autoMemoryDirectory === "string") {
            return parsed.autoMemoryDirectory;
        }
    }
    return undefined;
}

function findExistingLongProjectMemoryRoot(
    configRoot: string,
    projectRootPath: string,
    diagnostics: OperationDiagnostic[],
): ResolvedClaudePath | null {
    const prefix = sanitizePath(projectRootPath).slice(0, MAX_SANITIZED_PROJECT_KEY_LENGTH);
    const projectsDir = joinHost(configRoot, "projects");
    try {
        const entries = readDirectoryEntriesBounded(projectsDir, MAX_PROJECT_KEY_DIRECTORY_ENTRIES)
            .filter((entry) => entry.entryKind === "directory" && entry.name.startsWith(`${prefix}-`))
            .sort((left, right) => compareText(left.name, right.name));
        if (entries.length !== 1) return null;
        return {
            path: joinHost(projectsDir, entries[0]?.name ?? "", "memory"),
            locatorKind: "runtime_known_rule",
            locatorKey: "claude_project_memory_existing_long_key",
        };
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "resource_limit") {
            diagnostics.push(
                diagnostic(
                    "claudecode_memory_project_directory_too_large",
                    "Claude Code project-memory discovery exceeded its bounded entry limit",
                    "invalid_schema",
                    "warning",
                    projectsDir,
                ),
            );
        }
        return null;
    }
}

function readBoundedText(path: string, maximumBytes: number): string {
    return Buffer.from(readRegularFileBounded(path, maximumBytes)).toString("utf8");
}

async function findClaudeExecutable(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
    installationRootPath?: string,
): Promise<ClaudeExecutableSearch> {
    const platform = platformContext.platform;
    const executableName = platform === "win32" ? "claude.exe" : "claude";
    const runtimePaths = platform === "win32" ? path.win32 : path.posix;
    let discoveryIncomplete = false;
    if (installationRootPath !== undefined) {
        const paths = hostPathApiFor(installationRootPath);
        const selected =
            paths === null
                ? null
                : canonicalProviderHostPathWithinAccessRoot(paths.join(installationRootPath, executableName), platformContext);
        if (selected === null) discoveryIncomplete = true;
        else {
            const manual = await inspectClaudeExecutableCandidates([selected], platform, platformContext);
            if (manual !== null) return manual;
        }
        return unavailableClaudeExecutable(
            discoveryIncomplete ? "unknown" : "not_found",
            discoveryIncomplete ? "claudecode_install_discovery_incomplete" : "claudecode_executable_not_found",
            installationRootPath,
        );
    }
    const fixedRuntimeCandidates = platform === "win32" ? [] : ["/usr/local/bin", "/usr/bin"];
    const runtimeCandidates = fixedRuntimeCandidates.flatMap((base) => {
        const hostBase = runtimeAbsolutePathToHost(platform, platformContext.accessRootPath, base);
        if (hostBase === null) {
            discoveryIncomplete = true;
            return [];
        }
        return [joinHost(hostBase, executableName)];
    });
    const pathCandidates = (environment.PATH ?? "")
        .split(runtimePaths.delimiter)
        .filter((candidate) => candidate !== "")
        .flatMap((candidate) => {
            const canonical = canonicalAbsolute(candidate);
            if (canonical === null) {
                discoveryIncomplete = true;
                return [];
            }
            return [joinHost(canonical, executableName)];
        });
    const candidates = uniqueSorted(
        [...pathCandidates, joinHost(homeDir, ".local", "bin", executableName), ...runtimeCandidates]
            .map((candidate) => resolveHost(candidate))
            .flatMap((candidate) => {
                const canonical = canonicalProviderHostPathWithinAccessRoot(candidate, platformContext);
                if (canonical === null) {
                    discoveryIncomplete = true;
                    return [];
                }
                return [canonical];
            }),
    );
    let permissionDenied = false;
    for (const candidate of candidates) {
        try {
            const link = lstatSync(candidate);
            const actualPath = canonicalProviderHostPathWithinAccessRoot(
                link.isSymbolicLink() ? realpathSync(candidate) : candidate,
                platformContext,
            );
            if (actualPath === null) {
                discoveryIncomplete = true;
                continue;
            }
            const stat = statSync(actualPath);
            const executable = stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0);
            if (!executable) continue;
            return availableClaudeExecutable(actualPath, inspectProviderRegularFileNoFollow(actualPath));
        } catch (error) {
            if (isPermission(error)) {
                permissionDenied = true;
            }
        }
    }
    const status = permissionDenied ? "needs_permission" : discoveryIncomplete ? "unknown" : "not_found";
    const resultDiagnostic = diagnostic(
        permissionDenied
            ? "claudecode_executable_permission"
            : discoveryIncomplete
              ? "claudecode_install_discovery_incomplete"
              : "claudecode_executable_not_found",
        permissionDenied
            ? "At least one Claude CLI executable candidate could not be inspected"
            : discoveryIncomplete
              ? "At least one Claude CLI executable candidate falls outside the selected physical access root or is invalid"
              : "No executable Claude CLI was found in the authorized PATH/fallback locations",
        permissionDenied || discoveryIncomplete ? (permissionDenied ? "permission_denied" : "partial") : "not_found",
        "warning",
    );
    return {
        status,
        evidence:
            status === "not_found"
                ? candidates.map((candidate) => ({
                      kind: "executable" as const,
                      path: canonicalAbsolute(candidate) ?? candidate,
                      evidenceLevel: "local_artifact" as const,
                      diagnostics: [],
                  }))
                : [],
        diagnostics: [resultDiagnostic],
        executable: null,
    };
}

async function inspectClaudeExecutableCandidates(
    candidates: readonly string[],
    platform: PlatformContext["platform"],
    platformContext: PlatformContext,
): Promise<ClaudeExecutableSearch | null> {
    for (const candidate of candidates) {
        try {
            const link = lstatSync(candidate);
            const actualPath = canonicalProviderHostPathWithinAccessRoot(
                link.isSymbolicLink() ? realpathSync(candidate) : candidate,
                platformContext,
            );
            if (actualPath === null) continue;
            const stat = statSync(actualPath);
            if (!stat.isFile() || (platform !== "win32" && (stat.mode & 0o111) === 0)) continue;
            return availableClaudeExecutable(actualPath, inspectProviderRegularFileNoFollow(actualPath));
        } catch (error) {}
    }
    return null;
}

function makeSourceRoot(
    path: string,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    evidence: PathLocatorEvidence[],
): SourceRoot {
    const inspected = inspectDirectory(path);
    return {
        sourceRootId: stableId("source-root", `${rootRole}\0${sourceDomain}\0${path}`),
        rootRole,
        sourceDomain,
        path,
        accessStatus: inspected.accessStatus,
        locatorEvidence: evidence,
        diagnostics: inspected.diagnostics,
    };
}

function inspectDirectory(path: string): DirectoryInspection {
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
            return {
                accessStatus: "unknown",
                diagnostics: [
                    diagnostic(
                        "claudecode_source_root_symlink",
                        "Claude Code source root symlinks are not followed",
                        "unsupported",
                        "warning",
                        path,
                    ),
                ],
            };
        }
        if (!stat.isDirectory()) {
            return {
                accessStatus: "unknown",
                diagnostics: [
                    diagnostic(
                        "claudecode_source_root_not_directory",
                        "Claude Code source root exists but is not a directory",
                        "invalid_schema",
                        "warning",
                        path,
                    ),
                ],
            };
        }
        accessSync(path, constants.R_OK);
        return { accessStatus: "available", diagnostics: [] };
    } catch (error) {
        if (isNotFound(error)) return { accessStatus: "not_found", diagnostics: [] };
        return {
            accessStatus: isPermission(error) ? "needs_permission" : "unknown",
            diagnostics: [
                diagnostic(
                    "claudecode_source_root_unreadable",
                    "Claude Code source root could not be inspected",
                    isPermission(error) ? "permission_denied" : "unavailable",
                    "warning",
                    path,
                ),
            ],
        };
    }
}

function locatorEvidence(path: ResolvedClaudePath, evidenceLevel: PathLocatorEvidence["evidenceLevel"]): PathLocatorEvidence[] {
    return [
        {
            locatorKind: path.locatorKind,
            locatorKey: path.locatorKey,
            evidenceLevel,
        },
    ];
}

function runtimeUnknown(agentRuntimeId: "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP", runtimeDiagnostic: OperationDiagnostic) {
    return {
        agentRuntimeId,
        versionText: "",
        installationEvidence: [],
        sourceRootIds: [],
        agentRuntimeResourceIds: [],
        observedProjectIds: [],
        installationStatus: "unknown" as const,
        projectDiscoveryStatus: "unknown" as const,
        diagnostics: [runtimeDiagnostic],
    };
}

function invalidMemoryOverride(locatorKey: string): OperationDiagnostic {
    return diagnostic(
        "claudecode_memory_override_invalid",
        `${locatorKey} does not resolve to a safe canonical memory root`,
        "invalid_schema",
        "error",
    );
}

function stableId(kind: string, value: string): string {
    const digest = crypto.createHash("sha256").update(`${kind}\0${value}`, "utf8").digest("hex");
    return `claudecode-${kind}-${digest}`;
}

function canonicalAbsolute(value: string): string | null {
    const canonical = canonicalHostPath(value);
    return canonical === null || canonical === "\\" ? null : canonical;
}

function joinHost(base: string, ...segments: string[]): string {
    const paths = hostPathApiFor(base);
    if (paths === null) throw new TypeError("Claude Code path base must be canonical absolute");
    return paths.join(base, ...segments);
}

function resolveHost(value: string): string {
    const paths = hostPathApiFor(value);
    if (paths === null) throw new TypeError("Claude Code path must be canonical absolute");
    return paths.resolve(value);
}

function basename(value: string): string {
    const paths = hostPathApiFor(value);
    return paths === null ? value : paths.basename(value) || value;
}

function isNotFound(error: unknown): boolean {
    const inspection = inspectFilesystemFailure(error);
    return (
        inspection.failureKind === "not_found" ||
        (inspection.source === "node_errno_error" && inspection.systemCode === "ENOTDIR")
    );
}

function isPermission(error: unknown): boolean {
    return inspectFilesystemFailure(error).failureKind === "permission_denied";
}

/** Narrow deep-module test seam; not exported from the Provider package barrel. */
export const CLAUDECODE_PROBE_FOR_TEST = Object.freeze({
    findClaudeExecutable,
    observeClaudeInstallations,
    probeClaudeCodeForTest,
    readTrustedMemorySetting,
    resolveRuntimeProjectBase,
});
