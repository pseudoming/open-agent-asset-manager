import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    getWatchedScanIntentAuthority,
    listSettingsAuthorities,
    setGenericSettingAuthority,
    setWatchedScanIntentAuthority,
    unsetGenericSettingAuthority,
} from "../../src/catalog/settings-authority";
import {
    buildWatchedScanIntentAuthority,
    buildWatchedSourceSelector,
    canonicalWatchedEnvironments,
    canonicalWatchedSourceIdentity,
    validateStoredWatchedScanIntent,
    virginWatchedScanIntentAuthority,
    WATCHED_SCAN_INTENT_KEY,
} from "../../src/catalog/watched-scan-intent-setting";
import type {
    AdapterId,
    AgentRuntimeId,
    Platform,
    WatchedEnvironmentIntentV1,
    WatchedEnvironmentSelectorV1,
    WatchedScanIntentV1,
    WatchedSourceIdentityV1,
} from "../../src/types";

const ENVIRONMENT: WatchedEnvironmentSelectorV1 = { platform: "linux", platformInstanceId: "local" };
const RUNTIME = "WATCHED_CLI" as AgentRuntimeId;
const ADAPTER = "WATCHED" as AdapterId;

function source(overrides: Partial<WatchedSourceIdentityV1> = {}): WatchedSourceIdentityV1 {
    return {
        adapterId: ADAPTER,
        rootRole: "source",
        sourceDomain: "agent_runtime_private",
        canonicalPath: "/home/user/.watched",
        locatorIdentities: [{ locatorKind: "runtime_known_rule", locatorKey: "default" }],
        ...overrides,
    };
}

function environmentIntent(): WatchedEnvironmentIntentV1 {
    return {
        environment: ENVIRONMENT,
        sourceSelectors: [
            buildWatchedSourceSelector(
                {
                    disposition: "included",
                    source: source(),
                    agentRuntimeIds: [RUNTIME],
                    binding: { assetScope: "global" },
                },
                ENVIRONMENT,
            ),
        ],
    };
}

