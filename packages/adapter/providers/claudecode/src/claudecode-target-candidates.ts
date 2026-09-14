/** Claude Code target-candidate projection from exact probe observations. */

import * as crypto from "node:crypto";
import { compareCodeUnitText as compareText, probeDiagnostic as diagnostic } from "@oaam/adapter-framework";
import type { AdapterProbeResult, PathLocatorEvidence, SourceRoot } from "@oaam/core";

type ObservedProject = AdapterProbeResult["observation"]["observedProjects"][number];
type ObservedRuntime = AdapterProbeResult["observation"]["observedAgentRuntimes"][number];
type TargetApplicability = AdapterProbeResult["observation"]["targetCandidates"][number]["entryApplicabilities"][number];

export function materializeClaudeCodeTargetCandidates(
    sourceRoots: SourceRoot[],
    observedProjects: AdapterProbeResult["observation"]["observedProjects"],
    cliRuntime: ObservedRuntime,
    appRuntime: ObservedRuntime = unknownAppRuntime(),
): AdapterProbeResult["observation"]["targetCandidates"] {
    const runtimeProjectIds = new Set(cliRuntime.observedProjectIds);
    const projectCandidates = sourceRoots
        .filter((root) => root.rootRole === "project_actual" && root.sourceDomain === "project_root")
        .flatMap((root) => {
            const projects = observedProjects.filter(
                (project) =>
                    runtimeProjectIds.has(project.observedProjectId) &&
                    project.workspaces.some(
                        (workspace) => workspace.role === "primary" && workspace.sourceRootId === root.sourceRootId,
                    ),
            );
            if (projects.length !== 1) return [];
            const project = projects[0] as (typeof projects)[number];
            return [
                {
                    targetCandidateId: stableTargetId("target", root.sourceRootId),
                    targetRootPath: root.path,
                    targetKind: "project" as const,
                    displayName: project.displayName,
                    entryApplicabilities: [
                        claudeCliTargetApplicability(root, project, cliRuntime),
                        claudeAppTargetApplicability(root, project, appRuntime),
                    ],
                    diagnostics: [],
                },
            ];
        });
    const appProjectIds = new Set(appRuntime.observedProjectIds);
    const selectedMemoryProjects = observedProjects.filter(
        (project) => runtimeProjectIds.has(project.observedProjectId) || appProjectIds.has(project.observedProjectId),
    );
    const memoryCandidates =
        selectedMemoryProjects.length === 1
            ? sourceRoots
                  .filter(
                      (root) =>
                          root.rootRole === "source" &&
                          root.sourceDomain === "project_keyed" &&
                          root.accessStatus === "available" &&
                          root.diagnostics.every((item) => item.severity !== "error") &&
                          (cliRuntime.sourceRootIds.includes(root.sourceRootId) ||
                              appRuntime.sourceRootIds.includes(root.sourceRootId)),
                  )
                  .map((root) => ({
                      targetCandidateId: stableTargetId("memory-target", root.sourceRootId),
                      targetRootPath: root.path,
                      targetKind: "directory" as const,
                      displayName: `${(selectedMemoryProjects[0] as ObservedProject).displayName} Claude Code Memory`,
                      entryApplicabilities: [
                          claudeCliMemoryTargetApplicability(root, selectedMemoryProjects[0] as ObservedProject, cliRuntime),
                          claudeAppMemoryTargetApplicability(root, selectedMemoryProjects[0] as ObservedProject, appRuntime),
                      ],
                      diagnostics: [],
                  }))
            : [];
    const globalCandidates = sourceRoots
        .filter(
            (root) =>
                root.rootRole === "config" &&
                root.sourceDomain === "agent_runtime_private" &&
                root.accessStatus === "available" &&
                root.diagnostics.every((item) => item.severity !== "error") &&
                (cliRuntime.sourceRootIds.includes(root.sourceRootId) || appRuntime.sourceRootIds.includes(root.sourceRootId)),
        )
        .map((root) => ({
            targetCandidateId: stableTargetId("global-target", root.sourceRootId),
            targetRootPath: root.path,
            targetKind: "global" as const,
            displayName: "Claude Code global configuration",
            entryApplicabilities: [
                claudeCliGlobalTargetApplicability(root, cliRuntime),
                claudeAppGlobalTargetApplicability(root, appRuntime),
            ],
            diagnostics: [],
        }));
    return [...projectCandidates, ...memoryCandidates, ...globalCandidates].sort((left, right) =>
        compareText(`${left.targetRootPath}\0${left.targetKind}`, `${right.targetRootPath}\0${right.targetKind}`),
    );
}

