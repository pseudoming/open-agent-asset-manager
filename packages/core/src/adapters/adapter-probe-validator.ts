/** Dynamic probe-result validation against one registered provider. */

import { isCanonicalPhysicalAccessPath, physicalAccessPathContains } from "@oaam/shared/paths";
import type {
    AdapterProbeResult,
    AdapterProvider,
    AgentRuntimeId,
    ObservedAgentRuntime,
    OperationDiagnostic,
    PlatformContext,
    SourceRoot,
} from "../types";
import {
    issue,
    ROOT_LOCATOR_KINDS,
    ROOT_ROLES,
    requireAllowed,
    requireNonBlank,
    SOURCE_DOMAINS,
    SOURCE_EVIDENCE_LEVELS,
} from "./adapter-validation-helpers";

const TRUSTED_ABSENCE_EVIDENCE = new Set(["agent_runtime_verified", "local_artifact", "user_provided"]);

const OPERATION_STATUSES = new Set(["complete", "partial", "failed"]);

const INSTALLATION_STATUSES = new Set(["available", "not_found", "needs_permission", "version_incompatible", "unknown"]);

const PROJECT_DISCOVERY_STATUSES = new Set(["complete", "partial", "not_found", "needs_permission", "unknown"]);

const CLOSED_PROJECT_DISCOVERY_STATUSES = new Set(["complete", "not_found"]);

const RESOURCE_ACCESS_STATUSES = new Set(["available", "not_found", "needs_permission", "unknown"]);

const TARGET_CANDIDATE_STATUSES = new Set(["ready_for_plan", "invalid", "unknown"]);

const INSTALLATION_EVIDENCE_KINDS = new Set(["executable", "launcher", "app_bundle", "install_root", "version_command"]);

const RESOURCE_ROLES = new Set(["agent_runtime_data", "project_registry"]);

const PROJECT_WORKSPACE_ROLES = new Set(["primary", "additional"]);

const PROJECT_EVIDENCE_KINDS = new Set(["agent_runtime_resource", "environment", "invocation"]);

const TARGET_KINDS = new Set(["global", "project", "directory", "unknown"]);

