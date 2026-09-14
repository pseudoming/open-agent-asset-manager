/** Authority-focused split from the original oversized render test suite. */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { RenderSelectionRequest, SemanticRenderOption } from "../../src/contracts/render";
import { analyzeRenderDeployment } from "../../src/render/render-analysis";
import {
    denyUnverifiedOneTimeRenderApproval,
    recommendDefaultRenderOption,
    resolveCoreRenderSelection,
    resolveNoSavedRenderPolicy,
} from "../../src/render/render-selection";
import { publishInitialAssetVersion, EMPTY_VERSION_DIALECT_REGISTRY } from "../../src/catalog/version-authority";
import { computeRenderInputFingerprint } from "../../src/foundation/fingerprint";
import { makeAsset, makeVersionClosure } from "../catalog/fixtures/version-v2";
import {
    makeAnalysisResult,
    makeOutputContract,
    makeProviderSummary,
    makeRenderDeployment,
    makeRenderRegistry,
    makeTargetContext,
} from "./fixtures/render-contract-fixtures";
import { sandbox, selectionFixture, selectionResult, makeTwoUnitAnalysis } from "./fixtures/render-selection-test-fixtures";

it("keeps CoreService approval and saved-policy defaults fail closed", () => {
    expect(denyUnverifiedOneTimeRenderApproval()).toBeNull();
    expect(resolveNoSavedRenderPolicy()).toBeNull();
});

