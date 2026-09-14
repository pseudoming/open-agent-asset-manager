/** Cursor CLI/App installation and invocation-bound Project discovery. Read-only. */

import {
    canonicalProviderHostPathWithinAccessRoot,
    probeDiagnostic as diagnostic,
    hostAbsolutePathToRuntime,
    hostPathApiFor,
    readProviderRegularFileRangeNoFollow,
    resolveProviderProbeEnvironment,
    runtimeAbsolutePathToHost,
    sameProviderRegularFileIdentity,
} from "@oaam/adapter-framework";
import type {
    AdapterProbeContext,
    AdapterProbeResult,
    InstallationEvidence,
    InstallationStatus,
    OperationDiagnostic,
    PlatformContext,
    SourceRoot,
} from "@oaam/core";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";
import { getHomeDir } from "@oaam/shared/paths";
import * as crypto from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";

export interface CursorInstallationSearch {
    status: InstallationStatus;
    versionText: string;
    evidence: InstallationEvidence[];
    diagnostics: OperationDiagnostic[];
}

export async function probeCursor(
    context: AdapterProbeContext,
    environment: NodeJS.ProcessEnv = process.env,
    homeDir: string = getHomeDir(),
    hostPlatform: NodeJS.Platform = process.platform,
): Promise<AdapterProbeResult> {
    const selected = resolveProviderProbeEnvironment(context.platformContext, environment, homeDir, hostPlatform);
    if (selected === null) {
        const issue = diagnostic(
            "cursor_probe_platform_unreachable",
            "The current process cannot inspect the selected Cursor environment",
            "partial",
            "warning",
            context.platformContext.accessRootPath,
        );
        return unavailable(issue);
    }
    environment = selected.environment;
    homeDir = selected.homePath;
    const diagnostics: OperationDiagnostic[] = [];

    const [cli, app] = await Promise.all([
        findCursorAgentInstallation(environment, homeDir, context.platformContext, context.installationRootPath),
        Promise.resolve(findCursorAppInstallation(environment, homeDir, context.platformContext, context.installationRootPath)),
    ]);
    diagnostics.push(...cli.diagnostics, ...app.diagnostics);

    const sourceRoots: SourceRoot[] = [];
    const observedProjects: AdapterProbeResult["observation"]["observedProjects"] = [];
    let projectStatus: AdapterProbeResult["observation"]["observedAgentRuntimes"][number]["projectDiscoveryStatus"] = "not_found";
    if (context.authorizationScope === "project") {
        const rootPath = canonicalProviderHostPathWithinAccessRoot(context.projectRootPath, context.platformContext);
        if (rootPath === null) {
            projectStatus = "partial";
            diagnostics.push(
                diagnostic(
                    "cursor_project_root_invalid",
                    "The authorized Cursor Project root is outside the selected physical access root",
                    "invalid_schema",
                    "error",
                    context.projectRootPath,
                ),
            );
        } else {
            const root = makeSourceRoot(
                rootPath,
                "project_actual",
                "project_root",
                "user_provided_path",
                "probe_project_root",
                "user_provided",
            );
            sourceRoots.push(root);
            const runtimePath =
                hostAbsolutePathToRuntime(context.platformContext.platform, context.platformContext.accessRootPath, rootPath) ??
                rootPath;
            const paths = hostPathApiFor(rootPath);
            const observedProjectId = stableId("project", runtimePath);
            observedProjects.push({
                observedProjectId,
                runtimeProjectKey: runtimePath,
                displayName: paths?.basename(rootPath) ?? runtimePath,
                workspaces: [{ sourceRootId: root.sourceRootId, role: "primary" }],
                evidence: [
                    {
                        evidenceKind: "invocation",
                        locatorKey: "probe_project_root",
                        evidenceLevel: "user_provided",
                    },
                ],
                diagnostics: root.diagnostics,
            });
            projectStatus = statusForRoot(root);
        }
    }

    const paths = hostPathApiFor(homeDir);
    const configPath =
        paths === null
            ? null
            : canonicalProviderHostPathWithinAccessRoot(paths.join(homeDir, ".cursor"), context.platformContext);
    const configRoot =
        configPath === null
            ? null
            : makeSourceRoot(
                  configPath,
                  "config",
                  "agent_runtime_private",
                  "runtime_known_rule",
                  "cursor_user_config_root",
                  "local_artifact",
              );
    if (configRoot !== null) sourceRoots.push(configRoot);
    const sharedSkillPath =
        paths === null
            ? null
            : canonicalProviderHostPathWithinAccessRoot(paths.join(homeDir, ".agents", "skills"), context.platformContext);
    const sharedSkillRoot =
        sharedSkillPath === null
            ? null
            : makeSourceRoot(
                  sharedSkillPath,
                  "source",
                  "family_shared",
                  "runtime_known_rule",
                  "cursor_shared_skill_root",
                  "source_code",
              );
    if (sharedSkillRoot !== null) sourceRoots.push(sharedSkillRoot);

    const sourceRootIds = sourceRoots.map((root) => root.sourceRootId);
    const observedProjectIds = observedProjects.map((project) => project.observedProjectId);
    const targetCandidates: AdapterProbeResult["observation"]["targetCandidates"] = observedProjects.flatMap((project) => {
        const rootId = project.workspaces.find((workspace) => workspace.role === "primary")?.sourceRootId;
        const root = sourceRoots.find((candidate) => candidate.sourceRootId === rootId);
        if (root === undefined) return [];
        return [
            {
                targetCandidateId: stableId("target", root.path),
                targetRootPath: root.path,
                targetKind: "project" as const,
                displayName: project.displayName,
                entryApplicabilities: [
                    targetApplicability("CURSOR_AGENT_CLI", cli, root),
                    targetApplicability("CURSOR_APP", app, root),
                ],
                diagnostics: [...root.diagnostics],
            },
        ];
    });
    if (
        configRoot !== null &&
        configRoot.accessStatus === "available" &&
        configRoot.diagnostics.every((item) => item.severity !== "error")
    ) {
        targetCandidates.push({
            targetCandidateId: stableId("global-target", configRoot.path),
            targetRootPath: configRoot.path,
            targetKind: "global",
            displayName: "Cursor personal assets",
            entryApplicabilities: [
                targetApplicability("CURSOR_AGENT_CLI", cli, configRoot),
                targetApplicability("CURSOR_APP", app, configRoot),
            ],
            diagnostics: [],
        });
    }
    if (
        sharedSkillRoot !== null &&
        sharedSkillRoot.accessStatus === "available" &&
        sharedSkillRoot.diagnostics.every((item) => item.severity !== "error")
    ) {
        targetCandidates.push({
            targetCandidateId: stableId("global-shared-skill-target", sharedSkillRoot.path),
            targetRootPath: sharedSkillRoot.path,
            targetKind: "directory",
            displayName: "Shared personal Cursor Skills",
            entryApplicabilities: [
                targetApplicability("CURSOR_AGENT_CLI", cli, sharedSkillRoot),
                targetApplicability("CURSOR_APP", app, sharedSkillRoot),
            ],
            diagnostics: [],
        });
    }
    const observation: AdapterProbeResult["observation"] = {
        observedAgentRuntimes: [
            observedRuntime("CURSOR_AGENT_CLI", cli, sourceRootIds, observedProjectIds, projectStatus),
            observedRuntime("CURSOR_APP", app, sourceRootIds, observedProjectIds, projectStatus),
        ],
        sourceRoots,
        agentRuntimeResources: [],
        observedProjects,
        targetCandidates,
    };
    diagnostics.push(...sourceRoots.flatMap((root) => root.diagnostics));
    return {
        status:
            diagnostics.length === 0 &&
            [cli.status, app.status].every((status) => status !== "unknown" && status !== "needs_permission") &&
            projectStatus !== "partial" &&
            projectStatus !== "needs_permission"
                ? "complete"
                : "partial",
        observation,
        diagnostics,
    };
}

