import { describe, expect, it } from "vitest";
import { validateAdapterProbeResult } from "../../src/adapters/adapter-contract-validator";
import type { AdapterId, AdapterProbeResult, AgentRuntimeId, PlatformContext } from "../../src/types";
import {
    completeNotFoundProbe,
    makeContractProvider,
    partialUnknownProbe,
    testDiagnostic,
} from "./fixtures/adapter-contract-fixtures";

const A = "VALIDATOR_A" as AdapterId;
const LINUX_CONTEXT: PlatformContext = { platform: "linux", platformInstanceId: "test", accessRootPath: "/" };

function codes(diagnostics: Array<{ code: string }>): string[] {
    return diagnostics.map((item) => item.code);
}

function addObservedEnvironmentProject(result: AdapterProbeResult): void {
    const runtime = result.observation.observedAgentRuntimes[0]!;
    runtime.sourceRootIds = ["project-root"];
    runtime.observedProjectIds = ["project"];
    result.observation.sourceRoots = [
        {
            sourceRootId: "project-root",
            rootRole: "project_actual",
            sourceDomain: "project_root",
            path: "/project",
            accessStatus: "available",
            locatorEvidence: [
                {
                    locatorKind: "user_provided_path",
                    locatorKey: "project",
                    evidenceLevel: "user_provided",
                },
            ],
            diagnostics: [],
        },
    ];
    result.observation.observedProjects = [
        {
            observedProjectId: "project",
            runtimeProjectKey: "project-key",
            displayName: "Project",
            workspaces: [{ sourceRootId: "project-root", role: "primary" }],
            evidence: [
                {
                    evidenceKind: "environment",
                    locatorKey: "project",
                    evidenceLevel: "user_provided",
                },
            ],
            diagnostics: [],
        },
    ];
}