export function validateAdapterProbeResult(
    provider: AdapterProvider,
    result: AdapterProbeResult,
    platformContext: PlatformContext,
): OperationDiagnostic[] {
    const issues: OperationDiagnostic[] = [];
    if (!isCanonicalPhysicalAccessPath(platformContext.accessRootPath)) {
        issues.push(issue("probe.context_access_root_invalid", "probe context access root is not canonical absolute"));
    }
    requireAllowed(result.status, OPERATION_STATUSES, "probe.status_invalid", "probe operation status is invalid", issues);
    const observation = result.observation;
    const descriptors = new Map(provider.agentRuntimes.map((descriptor) => [descriptor.agentRuntimeId, descriptor]));
    const observedRuntimes = uniqueRecords(
        observation.observedAgentRuntimes,
        (record) => record.agentRuntimeId,
        "probe.agent_runtime_duplicate",
        issues,
    );

    for (const runtime of observation.observedAgentRuntimes) {
        if (!descriptors.has(runtime.agentRuntimeId)) {
            issues.push(issue("probe.agent_runtime_foreign", `foreign agentRuntimeId: ${runtime.agentRuntimeId}`));
        }
        validateObservedRuntime(runtime, result.status, issues);
    }
    if (result.status === "complete") {
        for (const descriptor of provider.agentRuntimes) {
            if (!observedRuntimes.has(descriptor.agentRuntimeId)) {
                issues.push(
                    issue("probe.agent_runtime_missing", `complete probe omitted agentRuntimeId: ${descriptor.agentRuntimeId}`),
                );
            }
        }
        if (observedRuntimes.size !== descriptors.size) {
            issues.push(issue("probe.agent_runtime_cardinality", "complete probe must match descriptor cardinality"));
        }
    }

    const roots = uniqueRecords(observation.sourceRoots, (root) => root.sourceRootId, "probe.source_root_duplicate", issues);
    const resources = uniqueRecords(
        observation.agentRuntimeResources,
        (resource) => resource.agentRuntimeResourceId,
        "probe.resource_duplicate",
        issues,
    );
    const projects = uniqueRecords(
        observation.observedProjects,
        (project) => project.observedProjectId,
        "probe.project_duplicate",
        issues,
    );
    const environmentReferences = uniqueRecords(
        observation.environmentReferences ?? [],
        (reference) => reference.referenceId,
        "probe.environment_reference_duplicate",
        issues,
    );

    for (const root of observation.sourceRoots) validateSourceRoot(root, platformContext.accessRootPath, issues);
    for (const resource of observation.agentRuntimeResources) {
        requireNonBlank(resource.agentRuntimeResourceId, "agentRuntimeResourceId", issues);
        requireAllowed(
            resource.accessStatus,
            RESOURCE_ACCESS_STATUSES,
            "probe.resource_access_status_invalid",
            `resource ${resource.agentRuntimeResourceId} access status is invalid`,
            issues,
        );
        if (!physicalAccessPathContains(platformContext.accessRootPath, resource.path)) {
            issues.push(
                issue(
                    "probe.resource_path_invalid",
                    `resource ${resource.agentRuntimeResourceId} path is not canonical within the selected access root`,
                ),
            );
        }
        if (resource.roles.length === 0 || new Set(resource.roles).size !== resource.roles.length) {
            issues.push(
                issue(
                    "probe.resource_roles_invalid",
                    `resource ${resource.agentRuntimeResourceId} must have unique non-empty roles`,
                ),
            );
        }
        for (const role of resource.roles) {
            requireAllowed(
                role,
                RESOURCE_ROLES,
                "probe.resource_role_invalid",
                `resource ${resource.agentRuntimeResourceId} role is invalid`,
                issues,
            );
        }
        if (resource.locatorEvidence.length === 0) {
            issues.push(
                issue("probe.resource_evidence_missing", `resource ${resource.agentRuntimeResourceId} has no locator evidence`),
            );
        }
        validateLocatorEvidence(resource.locatorEvidence, "resource", issues);
    }

    for (const runtime of observation.observedAgentRuntimes) {
        validateUniqueReferences(runtime.sourceRootIds, `runtime ${runtime.agentRuntimeId} source roots`, issues);
        validateUniqueReferences(runtime.agentRuntimeResourceIds, `runtime ${runtime.agentRuntimeId} resources`, issues);
        validateUniqueReferences(runtime.observedProjectIds, `runtime ${runtime.agentRuntimeId} projects`, issues);
        requireReferences(runtime.sourceRootIds, roots, "probe.source_root_reference_missing", issues);
        requireReferences(runtime.agentRuntimeResourceIds, resources, "probe.resource_reference_missing", issues);
        requireReferences(runtime.observedProjectIds, projects, "probe.project_reference_missing", issues);
        validateProjectDiscoveryDisposition(runtime, result, resources, projects, issues);
    }

    const environmentReferenceTuples = new Set<string>();
    for (const reference of environmentReferences.values()) {
        requireNonBlank(reference.referenceId, "environmentReference.referenceId", issues);
        if (reference.referenceKind !== "project" || reference.validationState !== "not_checked") {
            issues.push(issue("probe.environment_reference_shape_invalid", "environment reference shape is invalid"));
        }
        if (platformContext.platform !== "win32" || reference.referencedEnvironment.platform !== "wsl") {
            issues.push(
                issue(
                    "probe.environment_reference_context_invalid",
                    "environment reference must originate in win32 and identify one unselected WSL environment",
                ),
            );
        }
        if (!isSafeEnvironmentInstance(reference.referencedEnvironment.platformInstanceId)) {
            issues.push(
                issue(
                    "probe.environment_reference_instance_invalid",
                    "environment reference has an invalid platform instance identity",
                ),
            );
        }
        const runtime = observedRuntimes.get(reference.agentRuntimeId);
        if (runtime === undefined || runtime.installationStatus !== "available") {
            issues.push(
                issue(
                    "probe.environment_reference_runtime_invalid",
                    "environment reference must belong to one available runtime in the same observation",
                ),
            );
        }
        const evidenceResource = resources.get(reference.evidence.agentRuntimeResourceId);
        if (
            evidenceResource === undefined ||
            evidenceResource.accessStatus !== "available" ||
            !evidenceResource.roles.includes("project_registry") ||
            runtime === undefined ||
            !runtime.agentRuntimeResourceIds.includes(reference.evidence.agentRuntimeResourceId)
        ) {
            issues.push(
                issue(
                    "probe.environment_reference_evidence_invalid",
                    "environment reference must use one available project-registry resource owned by its runtime",
                ),
            );
        }
        requireNonBlank(reference.evidence.locatorKey, "environmentReference.evidence.locatorKey", issues);
        requireAllowed(
            reference.evidence.evidenceLevel,
            SOURCE_EVIDENCE_LEVELS,
            "probe.environment_reference_evidence_level_invalid",
            "environment reference evidence level is invalid",
            issues,
        );
        const tuple = `${reference.agentRuntimeId}\0${reference.referencedEnvironment.platform}\0${reference.referencedEnvironment.platformInstanceId}`;
        if (environmentReferenceTuples.has(tuple)) {
            issues.push(
                issue(
                    "probe.environment_reference_tuple_duplicate",
                    "environment reference repeats one runtime and target-environment tuple",
                ),
            );
        }
        environmentReferenceTuples.add(tuple);
    }

    const referencedProjectIds = new Set(observation.observedAgentRuntimes.flatMap((runtime) => runtime.observedProjectIds));
    for (const project of observation.observedProjects) {
        requireNonBlank(project.observedProjectId, "observedProjectId", issues);
        requireCanonicalOptionalText(project.runtimeProjectKey, "observedProject.runtimeProjectKey", issues);
        requireCanonicalOptionalText(project.displayName, "observedProject.displayName", issues);
        if (!referencedProjectIds.has(project.observedProjectId)) {
            issues.push(
                issue(
                    "probe.project_unreferenced",
                    `project ${project.observedProjectId} is not referenced by an observed runtime`,
                ),
            );
        }
        const primary = project.workspaces.filter((workspace) => workspace.role === "primary");
        if (project.workspaces.length === 0 || primary.length !== 1) {
            issues.push(
                issue(
                    "probe.project_primary_invalid",
                    `project ${project.observedProjectId} must have exactly one primary workspace`,
                ),
            );
        }
        if (new Set(project.workspaces.map((workspace) => workspace.sourceRootId)).size !== project.workspaces.length) {
            issues.push(
                issue("probe.project_workspace_duplicate", `project ${project.observedProjectId} repeats a workspace root`),
            );
        }
        for (const workspace of project.workspaces) {
            requireAllowed(
                workspace.role,
                PROJECT_WORKSPACE_ROLES,
                "probe.project_workspace_role_invalid",
                `project ${project.observedProjectId} workspace role is invalid`,
                issues,
            );
            const root = roots.get(workspace.sourceRootId);
            if (root === undefined) {
                issues.push(
                    issue(
                        "probe.project_workspace_missing",
                        `project ${project.observedProjectId} references missing root ${workspace.sourceRootId}`,
                    ),
                );
            } else if (root.rootRole !== "project_actual" || root.sourceDomain !== "project_root") {
                issues.push(
                    issue(
                        "probe.project_workspace_not_actual",
                        `project workspace ${workspace.sourceRootId} is not a project root`,
                    ),
                );
            }
        }
        if (project.evidence.length === 0) {
            issues.push(issue("probe.project_evidence_missing", `project ${project.observedProjectId} has no evidence`));
        }
        for (const evidence of project.evidence) {
            requireNonBlank(evidence.locatorKey, "observedProject.evidence.locatorKey", issues);
            requireAllowed(
                evidence.evidenceKind,
                PROJECT_EVIDENCE_KINDS,
                "probe.project_evidence_kind_invalid",
                `project ${project.observedProjectId} evidence kind is invalid`,
                issues,
            );
            requireAllowed(
                evidence.evidenceLevel,
                SOURCE_EVIDENCE_LEVELS,
                "probe.project_evidence_level_invalid",
                `project ${project.observedProjectId} evidence level is invalid`,
                issues,
            );
            if (evidence.evidenceKind === "agent_runtime_resource") {
                const resource = resources.get(evidence.agentRuntimeResourceId);
                if (resource === undefined || !resource.roles.includes("project_registry")) {
                    issues.push(
                        issue(
                            "probe.project_registry_evidence_invalid",
                            `project ${project.observedProjectId} has invalid registry evidence`,
                        ),
                    );
                }
            }
        }
        for (const runtime of observation.observedAgentRuntimes) {
            if (!runtime.observedProjectIds.includes(project.observedProjectId)) continue;
            const hasRuntimeEvidence = project.evidence.some(
                (evidence) =>
                    evidence.evidenceKind !== "agent_runtime_resource" ||
                    runtime.agentRuntimeResourceIds.includes(evidence.agentRuntimeResourceId),
            );
            if (!hasRuntimeEvidence) {
                issues.push(
                    issue(
                        "probe.project_runtime_evidence_unlinked",
                        `project ${project.observedProjectId} has no evidence linked to ${runtime.agentRuntimeId}`,
                    ),
                );
            }
        }
    }

    const targetIds = new Set<string>();
    const targetPaths = new Set<string>();
    for (const target of observation.targetCandidates) {
        if (targetIds.has(target.targetCandidateId)) {
            issues.push(issue("probe.target_duplicate", `duplicate targetCandidateId: ${target.targetCandidateId}`));
        }
        targetIds.add(target.targetCandidateId);
        requireNonBlank(target.targetCandidateId, "targetCandidateId", issues);
        requireAllowed(
            target.targetKind,
            TARGET_KINDS,
            "probe.target_kind_invalid",
            `target ${target.targetCandidateId} kind is invalid`,
            issues,
        );
        if (!physicalAccessPathContains(platformContext.accessRootPath, target.targetRootPath)) {
            issues.push(
                issue(
                    "probe.target_path_invalid",
                    `target ${target.targetCandidateId} path is not canonical within the selected access root`,
                ),
            );
        }
        if (targetPaths.has(target.targetRootPath)) {
            issues.push(issue("probe.target_path_duplicate", `physical target repeated: ${target.targetRootPath}`));
        }
        targetPaths.add(target.targetRootPath);
        if (target.entryApplicabilities.length === 0) {
            issues.push(
                issue("probe.target_applicability_missing", `target ${target.targetCandidateId} has no entry applicability`),
            );
        }
        const applicabilityIds = new Set<AgentRuntimeId>();
        for (const applicability of target.entryApplicabilities) {
            requireAllowed(
                applicability.status,
                TARGET_CANDIDATE_STATUSES,
                "probe.target_status_invalid",
                `target ${target.targetCandidateId} applicability status is invalid`,
                issues,
            );
            if (applicabilityIds.has(applicability.agentRuntimeId)) {
                issues.push(
                    issue(
                        "probe.target_applicability_duplicate",
                        `target ${target.targetCandidateId} repeats ${applicability.agentRuntimeId}`,
                    ),
                );
            }
            applicabilityIds.add(applicability.agentRuntimeId);
            if (!descriptors.has(applicability.agentRuntimeId) || !observedRuntimes.has(applicability.agentRuntimeId)) {
                issues.push(
                    issue(
                        "probe.target_applicability_foreign",
                        `target ${target.targetCandidateId} references unobserved runtime ${applicability.agentRuntimeId}`,
                    ),
                );
            }
            if (applicability.status === "ready_for_plan" && applicability.locatorEvidence.length === 0) {
                issues.push(
                    issue(
                        "probe.target_ready_without_evidence",
                        `ready target ${target.targetCandidateId} has no locator evidence`,
                    ),
                );
            }
            validateLocatorEvidence(applicability.locatorEvidence, "target applicability", issues);
            if (
                applicability.status === "ready_for_plan" &&
                !applicability.locatorEvidence.some(
                    (evidence) => evidence.locatorKind !== "unknown" && TRUSTED_ABSENCE_EVIDENCE.has(evidence.evidenceLevel),
                )
            ) {
                issues.push(
                    issue(
                        "probe.target_ready_without_trusted_locator",
                        `ready target ${target.targetCandidateId} has no trusted locator`,
                    ),
                );
            }
        }
    }
    return issues;
}