function claudeCliGlobalTargetApplicability(root: SourceRoot, cliRuntime: ObservedRuntime): TargetApplicability {
    const base = {
        agentRuntimeId: "CLAUDE_CODE_CLI" as const,
        locatorEvidence: observedTargetLocatorEvidence(root),
    };
    if (cliRuntime.installationStatus === "not_found") {
        return {
            ...base,
            status: "invalid",
            diagnostics: [
                diagnostic(
                    "claudecode_cli_global_target_installation_not_found",
                    "Claude Code CLI global targets cannot be planned without an installed CLI",
                    "not_found",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        cliRuntime.installationStatus !== "available" ||
        cliRuntime.diagnostics.some((item) => item.severity === "error") ||
        !cliRuntime.installationEvidence.some(
            (evidence) =>
                (evidence.kind === "executable" || evidence.kind === "launcher") &&
                (evidence.evidenceLevel === "agent_runtime_verified" || evidence.evidenceLevel === "local_artifact") &&
                !evidence.diagnostics.some((item) => item.severity === "error"),
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    "claudecode_cli_global_target_build_evidence_unavailable",
                    "Claude Code CLI global target planning needs one readable build-bearing installation observation",
                    cliRuntime.installationStatus === "needs_permission" ? "permission_denied" : "partial",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    return { ...base, status: "ready_for_plan", diagnostics: [] };
}

function claudeAppGlobalTargetApplicability(root: SourceRoot, appRuntime: ObservedRuntime): TargetApplicability {
    const base = {
        agentRuntimeId: "CLAUDE_CODE_APP" as const,
        locatorEvidence: observedTargetLocatorEvidence(root),
    };
    if (appRuntime.installationStatus === "not_found") {
        return {
            ...base,
            status: "invalid",
            diagnostics: [
                diagnostic(
                    "claudecode_app_global_target_installation_not_found",
                    "Claude Code App global targets cannot be planned without an installed App-owned Code engine",
                    "not_found",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        appRuntime.installationStatus !== "available" ||
        appRuntime.diagnostics.some((item) => item.severity === "error") ||
        !appRuntime.sourceRootIds.includes(root.sourceRootId) ||
        !appRuntime.installationEvidence.some(
            (evidence) =>
                evidence.kind === "executable" &&
                evidence.evidenceLevel === "agent_runtime_verified" &&
                !evidence.diagnostics.some((item) => item.severity === "error"),
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    "claudecode_app_global_target_build_evidence_unavailable",
                    "Claude Code App global target planning needs one exact App-owned Code-engine observation and config root",
                    appRuntime.installationStatus === "needs_permission" ? "permission_denied" : "partial",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    return { ...base, status: "ready_for_plan", diagnostics: [] };
}

function observedTargetLocatorEvidence(root: SourceRoot): PathLocatorEvidence[] {
    return root.locatorEvidence.map((evidence) =>
        evidence.evidenceLevel === "source_code"
            ? {
                  ...evidence,
                  evidenceLevel: "local_artifact" as const,
              }
            : evidence,
    );
}

function claudeCliMemoryTargetApplicability(
    root: SourceRoot,
    project: ObservedProject,
    cliRuntime: ObservedRuntime,
): TargetApplicability {
    const base = {
        agentRuntimeId: "CLAUDE_CODE_CLI" as const,
        locatorEvidence: observedTargetLocatorEvidence(root),
    };
    if (cliRuntime.installationStatus === "not_found") {
        return {
            ...base,
            status: "invalid",
            diagnostics: [
                diagnostic(
                    "claudecode_cli_memory_target_installation_not_found",
                    "Claude Code CLI Memory topics cannot be planned without an installed CLI",
                    "not_found",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        cliRuntime.installationStatus !== "available" ||
        !cliRuntime.installationEvidence.some(
            (evidence) =>
                (evidence.kind === "executable" || evidence.kind === "launcher") &&
                (evidence.evidenceLevel === "agent_runtime_verified" || evidence.evidenceLevel === "local_artifact") &&
                !evidence.diagnostics.some((item) => item.severity === "error"),
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    "claudecode_cli_memory_target_build_evidence_unavailable",
                    "Claude Code CLI Memory planning needs one readable build-bearing installation observation",
                    cliRuntime.installationStatus === "needs_permission" ? "permission_denied" : "partial",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        cliRuntime.projectDiscoveryStatus !== "complete" ||
        cliRuntime.diagnostics.some((item) => item.severity === "error") ||
        !cliRuntime.sourceRootIds.includes(root.sourceRootId) ||
        !cliRuntime.observedProjectIds.includes(project.observedProjectId) ||
        root.accessStatus !== "available" ||
        root.diagnostics.some((item) => item.severity === "error") ||
        project.diagnostics.some((item) => item.severity === "error") ||
        !project.evidence.some(
            (evidence) =>
                evidence.evidenceKind === "invocation" &&
                evidence.evidenceLevel === "user_provided" &&
                evidence.locatorKey === "probe_project_root",
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    "claudecode_cli_memory_target_authority_incomplete",
                    "Claude Code CLI Memory planning requires one exact readable topic directory and registered Project binding",
                    root.accessStatus === "needs_permission" ? "permission_denied" : "verification_failed",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    return { ...base, status: "ready_for_plan", diagnostics: [] };
}

function claudeAppMemoryTargetApplicability(
    root: SourceRoot,
    project: ObservedProject,
    appRuntime: ObservedRuntime,
): TargetApplicability {
    const base = {
        agentRuntimeId: "CLAUDE_CODE_APP" as const,
        locatorEvidence: observedTargetLocatorEvidence(root),
    };
    if (appRuntime.installationStatus === "not_found") {
        return {
            ...base,
            status: "invalid",
            diagnostics: [
                diagnostic(
                    "claudecode_app_memory_target_installation_not_found",
                    "Claude Code App Memory cannot be planned without an installed App-owned Code engine",
                    "not_found",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        appRuntime.installationStatus !== "available" ||
        !appRuntime.installationEvidence.some(
            (evidence) =>
                evidence.kind === "executable" &&
                evidence.evidenceLevel === "agent_runtime_verified" &&
                !evidence.diagnostics.some((item) => item.severity === "error"),
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    "claudecode_app_memory_target_build_evidence_unavailable",
                    "Claude Code App Memory planning needs one exact App-owned Code-engine observation",
                    appRuntime.installationStatus === "needs_permission" ? "permission_denied" : "partial",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        appRuntime.projectDiscoveryStatus !== "complete" ||
        appRuntime.diagnostics.some((item) => item.severity === "error") ||
        !appRuntime.sourceRootIds.includes(root.sourceRootId) ||
        !appRuntime.observedProjectIds.includes(project.observedProjectId) ||
        root.accessStatus !== "available" ||
        root.diagnostics.some((item) => item.severity === "error") ||
        project.diagnostics.some((item) => item.severity === "error") ||
        !project.evidence.some(
            (evidence) =>
                evidence.evidenceKind === "invocation" &&
                evidence.evidenceLevel === "user_provided" &&
                evidence.locatorKey === "probe_project_root",
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    "claudecode_app_memory_target_authority_incomplete",
                    "Claude Code App Memory planning requires one exact readable topic directory and registered Project binding",
                    root.accessStatus === "needs_permission" ? "permission_denied" : "verification_failed",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    return { ...base, status: "ready_for_plan", diagnostics: [] };
}

function claudeCliTargetApplicability(
    root: SourceRoot,
    project: ObservedProject,
    cliRuntime: ObservedRuntime,
): TargetApplicability {
    const base = {
        agentRuntimeId: "CLAUDE_CODE_CLI" as const,
        locatorEvidence: root.locatorEvidence,
    };
    if (cliRuntime.installationStatus === "not_found") {
        return {
            ...base,
            status: "invalid",
            diagnostics: [
                diagnostic(
                    "claudecode_cli_target_installation_not_found",
                    "Claude Code CLI project targets cannot be planned without an installed CLI",
                    "not_found",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        cliRuntime.installationStatus !== "available" ||
        !cliRuntime.installationEvidence.some(
            (evidence) =>
                (evidence.kind === "executable" || evidence.kind === "launcher") &&
                (evidence.evidenceLevel === "agent_runtime_verified" || evidence.evidenceLevel === "local_artifact") &&
                !evidence.diagnostics.some((item) => item.severity === "error"),
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    "claudecode_cli_target_build_evidence_unavailable",
                    "Claude Code CLI target planning needs one readable build-bearing installation observation",
                    cliRuntime.installationStatus === "needs_permission" ? "permission_denied" : "partial",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        cliRuntime.projectDiscoveryStatus !== "complete" ||
        cliRuntime.diagnostics.some((item) => item.severity === "error") ||
        root.accessStatus !== "available" ||
        root.diagnostics.some((item) => item.severity === "error") ||
        project.diagnostics.some((item) => item.severity === "error") ||
        !project.evidence.some(
            (evidence) =>
                evidence.evidenceKind === "invocation" &&
                evidence.evidenceLevel === "user_provided" &&
                evidence.locatorKey === "probe_project_root",
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    "claudecode_cli_target_project_authority_incomplete",
                    "Claude Code CLI target planning requires the exact readable user-authorized project root",
                    root.accessStatus === "needs_permission" ? "permission_denied" : "verification_failed",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    return { ...base, status: "ready_for_plan", diagnostics: [] };
}

function claudeAppTargetApplicability(
    root: SourceRoot,
    project: ObservedProject,
    appRuntime: ObservedRuntime,
): TargetApplicability {
    const base = {
        agentRuntimeId: "CLAUDE_CODE_APP" as const,
        locatorEvidence: root.locatorEvidence,
    };
    if (appRuntime.installationStatus === "not_found") {
        return {
            ...base,
            status: "invalid",
            diagnostics: [
                diagnostic(
                    "claudecode_app_target_installation_not_found",
                    "Claude Code App project targets cannot be planned without an installed App-owned Code engine",
                    "not_found",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        appRuntime.installationStatus !== "available" ||
        !appRuntime.installationEvidence.some(
            (evidence) =>
                evidence.kind === "executable" &&
                evidence.evidenceLevel === "agent_runtime_verified" &&
                !evidence.diagnostics.some((item) => item.severity === "error"),
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    "claudecode_app_target_build_evidence_unavailable",
                    "Claude Code App target planning needs one exact App-owned Code-engine observation",
                    appRuntime.installationStatus === "needs_permission" ? "permission_denied" : "partial",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        appRuntime.projectDiscoveryStatus !== "complete" ||
        appRuntime.diagnostics.some((item) => item.severity === "error") ||
        !appRuntime.sourceRootIds.includes(root.sourceRootId) ||
        !appRuntime.observedProjectIds.includes(project.observedProjectId) ||
        root.accessStatus !== "available" ||
        root.diagnostics.some((item) => item.severity === "error") ||
        project.diagnostics.some((item) => item.severity === "error") ||
        !project.evidence.some(
            (evidence) =>
                evidence.evidenceKind === "invocation" &&
                evidence.evidenceLevel === "user_provided" &&
                evidence.locatorKey === "probe_project_root",
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    "claudecode_app_target_project_authority_incomplete",
                    "Claude Code App target planning requires the exact readable user-authorized Project root",
                    root.accessStatus === "needs_permission" ? "permission_denied" : "verification_failed",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    return { ...base, status: "ready_for_plan", diagnostics: [] };
}

function stableTargetId(kind: "target" | "global-target" | "memory-target", value: string): string {
    const digest = crypto.createHash("sha256").update(`${kind}\0${value}`, "utf8").digest("hex");
    return `claudecode-${kind}-${digest}`;
}

function unknownAppRuntime(): ObservedRuntime {
    return {
        agentRuntimeId: "CLAUDE_CODE_APP",
        versionText: "",
        installationEvidence: [],
        sourceRootIds: [],
        agentRuntimeResourceIds: [],
        observedProjectIds: [],
        installationStatus: "unknown",
        projectDiscoveryStatus: "unknown",
        diagnostics: [],
    };
}
