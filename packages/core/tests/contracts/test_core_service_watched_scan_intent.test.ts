import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryAcquireAuthorityLocks } from "../../src/foundation/authority-locks";
import { clearRegistry, validateRegisteredProbeResult } from "../../src/orchestration/adapter-registry";
import { createCoreServiceForTest } from "../../src/orchestration/core-service";
import { closeDb } from "../../src/persistence/db";
import type { AdapterId, AgentRuntimeId, PlatformContext, ProbeResult, UuidV4 } from "../../src/types";
import {
    WATCHED_ADAPTER_ID as ADAPTER,
    availableWatchedProbe as availableProbe,
    WATCHED_LINUX_CONTEXT as LINUX,
    WATCHED_PROJECT_ID as PROJECT_ID,
    makeWatchedProvider as provider,
    WATCHED_RUNTIME_ID as RUNTIME,
} from "./fixtures/watched-scan-intent-fixture";

describe("CoreService watched-scan intent", () => {
    let parent = "";
    let oaamRoot = "";
    let databasePath = "";
    let projectRoot = "";
    let now = 100;

    beforeEach(() => {
        parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-core-watched-"));
        oaamRoot = path.join(parent, ".oaam");
        databasePath = path.join(parent, "state.db");
        projectRoot = path.join(parent, "project");
        fs.mkdirSync(projectRoot);
        now = 100;
        clearRegistry();
        closeDb();
    });

    afterEach(() => {
        closeDb();
        clearRegistry();
        fs.rmSync(parent, { recursive: true, force: true });
    });

    function core(selectedProvider = provider(), contexts: PlatformContext[] = [LINUX]) {
        return createCoreServiceForTest(
            {
                providers: [selectedProvider],
                platformContexts: contexts,
                oaamRoot,
                databasePath,
                now: () => (now += 1),
                newUuid: () => PROJECT_ID,
            },
            {},
        );
    }

    async function currentProbe(service: ReturnType<typeof core>): Promise<ProbeResult> {
        const enablement = service.getAdapterEnablement().value;
        expect(
            service.replaceAdapterEnablement({
                expectedRevision: enablement.revision,
                expectedSettingFingerprint: enablement.settingFingerprint,
                enabledAdapterIds: [ADAPTER],
                userActionId: "enable-for-probe",
            }).status,
        ).toBe("complete");
        const result = await service.probeAdapters({
            adapterIds: [ADAPTER],
            contexts: [LINUX],
            target: { authorizationScope: "global" },
        });
        expect(result.status).toBe("complete");
        return result.value[0]!;
    }

    it("builds included and excluded selectors only from an exact current probe and active Project binding", async () => {
        const service = core();
        const project = service.registerProject({ rootPath: projectRoot });
        expect(project.value.projectId).toBe(PROJECT_ID);
        const probe = await currentProbe(service);
        const virgin = service.getWatchedScanIntent().value;
        const stored = service.replaceWatchedScanIntent({
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            userActionId: "select-observed",
            currentProbeResults: [probe],
            decisions: [
                {
                    action: "include_observed",
                    sourceRef: {
                        adapterId: ADAPTER,
                        platformContext: LINUX,
                        sourceRootId: "watched-root",
                    },
                    agentRuntimeIds: [RUNTIME],
                    binding: { assetScope: "project", projectId: PROJECT_ID },
                },
            ],
        });
        expect(stored.status).toBe("complete");
        expect(stored.value.environments).toEqual([
            {
                environment: { platform: "linux", platformInstanceId: "local" },
                sourceSelectors: [
                    expect.objectContaining({
                        disposition: "included",
                        agentRuntimeIds: [RUNTIME],
                        source: expect.objectContaining({
                            adapterId: ADAPTER,
                            canonicalPath: "/home/user/.watched",
                            rootRole: "source",
                            sourceDomain: "agent_runtime_private",
                        }),
                        binding: { assetScope: "project", projectId: PROJECT_ID },
                    }),
                ],
            },
        ]);
        expect(stored.value.environments[0]?.sourceSelectors[0]?.selectorFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("retains an existing selector by its returned fingerprint and removes every omitted selector", async () => {
        const service = core();
        expect(service.registerProject({ rootPath: projectRoot }).status).toBe("complete");
        const probe = await currentProbe(service);
        const virgin = service.getWatchedScanIntent().value;
        const first = service.replaceWatchedScanIntent({
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            userActionId: "include-and-exclude",
            currentProbeResults: [probe],
            decisions: [
                {
                    action: "include_observed",
                    sourceRef: { adapterId: ADAPTER, platformContext: LINUX, sourceRootId: "watched-root" },
                    agentRuntimeIds: [RUNTIME],
                    binding: { assetScope: "global" },
                },
                {
                    action: "include_user_selected_root",
                    environment: { platform: "linux", platformInstanceId: "local" },
                    adapterId: ADAPTER,
                    agentRuntimeIds: [RUNTIME],
                    directoryRootPath: "/tmp/../tmp/user-root",
                    binding: { assetScope: "project", projectId: PROJECT_ID },
                },
            ],
        });
        expect(first.status).toBe("complete");
        const observedFingerprint = first.value.environments[0]!.sourceSelectors.find(
            (selector) => selector.source.canonicalPath === "/home/user/.watched",
        )!.selectorFingerprint;
        const retainedFingerprint = first.value.environments[0]!.sourceSelectors.find(
            (selector) => selector.source.canonicalPath === "/tmp/user-root",
        )!.selectorFingerprint;
        const both = service.replaceWatchedScanIntent({
            expectedRevision: first.value.revision,
            expectedSettingFingerprint: first.value.settingFingerprint,
            userActionId: "retain-both",
            currentProbeResults: [],
            decisions: [
                { action: "retain_existing", selectorFingerprint: observedFingerprint },
                { action: "retain_existing", selectorFingerprint: retainedFingerprint },
            ],
        });
        expect(both.status).toBe("complete");
        expect(both.value.environments[0]?.sourceSelectors).toHaveLength(2);
        const retained = service.replaceWatchedScanIntent({
            expectedRevision: both.value.revision,
            expectedSettingFingerprint: both.value.settingFingerprint,
            userActionId: "retain-one",
            currentProbeResults: [],
            decisions: [{ action: "retain_existing", selectorFingerprint: retainedFingerprint }],
        });
        expect(retained.status).toBe("complete");
        expect(retained.value.environments[0]?.sourceSelectors).toHaveLength(1);
        expect(retained.value.environments[0]?.sourceSelectors[0]?.selectorFingerprint).toBe(retainedFingerprint);
        expect(retained.value.environments[0]?.sourceSelectors[0]).toMatchObject({
            agentRuntimeIds: [RUNTIME],
            binding: { assetScope: "project", projectId: PROJECT_ID },
        });
    });

    it("records supported user-selected roots as external intent and reset writes the next empty revision", () => {
        const service = core();
        const virgin = service.getWatchedScanIntent().value;
        const stored = service.replaceWatchedScanIntent({
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            userActionId: "select-root",
            currentProbeResults: [],
            decisions: [
                {
                    action: "include_user_selected_root",
                    environment: { platform: "linux", platformInstanceId: "local" },
                    adapterId: ADAPTER,
                    agentRuntimeIds: [RUNTIME],
                    directoryRootPath: "/tmp/../tmp/selected",
                    binding: { assetScope: "global" },
                },
            ],
        });
        expect(stored.status).toBe("complete");
        expect(stored.value.environments[0]?.sourceSelectors[0]).toMatchObject({
            disposition: "included",
            agentRuntimeIds: [RUNTIME],
            source: {
                adapterId: ADAPTER,
                rootRole: "source",
                sourceDomain: "external_managed",
                canonicalPath: "/tmp/selected",
                locatorIdentities: [{ locatorKind: "user_provided_path", locatorKey: "user_selection" }],
            },
        });
        const reset = service.resetWatchedScanIntent({
            expectedRevision: stored.value.revision,
            expectedSettingFingerprint: stored.value.settingFingerprint,
            userActionId: "reset-watch",
        });
        expect(reset).toMatchObject({ status: "complete", value: { revision: 2, environments: [] } });
        expect(service.getWatchedScanIntent().value).toEqual(reset.value);
    });

    it("rejects stale, duplicate, foreign-runtime, and malformed observed references before changing settings", async () => {
        const service = core();
        const probe = await currentProbe(service);
        const virgin = service.getWatchedScanIntent().value;
        const base = {
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            userActionId: "invalid-observed",
            currentProbeResults: [probe],
        };
        const observed = {
            action: "exclude_observed" as const,
            sourceRef: { adapterId: ADAPTER, platformContext: LINUX, sourceRootId: "watched-root" },
            agentRuntimeIds: [RUNTIME],
        };
        for (const decisions of [
            [{ ...observed, sourceRef: { ...observed.sourceRef, sourceRootId: "missing" } }],
            [{ ...observed, agentRuntimeIds: ["FOREIGN_CLI" as AgentRuntimeId] }],
            [observed, observed],
        ]) {
            expect(service.replaceWatchedScanIntent({ ...base, decisions }).status).toBe("failed");
        }
        expect(
            service.replaceWatchedScanIntent({
                ...base,
                currentProbeResults: [probe, probe],
                decisions: [observed],
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_probe_duplicate");
        expect(service.getWatchedScanIntent().value).toEqual(virgin);
    });

    it("rejects unknown included source facts while allowing the user to persist an exclusion", async () => {
        const service = core(provider(availableProbe({ rootRole: "unknown", sourceDomain: "unknown" })));
        const probe = await currentProbe(service);
        const virgin = service.getWatchedScanIntent().value;
        const sourceRef = { adapterId: ADAPTER, platformContext: LINUX, sourceRootId: "watched-root" };
        expect(
            service.replaceWatchedScanIntent({
                expectedRevision: virgin.revision,
                expectedSettingFingerprint: virgin.settingFingerprint,
                userActionId: "include-unknown",
                currentProbeResults: [probe],
                decisions: [
                    {
                        action: "include_observed",
                        sourceRef,
                        agentRuntimeIds: [RUNTIME],
                        binding: { assetScope: "global" },
                    },
                ],
            }).status,
        ).toBe("failed");
        expect(
            service.replaceWatchedScanIntent({
                expectedRevision: virgin.revision,
                expectedSettingFingerprint: virgin.settingFingerprint,
                userActionId: "exclude-unknown",
                currentProbeResults: [probe],
                decisions: [{ action: "exclude_observed", sourceRef, agentRuntimeIds: [RUNTIME] }],
            }).status,
        ).toBe("complete");
    });

    it.each([false, true])("retains excluded observed Project roots when continuing with restore=%s", async (restore) => {
        const observed = availableProbe({
            rootRole: "project_actual",
            sourceDomain: "project_root",
            path: projectRoot,
            locatorEvidence: [
                { locatorKind: "user_provided_path", locatorKey: "probe_project_root", evidenceLevel: "user_provided" },
            ],
        });
        observed.observation.sourceRoots.push({
            ...observed.observation.sourceRoots[0]!,
            sourceRootId: "other-project-root",
            path: path.join(parent, "other-project"),
        });
        observed.observation.observedAgentRuntimes[0]!.sourceRootIds.push("other-project-root");
        const service = core(provider(observed, false));
        expect(service.registerProject({ rootPath: projectRoot }).status).toBe("complete");
        const probe = await currentProbe(service);
        const virgin = service.getWatchedScanIntent().value;
        const excluded = service.replaceWatchedScanIntent({
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            userActionId: "exclude-observed-projects",
            currentProbeResults: [probe],
            decisions: probe.observation.sourceRoots.map((root) => ({
                action: "exclude_observed",
                sourceRef: { adapterId: ADAPTER, platformContext: LINUX, sourceRootId: root.sourceRootId },
                agentRuntimeIds: [RUNTIME],
            })),
        });
        expect(excluded.status, JSON.stringify(excluded.diagnostics)).toBe("complete");
        const selectors = excluded.value.environments[0]!.sourceSelectors;
        const decisions = selectors.map((selector) =>
            restore && selector.source.canonicalPath === projectRoot
                ? {
                      action: "include_observed" as const,
                      sourceRef: { adapterId: ADAPTER, platformContext: LINUX, sourceRootId: "watched-root" },
                      agentRuntimeIds: [RUNTIME],
                      binding: { assetScope: "project" as const, projectId: PROJECT_ID },
                  }
                : { action: "retain_existing" as const, selectorFingerprint: selector.selectorFingerprint },
        );
        const continued = service.replaceWatchedScanIntent({
            expectedRevision: excluded.value.revision,
            expectedSettingFingerprint: excluded.value.settingFingerprint,
            userActionId: restore ? "restore-one-observed-project" : "continue-with-zero-selections",
            currentProbeResults: restore ? [probe] : [],
            decisions,
        });
        expect(continued.status, JSON.stringify(continued.diagnostics)).toBe("complete");
        const retained = continued.value.environments[0]!.sourceSelectors;
        expect(retained.filter((selector) => selector.disposition === "included")).toHaveLength(restore ? 1 : 0);
        const other = selectors.find((selector) => selector.source.canonicalPath !== projectRoot)!;
        expect(retained.find((selector) => selector.selectorFingerprint === other.selectorFingerprint)).toEqual(other);
        if (restore) {
            expect(retained.find((selector) => selector.disposition === "included")).toMatchObject({
                source: { rootRole: "project_actual", sourceDomain: "project_root", canonicalPath: projectRoot },
                binding: { assetScope: "project", projectId: PROJECT_ID },
            });
        }
    });

    it("still revalidates support when retaining a manually selected external source", () => {
        const service = core();
        const virgin = service.getWatchedScanIntent().value;
        const stored = service.replaceWatchedScanIntent({
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            userActionId: "select-external-root",
            currentProbeResults: [],
            decisions: [
                {
                    action: "include_user_selected_root",
                    environment: { platform: "linux", platformInstanceId: "local" },
                    adapterId: ADAPTER,
                    agentRuntimeIds: [RUNTIME],
                    directoryRootPath: "/tmp/selected",
                    binding: { assetScope: "global" },
                },
            ],
        });
        expect(stored.status).toBe("complete");
        closeDb();
        clearRegistry();
        const changed = core(provider(availableProbe(), false));
        const retained = changed.replaceWatchedScanIntent({
            expectedRevision: stored.value.revision,
            expectedSettingFingerprint: stored.value.settingFingerprint,
            userActionId: "retain-external-root-after-support-change",
            currentProbeResults: [],
            decisions: [
                {
                    action: "retain_existing",
                    selectorFingerprint: stored.value.environments[0]!.sourceSelectors[0]!.selectorFingerprint,
                },
            ],
        });
        expect(retained.diagnostics[0]?.code).toBe("settings.watched_scan_user_root_unsupported");
        expect(changed.getWatchedScanIntent().value).toEqual(stored.value);
    });

    it("rejects unsupported, out-of-environment, unknown-environment, duplicate, and inactive-project user roots", () => {
        const unsupported = core(provider(availableProbe(), false));
        const virgin = unsupported.getWatchedScanIntent().value;
        const decision = {
            action: "include_user_selected_root" as const,
            environment: { platform: "linux" as const, platformInstanceId: "local" },
            adapterId: ADAPTER,
            agentRuntimeIds: [RUNTIME],
            directoryRootPath: "/tmp/root",
            binding: { assetScope: "global" as const },
        };
        expect(
            unsupported.replaceWatchedScanIntent({
                expectedRevision: virgin.revision,
                expectedSettingFingerprint: virgin.settingFingerprint,
                userActionId: "unsupported",
                currentProbeResults: [],
                decisions: [decision],
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_user_root_unsupported");

        clearRegistry();
        closeDb();
        const narrowed = core(provider(), [{ ...LINUX, accessRootPath: "/home" }]);
        const narrowedVirgin = narrowed.getWatchedScanIntent().value;
        for (const changed of [
            { ...decision, directoryRootPath: "/tmp/outside" },
            { ...decision, environment: { ...decision.environment, platformInstanceId: "missing" } },
            { ...decision, agentRuntimeIds: ["FOREIGN_CLI" as AgentRuntimeId] },
        ]) {
            expect(
                narrowed.replaceWatchedScanIntent({
                    expectedRevision: narrowedVirgin.revision,
                    expectedSettingFingerprint: narrowedVirgin.settingFingerprint,
                    userActionId: "invalid-user-root",
                    currentProbeResults: [],
                    decisions: [changed],
                }).status,
            ).toBe("failed");
        }

        const project = narrowed.registerProject({ rootPath: projectRoot });
        const stopReview = narrowed.inspectProjectLifecycle({
            action: "stop_managing",
            projectId: project.value.projectId,
        });
        expect(stopReview.status).toBe("complete");
        expect(
            narrowed.commitProjectLifecycle({
                preparation: stopReview.value,
                userActionId: "stop-managing-project",
            }).status,
        ).toBe("complete");
        expect(
            narrowed.replaceWatchedScanIntent({
                expectedRevision: narrowedVirgin.revision,
                expectedSettingFingerprint: narrowedVirgin.settingFingerprint,
                userActionId: "deleted-project",
                currentProbeResults: [],
                decisions: [
                    {
                        ...decision,
                        directoryRootPath: "/home/user/root",
                        binding: { assetScope: "project", projectId: PROJECT_ID },
                    },
                ],
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_project_inactive");
    });

    it("rejects stale CAS, missing retained fingerprints, invalid request shapes, and ambiguous configured environments", () => {
        const service = core();
        const virgin = service.getWatchedScanIntent().value;
        expect(
            service.replaceWatchedScanIntent({
                expectedRevision: 1,
                expectedSettingFingerprint: virgin.settingFingerprint,
                userActionId: "stale",
                currentProbeResults: [],
                decisions: [],
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_cas_mismatch");
        expect(
            service.replaceWatchedScanIntent({
                expectedRevision: virgin.revision,
                expectedSettingFingerprint: virgin.settingFingerprint,
                userActionId: "missing-retain",
                currentProbeResults: [],
                decisions: [{ action: "retain_existing", selectorFingerprint: `sha256:${"1".repeat(64)}` }],
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_retain_missing");
        expect(
            service.replaceWatchedScanIntent({
                expectedRevision: virgin.revision,
                expectedSettingFingerprint: virgin.settingFingerprint,
                userActionId: " ",
                currentProbeResults: [],
                decisions: [],
            }).status,
        ).toBe("failed");
        expect(() =>
            core(provider(), [
                LINUX,
                {
                    ...LINUX,
                    accessRootPath: "/home",
                },
            ]),
        ).toThrow(/unique/);
    });

    it("rejects malformed request, decision, source-reference, binding, and header boundaries", () => {
        const service = core();
        const virgin = service.getWatchedScanIntent().value;
        const validHeader = {
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            userActionId: "malformed-boundary",
            currentProbeResults: [],
            decisions: [],
        };
        const observed = {
            action: "exclude_observed",
            sourceRef: { adapterId: ADAPTER, platformContext: LINUX, sourceRootId: "watched-root" },
            agentRuntimeIds: [RUNTIME],
        };
        const userRoot = {
            action: "include_user_selected_root",
            environment: { platform: "linux", platformInstanceId: "local" },
            adapterId: ADAPTER,
            agentRuntimeIds: [RUNTIME],
            directoryRootPath: "/tmp/root",
            binding: { assetScope: "global" },
        };
        const attempts: unknown[] = [
            null,
            { ...validHeader, extra: true },
            { ...validHeader, currentProbeResults: null },
            { ...validHeader, decisions: [null] },
            {
                ...validHeader,
                decisions: [{ action: "retain_existing", selectorFingerprint: "bad" }],
            },
            { ...validHeader, decisions: [{ ...observed, extra: true }] },
            { ...validHeader, decisions: [{ ...userRoot, extra: true }] },
            { ...validHeader, decisions: [{ action: "future_action" }] },
            { ...validHeader, decisions: [{ ...observed, sourceRef: null }] },
            {
                ...validHeader,
                decisions: [{ ...observed, sourceRef: { ...observed.sourceRef, extra: true } }],
            },
            {
                ...validHeader,
                decisions: [{ ...observed, sourceRef: { ...observed.sourceRef, platformContext: null } }],
            },
            {
                ...validHeader,
                decisions: [
                    {
                        ...observed,
                        sourceRef: {
                            ...observed.sourceRef,
                            platformContext: { ...LINUX, extra: true },
                        },
                    },
                ],
            },
            {
                ...validHeader,
                decisions: [
                    {
                        ...observed,
                        sourceRef: {
                            ...observed.sourceRef,
                            platformContext: {
                                platform: "wsl",
                                platformInstanceId: "distro",
                                accessRootPath: "/",
                            },
                        },
                    },
                ],
            },
            {
                ...validHeader,
                decisions: [
                    {
                        ...observed,
                        sourceRef: {
                            ...observed.sourceRef,
                            platformContext: { ...LINUX, accessRootPath: "relative" },
                        },
                    },
                ],
            },
            { ...validHeader, decisions: [{ ...observed, agentRuntimeIds: null }] },
            { ...validHeader, decisions: [{ ...observed, agentRuntimeIds: [RUNTIME, RUNTIME] }] },
            {
                ...validHeader,
                decisions: [
                    {
                        ...observed,
                        action: "include_observed",
                        binding: null,
                    },
                ],
            },
            {
                ...validHeader,
                decisions: [
                    {
                        ...observed,
                        action: "include_observed",
                        binding: { assetScope: "future" },
                    },
                ],
            },
            { ...validHeader, expectedRevision: -1 },
            { ...validHeader, expectedSettingFingerprint: "bad" },
        ];
        for (const attempt of attempts) {
            expect(service.replaceWatchedScanIntent(attempt as never).status).toBe("failed");
        }
        expect(
            service.resetWatchedScanIntent({
                expectedRevision: virgin.revision,
                expectedSettingFingerprint: virgin.settingFingerprint,
                userActionId: "reset",
                extra: true,
            } as never).status,
        ).toBe("failed");
        const stringFailure = {
            ...validHeader,
            get expectedRevision() {
                throw "string failure";
            },
        };
        expect(service.replaceWatchedScanIntent(stringFailure as never).diagnostics[0]?.message).toBe("string failure");
        expect(
            service.resetWatchedScanIntent({
                expectedRevision: -1,
                expectedSettingFingerprint: virgin.settingFingerprint,
                userActionId: "reset",
            }).status,
        ).toBe("failed");
    });

    it("revalidates current probe snapshots and rejects stale, malformed, and unregistered evidence", async () => {
        const service = core();
        const probe = await currentProbe(service);
        const virgin = service.getWatchedScanIntent().value;
        const observed = {
            action: "exclude_observed" as const,
            sourceRef: { adapterId: ADAPTER, platformContext: LINUX, sourceRootId: "watched-root" },
            agentRuntimeIds: [RUNTIME],
        };
        const request = {
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            userActionId: "probe-boundary",
            decisions: [observed],
        };

        expect(
            service.replaceWatchedScanIntent({
                ...request,
                currentProbeResults: [],
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_source_ref_stale");
        expect(
            service.replaceWatchedScanIntent({
                ...request,
                currentProbeResults: [null as never],
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_probe_invalid");

        const contractInvalid = structuredClone(probe);
        contractInvalid.observation.observedAgentRuntimes[0]!.agentRuntimeId = "FOREIGN_CLI" as AgentRuntimeId;
        expect(
            service.replaceWatchedScanIntent({
                ...request,
                currentProbeResults: [contractInvalid],
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_probe_invalid");

        const malformedContext = structuredClone(probe) as ProbeResult & {
            observation: { platformContext: PlatformContext & { extra?: boolean } };
        };
        malformedContext.observation.platformContext.extra = true;
        expect(
            service.replaceWatchedScanIntent({
                ...request,
                currentProbeResults: [malformedContext],
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_environment_invalid");

        const unknownContext = structuredClone(probe);
        unknownContext.observation.platformContext.accessRootPath = "/home";
        expect(
            service.replaceWatchedScanIntent({
                ...request,
                currentProbeResults: [unknownContext],
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_environment_unknown");

        expect(
            service.replaceWatchedScanIntent({
                ...request,
                currentProbeResults: [],
                decisions: [
                    {
                        action: "include_user_selected_root",
                        environment: { platform: "linux", platformInstanceId: "local" },
                        adapterId: "UNREGISTERED" as AdapterId,
                        agentRuntimeIds: [RUNTIME],
                        directoryRootPath: "/tmp/root",
                        binding: { assetScope: "global" },
                    },
                ],
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_adapter_unknown");

        const unknownProviderProbe = structuredClone(probe);
        unknownProviderProbe.observation.adapterId = "UNREGISTERED" as AdapterId;
        expect(validateRegisteredProbeResult(unknownProviderProbe)[0]?.code).toBe("probe.adapter_not_registered");
    });

    it("validates POSIX and win32 user-root grammar against the selected environment boundary", () => {
        const service = core();
        const virgin = service.getWatchedScanIntent().value;
        const base = {
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            userActionId: "path-boundary",
            currentProbeResults: [],
        };
        const decision = {
            action: "include_user_selected_root" as const,
            environment: { platform: "linux" as const, platformInstanceId: "local" },
            adapterId: ADAPTER,
            agentRuntimeIds: [RUNTIME],
            directoryRootPath: "/",
            binding: { assetScope: "global" as const },
        };
        expect(service.replaceWatchedScanIntent({ ...base, decisions: [decision] }).status).toBe("complete");

        clearRegistry();
        closeDb();
        const windows = { platform: "win32" as const, platformInstanceId: "windows", accessRootPath: "C:\\" };
        const windowsService = core(provider(availableProbe(), true, "auto_read"), [windows]);
        const windowsVirgin = windowsService.getWatchedScanIntent().value;
        const windowsBase = {
            expectedRevision: windowsVirgin.revision,
            expectedSettingFingerprint: windowsVirgin.settingFingerprint,
            userActionId: "win-path-boundary",
            currentProbeResults: [],
        };
        const windowsDecision = {
            action: "include_user_selected_root" as const,
            environment: { platform: "win32" as const, platformInstanceId: "windows" },
            adapterId: ADAPTER,
            agentRuntimeIds: [RUNTIME],
            directoryRootPath: "C:\\Users\\person",
            binding: { assetScope: "global" as const },
        };
        for (const directoryRootPath of [null, "", "C:\\bad\0root", "relative"] as unknown[]) {
            expect(
                windowsService.replaceWatchedScanIntent({
                    ...windowsBase,
                    decisions: [{ ...windowsDecision, directoryRootPath }],
                } as never).diagnostics[0]?.code,
            ).toBe("settings.watched_scan_user_root_invalid");
        }
        expect(
            windowsService.replaceWatchedScanIntent({
                ...windowsBase,
                decisions: [{ ...windowsDecision, environment: null }],
            } as never).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_environment_invalid");
        expect(windowsService.replaceWatchedScanIntent({ ...windowsBase, decisions: [windowsDecision] }).status).toBe("complete");

        clearRegistry();
        closeDb();
        oaamRoot = path.join(parent, ".oaam-wsl");
        databasePath = path.join(parent, "wsl-state.db");
        const windowsHostedWsl = {
            platform: "wsl" as const,
            platformInstanceId: "Ubuntu",
            accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example",
        };
        const wslService = core(provider(availableProbe(), true, "auto_read"), [windowsHostedWsl]);
        const wslVirgin = wslService.getWatchedScanIntent().value;
        const wslBase = {
            expectedRevision: wslVirgin.revision,
            expectedSettingFingerprint: wslVirgin.settingFingerprint,
            userActionId: "wsl-unc-path-boundary",
            currentProbeResults: [],
        };
        const wslDecision = {
            action: "include_user_selected_root" as const,
            environment: { platform: "wsl" as const, platformInstanceId: "Ubuntu" },
            adapterId: ADAPTER,
            agentRuntimeIds: [RUNTIME],
            directoryRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example\\project",
            binding: { assetScope: "global" as const },
        };
        expect(
            wslService.replaceWatchedScanIntent({
                ...wslBase,
                decisions: [{ ...wslDecision, directoryRootPath: "/home/example/project" }],
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_user_root_invalid");
        expect(
            wslService.replaceWatchedScanIntent({
                ...wslBase,
                decisions: [{ ...wslDecision, directoryRootPath: "\\\\wsl.localhost\\Debian\\home\\example" }],
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_user_root_outside_environment");
        expect(wslService.replaceWatchedScanIntent({ ...wslBase, decisions: [wslDecision] }).status).toBe("complete");
    });

    it("fails closed on settings locks, corrupt settings, mutation reservations, and missing Project bindings", () => {
        const service = core();
        const virgin = service.getWatchedScanIntent().value;
        const request = {
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            userActionId: "failure-boundary",
            currentProbeResults: [],
            decisions: [],
        };
        const locksRoot = path.join(oaamRoot, "transactions", "authority-locks");
        const release = tryAcquireAuthorityLocks(locksRoot, "settings", ["settings"]);
        expect(release).not.toBeNull();
        expect(service.getWatchedScanIntent().diagnostics[0]?.code).toBe("settings.watched_scan_locked");
        expect(service.replaceWatchedScanIntent(request).diagnostics[0]?.code).toBe("settings.watched_scan_locked");
        expect(
            service.resetWatchedScanIntent({
                expectedRevision: virgin.revision,
                expectedSettingFingerprint: virgin.settingFingerprint,
                userActionId: "locked-reset",
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_locked");
        release!();

        const missingProject = "00000000-0000-4000-8000-000000000987" as UuidV4;
        expect(
            service.replaceWatchedScanIntent({
                ...request,
                decisions: [
                    {
                        action: "include_user_selected_root",
                        environment: { platform: "linux", platformInstanceId: "local" },
                        adapterId: ADAPTER,
                        agentRuntimeIds: [RUNTIME],
                        directoryRootPath: "/tmp/root",
                        binding: { assetScope: "project", projectId: missingProject },
                    },
                ],
            }).diagnostics[0]?.code,
        ).toBe("settings.watched_scan_project_inactive");

        const corruptTxn = path.join(oaamRoot, "transactions", "00000000-0000-4000-8000-000000000654");
        fs.mkdirSync(corruptTxn, { recursive: true });
        fs.writeFileSync(path.join(corruptTxn, "journal.json"), "{not-json");
        expect(service.replaceWatchedScanIntent(request).diagnostics[0]?.code).toBe("mutation_scope.corrupt_deployment_journal");
        fs.rmSync(corruptTxn, { recursive: true, force: true });

        expect(service.setSetting("client.ui", { configVersion: 1 }).status).toBe("complete");
        const settingsPath = path.join(oaamRoot, "settings.json");
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
            settings: Record<string, unknown>;
        };
        settings.settings["core.watched_scan_intent_v1"] = { configVersion: 1 };
        fs.writeFileSync(settingsPath, JSON.stringify(settings));
        expect(service.getWatchedScanIntent().diagnostics[0]?.causeKind).toBe("invalid_schema");

        fs.mkdirSync(oaamRoot, { recursive: true });
        fs.writeFileSync(settingsPath, "{not-json");
        expect(service.getWatchedScanIntent().diagnostics[0]?.causeKind).toBe("internal_error");
    });
});
