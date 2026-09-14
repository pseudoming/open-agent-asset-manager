import { describe, expect, it } from "vitest";
import type { AdapterRenderAnalysisResult, RenderAnalysisInput } from "../../src/contracts/render";
import type { OperationDiagnostic } from "../../src/types";
import { analyzeRenderDeployment, validateAnalysisView } from "../../src/render/render-analysis";
import { classifyAssetUsageRelationship } from "../../src/orchestration/asset-usage-analysis";
import {
    makeAnalysisResult,
    makeOutputContract,
    makeProviderSummary,
    makeRenderDeployment,
    makeRenderRegistry,
    makeTargetContext,
} from "./fixtures/render-contract-fixtures";
import { selectionFixture, selectionResult } from "./fixtures/render-selection-test-fixtures";

function refusal(input: RenderAnalysisInput): AdapterRenderAnalysisResult {
    const diagnostic: OperationDiagnostic = {
        severity: "error",
        code: "fixture.invocation_not_expressible",
        message: "This target cannot preserve model invocation.",
        operation: "render",
        causeKind: "unsupported",
        retryable: false,
        path: "",
        traceId: "",
        suggestedActions: [],
        rawSummary: "",
    };
    return {
        status: "failed",
        outputUnits: [],
        semanticOptions: [],
        diagnostics: [diagnostic],
        blockedSemanticRefs: input.requiredSemantics.map((semantic) => ({
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            reasonCode: diagnostic.code,
            diagnostics: [diagnostic],
        })),
    };
}

describe("explicit unsupported render analysis", () => {
    it("retains an exact negative relationship and continues other Providers", async () => {
        const contract = makeOutputContract(),
            first = makeProviderSummary({ adapterId: "A_PROVIDER", agentRuntimeId: "A_RUNTIME_CLI", contract });
        const second = makeProviderSummary({ adapterId: "Z_PROVIDER", agentRuntimeId: "Z_RUNTIME_CLI", contract });
        const registry = makeRenderRegistry({ providers: [first, second], contract });
        const deployment = makeRenderDeployment(registry, first, {
            consumerAgentRuntimeIds: ["A_RUNTIME_CLI", "Z_RUNTIME_CLI"],
            targetContexts: [makeTargetContext(first), makeTargetContext(second)],
        });
        const calls: string[] = [];
        const result = await analyzeRenderDeployment(deployment, {
            registry,
            resolveDialectInputs: () => [],
            dispatch: async (id, input) => {
                calls.push(id);
                const value = id === first.adapterId ? refusal(input) : makeAnalysisResult(second, input, contract);
                return { status: value.status, value, diagnostics: value.diagnostics };
            },
        });
        expect(result.status).toBe("partial");
        expect(calls).toEqual(["A_PROVIDER", "Z_PROVIDER"]);
        expect(result.diagnostics.map((value) => value.code)).not.toContain("render.provider_analysis_failed");
        expect(classifyAssetUsageRelationship("A_RUNTIME_CLI", result.value)).toMatchObject({
            capability: "unavailable",
            requiresReview: false,
            reasonCodes: ["fixture.invocation_not_expressible"],
        });
        expect(classifyAssetUsageRelationship("Z_RUNTIME_CLI", result.value)).toMatchObject({ capability: "direct" });
        for (const mutation of ["missing", "foreign", "duplicate"] as const) {
            const view = structuredClone(result.value),
                blocked = view.analyses[0]!.blockedSemanticRefs;
            if (mutation === "missing") blocked.pop();
            else if (mutation === "duplicate") blocked.push(structuredClone(blocked[0]!));
            else blocked[0]!.semanticRefFingerprint = ("sha256:" + "0".repeat(64)) as `sha256:${string}`;
            expect(() => validateAnalysisView(view, deployment, registry)).toThrow(/negative analysis/);
        }
    });

    it("cannot turn a classified refusal into a selection or write capability", async () => {
        const fixture = await selectionFixture();
        fixture.analysis.analyses = [
            { ...refusal(fixture.input), adapterId: fixture.provider.adapterId, adapterVersion: fixture.provider.version },
        ];
        expect(fixture.analysis.analyses[0]?.semanticOptions).toEqual([]);
        const selected = selectionResult(fixture);
        expect(selected.status).toBe("failed");
        expect(selected.value).toBeUndefined();
    });

    const failures: [string, (result: AdapterRenderAnalysisResult) => void][] = [
        [
            "runtime failure",
            (result) => {
                result.diagnostics[0]!.causeKind = "unavailable";
            },
        ],
        [
            "retryable denial",
            (result) => {
                result.diagnostics[0]!.retryable = true;
            },
        ],
        [
            "missing top diagnostic",
            (result) => {
                result.diagnostics = [];
            },
        ],
        [
            "missing reason",
            (result) => {
                result.blockedSemanticRefs[0]!.reasonCode = "";
            },
        ],
        [
            "missing blocked diagnostic",
            (result) => {
                result.blockedSemanticRefs[0]!.diagnostics = [];
            },
        ],
        [
            "missing semantic",
            (result) => {
                result.blockedSemanticRefs.pop();
            },
        ],
        [
            "duplicate semantic",
            (result) => {
                result.blockedSemanticRefs.push(structuredClone(result.blockedSemanticRefs[0]!));
            },
        ],
        [
            "foreign semantic",
            (result) => {
                result.blockedSemanticRefs[0]!.semanticRefFingerprint = ("sha256:" + "0".repeat(64)) as `sha256:${string}`;
            },
        ],
        [
            "unattributed output",
            (result) => {
                result.outputUnits = [{ outputUnitFingerprint: "sha256:" + "0".repeat(64) } as never];
            },
        ],
    ];
    it.each(failures)("keeps %s as failure", async (_name, mutate) => {
        const contract = makeOutputContract(),
            provider = makeProviderSummary({ contract });
        const registry = makeRenderRegistry({ providers: [provider], contract });
        const result = await analyzeRenderDeployment(makeRenderDeployment(registry, provider), {
            registry,
            resolveDialectInputs: () => [],
            dispatch: async (_id, input) => {
                const value = refusal(input);
                mutate(value);
                return { status: "failed", value, diagnostics: value.diagnostics };
            },
        });
        expect(result.status).toBe("failed");
        expect(result.value).toBeUndefined();
    });
});
