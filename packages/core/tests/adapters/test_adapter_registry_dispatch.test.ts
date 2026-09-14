/** Dynamic adapter probe, read, render, materialization, and inspection dispatch tests. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sharedPaths from "@oaam/shared/paths";
import {
    clearRegistry,
    dispatchAnalyzeRender,
    dispatchInspectRenderedTarget,
    dispatchMaterializeRender,
    dispatchReadAssetsWithAuthority,
    enableAdapter,
    listAdapterProviders,
    probeAdapters,
    readAssetsFromAdapter,
    readAssetsFromAdapterForTest,
    registerAdapterProvider,
} from "../../src/orchestration/adapter-registry";
import { deriveRequiredRenderSemanticsV1 } from "../../src/render/render-analysis";
import { nativeProjectGuidanceRegistryComponents } from "../../src/render/native-project-guidance";
import { createRenderRegistry } from "../../src/render/render-registry";
import type { AdapterId, AdapterProvider, AdapterReadTarget, PlatformContext } from "../../src/types";
import { completeNotFoundProbe, makeContractProvider, partialUnknownProbe } from "./fixtures/adapter-contract-fixtures";
import { makeNativeGuidanceProvider } from "./fixtures/adapter-registry-providers";
import {
    makeAnalysisResult,
    makeGuidanceRenderAsset,
    makeRenderDeployment,
    makeTargetContext,
} from "../render/fixtures/render-contract-fixtures";

const A = "MOCK_A" as AdapterId;
const B = "MOCK_B" as AdapterId;
const LINUX: PlatformContext = {
    platform: "linux",
    platformInstanceId: "local",
    accessRootPath: "/",
};

function enable(provider: AdapterProvider): void {
    expect(registerAdapterProvider(provider).status).toBe("complete");
    expect(enableAdapter(provider.adapterId).status).toBe("complete");
}

function readTarget(adapterId: AdapterId): AdapterReadTarget {
    return {
        adapterId,
        sourceSelector: {
            selectorKind: "probe_roots",
            observation: {
                adapterId,
                platformContext: LINUX,
                observedAgentRuntimes: [],
                sourceRoots: [],
                agentRuntimeResources: [],
                observedProjects: [],
                targetCandidates: [],
            },
            sourceRootIds: [],
        },
    };
}

describe("probe dispatch and validation", () => {
    beforeEach(() => clearRegistry());
    afterEach(() => vi.restoreAllMocks());

    it("runs all selected Provider-context probes concurrently while preserving request order", async () => {
        const adapterIds = ["MOCK_A", "MOCK_B", "MOCK_C", "MOCK_D", "MOCK_E", "MOCK_F"] as AdapterId[];
        const started: AdapterId[] = [];
        let release = (): void => {};
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        for (const adapterId of adapterIds) {
            const provider = makeContractProvider(adapterId);
            const originalProbe = provider.probe;
            provider.probe = async (context) => {
                started.push(adapterId);
                await pending;
                return originalProbe(context);
            };
            enable(provider);
        }

        const progress: unknown[] = [];
        const scope = vi.spyOn(sharedPaths, "withPathEnvironmentObservation");
        const operation = probeAdapters(
            {
                adapterIds,
                contexts: [LINUX],
                target: { authorizationScope: "global" },
            },
            (update) => progress.push(update),
        );
        try {
            // No Provider can finish before all six have started. A fixed-five limiter fails here.
            expect(started).toEqual(adapterIds);
            expect(scope).toHaveBeenCalledTimes(1);
        } finally {
            release();
        }
        const result = await operation;

        expect(result.status).toBe("complete");
        expect(result.value.map((entry) => entry.observation.adapterId)).toEqual(adapterIds);
        expect(progress[0]).toEqual({ stage: "provider_probe", completedUnits: 0, totalUnits: 6 });
        expect(progress.slice(1).map((update) => (update as { completedUnits: number }).completedUnits)).toEqual([
            1, 2, 3, 4, 5, 6,
        ]);
        expect(
            progress
                .slice(1)
                .map((update) => (update as { adapterId: string }).adapterId)
                .sort(),
        ).toEqual([...adapterIds].sort());
        expect(progress.slice(1)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    stage: "provider_probe",
                    totalUnits: 6,
                    outcome: "complete",
                    elapsedMilliseconds: expect.any(Number),
                }),
            ]),
        );
        await probeAdapters({ adapterIds, contexts: [LINUX], target: { authorizationScope: "global" } });
        expect(scope).toHaveBeenCalledTimes(2);
    });

    it("keeps progress presentation failures outside the immutable probe result", async () => {
        enable(makeContractProvider(A));
        await expect(
            probeAdapters({ adapterIds: [A], contexts: [LINUX], target: { authorizationScope: "global" } }, () => {
                throw new Error("presentation closed");
            }),
        ).resolves.toMatchObject({ status: "complete", value: [expect.objectContaining({ status: "complete" })] });
    });

    it("isolates the probe request and returned observation from provider-owned mutation", async () => {
        const provider = makeContractProvider(A);
        const originalProbe = provider.probe;
        let retainedResult: Awaited<ReturnType<AdapterProvider["probe"]>> | undefined;
        provider.probe = async (context) => {
            const result = await originalProbe(context);
            context.platformContext.platformInstanceId = "provider-mutated";
            retainedResult = result;
            return result;
        };
        enable(provider);
        const platformContext = structuredClone(LINUX);
        const result = await probeAdapters({
            adapterIds: [A],
            contexts: [platformContext],
            target: { authorizationScope: "global" },
        });
        expect(result.status).toBe("complete");
        expect(platformContext.platformInstanceId).toBe("local");

        retainedResult?.observation.observedAgentRuntimes.splice(0);
        expect(result.value[0]?.observation.observedAgentRuntimes).toHaveLength(1);
    });

    it("accepts a logical WSL context whose Host-visible access root uses canonical UNC grammar", async () => {
        enable(makeContractProvider(A));
        const result = await probeAdapters({
            adapterIds: [A],
            contexts: [
                {
                    platform: "wsl",
                    platformInstanceId: "Ubuntu",
                    accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example",
                },
            ],
            target: { authorizationScope: "global" },
        });
        expect(result.status).toBe("complete");
        expect(result.value[0]?.observation.platformContext).toEqual({
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example",
        });
    });

    it("passes one canonical user-selected installation root only to one exact Provider context", async () => {
        const provider = makeContractProvider(A);
        const contexts: unknown[] = [];
        const originalProbe = provider.probe;
        provider.probe = async (context) => {
            contexts.push(context);
            return originalProbe(context);
        };
        enable(provider);
        enable(makeContractProvider(B));
        const narrow = { ...LINUX, accessRootPath: "/trusted" };

        const accepted = await probeAdapters({
            adapterIds: [A],
            contexts: [narrow],
            target: { authorizationScope: "global", installationRootPath: "/trusted/tools/claude" },
        });
        expect(accepted.status).toBe("complete");
        expect(contexts).toEqual([
            {
                authorizationScope: "global",
                platformContext: narrow,
                installationRootPath: "/trusted/tools/claude",
            },
        ]);

        for (const request of [
            {
                adapterIds: [A, B],
                contexts: [narrow],
                target: { authorizationScope: "global" as const, installationRootPath: "/trusted/tools" },
            },
            {
                adapterIds: [A],
                contexts: [narrow, { ...narrow, platformInstanceId: "other" }],
                target: { authorizationScope: "global" as const, installationRootPath: "/trusted/tools" },
            },
        ]) {
            const rejected = await probeAdapters(request);
            expect(rejected.status).toBe("failed");
            expect(rejected.diagnostics).toEqual(
                expect.arrayContaining([expect.objectContaining({ code: "probe_request_installation_root_scope_invalid" })]),
            );
        }
        const outside = await probeAdapters({
            adapterIds: [A],
            contexts: [narrow],
            target: { authorizationScope: "global", installationRootPath: "/outside" },
        });
        expect(outside.status).toBe("failed");
        expect(outside.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: "probe_request_installation_root_invalid" })]),
        );
        expect(contexts).toHaveLength(1);
    });

    it("rejects duplicate or noncanonical probe authority before provider invocation", async () => {
        const provider = makeContractProvider(A);
        let calls = 0;
        const originalProbe = provider.probe;
        provider.probe = async (context) => {
            calls += 1;
            return originalProbe(context);
        };
        enable(provider);

        const invalidRequests = [
            {
                adapterIds: [A, A],
                contexts: [LINUX],
                target: { authorizationScope: "global" as const },
                code: "probe_request_adapter_duplicate",
            },
            {
                adapterIds: [A],
                contexts: [LINUX, structuredClone(LINUX)],
                target: { authorizationScope: "global" as const },
                code: "probe_request_context_duplicate",
            },
            {
                adapterIds: [A],
                contexts: [{ ...LINUX, accessRootPath: "relative" }],
                target: { authorizationScope: "global" as const },
                code: "probe_request_context_invalid",
            },
            {
                adapterIds: [A],
                contexts: [LINUX],
                target: { authorizationScope: "project" as const, projectRootPath: "relative" },
                code: "probe_request_target_root_invalid",
            },
            {
                adapterIds: [A],
                contexts: [LINUX],
                target: {
                    authorizationScope: "directory" as const,
                    directoryRootPath: "relative",
                },
                code: "probe_request_target_root_invalid",
            },
        ];
        for (const { code, ...request } of invalidRequests) {
            const result = await probeAdapters(request);
            expect(result.status).toBe("failed");
            expect(result.value).toEqual([]);
            expect(result.diagnostics.some((item) => item.code === code)).toBe(true);
        }
        const malformed = await probeAdapters({
            adapterIds: [A],
            contexts: [{ ...LINUX, platformInstanceId: null as never }],
            target: { authorizationScope: "global" },
        });
        expect(malformed.diagnostics[0]?.code).toBe("probe_request_invalid");
        const outsideSelectedWsl = await probeAdapters({
            adapterIds: [A],
            contexts: [
                {
                    platform: "wsl",
                    platformInstanceId: "Ubuntu",
                    accessRootPath: "\\\\wsl.localhost\\Ubuntu\\",
                },
            ],
            target: {
                authorizationScope: "project",
                projectRootPath: "\\\\wsl.localhost\\Debian\\home\\example\\project",
            },
        });
        expect(outsideSelectedWsl.status).toBe("failed");
        expect(outsideSelectedWsl.diagnostics.some((item) => item.code === "probe_request_target_root_invalid")).toBe(true);
        expect(calls).toBe(0);
    });

    it("accepts a complete not-found only when the provider reports every entry and checked-path evidence", async () => {
        const provider = makeContractProvider(A);
        const calls: unknown[] = [];
        const originalProbe = provider.probe;
        provider.probe = async (context) => {
            calls.push(context);
            return originalProbe(context);
        };
        enable(provider);
        const targets = [
            { authorizationScope: "global" as const },
            { authorizationScope: "project" as const, projectRootPath: "/project" },
            { authorizationScope: "directory" as const, directoryRootPath: "/chosen" },
        ];
        for (const target of targets) {
            const result = await probeAdapters({ adapterIds: [A], contexts: [LINUX], target });
            expect(result.status).toBe("complete");
            expect(result.value[0]?.observation.adapterId).toBe(A);
            expect(result.value[0]?.observation.platformContext).toEqual(LINUX);
            expect(result.value[0]?.observation.observedAgentRuntimes[0]?.installationStatus).toBe("not_found");
        }
        expect(calls).toEqual(targets.map((target) => ({ ...target, platformContext: LINUX })));
    });

    it("preserves an honest partial-unknown result instead of inventing not-found", async () => {
        const runtime = `${A}_CLI`;
        enable(makeContractProvider(A, partialUnknownProbe(runtime)));
        const result = await probeAdapters({
            contexts: [LINUX],
            target: { authorizationScope: "global" },
        });
        expect(result.status).toBe("partial");
        expect(result.value[0]?.status).toBe("partial");
        expect(result.value[0]?.observation.observedAgentRuntimes[0]?.installationStatus).toBe("unknown");
    });

    it("rejects unchecked not-found and strips the invalid observation from the returned fact set", async () => {
        const runtime = `${A}_CLI`;
        const unchecked = completeNotFoundProbe(runtime);
        unchecked.observation.observedAgentRuntimes[0]!.installationEvidence = [];
        unchecked.observation.sourceRoots.push({
            sourceRootId: "residual",
            rootRole: "source",
            sourceDomain: "agent_runtime_private",
            path: "/residual/data",
            accessStatus: "available",
            locatorEvidence: [
                {
                    locatorKind: "runtime_known_rule",
                    locatorKey: "residual",
                    evidenceLevel: "local_artifact",
                },
            ],
            diagnostics: [],
        });
        enable(makeContractProvider(A, unchecked));
        const result = await probeAdapters({
            contexts: [LINUX],
            target: { authorizationScope: "global" },
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics.some((item) => item.code === "probe.not_found_unchecked")).toBe(true);
        expect(result.value[0]?.observation.sourceRoots).toEqual([]);
    });

    it("aggregates complete plus failed as partial and all failures as failed", async () => {
        enable(makeContractProvider(A));
        const failed = makeContractProvider(B);
        failed.probe = async () => {
            throw new Error("boom");
        };
        enable(failed);
        const mixed = await probeAdapters({ contexts: [LINUX], target: { authorizationScope: "global" } });
        expect(mixed.status).toBe("partial");
        expect(mixed.value).toEqual([
            expect.objectContaining({ status: "complete" }),
            expect.objectContaining({
                status: "failed",
                observation: expect.objectContaining({ adapterId: B, platformContext: LINUX }),
                diagnostics: [expect.objectContaining({ code: "probe_error" })],
            }),
        ]);
        clearRegistry();
        enable(failed);
        const result = await probeAdapters({
            contexts: [LINUX],
            target: { authorizationScope: "global" },
        });
        expect(result.status).toBe("failed");
        expect(result.value).toEqual([
            expect.objectContaining({
                status: "failed",
                observation: expect.objectContaining({ adapterId: B, platformContext: LINUX }),
            }),
        ]);
        expect(result.diagnostics[0]?.code).toBe("probe_error");
    });

    it("preserves a provider's valid typed failed probe result", async () => {
        const provider = makeContractProvider(A);
        provider.probe = async () => ({
            status: "failed",
            observation: {
                observedAgentRuntimes: [],
                sourceRoots: [],
                agentRuntimeResources: [],
                observedProjects: [],
                targetCandidates: [],
            },
            diagnostics: [],
        });
        enable(provider);
        const result = await probeAdapters({
            contexts: [LINUX],
            target: { authorizationScope: "global" },
        });
        expect(result.status).toBe("failed");
        expect(result.value).toEqual([expect.objectContaining({ status: "failed", diagnostics: [] })]);
    });

    it("omits disabled adapters by default and rejects explicit disabled, unknown, or empty-context unknown requests", async () => {
        enable(makeContractProvider(A));
        registerAdapterProvider(makeContractProvider(B));
        expect((await probeAdapters({ contexts: [LINUX], target: { authorizationScope: "global" } })).value).toHaveLength(1);
        const explicit = await probeAdapters({
            adapterIds: [B, "UNKNOWN"],
            contexts: [LINUX],
            target: { authorizationScope: "global" },
        });
        expect(explicit.status).toBe("failed");
        expect(explicit.diagnostics.map((item) => item.code)).toEqual(["adapter_disabled", "not_found"]);
        expect(
            (
                await probeAdapters({
                    adapterIds: ["UNKNOWN"],
                    contexts: [],
                    target: { authorizationScope: "global" },
                })
            ).status,
        ).toBe("failed");
        clearRegistry();
        expect((await probeAdapters({ contexts: [LINUX], target: { authorizationScope: "global" } })).status).toBe("complete");
    });
});
describe("Stage-A authority dispatch boundaries", () => {
    beforeEach(() => clearRegistry());

    it("blocks read before provider invocation for unknown, disabled, and enabled adapters", async () => {
        let calls = 0;
        const provider = makeContractProvider(A);
        provider.read = async () => {
            calls += 1;
            return { candidates: [], sourceParseReports: [], diagnostics: [] };
        };
        expect((await readAssetsFromAdapter(readTarget(A))).diagnostics[0]?.code).toBe("not_found");
        registerAdapterProvider(provider);
        expect((await readAssetsFromAdapter(readTarget(A))).diagnostics[0]?.code).toBe("adapter_disabled");
        enableAdapter(A);
        expect((await readAssetsFromAdapter(readTarget(A))).diagnostics[0]?.code).toBe("stage_a_read_authority_unassembled");
        expect(calls).toBe(0);
    });

    it("uses the explicit A3 authority seam only after registry authorization", async () => {
        const authority = {
            managedTargetGuards: [],
            reservationIdentityFingerprints: [],
            transactionsRoot: "/tmp/oaam-read-registry-test",
        };
        expect((await readAssetsFromAdapterForTest(readTarget(A), authority)).diagnostics[0]?.code).toBe("not_found");
        registerAdapterProvider(makeContractProvider(A));
        expect((await readAssetsFromAdapterForTest(readTarget(A), authority)).diagnostics[0]?.code).toBe("adapter_disabled");
        enableAdapter(A);
        expect((await dispatchReadAssetsWithAuthority(readTarget(A), authority, () => true)).status).toBe("complete");
        expect((await readAssetsFromAdapterForTest(readTarget(A), authority)).status).toBe("complete");
    });

    it("validates live render analysis before returning provider facts", async () => {
        let calls = 0;
        let mode: "valid" | "invalid" | "throw" = "valid";
        const provider = makeNativeGuidanceProvider(A);
        provider.analyzeRender = async (input) => {
            calls += 1;
            if (mode === "throw") throw new Error("analysis fault");
            const summary = listAdapterProviders().value[0]!;
            const components = nativeProjectGuidanceRegistryComponents([summary]);
            const contract = components.outputContracts[0]!;
            const result = makeAnalysisResult(summary, input, contract, {
                renderStrategy: "native_file",
            });
            if (mode === "invalid") {
                result.semanticOptions[0]!.optionFingerprint = `sha256:${"0".repeat(64)}`;
            }
            input.requiredSemantics.length = 0;
            return result;
        };
        enable(provider);
        const summary = listAdapterProviders().value[0]!;
        const renderRegistry = createRenderRegistry({
            providers: [summary],
            ...nativeProjectGuidanceRegistryComponents([summary]),
        });
        const deployment = makeRenderDeployment(renderRegistry, summary);
        const analysisInput = {
            schemaVersion: 1 as const,
            deployment: {
                schemaVersion: 1 as const,
                platform: deployment.platform,
                targetContexts: [makeTargetContext(summary)],
                assets: [makeGuidanceRenderAsset()],
                renderInputFingerprint: deployment.renderInputFingerprint,
            },
            requiredSemantics: deriveRequiredRenderSemanticsV1(deployment),
            dialectInputs: [],
        };
        expect((await dispatchAnalyzeRender(A, analysisInput)).status).toBe("complete");
        expect(calls).toBe(1);
        expect(analysisInput.requiredSemantics).not.toHaveLength(0);

        mode = "invalid";
        expect((await dispatchAnalyzeRender(A, analysisInput)).diagnostics[0]?.code).toBe("render.option_fingerprint_mismatch");
        mode = "throw";
        expect((await dispatchAnalyzeRender(A, analysisInput)).diagnostics[0]?.code).toBe("render_analysis_error");
    });

    it("rejects analysis dispatch for unknown and disabled providers", async () => {
        expect((await dispatchAnalyzeRender(A, {} as never)).diagnostics[0]?.code).toBe("not_found");
        registerAdapterProvider(makeContractProvider(A));
        expect((await dispatchAnalyzeRender(A, {} as never)).diagnostics[0]?.code).toBe("adapter_disabled");
    });

    it("blocks materialization and inspection before invocation for unknown, disabled, or invalid input", async () => {
        const calls = { materialize: 0, inspect: 0 };
        const provider = makeNativeGuidanceProvider(A);
        provider.materializeRender = async () => {
            calls.materialize += 1;
            throw new Error("must not run");
        };
        provider.inspectRenderedTarget = async () => {
            calls.inspect += 1;
            throw new Error("must not run");
        };
        expect((await dispatchMaterializeRender(A, {} as never)).diagnostics[0]?.code).toBe("not_found");
        expect((await dispatchInspectRenderedTarget(A, {} as never)).diagnostics[0]?.code).toBe("not_found");
        registerAdapterProvider(provider);
        expect((await dispatchMaterializeRender(A, {} as never)).diagnostics[0]?.code).toBe("adapter_disabled");
        expect((await dispatchInspectRenderedTarget(A, {} as never)).diagnostics[0]?.code).toBe("adapter_disabled");
        enableAdapter(A);
        expect((await dispatchMaterializeRender(A, {} as never)).diagnostics[0]?.code).toBe("render_materialization_error");
        expect((await dispatchInspectRenderedTarget(A, {} as never)).diagnostics[0]?.code).toBe("render_inspection_error");
        expect(calls).toEqual({ materialize: 0, inspect: 0 });
    });
});
