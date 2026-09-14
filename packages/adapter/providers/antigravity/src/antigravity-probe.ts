/** Antigravity CLI/App/IDE installation and source discovery facade. Read-only. */

import {
    canonicalHostPath,
    canonicalProviderHostPathWithinAccessRoot,
    hostPathApiFor,
    resolveProviderProbeEnvironment,
} from "@oaam/adapter-framework";
import type { AdapterProbeContext, AdapterProbeResult, AgentRuntimeId, OperationDiagnostic, SourceRoot } from "@oaam/core";
import { getHomeDir } from "@oaam/shared/paths";
import { getPathRule } from "./antigravity-paths";
import {
    addSourceRoot,
    compareText,
    diagnostic,
    knownEvidence,
    makeResource,
    makeSourceRoot,
    runtimeValues,
    stableId,
    uniqueSorted,
    unknownRuntime,
} from "./antigravity-probe-foundation";
import {
    appendAntigravityResidualDiagnostic,
    findAntigravityAppInstallation,
    findAntigravityCliInstallation,
    findAntigravityIdeInstallation,
    observeAntigravityCliVersion,
    observeAntigravityInstallationsConcurrently,
} from "./antigravity-probe-installation";
import {
    antigravityProjectDiscoveryStatus,
    discoverAntigravityProjects,
    materializeAntigravityProjects,
} from "./antigravity-probe-projects";

export { parseSummariesProjects } from "./antigravity-probe-projects";

