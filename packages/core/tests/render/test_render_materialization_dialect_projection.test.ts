/** Per-output receipt validation must retain the exact consumer and Version dialect authority. */

import { describe, expect, it } from "vitest";
import { computeTargetContextSchemaFingerprint } from "../../src/adapters/adapter-contract-validator";
import { binaryPayloadStats } from "../../src/catalog/payload-store";
import { EMPTY_VERSION_DIALECT_REGISTRY } from "../../src/catalog/version-authority";
import type { ProviderRenderDialectInputsForAsset, RenderAssetInput } from "../../src/contracts/render";
import {
    computeProviderRenderDialectInputFingerprint,
    computeRenderOptionFingerprint,
    computeRenderSelectionFingerprint,
} from "../../src/foundation/fingerprint";
import { compareUtf8Bytes } from "../../src/foundation/text-order";
import { materializeRenderDeployment } from "../../src/render/render-materialization";
import { deriveRequiredRenderSemanticsV1, versionRefKey } from "../../src/render/render-semantics";
import { makeTextFile, makeVersionClosure } from "../catalog/fixtures/version-v2";
import {
    makeAnalysisResult,
    makeGuidanceRenderAsset,
    makeOutputContract,
    makeProviderSummary,
    makeRenderDeployment,
    makeRenderRegistry,
    makeTargetContext,
    PROFILE_ID,
} from "./fixtures/render-contract-fixtures";
import { materializeFixtureResult } from "./fixtures/render-lifecycle-fixtures";

const SECOND_ASSET_ID = "11111111-2222-4222-8222-222222222222";
const SECOND_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_FILE_ID = "44444444-4444-4444-8444-444444444444";
const CONTRACT_HASH = `sha256:${"8".repeat(64)}` as const;

