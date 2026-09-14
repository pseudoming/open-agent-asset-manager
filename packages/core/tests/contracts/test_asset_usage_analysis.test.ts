import * as fs from "node:fs";
import * as path from "node:path";
import { readRegularFileNoFollow } from "@oaam/shared/filesystem";
import { describe, expect, it, vi } from "vitest";
import { physicalIdentityFingerprint } from "../../src/adapters/adapter-read-physical-authority";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import type { ImportProvenanceAuthorityV1, ImportProvenanceAuthorityV2 } from "../../src/contracts/persistence";
import {
    computeImportProvenanceAuthorityFingerprint,
    computeImportSourceSnapshotFingerprint,
    computeVersionOriginAuthorityFingerprint,
} from "../../src/foundation/fingerprint";
import {
    assetUsageCapableConsumerIds,
    loadAssetUsageSourceSnapshot,
    normalizeAssetUsageInput,
} from "../../src/orchestration/asset-usage-analysis";
import { deploymentRenderServiceInternalsForTest } from "../../src/orchestration/deployment-render-service";
import { getDb } from "../../src/persistence/db";
import { softDeleteDeployment, updateDeployment } from "../../src/persistence/state-db";
import type { AnalyzeAssetUsageInput, Platform, Sha256Digest, UuidV4 } from "../../src/types";
import { ASSET_ID, makeTextFile, makeVersionClosure, PROJECT_ID, VERSION_ID } from "../catalog/fixtures/version-v2";
import {
    ADAPTER_ID,
    AGENT_RUNTIME_ID,
    ANTIGRAVITY_FIXTURE,
    currentProbeResult,
    DEPLOYMENT_ID,
    databasePath,
    diagnostic,
    materializeCalls,
    multiRuntimeService,
    oaamRoot,
    probeCalls,
    provider,
    resolveObservedTarget,
    sandbox,
    seedAuthority,
    seedGlobalAuthority,
    service,
    targetRoot,
} from "./fixtures/core-service-render-test-fixtures";

function usageInput(overrides: Partial<AnalyzeAssetUsageInput> = {}): AnalyzeAssetUsageInput {
    return {
        projectId: PROJECT_ID,
        consumerAgentRuntimeIds: [AGENT_RUNTIME_ID as never],
        platform: "wsl",
        platformInstanceId: "wsl-test",
        targetRootPath: targetRoot,
        asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false },
        currentProbeResults: [currentProbeResult()],
        ...overrides,
    };
}

