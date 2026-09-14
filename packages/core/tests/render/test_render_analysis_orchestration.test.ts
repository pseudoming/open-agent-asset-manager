/** Authority-focused split from the original oversized render test suite. */

import { describe, expect, it } from "vitest";
import type { AdapterRenderAnalysisResult, RenderAnalysisInput, RenderAnalysisView } from "../../src/contracts/render";
import {
    analyzeRenderDeployment,
    validateAdapterRenderAnalysisResult,
    validateAnalysisView,
} from "../../src/render/render-analysis";
import {
    makeAnalysisResult,
    makeOutputContract,
    makeProviderSummary,
    makeRenderDeployment,
    makeRenderRegistry,
    makeTargetContext,
} from "./fixtures/render-contract-fixtures";
import { validAnalysisFixture } from "./fixtures/render-analysis-test-fixtures";
import { makeMemoryCatalogExactFileFixture } from "./fixtures/native-project-memory-catalog-test-fixtures";

describe("Core render analysis orchestration", () => {
    it("projects one shared-target Memory Catalog with its Unit dialect inputs and rejects foreign receipts", async () => {
        const fixture = makeMemoryCatalogExactFileFixture();
        let captured: RenderAnalysisInput | undefined;
        let providerResult: AdapterRenderAnalysisResult | undefined;
        const analyzed = await analyzeRenderDeployment(fixture.deployment, {
            registry: fixture.registry,
            resolveDialectInputs: () => structuredClone(fixture.analysisInput.dialectInputs),
            dispatch: async (_adapterId, input) => {
                captured = structuredClone(input);
                providerResult = fixture.support.analyze(input);
                return { status: "complete", value: providerResult, diagnostics: [] };
            },
        });
        expect(analyzed.status).toBe("complete");
        expect(captured?.deployment.assets).toHaveLength(3);
        expect(captured?.deployment.targetFileSnapshots).toEqual(fixture.deployment.targetFileSnapshots);

        const forged = structuredClone(captured as RenderAnalysisInput);
        forged.deployment.targetFileSnapshots?.push({ relativePath: "foreign.md", snapshotState: "missing" });
        expect(
            validateAdapterRenderAnalysisResult(fixture.provider, forged, providerResult as AdapterRenderAnalysisResult)[0]?.code,
        ).toBe("render.provider_target_snapshot_projection_invalid");
    });

    it("aggregates two consumer-owner providers in canonical order without competing plans", async () => {
        const contract = makeOutputContract();
        const first = makeProviderSummary({
            adapterId: "A_PROVIDER" as never,
            agentRuntimeId: "A_RUNTIME_CLI" as never,
            contract,
        });
        const second = makeProviderSummary({
            adapterId: "Z_PROVIDER" as never,
            agentRuntimeId: "Z_RUNTIME_CLI" as never,
            contract,
        });
        second.materializerCapabilities = [];
        const registry = makeRenderRegistry({ providers: [second, first], contract });
        const deployment = makeRenderDeployment(registry, first, {
            consumerAgentRuntimeIds: [first.agentRuntimes[0]!.agentRuntimeId, second.agentRuntimes[0]!.agentRuntimeId],
            targetContexts: [makeTargetContext(first), makeTargetContext(second)],
        });
        const calls: string[] = [];
        const analyzed = await analyzeRenderDeployment(deployment, {
            registry,
            resolveDialectInputs: () => [],
            dispatch: async (adapterId, input) => {
                calls.push(adapterId);
                const provider = registry.getProvider(adapterId)!;
                return {
                    status: "complete",
                    value: makeAnalysisResult(provider, input, contract),
                    diagnostics: [],
                };
            },
        });
        expect(analyzed.status).toBe("complete");
        expect(calls).toEqual(["A_PROVIDER", "Z_PROVIDER"]);
        expect(analyzed.value.analyses.map((item) => item.adapterId)).toEqual(["A_PROVIDER", "Z_PROVIDER"]);
        expect(
            new Set(analyzed.value.analyses.flatMap((analysis) => analysis.outputUnits.map((unit) => unit.outputUnitFingerprint)))
                .size,
        ).toBe(1);
    });

    it("does not expose the absolute target root and preserves provider partial diagnostics", async () => {
        const contract = makeOutputContract();
        const provider = makeProviderSummary({ contract });
        const registry = makeRenderRegistry({ providers: [provider], contract });
        const deployment = makeRenderDeployment(registry, provider);
        let projection: RenderAnalysisInput | undefined;
        const analyzed = await analyzeRenderDeployment(deployment, {
            registry,
            resolveDialectInputs: () => [],
            dispatch: async (_adapterId, input) => {
                projection = structuredClone(input);
                const value = makeAnalysisResult(provider, input, contract);
                input.requiredSemantics.length = 0;
                input.deployment.assets.length = 0;
                return {
                    status: "partial",
                    value,
                    diagnostics: [
                        {
                            severity: "warning",
                            code: "fixture.partial",
                            message: "partial",
                            operation: "render",
                            causeKind: "unavailable",
                            path: "",
                            traceId: "",
                            retryable: false,
                            suggestedActions: [],
                            rawSummary: "",
                        },
                    ],
                };
            },
        });
        expect(analyzed.status).toBe("partial");
        expect(analyzed.diagnostics[0]?.code).toBe("fixture.partial");
        expect(projection).not.toHaveProperty("deployment.targetRootPath");
        expect(deployment.assets).toHaveLength(1);
    });

    it("fails closed for disabled owner, provider failure/throw, and a forged result", async () => {
        const contract = makeOutputContract();
        const provider = makeProviderSummary({ contract });
        const registry = makeRenderRegistry({ providers: [provider], contract });
        const deployment = makeRenderDeployment(registry, provider);
        const base = {
            registry,
            resolveDialectInputs: () => [],
        };
        const failed = await analyzeRenderDeployment(deployment, {
            ...base,
            dispatch: async () => ({
                status: "failed",
                value: undefined as never,
                diagnostics: [
                    {
                        severity: "error",
                        code: "fixture.provider_exact_failure",
                        message: "exact provider failure",
                        operation: "render",
                        causeKind: "invalid_input",
                        path: "",
                        traceId: "",
                        retryable: false,
                        suggestedActions: [],
                        rawSummary: "",
                    },
                ],
            }),
        });
        expect(failed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
            "fixture.provider_exact_failure",
            "render.provider_analysis_failed",
        ]);

        const thrown = await analyzeRenderDeployment(deployment, {
            ...base,
            dispatch: async () => {
                throw new Error("boom");
            },
        });
        expect(thrown.diagnostics[0]?.code).toBe("render.internal_error");

        const nonError = await analyzeRenderDeployment(deployment, {
            registry,
            resolveDialectInputs: () => {
                throw "non-error dialect resolver failure";
            },
            dispatch: async () => {
                throw new Error("must not dispatch");
            },
        });
        expect(nonError.diagnostics[0]).toEqual(
            expect.objectContaining({
                code: "render.internal_error",
                message: "non-error dialect resolver failure",
            }),
        );

        const forged = await analyzeRenderDeployment(deployment, {
            ...base,
            dispatch: async (_adapterId, input) => {
                const value = makeAnalysisResult(provider, input, contract);
                value.semanticOptions[0]!.optionFingerprint = `sha256:${"0".repeat(64)}`;
                return { status: "complete", value, diagnostics: [] };
            },
        });
        expect(forged.diagnostics[0]?.code).toBe("render.option_fingerprint_mismatch");

        const disabledProvider = makeProviderSummary({ contract, enabled: false });
        const disabledRegistry = makeRenderRegistry({ providers: [disabledProvider], contract });
        const disabled = await analyzeRenderDeployment(makeRenderDeployment(disabledRegistry, disabledProvider), {
            registry: disabledRegistry,
            resolveDialectInputs: () => [],
            dispatch: async () => {
                throw new Error("must not dispatch");
            },
        });
        expect(disabled.diagnostics[0]?.code).toBe("render.consumer_owner_disabled");

        let dispatched = false;
        const missingOwner = await analyzeRenderDeployment(deployment, {
            registry: { ...registry, getOwner: () => null },
            resolveDialectInputs: () => [],
            dispatch: async () => {
                dispatched = true;
                throw new Error("must not dispatch");
            },
        });
        expect(missingOwner.diagnostics[0]?.code).toBe("render.consumer_owner_missing");
        expect(dispatched).toBe(false);
    });

    it("rejects stale or incomplete aggregate analysis views", async () => {
        const fixture = await validAnalysisFixture();
        expect(() => validateAnalysisView(fixture.view, fixture.deployment, fixture.registry)).not.toThrow();
        const cases: Array<[string, (view: RenderAnalysisView) => void]> = [
            [
                "render.analysis_input_mismatch",
                (view) => {
                    view.renderInputFingerprint = `sha256:${"1".repeat(64)}`;
                },
            ],
            [
                "render.analysis_semantics_mismatch",
                (view) => {
                    view.requiredSemantics.pop();
                },
            ],
            [
                "render.analysis_provider_duplicate",
                (view) => {
                    view.analyses.push(structuredClone(view.analyses[0]!));
                },
            ],
            [
                "render.analysis_provider_stale",
                (view) => {
                    view.analyses[0]!.adapterVersion = "old";
                },
            ],
            [
                "render.analysis_owner_cardinality",
                (view) => {
                    view.analyses = [];
                },
            ],
        ];
        for (const [code, mutate] of cases) {
            const view = structuredClone(fixture.view);
            mutate(view);
            try {
                validateAnalysisView(view, fixture.deployment, fixture.registry);
                throw new Error("expected validation failure");
            } catch (error) {
                expect((error as { code?: string }).code).toBe(code);
            }
        }
    });

    it("recognizes a conflicting descriptor shared by two provider analyses", async () => {
        const fixture = await validAnalysisFixture();
        const second = structuredClone(fixture.view.analyses[0]!);
        second.adapterId = "FOREIGN" as never;
        second.outputUnits[0]!.claims[0]!.executable = true;
        const view = structuredClone(fixture.view);
        view.analyses.push(second);
        expect(() =>
            validateAnalysisView(view, fixture.deployment, {
                ...fixture.registry,
                getProvider: (id: string) =>
                    id === "FOREIGN"
                        ? ({ ...fixture.provider, adapterId: "FOREIGN" } as never)
                        : fixture.registry.getProvider(id),
            }),
        ).toThrow(/disagree/);

        expect(() =>
            validateAnalysisView(fixture.view, fixture.deployment, {
                ...fixture.registry,
                getOwner: () => null,
            }),
        ).toThrow(/consumer owner/);
    });
});