describe("watched-scan settings authority", () => {
    let parent = "";
    let oaamRoot = "";

    beforeEach(() => {
        parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-watched-intent-"));
        oaamRoot = path.join(parent, ".oaam");
    });

    afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

    it("derives a deterministic virgin authority and persists canonical revisions without losing opaque settings", () => {
        expect(getWatchedScanIntentAuthority(oaamRoot)).toEqual(virginWatchedScanIntentAuthority());
        expect(fs.existsSync(path.join(oaamRoot, "settings.json"))).toBe(false);
        setGenericSettingAuthority(oaamRoot, "client.future", { configVersion: 2, value: "kept" });
        const virgin = getWatchedScanIntentAuthority(oaamRoot);
        const stored = setWatchedScanIntentAuthority({
            oaamRoot,
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            environments: [environmentIntent()],
            userActionEvidenceId: "watch-source",
            changedAt: 10,
        });
        expect(stored).toMatchObject({
            revision: 1,
            environments: [environmentIntent()],
            userActionEvidenceId: "watch-source",
            updatedAt: 10,
        });
        expect(getWatchedScanIntentAuthority(oaamRoot)).toEqual(stored);
        expect(listSettingsAuthorities(oaamRoot)["client.future"]).toEqual({ configVersion: 2, value: "kept" });

        const reset = setWatchedScanIntentAuthority({
            oaamRoot,
            expectedRevision: stored.revision,
            expectedSettingFingerprint: stored.settingFingerprint,
            environments: [],
            userActionEvidenceId: "reset",
            changedAt: 11,
        });
        expect(reset).toMatchObject({ revision: 2, environments: [], userActionEvidenceId: "reset" });
    });

    it("canonicalizes environment, runtime, selector, and locator order while binding fingerprints to the environment", () => {
        const secondEnvironment = { platform: "wsl" as const, platformInstanceId: "distro" };
        const first = environmentIntent();
        const second: WatchedEnvironmentIntentV1 = {
            environment: secondEnvironment,
            sourceSelectors: [
                buildWatchedSourceSelector(
                    {
                        disposition: "excluded",
                        source: source({
                            canonicalPath: "/mnt/c/source",
                            locatorIdentities: [
                                { locatorKind: "runtime_declared_path", locatorKey: "z" },
                                { locatorKind: "runtime_known_rule", locatorKey: "a" },
                            ],
                        }),
                        agentRuntimeIds: ["Z_RUNTIME", "A_RUNTIME"] as AgentRuntimeId[],
                    },
                    secondEnvironment,
                ),
            ],
        };
        const canonical = canonicalWatchedEnvironments([second, first]);
        expect(canonical.map((value) => value.environment.platform)).toEqual(["linux", "wsl"]);
        expect(canonical[1]?.sourceSelectors[0]?.agentRuntimeIds).toEqual(["A_RUNTIME", "Z_RUNTIME"]);
        expect(canonical[1]?.sourceSelectors[0]?.source.locatorIdentities).toEqual([
            { locatorKind: "runtime_declared_path", locatorKey: "z" },
            { locatorKind: "runtime_known_rule", locatorKey: "a" },
        ]);
        expect(
            buildWatchedSourceSelector({ disposition: "excluded", source: source(), agentRuntimeIds: [RUNTIME] }, ENVIRONMENT)
                .selectorFingerprint,
        ).not.toBe(
            buildWatchedSourceSelector(
                { disposition: "excluded", source: source(), agentRuntimeIds: [RUNTIME] },
                { ...ENVIRONMENT, platformInstanceId: "other" },
            ).selectorFingerprint,
        );
    });

    it("rejects stale CAS, malformed mutation headers, and generic access to the reserved key", () => {
        const virgin = getWatchedScanIntentAuthority(oaamRoot);
        for (const attempt of [
            { expectedRevision: -1, expectedSettingFingerprint: virgin.settingFingerprint, changedAt: 1 },
            { expectedRevision: 0, expectedSettingFingerprint: "bad", changedAt: 1 },
            { expectedRevision: 1, expectedSettingFingerprint: virgin.settingFingerprint, changedAt: 1 },
        ]) {
            expect(() =>
                setWatchedScanIntentAuthority({
                    oaamRoot,
                    expectedRevision: attempt.expectedRevision,
                    expectedSettingFingerprint: attempt.expectedSettingFingerprint as never,
                    environments: [],
                    userActionEvidenceId: "attempt",
                    changedAt: attempt.changedAt,
                }),
            ).toThrow();
        }
        expect(() =>
            setWatchedScanIntentAuthority({
                oaamRoot,
                expectedRevision: 0,
                expectedSettingFingerprint: virgin.settingFingerprint,
                environments: [],
                userActionEvidenceId: " ",
                changedAt: 1,
            }),
        ).toThrow(/non-blank/);
        expect(() =>
            setWatchedScanIntentAuthority({
                oaamRoot,
                expectedRevision: 0,
                expectedSettingFingerprint: virgin.settingFingerprint,
                environments: [],
                userActionEvidenceId: "bad-time",
                changedAt: 0,
            }),
        ).toThrow(/positive/);
        expect(() => setGenericSettingAuthority(oaamRoot, WATCHED_SCAN_INTENT_KEY, { configVersion: 1 })).toThrow(/reserved/);
        expect(() => unsetGenericSettingAuthority(oaamRoot, WATCHED_SCAN_INTENT_KEY)).toThrow(/reserved/);
    });

    it("rejects malformed stored authorities, selector identities, and noncanonical collections", () => {
        const valid = buildWatchedScanIntentAuthority({
            currentRevision: 0,
            environments: [environmentIntent()],
            userActionEvidenceId: "valid",
            updatedAt: 1,
        });
        const mutations: unknown[] = [
            null,
            { ...valid, extra: true },
            { ...valid, configVersion: 2 },
            { ...valid, revision: 0 },
            { ...valid, environments: {} },
            { ...valid, userActionEvidenceId: " " },
            { ...valid, updatedAt: 0 },
            { ...valid, settingFingerprint: "bad" },
            { ...valid, environments: [...valid.environments, ...valid.environments] },
            {
                ...valid,
                environments: [
                    {
                        ...valid.environments[0]!,
                        sourceSelectors: [
                            {
                                ...valid.environments[0]!.sourceSelectors[0]!,
                                agentRuntimeIds: [RUNTIME, RUNTIME],
                            },
                        ],
                    },
                ],
            },
        ];
        for (const mutation of mutations) {
            expect(() => validateStoredWatchedScanIntent(mutation as never)).toThrow();
        }
        expect(() => canonicalWatchedEnvironments([environmentIntent(), environmentIntent()])).toThrow(/unique/);
        expect(() => canonicalWatchedSourceIdentity(source({ adapterId: "" as AdapterId }))).toThrow(/non-blank/);
        expect(() =>
            canonicalWatchedSourceIdentity(
                source({
                    locatorIdentities: [
                        { locatorKind: "runtime_known_rule", locatorKey: "same" },
                        { locatorKind: "runtime_known_rule", locatorKey: "same" },
                    ],
                }),
            ),
        ).toThrow(/unique/);
    });

    it("rejects invalid selector branches, bindings, paths, unknown included facts, and invalid platform grammar", () => {
        const invalidSources: Array<() => unknown> = [
            () =>
                buildWatchedSourceSelector(
                    {
                        disposition: "excluded",
                        source: source({ canonicalPath: "relative" }),
                        agentRuntimeIds: [RUNTIME],
                    },
                    ENVIRONMENT,
                ),
            () =>
                buildWatchedSourceSelector(
                    {
                        disposition: "included",
                        source: source({ rootRole: "unknown" }),
                        agentRuntimeIds: [RUNTIME],
                        binding: { assetScope: "global" },
                    },
                    ENVIRONMENT,
                ),
            () =>
                buildWatchedSourceSelector(
                    {
                        disposition: "included",
                        source: source({
                            locatorIdentities: [{ locatorKind: "unknown", locatorKey: "unknown" }],
                        }),
                        agentRuntimeIds: [RUNTIME],
                        binding: { assetScope: "global" },
                    },
                    ENVIRONMENT,
                ),
            () =>
                buildWatchedSourceSelector(
                    {
                        disposition: "included",
                        source: source(),
                        agentRuntimeIds: [RUNTIME],
                        binding: { assetScope: "project", projectId: "bad" as never },
                    },
                    ENVIRONMENT,
                ),
            () =>
                canonicalWatchedEnvironments([
                    {
                        environment: { platform: "unknown" as Platform, platformInstanceId: "local" },
                        sourceSelectors: environmentIntent().sourceSelectors,
                    },
                ]),
        ];
        for (const invalid of invalidSources) expect(invalid).toThrow();

        const stored = buildWatchedScanIntentAuthority({
            currentRevision: 0,
            environments: [environmentIntent()],
            userActionEvidenceId: "valid",
            updatedAt: 1,
        }) as WatchedScanIntentV1 & Record<string, unknown>;
        const selector = structuredClone(stored.environments[0]!.sourceSelectors[0]!) as Record<string, unknown>;
        selector.selectorFingerprint = `sha256:${"0".repeat(64)}`;
        stored.environments = [{ ...stored.environments[0]!, sourceSelectors: [selector as never] }];
        expect(() => validateStoredWatchedScanIntent(stored as never)).toThrow(/fingerprint/);
    });

    it("rejects every malformed object boundary before it can become watched authority", () => {
        const valid = buildWatchedScanIntentAuthority({
            currentRevision: 0,
            environments: [environmentIntent()],
            userActionEvidenceId: "valid",
            updatedAt: 1,
        });
        const validSelector = valid.environments[0]!.sourceSelectors[0]!;
        const secondEnvironment: WatchedEnvironmentIntentV1 = {
            environment: { platform: "wsl", platformInstanceId: "distro" },
            sourceSelectors: [
                buildWatchedSourceSelector(
                    {
                        disposition: "excluded",
                        source: source({ canonicalPath: "/mnt/c/source" }),
                        agentRuntimeIds: ["SECOND_CLI" as AgentRuntimeId],
                    },
                    { platform: "wsl", platformInstanceId: "distro" },
                ),
            ],
        };
        const twoEnvironments = buildWatchedScanIntentAuthority({
            currentRevision: 0,
            environments: [environmentIntent(), secondEnvironment],
            userActionEvidenceId: "two",
            updatedAt: 2,
        });

        for (const malformed of [
            { ...valid, settingId: "wrong" },
            { ...valid, revision: 1.5 },
            { ...valid, settingFingerprint: `sha256:${"0".repeat(64)}` },
            { ...twoEnvironments, environments: [...twoEnvironments.environments].reverse() },
        ]) {
            expect(() => validateStoredWatchedScanIntent(malformed as never)).toThrow();
        }

        for (const malformedSource of [
            null,
            { ...source(), extra: true },
            source({ locatorIdentities: [] }),
            source({ locatorIdentities: [{} as never] }),
        ]) {
            expect(() => canonicalWatchedSourceIdentity(malformedSource as never)).toThrow();
        }

        for (const malformedEnvironment of [
            null,
            { ...environmentIntent(), extra: true },
            { ...environmentIntent(), environment: null },
            { ...environmentIntent(), sourceSelectors: [] },
            { ...environmentIntent(), sourceSelectors: [validSelector, validSelector] },
            {
                ...environmentIntent(),
                sourceSelectors: [{ ...validSelector, agentRuntimeIds: [] }],
            },
            {
                ...environmentIntent(),
                sourceSelectors: [{ ...validSelector, agentRuntimeIds: null }],
            },
            {
                ...environmentIntent(),
                sourceSelectors: [{ ...validSelector, selectorFingerprint: "bad" }],
            },
            {
                ...environmentIntent(),
                sourceSelectors: [{ ...validSelector, extra: true }],
            },
        ]) {
            expect(() => canonicalWatchedEnvironments([malformedEnvironment as never])).toThrow();
        }

        expect(() => canonicalWatchedEnvironments(null as never)).toThrow();
        expect(() =>
            buildWatchedSourceSelector(
                {
                    disposition: "included",
                    source: source(),
                    agentRuntimeIds: [RUNTIME],
                    binding: null as never,
                },
                ENVIRONMENT,
            ),
        ).toThrow(/binding/);
        expect(() =>
            buildWatchedScanIntentAuthority({
                currentRevision: -1,
                environments: [],
                userActionEvidenceId: "invalid-revision",
                updatedAt: 1,
            }),
        ).toThrow(/revision/);
    });
});