export async function probeAntigravity(
    context: AdapterProbeContext,
    environment: NodeJS.ProcessEnv = process.env,
    homeDir: string = getHomeDir(),
    hostPlatform: NodeJS.Platform = process.platform,
): Promise<AdapterProbeResult> {
    if (canonicalHostPath(homeDir) === null) {
        return unavailableProbe(
            "failed",
            diagnostic(
                "antigravity_home_root_invalid",
                "The Antigravity family root cannot be derived from the platform home",
                "invalid_schema",
                "error",
                homeDir,
            ),
        );
    }
    const probeEnvironment = resolveProviderProbeEnvironment(context.platformContext, environment, homeDir, hostPlatform);
    if (probeEnvironment === null) {
        const mismatch = diagnostic(
            "antigravity_probe_platform_unreachable",
            "The current process cannot inspect the requested platform filesystem",
            "partial",
            "warning",
            context.platformContext.accessRootPath,
        );
        return unavailableProbe("partial", mismatch);
    }

    environment = probeEnvironment.environment;
    homeDir = probeEnvironment.homePath;
    const rule = getPathRule(context.platformContext.platform, homeDir);
    if (rule === null) {
        const invalid = diagnostic(
            "antigravity_home_root_invalid",
            "The Antigravity family root cannot be derived from the platform home",
            "invalid_schema",
            "error",
            homeDir,
        );
        return unavailableProbe("failed", invalid);
    }

    const diagnostics: OperationDiagnostic[] = [];

    const sourceRoots = new Map<string, SourceRoot>();
    const resources = new Map<string, AdapterProbeResult["observation"]["agentRuntimeResources"][number]>();
    const paths = hostPathApiFor(rule.familyRoot);
    if (paths === null) {
        const invalid = diagnostic(
            "antigravity_host_path_grammar_invalid",
            "The selected Antigravity home does not carry one canonical Host path grammar",
            "invalid_schema",
            "error",
            rule.familyRoot,
        );
        return unavailableProbe("failed", invalid);
    }

    const installationSetPromise = observeAntigravityInstallationsConcurrently({
        observeCli: async () =>
            observeAntigravityCliVersion(
                findAntigravityCliInstallation(environment, homeDir, context.platformContext, context.installationRootPath),
                environment,
                context.platformContext,
                hostPlatform,
            ),
        observeApp: () =>
            findAntigravityAppInstallation(environment, homeDir, context.platformContext, context.installationRootPath),
        observeIde: () =>
            findAntigravityIdeInstallation(environment, homeDir, context.platformContext, context.installationRootPath),
    });
    // Start the independent entry observations before projecting Project/source metadata.
    await Promise.resolve();

    const familyRootIds = [
        addSourceRoot(
            sourceRoots,
            makeSourceRoot(
                rule.familyRoot,
                "config",
                "family_shared",
                "directory",
                knownEvidence("antigravity_family_root", "agent_runtime_verified"),
            ),
        ),
    ];
    const cliPrivateSkills = addSourceRoot(
        sourceRoots,
        makeSourceRoot(
            paths.join(rule.cliDataRoot, "skills"),
            "source",
            "agent_runtime_private",
            "directory",
            knownEvidence("antigravity_cli_private_skills", "agent_runtime_verified"),
        ),
    );
    const antigravityPrivateSkills = addSourceRoot(
        sourceRoots,
        makeSourceRoot(
            paths.join(rule.appDataRoot, "skills"),
            "source",
            "agent_runtime_private",
            "directory",
            knownEvidence("antigravity_app_private_skills_candidate", "docs_declared"),
        ),
    );

    const sharedRegistryResource = makeResource(
        rule.sharedProjectsRoot,
        ["project_registry"],
        "directory",
        knownEvidence("antigravity_shared_project_registry", "agent_runtime_verified"),
    );
    const appDataResource = makeResource(
        rule.appDataRoot,
        ["agent_runtime_data"],
        "directory",
        knownEvidence("antigravity_app_data_root", "local_artifact"),
    );
    const cliDataResource = makeResource(
        rule.cliDataRoot,
        ["agent_runtime_data"],
        "directory",
        knownEvidence("antigravity_cli_data_root", "local_artifact"),
    );
    const ideDataResource = makeResource(
        rule.ideDataRoot,
        ["agent_runtime_data"],
        "directory",
        knownEvidence("antigravity_ide_data_root", "local_artifact"),
    );
    const appPbResource = makeResource(
        rule.appSummariesPath,
        ["project_registry"],
        "file",
        knownEvidence("antigravity_app_summaries_pb", "agent_runtime_verified"),
    );
    const idePbResource = makeResource(
        rule.ideSummariesPath,
        ["project_registry"],
        "file",
        knownEvidence("antigravity_ide_summaries_pb", "agent_runtime_verified"),
    );
    const cliSettingsResource = makeResource(
        rule.cliSettingsPath,
        ["project_registry"],
        "file",
        knownEvidence("antigravity_cli_trusted_workspaces", "agent_runtime_verified"),
    );
    const cliSummariesDbResource = makeResource(
        rule.cliSummariesDbPath,
        ["project_registry"],
        "file",
        knownEvidence("antigravity_cli_conversation_summaries_db", "local_artifact"),
    );
    for (const resource of [
        sharedRegistryResource,
        appDataResource,
        cliDataResource,
        ideDataResource,
        appPbResource,
        idePbResource,
        cliSettingsResource,
        cliSummariesDbResource,
    ]) {
        resources.set(resource.agentRuntimeResourceId, resource);
    }

    const projectDiscovery = await discoverAntigravityProjects(
        context,
        environment,
        rule,
        sharedRegistryResource,
        appPbResource,
        idePbResource,
        cliSummariesDbResource,
    );
    diagnostics.push(...projectDiscovery.diagnostics);
    const materializedProjects = await materializeAntigravityProjects(
        projectDiscovery.records,
        sourceRoots,
        context.platformContext,
        rule,
    );
    diagnostics.push(...materializedProjects.diagnostics);
    const observedProjects = materializedProjects.observedProjects;
    const externalRootIds = addAuthorizedExternalRoot(context, sourceRoots, diagnostics);

    const installationSet = await installationSetPromise;
    const { cli: cliInstall, app: appInstall, ide: ideInstall } = installationSet;

    appendAntigravityResidualDiagnostic(cliInstall, cliDataResource, "CLI");
    appendAntigravityResidualDiagnostic(appInstall, appDataResource, "App");
    appendAntigravityResidualDiagnostic(ideInstall, ideDataResource, "IDE");
    diagnostics.push(...cliInstall.diagnostics, ...appInstall.diagnostics, ...ideInstall.diagnostics);

    const sharedResourceIds = [sharedRegistryResource.agentRuntimeResourceId];
    const cliResourceIds = uniqueSorted([
        ...sharedResourceIds,
        cliDataResource.agentRuntimeResourceId,
        cliSettingsResource.agentRuntimeResourceId,
        cliSummariesDbResource.agentRuntimeResourceId,
    ]);
    const cliObservedProjectIds = runtimeValues(materializedProjects.observedProjectIdsByRuntime, "ANTIGRAVITY_CLI");
    const cliProjectStatus = antigravityProjectDiscoveryStatus(context, [
        projectDiscovery.indexes.shared,
        projectDiscovery.indexes.cli,
    ]);
    const appProjectStatus = antigravityProjectDiscoveryStatus(context, [
        projectDiscovery.indexes.shared,
        projectDiscovery.indexes.app,
    ]);
    const ideProjectStatus = antigravityProjectDiscoveryStatus(context, [
        projectDiscovery.indexes.shared,
        projectDiscovery.indexes.ide,
    ]);
    for (const [agentRuntimeId, status] of [
        ["ANTIGRAVITY_CLI", cliProjectStatus],
        ["ANTIGRAVITY_APP", appProjectStatus],
        ["ANTIGRAVITY_IDE", ideProjectStatus],
    ] as const) {
        if (status !== "partial") continue;
        diagnostics.push(
            diagnostic(
                "antigravity_project_registry_partially_observed",
                `${agentRuntimeId} project discovery observed only part of its bounded registry set`,
                "partial",
                "warning",
                homeDir,
            ),
        );
    }
    const cliRuntime: AdapterProbeResult["observation"]["observedAgentRuntimes"][number] = {
        agentRuntimeId: "ANTIGRAVITY_CLI",
        versionText: cliInstall.versionText,
        installationEvidence: cliInstall.evidence,
        sourceRootIds: uniqueSorted([
            ...familyRootIds,
            cliPrivateSkills,
            ...externalRootIds,
            ...runtimeValues(materializedProjects.sourceRootIdsByRuntime, "ANTIGRAVITY_CLI"),
        ]),
        agentRuntimeResourceIds: cliResourceIds,
        observedProjectIds: cliObservedProjectIds,
        installationStatus: cliInstall.status,
        projectDiscoveryStatus: cliProjectStatus,
        diagnostics: cliInstall.diagnostics,
    };
    const appRuntime: AdapterProbeResult["observation"]["observedAgentRuntimes"][number] = {
        agentRuntimeId: "ANTIGRAVITY_APP",
        versionText: appInstall.versionText,
        installationEvidence: appInstall.evidence,
        sourceRootIds: uniqueSorted([
            ...familyRootIds,
            antigravityPrivateSkills,
            ...runtimeValues(materializedProjects.sourceRootIdsByRuntime, "ANTIGRAVITY_APP"),
        ]),
        agentRuntimeResourceIds: uniqueSorted([
            ...sharedResourceIds,
            appDataResource.agentRuntimeResourceId,
            appPbResource.agentRuntimeResourceId,
        ]),
        observedProjectIds: runtimeValues(materializedProjects.observedProjectIdsByRuntime, "ANTIGRAVITY_APP"),
        installationStatus: appInstall.status,
        projectDiscoveryStatus: appProjectStatus,
        diagnostics: appInstall.diagnostics,
    };
    const ideRuntime: AdapterProbeResult["observation"]["observedAgentRuntimes"][number] = {
        agentRuntimeId: "ANTIGRAVITY_IDE",
        versionText: ideInstall.versionText,
        installationEvidence: ideInstall.evidence,
        sourceRootIds: uniqueSorted([
            ...familyRootIds,
            ...runtimeValues(materializedProjects.sourceRootIdsByRuntime, "ANTIGRAVITY_IDE"),
        ]),
        agentRuntimeResourceIds: uniqueSorted([
            ...sharedResourceIds,
            ideDataResource.agentRuntimeResourceId,
            idePbResource.agentRuntimeResourceId,
        ]),
        observedProjectIds: runtimeValues(materializedProjects.observedProjectIdsByRuntime, "ANTIGRAVITY_IDE"),
        installationStatus: ideInstall.status,
        projectDiscoveryStatus: ideProjectStatus,
        diagnostics: ideInstall.diagnostics,
    };
    const targetCandidates = materializeAntigravityTargetCandidates(
        observedProjects,
        sourceRoots,
        [cliRuntime, appRuntime, ideRuntime],
        resources,
    );

    const observation: AdapterProbeResult["observation"] = {
        observedAgentRuntimes: [cliRuntime, appRuntime, ideRuntime],
        sourceRoots: [...sourceRoots.values()].sort((left, right) => compareText(left.sourceRootId, right.sourceRootId)),
        agentRuntimeResources: [...resources.values()].sort((left, right) =>
            compareText(left.agentRuntimeResourceId, right.agentRuntimeResourceId),
        ),
        observedProjects,
        targetCandidates,
    };
    const hasErrors = diagnostics.some((item) => item.severity === "error");
    const hasPartial = diagnostics.some((item) => item.causeKind === "partial" || item.causeKind === "permission_denied");
    return {
        status: hasErrors ? "failed" : hasPartial ? "partial" : "complete",
        observation,
        diagnostics,
    };
}

