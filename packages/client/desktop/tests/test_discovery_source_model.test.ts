import { describe, expect, it } from "vitest";
import {
    buildReadSourceRequest,
    classifyDiscoverySources,
    defaultDiscoveryReadSourceKeys,
    defaultDiscoveryWatchSelections,
    deriveDiscoveryEnvironmentProbeOutcomes,
    deriveDiscoveryProjectProposals,
    discoveryProjectProposalForSourceGroup,
    discoveryProviderContextReceipts,
    groupDiscoverySourceClaims,
    type ProbeReviewView,
    projectDiscoverySourcesForProbe,
    reconcileDiscoveryWatchSelectionsForRegisteredProject,
    sameStringSet,
    type WatchedScanIntentView,
} from "../src/renderer/features/discovery/discovery-model";
import {
    diagnostic,
    EMPTY_WATCHED,
    ENVIRONMENT,
    PROBE,
    probeSource,
    required,
    WATCHED,
    watchedSelector,
} from "./discovery-test-fixtures";

describe("Desktop discovery source presentation model", () => {
    it("projects a current WSL-only journey without exposing a historical watched Windows source", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const wsl = { platform: "wsl" as const, platformInstanceId: "Ubuntu" };
        const windows = { platform: "win32" as const, platformInstanceId: "desktop-local" };
        const watched: WatchedScanIntentView = {
            ...WATCHED,
            environments: [
                {
                    environment: windows,
                    sourceSelectors: [watchedSelector("historical-windows", "C:\\Users\\user\\.claude")],
                },
            ],
        };
        const probe: ProbeReviewView = {
            probeToken: "wsl-only",
            results: [
                {
                    ...baseResult,
                    rowId: "zcode-wsl",
                    adapterId: "ZCODE",
                    environment: wsl,
                    runtimes: [
                        {
                            ...baseRuntime,
                            agentRuntimeId: "ZCODE_APP",
                            sourceRootRowIds: ["wsl-source"],
                        },
                    ],
                    sources: [probeSource("wsl-source", "wsl-zcode", "/home/user/.zcode")],
                },
            ],
        };

        const allSources = classifyDiscoverySources(watched, probe);
        expect(allSources.map((source) => source.displayPath)).toEqual(["C:\\Users\\user\\.claude", "/home/user/.zcode"]);
        expect(projectDiscoverySourcesForProbe(allSources, probe).map((source) => source.displayPath)).toEqual([
            "/home/user/.zcode",
        ]);
    });

    it("deduplicates the same exact Project root across providers and matches an existing Project by root", () => {
        const base = required(PROBE.results[0], "probe result");
        const root = {
            ...probeSource("project-root", "project-root", "/work/oaam"),
            rootRole: "project_actual" as const,
        };
        const observedProject = {
            rowId: "project-row",
            observedProjectId: "observed-oaam",
            displayName: "OAAM",
            workspaceSourceRowIds: ["project-root"],
            containedSourceRootRowIds: ["project-root"],
            diagnostics: [],
        };
        const probe: ProbeReviewView = {
            probeToken: "project-probe",
            results: [
                { ...base, rowId: "zcode", adapterId: "ZCODE", sources: [root], projects: [observedProject] },
                {
                    ...base,
                    rowId: "codex",
                    adapterId: "CODEX",
                    sources: [root],
                    projects: [{ ...observedProject, rowId: "project-row-codex", observedProjectId: "observed-codex" }],
                },
            ],
        };

        expect(
            deriveDiscoveryProjectProposals(probe, [
                {
                    projectId: "11111111-1111-4111-8111-111111111111",
                    displayName: "Existing OAAM",
                    rootPath: "/work/oaam",
                    deleted: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            ]),
        ).toEqual([
            expect.objectContaining({
                displayName: "OAAM",
                rootPath: "/work/oaam",
                adapterIds: ["CODEX", "ZCODE"],
                observedProjectIds: ["observed-codex", "observed-oaam"],
                matchedProjectId: "11111111-1111-4111-8111-111111111111",
                registrationReference: {
                    probeToken: "project-probe",
                    probeResultRowId: "codex",
                    projectRowId: "project-row-codex",
                    sourceRootRowId: "project-root",
                },
            }),
        ]);
    });

    it("distinguishes an exact stopped Project root from an active Project match", () => {
        const base = required(PROBE.results[0], "probe result");
        const root = {
            ...probeSource("retained-root", "retained-root", "/work/stopped"),
            rootRole: "project_actual" as const,
        };
        const probe: ProbeReviewView = {
            probeToken: "retained-project-probe",
            results: [
                {
                    ...base,
                    sources: [root],
                    projects: [
                        {
                            rowId: "retained-project-row",
                            observedProjectId: "observed-retained",
                            displayName: "Stopped workspace",
                            workspaceSourceRowIds: [root.rowId],
                            containedSourceRootRowIds: [root.rowId],
                            diagnostics: [],
                        },
                    ],
                },
            ],
        };

        expect(
            deriveDiscoveryProjectProposals(probe, [
                {
                    projectId: "99999999-9999-4999-8999-999999999999",
                    displayName: "Stopped workspace",
                    rootPath: root.displayPath,
                    deleted: true,
                    createdAt: 1,
                    updatedAt: 2,
                },
            ]),
        ).toEqual([
            expect.objectContaining({
                rootPath: root.displayPath,
                matchedProjectId: undefined,
                matchedRetainedProjectId: "99999999-9999-4999-8999-999999999999",
            }),
        ]);
    });

    it("joins Project proposals only by exact environment and root evidence", () => {
        const base = required(PROBE.results[0], "probe result");
        const root = {
            ...probeSource("project-root", "project-root", "/work/arbitrary-name"),
            rootRole: "project_actual" as const,
        };
        const probe: ProbeReviewView = {
            probeToken: "project-card-join",
            results: [
                {
                    ...base,
                    rowId: "project-result",
                    adapterId: "OPENCODE",
                    sources: [root],
                    projects: [
                        {
                            rowId: "project-row",
                            observedProjectId: "observed-project",
                            displayName: "Display name is not identity",
                            workspaceSourceRowIds: [root.rowId],
                            containedSourceRootRowIds: [root.rowId],
                            diagnostics: [],
                        },
                    ],
                },
            ],
        };
        const group = required(
            groupDiscoverySourceClaims(classifyDiscoverySources(EMPTY_WATCHED, probe), probe)[0],
            "Project source group",
        );
        const proposal = required(deriveDiscoveryProjectProposals(probe, [])[0], "Project proposal");

        expect(
            discoveryProjectProposalForSourceGroup(group, [{ ...proposal, displayName: "Renamed", adapterIds: ["ZCODE"] }]),
        ).toEqual(expect.objectContaining({ rootPath: "/work/arbitrary-name" }));
        expect(discoveryProjectProposalForSourceGroup(group, [{ ...proposal, rootPath: "/work" }])).toBeUndefined();
        expect(
            discoveryProjectProposalForSourceGroup(group, [
                { ...proposal, environment: { platform: "wsl", platformInstanceId: "Another" } },
            ]),
        ).toBeUndefined();
        expect(discoveryProjectProposalForSourceGroup(group, [proposal, { ...proposal, key: "duplicate" }])).toBeUndefined();
    });

    it("projects each available multi-workspace member as an exact user-reviewable folder without choosing a canonical root", () => {
        const base = required(PROBE.results[0], "probe result");
        const probe: ProbeReviewView = {
            probeToken: "multi-root-project",
            results: [
                {
                    ...base,
                    sources: [
                        { ...probeSource("primary", "primary", "/work/main"), rootRole: "project_actual" },
                        { ...probeSource("secondary", "secondary", "/work/secondary"), rootRole: "project_actual" },
                    ],
                    projects: [
                        {
                            rowId: "project-row",
                            observedProjectId: "observed-project",
                            displayName: "Two roots",
                            workspaceSourceRowIds: ["primary", "secondary"],
                            containedSourceRootRowIds: ["primary", "secondary"],
                            diagnostics: [],
                        },
                    ],
                },
            ],
        };

        expect(deriveDiscoveryProjectProposals(probe, [])).toEqual([
            expect.objectContaining({
                displayName: "Two roots",
                rootPath: "/work/main",
                matchedProjectId: undefined,
                registrationReference: {
                    probeToken: "multi-root-project",
                    probeResultRowId: base.rowId,
                    projectRowId: "project-row",
                    sourceRootRowId: "primary",
                },
            }),
            expect.objectContaining({
                displayName: "Two roots",
                rootPath: "/work/secondary",
                matchedProjectId: undefined,
                registrationReference: {
                    probeToken: "multi-root-project",
                    probeResultRowId: base.rowId,
                    projectRowId: "project-row",
                    sourceRootRowId: "secondary",
                },
            }),
        ]);
    });

    it("does not mint a registration reference for an unavailable Project workspace", () => {
        const base = required(PROBE.results[0], "probe result");
        const unavailableRoot = {
            ...probeSource("project-root", "project-root", "/work/unavailable", "not_found"),
            rootRole: "project_actual" as const,
        };
        const probe: ProbeReviewView = {
            probeToken: "unavailable-project",
            results: [
                {
                    ...base,
                    sources: [unavailableRoot],
                    projects: [
                        {
                            rowId: "project-row",
                            observedProjectId: "observed-project",
                            displayName: "Unavailable",
                            workspaceSourceRowIds: [unavailableRoot.rowId],
                            containedSourceRootRowIds: [unavailableRoot.rowId],
                            diagnostics: [],
                        },
                    ],
                },
            ],
        };

        expect(deriveDiscoveryProjectProposals(probe, [])).toEqual([
            expect.objectContaining({
                rootPath: undefined,
                registrationReference: undefined,
            }),
        ]);
    });

    it("classifies current, moved, missing and new roots by durable identity rather than path alone", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const watched: WatchedScanIntentView = {
            ...WATCHED,
            environments: [
                {
                    environment: ENVIRONMENT,
                    sourceSelectors: [
                        watchedSelector("current", "/current", "1".repeat(64)),
                        watchedSelector("moved", "/old", "2".repeat(64)),
                        watchedSelector("gone", "/gone", "3".repeat(64)),
                        watchedSelector("reported-missing", "/reported-missing", "4".repeat(64)),
                        watchedSelector("moved-missing", "/moved-missing-old", "5".repeat(64)),
                    ],
                },
            ],
        };
        const probe: ProbeReviewView = {
            ...PROBE,
            results: [
                {
                    ...baseResult,
                    runtimes: [
                        {
                            ...baseRuntime,
                            sourceRootRowIds: ["current", "moved", "reported-missing", "moved-missing", "new"],
                        },
                    ],
                    sources: [
                        probeSource("current", "current", "/current"),
                        probeSource("moved", "moved", "/new"),
                        probeSource("reported-missing", "reported-missing", "/reported-missing", "not_found"),
                        probeSource("moved-missing", "moved-missing", "/moved-missing-new", "not_found"),
                        probeSource("new", "new", "/brand-new"),
                    ],
                },
            ],
        };
        const classified = classifyDiscoverySources(watched, probe);
        expect(classified.map((source) => [source.status, source.displayPath, source.priorDisplayPath])).toEqual([
            ["current", "/current", ""],
            ["moved", "/new", "/old"],
            ["missing", "/gone", ""],
            ["missing", "/reported-missing", ""],
            ["missing", "/moved-missing-old", ""],
            ["new", "/brand-new", ""],
        ]);
        expect(sameStringSet(["b", "a", "a"], ["a", "b"])).toBe(true);
        expect(sameStringSet(["a"], ["a", "b"])).toBe(false);
        expect(sameStringSet(["a", "c"], ["a", "b"])).toBe(false);
    });

    it("derives one truthful environment outcome from all provider rows without storing another summary", () => {
        const base = required(PROBE.results[0], "probe result");
        const windows = { platform: "win32" as const, platformInstanceId: "desktop-local" };
        const wsl = { platform: "wsl" as const, platformInstanceId: "Ubuntu" };
        const warning = diagnostic("same diagnostic text");
        const escalation = {
            ...warning,
            severity: "error" as const,
            suggestedActions: ["contact_support"] as const,
        };
        const probe: ProbeReviewView = {
            probeToken: "multi-probe",
            results: [
                {
                    ...base,
                    rowId: "windows-complete",
                    adapterId: "Z",
                    environment: windows,
                    status: "complete",
                    diagnostics: [warning, escalation, warning],
                },
                { ...base, rowId: "windows-failed", adapterId: "A", environment: windows, status: "failed" },
                { ...base, rowId: "wsl-failed-a", adapterId: "A", environment: wsl, status: "failed" },
                { ...base, rowId: "wsl-failed-b", adapterId: "B", environment: wsl, status: "failed" },
            ],
        };

        const outcomes = deriveDiscoveryEnvironmentProbeOutcomes(probe);
        expect(outcomes).toEqual([
            {
                environment: windows,
                status: "partial",
                tools: [
                    expect.objectContaining({
                        adapterId: "A",
                        agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                        status: "failed",
                    }),
                    expect.objectContaining({
                        adapterId: "Z",
                        agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                        status: "complete",
                    }),
                ],
            },
            {
                environment: wsl,
                status: "failed",
                tools: [
                    expect.objectContaining({
                        adapterId: "A",
                        agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                        status: "failed",
                    }),
                    expect.objectContaining({
                        adapterId: "B",
                        agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                        status: "failed",
                    }),
                ],
            },
        ]);
        expect(outcomes[0]?.tools.find((tool) => tool.adapterId === "Z")?.diagnostics).toEqual([warning, escalation]);
        const receipts = discoveryProviderContextReceipts(outcomes) as readonly (readonly unknown[])[];
        expect(receipts.map((receipt) => receipt.slice(0, 3))).toEqual([
            [JSON.stringify(["win32", "desktop-local"]), "A", "failed"],
            [JSON.stringify(["win32", "desktop-local"]), "Z", "complete"],
            [JSON.stringify(["wsl", "Ubuntu"]), "A", "failed"],
            [JSON.stringify(["wsl", "Ubuntu"]), "B", "failed"],
        ]);
        expect(receipts[1]?.[6]).toEqual([
            { code: "settings.stale", causeKind: "conflict", path: "" },
            { code: "settings.stale", causeKind: "conflict", path: "" },
        ]);
    });

    it("subtracts exact runtime-owned diagnostics from the provider scope without borrowing sibling status", () => {
        const base = required(PROBE.results[0], "probe result");
        const cli = required(base.runtimes[0], "probe runtime");
        const appWarning = diagnostic("App observation warning");
        const providerWarning = { ...diagnostic("Provider observation warning"), code: "provider.partial" };
        const outcomes = deriveDiscoveryEnvironmentProbeOutcomes({
            probeToken: "entry-scoped-probe",
            results: [
                {
                    ...base,
                    status: "partial",
                    diagnostics: [appWarning, providerWarning, appWarning],
                    runtimes: [
                        { ...cli, diagnostics: [] },
                        {
                            ...cli,
                            rowId: "app-runtime",
                            agentRuntimeId: "CLAUDE_CODE_APP",
                            versionText: "",
                            installationStatus: "unknown",
                            diagnostics: [appWarning, appWarning],
                        },
                    ],
                },
            ],
        });
        const tool = required(outcomes[0]?.tools[0], "tool outcome");
        expect(tool.diagnostics).toEqual([appWarning, providerWarning]);
        expect(tool.unscopedDiagnostics).toEqual([providerWarning]);
        expect(tool.runtimeOutcomes).toEqual([
            expect.objectContaining({ agentRuntimeId: "CLAUDE_CODE_APP", diagnostics: [appWarning] }),
            expect.objectContaining({ agentRuntimeId: "CLAUDE_CODE_CLI", diagnostics: [] }),
        ]);
    });

    it("keeps absent and unreadable fresh paths out of the New source class", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const probe: ProbeReviewView = {
            ...PROBE,
            results: [
                {
                    ...baseResult,
                    runtimes: [{ ...baseRuntime, sourceRootRowIds: ["available", "missing", "unknown", "permission"] }],
                    sources: [
                        probeSource("available", "available", "/available"),
                        probeSource("missing", "missing", "/missing", "not_found"),
                        probeSource("unknown", "unknown", "/unknown", "unknown"),
                        probeSource("permission", "permission", "/permission", "needs_permission"),
                    ],
                },
            ],
        };

        expect(classifyDiscoverySources(EMPTY_WATCHED, probe).map((source) => [source.displayPath, source.status])).toEqual([
            ["/available", "new"],
        ]);
    });

    it("groups one physical path for presentation without merging provider read authority or depending on execution order", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const claudeResult = {
            ...baseResult,
            rowId: "claude-result",
            adapterId: "CLAUDECODE",
            runtimes: [{ ...baseRuntime, sourceRootRowIds: ["claude-root"], installationStatus: "not_found" as const }],
            sources: [
                {
                    ...probeSource("claude-root", "claude-native", "/home/user/.claude"),
                    sourceDomain: "agent_runtime_private" as const,
                },
            ],
        };
        const opencodeResult = {
            ...baseResult,
            rowId: "opencode-result",
            adapterId: "OPENCODE",
            runtimes: [
                {
                    ...baseRuntime,
                    agentRuntimeId: "OPENCODE_CLI",
                    sourceRootRowIds: ["opencode-compat"],
                    installationStatus: "available" as const,
                },
            ],
            sources: [
                {
                    ...probeSource("opencode-compat", "opencode-compat", "/home/user/.claude"),
                    sourceDomain: "family_shared" as const,
                },
            ],
        };
        const forward: ProbeReviewView = { probeToken: "grouped", results: [claudeResult, opencodeResult] };
        const reverse: ProbeReviewView = { probeToken: "grouped", results: [opencodeResult, claudeResult] };
        const normalized = (probe: ProbeReviewView) =>
            groupDiscoverySourceClaims(classifyDiscoverySources(EMPTY_WATCHED, probe), probe).map((group) => ({
                path: group.displayPath,
                claims: group.claims.map((claim) => [claim.source.adapterId, claim.claimKind, claim.source.readSelection.status]),
            }));

        expect(normalized(forward)).toEqual(normalized(reverse));
        expect(normalized(forward)).toEqual([
            {
                path: "/home/user/.claude",
                claims: [
                    ["CLAUDECODE", "native", "selectable"],
                    ["OPENCODE", "compatible_shared", "selectable"],
                ],
            },
        ]);
        const [group] = groupDiscoverySourceClaims(classifyDiscoverySources(EMPTY_WATCHED, forward), forward);
        expect(group).toMatchObject({
            primaryClaim: {
                claimKind: "native",
                source: { key: "fresh:claude-result:claude-root" },
            },
            readableSourceKeys: ["fresh:claude-result:claude-root", "fresh:opencode-result:opencode-compat"],
            reviewSourceKeys: ["fresh:claude-result:claude-root"],
            watchSourceKey: "fresh:claude-result:claude-root",
        });
        expect(defaultDiscoveryReadSourceKeys(group === undefined ? [] : [group])).toEqual(["fresh:claude-result:claude-root"]);
        const mixedPrior: WatchedScanIntentView = {
            ...EMPTY_WATCHED,
            revision: 1,
            environments: [
                {
                    environment: ENVIRONMENT,
                    sourceSelectors: [
                        {
                            disposition: "included",
                            source: {
                                adapterId: "CLAUDECODE",
                                rootRole: "source",
                                sourceDomain: "agent_runtime_private",
                                canonicalPath: "/home/user/.claude",
                                locatorIdentities: [{ locatorKind: "runtime_known_rule", locatorKey: "claude-native" }],
                            },
                            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                            binding: { assetScope: "global" },
                            selectorFingerprint: "1".repeat(64),
                        },
                        {
                            disposition: "excluded",
                            source: {
                                adapterId: "OPENCODE",
                                rootRole: "source",
                                sourceDomain: "family_shared",
                                canonicalPath: "/home/user/.claude",
                                locatorIdentities: [{ locatorKind: "runtime_known_rule", locatorKey: "opencode-compat" }],
                            },
                            agentRuntimeIds: ["OPENCODE_CLI"],
                            selectorFingerprint: "2".repeat(64),
                        },
                    ],
                },
            ],
        };
        const [mixedGroup] = groupDiscoverySourceClaims(classifyDiscoverySources(mixedPrior, forward), forward);
        expect(defaultDiscoveryReadSourceKeys(mixedGroup === undefined ? [] : [mixedGroup])).toEqual([
            "fresh:claude-result:claude-root",
        ]);
        const request = buildReadSourceRequest(
            forward,
            classifyDiscoverySources(EMPTY_WATCHED, forward),
            new Set(group?.reviewSourceKeys),
        );
        expect(request).toEqual({
            probeToken: "grouped",
            selections: [{ probeResultRowId: "claude-result", sourceRootRowIds: ["claude-root"] }],
        });
    });

    it("preselects one readable compatible-only path for Asset review", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const probe: ProbeReviewView = {
            probeToken: "compatible-only",
            results: [
                {
                    ...baseResult,
                    rowId: "compatible-result",
                    adapterId: "OPENCODE",
                    runtimes: [
                        {
                            ...baseRuntime,
                            agentRuntimeId: "OPENCODE_CLI",
                            sourceRootRowIds: ["compatible-root"],
                        },
                    ],
                    sources: [
                        {
                            ...probeSource("compatible-root", "compatible", "/home/user/.claude"),
                            sourceDomain: "family_shared",
                        },
                    ],
                },
            ],
        };
        const sources = classifyDiscoverySources(EMPTY_WATCHED, probe);
        const groups = groupDiscoverySourceClaims(sources, probe);

        expect(defaultDiscoveryReadSourceKeys(groups)).toEqual(["fresh:compatible-result:compatible-root"]);
        expect(defaultDiscoveryWatchSelections(sources)).toEqual([
            {
                sourceKey: "fresh:compatible-result:compatible-root",
                binding: { assetScope: "global" },
            },
        ]);
        expect(groups[0]?.reviewSourceKeys).toEqual(["fresh:compatible-result:compatible-root"]);
        expect(
            buildReadSourceRequest(probe, classifyDiscoverySources(EMPTY_WATCHED, probe), new Set(groups[0]?.reviewSourceKeys)),
        ).toEqual({
            probeToken: "compatible-only",
            selections: [{ probeResultRowId: "compatible-result", sourceRootRowIds: ["compatible-root"] }],
        });
    });

    it("preselects an exact Project source without silently assigning an unmatched Project to Global", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const projectPath = "/home/user/opencode-src";
        const probe: ProbeReviewView = {
            probeToken: "project-default",
            results: [
                {
                    ...baseResult,
                    rowId: "project-result",
                    adapterId: "OPENCODE",
                    runtimes: [{ ...baseRuntime, agentRuntimeId: "OPENCODE_CLI", sourceRootRowIds: ["project-root"] }],
                    sources: [
                        {
                            ...probeSource("project-root", "project-root", projectPath),
                            rootRole: "project_actual",
                            sourceDomain: "project_root",
                        },
                    ],
                },
            ],
        };
        const sources = classifyDiscoverySources(EMPTY_WATCHED, probe);
        const groups = groupDiscoverySourceClaims(sources, probe);

        expect(defaultDiscoveryReadSourceKeys(groups)).toEqual(["fresh:project-result:project-root"]);
        expect(defaultDiscoveryWatchSelections(sources)).toEqual([]);
        expect(
            defaultDiscoveryWatchSelections(sources, [
                {
                    projectId: "11111111-1111-4111-8111-111111111111",
                    displayName: "OpenCode source",
                    rootPath: projectPath,
                    deleted: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            ]),
        ).toEqual([
            {
                sourceKey: "fresh:project-result:project-root",
                binding: { assetScope: "project", projectId: "11111111-1111-4111-8111-111111111111" },
            },
        ]);

        const project = {
            projectId: "11111111-1111-4111-8111-111111111111",
            displayName: "OpenCode source",
            rootPath: projectPath,
            deleted: false,
            createdAt: 1,
            updatedAt: 1,
        };
        expect(
            reconcileDiscoveryWatchSelectionsForRegisteredProject(groups, groups[0]?.reviewSourceKeys ?? [], [], [], project),
        ).toEqual([
            {
                sourceKey: "fresh:project-result:project-root",
                binding: { assetScope: "project", projectId: project.projectId },
            },
        ]);
        const ignoredSelections: readonly [] = [];
        expect(reconcileDiscoveryWatchSelectionsForRegisteredProject(groups, [], ignoredSelections, [], project)).toBe(
            ignoredSelections,
        );
    });

    it("keeps exact Project evidence authoritative when two providers report the same physical Project root", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const projectPath = "/home/user/shared-project";
        const projectSource = (rowId: string) => ({
            ...probeSource(rowId, rowId, projectPath),
            rootRole: "project_actual" as const,
            sourceDomain: "project_root" as const,
        });
        const probe: ProbeReviewView = {
            probeToken: "shared-project-default",
            results: [
                {
                    ...baseResult,
                    rowId: "opencode-project",
                    adapterId: "OPENCODE",
                    runtimes: [{ ...baseRuntime, sourceRootRowIds: ["opencode-root"] }],
                    sources: [projectSource("opencode-root")],
                },
                {
                    ...baseResult,
                    rowId: "zcode-project",
                    adapterId: "ZCODE",
                    runtimes: [{ ...baseRuntime, sourceRootRowIds: ["zcode-root"] }],
                    sources: [projectSource("zcode-root")],
                },
            ],
        };
        const sources = classifyDiscoverySources(EMPTY_WATCHED, probe);
        const projectId = "22222222-2222-4222-8222-222222222222";

        expect(defaultDiscoveryWatchSelections(sources)).toEqual([]);
        expect(
            defaultDiscoveryWatchSelections(sources, [
                {
                    projectId,
                    displayName: "Shared Project",
                    rootPath: projectPath,
                    deleted: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            ]),
        ).toEqual([
            {
                sourceKey: "fresh:opencode-project:opencode-root",
                binding: { assetScope: "project", projectId },
            },
        ]);
    });

    it("does not treat an unavailable native claim as permission to preselect a compatible parser", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const watched: WatchedScanIntentView = {
            ...EMPTY_WATCHED,
            revision: 1,
            environments: [
                {
                    environment: ENVIRONMENT,
                    sourceSelectors: [
                        {
                            disposition: "included",
                            source: {
                                adapterId: "CLAUDECODE",
                                rootRole: "source",
                                sourceDomain: "agent_runtime_private",
                                canonicalPath: "/home/user/.claude",
                                locatorIdentities: [{ locatorKind: "runtime_known_rule", locatorKey: "claude-native" }],
                            },
                            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                            binding: { assetScope: "global" },
                            selectorFingerprint: "f".repeat(64),
                        },
                    ],
                },
            ],
        };
        const probe: ProbeReviewView = {
            probeToken: "native-unavailable",
            results: [
                {
                    ...baseResult,
                    rowId: "native-result",
                    adapterId: "CLAUDECODE",
                    runtimes: [{ ...baseRuntime, sourceRootRowIds: ["native-root"] }],
                    sources: [
                        {
                            ...probeSource("native-root", "claude-native", "/home/user/.claude", "not_found"),
                            sourceDomain: "agent_runtime_private",
                        },
                    ],
                },
                {
                    ...baseResult,
                    rowId: "compatible-result",
                    adapterId: "OPENCODE",
                    runtimes: [
                        {
                            ...baseRuntime,
                            agentRuntimeId: "OPENCODE_CLI",
                            sourceRootRowIds: ["compatible-root"],
                        },
                    ],
                    sources: [
                        {
                            ...probeSource("compatible-root", "opencode-compatible", "/home/user/.claude"),
                            sourceDomain: "family_shared",
                        },
                    ],
                },
            ],
        };
        const groups = groupDiscoverySourceClaims(classifyDiscoverySources(watched, probe), probe);

        expect(groups[0]?.claims.map((claim) => [claim.claimKind, claim.source.readSelection.status])).toEqual([
            ["native", "unavailable"],
            ["compatible_shared", "selectable"],
        ]);
        expect(groups[0]).toMatchObject({ status: "new", priorDisplayPath: "" });
        expect(defaultDiscoveryReadSourceKeys(groups)).toEqual([]);
        expect(groups[0]?.reviewSourceKeys).toEqual(["fresh:compatible-result:compatible-root"]);
    });

    it("marks competing private claims as ambiguous instead of choosing an owner", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const probe: ProbeReviewView = {
            probeToken: "ambiguous",
            results: [
                {
                    ...baseResult,
                    rowId: "a",
                    adapterId: "A",
                    sources: [
                        {
                            ...probeSource("first", "first", "/shared/private"),
                            sourceDomain: "agent_runtime_private" as const,
                        },
                    ],
                    runtimes: [{ ...baseRuntime, sourceRootRowIds: ["first"] }],
                },
                {
                    ...baseResult,
                    rowId: "b",
                    adapterId: "B",
                    sources: [
                        {
                            ...probeSource("second", "second", "/shared/private"),
                            sourceDomain: "agent_runtime_private" as const,
                        },
                    ],
                    runtimes: [{ ...baseRuntime, sourceRootRowIds: ["second"] }],
                },
            ],
        };

        expect(
            groupDiscoverySourceClaims(classifyDiscoverySources(EMPTY_WATCHED, probe), probe)[0]?.claims.map(
                (claim) => claim.claimKind,
            ),
        ).toEqual(["ambiguous_private", "ambiguous_private"]);
        expect(groupDiscoverySourceClaims(classifyDiscoverySources(EMPTY_WATCHED, probe), probe)[0]?.reviewSourceKeys).toEqual([
            "fresh:a:first",
            "fresh:b:second",
        ]);
    });

    it("keeps competing private parsers fail-closed even when the same path also has a compatible claim", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const privateResult = (rowId: string, adapterId: string, sourceRowId: string) => ({
            ...baseResult,
            rowId,
            adapterId,
            sources: [
                {
                    ...probeSource(sourceRowId, sourceRowId, "/shared/private"),
                    sourceDomain: "agent_runtime_private" as const,
                },
            ],
            runtimes: [{ ...baseRuntime, sourceRootRowIds: [sourceRowId] }],
        });
        const compatibleResult = {
            ...baseResult,
            rowId: "compatible",
            adapterId: "COMPATIBLE",
            sources: [
                {
                    ...probeSource("compatible-root", "compatible-root", "/shared/private"),
                    sourceDomain: "family_shared" as const,
                },
            ],
            runtimes: [{ ...baseRuntime, sourceRootRowIds: ["compatible-root"] }],
        };
        const probe: ProbeReviewView = {
            probeToken: "ambiguous-with-compatible",
            results: [privateResult("a", "A", "first"), compatibleResult, privateResult("b", "B", "second")],
        };

        expect(groupDiscoverySourceClaims(classifyDiscoverySources(EMPTY_WATCHED, probe), probe)[0]?.reviewSourceKeys).toEqual([
            "fresh:a:first",
            "fresh:b:second",
        ]);
    });

    it("builds one exact read request from selected fresh source rows and ignores unavailable rows", () => {
        const sources = classifyDiscoverySources(EMPTY_WATCHED, PROBE);
        const selectedKeys = new Set(sources.map((source) => source.key));

        expect(buildReadSourceRequest(PROBE, sources, selectedKeys)).toEqual({
            probeToken: "probe-token",
            selections: [
                {
                    probeResultRowId: "result-1",
                    sourceRootRowIds: ["source-moved", "source-new"],
                },
            ],
        });
        expect(buildReadSourceRequest(PROBE, sources, new Set())).toBeUndefined();
    });
});