describe("Core Asset usage analysis", () => {
    it.each([
        ["win32", "C:\\oaam\\project"],
        ["darwin", "/oaam/project"],
        ["linux", "/oaam/project"],
        ["wsl", "/oaam/project"],
    ] as const)("normalizes a canonical %s read request and sorts runtime identities", (platform, targetRootPath) => {
        const normalized = normalizeAssetUsageInput({
            ...usageInput(),
            projectId: "",
            consumerAgentRuntimeIds: ["Z_RUNTIME", "A_RUNTIME"] as never,
            platform,
            targetRootPath,
        });
        expect(normalized.consumerAgentRuntimeIds).toEqual(["A_RUNTIME", "Z_RUNTIME"]);
    });

    it.each([
        ["invalid Project identity", () => usageInput({ projectId: "not-a-project" })],
        ["empty runtime set", () => usageInput({ consumerAgentRuntimeIds: [] })],
        ["empty runtime identity", () => usageInput({ consumerAgentRuntimeIds: [""] as never })],
        ["lowercase runtime identity", () => usageInput({ consumerAgentRuntimeIds: ["runtime"] as never })],
        ["NUL runtime identity", () => usageInput({ consumerAgentRuntimeIds: ["RUNTIME\0"] as never })],
        ["duplicate runtime identity", () => usageInput({ consumerAgentRuntimeIds: ["RUNTIME", "RUNTIME"] as never })],
        ["unknown platform", () => usageInput({ platform: "plan9" as Platform })],
        ["blank platform instance", () => usageInput({ platformInstanceId: " " })],
        ["NUL platform instance", () => usageInput({ platformInstanceId: "wsl\0test" })],
        ["non-canonical target", () => usageInput({ targetRootPath: "relative/target" })],
        [
            "invalid Asset identity",
            () => usageInput({ asset: { assetId: "asset" as UuidV4, versionId: VERSION_ID, allowIncomplete: false } }),
        ],
        [
            "invalid Version identity",
            () => usageInput({ asset: { assetId: ASSET_ID, versionId: "version" as UuidV4, allowIncomplete: false } }),
        ],
        [
            "non-boolean incomplete policy",
            () => usageInput({ asset: { assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: "false" as never } }),
        ],
    ])("rejects an %s before any runtime work", (_label, makeInput) => {
        expect(() => normalizeAssetUsageInput(makeInput())).toThrowError(
            expect.objectContaining({ code: "asset_usage.input_invalid", causeKind: "invalid_schema" }),
        );
    });

    it("rejects a non-UUID ephemeral projection identity", async () => {
        seedAuthority();
        const usage = await service(
            provider(),
            Number.POSITIVE_INFINITY,
            {},
            { newUuid: () => "invalid" as UuidV4 },
        ).analyzeAssetUsage(usageInput());
        expect(usage).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "asset_usage.projection_identity_invalid", causeKind: "internal_error" }],
        });
        expect(materializeCalls).toBe(0);
        expect(probeCalls).toBe(0);
    });

    it("preserves a Provider analysis failure without creating or materializing a Deployment", async () => {
        seedAuthority();
        const selected = provider();
        selected.analyzeRender = async () => {
            throw new Error("fixture usage analysis failure");
        };
        const usage = await service(selected).analyzeAssetUsage(usageInput());
        expect(usage.status).toBe("failed");
        expect(usage.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
            "render_analysis_error",
            "render.provider_analysis_failed",
        ]);
        expect(materializeCalls).toBe(0);
    });

    it("uses the validated probe snapshot from the same read-only operation without probing the Provider again", async () => {
        seedAuthority();
        const core = service();
        const probe = await core.probeAdapters({
            adapterIds: [ADAPTER_ID],
            contexts: [
                {
                    platform: "wsl",
                    platformInstanceId: "wsl-test",
                    accessRootPath: sandbox,
                },
            ],
            target: { authorizationScope: "project", projectRootPath: targetRoot },
        });
        expect(probe.status, JSON.stringify(probe.diagnostics)).toBe("complete");
        const callsAfterInitialProbe = probeCalls;

        const usage = await core.analyzeAssetUsage({
            ...usageInput(),
            currentProbeResults: probe.value,
        } as AnalyzeAssetUsageInput);

        expect(usage.status, JSON.stringify(usage.diagnostics)).toBe("complete");
        expect(probeCalls).toBe(callsAfterInitialProbe);
    });

    it("keeps each target-file check distinct while consuming the same immutable Host probe array", async () => {
        seedAuthority();
        const snapshots: unknown[] = [];
        const core = service(provider(), Number.POSITIVE_INFINITY, {
            resolveObservedTargetContext(input, snapshot) {
                snapshots.push(snapshot);
                return resolveObservedTarget(input);
            },
        });
        const currentProbeResults = Object.freeze([
            currentProbeResult(),
        ]) as unknown as AnalyzeAssetUsageInput["currentProbeResults"];

        expect((await core.analyzeAssetUsage({ ...usageInput(), currentProbeResults })).status).toBe("complete");
        expect((await core.analyzeAssetUsage({ ...usageInput(), currentProbeResults })).status).toBe("complete");

        expect(
            (await core.analyzeAssetUsage({ ...usageInput(), currentProbeResults: Object.freeze([currentProbeResult()]) }))
                .status,
        ).toBe("complete");
        expect(snapshots).toHaveLength(3);
        expect(snapshots[0]).not.toBe(snapshots[1]);
        expect(snapshots[2]).not.toBe(snapshots[0]);
    });

    it("selects the exact target Provider from one same-context Host operation snapshot", async () => {
        seedAuthority();
        const core = multiRuntimeService(() => "55555555-5555-4555-8555-555555555555" as UuidV4);
        const currentProbeResults = Object.freeze([
            currentProbeResult(),
            currentProbeResult(ANTIGRAVITY_FIXTURE),
        ]) as unknown as AnalyzeAssetUsageInput["currentProbeResults"];

        const result = await core.analyzeAssetUsage({ ...usageInput(), currentProbeResults });
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(result.value.relationships.map((relationship) => relationship.agentRuntimeId)).toEqual([AGENT_RUNTIME_ID]);
    });

    it("fails closed without re-probing when the operation-local probe snapshot is missing, duplicated, or mismatched", async () => {
        seedAuthority();
        const core = service();
        const exact = currentProbeResult();
        const callsBefore = probeCalls;
        const cases: readonly {
            currentProbeResults: AnalyzeAssetUsageInput["currentProbeResults"];
            expectedCode: string;
        }[] = [
            { currentProbeResults: [], expectedCode: "asset_usage.input_invalid" },
            {
                currentProbeResults: [exact, structuredClone(exact)],
                expectedCode: "asset_usage.probe_snapshot_invalid",
            },
            {
                currentProbeResults: [
                    {
                        ...exact,
                        observation: {
                            ...exact.observation,
                            platformContext: { ...exact.observation.platformContext, platformInstanceId: "other" },
                        },
                    },
                ],
                expectedCode: "asset_usage.probe_snapshot_invalid",
            },
            {
                currentProbeResults: [{ ...exact, observation: { ...exact.observation, adapterId: "UNREGISTERED" as never } }],
                expectedCode: "asset_usage.probe_snapshot_invalid",
            },
            {
                currentProbeResults: [
                    {
                        ...exact,
                        observation: {
                            ...exact.observation,
                            observedAgentRuntimes: [
                                {
                                    ...exact.observation.observedAgentRuntimes[0]!,
                                    agentRuntimeId: "FOREIGN_CLI" as never,
                                },
                            ],
                        },
                    },
                ],
                expectedCode: "probe.agent_runtime_foreign",
            },
        ];

        for (const { currentProbeResults, expectedCode } of cases) {
            const result = await core.analyzeAssetUsage({ ...usageInput(), currentProbeResults } as AnalyzeAssetUsageInput);
            expect(result.status).toBe("failed");
            expect(result.diagnostics.map((entry) => entry.code)).toContain(expectedCode);
        }
        expect(probeCalls).toBe(callsBefore);
    });

    it("fails closed when the operation-local snapshot omits one exact target Provider", async () => {
        seedAuthority();
        const core = multiRuntimeService(() => "55555555-5555-4555-8555-555555555555" as UuidV4);

        const result = await core.analyzeAssetUsage({
            ...usageInput(),
            consumerAgentRuntimeIds: [AGENT_RUNTIME_ID, "ANTIGRAVITY_CLI"] as never,
            currentProbeResults: [currentProbeResult()],
        });

        expect(result).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "asset_usage.probe_snapshot_invalid", causeKind: "invalid_schema" }],
        });
        expect(materializeCalls).toBe(0);
    });

    it("does not probe a runtime whose exact AssetKind has no supported target capability", async () => {
        seedAuthority();
        const selected = provider();
        const deferred = selected.assetTargetCapabilities.find(
            (capability) => capability.agentRuntimeId === AGENT_RUNTIME_ID && capability.assetKind === "Rule",
        );
        if (deferred === undefined || deferred.entrySupportStatus !== "deferred") {
            throw new Error("deferred target capability fixture is missing");
        }
        selected.assetTargetCapabilities = selected.assetTargetCapabilities.map((capability) =>
            capability.assetKind === "Guidance" ? { ...deferred, assetKind: "Guidance" } : capability,
        );
        selected.targetContextSchemas = [];
        selected.materializerCapabilities = [];
        selected.renderContractDeclarations = [];

        expect(assetUsageCapableConsumerIds([selected], [AGENT_RUNTIME_ID as never], ["Guidance"], "project")).toEqual([]);
        const usage = await service(selected).analyzeAssetUsage(usageInput());

        expect(usage.status, JSON.stringify(usage.diagnostics)).toBe("complete");
        expect(usage.value.relationships).toEqual([
            expect.objectContaining({
                agentRuntimeId: AGENT_RUNTIME_ID,
                capability: "unavailable",
                observedTargetState: "unknown",
                substitute: null,
                reasonCodes: ["asset_usage.target_unsupported"],
            }),
        ]);
        expect(materializeCalls).toBe(0);
        expect(probeCalls).toBe(0);
    });

    it("does not materialize a target-capable runtime whose Provider reports no usable semantic", async () => {
        seedAuthority();
        const selected = provider();
        const analyze = selected.analyzeRender;
        if (analyze === undefined) throw new Error("fixture analysis entry is missing");
        selected.analyzeRender = async (input) => {
            const result = await analyze(input);
            result.outputUnits = [];
            result.semanticOptions = [];
            result.blockedSemanticRefs = input.requiredSemantics.map((semantic) => ({
                semanticRefFingerprint: semantic.semanticRefFingerprint,
                reasonCode: "fixture_semantic_unavailable",
                diagnostics: [],
            }));
            return result;
        };

        const usage = await service(selected).analyzeAssetUsage(usageInput());

        expect(usage.status, JSON.stringify(usage.diagnostics)).toBe("complete");
        expect(usage.value.relationships).toEqual([
            expect.objectContaining({
                capability: "unavailable",
                observedTargetState: "unknown",
                reasonCodes: ["fixture_semantic_unavailable"],
            }),
        ]);
        expect(materializeCalls).toBe(0);
    });

    it("does not send a Global Asset to an exact project-only output declaration or borrow a sibling output", async () => {
        seedGlobalAuthority();
        const selected = provider();
        expect(assetUsageCapableConsumerIds([selected], [AGENT_RUNTIME_ID as never], ["Guidance"], "project")).toEqual([
            AGENT_RUNTIME_ID,
        ]);
        expect(assetUsageCapableConsumerIds([selected], [AGENT_RUNTIME_ID as never], ["Guidance"], "global")).toEqual([]);
        const declaration = selected.renderContractDeclarations[0]!;
        const opposite = { ...declaration, declarationKind: "native_global_guidance_v1" as const };
        expect(
            assetUsageCapableConsumerIds(
                [{ ...selected, renderContractDeclarations: [opposite] }],
                [AGENT_RUNTIME_ID as never],
                ["Guidance"],
                "global",
            ),
        ).toEqual([AGENT_RUNTIME_ID]);
        expect(
            assetUsageCapableConsumerIds(
                [{ ...selected, renderContractDeclarations: [opposite] }],
                [AGENT_RUNTIME_ID as never],
                ["Guidance"],
                "project",
            ),
        ).toEqual([]);
        const sibling = { ...opposite, outputContractId: "SIBLING_OUTPUT" };
        expect(
            assetUsageCapableConsumerIds(
                [{ ...selected, renderContractDeclarations: [declaration, sibling] }],
                [AGENT_RUNTIME_ID as never],
                ["Guidance"],
                "global",
            ),
        ).toEqual([]);
        const unresolved = { ...selected, renderContractDeclarations: [] };
        // Missing declarations remain candidates for the existing registry/context failure path, not proven unsupported.
        expect(assetUsageCapableConsumerIds([unresolved], [AGENT_RUNTIME_ID as never], ["Guidance"], "global")).toEqual([
            AGENT_RUNTIME_ID,
        ]);
        const resolveObservedTargetContext = vi.fn(resolveObservedTarget);
        const core = service(selected, Number.POSITIVE_INFINITY, { resolveObservedTargetContext });
        const result = await core.analyzeAssetUsage(usageInput({ projectId: "" }));
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(result.value.relationships).toEqual([
            expect.objectContaining({
                agentRuntimeId: AGENT_RUNTIME_ID,
                capability: "unavailable",
                observedTargetState: "unknown",
                reasonCodes: ["asset_usage.target_unsupported"],
            }),
        ]);
        expect(resolveObservedTargetContext).not.toHaveBeenCalled();
        expect(materializeCalls).toBe(0);
        expect(probeCalls).toBe(0);
    });

    it("still validates the exact current probe when all Global candidates are project-only", async () => {
        seedGlobalAuthority();
        const core = service();
        const exact = currentProbeResult();
        const result = await core.analyzeAssetUsage(
            usageInput({ projectId: "", currentProbeResults: [exact, structuredClone(exact)] }),
        );
        expect(result).toMatchObject({ status: "failed", diagnostics: [{ code: "asset_usage.probe_snapshot_invalid" }] });
        expect(probeCalls).toBe(0);
        expect(materializeCalls).toBe(0);
    });

    it("refreshes an exact applied relationship while reusing immutable Host probe facts", async () => {
        seedAuthority();
        updateDeployment(
            getDb(databasePath),
            DEPLOYMENT_ID,
            {
                appliedInputsSnapshot: JSON.stringify({
                    schemaVersion: 1,
                    deploymentId: DEPLOYMENT_ID,
                    consumerAgentRuntimeIds: [AGENT_RUNTIME_ID],
                    assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
                }),
            },
            3,
        );
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# Before the authorized fixture change\n");
        const core = service();
        const currentProbeResults = Object.freeze([
            currentProbeResult(),
        ]) as unknown as AnalyzeAssetUsageInput["currentProbeResults"];
        const input = usageInput({ currentProbeResults });
        expect((await core.analyzeAssetUsage(input)).value.relationships).toEqual([
            expect.objectContaining({ managedState: "applied", observedTargetState: "different" }),
        ]);

        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# Project guidance\n");
        const usage = await core.analyzeAssetUsage(input);
        expect(usage.value.relationships).toEqual([
            expect.objectContaining({
                agentRuntimeId: AGENT_RUNTIME_ID,
                observedTargetState: "already_usable",
                managedState: "applied",
                deploymentIds: [DEPLOYMENT_ID],
                appliedDeploymentIds: [DEPLOYMENT_ID],
            }),
        ]);

        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# changed outside OAAM\n");
        expect((await core.analyzeAssetUsage(input)).value.relationships).toEqual([
            expect.objectContaining({ managedState: "applied", observedTargetState: "different" }),
        ]);

        fs.rmSync(path.join(targetRoot, "CLAUDE.md"));
        expect((await core.analyzeAssetUsage(input)).value.relationships).toEqual([
            expect.objectContaining({ managedState: "applied", observedTargetState: "absent" }),
        ]);

        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# Project guidance\n");
        expect((await core.analyzeAssetUsage(input)).value.relationships).toEqual([
            expect.objectContaining({ managedState: "applied", observedTargetState: "already_usable" }),
        ]);
    });

    it("proves an unmanaged shared target already usable without creating any Deployment authority", async () => {
        seedAuthority();
        softDeleteDeployment(getDb(databasePath), DEPLOYMENT_ID, 4);
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# Project guidance\n");
        const core = service();
        const before = core.listDeployments();

        const usage = await core.analyzeAssetUsage(usageInput());

        expect(usage.status, JSON.stringify(usage.diagnostics)).toBe("complete");
        expect(usage.value.relationships).toEqual([
            expect.objectContaining({
                capability: "direct",
                observedTargetState: "already_usable",
                managedState: "none",
                deploymentIds: [],
                appliedDeploymentIds: [],
            }),
        ]);
        expect(core.listDeployments()).toEqual(before);
        expect(materializeCalls).toBe(1);

        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# bytes from an older Version\n");
        expect((await core.analyzeAssetUsage(usageInput())).value.relationships).toEqual([
            expect.objectContaining({ observedTargetState: "different", managedState: "none" }),
        ]);
        expect(core.listDeployments()).toEqual(before);
    });

    it("uses only a current Version's V2 import snapshot to prove same-context shared bytes", async () => {
        const targetPath = path.join(targetRoot, "CLAUDE.md");
        fs.writeFileSync(targetPath, "# Project guidance\n");
        const sourceIdentity = physicalIdentityFingerprint("wsl", readRegularFileNoFollow(targetPath).identity);
        seedAuthority(importedVersion(2, sourceIdentity));
        softDeleteDeployment(getDb(databasePath), DEPLOYMENT_ID, 4);

        const usage = await service().analyzeAssetUsage(usageInput());

        expect(usage.status, JSON.stringify(usage.diagnostics)).toBe("complete");
        expect(usage.value.relationships).toEqual([
            expect.objectContaining({
                capability: "direct",
                observedTargetState: "already_usable",
                managedState: "none",
            }),
        ]);
    });

    it("does not treat a missing Version or legacy import provenance as fresh physical identity", () => {
        expect(
            loadAssetUsageSourceSnapshot(
                {
                    assetsRoot: path.join(oaamRoot, "missing-assets"),
                    dialectRegistry: createVersionDialectRegistry([], [], [], []),
                },
                usageInput(),
            ),
        ).toBeUndefined();

        seedAuthority(importedVersion(1, `sha256:${"f".repeat(64)}`));
        expect(
            loadAssetUsageSourceSnapshot(
                {
                    assetsRoot: path.join(oaamRoot, "assets"),
                    dialectRegistry: createVersionDialectRegistry([], [], [], []),
                },
                usageInput(),
            ),
        ).toBeUndefined();
    });

    it("returns an actual target-link failure only on its consumer row without changing Deployment authority", async () => {
        seedAuthority();
        fs.symlinkSync(path.join(targetRoot, "private-missing-source"), path.join(targetRoot, "CLAUDE.md"));
        const core = multiRuntimeService(
            () => "55555555-5555-4555-8555-555555555555" as UuidV4,
            [provider(), provider({}, ANTIGRAVITY_FIXTURE)],
        );
        const before = core.listDeployments();
        const usage = await core.analyzeAssetUsage(
            usageInput({
                consumerAgentRuntimeIds: [AGENT_RUNTIME_ID, ANTIGRAVITY_FIXTURE.agentRuntimeId],
                currentProbeResults: [currentProbeResult(), currentProbeResult(ANTIGRAVITY_FIXTURE)],
            }),
        );
        expect(usage.status).toBe("partial");
        const first = usage.value.relationships.find((row) => row.agentRuntimeId === AGENT_RUNTIME_ID)!;
        const second = usage.value.relationships.find((row) => row.agentRuntimeId === ANTIGRAVITY_FIXTURE.agentRuntimeId)!;
        expect(first.observedTargetState).toBe("unknown");
        expect(first.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: "render.target_observation_blocked_symlink_or_reparse",
                    causeKind: "verification_failed",
                }),
            ]),
        );
        expect(second.observedTargetState).toBe("absent");
        expect(second.diagnostics).toEqual([]);
        expect(usage.diagnostics).toEqual(expect.arrayContaining(first.diagnostics));
        expect(JSON.stringify(first.diagnostics)).not.toContain("private-missing-source");
        expect(core.listDeployments()).toEqual(before);
    });

    it("keeps a failed read-only materialization unknown instead of inventing unavailability or a write intent", async () => {
        seedAuthority();
        softDeleteDeployment(getDb(databasePath), DEPLOYMENT_ID, 4);
        const core = service(provider({ materializationFailure: true }));
        const before = core.listDeployments();

        const usage = await core.analyzeAssetUsage(usageInput());

        expect(usage.status).toBe("partial");
        expect(usage.value.relationships).toEqual([
            expect.objectContaining({
                capability: "direct",
                observedTargetState: "unknown",
                managedState: "none",
                diagnostics: expect.arrayContaining([expect.objectContaining({ code: "fixture_materialization_failed" })]),
            }),
        ]);
        expect(usage.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: "render.materialization_blocked" })]),
        );
        expect(core.listDeployments()).toEqual(before);
    });

    it.each([
        false,
        true,
    ])("keeps each consumer's materialization diagnostics distinct when the second also fails: %s", async (failSecond) => {
        seedAuthority();
        const first = provider();
        const second = provider({}, ANTIGRAVITY_FIXTURE);
        const fail = (message: string) => async () => ({
            status: "failed" as const,
            materializationState: "blocked" as const,
            reasonCode: "fixture_materialization_failed",
            diagnostics: [{ ...diagnostic("fixture_materialization_failed"), message }],
        });
        first.materializeRender = fail("First consumer cannot materialize its native graph");
        if (failSecond) second.materializeRender = fail("Second consumer has a different native graph failure");
        const core = multiRuntimeService(() => "55555555-5555-4555-8555-555555555555" as UuidV4, [first, second]);
        const before = core.listDeployments();
        const usage = await core.analyzeAssetUsage(
            usageInput({
                consumerAgentRuntimeIds: [AGENT_RUNTIME_ID, ANTIGRAVITY_FIXTURE.agentRuntimeId],
                currentProbeResults: [currentProbeResult(), currentProbeResult(ANTIGRAVITY_FIXTURE)],
            }),
        );
        expect(usage.status, JSON.stringify(usage.diagnostics)).toBe("partial");
        const firstRow = usage.value.relationships.find((row) => row.agentRuntimeId === AGENT_RUNTIME_ID)!;
        const secondRow = usage.value.relationships.find((row) => row.agentRuntimeId === ANTIGRAVITY_FIXTURE.agentRuntimeId)!;
        expect(firstRow.observedTargetState).toBe("unknown");
        expect(firstRow.diagnostics.map((item) => item.message)).toContain("First consumer cannot materialize its native graph");
        expect(firstRow.diagnostics.map((item) => item.message)).not.toContain(
            "Second consumer has a different native graph failure",
        );
        expect(secondRow.diagnostics.map((item) => item.message)).not.toContain(
            "First consumer cannot materialize its native graph",
        );
        if (failSecond) {
            expect(secondRow.observedTargetState).toBe("unknown");
            expect(secondRow.diagnostics.map((item) => item.message)).toContain(
                "Second consumer has a different native graph failure",
            );
        } else {
            expect(secondRow.observedTargetState).toBe("absent");
            expect(secondRow.diagnostics).toEqual([]);
        }
        expect(core.listDeployments()).toEqual(before);
    });

    it("does not invent a managed relationship when the retained Deployment view is unavailable", async () => {
        seedAuthority();
        const usage = await service(provider(), Number.POSITIVE_INFINITY, { readDeploymentView: () => null }).analyzeAssetUsage(
            usageInput(),
        );
        expect(usage.value.relationships).toEqual([
            expect.objectContaining({ managedState: "none", deploymentIds: [], appliedDeploymentIds: [] }),
        ]);
    });

    it("ranks alternate degradations and keeps blocked and unmapped reasons distinct", async () => {
        seedAuthority();
        const analyzed = await service().analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status, JSON.stringify(analyzed.diagnostics)).toBe("complete");
        const base = structuredClone(analyzed.value);
        const option = base.analyses[0]?.semanticOptions[0];
        if (option === undefined) throw new Error("fixture semantic is unavailable");
        const semanticFingerprint = option.semanticRefFingerprint;

        const alternatives = structuredClone(base);
        alternatives.analyses[0]!.semanticOptions = [
            ...base.analyses[0]!.semanticOptions.filter((candidate) => candidate.semanticRefFingerprint !== semanticFingerprint),
            {
                ...option,
                optionFingerprint: `sha256:${"1".repeat(64)}`,
                outcome: "degraded",
                degradationKinds: ["target_runtime_missing_asset_kind", "workflow_trigger_lost"],
                degradationFingerprint: `sha256:${"2".repeat(64)}`,
                reasonCode: "z-two-losses",
            },
            {
                ...option,
                optionFingerprint: `sha256:${"3".repeat(64)}`,
                outcome: "degraded",
                degradationKinds: ["target_runtime_missing_asset_kind"],
                degradationFingerprint: `sha256:${"4".repeat(64)}`,
                reasonCode: "z-one-loss",
            },
            {
                ...option,
                optionFingerprint: `sha256:${"5".repeat(64)}`,
                outcome: "degraded",
                degradationKinds: ["target_runtime_missing_asset_kind"],
                degradationFingerprint: `sha256:${"6".repeat(64)}`,
                reasonCode: "a-one-loss",
            },
        ];
        expect(
            deploymentRenderServiceInternalsForTest.classifyAssetUsageRelationship(AGENT_RUNTIME_ID as never, alternatives),
        ).toMatchObject({
            capability: "transformed",
            substitute: null,
            reasonCodes: expect.arrayContaining(["a-one-loss"]),
        });

        const substitute = structuredClone(base);
        substitute.analyses[0]!.semanticOptions = substitute.analyses[0]!.semanticOptions.map((candidate) => ({
            ...candidate,
            outcome: "degraded" as const,
            degradationKinds: ["target_runtime_missing_asset_kind" as const],
            degradationFingerprint: `sha256:${"7".repeat(64)}` as never,
            substituteAssetKind: "Skill" as const,
            reasonCode: "fixture_workflow_as_skill",
        }));
        expect(
            deploymentRenderServiceInternalsForTest.classifyAssetUsageRelationship(AGENT_RUNTIME_ID as never, substitute),
        ).toMatchObject({
            capability: "substitute",
            substitute: { assetKind: "Skill" },
            diagnostics: [],
            requiresReview: true,
        });

        const blocked = structuredClone(base);
        blocked.analyses[0]!.semanticOptions = [];
        blocked.analyses[0]!.blockedSemanticRefs = [
            { semanticRefFingerprint: semanticFingerprint, reasonCode: "fixture-blocked", diagnostics: [] },
        ];
        expect(
            deploymentRenderServiceInternalsForTest.classifyAssetUsageRelationship(AGENT_RUNTIME_ID as never, blocked),
        ).toEqual({
            capability: "unavailable",
            substitute: null,
            degradationKinds: [],
            reasonCodes: ["fixture-blocked"],
            diagnostics: [],
            requiresReview: false,
        });

        const unmapped = structuredClone(blocked);
        unmapped.analyses[0]!.blockedSemanticRefs = [];
        expect(
            deploymentRenderServiceInternalsForTest.classifyAssetUsageRelationship(AGENT_RUNTIME_ID as never, unmapped),
        ).toEqual({
            capability: "unavailable",
            substitute: null,
            degradationKinds: [],
            reasonCodes: ["asset_usage.semantic_unavailable"],
            diagnostics: [],
            requiresReview: false,
        });
    });
});