type AntigravityObservedProject = AdapterProbeResult["observation"]["observedProjects"][number];
type AntigravityObservedRuntime = AdapterProbeResult["observation"]["observedAgentRuntimes"][number];
type AntigravityRuntimeResource = AdapterProbeResult["observation"]["agentRuntimeResources"][number];
type AntigravityTargetCandidate = AdapterProbeResult["observation"]["targetCandidates"][number];
type AntigravityTargetApplicability = AntigravityTargetCandidate["entryApplicabilities"][number];

const ANTIGRAVITY_TARGET_RUNTIME_IDS = [
    "ANTIGRAVITY_CLI",
    "ANTIGRAVITY_APP",
    "ANTIGRAVITY_IDE",
] as const satisfies readonly AgentRuntimeId[];

export function materializeAntigravityTargetCandidates(
    observedProjects: AntigravityObservedProject[],
    sourceRoots: Map<string, SourceRoot>,
    runtimeInput: AntigravityObservedRuntime | readonly AntigravityObservedRuntime[],
    resources: ReadonlyMap<string, AntigravityRuntimeResource>,
): AntigravityTargetCandidate[] {
    const runtimes = Array.isArray(runtimeInput) ? runtimeInput : [runtimeInput];
    const projectsByPrimaryRoot = new Map<string, { root: SourceRoot; projects: AntigravityObservedProject[] }>();
    const invalidCandidates: AntigravityTargetCandidate[] = [];

    for (const project of observedProjects) {
        const primary = project.workspaces.find((workspace) => workspace.role === "primary");
        const root = primary === undefined ? undefined : sourceRoots.get(primary.sourceRootId);
        if (primary === undefined || root === undefined || root.path === "") {
            invalidCandidates.push(
                makeAntigravityTargetCandidate(
                    stableId("target", project.observedProjectId),
                    root,
                    project.displayName,
                    [project],
                    runtimes,
                    resources,
                ),
            );
            continue;
        }

        const existing = projectsByPrimaryRoot.get(primary.sourceRootId);
        if (existing === undefined) {
            projectsByPrimaryRoot.set(primary.sourceRootId, { root, projects: [project] });
        } else {
            existing.projects.push(project);
        }
    }

    const physicalCandidates = [...projectsByPrimaryRoot.entries()].map(([sourceRootId, group]) => {
        const displayName = uniqueSorted(group.projects.map((project) => project.displayName))[0] as string;
        return makeAntigravityTargetCandidate(
            stableId("target", sourceRootId),
            group.root,
            displayName,
            group.projects,
            runtimes,
            resources,
        );
    });

    const globalCandidates = [...sourceRoots.values()]
        .filter(
            (root) =>
                root.rootRole === "config" &&
                root.sourceDomain === "family_shared" &&
                root.accessStatus === "available" &&
                root.diagnostics.every((item) => item.severity !== "error"),
        )
        .map((root) => makeAntigravityGlobalTargetCandidate(root, runtimes));

    return [...physicalCandidates, ...invalidCandidates, ...globalCandidates].sort((left, right) =>
        compareText(`${left.targetRootPath}\0${left.targetCandidateId}`, `${right.targetRootPath}\0${right.targetCandidateId}`),
    );
}