describe("Core per-output materialization dialect projection", () => {
    it.each([
        "distinct Versions",
        "one Version with distinct consumers",
    ])("keeps the Provider fingerprint and exact output authority for %s", async (mode) => {
        const contract = makeOutputContract();
        const provider = makeProviderSummary({ contract });
        const secondConsumer = "RENDER_FIXTURE_OTHER_CLI";
        if (mode === "one Version with distinct consumers") {
            const sibling = makeProviderSummary({ contract, agentRuntimeId: secondConsumer });
            const schema = sibling.targetContextSchemas[0]!;
            schema.targetContextSchemaId += ".other";
            schema.schemaFingerprint = computeTargetContextSchemaFingerprint(sibling, schema)!;
            for (const capability of sibling.assetTargetCapabilities) {
                if (capability.entrySupportStatus !== "supported") continue;
                capability.targetContextSchemaId = schema.targetContextSchemaId;
                capability.targetContextSchemaFingerprint = schema.schemaFingerprint;
            }
            provider.agentRuntimes.push(...sibling.agentRuntimes);
            provider.targetContextSchemas.push(...sibling.targetContextSchemas);
            provider.assetTargetCapabilities.push(...sibling.assetTargetCapabilities);
        }
        const validatedUnitVersionKeys: string[][] = [];
        const registry = makeRenderRegistry({
            providers: [provider],
            contract,
            inspectMaterializationInput(input) {
                const expected = [
                    ...new Set(
                        input.selectedSemantics.map(
                            (semantic) => `${semantic.consumerAgentRuntimeId}\0${versionRefKey(semantic.subject)}`,
                        ),
                    ),
                ].sort(compareUtf8Bytes);
                const actual = input.dialectInputs
                    .flatMap((group) =>
                        group.consumerAgentRuntimeIds.map((consumer) => `${consumer}\0${versionRefKey(group.targetVersion)}`),
                    )
                    .sort(compareUtf8Bytes);
                if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                    throw new Error("output validator received a foreign or missing consumer-Version dialect closure");
                }
                const expectedMarker = input.outputUnit.claims[0]!.relativePath === "SECOND.md" ? 2 : 1;
                const restoration = input.dialectInputs[0]!.inputs[0]!;
                if (
                    restoration.inputKind !== "dialect_restoration" ||
                    restoration.content.contentKind !== "binary" ||
                    restoration.content.bytes[0] !== expectedMarker
                ) {
                    throw new Error("output validator received its sibling's dialect payload");
                }
                validatedUnitVersionKeys.push(actual);
            },
        });
        const firstClosure = makeVersionClosure();
        const secondFile = makeTextFile("# Second Guidance\n", "SECOND.md");
        secondFile.file.fileId = SECOND_FILE_ID;
        const secondClosure = makeVersionClosure({
            assetId: SECOND_ASSET_ID,
            versionId: SECOND_VERSION_ID,
            files: [secondFile],
        });
        const assets =
            mode === "distinct Versions" ? [renderAsset(firstClosure), renderAsset(secondClosure)] : [renderAsset(firstClosure)];
        const deployment = makeRenderDeployment(registry, provider, {
            assets,
            consumerAgentRuntimeIds: provider.agentRuntimes.map((entry) => entry.agentRuntimeId).sort(),
            targetContexts: provider.agentRuntimes.map((entry) => makeTargetContext(provider, entry.agentRuntimeId)),
        });
        const requiredSemantics = deriveRequiredRenderSemanticsV1(deployment);
        const dialectInputs =
            mode === "distinct Versions"
                ? assets.map((asset, index) => restorationGroup(asset, index + 1))
                : [
                      restorationGroup(assets[0]!, 1),
                      { ...restorationGroup(assets[0]!, 2), consumerAgentRuntimeIds: [secondConsumer] as [string] },
                  ];
        const analysisInput = {
            schemaVersion: 1 as const,
            deployment: {
                schemaVersion: 1 as const,
                platform: deployment.platform,
                platformInstanceId: deployment.platformInstanceId,
                targetContexts: deployment.targetContexts,
                assets: deployment.assets,
                renderInputFingerprint: deployment.renderInputFingerprint,
            },
            requiredSemantics,
            dialectInputs,
        };
        const providerAnalysis = makeAnalysisResult(provider, analysisInput, contract, {
            relativePath: "FIRST.md",
            additionalOutputUnitPaths: ["SECOND.md"],
        });
        const outputUnits = providerAnalysis.outputUnits;
        const providerDialectFingerprint = computeProviderRenderDialectInputFingerprint({
            adapterId: provider.adapterId,
            adapterVersion: provider.version,
            dialectInputs,
        });
        for (const option of providerAnalysis.semanticOptions) {
            const semantic = requiredSemantics.find(
                (candidate) => candidate.semanticRefFingerprint === option.semanticRefFingerprint,
            );
            if (semantic === undefined) throw new Error("fixture semantic is missing");
            option.requiredOutputUnitFingerprints = [
                semantic.subject.assetId === SECOND_ASSET_ID || semantic.consumerAgentRuntimeId === secondConsumer
                    ? outputUnits[1]!.outputUnitFingerprint
                    : outputUnits[0]!.outputUnitFingerprint,
            ];
            const { optionFingerprint: _stored, diagnostics: _diagnostics, ...optionPreimage } = option;
            option.optionFingerprint = computeRenderOptionFingerprint({
                adapterId: provider.adapterId,
                adapterVersion: provider.version,
                renderInputFingerprint: deployment.renderInputFingerprint,
                providerRenderDialectInputFingerprint: providerDialectFingerprint,
                option: optionPreimage,
            });
        }
        const selectionPreimage = {
            schemaVersion: 1 as const,
            compilerPolicyVersion: "core_render_policy_v1" as const,
            renderInputFingerprint: deployment.renderInputFingerprint,
            semanticOptions: providerAnalysis.semanticOptions.map((option) => ({
                consumerOwnerAdapterId: provider.adapterId,
                consumerOwnerAdapterVersion: provider.version,
                optionFingerprint: option.optionFingerprint,
                semanticRefFingerprint: option.semanticRefFingerprint,
                renderStrategy: option.renderStrategy,
                actualReverseExtractPolicy: option.actualReverseExtractPolicy,
                requiredOutputUnitFingerprints: option.requiredOutputUnitFingerprints,
                approval: { approvalState: "not_required" as const },
                outcome: "preserved" as const,
            })),
            outputUnits,
            outputUnitRenderers: outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                rendererAdapterId: provider.adapterId,
                rendererAdapterVersion: provider.version,
                materializerCapabilityKey: provider.materializerCapabilities[0]!.materializerCapabilityKey,
                materializationProfileId: PROFILE_ID,
                profileConstraintFingerprint: contract.materializationProfiles[0]!.profileConstraintFingerprint,
            })),
            promotionAuthorizations: [],
        };
        const selection = {
            ...selectionPreimage,
            selectionFingerprint: computeRenderSelectionFingerprint(selectionPreimage),
        };
        const analysis = {
            renderInputFingerprint: deployment.renderInputFingerprint,
            requiredSemantics,
            analyses: [{ ...providerAnalysis, adapterId: provider.adapterId, adapterVersion: provider.version }],
        };
        const dispatchedDialectKeys: string[][] = [];
        const run = (inputs: ProviderRenderDialectInputsForAsset[]) =>
            materializeRenderDeployment(
                { deployment, analysis, selection },
                {
                    registry,
                    dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                    resolveDialectInputs: () => structuredClone(inputs),
                    dispatch: async (_adapterId, input) => {
                        dispatchedDialectKeys.push(input.dialectInputs.map((group) => versionRefKey(group.targetVersion)));
                        return { status: "complete", value: materializeFixtureResult(input), diagnostics: [] };
                    },
                },
            );

        const forward = await run(dialectInputs);
        const reversed = await run([...dialectInputs].reverse());
        expect(forward.status).toBe("complete");
        expect(reversed.status).toBe("complete");
        expect(dispatchedDialectKeys).toEqual([
            dialectInputs.map((group) => versionRefKey(group.targetVersion)),
            [...dialectInputs].reverse().map((group) => versionRefKey(group.targetVersion)),
        ]);
        expect(validatedUnitVersionKeys).toHaveLength(4);
        expect(validatedUnitVersionKeys.every((keys) => keys.length === 1)).toBe(true);
        expect(new Set(forward.value.units.map((unit) => unit.providerRenderDialectInputFingerprint)).size).toBe(1);
        expect(forward.value.units.map((unit) => unit.providerRenderDialectInputFingerprint)).toEqual(
            reversed.value.units.map((unit) => unit.providerRenderDialectInputFingerprint),
        );

        const missing = await run([dialectInputs[1]!]);
        expect(missing.status).toBe("failed");
        expect(missing.diagnostics[0]?.code).toBe("render.materialization_internal_error");
    });
});

