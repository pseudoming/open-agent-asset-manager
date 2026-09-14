import * as crypto from "node:crypto";
import type {
    AdapterProviderSummary,
    RenderAnalysisInput,
    RenderedTargetInspectionInput,
    RenderMaterializationInput,
    Sha256Digest,
} from "@oaam/core";
import { describe, expect, it } from "vitest";
import {
    makeVerifiedNativeProjectGuidanceTargetContextForTest,
    nativeProjectGuidanceRegistryComponents,
} from "../../../core/src/render/native-project-guidance";
import { claudecodeProvider } from "../src/claudecode-provider";

const HASH = `sha256:${"9".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const FILE_ID = "33333333-3333-4333-8333-333333333333";
const GUIDANCE_TEXT = "# Claude App project guidance\n";
const CHANGED_TEXT = "# Claude App changed guidance\n";

function providerSummary(): AdapterProviderSummary {
    return {
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
    };
}

function input(): RenderAnalysisInput {
    const declaration = claudecodeProvider.renderContractDeclarations.find(
        (candidate) =>
            candidate.declarationKind === "native_project_guidance_v1" && candidate.agentRuntimeId === "CLAUDE_CODE_APP",
    );
    const build = declaration?.verifiedBuilds[0];
    if (build === undefined) throw new Error("Claude App verified Guidance build is missing");
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: "win32",
            targetContexts: [makeVerifiedNativeProjectGuidanceTargetContextForTest({ provider: providerSummary(), build })],
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
                        canonical: { kind: "Guidance", typeData: { schemaVersion: 1 } },
                        files: [
                            {
                                contentKind: "text",
                                text: GUIDANCE_TEXT,
                                file: {
                                    fileId: FILE_ID,
                                    logicalPath: "GUIDANCE.md",
                                    role: "entry",
                                    contentHash: sha256Text(GUIDANCE_TEXT),
                                    contentKind: "text",
                                    mediaType: "text/markdown",
                                    byteSize: Buffer.byteLength(GUIDANCE_TEXT),
                                    executable: false,
                                    references: [],
                                },
                            },
                        ],
                    },
                    sectionHandles: { [FILE_ID]: "guidance-entry" },
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            semantic("1", "asset.file_inventory"),
            semantic("2", "guidance.base_context"),
            semantic("3", "guidance.content", FILE_ID),
        ],
        dialectInputs: [],
    };
}

function globalInput(agentRuntimeId: "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP"): RenderAnalysisInput {
    const fixture = input();
    const declaration = claudecodeProvider.renderContractDeclarations.find(
        (candidate) => candidate.declarationKind === "native_global_guidance_v1" && candidate.agentRuntimeId === agentRuntimeId,
    );
    const build = declaration?.verifiedBuilds[0];
    const schema = claudecodeProvider.targetContextSchemas.find(
        (candidate) => candidate.targetContextSchemaId === declaration?.target.targetContextSchemaId,
    );
    const asset = fixture.deployment.assets[0];
    if (declaration === undefined || build === undefined || schema === undefined || asset === undefined) {
        throw new Error("Claude global Guidance fixture is incomplete");
    }
    fixture.deployment.platform = build.platform;
    fixture.deployment.platformInstanceId = `test-${build.platform}`;
    fixture.deployment.targetContexts = [
        {
            schemaVersion: 1,
            agentRuntimeId,
            versionText: build.versionText,
            buildIdentity: build.buildIdentity,
            targetContextSchemaId: schema.targetContextSchemaId,
            targetContextSchemaFingerprint: schema.schemaFingerprint,
            renderFacts: [{ key: "oaam.platform", value: build.platform, evidenceLevel: "agent_runtime_verified" }],
            targetApplicabilityFingerprint: HASH,
        },
    ];
    asset.scope = "global";
    asset.projectId = "";
    for (const required of fixture.requiredSemantics) required.consumerAgentRuntimeId = agentRuntimeId;
    return fixture;
}

function semantic(character: string, semanticKind: string, fileId?: string) {
    return {
        semanticRefFingerprint: `sha256:${character.repeat(64)}`,
        consumerAgentRuntimeId: "CLAUDE_CODE_APP",
        subject:
            fileId === undefined
                ? { subjectKind: "asset" as const, assetId: ASSET_ID, versionId: VERSION_ID }
                : { subjectKind: "file" as const, assetId: ASSET_ID, versionId: VERSION_ID, fileId },
        semanticKind,
    };
}

function materializationInput(
    analysisInput: RenderAnalysisInput,
    analysis: Awaited<ReturnType<typeof claudecodeProvider.analyzeRender>>,
): RenderMaterializationInput {
    if (analysis.status !== "complete") throw new Error("Claude App Guidance analysis did not close");
    const unit = analysis.outputUnits[0];
    const capability = claudecodeProvider.materializerCapabilities.find(
        (candidate) => candidate.outputContractId === unit?.outputContractId,
    );
    const profile = nativeProjectGuidanceRegistryComponents([providerSummary()]).outputContracts.find(
        (candidate) => candidate.outputContractId === unit?.outputContractId,
    )?.materializationProfiles[0];
    if (unit === undefined || capability === undefined || profile === undefined) {
        throw new Error("Claude App Guidance materialization fixture is incomplete");
    }
    return {
        schemaVersion: 1,
        deployment: structuredClone(analysisInput.deployment),
        requiredSemantics: structuredClone(analysisInput.requiredSemantics),
        dialectInputs: [],
        selection: {
            schemaVersion: 1,
            outputUnits: [unit],
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
            semanticOptions: analysis.semanticOptions.map((option) => ({
                optionFingerprint: option.optionFingerprint,
                semanticRefFingerprint: option.semanticRefFingerprint,
                renderStrategy: option.renderStrategy,
                actualReverseExtractPolicy: option.actualReverseExtractPolicy,
                requiredOutputUnitFingerprints: option.requiredOutputUnitFingerprints,
                outcome: "preserved" as const,
            })),
        },
    };
}

function inspectionInput(materialization: RenderMaterializationInput): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0];
    if (unit === undefined) throw new Error("Claude App Guidance output unit is missing");
    return {
        schemaVersion: 1,
        deploymentId: "55555555-5555-4555-8555-555555555555",
        appliedRenderSnapshot: {
            schemaVersion: 1,
            snapshotState: "applied",
            renderInputFingerprint: HASH,
            compilerPolicyVersion: "core_render_policy_v1",
            selectionFingerprint: HASH,
            compilationFingerprint: HASH,
            decisions: materialization.requiredSemantics.map((semantic) => ({
                semanticRef: semantic,
                consumerOwnerAdapterId: claudecodeProvider.adapterId,
                consumerOwnerAdapterVersion: claudecodeProvider.version,
                optionFingerprint: HASH,
                renderStrategy: "native_file",
                actualReverseExtractPolicy: "can_reconcile",
                outputUnitFingerprints: [unit.outputUnitFingerprint],
                outcome: "preserved",
            })),
            outputUnits: [unit],
            outputUnitRenderers: materialization.selection.outputUnitRenderers,
            semanticCoverageProofs: [],
        },
        inspectionScope: {
            inspectionScopeFingerprint: HASH,
            fileStates: [
                {
                    relativePath: "CLAUDE.md",
                    state: "changed",
                    appliedContentHash: sha256Text(GUIDANCE_TEXT),
                    currentContentHash: sha256Text(CHANGED_TEXT),
                    appliedExecutable: false,
                    currentExecutable: false,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    provenanceFingerprint: HASH,
                },
            ],
            directoryInventories: [],
        },
        files: [
            {
                fileState: "baseline_changed",
                relativePath: "CLAUDE.md",
                appliedContent: { contentKind: "text", text: GUIDANCE_TEXT },
                currentContent: { contentKind: "text", text: CHANGED_TEXT },
                diffHunks: [
                    {
                        hunkFingerprint: HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(GUIDANCE_TEXT),
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(CHANGED_TEXT),
                    },
                ],
                attributeChanges: [],
                provenance: {
                    schemaVersion: 1,
                    appliedRenderSnapshotFingerprint: HASH,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    semanticRefFingerprints: materialization.requiredSemantics.map((item) => item.semanticRefFingerprint),
                    sectionBindings: [],
                    materializationFingerprint: HASH,
                    provenanceFingerprint: HASH,
                },
            },
        ],
        inventoryDeltas: [],
    };
}

function sha256Text(value: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

describe("Claude Code App exact project Guidance target", () => {
    it("routes the App-owned contract through materialization and whole-file reverse", async () => {
        const fixture = input();
        expect(fixture.deployment.targetContexts).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CLAUDE_CODE_APP",
                targetContextSchemaId: "CLAUDE_CODE_APP_PROJECT_GUIDANCE_TARGET_V1",
                versionText: "2.1.219",
                renderFacts: [{ key: "oaam.platform", value: "win32", evidenceLevel: "agent_runtime_verified" }],
            }),
        ]);
        const analysis = await claudecodeProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.outputUnits).toEqual([
            expect.objectContaining({
                outputContractId: "CLAUDECODE_APP_NATIVE_PROJECT_GUIDANCE_V1",
                claims: [{ relativePath: "CLAUDE.md", contentKind: "text", executable: false }],
            }),
        ]);
        const materialization = materializationInput(fixture, analysis);
        await expect(claudecodeProvider.materializeRender(materialization)).resolves.toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: "CLAUDE.md", content: { text: GUIDANCE_TEXT } }] }],
        });
        await expect(claudecodeProvider.inspectRenderedTarget(inspectionInput(materialization))).resolves.toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: CHANGED_TEXT } }],
            files: [{ relativePath: "CLAUDE.md", attributionState: "uniquely_attributable" }],
        });
    });

    it.each([
        "CLAUDE_CODE_CLI",
        "CLAUDE_CODE_APP",
    ] as const)("routes %s user-global Guidance through the scope-specific facade and whole-file reverse", async (agentRuntimeId) => {
        const fixture = globalInput(agentRuntimeId);
        const analysis = await claudecodeProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [] });
        expect(analysis.diagnostics).toEqual(
            agentRuntimeId === "CLAUDE_CODE_CLI"
                ? [
                      expect.objectContaining({
                          code: "claudecode_target_build_compatibility_inferred",
                          severity: "warning",
                      }),
                  ]
                : [],
        );
        const expectedContract =
            agentRuntimeId === "CLAUDE_CODE_APP"
                ? "CLAUDECODE_APP_NATIVE_GLOBAL_GUIDANCE_V1"
                : "CLAUDECODE_NATIVE_GLOBAL_GUIDANCE_V1";
        expect(analysis.outputUnits).toEqual([
            expect.objectContaining({
                outputContractId: expectedContract,
                claims: [{ relativePath: "CLAUDE.md", contentKind: "text", executable: false }],
            }),
        ]);
        const materialization = materializationInput(fixture, analysis);
        await expect(claudecodeProvider.materializeRender(materialization)).resolves.toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: "CLAUDE.md", content: { text: GUIDANCE_TEXT } }] }],
        });
        await expect(claudecodeProvider.inspectRenderedTarget(inspectionInput(materialization))).resolves.toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: CHANGED_TEXT } }],
            files: [{ relativePath: "CLAUDE.md", attributionState: "uniquely_attributable" }],
        });
    });
});
