/** CLI project-location metadata only; no project values, history or auth fields leave this reader. */
import {
    canonicalProviderHostPathWithinAccessRoot,
    probeDiagnostic as diagnostic,
    hostPathApiFor,
    runtimeAbsolutePathToHost,
} from "@oaam/adapter-framework";
import type { AdapterProbeResult, OperationDiagnostic, PathLocatorEvidence, PlatformContext, SourceRoot } from "@oaam/core";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";
import { CLAUDE_PROJECT_REGISTRY_MAXIMUM_BYTES, projectClaudeRegistryKeys } from "./claudecode-project-key-projection";

export interface ClaudeRegistryProject {
    runtimePath: string;
    hostPath: string;
}
export interface ClaudeProjectRegistry {
    status: "complete" | "partial" | "not_found" | "needs_permission";
    projects: ClaudeRegistryProject[];
    diagnostics: OperationDiagnostic[];
    registryPath?: string;
}

export async function readClaudeProjectRegistry(
    configRoot: string,
    homeDir: string,
    environment: NodeJS.ProcessEnv,
    context: PlatformContext,
    readText: (filePath: string, maximumBytes: number) => Promise<string>,
): Promise<ClaudeProjectRegistry> {
    const paths = hostPathApiFor(configRoot)!;
    // Exact source env.ts precedence: the legacy file, then the selected profile's global config.
    // Environment switches select only a filename; no authentication value is consumed or returned.
    const truthy = (value: string | undefined): boolean => ["1", "true", "yes", "on"].includes(value?.toLowerCase().trim() ?? "");
    const suffix = environment.CLAUDE_CODE_CUSTOM_OAUTH_URL
        ? "-custom-oauth"
        : environment.USER_TYPE === "ant" && truthy(environment.USE_LOCAL_OAUTH)
          ? "-local-oauth"
          : environment.USER_TYPE === "ant" && truthy(environment.USE_STAGING_OAUTH)
            ? "-staging-oauth"
            : "";
    const candidates = [
        paths.join(configRoot, ".config.json"),
        paths.join(environment.CLAUDE_CONFIG_DIR ? configRoot : homeDir, `.claude${suffix}.json`),
    ];
    for (const registryPath of candidates) {
        if (canonicalProviderHostPathWithinAccessRoot(registryPath, context) === null)
            return failed(
                registryPath,
                "claudecode_project_registry_outside_environment",
                "The Claude project index is outside the selected Environment",
            );
        let text: string;
        try {
            text = await readText(registryPath, CLAUDE_PROJECT_REGISTRY_MAXIMUM_BYTES);
        } catch (error) {
            const failure = inspectFilesystemFailure(error);
            if (failure.failureKind === "not_found") continue;
            return failed(
                registryPath,
                failure.failureKind === "permission_denied"
                    ? "claudecode_project_registry_permission_denied"
                    : "claudecode_project_registry_unreadable",
                failure.failureKind === "permission_denied"
                    ? "Access to the Claude project index was denied"
                    : "The Claude project index could not be read as a bounded stable file",
                failure.failureKind === "permission_denied",
            );
        }
        try {
            const keys = projectClaudeRegistryKeys(text);
            const projects: ClaudeRegistryProject[] = [];
            const diagnostics: OperationDiagnostic[] = [];
            for (const runtimePath of keys) {
                const physicalPath = context.platform === "win32" ? runtimePath.replaceAll("/", "\\") : runtimePath;
                const hostPath = runtimeAbsolutePathToHost(context.platform, context.accessRootPath, physicalPath);
                const canonical = hostPath === null ? null : canonicalProviderHostPathWithinAccessRoot(hostPath, context);
                if (canonical === null) {
                    diagnostics.push(
                        diagnostic(
                            "claudecode_project_registry_path_unreachable",
                            "A Claude project locator is invalid or outside the selected Environment; select its Project explicitly",
                            "partial",
                            "warning",
                            registryPath,
                        ),
                    );
                } else projects.push({ runtimePath, hostPath: canonical });
            }
            return { status: diagnostics.length === 0 ? "complete" : "partial", projects, diagnostics, registryPath };
        } catch {
            return failed(
                registryPath,
                "claudecode_project_registry_invalid",
                "The Claude project index has an invalid or oversized locator map; select a Project explicitly",
            );
        }
    }
    return { status: "not_found", projects: [], diagnostics: [] };
}

export function materializeClaudeRegistryProjects(
    registry: ClaudeProjectRegistry,
    makeRoot: (
        filePath: string,
        role: SourceRoot["rootRole"],
        domain: SourceRoot["sourceDomain"],
        evidence: PathLocatorEvidence[],
    ) => SourceRoot,
    stableId: (kind: string, value: string) => string,
): Pick<AdapterProbeResult["observation"], "sourceRoots" | "observedProjects" | "agentRuntimeResources"> {
    const result: Pick<AdapterProbeResult["observation"], "sourceRoots" | "observedProjects" | "agentRuntimeResources"> = {
        sourceRoots: [],
        observedProjects: [],
        agentRuntimeResources: [],
    };
    if (registry.registryPath === undefined) return result;
    const resourceId = stableId("resource", registry.registryPath);
    result.agentRuntimeResources.push({
        agentRuntimeResourceId: resourceId,
        roles: ["project_registry"],
        path: registry.registryPath,
        accessStatus: "available",
        locatorEvidence: [
            { locatorKind: "runtime_known_rule", locatorKey: "claude_cli_project_index", evidenceLevel: "source_code" },
        ],
        diagnostics: [],
    });
    for (const project of registry.projects) {
        const locatorKey = stableId("registry-entry", `${resourceId}\0${project.runtimePath}`);
        const root = makeRoot(project.hostPath, "project_actual", "project_root", [
            { locatorKind: "project_registry_entry", locatorKey, evidenceLevel: "local_artifact" },
        ]);
        if (!result.sourceRoots.some((entry) => entry.sourceRootId === root.sourceRootId)) result.sourceRoots.push(root);
        result.observedProjects.push({
            observedProjectId: stableId("project", project.runtimePath),
            runtimeProjectKey: project.runtimePath,
            displayName: "",
            workspaces: [{ sourceRootId: root.sourceRootId, role: "primary" }],
            evidence: [
                {
                    evidenceKind: "agent_runtime_resource",
                    agentRuntimeResourceId: resourceId,
                    locatorKey,
                    evidenceLevel: "local_artifact",
                },
            ],
            diagnostics: root.diagnostics,
        });
    }
    return result;
}

function failed(filePath: string, code: string, message: string, permission = false): ClaudeProjectRegistry {
    return {
        status: permission ? "needs_permission" : "partial",
        projects: [],
        diagnostics: [diagnostic(code, message, permission ? "permission_denied" : "invalid_schema", "warning", filePath)],
    };
}
