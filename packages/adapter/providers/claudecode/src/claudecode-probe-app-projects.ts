/** Historical App-owned project anchors, confined to selected-Environment profile metadata. */
import {
    canonicalProviderHostPathWithinAccessRoot,
    probeDiagnostic as diagnostic,
    hostPathApiFor,
    inspectProviderDirectoryNoFollow,
    inventoryProviderDirectoryNoFollow,
    type ProviderDirectoryInventory,
    runtimeAbsolutePathToHost,
    sameProviderPathIdentity,
} from "@oaam/adapter-framework";
import type { AdapterProbeContext, AdapterProbeResult, OperationDiagnostic, PlatformContext } from "@oaam/core";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";
import { CLAUDE_APP_PROJECT_MAXIMUM_BYTES, projectClaudeAppLocation } from "./claudecode-app-project-projection";
import type { materializeClaudeRegistryProjects } from "./claudecode-probe-project-registry";

type Observation = AdapterProbeResult["observation"];
interface AppProjects extends Pick<Observation, "sourceRoots" | "observedProjects" | "agentRuntimeResources"> {
    environmentReferences: NonNullable<Observation["environmentReferences"]>;
    status: "complete" | "not_found" | "partial" | "needs_permission";
    diagnostics: OperationDiagnostic[];
}
interface Dependencies {
    inventory: typeof inventoryProviderDirectoryNoFollow;
    inspectDirectory: typeof inspectProviderDirectoryNoFollow;
    now: () => number;
}

export async function populateClaudeAppProjects(
    context: AdapterProbeContext,
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    appRuntime: Observation["observedAgentRuntimes"][number],
    observation: Pick<Observation, "sourceRoots" | "observedProjects" | "agentRuntimeResources">,
    diagnostics: OperationDiagnostic[],
    readText: Parameters<typeof discoverClaudeAppProjects>[4],
    makeRoot: Parameters<typeof discoverClaudeAppProjects>[5],
    stableId: Parameters<typeof discoverClaudeAppProjects>[6],
): Promise<AppProjects["environmentReferences"]> {
    if (context.authorizationScope !== "global") return [];
    const found = await discoverClaudeAppProjects(
        environment,
        homeDir,
        context.platformContext,
        appRuntime.installationStatus === "available",
        readText,
        makeRoot,
        stableId,
    );
    appRuntime.sourceRootIds.push(...found.sourceRoots.map((root) => root.sourceRootId));
    appRuntime.agentRuntimeResourceIds = found.agentRuntimeResources.map((resource) => resource.agentRuntimeResourceId);
    appRuntime.observedProjectIds = found.observedProjects.map((project) => project.observedProjectId);
    appRuntime.projectDiscoveryStatus = found.status;
    appRuntime.diagnostics = [...appRuntime.diagnostics, ...found.diagnostics];
    for (const root of found.sourceRoots) {
        const existing = observation.sourceRoots.find((item) => item.sourceRootId === root.sourceRootId);
        if (existing) existing.locatorEvidence.push(...root.locatorEvidence);
        else observation.sourceRoots.push(root);
    }
    observation.observedProjects.push(...found.observedProjects);
    observation.agentRuntimeResources.push(...found.agentRuntimeResources);
    diagnostics.push(...found.diagnostics);
    return found.environmentReferences;
}

export function claudeAppProfileRoots(environment: NodeJS.ProcessEnv, homeDir: string, context: PlatformContext): string[] {
    const paths = hostPathApiFor(homeDir);
    if (paths === null) return [];
    if (context.platform === "win32") {
        const roaming = environment.APPDATA?.trim() || paths.join(homeDir, "AppData", "Roaming");
        const local = environment.LOCALAPPDATA?.trim() || paths.join(homeDir, "AppData", "Local");
        return [
            paths.join(roaming, "Claude"),
            paths.join(local, "Claude-3p"),
            paths.join(roaming, "Claude-3p"),
            ...(roaming.startsWith("\\\\") ? [paths.join(local, "Claude-Data")] : []),
        ];
    }
    const config =
        context.platform === "darwin"
            ? paths.join(homeDir, "Library", "Application Support")
            : environment.XDG_CONFIG_HOME
              ? runtimeAbsolutePathToHost(context.platform, context.accessRootPath, environment.XDG_CONFIG_HOME)
              : paths.join(homeDir, ".config");
    return config === null ? [] : [paths.join(config, "Claude"), paths.join(config, "Claude-3p")];
}

