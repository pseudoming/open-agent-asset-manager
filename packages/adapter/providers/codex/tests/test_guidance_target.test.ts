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
import { codexProvider } from "../src/codex-provider";

const HASH = `sha256:${"9".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const FILE_ID = "33333333-3333-4333-8333-333333333333";
const GUIDANCE_TEXT = "# Project guidance\n";
const CHANGED_GUIDANCE_TEXT = "# User-edited project guidance\n";

function providerSummary(): AdapterProviderSummary {
    return {
        adapterId: codexProvider.adapterId,
        displayName: codexProvider.displayName,
        version: codexProvider.version,
        enabled: true,
        agentRuntimes: codexProvider.agentRuntimes,
        targetContextSchemas: codexProvider.targetContextSchemas,
        assetSourceCapabilities: codexProvider.assetSourceCapabilities,
        assetTargetCapabilities: codexProvider.assetTargetCapabilities,
        materializerCapabilities: codexProvider.materializerCapabilities,
        renderContractDeclarations: codexProvider.renderContractDeclarations,
    };
}

function targetContext(agentRuntimeId: "CODEX_CLI" | "CODEX_APP" = "CODEX_CLI", versionText?: string) {
    const declaration = codexProvider.renderContractDeclarations.find(
        (candidate) => candidate.declarationKind === "native_project_guidance_v1" && candidate.agentRuntimeId === agentRuntimeId,
    );
    const build =
        versionText === undefined
            ? declaration?.verifiedBuilds[0]
            : declaration?.verifiedBuilds.find((candidate) => candidate.versionText === versionText);
    if (build === undefined) throw new Error("Codex verified Guidance build is missing");
    return makeVerifiedNativeProjectGuidanceTargetContextForTest({ provider: providerSummary(), build });
}

function input(agentRuntimeId: "CODEX_CLI" | "CODEX_APP" = "CODEX_CLI", versionText?: string): RenderAnalysisInput {
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: agentRuntimeId === "CODEX_CLI" ? "wsl" : "win32",
            targetContexts: [targetContext(agentRuntimeId, versionText)],
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
                                    logicalPath: "AGENTS.md",
                                    role: "entry",
                                    contentHash: sha256Text(GUIDANCE_TEXT),
                                    contentKind: "text",
                                    mediaType: "text/markdown",
                                    byteSize: 19,
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
            {
                semanticRefFingerprint: `sha256:${"1".repeat(64)}`,
                consumerAgentRuntimeId: agentRuntimeId,
                subject: { subjectKind: "asset", assetId: ASSET_ID, versionId: VERSION_ID },
                semanticKind: "asset.file_inventory",
            },
            {
                semanticRefFingerprint: `sha256:${"2".repeat(64)}`,
                consumerAgentRuntimeId: agentRuntimeId,
                subject: { subjectKind: "asset", assetId: ASSET_ID, versionId: VERSION_ID },
                semanticKind: "guidance.base_context",
            },
            {
                semanticRefFingerprint: `sha256:${"3".repeat(64)}`,
                consumerAgentRuntimeId: agentRuntimeId,
                subject: { subjectKind: "file", assetId: ASSET_ID, versionId: VERSION_ID, fileId: FILE_ID },
                semanticKind: "guidance.content",
            },
        ],
        dialectInputs: [],
    };
}

function materializationInput(
    analysisInput: RenderAnalysisInput,
    analysis: Awaited<ReturnType<typeof codexProvider.analyzeRender>>,
): RenderMaterializationInput {
    if (analysis.status !== "complete") throw new Error("Codex App Guidance analysis fixture did not close");
    const outputUnit = analysis.outputUnits[0];
    const capability = codexProvider.materializerCapabilities.find(
        (candidate) => candidate.outputContractId === outputUnit?.outputContractId,
    );
    const profile = nativeProjectGuidanceRegistryComponents([providerSummary()])
        .outputContracts.find((candidate) => candidate.outputContractId === outputUnit?.outputContractId)
        ?.materializationProfiles.at(0);
    if (outputUnit === undefined || capability === undefined || profile === undefined) {
        throw new Error("Codex App Guidance materialization fixture is incomplete");
    }
    return {
        schemaVersion: 1,
        deployment: structuredClone(analysisInput.deployment),
        requiredSemantics: structuredClone(analysisInput.requiredSemantics),
        dialectInputs: [],
        selection: {
            schemaVersion: 1,
            outputUnits: [outputUnit],
            outputUnitRenderers: [
                {
                    outputUnitFingerprint: outputUnit.outputUnitFingerprint,
                    rendererAdapterId: codexProvider.adapterId,
                    rendererAdapterVersion: codexProvider.version,
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
    if (unit === undefined) throw new Error("Codex App Guidance inspection fixture has no output unit");
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
                consumerOwnerAdapterId: codexProvider.adapterId,
                consumerOwnerAdapterVersion: codexProvider.version,
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
                    appliedContentHash: sha256Text(GUIDANCE_TEXT),
                    currentContentHash: sha256Text(CHANGED_GUIDANCE_TEXT),
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
                appliedContent: { contentKind: "text", text: GUIDANCE_TEXT },
                currentContent: { contentKind: "text", text: CHANGED_GUIDANCE_TEXT },
                diffHunks: [
                    {
                        hunkFingerprint: HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(GUIDANCE_TEXT),
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(CHANGED_GUIDANCE_TEXT),
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

function sha256Text(value: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function firstAsset(value: RenderAnalysisInput): RenderAnalysisInput["deployment"]["assets"][number] {
    const asset = value.deployment.assets[0];
    if (asset === undefined) throw new Error("Codex Guidance target fixture has no Asset");
    return asset;
}

function firstFile(value: RenderAnalysisInput): RenderAnalysisInput["deployment"]["assets"][number]["version"]["files"][number] {
    const file = firstAsset(value).version.files[0];
    if (file === undefined) throw new Error("Codex Guidance target fixture has no entry file");
    return file;
}

describe("Codex CLI exact project Guidance target", () => {
    it("composes the 0.140.0 exact consumer anchor with target materialization and attributable reverse", async () => {
        const historical = input("CODEX_CLI", "0.140.0");
        const analysis = await codexProvider.analyzeRender(historical);
        expect(historical.deployment.targetContexts).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                versionText: "0.140.0",
                buildIdentity: "sha256:b3b2a5f4ae29a584e594287d08c717e0454d21e47602e4314fca541e327a3c3e",
            }),
        ]);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        const materialization = materializationInput(historical, analysis);
        await expect(codexProvider.materializeRender(materialization)).resolves.toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: "AGENTS.md", content: { text: GUIDANCE_TEXT } }] }],
        });
        await expect(codexProvider.inspectRenderedTarget(inspectionInput(materialization))).resolves.toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: CHANGED_GUIDANCE_TEXT } }],
        });
    });

    it("claims one AGENTS.md output and preserves the complete Guidance semantic closure", async () => {
        const result = await codexProvider.analyzeRender(input());

        expect(result).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(result.outputUnits).toEqual([
            expect.objectContaining({
                outputContractId: "CODEX_NATIVE_PROJECT_GUIDANCE_V1",
                claims: [{ relativePath: "AGENTS.md", contentKind: "text", executable: false }],
                managedDirectoryBoundaries: [],
            }),
        ]);
        expect(result.semanticOptions).toHaveLength(3);
        expect(result.semanticOptions.every((option) => option.outcome === "preserved")).toBe(true);
        expect(result.semanticOptions.every((option) => option.renderStrategy === "native_file")).toBe(true);
        expect(result.semanticOptions.every((option) => option.actualReverseExtractPolicy === "can_reconcile")).toBe(true);

        const materialization = materializationInput(input(), result);
        await expect(codexProvider.materializeRender(materialization)).resolves.toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: "AGENTS.md", content: { text: GUIDANCE_TEXT } }] }],
        });
        await expect(codexProvider.inspectRenderedTarget(inspectionInput(materialization))).resolves.toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: CHANGED_GUIDANCE_TEXT } }],
        });
    });

    it.each([
        ["nested scope", (value: RenderAnalysisInput) => (firstAsset(value).scopePath = "nested")],
        ["incomplete version", (value: RenderAnalysisInput) => (firstAsset(value).version.status = "incomplete")],
        ["executable entry", (value: RenderAnalysisInput) => (firstFile(value).file.executable = true)],
        ["extra file", (value: RenderAnalysisInput) => firstAsset(value).version.files.push({} as never)],
    ])("blocks %s instead of silently degrading it", async (_label, mutate) => {
        const candidate = structuredClone(input());
        mutate(candidate);

        const result = await codexProvider.analyzeRender(candidate);

        expect(result).toMatchObject({ status: "failed", outputUnits: [], semanticOptions: [] });
        expect(result.blockedSemanticRefs).toHaveLength(3);
        expect(result.blockedSemanticRefs.every((item) => item.reasonCode === "project_guidance_target_not_applicable")).toBe(
            true,
        );
    });
});

describe("Codex App exact project Guidance target", () => {
    it("uses an App-owned contract and dispatches materialization plus reverse inspection", async () => {
        const candidate = input("CODEX_APP");
        const result = await codexProvider.analyzeRender(candidate);

        expect(candidate.deployment.targetContexts).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                targetContextSchemaId: "CODEX_APP_PROJECT_SKILL_TARGET_V1",
                versionText: "0.147.0-alpha.1.2",
                renderFacts: [{ key: "oaam.platform", value: "win32", evidenceLevel: "agent_runtime_verified" }],
            }),
        ]);
        expect(result).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(result.outputUnits).toEqual([
            expect.objectContaining({
                outputContractId: "CODEX_APP_NATIVE_PROJECT_GUIDANCE_V1",
                claims: [{ relativePath: "AGENTS.md", contentKind: "text", executable: false }],
            }),
        ]);
        expect(result.semanticOptions).toHaveLength(3);

        const materialization = materializationInput(candidate, result);
        await expect(codexProvider.materializeRender(materialization)).resolves.toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: "AGENTS.md", content: { text: GUIDANCE_TEXT } }] }],
        });
        await expect(codexProvider.inspectRenderedTarget(inspectionInput(materialization))).resolves.toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: CHANGED_GUIDANCE_TEXT } }],
            files: [{ relativePath: "AGENTS.md", attributionState: "uniquely_attributable" }],
        });
    });
});
