import { describe, expect, it } from "vitest";
import { claudecodeProvider } from "../src/claudecode-provider";

describe("Claude Code provider target boundary", () => {
    it("fails closed at the Framework boundary for malformed target closures", async () => {
        const outputContractId = claudecodeProvider.materializerCapabilities[0]?.outputContractId;
        if (outputContractId === undefined) throw new Error("Claude Code Guidance materializer fixture is missing");
        const outputUnit = { outputUnitFingerprint: "sha256:foreign", outputContractId };
        const analysis = await claudecodeProvider.analyzeRender({
            deployment: {
                assets: [
                    {
                        version: {
                            ref: { assetId: "asset", versionId: "version" },
                            canonical: { kind: "Guidance" },
                        },
                    },
                ],
                targetContexts: [],
            },
            requiredSemantics: [
                {
                    semanticRefFingerprint: "sha256:semantic",
                    consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
                    subject: { subjectKind: "asset", assetId: "asset", versionId: "version" },
                },
            ],
            dialectInputs: [],
        } as never);
        expect(analysis).toMatchObject({ status: "failed", outputUnits: [], semanticOptions: [] });
        expect(analysis.blockedSemanticRefs).toEqual([
            expect.objectContaining({
                semanticRefFingerprint: "sha256:semantic",
                reasonCode: "claudecode_guidance_variant_closure_invalid",
            }),
        ]);
        expect(
            await claudecodeProvider.materializeRender({
                deployment: { assets: [], targetContexts: [] },
                requiredSemantics: [],
                dialectInputs: [],
                selection: {
                    outputUnits: [outputUnit],
                    outputUnitRenderers: [],
                    semanticOptions: [],
                },
            } as never),
        ).toMatchObject({ status: "failed", materializationState: "blocked" });
        expect(
            await claudecodeProvider.inspectRenderedTarget({
                files: [{ relativePath: "foreign.md" }],
                inventoryDeltas: [],
                appliedRenderSnapshot: { decisions: [], outputUnits: [outputUnit] },
                inspectionScope: {
                    fileStates: [{ relativePath: "foreign.md", outputUnitFingerprint: outputUnit.outputUnitFingerprint }],
                    directoryInventories: [],
                },
            } as never),
        ).toMatchObject({ status: "failed", changes: [], files: [] });
    });
});
