import { describe, expect, it } from "vitest";
import {
    buildWatchedScanDecisions,
    classifyDiscoverySources,
    defaultDiscoveryWatchSelections,
    type ProbeReviewView,
    type WatchedScanIntentView,
} from "../src/renderer/features/discovery/discovery-model";
import { ENVIRONMENT, PROBE, probeSource, required, WATCHED, watchedSelector } from "./discovery-test-fixtures";

describe("Desktop watched-source decision model", () => {
    it("defaults unambiguous native and family-shared locations to Global without duplicating one physical path", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const probe: ProbeReviewView = {
            probeToken: "default-policy",
            results: [
                {
                    ...baseResult,
                    rowId: "native",
                    adapterId: "CLAUDECODE",
                    runtimes: [{ ...baseRuntime, sourceRootRowIds: ["native-root"] }],
                    sources: [
                        {
                            ...probeSource("native-root", "native", "/home/user/.claude"),
                            sourceDomain: "agent_runtime_private",
                        },
                    ],
                },
                {
                    ...baseResult,
                    rowId: "compatible",
                    adapterId: "OPENCODE",
                    runtimes: [
                        {
                            ...baseRuntime,
                            agentRuntimeId: "OPENCODE_CLI",
                            sourceRootRowIds: ["compatible-root", "compatible-only"],
                        },
                    ],
                    sources: [
                        {
                            ...probeSource("compatible-root", "compatible", "/home/user/.claude"),
                            sourceDomain: "family_shared",
                        },
                        {
                            ...probeSource("compatible-only", "compatible-only", "/home/user/.other"),
                            sourceDomain: "family_shared",
                        },
                    ],
                },
            ],
        };
        const sources = classifyDiscoverySources({ ...WATCHED, environments: [] }, probe);

        expect(defaultDiscoveryWatchSelections(sources)).toEqual([
            {
                sourceKey: "fresh:native:native-root",
                binding: { assetScope: "global" },
            },
            {
                sourceKey: "fresh:compatible:compatible-only",
                binding: { assetScope: "global" },
            },
        ]);
    });

    it("defaults one physical family-shared location to Global when multiple Providers report it", () => {
        const baseResult = required(PROBE.results[0], "probe result");
        const baseRuntime = required(baseResult.runtimes[0], "probe runtime");
        const sharedPath = "/home/user/.agents/skills";
        const familyResult = (rowId: string, adapterId: string, agentRuntimeId: string) => ({
            ...baseResult,
            rowId,
            adapterId,
            runtimes: [{ ...baseRuntime, agentRuntimeId, sourceRootRowIds: [`${rowId}-root`] }],
            sources: [
                {
                    ...probeSource(`${rowId}-root`, `${rowId}-shared`, sharedPath),
                    sourceDomain: "family_shared" as const,
                },
            ],
        });
        const probe = {
            probeToken: "shared-family-default",
            results: [familyResult("codex", "CODEX", "CODEX_CLI"), familyResult("opencode", "OPENCODE", "OPENCODE_CLI")],
        } as ProbeReviewView;

        expect(defaultDiscoveryWatchSelections(classifyDiscoverySources({ ...WATCHED, environments: [] }, probe))).toEqual([
            {
                sourceKey: "fresh:codex:codex-root",
                binding: { assetScope: "global" },
            },
        ]);
    });

    it("builds exact watched-source decisions for retained, moved, excluded and newly included roots", () => {
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
                        {
                            disposition: "excluded",
                            source: {
                                adapterId: "CLAUDECODE",
                                rootRole: "source",
                                sourceDomain: "project_root",
                                canonicalPath: "/excluded",
                                locatorIdentities: [{ locatorKind: "runtime_known_rule", locatorKey: "excluded" }],
                            },
                            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                            selectorFingerprint: "3".repeat(64),
                        },
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
                            sourceRootRowIds: ["current", "moved", "excluded", "new"],
                        },
                    ],
                    sources: [
                        probeSource("current", "current", "/current"),
                        probeSource("moved", "moved", "/new"),
                        probeSource("excluded", "excluded", "/excluded"),
                        probeSource("new", "new", "/brand-new"),
                    ],
                },
            ],
        };
        const sources = classifyDiscoverySources(watched, probe);
        const defaults = defaultDiscoveryWatchSelections(sources);
        expect(defaults).toHaveLength(2);
        const newSource = required(
            sources.find((source) => source.status === "new"),
            "new source",
        );
        const movedSource = required(
            sources.find((source) => source.status === "moved"),
            "moved source",
        );
        const decisions = buildWatchedScanDecisions("probe-token", sources, [
            ...defaults,
            { sourceKey: newSource.key, binding: { assetScope: "project", projectId: "project-1" } },
        ]);

        expect(decisions).toEqual([
            { action: "retain_existing", selectorFingerprint: "1".repeat(64) },
            {
                action: "include_observed",
                probeToken: "probe-token",
                probeResultRowId: "result-1",
                sourceRootRowId: "moved",
                agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                binding: { assetScope: "global" },
            },
            { action: "retain_existing", selectorFingerprint: "3".repeat(64) },
            {
                action: "include_observed",
                probeToken: "probe-token",
                probeResultRowId: "result-1",
                sourceRootRowId: "new",
                agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                binding: { assetScope: "project", projectId: "project-1" },
            },
        ]);
        expect(buildWatchedScanDecisions("probe-token", sources, defaults)).not.toContainEqual(
            expect.objectContaining({ sourceRootRowId: "new" }),
        );
        expect(buildWatchedScanDecisions("probe-token", sources, defaults, [newSource.key])).toContainEqual({
            action: "exclude_observed",
            probeToken: "probe-token",
            probeResultRowId: "result-1",
            sourceRootRowId: "new",
            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
        });
        expect(() => buildWatchedScanDecisions("probe-token", sources, defaults, [newSource.key, newSource.key])).toThrow(
            "explicitly excluded watched source is duplicate",
        );
        expect(() =>
            buildWatchedScanDecisions("probe-token", sources, defaults, [required(defaults[0], "selected source").sourceKey]),
        ).toThrow("explicitly excluded watched source is stale, unavailable, or selected");
        expect(movedSource.watchAvailability).toMatchObject({ status: "selectable" });
        expect(() =>
            buildWatchedScanDecisions("probe-token", sources, [
                { sourceKey: newSource.key, binding: { assetScope: "global" } },
                { sourceKey: newSource.key, binding: { assetScope: "global" } },
            ]),
        ).toThrow("duplicate or stale");
        expect(() =>
            buildWatchedScanDecisions("probe-token", sources, [{ sourceKey: "stale-source", binding: { assetScope: "global" } }]),
        ).toThrow("duplicate or stale");

        const missingExcluded: WatchedScanIntentView = {
            ...WATCHED,
            environments: [
                {
                    environment: ENVIRONMENT,
                    sourceSelectors: [
                        {
                            disposition: "excluded",
                            source: {
                                adapterId: "CLAUDECODE",
                                rootRole: "source",
                                sourceDomain: "project_root",
                                canonicalPath: "/missing-excluded",
                                locatorIdentities: [{ locatorKind: "runtime_known_rule", locatorKey: "missing-excluded" }],
                            },
                            agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                            selectorFingerprint: "6".repeat(64),
                        },
                    ],
                },
            ],
        };
        const missingSources = classifyDiscoverySources(missingExcluded, {
            ...probe,
            results: [
                {
                    ...required(probe.results[0], "probe result"),
                    sources: [],
                    runtimes: [],
                },
            ],
        });
        expect(buildWatchedScanDecisions("probe-token", missingSources, [])).toEqual([
            { action: "retain_existing", selectorFingerprint: "6".repeat(64) },
        ]);
        expect(() =>
            buildWatchedScanDecisions("probe-token", missingSources, [
                { sourceKey: required(missingSources[0], "missing source").key, binding: { assetScope: "global" } },
            ]),
        ).toThrow("missing watched source cannot change binding");
    });
});