function isSafeEnvironmentInstance(value: string): boolean {
    return (
        value.length > 0 &&
        value !== "." &&
        value !== ".." &&
        value.trim() === value &&
        !value.endsWith(".") &&
        !value.endsWith(" ") &&
        ![...value].some((character) => character.charCodeAt(0) < 0x20 || '\\\\/:*?"<>|'.includes(character))
    );
}

function requireCanonicalOptionalText(value: unknown, label: string, issues: OperationDiagnostic[]): void {
    if (
        typeof value !== "string" ||
        value.includes("\0") ||
        (value.length > 0 && (value.trim().length === 0 || value.trim() !== value))
    ) {
        issues.push(issue("adapter.noncanonical_text", `${label} must be canonical empty or trimmed text without NUL`));
    }
}

function validateProjectDiscoveryDisposition(
    runtime: ObservedAgentRuntime,
    result: AdapterProbeResult,
    resources: ReadonlyMap<string, AdapterProbeResult["observation"]["agentRuntimeResources"][number]>,
    projects: ReadonlyMap<string, AdapterProbeResult["observation"]["observedProjects"][number]>,
    issues: OperationDiagnostic[],
): void {
    if (
        runtime.observedProjectIds.some((projectId) => projects.has(projectId)) &&
        runtime.projectDiscoveryStatus !== "complete" &&
        runtime.projectDiscoveryStatus !== "partial"
    ) {
        issues.push(
            issue(
                "probe.project_discovery_status_conflict",
                `runtime ${runtime.agentRuntimeId} reports projects while discovery is ${runtime.projectDiscoveryStatus}`,
            ),
        );
    }
    if (result.status === "complete" && !CLOSED_PROJECT_DISCOVERY_STATUSES.has(runtime.projectDiscoveryStatus)) {
        issues.push(
            issue(
                "probe.complete_project_incomplete",
                `complete probe left ${runtime.agentRuntimeId} project discovery ${runtime.projectDiscoveryStatus}`,
            ),
        );
    }
    if (!CLOSED_PROJECT_DISCOVERY_STATUSES.has(runtime.projectDiscoveryStatus)) return;

    for (const resourceId of runtime.agentRuntimeResourceIds) {
        const resource = resources.get(resourceId);
        if (resource === undefined || !resource.roles.includes("project_registry")) continue;
        if (resource.accessStatus === "unknown" || resource.accessStatus === "needs_permission") {
            issues.push(
                issue(
                    "probe.project_registry_disposition_incomplete",
                    `runtime ${runtime.agentRuntimeId} closed project discovery over unresolved registry ${resourceId}`,
                ),
            );
            continue;
        }
        const diagnostics = [
            ...resource.diagnostics,
            ...runtime.diagnostics.filter((diagnostic) => diagnostic.path === resource.path),
            ...result.diagnostics.filter((diagnostic) => diagnostic.path === resource.path),
        ];
        if (diagnostics.some((diagnostic) => diagnostic.severity !== "info")) {
            issues.push(
                issue(
                    "probe.project_registry_disposition_incomplete",
                    `runtime ${runtime.agentRuntimeId} closed project discovery over incomplete registry ${resourceId}`,
                ),
            );
        }
    }
}