async function findCursorAgentInstallation(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    context: PlatformContext,
    installationRootPath?: string,
): Promise<CursorInstallationSearch> {
    if (context.platform !== "linux" && context.platform !== "wsl" && context.platform !== "win32") {
        return unknown("cursor_agent_platform_unverified", context.accessRootPath);
    }
    const paths = hostPathApiFor(homeDir);
    if (paths === null) return unknown("cursor_agent_path_grammar_invalid", homeDir);
    const executableName = context.platform === "win32" ? "cursor-agent.exe" : "cursor-agent";
    let discoveryIncomplete = false;
    const candidates: string[] = [];
    if (installationRootPath !== undefined) {
        candidates.push(paths.join(installationRootPath, executableName));
    } else {
        const explicit = environment.CURSOR_AGENT_EXECUTABLE?.trim();
        if (explicit) candidates.push(explicit);
        const runtimePaths = context.platform === "win32" ? path.win32 : path.posix;
        for (const entry of (environment.PATH ?? environment.Path ?? "").split(runtimePaths.delimiter)) {
            if (entry.trim() === "") continue;
            const entryPaths = hostPathApiFor(entry);
            if (entryPaths !== paths) {
                discoveryIncomplete = true;
                continue;
            }
            candidates.push(entryPaths.join(entry, executableName));
        }
        candidates.push(paths.join(homeDir, ".local", "bin", executableName));
    }
    for (const candidate of candidates) {
        const canonical = canonicalProviderHostPathWithinAccessRoot(candidate, context);
        if (canonical === null) {
            discoveryIncomplete = true;
            continue;
        }
        let resolved: string | null;
        let currentBuildObservation: InstallationEvidence["currentBuildObservation"];
        resolved = resolveRegularFile(canonical, context);
        if (resolved === null) continue;
        const versionDirectory = paths.basename(paths.dirname(resolved));
        const versionText = /^20[0-9]{2}\.[0-9]{2}\.[0-9]{2}-[A-Za-z0-9._-]+$/u.test(versionDirectory) ? versionDirectory : "";
        return {
            status: "available",
            versionText,
            evidence: [
                {
                    kind: "launcher",
                    path: resolved,
                    evidenceLevel: "local_artifact",
                    diagnostics: [],
                    ...(currentBuildObservation === undefined ? {} : { currentBuildObservation }),
                },
            ],
            diagnostics:
                versionText === ""
                    ? [
                          diagnostic(
                              "cursor_agent_version_unavailable",
                              "Cursor Agent launcher is readable but its exact version directory is unavailable",
                              "partial",
                              "warning",
                              resolved,
                          ),
                      ]
                    : [],
        };
    }
    const checkedCandidates = candidates.flatMap((candidate) => {
        const canonical = canonicalProviderHostPathWithinAccessRoot(candidate, context);
        return canonical === null ? [] : [canonical];
    });
    return checkedCandidates.length === 0 || discoveryIncomplete
        ? unknown("cursor_agent_install_discovery_incomplete", context.accessRootPath, [])
        : absent(checkedCandidates);
}

