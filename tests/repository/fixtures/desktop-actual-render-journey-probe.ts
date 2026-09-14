export const ACTUAL_RENDER_PROJECT_SOURCE_PATH = "C:\\Users\\Example\\work\\sample-project";

interface JourneyProbeOptions {
    readonly environment: { readonly platform: "win32"; readonly platformInstanceId: string };
    readonly sharedSourcePath: string;
    readonly compatibleOnlySourcePath: string;
    readonly projectSourcePath: string;
    readonly includeEntryChoice?: boolean;
}

function journeySource(
    rowId: string,
    sourceDomain: "agent_runtime_private" | "family_shared" | "project_root",
    displayPath: string,
    rootRole: "source" | "project_actual" = "source",
) {
    return Object.freeze({
        rowId,
        sourceRootId: `root-${rowId}`,
        rootRole,
        sourceDomain,
        displayPath,
        accessStatus: "available" as const,
        locatorIdentities: Object.freeze([
            Object.freeze({ locatorKind: "runtime_known_rule" as const, locatorKey: `locator-${rowId}` }),
        ]),
        diagnostics: Object.freeze([]),
    });
}

export function createActualRenderJourneyProbe(options: JourneyProbeOptions) {
    return Object.freeze({
        probeToken: "actual-render-probe-token",
        results: Object.freeze([
            Object.freeze({
                rowId: "claude-result",
                adapterId: "CLAUDECODE",
                environment: options.environment,
                status: "complete" as const,
                runtimes: Object.freeze([
                    Object.freeze({
                        rowId: "claude-runtime",
                        agentRuntimeId: "CLAUDE_CODE_CLI",
                        versionText: "2.1",
                        installationStatus: "available" as const,
                        projectDiscoveryStatus: "complete" as const,
                        sourceRootRowIds: Object.freeze(["claude-native"]),
                        diagnostics: Object.freeze([]),
                    }),
                ]),
                sources: Object.freeze([journeySource("claude-native", "agent_runtime_private", options.sharedSourcePath)]),
                projects: Object.freeze([]),
                targets: Object.freeze([]),
                diagnostics: Object.freeze([]),
            }),
            Object.freeze({
                rowId: "opencode-result",
                adapterId: "OPENCODE",
                environment: options.environment,
                status: "complete" as const,
                runtimes: Object.freeze([
                    Object.freeze({
                        rowId: "opencode-runtime",
                        agentRuntimeId: "OPENCODE_CLI",
                        versionText: "1.0",
                        installationStatus: "available" as const,
                        projectDiscoveryStatus: "complete" as const,
                        sourceRootRowIds: Object.freeze(["opencode-compatible", "opencode-compatible-only", "project-root"]),
                        diagnostics: Object.freeze([]),
                    }),
                    ...(options.includeEntryChoice
                        ? [
                              Object.freeze({
                                  rowId: "opencode-app-runtime",
                                  agentRuntimeId: "OPENCODE_APP",
                                  versionText: "1.0",
                                  installationStatus: "available" as const,
                                  projectDiscoveryStatus: "complete" as const,
                                  sourceRootRowIds: Object.freeze(["opencode-compatible-only"]),
                                  diagnostics: Object.freeze([]),
                              }),
                          ]
                        : []),
                ]),
                sources: Object.freeze([
                    journeySource("opencode-compatible", "family_shared", options.sharedSourcePath),
                    journeySource("opencode-compatible-only", "family_shared", options.compatibleOnlySourcePath),
                    journeySource("project-root", "project_root", options.projectSourcePath, "project_actual"),
                ]),
                projects: Object.freeze([
                    Object.freeze({
                        rowId: "sample-project-row",
                        observedProjectId: "sample-project",
                        displayName: "Sample Project",
                        workspaceSourceRowIds: Object.freeze(["project-root"]),
                        containedSourceRootRowIds: Object.freeze(["project-root"]),
                        diagnostics: Object.freeze([]),
                    }),
                ]),
                targets: Object.freeze([]),
                diagnostics: Object.freeze([]),
            }),
        ]),
    });
}

export function withOpenCodeAppEntry<
    T extends {
        readonly agentRuntimes: readonly {
            readonly agentRuntimeId: string;
            readonly displayName: string;
            readonly entryClass: "cli" | "app";
        }[];
    },
>(provider: T) {
    return Object.freeze({
        ...provider,
        agentRuntimes: Object.freeze([
            ...provider.agentRuntimes,
            Object.freeze({
                agentRuntimeId: "OPENCODE_APP",
                displayName: "OpenCode App",
                entryClass: "app" as const,
            }),
        ]),
    });
}