function validateObservedRuntime(
    runtime: ObservedAgentRuntime,
    operationStatus: AdapterProbeResult["status"],
    issues: OperationDiagnostic[],
): void {
    requireAllowed(
        runtime.installationStatus,
        INSTALLATION_STATUSES,
        "probe.installation_status_invalid",
        `runtime ${runtime.agentRuntimeId} installation status is invalid`,
        issues,
    );
    requireAllowed(
        runtime.projectDiscoveryStatus,
        PROJECT_DISCOVERY_STATUSES,
        "probe.project_discovery_status_invalid",
        `runtime ${runtime.agentRuntimeId} project discovery status is invalid`,
        issues,
    );
    for (const evidence of runtime.installationEvidence) {
        requireNonBlank(evidence.path, "installationEvidence.path", issues);
        requireAllowed(
            evidence.kind,
            INSTALLATION_EVIDENCE_KINDS,
            "probe.installation_evidence_kind_invalid",
            "installation evidence kind is invalid",
            issues,
        );
        requireAllowed(
            evidence.evidenceLevel,
            SOURCE_EVIDENCE_LEVELS,
            "probe.installation_evidence_level_invalid",
            "installation evidence level is invalid",
            issues,
        );
        validateCurrentBuildObservation(evidence, issues);
    }
    if (operationStatus === "complete" && runtime.installationStatus === "unknown") {
        issues.push(
            issue("probe.complete_installation_unknown", `complete probe left ${runtime.agentRuntimeId} installation unknown`),
        );
    }
    if (
        runtime.installationStatus === "available" &&
        !runtime.installationEvidence.some(
            (evidence) => evidence.path.length > 0 && TRUSTED_ABSENCE_EVIDENCE.has(evidence.evidenceLevel),
        )
    ) {
        issues.push(
            issue(
                "probe.available_without_evidence",
                `available runtime ${runtime.agentRuntimeId} has no trusted installation evidence`,
            ),
        );
    }
    if (
        runtime.installationStatus === "not_found" &&
        !runtime.installationEvidence.some(
            (evidence) => evidence.path.length > 0 && TRUSTED_ABSENCE_EVIDENCE.has(evidence.evidenceLevel),
        )
    ) {
        issues.push(
            issue(
                "probe.not_found_unchecked",
                `runtime ${runtime.agentRuntimeId} was called not_found without a trusted checked path`,
            ),
        );
    }
    if (operationStatus === "complete" && runtime.projectDiscoveryStatus === "unknown") {
        issues.push(
            issue("probe.complete_project_unknown", `complete probe left ${runtime.agentRuntimeId} project discovery unknown`),
        );
    }
}