function findCursorAppInstallation(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    context: PlatformContext,
    installationRootPath?: string,
): CursorInstallationSearch {
    const paths = hostPathApiFor(homeDir);
    if (paths === null) return unknown("cursor_app_path_grammar_invalid", homeDir);
    const candidates: string[] = [];
    if (installationRootPath !== undefined) {
        const selected = canonicalProviderHostPathWithinAccessRoot(
            paths.join(installationRootPath, context.platform === "win32" ? "Cursor.exe" : "cursor"),
            context,
        );
        if (selected === null) return unknown("cursor_app_install_discovery_incomplete", context.accessRootPath);
        candidates.push(selected);
    }
    const explicitExecutable = environment.CURSOR_APP_EXECUTABLE?.trim();
    if (installationRootPath === undefined && explicitExecutable) {
        const canonical = canonicalProviderHostPathWithinAccessRoot(explicitExecutable, context);
        if (canonical !== null) candidates.push(canonical);
    }
    if (installationRootPath !== undefined) {
        // The one-shot user selection is the only candidate for this exact probe.
    } else if (context.platform === "win32") {
        const localAppData = environment.LOCALAPPDATA?.trim() || paths.join(homeDir, "AppData", "Local");
        candidates.push(paths.join(localAppData, "Programs", "cursor", "Cursor.exe"));
    } else if (context.platform === "linux" || context.platform === "wsl") {
        for (const runtimePath of ["/usr/share/cursor/cursor", "/opt/Cursor/cursor"]) {
            const mapped = runtimeAbsolutePathToHost(context.platform, context.accessRootPath, runtimePath);
            const canonical = mapped === null ? null : canonicalProviderHostPathWithinAccessRoot(mapped, context);
            if (canonical !== null) candidates.push(canonical);
        }
    } else {
        return unknown("cursor_app_platform_unverified", context.accessRootPath);
    }
    for (const candidate of candidates) {
        const installation = inspectCursorAppCandidate(candidate, context);
        if (installation !== null) return installation;
    }
    return candidates.length === 0
        ? unknown("cursor_app_install_discovery_incomplete", context.accessRootPath)
        : absent(candidates);
}