function importedVersion(schemaVersion: 1 | 2, physicalIdentity: Sha256Digest) {
    const closure = makeVersionClosure({ files: [makeTextFile("# Project guidance\n", "GUIDANCE.md")] });
    const common = {
        importProvenanceId: "asset-usage-import-provenance",
        assetId: closure.manifest.assetId,
        versionId: closure.manifest.versionId,
        previewSnapshotFingerprint: `sha256:${"1".repeat(64)}` as const,
        candidateFingerprint: `sha256:${"2".repeat(64)}` as const,
        acceptedFreshness: "current_source_verified" as const,
        acceptedPromotion: { promotionAction: "import_only" as const, userActionEvidenceId: "asset-usage-import" },
        promotionSafety: "default_promotable" as const,
        importedAt: 100,
    };
    const sourceSnapshotPreimage = {
        schemaVersion: 1 as const,
        adapterId: ADAPTER_ID,
        roots: [
            {
                sourceRootId: "asset-usage-source-root",
                rootRole: "project_actual" as const,
                sourceDomain: "project_root" as const,
                path: targetRoot,
                locatorEvidence: [],
            },
        ],
        entries: [
            {
                observedReadEntryId: "asset-usage-source-entry",
                sourceRootId: "asset-usage-source-root",
                relativePath: "CLAUDE.md" as const,
                entryKind: "file" as const,
                contentHash: `sha256:${"3".repeat(64)}` as const,
                executable: false,
                physicalIdentityFingerprint: physicalIdentity,
            },
        ],
        fileOrigins: [{ logicalPath: "GUIDANCE.md" as const, observedReadEntryIds: ["asset-usage-source-entry"] }],
        sourceContainerEntryIds: [],
        metadataOrigins: [],
        evidence: [],
        externalAttestations: [],
    };
    const sourceSnapshot = {
        ...sourceSnapshotPreimage,
        snapshotFingerprint: computeImportSourceSnapshotFingerprint(sourceSnapshotPreimage),
    };
    const provenancePreimage =
        schemaVersion === 1
            ? ({ ...common, schemaVersion: 1 as const } satisfies Omit<ImportProvenanceAuthorityV1, "authorityFingerprint">)
            : ({
                  ...common,
                  schemaVersion: 2 as const,
                  sourceSnapshot,
              } satisfies Omit<ImportProvenanceAuthorityV2, "authorityFingerprint">);
    const importProvenanceAuthority = {
        ...provenancePreimage,
        authorityFingerprint: computeImportProvenanceAuthorityFingerprint(provenancePreimage),
    };
    const originPreimage = {
        schemaVersion: 1 as const,
        assetId: closure.manifest.assetId,
        versionId: closure.manifest.versionId,
        originKind: "import" as const,
        importProvenanceId: common.importProvenanceId,
        importProvenanceAuthorityFingerprint: importProvenanceAuthority.authorityFingerprint,
        promotionRequirement: "requires_current_authorization" as const,
        createdAt: 100,
    };
    closure.manifest.originAuthority = {
        ...originPreimage,
        authorityFingerprint: computeVersionOriginAuthorityFingerprint(originPreimage),
    };
    Object.assign(closure.manifest, { importProvenanceAuthority });
    return closure;
}