describe("adapter probe-result validator", () => {
    it("accepts complete checked not-found, partial unknown, and failed empty observations", () => {
        const provider = makeContractProvider(A);
        const runtime = provider.agentRuntimes[0]!.agentRuntimeId;
        expect(validateAdapterProbeResult(provider, completeNotFoundProbe(runtime), LINUX_CONTEXT)).toEqual([]);
        expect(validateAdapterProbeResult(provider, partialUnknownProbe(runtime), LINUX_CONTEXT)).toEqual([]);
        expect(
            validateAdapterProbeResult(provider, partialUnknownProbe(runtime), {
                ...LINUX_CONTEXT,
                accessRootPath: "relative",
            }).map((diagnostic) => diagnostic.code),
        ).toContain("probe.context_access_root_invalid");
        expect(
            validateAdapterProbeResult(
                provider,
                {
                    status: "failed",
                    observation: {
                        observedAgentRuntimes: [],
                        sourceRoots: [],
                        agentRuntimeResources: [],
                        observedProjects: [],
                        targetCandidates: [],
                    },
                    diagnostics: [testDiagnostic("failed", "probe")],
                },
                LINUX_CONTEXT,
            ),
        ).toEqual([]);
    });

    it("rejects runtime enum values outside the frozen observation contract", () => {
        const runtimeId = `${A}_CLI` as AgentRuntimeId;
        const provider = makeContractProvider(A);
        const result = partialUnknownProbe(runtimeId);
        result.status = "maybe" as never;
        const runtime = result.observation.observedAgentRuntimes[0]!;
        runtime.installationStatus = "stale" as never;
        runtime.projectDiscoveryStatus = "unscanned" as never;
        runtime.installationEvidence = [
            {
                kind: "registry" as never,
                path: "/runtime",
                evidenceLevel: "assumed" as never,
                diagnostics: [],
            },
        ];
        runtime.sourceRootIds = ["root-invalid"];
        runtime.agentRuntimeResourceIds = ["resource-invalid"];
        runtime.observedProjectIds = ["project-invalid"];
        result.observation.sourceRoots = [
            {
                sourceRootId: "root-invalid",
                rootRole: "install" as never,
                sourceDomain: "plugin" as never,
                path: "/source",
                accessStatus: "stale" as never,
                locatorEvidence: [
                    {
                        locatorKind: "cwd" as never,
                        locatorKey: "source",
                        evidenceLevel: "assumed" as never,
                    },
                ],
                diagnostics: [],
            },
        ];
        result.observation.agentRuntimeResources = [
            {
                agentRuntimeResourceId: "resource-invalid",
                roles: ["cache" as never],
                path: "/resource",
                accessStatus: "stale" as never,
                locatorEvidence: [
                    {
                        locatorKind: "cwd" as never,
                        locatorKey: "resource",
                        evidenceLevel: "assumed" as never,
                    },
                ],
                diagnostics: [],
            },
        ];
        result.observation.observedProjects = [
            {
                observedProjectId: "project-invalid",
                runtimeProjectKey: "project",
                displayName: "project",
                workspaces: [{ sourceRootId: "root-invalid", role: "owner" as never }],
                evidence: [
                    {
                        evidenceKind: "filesystem" as never,
                        locatorKey: "project",
                        evidenceLevel: "assumed" as never,
                    },
                ],
                diagnostics: [],
            },
        ];
        result.observation.targetCandidates = [
            {
                targetCandidateId: "target-invalid",
                targetRootPath: "/target",
                targetKind: "remote" as never,
                displayName: "target",
                entryApplicabilities: [
                    {
                        agentRuntimeId: runtimeId,
                        status: "maybe" as never,
                        locatorEvidence: [
                            {
                                locatorKind: "cwd" as never,
                                locatorKey: "target",
                                evidenceLevel: "assumed" as never,
                            },
                        ],
                        diagnostics: [],
                    },
                ],
                diagnostics: [],
            },
        ];
        expect(codes(validateAdapterProbeResult(provider, result, LINUX_CONTEXT))).toEqual(
            expect.arrayContaining([
                "probe.status_invalid",
                "probe.installation_status_invalid",
                "probe.project_discovery_status_invalid",
                "probe.installation_evidence_kind_invalid",
                "probe.installation_evidence_level_invalid",
                "probe.source_root_role_invalid",
                "probe.source_domain_invalid",
                "probe.source_access_status_invalid",
                "probe.locator_kind_invalid",
                "probe.locator_evidence_level_invalid",
                "probe.resource_access_status_invalid",
                "probe.resource_role_invalid",
                "probe.project_workspace_role_invalid",
                "probe.project_evidence_kind_invalid",
                "probe.project_evidence_level_invalid",
                "probe.target_kind_invalid",
                "probe.target_status_invalid",
            ]),
        );
    });

    it("accepts a fully linked available runtime/project/root/resource/target observation", () => {
        const provider = makeContractProvider(A);
        const runtime = provider.agentRuntimes[0]!.agentRuntimeId;
        const result: AdapterProbeResult = {
            status: "complete",
            observation: {
                observedAgentRuntimes: [
                    {
                        agentRuntimeId: runtime,
                        versionText: "1.0",
                        installationEvidence: [
                            {
                                kind: "version_command",
                                path: "/bin/mock",
                                evidenceLevel: "agent_runtime_verified",
                                diagnostics: [],
                            },
                        ],
                        sourceRootIds: ["root"],
                        agentRuntimeResourceIds: ["registry"],
                        observedProjectIds: ["project"],
                        installationStatus: "available",
                        projectDiscoveryStatus: "complete",
                        diagnostics: [],
                    },
                ],
                sourceRoots: [
                    {
                        sourceRootId: "root",
                        rootRole: "project_actual",
                        sourceDomain: "project_root",
                        path: "/project",
                        accessStatus: "available",
                        locatorEvidence: [
                            {
                                locatorKind: "project_registry_entry",
                                locatorKey: "p",
                                evidenceLevel: "agent_runtime_verified",
                            },
                        ],
                        diagnostics: [],
                    },
                ],
                agentRuntimeResources: [
                    {
                        agentRuntimeResourceId: "registry",
                        roles: ["project_registry"],
                        path: "/runtime/projects.db",
                        accessStatus: "available",
                        locatorEvidence: [
                            {
                                locatorKind: "runtime_known_rule",
                                locatorKey: "registry",
                                evidenceLevel: "agent_runtime_verified",
                            },
                        ],
                        diagnostics: [],
                    },
                ],
                observedProjects: [
                    {
                        observedProjectId: "project",
                        runtimeProjectKey: "p",
                        displayName: "Project",
                        workspaces: [{ sourceRootId: "root", role: "primary" }],
                        evidence: [
                            {
                                evidenceKind: "agent_runtime_resource",
                                agentRuntimeResourceId: "registry",
                                locatorKey: "p",
                                evidenceLevel: "agent_runtime_verified",
                            },
                        ],
                        diagnostics: [],
                    },
                ],
                targetCandidates: [
                    {
                        targetCandidateId: "target",
                        targetRootPath: "/project",
                        targetKind: "project",
                        displayName: "Project",
                        entryApplicabilities: [
                            {
                                agentRuntimeId: runtime,
                                status: "ready_for_plan",
                                locatorEvidence: [
                                    {
                                        locatorKind: "project_registry_entry",
                                        locatorKey: "p",
                                        evidenceLevel: "agent_runtime_verified",
                                    },
                                ],
                                diagnostics: [],
                            },
                        ],
                        diagnostics: [],
                    },
                ],
            },
            diagnostics: [],
        };
        expect(validateAdapterProbeResult(provider, result, LINUX_CONTEXT)).toEqual([]);

        const canonicalEmptyProjectMetadata = structuredClone(result);
        canonicalEmptyProjectMetadata.observation.observedProjects[0]!.runtimeProjectKey = "";
        canonicalEmptyProjectMetadata.observation.observedProjects[0]!.displayName = "";
        expect(validateAdapterProbeResult(provider, canonicalEmptyProjectMetadata, LINUX_CONTEXT)).toEqual([]);

        for (const invalidProjectMetadata of [
            { runtimeProjectKey: " ", displayName: "Project" },
            { runtimeProjectKey: "project", displayName: " Project" },
            { runtimeProjectKey: "project\u0000key", displayName: "Project" },
            { runtimeProjectKey: "project", displayName: "Project\u0000Name" },
            { runtimeProjectKey: 1 as never, displayName: "Project" },
        ]) {
            const malformed = structuredClone(result);
            Object.assign(malformed.observation.observedProjects[0]!, invalidProjectMetadata);
            expect(validateAdapterProbeResult(provider, malformed, LINUX_CONTEXT).map((item) => item.code)).toContain(
                "adapter.noncanonical_text",
            );
        }

        const windowsHostedWsl = structuredClone(result);
        windowsHostedWsl.observation.sourceRoots[0]!.path = "\\\\wsl.localhost\\Ubuntu\\home\\example\\project";
        windowsHostedWsl.observation.agentRuntimeResources[0]!.path =
            "\\\\wsl.localhost\\Ubuntu\\home\\example\\.runtime\\projects.db";
        windowsHostedWsl.observation.targetCandidates[0]!.targetRootPath = "\\\\wsl.localhost\\Ubuntu\\home\\example\\project";
        expect(
            validateAdapterProbeResult(provider, windowsHostedWsl, {
                platform: "wsl",
                platformInstanceId: "Ubuntu",
                accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example",
            }),
        ).toEqual([]);
        expect(
            validateAdapterProbeResult(provider, result, {
                platform: "wsl",
                platformInstanceId: "Ubuntu",
                accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example",
            }).map((diagnostic) => diagnostic.code),
        ).toEqual(
            expect.arrayContaining([
                "probe.source_root_path_invalid",
                "probe.resource_path_invalid",
                "probe.target_path_invalid",
            ]),
        );

        const sameGrammarOutsideContext = structuredClone(windowsHostedWsl);
        sameGrammarOutsideContext.observation.sourceRoots[0]!.path = "C:\\Users\\agent\\.runtime";
        sameGrammarOutsideContext.observation.agentRuntimeResources[0]!.path =
            "\\\\wsl.localhost\\Debian\\home\\example\\projects.db";
        sameGrammarOutsideContext.observation.targetCandidates[0]!.targetRootPath =
            "\\\\wsl.localhost\\Ubuntu-24.04\\home\\example\\project";
        expect(
            validateAdapterProbeResult(provider, sameGrammarOutsideContext, {
                platform: "wsl",
                platformInstanceId: "Ubuntu",
                accessRootPath: "\\\\wsl.localhost\\Ubuntu\\",
            }).map((diagnostic) => diagnostic.code),
        ).toEqual(
            expect.arrayContaining([
                "probe.source_root_path_invalid",
                "probe.resource_path_invalid",
                "probe.target_path_invalid",
            ]),
        );
    });

    it("rejects project-discovery status, registry, orphan, and runtime-evidence contradictions", () => {
        const provider = makeContractProvider(A);
        const runtimeId = provider.agentRuntimes[0]!.agentRuntimeId;

        const parsedEmptyRegistry = completeNotFoundProbe(runtimeId);
        parsedEmptyRegistry.observation.observedAgentRuntimes[0]!.agentRuntimeResourceIds = ["data", "registry"];
        parsedEmptyRegistry.observation.agentRuntimeResources = [
            {
                agentRuntimeResourceId: "data",
                roles: ["agent_runtime_data"],
                path: "/runtime-data",
                accessStatus: "available",
                locatorEvidence: [
                    {
                        locatorKind: "runtime_known_rule",
                        locatorKey: "data",
                        evidenceLevel: "agent_runtime_verified",
                    },
                ],
                diagnostics: [],
            },
            {
                agentRuntimeResourceId: "registry",
                roles: ["project_registry"],
                path: "/registry",
                accessStatus: "available",
                locatorEvidence: [
                    {
                        locatorKind: "runtime_known_rule",
                        locatorKey: "registry",
                        evidenceLevel: "agent_runtime_verified",
                    },
                ],
                diagnostics: [],
            },
        ];
        expect(validateAdapterProbeResult(provider, parsedEmptyRegistry, LINUX_CONTEXT)).toEqual([]);

        for (const placement of ["result", "runtime", "resource"] as const) {
            const informative = structuredClone(parsedEmptyRegistry);
            const fact = {
                ...testDiagnostic("registry-process-visibility", "probe"),
                severity: "info" as "info" | "warning" | "error",
                path: "/registry",
                causeKind: "partial" as const,
            };
            const diagnostics =
                placement === "result"
                    ? informative.diagnostics
                    : placement === "runtime"
                      ? informative.observation.observedAgentRuntimes[0]!.diagnostics
                      : informative.observation.agentRuntimeResources.find(
                            (resource) => resource.agentRuntimeResourceId === "registry",
                        )!.diagnostics;
            diagnostics.push(fact);
            expect(validateAdapterProbeResult(provider, informative, LINUX_CONTEXT)).toEqual([]);
            for (const severity of ["warning", "error"] as const) {
                fact.severity = severity;
                expect(codes(validateAdapterProbeResult(provider, informative, LINUX_CONTEXT))).toContain(
                    "probe.project_registry_disposition_incomplete",
                );
            }
        }

        const missingRegistryReference = structuredClone(parsedEmptyRegistry);
        missingRegistryReference.observation.observedAgentRuntimes[0]!.agentRuntimeResourceIds.push("missing-registry");
        expect(codes(validateAdapterProbeResult(provider, missingRegistryReference, LINUX_CONTEXT))).toContain(
            "probe.resource_reference_missing",
        );

        const incompleteCompleteProbe = completeNotFoundProbe(runtimeId);
        incompleteCompleteProbe.observation.observedAgentRuntimes[0]!.projectDiscoveryStatus = "partial";
        expect(codes(validateAdapterProbeResult(provider, incompleteCompleteProbe, LINUX_CONTEXT))).toContain(
            "probe.complete_project_incomplete",
        );

        const projectReportedNotFound = completeNotFoundProbe(runtimeId);
        addObservedEnvironmentProject(projectReportedNotFound);
        expect(codes(validateAdapterProbeResult(provider, projectReportedNotFound, LINUX_CONTEXT))).toContain(
            "probe.project_discovery_status_conflict",
        );

        const orphan = completeNotFoundProbe(runtimeId);
        addObservedEnvironmentProject(orphan);
        orphan.observation.observedAgentRuntimes[0]!.observedProjectIds = [];
        expect(codes(validateAdapterProbeResult(provider, orphan, LINUX_CONTEXT))).toContain("probe.project_unreferenced");

        const foreignRegistryEvidence = completeNotFoundProbe(runtimeId);
        foreignRegistryEvidence.status = "partial";
        foreignRegistryEvidence.observation.observedAgentRuntimes[0]!.projectDiscoveryStatus = "partial";
        addObservedEnvironmentProject(foreignRegistryEvidence);
        foreignRegistryEvidence.observation.agentRuntimeResources = [
            {
                agentRuntimeResourceId: "foreign-registry",
                roles: ["project_registry"],
                path: "/foreign-registry",
                accessStatus: "available",
                locatorEvidence: [
                    {
                        locatorKind: "runtime_known_rule",
                        locatorKey: "foreign-registry",
                        evidenceLevel: "local_artifact",
                    },
                ],
                diagnostics: [],
            },
        ];
        foreignRegistryEvidence.observation.observedProjects[0]!.evidence = [
            {
                evidenceKind: "agent_runtime_resource",
                agentRuntimeResourceId: "foreign-registry",
                locatorKey: "project",
                evidenceLevel: "local_artifact",
            },
        ];
        expect(codes(validateAdapterProbeResult(provider, foreignRegistryEvidence, LINUX_CONTEXT))).toContain(
            "probe.project_runtime_evidence_unlinked",
        );

        const diagnosedRegistry = structuredClone(parsedEmptyRegistry);
        diagnosedRegistry.diagnostics = [
            {
                ...testDiagnostic("registry-unparsed", "probe"),
                path: "/registry",
                causeKind: "partial",
            },
        ];
        expect(codes(validateAdapterProbeResult(provider, diagnosedRegistry, LINUX_CONTEXT))).toContain(
            "probe.project_registry_disposition_incomplete",
        );

        const runtimeDiagnosedRegistry = structuredClone(parsedEmptyRegistry);
        runtimeDiagnosedRegistry.observation.observedAgentRuntimes[0]!.diagnostics = [
            {
                ...testDiagnostic("registry-runtime-incomplete", "probe"),
                path: "/registry",
                causeKind: "partial",
            },
        ];
        expect(codes(validateAdapterProbeResult(provider, runtimeDiagnosedRegistry, LINUX_CONTEXT))).toContain(
            "probe.project_registry_disposition_incomplete",
        );

        const unresolvedRegistry = structuredClone(parsedEmptyRegistry);
        unresolvedRegistry.observation.agentRuntimeResources.find(
            (resource) => resource.agentRuntimeResourceId === "registry",
        )!.accessStatus = "needs_permission";
        expect(codes(validateAdapterProbeResult(provider, unresolvedRegistry, LINUX_CONTEXT))).toContain(
            "probe.project_registry_disposition_incomplete",
        );
    });

    it("rejects foreign/duplicate entries, unknown complete state, and unsupported installation claims", () => {
        const provider = makeContractProvider(A);
        const runtime = provider.agentRuntimes[0]!.agentRuntimeId;
        const result: AdapterProbeResult = {
            status: "complete",
            observation: {
                observedAgentRuntimes: [
                    {
                        agentRuntimeId: runtime,
                        versionText: "",
                        installationEvidence: [],
                        sourceRootIds: ["missing", "missing"],
                        agentRuntimeResourceIds: ["missing", "missing"],
                        observedProjectIds: ["missing", "missing"],
                        installationStatus: "unknown",
                        projectDiscoveryStatus: "unknown",
                        diagnostics: [],
                    },
                    {
                        agentRuntimeId: runtime,
                        versionText: "1",
                        installationEvidence: [
                            {
                                kind: "install_root",
                                path: "/docs-only",
                                evidenceLevel: "docs_declared",
                                diagnostics: [],
                            },
                        ],
                        sourceRootIds: [],
                        agentRuntimeResourceIds: [],
                        observedProjectIds: [],
                        installationStatus: "available",
                        projectDiscoveryStatus: "complete",
                        diagnostics: [],
                    },
                    {
                        agentRuntimeId: "FOREIGN_RUNTIME",
                        versionText: "",
                        installationEvidence: [
                            {
                                kind: "executable",
                                path: "",
                                evidenceLevel: "docs_declared",
                                diagnostics: [],
                            },
                        ],
                        sourceRootIds: [],
                        agentRuntimeResourceIds: [],
                        observedProjectIds: [],
                        installationStatus: "not_found",
                        projectDiscoveryStatus: "not_found",
                        diagnostics: [],
                    },
                ],
                sourceRoots: [],
                agentRuntimeResources: [],
                observedProjects: [],
                targetCandidates: [],
            },
            diagnostics: [],
        };
        const resultCodes = validateAdapterProbeResult(provider, result, LINUX_CONTEXT).map((item) => item.code);
        expect(resultCodes).toEqual(
            expect.arrayContaining([
                "probe.agent_runtime_duplicate",
                "probe.agent_runtime_foreign",
                "probe.agent_runtime_cardinality",
                "probe.complete_installation_unknown",
                "probe.complete_project_unknown",
                "probe.available_without_evidence",
                "probe.not_found_unchecked",
                "probe.reference_duplicate",
                "probe.source_root_reference_missing",
                "probe.resource_reference_missing",
                "probe.project_reference_missing",
            ]),
        );

        const omitted = completeNotFoundProbe("FOREIGN_RUNTIME");
        expect(validateAdapterProbeResult(provider, omitted, LINUX_CONTEXT).map((item) => item.code)).toContain(
            "probe.agent_runtime_missing",
        );
    });

    it("rejects malformed root/resource/project/target relation graphs", () => {
        const provider = makeContractProvider(A);
        const runtime = provider.agentRuntimes[0]!.agentRuntimeId;
        const result = partialUnknownProbe(runtime);
        result.observation.sourceRoots = [
            {
                sourceRootId: "root",
                rootRole: "project_actual",
                sourceDomain: "project_root",
                path: "/project",
                accessStatus: "available",
                locatorEvidence: [
                    {
                        locatorKind: "runtime_known_rule",
                        locatorKey: "root",
                        evidenceLevel: "local_artifact",
                    },
                ],
                diagnostics: [],
            },
            {
                sourceRootId: "root",
                rootRole: "source",
                sourceDomain: "agent_runtime_private",
                path: "",
                accessStatus: "available",
                locatorEvidence: [],
                diagnostics: [],
            },
            {
                sourceRootId: "not-project",
                rootRole: "source",
                sourceDomain: "agent_runtime_private",
                path: "/not-project",
                accessStatus: "available",
                locatorEvidence: [
                    {
                        locatorKind: "runtime_known_rule",
                        locatorKey: "source",
                        evidenceLevel: "local_artifact",
                    },
                ],
                diagnostics: [],
            },
        ];
        result.observation.agentRuntimeResources = [
            {
                agentRuntimeResourceId: "registry",
                roles: ["project_registry"],
                path: "/registry",
                accessStatus: "available",
                locatorEvidence: [
                    {
                        locatorKind: "runtime_known_rule",
                        locatorKey: "registry",
                        evidenceLevel: "local_artifact",
                    },
                ],
                diagnostics: [],
            },
            {
                agentRuntimeResourceId: "registry",
                roles: [],
                path: "",
                accessStatus: "unknown",
                locatorEvidence: [],
                diagnostics: [],
            },
        ];
        result.observation.observedProjects = [
            {
                observedProjectId: "empty",
                runtimeProjectKey: "",
                displayName: "",
                workspaces: [],
                evidence: [],
                diagnostics: [],
            },
            {
                observedProjectId: "duplicate-workspace",
                runtimeProjectKey: "d",
                displayName: "D",
                workspaces: [
                    { sourceRootId: "root", role: "primary" },
                    { sourceRootId: "root", role: "primary" },
                ],
                evidence: [
                    {
                        evidenceKind: "environment",
                        locatorKey: "",
                        evidenceLevel: "local_artifact",
                    },
                ],
                diagnostics: [],
            },
            {
                observedProjectId: "missing-root",
                runtimeProjectKey: "m",
                displayName: "M",
                workspaces: [{ sourceRootId: "missing", role: "primary" }],
                evidence: [
                    {
                        evidenceKind: "agent_runtime_resource",
                        agentRuntimeResourceId: "missing",
                        locatorKey: "m",
                        evidenceLevel: "local_artifact",
                    },
                ],
                diagnostics: [],
            },
            {
                observedProjectId: "wrong-root-role",
                runtimeProjectKey: "w",
                displayName: "W",
                workspaces: [{ sourceRootId: "not-project", role: "primary" }],
                evidence: [
                    {
                        evidenceKind: "invocation",
                        locatorKey: "workspace",
                        evidenceLevel: "local_artifact",
                    },
                ],
                diagnostics: [],
            },
        ];
        result.observation.targetCandidates = [
            {
                targetCandidateId: "target",
                targetRootPath: "",
                targetKind: "unknown",
                displayName: "",
                entryApplicabilities: [],
                diagnostics: [],
            },
            {
                targetCandidateId: "target",
                targetRootPath: "",
                targetKind: "project",
                displayName: "",
                entryApplicabilities: [
                    {
                        agentRuntimeId: runtime,
                        status: "ready_for_plan",
                        locatorEvidence: [],
                        diagnostics: [],
                    },
                    {
                        agentRuntimeId: runtime,
                        status: "ready_for_plan",
                        locatorEvidence: [
                            {
                                locatorKind: "unknown",
                                locatorKey: "",
                                evidenceLevel: "docs_declared",
                            },
                        ],
                        diagnostics: [],
                    },
                    {
                        agentRuntimeId: "FOREIGN_RUNTIME",
                        status: "unknown",
                        locatorEvidence: [],
                        diagnostics: [],
                    },
                ],
                diagnostics: [],
            },
        ];
        const resultCodes = validateAdapterProbeResult(provider, result, LINUX_CONTEXT).map((item) => item.code);
        expect(resultCodes).toEqual(
            expect.arrayContaining([
                "probe.source_root_duplicate",
                "probe.source_root_path_invalid",
                "probe.source_root_evidence_missing",
                "probe.resource_duplicate",
                "probe.resource_path_invalid",
                "probe.resource_roles_invalid",
                "probe.resource_evidence_missing",
                "probe.project_primary_invalid",
                "probe.project_workspace_duplicate",
                "probe.project_workspace_missing",
                "probe.project_workspace_not_actual",
                "probe.project_evidence_missing",
                "probe.project_registry_evidence_invalid",
                "probe.project_unreferenced",
                "probe.target_duplicate",
                "probe.target_path_duplicate",
                "probe.target_path_invalid",
                "probe.target_applicability_missing",
                "probe.target_applicability_duplicate",
                "probe.target_applicability_foreign",
                "probe.target_ready_without_evidence",
                "probe.target_ready_without_trusted_locator",
                "adapter.noncanonical_text",
            ]),
        );
    });
});
