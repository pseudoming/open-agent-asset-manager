/** Shared deterministic fixtures for the split render authority tests. */

import { expect } from "vitest";
import type {
    AdapterRenderAnalysisResult,
    RenderAnalysisInput,
    RenderAnalysisView,
    RenderDeploymentInput,
} from "../../../src/contracts/render";
import { analyzeRenderDeployment, validateAdapterRenderAnalysisResult } from "../../../src/render/render-analysis";
import { computeRenderInputFingerprint } from "../../../src/foundation/fingerprint";
import {
    makeAnalysisResult,
    makeOutputContract,
    makeProviderSummary,
    makeRenderDeployment,
    makeRenderRegistry,
} from "./render-contract-fixtures";

export async function validAnalysisFixture(): Promise<{
    registry: ReturnType<typeof makeRenderRegistry>;
    provider: ReturnType<typeof makeProviderSummary>;
    contract: ReturnType<typeof makeOutputContract>;
    deployment: RenderDeploymentInput;
    input: RenderAnalysisInput;
    result: AdapterRenderAnalysisResult;
    view: RenderAnalysisView;
}> {
    const contract = makeOutputContract();
    const provider = makeProviderSummary({ contract });
    const registry = makeRenderRegistry({ providers: [provider], contract });
    const deployment = makeRenderDeployment(registry, provider);
    let captured: RenderAnalysisInput | undefined;
    let providerResult: AdapterRenderAnalysisResult | undefined;
    const analyzed = await analyzeRenderDeployment(deployment, {
        registry,
        resolveDialectInputs: () => [],
        dispatch: async (_adapterId, input) => {
            captured = structuredClone(input);
            providerResult = makeAnalysisResult(provider, input, contract);
            return { status: "complete", value: providerResult, diagnostics: [] };
        },
    });
    expect(analyzed.status).toBe("complete");
    return {
        registry,
        provider,
        contract,
        deployment,
        input: captured as RenderAnalysisInput,
        result: providerResult as AdapterRenderAnalysisResult,
        view: analyzed.value,
    };
}

export function rehashDeployment(deployment: RenderDeploymentInput): void {
    const { renderInputFingerprint: _stored, ...preimage } = deployment;
    deployment.renderInputFingerprint = computeRenderInputFingerprint(preimage);
}

export function diagnosticCode(
    provider: ReturnType<typeof makeProviderSummary>,
    input: RenderAnalysisInput,
    result: AdapterRenderAnalysisResult,
): string | undefined {
    return validateAdapterRenderAnalysisResult(provider, input, result)[0]?.code;
}