export async function discoverClaudeAppProjects(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    context: PlatformContext,
    appAvailable: boolean,
    readText: (filePath: string, maximumBytes: number) => Promise<string>,
    makeRoot: Parameters<typeof materializeClaudeRegistryProjects>[1],
    stableId: Parameters<typeof materializeClaudeRegistryProjects>[2],
    overrides: Partial<Dependencies> = {},
): Promise<AppProjects> {
    const io: Dependencies = {
        inventory: inventoryProviderDirectoryNoFollow,
        inspectDirectory: inspectProviderDirectoryNoFollow,
        now: Date.now,
        ...overrides,
    };
    const result: AppProjects = {
        sourceRoots: [],
        observedProjects: [],
        agentRuntimeResources: [],
        environmentReferences: [],
        status: "not_found",
        diagnostics: [],
    };
    const startedAt = io.now();
    let remainingEntries = 4096,
        remainingDirectories = 256,
        remainingFiles = 128,
        remainingBytes = 16 * 1024 * 1024;
    const issue = (code: string, message: string, filePath = "", permission = false): void => {
        result.status = permission && result.status !== "partial" ? "needs_permission" : "partial";
        result.diagnostics.push(diagnostic(code, message, permission ? "permission_denied" : "partial", "warning", filePath));
    };
    const checkBudget = (): void => {
        if (
            io.now() - startedAt >= 10_000 ||
            remainingEntries <= 0 ||
            remainingDirectories <= 0 ||
            remainingFiles <= 0 ||
            remainingBytes <= 0
        )
            throw new RangeError("App project discovery bound reached");
    };
    const list = (directory: string, maximum: number): ProviderDirectoryInventory => {
        checkBudget();
        const snapshot = io.inventory(directory, Math.min(maximum, remainingEntries));
        remainingEntries -= snapshot.entries.length;
        remainingDirectories--;
        return snapshot;
    };
    const unchanged = (directory: string, snapshot: ProviderDirectoryInventory): void => {
        if (!sameProviderPathIdentity(snapshot.identity, io.inspectDirectory(directory)))
            throw new Error("App metadata directory changed");
    };
    // These are retained locations, not an assertion of the App's current login or active profile.
    // Packaged App removes unapproved CLAUDE_USER_DATA_DIR; never follow the caller's variable.
    const profiles = claudeAppProfileRoots(environment, homeDir, context);
    if (profiles.length === 0)
        issue(
            "claudecode_app_profile_unresolved",
            "The Claude App profile root could not be resolved in the selected Environment",
        );
    for (const profile of profiles) {
        const paths = hostPathApiFor(profile)!;
        const base = paths.join(profile, "claude-code-sessions");
        if (canonicalProviderHostPathWithinAccessRoot(base, context) === null) {
            issue("claudecode_app_profile_outside_environment", "A known Claude App profile is outside the selected Environment");
            continue;
        }
        let baseSnapshot: ProviderDirectoryInventory;
        try {
            baseSnapshot = list(base, 256);
        } catch (error) {
            const failure = inspectFilesystemFailure(error);
            if (failure.failureKind !== "not_found")
                issue(
                    "claudecode_app_project_index_unreadable",
                    "Claude App project metadata is unreadable, changed or exceeds its bound; select a Project explicitly",
                    base,
                    failure.failureKind === "permission_denied",
                );
            continue;
        }
        if (result.status === "not_found") result.status = "complete";
        const resourceId = stableId("resource", base);
        result.agentRuntimeResources.push({
            agentRuntimeResourceId: resourceId,
            roles: ["project_registry"],
            path: base,
            accessStatus: "available",
            locatorEvidence: [
                {
                    locatorKind: "runtime_known_rule",
                    locatorKey: "claude_app_retained_project_locations",
                    evidenceLevel: "source_code",
                },
            ],
            diagnostics: [],
        });
        const profileProjects: AppProjects["observedProjects"] = [],
            profileRoots: AppProjects["sourceRoots"] = [],
            profileReferences: AppProjects["environmentReferences"] = [];
        try {
            for (const account of baseSnapshot.entries) {
                if (!/^[0-9a-fA-F-]{8,36}$/u.test(account.relativeName)) continue;
                if (account.identity.entryKind !== "directory") throw new Error("App account metadata is not a directory");
                const accountPath = paths.join(base, account.relativeName),
                    accountSnapshot = list(accountPath, 256);
                for (const org of accountSnapshot.entries) {
                    if (org.identity.entryKind !== "directory") continue;
                    const orgPath = paths.join(accountPath, org.relativeName),
                        orgSnapshot = list(orgPath, 4096);
                    for (const entry of orgSnapshot.entries) {
                        if (!/^local_[^/\\\0]+\.json$/u.test(entry.relativeName)) continue;
                        checkBudget();
                        const filePath = paths.join(orgPath, entry.relativeName);
                        try {
                            if (entry.identity.entryKind !== "file") throw new Error("App locator is not a regular file");
                            remainingFiles--;
                            const text = await readText(filePath, Math.min(CLAUDE_APP_PROJECT_MAXIMUM_BYTES, remainingBytes));
                            remainingBytes -= Buffer.byteLength(text);
                            const locator = projectClaudeAppLocation(text);
                            // Backend selection in App is SSH first, WSL second, local last.
                            if (locator.ssh) {
                                issue(
                                    "claudecode_app_project_ssh_unselected",
                                    "A retained Claude App project belongs to SSH and is outside the selected Environment",
                                    base,
                                );
                                continue;
                            }
                            // originCwd owns the user's project; cwd may be an App-created worktree/scratch.
                            if (!locator.originCwd) continue;
                            const locatorKey = stableId(
                                "app-project-locator",
                                `${resourceId}\0${paths.relative(base, filePath)}`,
                            );
                            if (
                                locator.wslDistro !== null &&
                                !(
                                    context.platform === "wsl" &&
                                    context.platformInstanceId.toLowerCase() === locator.wslDistro.toLowerCase()
                                )
                            ) {
                                if (
                                    context.platform === "win32" &&
                                    appAvailable &&
                                    !profileReferences.some(
                                        (reference) => reference.referencedEnvironment.platformInstanceId === locator.wslDistro,
                                    )
                                ) {
                                    profileReferences.push({
                                        referenceId: stableId("app-environment-reference", locator.wslDistro),
                                        agentRuntimeId: "CLAUDE_CODE_APP",
                                        referenceKind: "project",
                                        referencedEnvironment: { platform: "wsl", platformInstanceId: locator.wslDistro },
                                        validationState: "not_checked",
                                        evidence: {
                                            agentRuntimeResourceId: resourceId,
                                            locatorKey,
                                            evidenceLevel: "local_artifact",
                                        },
                                    });
                                }
                                issue(
                                    "claudecode_app_project_environment_unselected",
                                    "A retained Claude App project belongs to another Environment; select that Environment to inspect it",
                                    base,
                                );
                                continue;
                            }
                            const physicalPath =
                                context.platform === "win32" ? locator.originCwd.replaceAll("/", "\\") : locator.originCwd;
                            const hostPath = runtimeAbsolutePathToHost(context.platform, context.accessRootPath, physicalPath);
                            const canonical =
                                hostPath === null ? null : canonicalProviderHostPathWithinAccessRoot(hostPath, context);
                            if (canonical === null) {
                                issue(
                                    "claudecode_app_project_path_unreachable",
                                    "A retained Claude App project path is invalid or outside the selected Environment",
                                    base,
                                );
                                continue;
                            }
                            const scratch = paths.join(profile, "scratch-workspaces"),
                                relative = paths.relative(scratch, canonical);
                            if (
                                relative === "" ||
                                (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
                            )
                                continue;
                            const root = makeRoot(canonical, "project_actual", "project_root", [
                                { locatorKind: "project_registry_entry", locatorKey, evidenceLevel: "local_artifact" },
                            ]);
                            if (!profileRoots.some((item) => item.sourceRootId === root.sourceRootId)) profileRoots.push(root);
                            const observedProjectId = stableId("app-project", locator.originCwd),
                                evidence = {
                                    evidenceKind: "agent_runtime_resource" as const,
                                    agentRuntimeResourceId: resourceId,
                                    locatorKey,
                                    evidenceLevel: "local_artifact" as const,
                                };
                            const existing = profileProjects.find((project) => project.observedProjectId === observedProjectId);
                            if (existing) existing.evidence.push(evidence);
                            else
                                profileProjects.push({
                                    observedProjectId,
                                    runtimeProjectKey: locator.originCwd,
                                    displayName: "",
                                    workspaces: [{ sourceRootId: root.sourceRootId, role: "primary" }],
                                    evidence: [evidence],
                                    diagnostics: root.diagnostics,
                                });
                        } catch (error) {
                            issue(
                                "claudecode_app_project_locator_unreadable",
                                "A Claude App project locator is invalid, unreadable or exceeds its bound; select its Project explicitly",
                                base,
                                inspectFilesystemFailure(error).failureKind === "permission_denied",
                            );
                        }
                    }
                    unchanged(orgPath, orgSnapshot);
                }
                unchanged(accountPath, accountSnapshot);
            }
            unchanged(base, baseSnapshot);
            for (const root of profileRoots)
                if (!result.sourceRoots.some((item) => item.sourceRootId === root.sourceRootId)) result.sourceRoots.push(root);
            for (const project of profileProjects) {
                const existing = result.observedProjects.find((item) => item.observedProjectId === project.observedProjectId);
                if (existing) existing.evidence.push(...project.evidence);
                else result.observedProjects.push(project);
            }
            for (const reference of profileReferences)
                if (!result.environmentReferences.some((item) => item.referenceId === reference.referenceId))
                    result.environmentReferences.push(reference);
        } catch (error) {
            issue(
                "claudecode_app_project_index_incomplete",
                "Claude App project metadata changed, is unreadable or exceeds the bounded enumeration; select a Project explicitly",
                base,
                inspectFilesystemFailure(error).failureKind === "permission_denied",
            );
        }
    }
    return result;
}
