/** Final Provider option fingerprints over composed cell-local target results. */

import { describe, expect, it } from "vitest";
import type { AdapterRenderAnalysisResult, ProviderRenderDialectInputsForAsset } from "../../src/contracts/render";
import { computeProviderRenderDialectInputFingerprint, computeRenderOptionFingerprint } from "../../src/foundation/fingerprint";
import { rebindAdapterRenderAnalysisOptionFingerprints } from "../../src/render/render-analysis-validator";

const ZERO = `sha256:${"0".repeat(64)}` as const;
const ONE = `sha256:${"1".repeat(64)}` as const;
const TWO = `sha256:${"2".repeat(64)}` as const;

describe("Provider render-option fingerprint rebinding", () => {
    it("rebinds every cell-local option to the complete deterministic Provider dialect input", () => {
        const dialectInputs = [dialectGroup("asset-b", "version-b", 2), dialectGroup("asset-a", "version-a", 1)];
        const result = analysisResult();
        const rebound = rebindAdapterRenderAnalysisOptionFingerprints(
            { adapterId: "TEST", version: "1.0.0" },
            { deployment: { renderInputFingerprint: ZERO }, dialectInputs } as never,
            result,
        );
        const providerRenderDialectInputFingerprint = computeProviderRenderDialectInputFingerprint({
            adapterId: "TEST",
            adapterVersion: "1.0.0",
            dialectInputs,
        });

        expect(result.semanticOptions.map((option) => option.optionFingerprint)).toEqual([ONE, TWO]);
        expect(rebound.semanticOptions.map((option) => option.optionFingerprint)).toEqual(
            result.semanticOptions.map((option) => {
                const { optionFingerprint: _optionFingerprint, diagnostics: _diagnostics, ...preimage } = option;
                return computeRenderOptionFingerprint({
                    adapterId: "TEST",
                    adapterVersion: "1.0.0",
                    renderInputFingerprint: ZERO,
                    providerRenderDialectInputFingerprint,
                    option: preimage,
                });
            }),
        );
        expect(
            rebindAdapterRenderAnalysisOptionFingerprints(
                { adapterId: "TEST", version: "1.0.0" },
                { deployment: { renderInputFingerprint: ZERO }, dialectInputs: [...dialectInputs].reverse() } as never,
                result,
            ).semanticOptions,
        ).toEqual(rebound.semanticOptions);
    });
});

function dialectGroup(assetId: string, versionId: string, byte: number): ProviderRenderDialectInputsForAsset {
    return {
        targetVersion: { assetId, versionId },
        consumerAgentRuntimeIds: ["TEST_RUNTIME"],
        inputs: [
            {
                inputKind: "dialect_restoration",
                restoration: {
                    dialectId: `test-dialect-${byte}`,
                    restorationContractFingerprint: ZERO,
                    contentHash: ZERO,
                },
                content: { contentKind: "binary", bytes: Uint8Array.of(byte) },
            },
        ],
    } as ProviderRenderDialectInputsForAsset;
}

function analysisResult(): AdapterRenderAnalysisResult {
    return {
        status: "complete",
        outputUnits: [],
        semanticOptions: [ONE, TWO].map((optionFingerprint, index) => ({
            optionFingerprint,
            semanticRefFingerprint: index === 0 ? ONE : TWO,
            renderStrategy: "native_file",
            outcome: "preserved",
            actualReverseExtractPolicy: "can_reconcile",
            approvalRequirement: { approvalState: "not_required" },
            requiredOutputUnitFingerprints: [],
            reasonCode: `test-${index}`,
            diagnostics: [],
        })),
        blockedSemanticRefs: [],
        diagnostics: [],
    };
}