function renderAsset(closure: ReturnType<typeof makeVersionClosure>): RenderAssetInput {
    return makeGuidanceRenderAsset({
        version: {
            ref: { assetId: closure.manifest.assetId, versionId: closure.manifest.versionId },
            versionFingerprint: closure.manifest.fingerprint,
            versionCanonicalContentFingerprint: closure.manifest.versionCanonicalContentFingerprint,
            status: closure.manifest.status,
            canonical: { kind: closure.manifest.kind, typeData: closure.manifest.typeData },
            files: closure.files,
        },
        sectionHandles: Object.fromEntries(closure.files.map((file) => [file.file.fileId, "fixture-section"])),
    });
}

function restorationGroup(asset: RenderAssetInput, marker: number): ProviderRenderDialectInputsForAsset {
    const bytes = Uint8Array.of(marker);
    return {
        targetVersion: structuredClone(asset.version.ref),
        consumerAgentRuntimeIds: ["RENDER_FIXTURE_CLI"],
        inputs: [
            {
                inputKind: "dialect_restoration",
                restoration: {
                    dialectId: `fixture-restoration-${marker}-v1`,
                    restorationContractFingerprint: CONTRACT_HASH,
                    contentHash: binaryPayloadStats(bytes).contentHash,
                },
                content: { contentKind: "binary", bytes },
            },
        ],
    };
}