function inspectCursorAppCandidate(candidate: string, context: PlatformContext): CursorInstallationSearch | null {
    const canonical = canonicalProviderHostPathWithinAccessRoot(candidate, context);
    if (canonical === null || !isRegularFile(canonical)) return null;
    const paths = hostPathApiFor(canonical);
    if (paths === null) return null;
    const installRoot = paths.dirname(canonical);
    const productPath = paths.join(installRoot, "resources", "app", "product.json");
    const version = readProductVersion(productPath);
    return {
        status: "available",
        versionText: version ?? "",
        evidence: [
            { kind: "executable", path: canonical, evidenceLevel: "local_artifact", diagnostics: [] },
            { kind: "install_root", path: installRoot, evidenceLevel: "local_artifact", diagnostics: [] },
        ],
        diagnostics:
            version === null
                ? [
                      diagnostic(
                          "cursor_app_version_unavailable",
                          "Cursor App installation is readable but product version metadata is unavailable",
                          "partial",
                          "warning",
                          productPath,
                      ),
                  ]
                : [],
    };
}

function resolveRegularFile(candidate: string, context: PlatformContext): string | null {
    try {
        const resolved = realpathSync(candidate);
        const canonical = canonicalProviderHostPathWithinAccessRoot(resolved, context);
        return canonical !== null && isRegularFile(canonical) ? canonical : null;
    } catch {
        return null;
    }
}

function readProductVersion(productPath: string): string | null {
    try {
        const first = readProviderRegularFileRangeNoFollow(productPath, 0, 512 * 1024 + 1);
        if (first.byteOffset !== 0 || first.totalBytes > 512 * 1024 || first.bytes.byteLength !== first.totalBytes) return null;
        const second = readProviderRegularFileRangeNoFollow(productPath, 0, first.totalBytes);
        if (
            second.byteOffset !== 0 ||
            second.totalBytes !== first.totalBytes ||
            second.bytes.byteLength !== first.bytes.byteLength ||
            !sameProviderRegularFileIdentity(first.identity, second.identity) ||
            !Buffer.from(first.bytes).equals(Buffer.from(second.bytes))
        ) {
            return null;
        }
        return parseProductVersionBytes(first.bytes);
    } catch {
        return null;
    }
}

function parseProductVersionBytes(bytes: Uint8Array): string | null {
    try {
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) return null;
        const version = (parsed as { version?: unknown }).version;
        return typeof version === "string" && version.trim() === version && version !== "" ? version : null;
    } catch {
        return null;
    }
}

function makeSourceRoot(
    path: string,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    locatorKind: SourceRoot["locatorEvidence"][number]["locatorKind"],
    locatorKey: string,
    evidenceLevel: SourceRoot["locatorEvidence"][number]["evidenceLevel"],
): SourceRoot {
    const inspection = inspectPath(path, "directory");
    return {
        sourceRootId: stableId("source-root", `${rootRole}\0${sourceDomain}\0${path}`),
        rootRole,
        sourceDomain,
        path,
        accessStatus: inspection.status,
        locatorEvidence: [{ locatorKind, locatorKey, evidenceLevel }],
        diagnostics: inspection.diagnostics,
    };
}

function inspectPath(path: string, expected: "file" | "directory") {
    try {
        const stat = lstatSync(path);
        const matches = !stat.isSymbolicLink() && (expected === "file" ? stat.isFile() : stat.isDirectory());
        return matches
            ? { status: "available" as const, diagnostics: [] }
            : {
                  status: "unknown" as const,
                  diagnostics: [
                      diagnostic(
                          "cursor_probe_path_kind_invalid",
                          `Cursor path is not a physical ${expected}`,
                          "invalid_schema",
                          "warning",
                          path,
                      ),
                  ],
              };
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        if (failure.source === "node_errno_error" && (failure.systemCode === "ENOENT" || failure.systemCode === "ENOTDIR")) {
            return { status: "not_found" as const, diagnostics: [] };
        }
        if (failure.source === "node_errno_error" && failure.failureKind === "permission_denied") {
            return {
                status: "needs_permission" as const,
                diagnostics: [
                    diagnostic(
                        "cursor_probe_permission_denied",
                        "Cursor path access was denied",
                        "permission_denied",
                        "warning",
                        path,
                    ),
                ],
            };
        }
        return {
            status: "unknown" as const,
            diagnostics: [diagnostic("cursor_probe_io_error", "Cursor path could not be inspected", "partial", "warning", path)],
        };
    }
}

