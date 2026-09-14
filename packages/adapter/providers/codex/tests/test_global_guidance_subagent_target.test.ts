import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
    AssetKindTypeDataV2,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderedTargetInspectionInput,
    Sha256Digest,
} from "@oaam/core";
import { validateAdapterRenderContractRegistration } from "../../../core/src/render/adapter-render-contract-registration";
import { makeNativeProjectExactGraphContractParts } from "../../../core/src/render/native-project-exact-graph";
import { makeNativeProjectGuidanceContractParts } from "../../../core/src/render/native-project-guidance-profiles";
import { codexProvider } from "../src/codex-provider";
import { validateCodexNativeDialect } from "../src/codex-source-read-native";
import { createCodexGlobalTargetSupports } from "../src/codex-target-global";

type CodexRuntime = "CODEX_CLI" | "CODEX_APP";

interface RuntimeSpec {
    agentRuntimeId: CodexRuntime;
    platform: "wsl" | "win32";
    versionText: string;
    buildIdentity: Sha256Digest;
    outputPrefix: string;
}

const HASH = `sha256:${"7".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const GLOBAL_GUIDANCE_PATH = "AGENTS.md";
const GLOBAL_SUBAGENT_PATH = "agents/oaam-phase54-global-subagent.toml";
const GUIDANCE_TEXT = "# Global Guidance\n\nUse OAAM_PHASE54_GLOBAL_GUIDANCE.\n";
const GUIDANCE_REVERSE_TEXT = GUIDANCE_TEXT.replace("GLOBAL_GUIDANCE", "GLOBAL_GUIDANCE_REVERSE");
const ORIGINAL_INSTRUCTION = "Reply with OAAM_PHASE54_GLOBAL_SUBAGENT.";
const FOREIGN_INSTRUCTION = "Reply with OAAM_PHASE54_GLOBAL_SUBAGENT_FOREIGN.";
const REVERSE_INSTRUCTION = "Reply with OAAM_PHASE54_GLOBAL_SUBAGENT_REVERSE.";
const NATIVE_TEXT = nativeText("oaam_phase54_global", "Global Codex Subagent", ORIGINAL_INSTRUCTION, "high");
const FOREIGN_NATIVE_TEXT = NATIVE_TEXT.replace('name = "oaam_phase54_global"', 'name = "oaam_phase54_global_foreign"')
    .replace('description = "Global Codex Subagent"', 'description = "Foreign global Codex Subagent"')
    .replace(JSON.stringify(ORIGINAL_INSTRUCTION), JSON.stringify(FOREIGN_INSTRUCTION))
    .replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "medium"');
const REVERSE_NATIVE_TEXT = FOREIGN_NATIVE_TEXT.replace(JSON.stringify(FOREIGN_INSTRUCTION), JSON.stringify(REVERSE_INSTRUCTION));

const RUNTIMES: RuntimeSpec[] = [
    {
        agentRuntimeId: "CODEX_CLI",
        platform: "wsl",
        versionText: "0.142.5",
        buildIdentity: "sha256:ac06f492f3ded7a8e2f36dc961e3cc5276a3c4841a2695d4681d0557c5b30e41",
        outputPrefix: "CODEX_NATIVE",
    },
    {
        agentRuntimeId: "CODEX_APP",
        platform: "win32",
        versionText: "0.147.0-alpha.1.2",
        buildIdentity: "sha256:fa960ec081bec3629f40c63ed610ebc49c7e5e077dfb42322b08cb6d460f0b8a",
        outputPrefix: "CODEX_APP_NATIVE",
    },
];

const supports = createCodexGlobalTargetSupports({
    adapterVersion: codexProvider.version,
    agentRuntimes: codexProvider.agentRuntimes,
});

describe("Codex user-global Guidance and Subagent targets", () => {
    it("registers one shared config-root schema per exact runtime without weakening project targets", () => {
        expect(validateAdapterRenderContractRegistration([codexProvider])).toEqual([]);
        expect(codexProvider.version).toBe("0.19.0");
        expect(codexProvider.targetContextSchemas.map((schema) => schema.targetContextSchemaId)).toEqual([
            "CODEX_CLI_PROJECT_GUIDANCE_TARGET_V1",
            "CODEX_APP_PROJECT_SKILL_TARGET_V1",
            "CODEX_CLI_GLOBAL_SKILL_DIRECTORY_TARGET_V1",
            "CODEX_APP_GLOBAL_SKILL_DIRECTORY_TARGET_V1",
            "CODEX_CLI_GLOBAL_CONFIG_TARGET_V1",
            "CODEX_APP_GLOBAL_CONFIG_TARGET_V1",
        ]);
        for (const runtime of RUNTIMES) {
            const selected = supports[runtime.agentRuntimeId];
            expect(selected.guidance.targetContextSchema).toEqual(selected.subagent.targetContextSchema);
            expect(selected.guidance.renderContractDeclaration.target.requiredFacts).toEqual({});
            expect(selected.subagent.renderContractDeclaration.target.requiredFacts).toEqual({});
        }
    });

    it.each(RUNTIMES)("materializes and reverses $agentRuntimeId Global Guidance", async (runtime) => {
        const fixture = guidanceInput(runtime);
        const analysis = await codexProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.outputUnits).toEqual([
            expect.objectContaining({
                outputContractId: `${runtime.outputPrefix}_GLOBAL_GUIDANCE_V1`,
                claims: [{ relativePath: GLOBAL_GUIDANCE_PATH, contentKind: "text", executable: false }],
                managedDirectoryBoundaries: [],
            }),
        ]);
        const support = supports[runtime.agentRuntimeId].guidance;
        const materialization = materializationInput(fixture, analysis, support, "guidance");
        expect(await codexProvider.materializeRender(materialization)).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: GLOBAL_GUIDANCE_PATH, content: { text: GUIDANCE_TEXT } }] }],
        });
        expect(
            await codexProvider.inspectRenderedTarget(
                inspectionInput(materialization, GLOBAL_GUIDANCE_PATH, GUIDANCE_TEXT, GUIDANCE_REVERSE_TEXT, "native_file"),
            ),
        ).toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: GUIDANCE_REVERSE_TEXT } }],
        });
    });

    it.each(RUNTIMES)("restores, rebases and reverses $agentRuntimeId Global Subagent TOML", async (runtime) => {
        const support = supports[runtime.agentRuntimeId].subagent;
        const current = subagentInput(runtime, "current_exact", originalCanonical(), ORIGINAL_INSTRUCTION, NATIVE_TEXT);
        const currentAnalysis = await codexProvider.analyzeRender(current);
        expect(currentAnalysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        const currentMaterialization = materializationInput(current, currentAnalysis, support, "graph");
        expect(await codexProvider.materializeRender(currentMaterialization)).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ relativePath: GLOBAL_SUBAGENT_PATH, content: { text: NATIVE_TEXT } }] }],
        });

        const rebased = subagentInput(runtime, "parent_rebase_seed", foreignCanonical(), FOREIGN_INSTRUCTION, NATIVE_TEXT);
        const rebaseAnalysis = await codexProvider.analyzeRender(rebased);
        expect(rebaseAnalysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        const rebaseMaterialization = materializationInput(rebased, rebaseAnalysis, support, "graph");
        expect(await codexProvider.materializeRender(rebaseMaterialization)).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ relativePath: GLOBAL_SUBAGENT_PATH, content: { text: FOREIGN_NATIVE_TEXT } }] }],
        });
        expect(FOREIGN_NATIVE_TEXT).toContain('nickname_candidates = ["auditor", "reviewer"]');
        expect(FOREIGN_NATIVE_TEXT).toContain("# preserve global comment");
        expect(validateNative(foreignCanonical(), FOREIGN_INSTRUCTION, FOREIGN_NATIVE_TEXT)).toBe(true);
        expect(
            await codexProvider.inspectRenderedTarget(
                inspectionInput(
                    rebaseMaterialization,
                    GLOBAL_SUBAGENT_PATH,
                    FOREIGN_NATIVE_TEXT,
                    REVERSE_NATIVE_TEXT,
                    "native_graph",
                ),
            ),
        ).toMatchObject({
            status: "complete",
            changes: [
                {
                    changeKind: "file_content_replacement",
                    replacementContent: { text: instructionEntry(REVERSE_INSTRUCTION) },
                },
            ],
            files: [{ attributionState: "uniquely_attributable" }],
        });
    });

    it.each(RUNTIMES)("fails closed for $agentRuntimeId ambiguous Global Subagent graphs and behavior", (runtime) => {
        const support = supports[runtime.agentRuntimeId].subagent;
        const projectPath = subagentInput(runtime, "current_exact", originalCanonical(), ORIGINAL_INSTRUCTION, NATIVE_TEXT);
        const native = firstNative(projectPath);
        native.relativePath = ".codex/agents/oaam-phase54-global-subagent.toml";
        expect(support.analyze(projectPath).status).toBe("failed");

        const extra = subagentInput(runtime, "current_exact", originalCanonical(), ORIGINAL_INSTRUCTION, NATIVE_TEXT);
        firstNativeGroup(extra).files.push({ ...firstNative(extra), relativePath: "agents/extra.toml" });
        expect(support.analyze(extra).status).toBe("failed");

        const unknown = subagentInput(
            runtime,
            "parent_rebase_seed",
            foreignCanonical(),
            FOREIGN_INSTRUCTION,
            NATIVE_TEXT.replace("model =", 'service_tier = "fast"\nmodel ='),
        );
        expect(support.analyze(unknown).status).toBe("failed");
    });

    it.each(RUNTIMES)("rejects a $agentRuntimeId Deployment that mixes project and Global ownership", async (runtime) => {
        const mixed = guidanceInput(runtime);
        const globalAsset = mixed.deployment.assets[0];
        if (globalAsset === undefined) throw new Error("Global Guidance fixture asset missing");
        mixed.deployment.assets.push({
            ...structuredClone(globalAsset),
            scope: "project",
            projectId: "55555555-5555-4555-8555-555555555555",
            scopePath: "/tmp/oaam-phase54-addition25-mixed-scope-project",
        });

        expect(await codexProvider.analyzeRender(mixed)).toMatchObject({
            status: "failed",
            outputUnits: [],
            diagnostics: [{ code: "codex_target_scope_ambiguous", severity: "error" }],
        });
    });
});

function guidanceInput(runtime: RuntimeSpec): RenderAnalysisInput {
    return baseInput(
        runtime,
        "Guidance",
        [textFile("AGENTS.md", GUIDANCE_TEXT)],
        [],
        [
            semantic(runtime, "asset.file_inventory", "asset"),
            semantic(runtime, "guidance.base_context", "asset"),
            semantic(runtime, "guidance.content", "file"),
        ],
    );
}

function subagentInput(
    runtime: RuntimeSpec,
    inputRole: "current_exact" | "parent_rebase_seed",
    canonical: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>,
    instruction: string,
    native: string,
): RenderAnalysisInput {
    const versionId = inputRole === "current_exact" ? VERSION_ID : "66666666-6666-4666-8666-666666666666";
    const common = {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: "codex-subagent-toml-v2",
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
        },
        files: [nativeFile(native)],
    };
    return baseInput(
        runtime,
        canonical,
        [textFile("instructions.json", instructionEntry(instruction))],
        [
            {
                targetVersion: { assetId: ASSET_ID, versionId },
                consumerAgentRuntimeIds: [runtime.agentRuntimeId],
                inputs: [
                    inputRole === "current_exact"
                        ? common
                        : {
                              ...common,
                              inputRole: "parent_rebase_seed" as const,
                              sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
                          },
                ],
            },
        ],
        [
            semantic(runtime, "asset.file_inventory", "asset", versionId),
            semantic(runtime, "subagent.delegation_metadata", "asset", versionId),
            semantic(runtime, "subagent.tool_boundary", "asset", versionId),
            semantic(runtime, "subagent.model_hint", "asset", versionId),
            semantic(runtime, "subagent.invoked_context", "file", versionId),
        ],
        versionId,
    );
}

function baseInput(
    runtime: RuntimeSpec,
    kind: "Guidance" | Extract<AssetKindTypeDataV2, { kind: "Subagent" }>,
    files: ReturnType<typeof textFile>[],
    dialectInputs: RenderAnalysisInput["dialectInputs"],
    requiredSemantics: RenderAnalysisInput["requiredSemantics"],
    versionId = VERSION_ID,
): RenderAnalysisInput {
    const support = supports[runtime.agentRuntimeId];
    const schema = kind === "Guidance" ? support.guidance.targetContextSchema : support.subagent.targetContextSchema;
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: runtime.platform,
            platformInstanceId: `test-${runtime.platform}`,
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: runtime.agentRuntimeId,
                    versionText: runtime.versionText,
                    buildIdentity: runtime.buildIdentity,
                    targetContextSchemaId: schema.targetContextSchemaId,
                    targetContextSchemaFingerprint: schema.schemaFingerprint,
                    renderFacts: [{ key: "oaam.platform", value: runtime.platform, evidenceLevel: "agent_runtime_verified" }],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [
                {
                    scope: "global",
                    projectId: "",
                    scopePath: "",
                    allowIncomplete: false,
                    version: {
                        ref: { assetId: ASSET_ID, versionId },
                        versionFingerprint: HASH,
                        versionCanonicalContentFingerprint: HASH,
                        status: "complete",
                        canonical:
                            kind === "Guidance" ? { kind: "Guidance", typeData: { schemaVersion: 1 } } : structuredClone(kind),
                        files,
                    },
                    sectionHandles: { [FILE_ID]: "global-entry" },
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics,
        dialectInputs,
    };
}

function materializationInput(
    fixture: RenderAnalysisInput,
    analysis: Awaited<ReturnType<typeof codexProvider.analyzeRender>>,
    support: (typeof supports)[CodexRuntime]["guidance"] | (typeof supports)[CodexRuntime]["subagent"],
    contractKind: "guidance" | "graph",
): RenderMaterializationInput {
    if (analysis.status !== "complete") throw new Error("Global target analysis did not close");
    const contract =
        contractKind === "guidance"
            ? makeNativeProjectGuidanceContractParts(support.renderContractDeclaration as never).outputContract
            : makeNativeProjectExactGraphContractParts(support.renderContractDeclaration as never).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Global target profile missing");
    return {
        schemaVersion: 1,
        deployment: structuredClone(fixture.deployment),
        requiredSemantics: structuredClone(fixture.requiredSemantics),
        dialectInputs: structuredClone(fixture.dialectInputs),
        selection: {
            schemaVersion: 1,
            outputUnits: analysis.outputUnits,
            outputUnitRenderers: analysis.outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                rendererAdapterId: "CODEX",
                rendererAdapterVersion: codexProvider.version,
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

function inspectionInput(
    materialization: RenderMaterializationInput,
    relativePath: string,
    appliedText: string,
    currentText: string,
    renderStrategy: "native_file" | "native_graph",
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0];
    if (unit === undefined) throw new Error("Global target output unit missing");
    return {
        schemaVersion: 1,
        deploymentId: "77777777-7777-4777-8777-777777777777",
        appliedRenderSnapshot: {
            schemaVersion: 1,
            snapshotState: "applied",
            renderInputFingerprint: HASH,
            compilerPolicyVersion: "core_render_policy_v1",
            selectionFingerprint: HASH,
            compilationFingerprint: HASH,
            decisions: materialization.requiredSemantics.map((semantic) => ({
                semanticRef: semantic,
                consumerOwnerAdapterId: "CODEX",
                consumerOwnerAdapterVersion: codexProvider.version,
                optionFingerprint: HASH,
                renderStrategy,
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
                    appliedContentHash: sha256Text(appliedText),
                    currentContentHash: sha256Text(currentText),
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
                appliedContent: { contentKind: "text", text: appliedText },
                currentContent: { contentKind: "text", text: currentText },
                diffHunks: [
                    {
                        hunkFingerprint: HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(appliedText),
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(currentText),
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

function originalCanonical(): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return subagentCanonical("oaam_phase54_global", "Global Codex Subagent", "high");
}

function foreignCanonical(): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return subagentCanonical("oaam_phase54_global_foreign", "Foreign global Codex Subagent", "medium");
}

function subagentCanonical(
    name: string,
    description: string,
    effort: string,
): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return {
        kind: "Subagent",
        typeData: {
            schemaVersion: 2,
            name,
            description,
            promptContextPolicy: { mode: "agent_runtime_default" },
            tools: {
                availability: { base: { mode: "inherit_available" }, unavailable: [] },
                permission: { rules: [], otherwise: "inherit_agent_runtime_policy" },
            },
            dependencies: { preloadedSkillVersionIds: [] },
            memory: { mode: "disabled" },
            execution: {
                permission: { mode: "inherit" },
                workspaceIsolation: { mode: "agent_runtime_default" },
                scheduling: { mode: "agent_runtime_default" },
                turnLimit: { mode: "agent_runtime_default" },
                model: { mode: "selected", dialectId: "codex-subagent-model-v1", selector: "gpt-5.4", relativeTier: -1 },
                effort: { mode: "selected", dialectId: "codex-subagent-reasoning-effort-v1", selector: effort, relativeTier: -1 },
                sampling: { temperature: { mode: "agent_runtime_default" }, topP: { mode: "agent_runtime_default" } },
            },
            directInvocation: { mode: "delegated_only" },
            presentation: { listing: "agent_runtime_default", color: { mode: "agent_runtime_default" } },
        },
    };
}

function validateNative(
    canonical: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>,
    instruction: string,
    text: string,
): boolean {
    const descriptor = nativeFile(text);
    const { text: _text, ...file } = descriptor;
    return validateCodexNativeDialect({
        canonical,
        canonicalFiles: [textFile("instructions.json", instructionEntry(instruction))],
        representation: {
            schemaVersion: 1,
            dialectId: "codex-subagent-toml-v2",
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: [file],
        },
        nativeFiles: [{ relativePath: GLOBAL_SUBAGENT_PATH, bytes: new TextEncoder().encode(text) }],
    });
}

function nativeText(name: string, description: string, instruction: string, effort: string): string {
    return [
        "# preserve Codex global custom-agent layout",
        'nickname_candidates = ["auditor", "reviewer"]',
        `description = ${JSON.stringify(description)}`,
        `name = ${JSON.stringify(name)}`,
        `developer_instructions = ${JSON.stringify(instruction)} # preserve global comment`,
        'model = "gpt-5.4"',
        `model_reasoning_effort = ${JSON.stringify(effort)}`,
        "",
    ].join("\n");
}

