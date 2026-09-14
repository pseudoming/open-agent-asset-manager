/** Exact Provider-level materialization proof for the first Claude Code Rule target cell. */

import { describe, expect, it } from "vitest";
import type { RenderAnalysisInput, RenderMaterializationInput, Sha256Digest } from "../../packages/core/src/types";
import { adapterRenderRegistryComponents } from "../../packages/core/src/render/adapter-render-contract-registration";
import { canonicalMaterializationValidatorsForProviders } from "../../packages/core/src/render/canonical-materialization-validation";
import { claudecodeProvider } from "../../packages/adapter/providers/claudecode/src/claudecode-provider";

const HASH = `sha256:${"7".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const FILE_ID = "33333333-3333-4333-8333-333333333333";
const RULE_TEXT = "# Review TypeScript changes\n";

function analysisInput(): RenderAnalysisInput {
    const schema = claudecodeProvider.targetContextSchemas[0];
    if (schema === undefined) throw new Error("Claude Code target schema is missing");
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: "wsl",
            platformInstanceId: "test-wsl",
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: "CLAUDE_CODE_CLI",
                    versionText: "2.1.191",
                    buildIdentity: "sha256:1038dba88bdf1b80941dc3e383e93b088325b00497329ac50da460c8786d5bee",
                    targetContextSchemaId: schema.targetContextSchemaId,
                    targetContextSchemaFingerprint: schema.schemaFingerprint,
                    renderFacts: [{ key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" }],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [
                {
                    scope: "project",
                    projectId: "44444444-4444-4444-8444-444444444444",
                    scopePath: "",
                    allowIncomplete: false,
                    version: {
                        ref: { assetId: ASSET_ID, versionId: VERSION_ID },
                        versionFingerprint: HASH,
                        versionCanonicalContentFingerprint: HASH,
                        status: "complete",
                        canonical: {
                            kind: "Rule",
                            typeData: {
                                schemaVersion: 2,
                                name: "typescript-review",
                                description: "",
                                activation: { mode: "always" },
                            },
                        },
                        files: [
                            {
                                contentKind: "text",
                                text: RULE_TEXT,
                                file: {
                                    fileId: FILE_ID,
                                    logicalPath: "rule.md",
                                    role: "entry",
                                    contentHash: HASH,
                                    contentKind: "text",
                                    mediaType: "text/markdown",
                                    byteSize: Buffer.byteLength(RULE_TEXT),
                                    executable: false,
                                    references: [],
                                },
                            },
                        ],
                    },
                    sectionHandles: { [FILE_ID]: "rule-entry" },
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            {
                semanticRefFingerprint: `sha256:${"1".repeat(64)}`,
                consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
                subject: { subjectKind: "asset", assetId: ASSET_ID, versionId: VERSION_ID },
                semanticKind: "asset.file_inventory",
            },
            {
                semanticRefFingerprint: `sha256:${"2".repeat(64)}`,
                consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
                subject: { subjectKind: "asset", assetId: ASSET_ID, versionId: VERSION_ID },
                semanticKind: "rule.activation",
            },
            {
                semanticRefFingerprint: `sha256:${"3".repeat(64)}`,
                consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
                subject: { subjectKind: "file", assetId: ASSET_ID, versionId: VERSION_ID, fileId: FILE_ID },
                semanticKind: "rule.content",
            },
        ],
        dialectInputs: [],
    } as RenderAnalysisInput;
}

describe("Claude Code CLI exact Rule target conformance", () => {
    it("materializes the canonical body at the exact native project path", async () => {
        const input = analysisInput();
        const analysis = await claudecodeProvider.analyzeRender(input);
        expect(analysis.status).toBe("complete");
        const unit = analysis.outputUnits[0];
        if (unit === undefined) throw new Error("Rule analysis produced no output unit");
        const components = adapterRenderRegistryComponents(
            [
                {
                    adapterId: claudecodeProvider.adapterId,
                    displayName: claudecodeProvider.displayName,
                    version: claudecodeProvider.version,
                    enabled: true,
                    agentRuntimes: claudecodeProvider.agentRuntimes,
                    targetContextSchemas: claudecodeProvider.targetContextSchemas,
                    assetSourceCapabilities: claudecodeProvider.assetSourceCapabilities,
                    assetTargetCapabilities: claudecodeProvider.assetTargetCapabilities,
                    materializerCapabilities: claudecodeProvider.materializerCapabilities,
                    renderContractDeclarations: claudecodeProvider.renderContractDeclarations,
                },
            ],
            canonicalMaterializationValidatorsForProviders([claudecodeProvider]),
        );
        const contract = components.outputContracts.find(
            (candidate) => candidate.outputContractId === "CLAUDECODE_NATIVE_PROJECT_RULE_V1",
        );
        const profile = contract?.materializationProfiles.find(
            (candidate) => candidate.materializationProfileId === "claude-code-cli-project-rule-v1",
        );
        const capability = claudecodeProvider.materializerCapabilities.find(
            (candidate) => candidate.outputContractId === "CLAUDECODE_NATIVE_PROJECT_RULE_V1",
        );
        if (profile === undefined || capability === undefined) throw new Error("Rule materializer contract is missing");
        const materializationInput: RenderMaterializationInput = {
            ...input,
            selection: {
                schemaVersion: 1,
                outputUnits: analysis.outputUnits,
                outputUnitRenderers: [
                    {
                        outputUnitFingerprint: unit.outputUnitFingerprint,
                        rendererAdapterId: claudecodeProvider.adapterId,
                        rendererAdapterVersion: claudecodeProvider.version,
                        materializerCapabilityKey: capability.materializerCapabilityKey,
                        materializationProfileId: profile.materializationProfileId,
                        profileConstraintFingerprint: profile.profileConstraintFingerprint,
                    },
                ],
                semanticOptions: analysis.semanticOptions.map((option) => {
                    if (option.outcome !== "preserved") throw new Error("exact Rule option unexpectedly degraded");
                    return {
                        optionFingerprint: option.optionFingerprint,
                        semanticRefFingerprint: option.semanticRefFingerprint,
                        renderStrategy: option.renderStrategy,
                        actualReverseExtractPolicy: option.actualReverseExtractPolicy,
                        requiredOutputUnitFingerprints: option.requiredOutputUnitFingerprints,
                        outcome: "preserved" as const,
                    };
                }),
            },
        };

        const materialized = await claudecodeProvider.materializeRender(materializationInput);

        expect(materialized).toEqual({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                {
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    files: [
                        {
                            relativePath: ".claude/rules/typescript-review.md",
                            content: { contentKind: "text", text: RULE_TEXT },
                            executable: false,
                            semanticRefFingerprints: input.requiredSemantics
                                .map((semantic) => semantic.semanticRefFingerprint)
                                .sort(),
                            sectionBindings: [],
                        },
                    ],
                },
            ],
            diagnostics: [],
        });
    });
});