function isRegularFile(path: string): boolean {
    try {
        const stat = lstatSync(path);
        return stat.isFile() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

function observedRuntime(
    agentRuntimeId: "CURSOR_AGENT_CLI" | "CURSOR_APP",
    installation: CursorInstallationSearch,
    sourceRootIds: string[],
    observedProjectIds: string[],
    projectDiscoveryStatus: AdapterProbeResult["observation"]["observedAgentRuntimes"][number]["projectDiscoveryStatus"],
) {
    return {
        agentRuntimeId,
        versionText: installation.versionText,
        installationEvidence: installation.evidence,
        sourceRootIds: [...sourceRootIds],
        agentRuntimeResourceIds: [],
        observedProjectIds: [...observedProjectIds],
        installationStatus: installation.status,
        projectDiscoveryStatus,
        diagnostics: [...installation.diagnostics],
    };
}

function targetApplicability(
    agentRuntimeId: "CURSOR_AGENT_CLI" | "CURSOR_APP",
    installation: CursorInstallationSearch,
    root: SourceRoot,
) {
    return {
        agentRuntimeId,
        status:
            installation.status === "available" &&
            root.accessStatus === "available" &&
            root.diagnostics.every((item) => item.severity !== "error")
                ? ("ready_for_plan" as const)
                : ("unknown" as const),
        locatorEvidence: observedTargetLocatorEvidence(root),
        diagnostics: [...installation.diagnostics, ...root.diagnostics],
    };
}

function observedTargetLocatorEvidence(root: SourceRoot): SourceRoot["locatorEvidence"] {
    return root.locatorEvidence.map((evidence) =>
        evidence.evidenceLevel === "source_code" || evidence.evidenceLevel === "docs_declared"
            ? { ...evidence, evidenceLevel: "local_artifact" as const }
            : { ...evidence },
    );
}

function statusForRoot(root: SourceRoot) {
    return root.accessStatus === "available"
        ? ("complete" as const)
        : root.accessStatus === "not_found"
          ? ("not_found" as const)
          : root.accessStatus === "needs_permission"
            ? ("needs_permission" as const)
            : ("partial" as const);
}

function stableId(namespace: string, value: string): string {
    return `${namespace}:${crypto.createHash("sha256").update(`${namespace}\0${value}`, "utf8").digest("hex")}`;
}

function absent(checkedExecutablePaths: readonly string[]): CursorInstallationSearch {
    return {
        status: "not_found",
        versionText: "",
        evidence: checkedExecutablePaths.map((path) => ({
            kind: "executable",
            path,
            evidenceLevel: "local_artifact",
            diagnostics: [],
        })),
        diagnostics: [],
    };
}

function unknown(
    code: string,
    path: string,
    additionalDiagnostics: readonly OperationDiagnostic[] = [],
): CursorInstallationSearch {
    return {
        status: "unknown",
        versionText: "",
        evidence: [],
        diagnostics: [
            diagnostic(
                code,
                code.endsWith("_path_grammar_invalid")
                    ? "Cursor installation path grammar is unavailable"
                    : code.endsWith("_platform_unverified")
                      ? "Cursor installation discovery is not verified for the selected platform"
                      : "Cursor installation candidates could not all be checked in the selected environment",
                "partial",
                "warning",
                path,
            ),
            ...additionalDiagnostics,
        ],
    };
}

function unavailable(issue: OperationDiagnostic): AdapterProbeResult {
    return {
        status: "partial",
        observation: {
            observedAgentRuntimes: [
                observedRuntime("CURSOR_AGENT_CLI", unknown(issue.code, issue.path), [], [], "unknown"),
                observedRuntime("CURSOR_APP", unknown(issue.code, issue.path), [], [], "unknown"),
            ],
            sourceRoots: [],
            agentRuntimeResources: [],
            observedProjects: [],
            targetCandidates: [],
        },
        diagnostics: [issue],
    };
}

/** Narrow deep-module test seam; not exported from the Provider package barrel. */
export const CURSOR_PROBE_FOR_TEST = Object.freeze({
    findCursorAgentInstallation,
    findCursorAppInstallation,
    inspectCursorAppCandidate,
    resolveRegularFile,
    readProductVersion,
    inspectPath,
    statusForRoot,
});
