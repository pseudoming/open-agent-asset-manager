/** Trusted installation and Project evidence for native project targets. */

import { physicalAccessPathContains } from "@oaam/shared/paths";
import type { InstallationEvidence, ProbeResult, SourceEvidenceLevel } from "../contracts/source-import";
import { isCanonicalTargetRootPath } from "../foundation/validators";
import type { TrustedTargetEvidenceLevel } from "./native-project-guidance-profiles";

export function findObservedProjectBindingEvidence(
    observation: ProbeResult["observation"],
    observedProjectIds: readonly string[],
    sourceRootIds: readonly string[],
    agentRuntimeResourceIds: readonly string[],
    targetRootPath: string,
): SourceEvidenceLevel | null {
    const projectIds = new Set(observedProjectIds);
    const runtimeRootIds = new Set(sourceRootIds);
    const runtimeResourceIds = new Set(agentRuntimeResourceIds);
    const candidates: TrustedTargetEvidenceLevel[] = [];
    for (const project of observation.observedProjects) {
        if (!projectIds.has(project.observedProjectId)) continue;
        const primary = project.workspaces.filter((workspace) => workspace.role === "primary");
        if (primary.length !== 1 || project.diagnostics.some((item) => item.severity === "error")) {
            continue;
        }
        const root = observation.sourceRoots.find((candidate) => candidate.sourceRootId === primary[0]?.sourceRootId);
        if (
            root === undefined ||
            !runtimeRootIds.has(root.sourceRootId) ||
            root.path !== targetRootPath ||
            root.rootRole !== "project_actual" ||
            root.sourceDomain !== "project_root" ||
            root.accessStatus !== "available" ||
            root.diagnostics.some((item) => item.severity === "error")
        ) {
            continue;
        }
        const projectEvidence = strongestEvidence(
            project.evidence.flatMap((evidence) => {
                const level = projectResourceEvidenceLevel(observation, runtimeResourceIds, evidence);
                return level === null ? [] : [level];
            }),
        );
        const rootEvidence = strongestEvidence(
            root.locatorEvidence.flatMap((evidence) =>
                evidence.locatorKind === "project_registry_entry" ? trustedEvidenceValue(evidence.evidenceLevel) : [],
            ),
        );
        if (projectEvidence !== null && rootEvidence !== null) {
            candidates.push(weakerEvidence(projectEvidence, rootEvidence));
        }
        const invocationAnchor = project.evidence.some(
            (evidence) =>
                evidence.evidenceKind === "invocation" &&
                evidence.locatorKey === "probe_project_root" &&
                evidence.evidenceLevel === "user_provided",
        );
        const selectedRootAnchor = root.locatorEvidence.some(
            (evidence) =>
                evidence.locatorKind === "user_provided_path" &&
                evidence.locatorKey === "probe_project_root" &&
                evidence.evidenceLevel === "user_provided",
        );
        if (invocationAnchor && selectedRootAnchor) candidates.push("user_provided");
    }
    return strongestEvidence(candidates);
}

export function projectResourceEvidenceLevel(
    observation: ProbeResult["observation"],
    runtimeResourceIds: ReadonlySet<string>,
    evidence: ProbeResult["observation"]["observedProjects"][number]["evidence"][number],
): TrustedTargetEvidenceLevel | null {
    if (
        evidence.evidenceKind !== "agent_runtime_resource" ||
        !runtimeResourceIds.has(evidence.agentRuntimeResourceId) ||
        !trustedRuntimeProjectEvidence(evidence.evidenceLevel)
    ) {
        return null;
    }
    const resource = observation.agentRuntimeResources.find(
        (candidate) => candidate.agentRuntimeResourceId === evidence.agentRuntimeResourceId,
    );
    if (
        resource === undefined ||
        resource.accessStatus !== "available" ||
        !resource.roles.includes("project_registry") ||
        resource.diagnostics.some((item) => item.severity === "error") ||
        !isCanonicalTargetRootPath(resource.path, observation.platformContext.platform) ||
        !physicalAccessPathContains(observation.platformContext.accessRootPath, resource.path)
    ) {
        return null;
    }
    const resourceEvidence = strongestEvidence(
        resource.locatorEvidence.flatMap((locator) => trustedEvidenceValue(locator.evidenceLevel)),
    );
    return resourceEvidence === null ? null : weakerEvidence(evidence.evidenceLevel, resourceEvidence);
}

export function trustedBuildEvidence(level: SourceEvidenceLevel): boolean {
    return level === "agent_runtime_verified" || level === "local_artifact";
}

export function isBuildBearingFileEvidence(
    evidence: InstallationEvidence,
): evidence is InstallationEvidence & { kind: "executable" | "launcher" | "app_bundle" } {
    return evidence.kind === "executable" || evidence.kind === "launcher" || evidence.kind === "app_bundle";
}

export function requiresExecutableMode(
    evidence: InstallationEvidence & { kind: "executable" | "launcher" | "app_bundle" },
): boolean {
    return evidence.kind === "executable" || evidence.kind === "launcher";
}

export function trustedProjectEvidence(level: SourceEvidenceLevel | undefined): level is TrustedTargetEvidenceLevel {
    return level === "agent_runtime_verified" || level === "local_artifact" || level === "user_provided";
}

export function trustedEvidenceValue(level: SourceEvidenceLevel): TrustedTargetEvidenceLevel[] {
    return trustedRuntimeProjectEvidence(level) ? [level] : [];
}

export function strongestEvidence(levels: readonly TrustedTargetEvidenceLevel[]): TrustedTargetEvidenceLevel | null {
    let strongest: TrustedTargetEvidenceLevel | null = null;
    for (const level of levels) {
        if (strongest === null || evidenceRank(level) > evidenceRank(strongest)) strongest = level;
    }
    return strongest;
}

export function weakerEvidence(left: TrustedTargetEvidenceLevel, right: TrustedTargetEvidenceLevel): TrustedTargetEvidenceLevel {
    return evidenceRank(left) <= evidenceRank(right) ? left : right;
}

export function evidenceRank(level: TrustedTargetEvidenceLevel): number {
    return level === "agent_runtime_verified" ? 2 : level === "local_artifact" ? 1 : 0;
}

function trustedRuntimeProjectEvidence(
    level: SourceEvidenceLevel | undefined,
): level is Extract<TrustedTargetEvidenceLevel, "agent_runtime_verified" | "local_artifact"> {
    return level === "agent_runtime_verified" || level === "local_artifact";
}
