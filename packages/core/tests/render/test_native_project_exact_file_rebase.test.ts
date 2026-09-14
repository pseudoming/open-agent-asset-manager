/** Parent-native rebase and restoration behavior for exact-file targets. */

import { describe, expect, it } from "vitest";
import { validateAdapterRenderContractRegistration } from "../../src/render/adapter-render-contract-registration";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { materializeRenderDeployment } from "../../src/render/render-materialization";
import {
    createNativeProjectExactFileProviderSupport,
    createVerifiedNativeProjectExactFileBuild,
} from "../../src/render/native-project-exact-file";
import {
    computeRenderSelectionFingerprint,
    computeRestorationDialectContractFingerprint,
} from "../../src/foundation/fingerprint";
import { binaryPayloadStats } from "../../src/catalog/payload-store";
import {
    EXACT_DIALECT_ID,
    EXACT_ENTRY_TEXT,
    EXACT_OUTPUT_CONTRACT_ID,
    EXACT_PARSER_REF,
    EXACT_PATH_REF,
    EXACT_PROFILE_ID,
    EXACT_REBASE_REF,
    EXACT_REBASED_ENTRY_TEXT,
    EXACT_REBASED_NATIVE_TEXT,
    EXACT_TARGET_PATH,
    asExactFileProvider,
    exactMaterializationInput,
    makeExactFileFixture,
    makeParentRebaseFixture,
} from "./fixtures/native-project-exact-file-test-fixtures";