describe("Core render selection", () => {
    it("selects one exact renderer, promotion authority, and immutable selection fingerprint", async () => {
        const fixture = await selectionFixture();
        const result = selectionResult(fixture);
        expect(result.status).toBe("complete");
        expect(result.value.semanticOptions).toHaveLength(fixture.analysis.requiredSemantics.length);
        expect(result.value.outputUnits).toHaveLength(1);
        expect(result.value.outputUnitRenderers).toEqual([
            expect.objectContaining({
                rendererAdapterId: fixture.provider.adapterId,
                outputUnitFingerprint: fixture.providerResult.outputUnits[0]!.outputUnitFingerprint,
            }),
        ]);
        expect(result.value.promotionAuthorizations).toEqual([
            expect.objectContaining({ promotionAuthorizationState: "not_required" }),
        ]);
        expect(result.value.selectionFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("canonicalizes two provider-owned output units into one Core selection", async () => {
        const fixture = await selectionFixture({
            buildAnalysisResult: makeTwoUnitAnalysis(
                (unit) => {
                    unit.managedDirectoryBoundaries = [
                        {
                            relativePath: "first-managed",
                            boundaryKind: "directory_inventory",
                        },
                    ];
                },
                (unit) => {
                    unit.managedDirectoryBoundaries = [
                        {
                            relativePath: "second-managed",
                            boundaryKind: "directory_inventory",
                        },
                    ];
                },
            ),
        });
        const result = selectionResult(fixture);
        expect(result.status).toBe("complete");
        expect(result.value.outputUnits).toHaveLength(2);
        expect(result.value.outputUnits.map((unit) => unit.claims[0]!.relativePath).sort()).toEqual(["AGENTS.md", "OTHER.md"]);
        expect(result.value.outputUnitRenderers).toHaveLength(2);
    });

    it("produces one Core selection for two consumer-owner providers targeting one file", async () => {
        const fixtureRoot = fs.mkdtempSync(path.join(sandbox, "multi-provider-"));
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
        const analyzed = await analyzeRenderDeployment(deployment, {
            registry,
            resolveDialectInputs: () => [],
            dispatch: async (adapterId, input) => ({
                status: "complete",
                value: makeAnalysisResult(registry.getProvider(adapterId)!, input, contract),
                diagnostics: [],
            }),
        });
        expect(analyzed.status).toBe("complete");
        const assetsRoot = path.join(fixtureRoot, "assets");
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-multi-provider",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const request: RenderSelectionRequest = {
            schemaVersion: 1,
            renderInputFingerprint: deployment.renderInputFingerprint,
            semanticOptions: analyzed.value.requiredSemantics.map((semantic) => ({
                optionFingerprint: analyzed.value.analyses
                    .flatMap((analysis) => analysis.semanticOptions)
                    .find((option) => option.semanticRefFingerprint === semantic.semanticRefFingerprint)!.optionFingerprint,
                approvalRequest: { approvalAction: "none" },
            })),
        };
        const result = resolveCoreRenderSelection(
            { deployment, analysis: analyzed.value, request },
            {
                assetsRoot,
                oaamRoot: path.join(fixtureRoot, "oaam"),
                authorityLocksRoot: path.join(fixtureRoot, "locks"),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                registry,
                confirmOneTimeApproval: () => null,
                resolveSavedPolicy: () => null,
                now: () => 1234,
            },
        );
        expect(result.status).toBe("complete");
        expect(result.value.semanticOptions).toHaveLength(analyzed.value.requiredSemantics.length);
        expect(result.value.outputUnits).toHaveLength(1);
        expect(result.value.outputUnitRenderers).toEqual([expect.objectContaining({ rendererAdapterId: "A_PROVIDER" })]);
    });

    it("accepts an empty desired Asset set without inventing output or authority", async () => {
        const fixture = await selectionFixture({ publishAsset: false });
        fixture.deployment.assets = [];
        const { renderInputFingerprint: _old, ...preimage } = fixture.deployment;
        const { computeRenderInputFingerprint } = await import("../../src/foundation/fingerprint");
        fixture.deployment.renderInputFingerprint = computeRenderInputFingerprint(preimage);
        fixture.analysis = {
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            requiredSemantics: [],
            analyses: [],
        };
        fixture.request = {
            schemaVersion: 1,
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            semanticOptions: [],
        };
        const result = selectionResult(fixture);
        expect(result.status).toBe("complete");
        expect(result.value).toEqual(
            expect.objectContaining({
                semanticOptions: [],
                outputUnits: [],
                outputUnitRenderers: [],
                promotionAuthorizations: [],
            }),
        );
    });

    it("recommends only a decisive safe strategy and leaves incomparable native forms to the user", async () => {
        const fixture = await selectionFixture();
        const source = fixture.analysis.analyses[0]!.semanticOptions[0]!;
        const option = (renderStrategy: SemanticRenderOption["renderStrategy"], fingerprint: string) =>
            ({
                ...structuredClone(source),
                renderStrategy,
                optionFingerprint: fingerprint,
            }) as SemanticRenderOption;
        expect(recommendDefaultRenderOption([])).toBeNull();
        expect(recommendDefaultRenderOption([source])).toBe(source);
        expect(
            recommendDefaultRenderOption([
                option("reference_with_intro", `sha256:${"3".repeat(64)}`),
                option("inline", `sha256:${"2".repeat(64)}`),
                option("native_import", `sha256:${"1".repeat(64)}`),
            ])?.renderStrategy,
        ).toBe("native_import");
        expect(
            recommendDefaultRenderOption([
                option("native_file", `sha256:${"4".repeat(64)}`),
                option("native_directory", `sha256:${"5".repeat(64)}`),
            ]),
        ).toBeNull();
        expect(
            recommendDefaultRenderOption([
                option("inline", `sha256:${"6".repeat(64)}`),
                option("inline", `sha256:${"1".repeat(64)}`),
            ])?.optionFingerprint,
        ).toBe(`sha256:${"1".repeat(64)}`);
    });

    it("rejects stale, duplicated, unknown, and incomplete client option requests", async () => {
        const fixture = await selectionFixture();
        const baseline = structuredClone(fixture.request);
        const cases: Array<[string, (request: RenderSelectionRequest) => void]> = [
            [
                "render.selection_request_stale",
                (request) => {
                    request.schemaVersion = 2 as never;
                },
            ],
            [
                "render.selection_option_duplicate",
                (request) => {
                    request.semanticOptions[1] = structuredClone(request.semanticOptions[0]!);
                },
            ],
            [
                "render.selection_cardinality",
                (request) => {
                    request.semanticOptions.pop();
                },
            ],
            [
                "render.selection_option_unknown",
                (request) => {
                    request.semanticOptions[0]!.optionFingerprint = `sha256:${"0".repeat(64)}`;
                },
            ],
        ];
        for (const [code, mutate] of cases) {
            fixture.request = structuredClone(baseline);
            mutate(fixture.request);
            const result = selectionResult(fixture);
            expect(result.diagnostics[0]?.code).toBe(code);
        }
    });
});