function validateCurrentBuildObservation(
    evidence: ObservedAgentRuntime["installationEvidence"][number],
    issues: OperationDiagnostic[],
): void {
    const observation = evidence.currentBuildObservation;
    if (observation === undefined) return;
    if (typeof observation !== "object" || observation === null) {
        issues.push(
            issue(
                "probe.installation_build_observation_invalid",
                `runtime installation evidence for ${evidence.kind} has an invalid current build observation`,
            ),
        );
        return;
    }
    const invalid =
        (evidence.kind !== "executable" && evidence.kind !== "launcher" && evidence.kind !== "app_bundle") ||
        !/^sha256:[a-f0-9]{64}$/u.test(observation.buildIdentity) ||
        !Number.isSafeInteger(observation.byteSize) ||
        observation.byteSize < 0 ||
        typeof observation.executable !== "boolean" ||
        observation.identity?.entryKind !== "file" ||
        typeof observation.identity.deviceId !== "string" ||
        observation.identity.deviceId.length === 0 ||
        typeof observation.identity.fileId !== "string" ||
        observation.identity.fileId.length === 0;
    if (invalid) {
        issues.push(
            issue(
                "probe.installation_build_observation_invalid",
                `runtime installation evidence for ${evidence.kind} has an invalid current build observation`,
            ),
        );
    }
}