function makeAntigravityGlobalTargetCandidate(
    root: SourceRoot,
    runtimes: readonly AntigravityObservedRuntime[],
): AntigravityTargetCandidate {
    const locatorEvidence = root.locatorEvidence;
    return {
        targetCandidateId: stableId("global-target", root.sourceRootId),
        targetRootPath: root.path,
        targetKind: "global",
        displayName: "Antigravity global configuration",
        entryApplicabilities: ANTIGRAVITY_TARGET_RUNTIME_IDS.map((agentRuntimeId) => {
            const runtime = runtimes.find((candidate) => candidate.agentRuntimeId === agentRuntimeId);
            return runtime === undefined
                ? unavailableTargetRuntime(root, agentRuntimeId, locatorEvidence)
                : globalTargetApplicability(root, runtime);
        }),
        diagnostics: [],
    };
}

function globalTargetApplicability(root: SourceRoot, runtime: AntigravityObservedRuntime): AntigravityTargetApplicability {
    const agentRuntimeId = runtime.agentRuntimeId;
    const { slug, label } = runtimeIdentity(agentRuntimeId);
    const base = { agentRuntimeId, locatorEvidence: root.locatorEvidence };
    if (runtime.installationStatus === "not_found") {
        return {
            ...base,
            status: "invalid",
            diagnostics: [
                diagnostic(
                    `antigravity_${slug}_global_target_installation_not_found`,
                    `${label} global targets require an installed ${label}`,
                    "not_found",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    if (
        runtime.installationStatus !== "available" ||
        !runtime.sourceRootIds.includes(root.sourceRootId) ||
        !runtime.installationEvidence.some(
            (evidence) =>
                evidence.kind === "executable" &&
                (evidence.evidenceLevel === "agent_runtime_verified" || evidence.evidenceLevel === "local_artifact") &&
                !evidence.diagnostics.some((item) => item.severity === "error"),
        ) ||
        root.locatorEvidence.length === 0
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    `antigravity_${slug}_global_target_build_evidence_unavailable`,
                    `${label} global target planning requires one readable family root and build-bearing installation`,
                    runtime.installationStatus === "needs_permission" ? "permission_denied" : "partial",
                    "warning",
                    root.path,
                ),
            ],
        };
    }
    return { ...base, status: "ready_for_plan", diagnostics: [] };
}

function makeAntigravityTargetCandidate(
    targetCandidateId: string,
    root: SourceRoot | undefined,
    displayName: string,
    projects: AntigravityObservedProject[],
    runtimes: readonly AntigravityObservedRuntime[],
    resources: ReadonlyMap<string, AntigravityRuntimeResource>,
): AntigravityTargetCandidate {
    const targetRootPath = root?.path ?? "";
    const locatorEvidence =
        root === undefined || root.path === "" || root.locatorEvidence.length === 0
            ? uniqueSorted(projects.map((project) => project.runtimeProjectKey)).map((locatorKey) => ({
                  locatorKind: "project_registry_entry" as const,
                  locatorKey,
                  evidenceLevel: "local_artifact" as const,
              }))
            : root.locatorEvidence;
    return {
        targetCandidateId,
        targetRootPath,
        targetKind: "project",
        displayName,
        entryApplicabilities: ANTIGRAVITY_TARGET_RUNTIME_IDS.map((agentRuntimeId) => {
            const runtime = runtimes.find((candidate) => candidate.agentRuntimeId === agentRuntimeId);
            return runtime === undefined
                ? unavailableTargetRuntime(root, agentRuntimeId, locatorEvidence)
                : targetApplicability(root, projects, runtime, resources, locatorEvidence);
        }),
        diagnostics: [],
    };
}

function targetApplicability(
    root: SourceRoot | undefined,
    projects: AntigravityObservedProject[],
    runtime: AntigravityObservedRuntime,
    resources: ReadonlyMap<string, AntigravityRuntimeResource>,
    locatorEvidence: SourceRoot["locatorEvidence"],
): AntigravityTargetApplicability {
    const targetRootPath = root?.path ?? "";
    const agentRuntimeId = runtime.agentRuntimeId;
    const { slug, label } = runtimeIdentity(agentRuntimeId);
    const base = { agentRuntimeId, locatorEvidence };
    if (root === undefined || targetRootPath === "") {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    `antigravity_${slug}_target_root_invalid`,
                    `${label} target planning requires one canonical project root`,
                    "invalid_schema",
                    "warning",
                    targetRootPath,
                ),
            ],
        };
    }
    if (runtime.installationStatus === "not_found") {
        return {
            ...base,
            status: "invalid",
            diagnostics: [
                diagnostic(
                    `antigravity_${slug}_target_installation_not_found`,
                    `${label} project targets cannot be planned without an installed ${label}`,
                    "not_found",
                    "warning",
                    targetRootPath,
                ),
            ],
        };
    }
    if (
        runtime.installationStatus !== "available" ||
        !runtime.installationEvidence.some(
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
                    `antigravity_${slug}_target_build_evidence_unavailable`,
                    `${label} target planning needs one readable build-bearing installation observation`,
                    runtime.installationStatus === "needs_permission" ? "permission_denied" : "partial",
                    "warning",
                    targetRootPath,
                ),
            ],
        };
    }
    if (runtime.projectDiscoveryStatus !== "complete" || runtime.diagnostics.some((item) => item.severity === "error")) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    `antigravity_${slug}_target_project_discovery_incomplete`,
                    `${label} target planning requires a complete current project-registry observation`,
                    "partial",
                    "warning",
                    targetRootPath,
                ),
            ],
        };
    }
    if (
        root.accessStatus !== "available" ||
        root.diagnostics.some((item) => item.severity === "error") ||
        !projects.some(
            (project) =>
                hasTrustedProjectLocator(root, project) &&
                hasTrustedProjectBinding(project, root.sourceRootId, runtime, resources),
        )
    ) {
        return {
            ...base,
            status: "unknown",
            diagnostics: [
                diagnostic(
                    `antigravity_${slug}_target_project_binding_unverified`,
                    `${label} target planning requires this readable root to be joined to a trusted project registry`,
                    "verification_failed",
                    "warning",
                    targetRootPath,
                ),
            ],
        };
    }
    return { ...base, status: "ready_for_plan", diagnostics: [] };
}

