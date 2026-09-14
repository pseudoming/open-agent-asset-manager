import * as crypto from "node:crypto";
import type { RenderAnalysisInput, RenderedTargetInspectionInput, RenderMaterializationInput, Sha256Digest } from "@oaam/core";
import { describe, expect, it } from "vitest";
import { makeNativeProjectGuidanceContractParts } from "../../../core/src/render/native-project-guidance-profiles";
import { cursorProvider } from "../src/cursor-provider";

const HASH = `sha256:${"6".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const ORIGINAL = "# Cursor guidance\n\nOAAM_PHASE58_CURSOR_GUIDANCE_4F2A19.\n";
const CHANGED = ORIGINAL.replace("4F2A19", "7C8D9E");
const declaration = cursorProvider.renderContractDeclarations.find(
    (row) => row.declarationKind === "native_project_guidance_v1" && row.agentRuntimeId === "CURSOR_AGENT_CLI",
);
if (declaration === undefined || declaration.declarationKind !== "native_project_guidance_v1") {
    throw new Error("Cursor Guidance declaration missing");
}
const schema = cursorProvider.targetContextSchemas.find(
    (row) => row.targetContextSchemaId === declaration.target.targetContextSchemaId,
);
const materializer = cursorProvider.materializerCapabilities.find((row) => row.outputContractId === declaration.outputContractId);
if (schema === undefined || materializer === undefined) throw new Error("Cursor Guidance target support is incomplete");

describe("Cursor Agent CLI exact project Guidance target", () => {
    it("dispatches analysis, materialization, and body reverse through the built-in Provider", async () => {
        const fixture = analysisInput();
        const analysis = await cursorProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.outputUnits).toEqual([
            expect.objectContaining({
                claims: [{ relativePath: "AGENTS.md", contentKind: "text", executable: false }],
                managedDirectoryBoundaries: [],
            }),
        ]);

        const materialization = materializationInput(fixture, analysis);
        await expect(cursorProvider.materializeRender(materialization)).resolves.toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: "AGENTS.md", content: { text: ORIGINAL } }] }],
        });
        await expect(cursorProvider.inspectRenderedTarget(inspectionInput(materialization))).resolves.toMatchObject({
            status: "complete",
            files: [{ relativePath: "AGENTS.md", attributionState: "uniquely_attributable" }],
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: CHANGED } }],
        });
    });

    it("keeps the exact WSL anchor distinct from compatible newer builds", async () => {
        expect(await cursorProvider.analyzeRender(analysisInput())).toMatchObject({ status: "complete", diagnostics: [] });
        const newer = analysisInput();
        const context = newer.deployment.targetContexts[0];
        if (context === undefined) throw new Error("Cursor target context missing");
        context.versionText = "2026.08.01-next";
        context.buildIdentity = `sha256:${"7".repeat(64)}`;
        expect(await cursorProvider.analyzeRender(newer)).toMatchObject({
            status: "complete",
            diagnostics: [{ code: "cursor_target_build_compatible_unverified", severity: "warning" }],
        });
    });
});

function analysisInput(): RenderAnalysisInput {
    const build = declaration.verifiedBuilds[0];
    if (build === undefined) throw new Error("Cursor Guidance verified build missing");
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: "wsl",
            platformInstanceId: "wsl:test",
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: "CURSOR_AGENT_CLI",
                    versionText: build.versionText,
                    buildIdentity: build.buildIdentity,
                    targetContextSchemaId: schema.targetContextSchemaId,
                    targetContextSchemaFingerprint: schema.schemaFingerprint,
                    renderFacts: [
                        { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
                        { key: "oaam.project-binding", value: "registered", evidenceLevel: "agent_runtime_verified" },
                    ],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [
                {
                    scope: "project",
                    projectId: PROJECT_ID,
                    scopePath: "",
                    allowIncomplete: false,
                    version: {
                        ref: { assetId: ASSET_ID, versionId: VERSION_ID },
                        versionFingerprint: HASH,
                        versionCanonicalContentFingerprint: HASH,
                        status: "complete",
                        canonical: { kind: "Guidance", typeData: { schemaVersion: 1 } },
                        files: [textFile(ORIGINAL)],
                    },
                    sectionHandles: { [FILE_ID]: "guidance-entry" },
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            semantic("asset.file_inventory", "asset", "1"),
            semantic("guidance.base_context", "asset", "2"),
            semantic("guidance.content", "file", "3"),
        ],
        dialectInputs: [],
    };
}

function materializationInput(
    fixture: RenderAnalysisInput,
    analysis: Awaited<ReturnType<typeof cursorProvider.analyzeRender>>,
): RenderMaterializationInput {
    if (analysis.status !== "complete") throw new Error("Cursor Guidance analysis did not close");
    const contract = makeNativeProjectGuidanceContractParts(declaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Cursor Guidance materialization profile missing");
    return {
        schemaVersion: 1,
        deployment: structuredClone(fixture.deployment),
        requiredSemantics: structuredClone(fixture.requiredSemantics),
        dialectInputs: [],
        selection: {
            schemaVersion: 1,
            outputUnits: analysis.outputUnits,
            outputUnitRenderers: analysis.outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                rendererAdapterId: "CURSOR",
                rendererAdapterVersion: cursorProvider.version,
                materializerCapabilityKey: materializer.materializerCapabilityKey,
                materializationProfileId: declaration.materializationProfileId,
                profileConstraintFingerprint: profile.profileConstraintFingerprint,
            })),
            semanticOptions: analysis.semanticOptions.map((option) => ({
                optionFingerprint: option.optionFingerprint,
                semanticRefFingerprint: option.semanticRefFingerprint,
                renderStrategy: option.renderStrategy,
                actualReverseExtractPolicy: option.actualReverseExtractPolicy,
                requiredOutputUnitFingerprints: option.requiredOutputUnitFingerprints,
                outcome: "preserved",
            })),
        },
    };
}

function inspectionInput(materialization: RenderMaterializationInput): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0];
    if (unit === undefined) throw new Error("Cursor Guidance output unit missing");
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
            decisions: materialization.requiredSemantics.map((item) => ({
                semanticRef: item,
                consumerOwnerAdapterId: "CURSOR",
                consumerOwnerAdapterVersion: cursorProvider.version,
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
                    relativePath: "AGENTS.md",
                    state: "changed",
                    appliedContentHash: sha256Text(ORIGINAL),
                    currentContentHash: sha256Text(CHANGED),
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
                relativePath: "AGENTS.md",
                appliedContent: { contentKind: "text", text: ORIGINAL },
                currentContent: { contentKind: "text", text: CHANGED },
                diffHunks: [
                    {
                        hunkFingerprint: HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(ORIGINAL),
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(CHANGED),
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

function semantic(kind: string, subjectKind: "asset" | "file", digit: string) {
    return {
        semanticRefFingerprint: `sha256:${digit.repeat(64)}`,
        consumerAgentRuntimeId: "CURSOR_AGENT_CLI",
        subject:
            subjectKind === "asset"
                ? { subjectKind, assetId: ASSET_ID, versionId: VERSION_ID }
                : { subjectKind, assetId: ASSET_ID, versionId: VERSION_ID, fileId: FILE_ID },
        semanticKind: kind,
    } as RenderAnalysisInput["requiredSemantics"][number];
}

function textFile(text: string) {
    return {
        contentKind: "text" as const,
        text,
        file: {
            fileId: FILE_ID,
            logicalPath: "AGENTS.md",
            role: "entry" as const,
            contentHash: sha256Text(text),
            contentKind: "text" as const,
            mediaType: "text/markdown",
            byteSize: Buffer.byteLength(text),
            executable: false,
            references: [],
        },
    };
}

function sha256Text(text: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}