function instructionEntry(instruction: string): string {
    return JSON.stringify({ schemaVersion: 1, sections: [{ title: "", content: instruction }] });
}

function textFile(logicalPath: string, text: string) {
    return {
        contentKind: "text" as const,
        text,
        file: {
            fileId: FILE_ID,
            logicalPath,
            role: "entry" as const,
            contentHash: sha256Text(text),
            contentKind: "text" as const,
            mediaType: logicalPath.endsWith(".json") ? "application/json" : "text/markdown",
            byteSize: Buffer.byteLength(text),
            executable: false,
            references: [],
        },
    };
}

function nativeFile(text: string) {
    return {
        relativePath: GLOBAL_SUBAGENT_PATH,
        contentKind: "text" as const,
        mediaType: "application/octet-stream",
        contentHash: sha256Text(text),
        byteSize: Buffer.byteLength(text),
        executable: false,
        text,
    };
}

function semantic(
    runtime: RuntimeSpec,
    semanticKind: string,
    subjectKind: "asset" | "file",
    versionId = VERSION_ID,
): RenderAnalysisInput["requiredSemantics"][number] {
    const subject =
        subjectKind === "file"
            ? { subjectKind: "file" as const, assetId: ASSET_ID, versionId, fileId: FILE_ID }
            : { subjectKind: "asset" as const, assetId: ASSET_ID, versionId };
    return {
        semanticRefFingerprint: sha256Text(`${runtime.agentRuntimeId}:${semanticKind}`),
        consumerAgentRuntimeId: runtime.agentRuntimeId,
        subject,
        semanticKind,
    } as RenderAnalysisInput["requiredSemantics"][number];
}

function firstNativeGroup(input: RenderAnalysisInput) {
    const group = input.dialectInputs[0]?.inputs[0];
    if (group?.inputKind !== "native_representation") throw new Error("native input missing");
    return group;
}

function firstNative(input: RenderAnalysisInput) {
    const file = firstNativeGroup(input).files[0];
    if (file === undefined) throw new Error("native file missing");
    return file;
}

function sha256Text(value: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}