function hasTrustedProjectLocator(root: SourceRoot, project: AntigravityObservedProject): boolean {
    return root.locatorEvidence.some(
        (evidence) =>
            (evidence.locatorKind === "project_registry_entry" &&
                (evidence.evidenceLevel === "agent_runtime_verified" || evidence.evidenceLevel === "local_artifact")) ||
            (evidence.locatorKind === "user_provided_path" &&
                evidence.locatorKey === "probe_project_root" &&
                evidence.evidenceLevel === "user_provided" &&
                hasExactUserProjectAuthorization(project)),
    );
}

function hasExactUserProjectAuthorization(project: AntigravityObservedProject): boolean {
    return project.evidence.some(
        (evidence) =>
            evidence.evidenceKind === "invocation" &&
            evidence.evidenceLevel === "user_provided" &&
            evidence.locatorKey === "probe_project_root",
    );
}

function hasTrustedProjectBinding(
    project: AntigravityObservedProject,
    sourceRootId: string,
    runtime: AntigravityObservedRuntime,
    resources: ReadonlyMap<string, AntigravityRuntimeResource>,
): boolean {
    if (
        !ANTIGRAVITY_TARGET_RUNTIME_IDS.includes(runtime.agentRuntimeId as (typeof ANTIGRAVITY_TARGET_RUNTIME_IDS)[number]) ||
        !runtime.observedProjectIds.includes(project.observedProjectId) ||
        !project.workspaces.some((workspace) => workspace.role === "primary" && workspace.sourceRootId === sourceRootId) ||
        project.diagnostics.some((item) => item.severity === "error")
    ) {
        return false;
    }
    if (hasExactUserProjectAuthorization(project)) return true;
    const resourceIds = new Set(runtime.agentRuntimeResourceIds);
    return project.evidence.some((evidence) => {
        if (
            evidence.evidenceKind !== "agent_runtime_resource" ||
            !resourceIds.has(evidence.agentRuntimeResourceId) ||
            (evidence.evidenceLevel !== "agent_runtime_verified" && evidence.evidenceLevel !== "local_artifact")
        ) {
            return false;
        }
        const resource = resources.get(evidence.agentRuntimeResourceId);
        return (
            resource !== undefined &&
            resource.accessStatus === "available" &&
            resource.roles.includes("project_registry") &&
            !resource.diagnostics.some((item) => item.severity === "error") &&
            resource.locatorEvidence.some(
                (locator) => locator.evidenceLevel === "agent_runtime_verified" || locator.evidenceLevel === "local_artifact",
            )
        );
    });
}