describe("native project exact-file parent rebase", () => {
    it("supports a current-exact-only declaration without claiming parent rebase", () => {
        const fixture = makeExactFileFixture();
        const build = createVerifiedNativeProjectExactFileBuild({
            ...fixture.build,
            fixtureId: "fixture-cli-1.2.3-current-exact-only",
            assetKind: "Skill",
            nativeDialectId: EXACT_DIALECT_ID,
            projectPathValidator: EXACT_PATH_REF,
            reverseParser: EXACT_PARSER_REF,
            rebaseMaterializer: null,
            restorationDialectIds: [],
            parentRebaseFixtureId: "",
            targetRelativePath: EXACT_TARGET_PATH,
            exactLoadMarker: "OAAM_SKILL_FIXTURE_MARKER",
            reverseFixtureId: "native-project-skill-whole-file-reverse-v1",
        });
        const support = createNativeProjectExactFileProviderSupport({
            adapterId: "FIXTURE",
            adapterVersion: "0.1.0",
            agentRuntimes: [fixture.descriptor],
            agentRuntimeId: fixture.descriptor.agentRuntimeId,
            assetKind: "Skill",
            outputContractId: EXACT_OUTPUT_CONTRACT_ID,
            materializationProfileId: EXACT_PROFILE_ID,
            nativeDialectId: EXACT_DIALECT_ID,
            projectPathValidator: { ref: EXACT_PATH_REF, validate: () => true },
            reverseParser: { ref: EXACT_PARSER_REF, parse: () => ({ canonicalEntryText: EXACT_ENTRY_TEXT }) },
            rebaseMaterializer: null,
            restorationDialectIds: [],
            target: fixture.support.renderContractDeclaration.target,
            verifiedBuilds: [build],
        });
        expect(support.renderContractDeclaration).toMatchObject({
            rebaseMaterializer: null,
            verifiedBuilds: [{ fixtureSetFingerprint: build.fixtureSetFingerprint }],
        });
    });

    it("rebases changed canonical content into the immediate parent native layout", () => {
        const fixture = makeParentRebaseFixture();
        expect(fixture.support.analyze(fixture.analysisInput).status).toBe("complete");
        expect(fixture.support.materialize(exactMaterializationInput(fixture))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    files: [
                        {
                            relativePath: EXACT_TARGET_PATH,
                            content: { contentKind: "text", text: EXACT_REBASED_NATIVE_TEXT },
                        },
                    ],
                },
            ],
        });
        expect(EXACT_REBASED_NATIVE_TEXT).toContain("# fixture-native-layout: keep");
        expect(EXACT_REBASED_NATIVE_TEXT).toContain("x-fixture-only: keep-me");
        expect(EXACT_REBASED_NATIVE_TEXT).toContain(EXACT_REBASED_ENTRY_TEXT);

        for (const materialize of [
            () => null,
            () => {
                throw new Error("fixture rebase failure");
            },
            () => ({ nativeText: "# wrong canonical body\n" }),
        ]) {
            const rejected = makeParentRebaseFixture();
            rejected.rebaseMaterializer.materialize = materialize;
            expect(rejected.support.analyze(rejected.analysisInput)).toMatchObject({ status: "failed", outputUnits: [] });
        }
    });

    it("passes only the declared inherited restoration payload into parent rebase", () => {
        const dialectId = "fixture-skill-restoration-v1";
        const bytes = Uint8Array.of(4, 2);
        let received: Uint8Array | undefined;
        const fixture = makeParentRebaseFixture({
            restorationDialectIds: [dialectId],
            rebaseMaterializer: {
                ref: EXACT_REBASE_REF,
                materialize(input) {
                    const restoration = input.restorationInputs[0];
                    if (
                        input.restorationInputs.length !== 1 ||
                        restoration?.restoration.dialectId !== dialectId ||
                        restoration.content.contentKind !== "binary"
                    ) {
                        return null;
                    }
                    received = new Uint8Array(restoration.content.bytes);
                    return { nativeText: EXACT_REBASED_NATIVE_TEXT };
                },
            },
        });
        const contract = fixture.restorationDialects[0]!;
        fixture.analysisInput.dialectInputs[0]!.inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId,
                restorationContractFingerprint: computeRestorationDialectContractFingerprint(contract.definition),
                contentHash: binaryPayloadStats(bytes).contentHash,
            },
            content: { contentKind: "binary", bytes },
        });
        expect(validateAdapterRenderContractRegistration([asExactFileProvider(fixture)])).toEqual([]);
        expect(fixture.support.analyze(fixture.analysisInput).status).toBe("complete");
        expect(fixture.support.materialize(exactMaterializationInput(fixture))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ content: { contentKind: "text", text: EXACT_REBASED_NATIVE_TEXT } }] }],
        });
        expect(received).toEqual(bytes);
    });

    it("Core rejects a Provider rebase whose native-only shell contradicts the target canonical metadata", async () => {
        const fixture = makeParentRebaseFixture();
        const providerAnalysis = fixture.support.analyze(fixture.analysisInput);
        if (providerAnalysis.status !== "complete") throw new Error("parent rebase analysis fixture failed");
        const providerSelection = exactMaterializationInput(fixture).selection;
        const selectionPreimage = {
            schemaVersion: 1 as const,
            compilerPolicyVersion: "core_render_policy_v1" as const,
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            semanticOptions: providerSelection.semanticOptions.map((option) => ({
                ...option,
                consumerOwnerAdapterId: fixture.provider.adapterId,
                consumerOwnerAdapterVersion: fixture.provider.version,
                approval: { approvalState: "not_required" as const },
            })),
            outputUnits: providerSelection.outputUnits,
            outputUnitRenderers: providerSelection.outputUnitRenderers,
            promotionAuthorizations: [],
        };
        const selection = {
            ...selectionPreimage,
            selectionFingerprint: computeRenderSelectionFingerprint(selectionPreimage),
        };
        const run = (forge: boolean) =>
            materializeRenderDeployment(
                {
                    deployment: fixture.deployment,
                    analysis: {
                        renderInputFingerprint: fixture.deployment.renderInputFingerprint,
                        requiredSemantics: fixture.requiredSemantics,
                        analyses: [
                            {
                                ...providerAnalysis,
                                adapterId: fixture.provider.adapterId,
                                adapterVersion: fixture.provider.version,
                            },
                        ],
                    },
                    selection,
                },
                {
                    registry: fixture.registry,
                    dialectRegistry: createVersionDialectRegistry([fixture.nativeDialect], [], [], []),
                    resolveDialectInputs: () => structuredClone(fixture.analysisInput.dialectInputs),
                    dispatch: async (_adapterId, input) => {
                        const result = fixture.support.materialize(input);
                        if (forge && result.materializationState === "materialized") {
                            result.materializedUnits[0]!.files[0]!.content = {
                                contentKind: "text",
                                text: EXACT_REBASED_NATIVE_TEXT.replace(
                                    "description: Review foreign changes",
                                    "description: Review changes",
                                ),
                            };
                        }
                        return { status: "complete" as const, value: result, diagnostics: [] };
                    },
                },
            );
        expect((await run(false)).status).toBe("complete");
        const forged = await run(true);
        expect(forged.status).toBe("failed");
        expect(forged.diagnostics[0]?.code).toBe("render.native_consistency_failed");
    });
});