function validateSourceRoot(root: SourceRoot, accessRootPath: string, issues: OperationDiagnostic[]): void {
    requireNonBlank(root.sourceRootId, "sourceRootId", issues);
    requireAllowed(
        root.rootRole,
        ROOT_ROLES,
        "probe.source_root_role_invalid",
        `source root ${root.sourceRootId} role is invalid`,
        issues,
    );
    requireAllowed(
        root.sourceDomain,
        SOURCE_DOMAINS,
        "probe.source_domain_invalid",
        `source root ${root.sourceRootId} domain is invalid`,
        issues,
    );
    requireAllowed(
        root.accessStatus,
        RESOURCE_ACCESS_STATUSES,
        "probe.source_access_status_invalid",
        `source root ${root.sourceRootId} access status is invalid`,
        issues,
    );
    if (!physicalAccessPathContains(accessRootPath, root.path)) {
        issues.push(
            issue(
                "probe.source_root_path_invalid",
                `source root ${root.sourceRootId} path is not canonical within the selected access root`,
            ),
        );
    }
    if (root.locatorEvidence.length === 0)
        issues.push(issue("probe.source_root_evidence_missing", `source root ${root.sourceRootId} has no locator evidence`));
    validateLocatorEvidence(root.locatorEvidence, "source root", issues);
}

function validateLocatorEvidence(
    evidence: readonly { locatorKey: string; locatorKind: unknown; evidenceLevel: unknown }[],
    label: string,
    issues: OperationDiagnostic[],
): void {
    for (const item of evidence) {
        requireNonBlank(item.locatorKey, `${label}.locatorKey`, issues);
        requireAllowed(
            item.locatorKind,
            ROOT_LOCATOR_KINDS,
            "probe.locator_kind_invalid",
            `${label} locator kind is invalid`,
            issues,
        );
        requireAllowed(
            item.evidenceLevel,
            SOURCE_EVIDENCE_LEVELS,
            "probe.locator_evidence_level_invalid",
            `${label} evidence level is invalid`,
            issues,
        );
    }
}

function uniqueRecords<T>(
    records: readonly T[],
    keyOf: (record: T) => string,
    code: string,
    issues: OperationDiagnostic[],
): Map<string, T> {
    const result = new Map<string, T>();
    for (const record of records) {
        const key = keyOf(record);
        if (result.has(key)) issues.push(issue(code, `duplicate record id: ${key}`));
        else result.set(key, record);
    }
    return result;
}

function validateUniqueReferences(refs: readonly string[], label: string, issues: OperationDiagnostic[]): void {
    if (new Set(refs).size !== refs.length)
        issues.push(issue("probe.reference_duplicate", `${label} contains duplicate references`));
}

function requireReferences<T>(
    refs: readonly string[],
    records: ReadonlyMap<string, T>,
    code: string,
    issues: OperationDiagnostic[],
): void {
    for (const ref of refs) if (!records.has(ref)) issues.push(issue(code, `missing referenced record: ${ref}`));
}