function unavailableTargetRuntime(
    root: SourceRoot | undefined,
    agentRuntimeId: (typeof ANTIGRAVITY_TARGET_RUNTIME_IDS)[number],
    locatorEvidence: SourceRoot["locatorEvidence"],
): AntigravityTargetApplicability {
    return {
        agentRuntimeId,
        status: "unknown",
        locatorEvidence,
        diagnostics: [
            diagnostic(
                "antigravity_target_runtime_observation_missing",
                `${agentRuntimeId} target planning requires one exact current runtime observation`,
                "partial",
                "warning",
                root?.path ?? "",
            ),
        ],
    };
}

function runtimeIdentity(agentRuntimeId: AgentRuntimeId): { slug: string; label: string } {
    if (agentRuntimeId === "ANTIGRAVITY_CLI") return { slug: "cli", label: "Antigravity CLI" };
    if (agentRuntimeId === "ANTIGRAVITY_APP") return { slug: "app", label: "Antigravity App" };
    return { slug: "ide", label: "Antigravity IDE" };
}

function unavailableProbe(status: "partial" | "failed", item: OperationDiagnostic): AdapterProbeResult {
    return {
        status,
        observation: {
            observedAgentRuntimes: [
                unknownRuntime("ANTIGRAVITY_CLI", item),
                unknownRuntime("ANTIGRAVITY_APP", item),
                unknownRuntime("ANTIGRAVITY_IDE", item),
            ],
            sourceRoots: [],
            agentRuntimeResources: [],
            observedProjects: [],
            targetCandidates: [],
        },
        diagnostics: [item],
    };
}

function addAuthorizedExternalRoot(
    context: AdapterProbeContext,
    sourceRoots: Map<string, SourceRoot>,
    diagnostics: OperationDiagnostic[],
): string[] {
    if (context.authorizationScope !== "directory") return [];
    const external = canonicalProviderHostPathWithinAccessRoot(context.directoryRootPath, context.platformContext);
    if (external === null) {
        diagnostics.push(
            diagnostic(
                "antigravity_external_root_invalid",
                "The authorized Antigravity external source root is not canonical absolute",
                "invalid_schema",
                "error",
                context.directoryRootPath,
            ),
        );
        return [];
    }
    return [
        addSourceRoot(
            sourceRoots,
            makeSourceRoot(external, "source", "external_managed", "directory", [
                {
                    locatorKind: "user_provided_path",
                    locatorKey: "probe_directory_root",
                    evidenceLevel: "user_provided",
                },
            ]),
        ),
    ];
}
