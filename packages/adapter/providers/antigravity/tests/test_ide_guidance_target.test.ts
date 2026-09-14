import * as crypto from "node:crypto";
import type { RenderAnalysisInput, RenderedTargetInspectionInput, RenderMaterializationInput, Sha256Digest } from "@oaam/core";
import { describe, expect, it } from "vitest";
import { makeNativeProjectGuidanceContractParts } from "../../../core/src/render/native-project-guidance-profiles";
import { antigravityProvider } from "../src/antigravity-provider";
import {
    createAntigravityAppGuidanceTargetSupports,
    createAntigravityIdeGuidanceTargetSupports,
} from "../src/antigravity-target-ide-guidance";

type Variant = "project" | "global";

const HASH = `sha256:${"5".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const ORIGINAL = "# Antigravity IDE guidance\n\nOAAM_PHASE55_IDE_GUIDANCE.\n";
const CHANGED = ORIGINAL.replace("GUIDANCE", "GUIDANCE_REVERSE");

const supports = createAntigravityIdeGuidanceTargetSupports({
    adapterVersion: antigravityProvider.version,
    agentRuntimes: antigravityProvider.agentRuntimes,
});
const appSupports = createAntigravityAppGuidanceTargetSupports({
    adapterVersion: antigravityProvider.version,
    agentRuntimes: antigravityProvider.agentRuntimes,
});

describe("Antigravity IDE exact Guidance targets", () => {
    it.each([
        "project",
        "global",
    ] as const)("materializes and reverses exact %s Guidance through the Provider dispatch", async (variant) => {
        const fixture = analysisInput(variant);
        const analysis = await antigravityProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.outputUnits).toEqual([
            expect.objectContaining({
                claims: [{ relativePath: targetPath(variant), contentKind: "text", executable: false }],
                managedDirectoryBoundaries: [],
            }),
        ]);

        const materialization = materializationInput(fixture, analysis, variant);
        await expect(antigravityProvider.materializeRender(materialization)).resolves.toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: targetPath(variant), content: { text: ORIGINAL } }] }],
        });
        await expect(antigravityProvider.inspectRenderedTarget(inspectionInput(materialization))).resolves.toMatchObject({
            status: "complete",
            files: [{ relativePath: targetPath(variant), attributionState: "uniquely_attributable" }],
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: CHANGED } }],
        });
    });

    it("warns without blocking when a newer comparable IDE build uses the nearest exact cell anchor", async () => {
        const fixture = analysisInput("project");
        const context = fixture.deployment.targetContexts[0];
        if (context === undefined) throw new Error("IDE Guidance target context is missing");
        context.versionText = "1.108.0";
        context.buildIdentity = `sha256:${"9".repeat(64)}`;

        expect(await antigravityProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            diagnostics: [
                expect.objectContaining({
                    code: "antigravity_target_build_compatibility_inferred",
                    severity: "warning",
                }),
            ],
        });
    });

    it("fails closed when one Deployment mixes Project and Global Guidance ownership", async () => {
        const fixture = analysisInput("project");
        const projectAsset = fixture.deployment.assets[0];
        if (projectAsset === undefined) throw new Error("IDE Guidance project asset is missing");
        fixture.deployment.assets.push({
            ...structuredClone(projectAsset),
            scope: "global",
            projectId: "",
        });

        expect(await antigravityProvider.analyzeRender(fixture)).toMatchObject({
            status: "failed",
            outputUnits: [],
            diagnostics: [{ code: "antigravity_ide_target_scope_ambiguous", severity: "error" }],
        });
    });

    it.each([
        "project",
        "global",
    ] as const)("dispatches App %s Guidance through analysis, materialization, and reverse", async (variant) => {
        const fixture = analysisInput(variant, "app");
        const analysis = await antigravityProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        const materialization = materializationInput(fixture, analysis, variant, appSupports);
        await expect(antigravityProvider.materializeRender(materialization)).resolves.toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ relativePath: targetPath(variant), content: { text: ORIGINAL } }] }],
        });
        await expect(antigravityProvider.inspectRenderedTarget(inspectionInput(materialization))).resolves.toMatchObject({
            status: "complete",
            files: [{ attributionState: "uniquely_attributable" }],
        });
    });
});

function analysisInput(variant: Variant, entry: "ide" | "app" = "ide"): RenderAnalysisInput {
    const selectedSupports = entry === "ide" ? supports : appSupports;
    const support = supportFor(variant, selectedSupports);
    const build = support.renderContractDeclaration.verifiedBuilds[0];
    if (build === undefined) throw new Error("IDE Guidance verified build is missing");
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: build.platform,
            platformInstanceId: `test-${build.platform}`,
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: entry === "ide" ? "ANTIGRAVITY_IDE" : "ANTIGRAVITY_APP",
                    versionText: build.versionText,
                    buildIdentity: build.buildIdentity,
                    targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
                    renderFacts: [
                        { key: "oaam.platform", value: build.platform, evidenceLevel: "agent_runtime_verified" },
                        ...(variant === "project"
                            ? [
                                  {
                                      key: "oaam.project-binding",
                                      value: "registered",
                                      evidenceLevel: "agent_runtime_verified" as const,
                                  },
                              ]
                            : []),
                    ],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [
                {
                    scope: variant,
                    projectId: variant === "project" ? PROJECT_ID : "",
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
                                text: ORIGINAL,
                                file: {
                                    fileId: FILE_ID,
                                    logicalPath: targetPath(variant),
                                    role: "entry",
                                    contentHash: sha256Text(ORIGINAL),
                                    contentKind: "text",
                                    mediaType: "text/markdown",
                                    byteSize: Buffer.byteLength(ORIGINAL),
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
            semantic("asset.file_inventory", "asset", entry),
            semantic("guidance.base_context", "asset", entry),
            semantic("guidance.content", "file", entry),
        ],
        dialectInputs: [],
    };
}

function materializationInput(
    fixture: RenderAnalysisInput,
    analysis: Awaited<ReturnType<typeof antigravityProvider.analyzeRender>>,
    variant: Variant,
    selectedSupports = supports,
): RenderMaterializationInput {
    if (analysis.status !== "complete") throw new Error("IDE Guidance analysis did not close");
    const support = supportFor(variant, selectedSupports);
    const contract = makeNativeProjectGuidanceContractParts(support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("IDE Guidance materialization profile is missing");
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
                rendererAdapterId: "ANTIGRAVITY",
                rendererAdapterVersion: antigravityProvider.version,
                materializerCapabilityKey: support.materializerCapability.materializerCapabilityKey,
                materializationProfileId: support.renderContractDeclaration.materializationProfileId,
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
    if (unit === undefined) throw new Error("IDE Guidance output unit is missing");
    const relativePath = unit.claims[0]?.relativePath;
    if (relativePath === undefined) throw new Error("IDE Guidance output claim is missing");
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
                consumerOwnerAdapterId: "ANTIGRAVITY",
                consumerOwnerAdapterVersion: antigravityProvider.version,
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
                    relativePath,
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
                relativePath,
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
                    semanticRefFingerprints: materialization.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint),
                    sectionBindings: [],
                    materializationFingerprint: HASH,
                    provenanceFingerprint: HASH,
                },
            },
        ],
        inventoryDeltas: [],
    };
}

function semantic(semanticKind: string, subjectKind: "asset" | "file", entry: "ide" | "app" = "ide") {
    return {
        semanticRefFingerprint: sha256Text(`${semanticKind}:${subjectKind}`),
        consumerAgentRuntimeId: entry === "ide" ? "ANTIGRAVITY_IDE" : "ANTIGRAVITY_APP",
        subject:
            subjectKind === "asset"
                ? { subjectKind: "asset" as const, assetId: ASSET_ID, versionId: VERSION_ID }
                : { subjectKind: "file" as const, assetId: ASSET_ID, versionId: VERSION_ID, fileId: FILE_ID },
        semanticKind,
    };
}

function supportFor(variant: Variant, selectedSupports = supports) {
    return variant === "project" ? selectedSupports.project : selectedSupports.global;
}

function targetPath(variant: Variant): string {
    return variant === "project" ? "AGENTS.md" : "GEMINI.md";
}

function sha256Text(text: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}
