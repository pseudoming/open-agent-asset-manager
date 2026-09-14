interface TargetProbeEnvironment {
    readonly platform: string;
    readonly platformInstanceId: string;
}

export function createTargetEmptyProbe(adapterIds: readonly string[], environment: TargetProbeEnvironment) {
    document.documentElement.dataset.oaamTargetProbeAdapterIds = JSON.stringify(adapterIds);
    return {
        status: "complete" as const,
        value: {
            probeToken: "actual-render-target-empty-probe",
            results: adapterIds.map((adapterId, index) => ({
                rowId: `target-result-${String(index)}`,
                adapterId,
                environment,
                status: "complete" as const,
                runtimes: [
                    {
                        rowId: `target-runtime-${String(index)}`,
                        agentRuntimeId: adapterId === "OPENCODE" ? "OPENCODE_CLI" : "CLAUDE_CODE_CLI",
                        versionText: adapterId === "OPENCODE" ? "" : "2.1.0",
                        installationStatus: adapterId === "OPENCODE" ? ("not_found" as const) : ("available" as const),
                        projectDiscoveryStatus: "complete" as const,
                        sourceRootRowIds: [],
                        diagnostics: [],
                    },
                ],
                sources: [],
                projects: [],
                targets: [],
                diagnostics: [],
            })),
        },
        diagnostics: [],
    };
}

export function createTargetUsageProbe(adapterIds: readonly string[], environment: TargetProbeEnvironment, projectPath: string) {
    document.documentElement.dataset.oaamTargetProbeAdapterIds = JSON.stringify(adapterIds);
    return {
        status: "complete" as const,
        value: {
            probeToken: "actual-render-target-usage-probe",
            results: adapterIds.map((adapterId, index) => {
                const agentRuntimeId = adapterId === "OPENCODE" ? "OPENCODE_CLI" : "CLAUDE_CODE_CLI";
                return {
                    rowId: `target-usage-result-${String(index)}`,
                    adapterId,
                    environment,
                    status: "complete" as const,
                    runtimes: [
                        {
                            rowId: `target-usage-runtime-${String(index)}`,
                            agentRuntimeId,
                            versionText: "actual-render",
                            installationStatus: "available" as const,
                            projectDiscoveryStatus: "complete" as const,
                            sourceRootRowIds: [],
                            diagnostics: [],
                        },
                    ],
                    sources: [],
                    projects: [],
                    targets: [
                        {
                            rowId: `target-usage-target-${String(index)}`,
                            targetCandidateId: `${adapterId.toLowerCase()}-project-target`,
                            targetKind: "project" as const,
                            displayName: "Open Agent Asset Manager",
                            displayPath: projectPath,
                            entryApplicabilities: [{ agentRuntimeId, status: "ready_for_plan" as const, diagnostics: [] }],
                            diagnostics: [],
                        },
                    ],
                    diagnostics: [],
                };
            }),
        },
        diagnostics: [],
    };
}

interface TargetProbeFixtureClientOptions {
    readonly emptyJourneyMode: boolean;
    readonly deploymentCatalogPreviewMode: boolean;
    readonly deploymentAssetChoiceCount: number;
    readonly projectPath: string;
    readonly emptyGlobalProbe: unknown;
    readonly globalProbe: unknown;
}

export function createTargetProbeFixtureClient(options: TargetProbeFixtureClientOptions) {
    return {
        async probeGlobal(adapterIds: readonly string[], environments: readonly unknown[]) {
            document.documentElement.dataset.oaamProbeAdapterIds = JSON.stringify(adapterIds);
            document.documentElement.dataset.oaamProbeEnvironmentCount = String(environments.length);
            if (document.documentElement.dataset.oaamHoldGlobalProbe === "true") {
                document.documentElement.dataset.oaamContainmentStage = "probing";
                await new Promise<void>((resolve) => {
                    window.addEventListener("oaam-actual-render-release-probe", () => resolve(), { once: true });
                });
                delete document.documentElement.dataset.oaamHoldGlobalProbe;
            }
            return {
                status: "complete" as const,
                value: options.emptyJourneyMode ? options.emptyGlobalProbe : options.globalProbe,
                diagnostics: [],
            };
        },
        async probeProject(
            adapterIds: readonly string[],
            environments: readonly { platform: string; platformInstanceId: string }[],
        ) {
            const environment = environments[0];
            if (environment === undefined) throw new Error("actual-render Project probe requires one environment");
            if (options.deploymentCatalogPreviewMode && options.deploymentAssetChoiceCount === 15) {
                return createTargetUsageProbe(adapterIds, environment, options.projectPath);
            }
            return createTargetEmptyProbe(adapterIds, environment);
        },
        async analyzeAssetUsage(input: {
            readonly probeToken: string;
            readonly probeResultRowId: string;
            readonly targetRowId: string;
            readonly consumerAgentRuntimeIds: readonly string[];
            readonly asset: { readonly assetId: string; readonly versionId: string };
        }) {
            document.documentElement.dataset.oaamAssetUsageRequest = JSON.stringify(input);
            return {
                status: "complete" as const,
                operationId: "actual-render-asset-usage",
                value: {
                    schemaVersion: 2 as const,
                    assetId: input.asset.assetId,
                    versionId: input.asset.versionId,
                    relationships: input.consumerAgentRuntimeIds.map((agentRuntimeId) => ({
                        agentRuntimeId,
                        capability: "direct" as const,
                        observedTargetState: "absent" as const,
                        managedState: "none" as const,
                        substitute: null,
                        deploymentIds: [],
                        appliedDeploymentIds: [],
                        degradationKinds: [],
                        reasonCodes: ["actual_render_direct_usage"],
                        requiresReview: false,
                    })),
                },
                diagnostics: [],
            };
        },
    };
}
