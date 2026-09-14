import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
    AssetKindTypeDataV2,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderedTargetInspectionInput,
    Sha256Digest,
} from "@oaam/core";
import { makeNativeProjectExactFileContractParts } from "../../../core/src/render/native-project-exact-file";
import { codexProvider } from "../src/codex-provider";
import { validateCodexNativeDialect } from "../src/codex-source-read-native";
import {
    projectCodexSubagentCanonical,
    rebaseCodexSubagentToml,
    reverseCodexSubagentInstruction,
} from "../src/codex-subagent-native-editor";
import { createCodexSubagentTargetSupports } from "../src/codex-target-exact-file";

type CodexRuntime = "CODEX_CLI" | "CODEX_APP";

interface RuntimeSpec {
    agentRuntimeId: CodexRuntime;
    platform: "wsl" | "win32";
    versionText: string;
    buildIdentity: Sha256Digest;
    outputContractId: string;
    materializerCapabilityKey: string;
}

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const NATIVE_PATH = ".codex/agents/oaam-phase54-subagent.toml";
const ORIGINAL_INSTRUCTIONS = "Reply with OAAM_PHASE54_SUBAGENT_DEVELOPER_4F19B0.";
const REVERSE_INSTRUCTIONS = "Reply with OAAM_PHASE54_SUBAGENT_REVERSE_91C7E2.";
const FOREIGN_INSTRUCTIONS = "Reply with OAAM_PHASE54_SUBAGENT_FOREIGN_3A68D5.";
const FOREIGN_REVERSE_INSTRUCTIONS = "Reply with OAAM_PHASE54_SUBAGENT_FOREIGN_REVERSE_7D42B6.";
const NATIVE_TEXT = [
    "# preserve Codex custom-agent layout",
    'nickname_candidates = ["auditor", "reviewer"]',
    'description = "OAAM isolated Codex Subagent fixture"',
    'name = "oaam_phase54_subagent"',
    `developer_instructions = ${JSON.stringify(ORIGINAL_INSTRUCTIONS)} # preserve this comment`,
    'model = "gpt-5.4"',
    'model_reasoning_effort = "high"',
    "",
].join("\n");
const REVERSE_NATIVE_TEXT = NATIVE_TEXT.replace(JSON.stringify(ORIGINAL_INSTRUCTIONS), JSON.stringify(REVERSE_INSTRUCTIONS));
const FOREIGN_NATIVE_TEXT = NATIVE_TEXT.replace(
    'description = "OAAM isolated Codex Subagent fixture"',
    'description = "Foreign-edited Codex Subagent fixture"',
)
    .replace('name = "oaam_phase54_subagent"', 'name = "oaam_phase54_foreign"')
    .replace(JSON.stringify(ORIGINAL_INSTRUCTIONS), JSON.stringify(FOREIGN_INSTRUCTIONS))
    .replace('model = "gpt-5.4"', 'model = "gpt-5.5"')
    .replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "medium"');
const FOREIGN_REVERSE_NATIVE_TEXT = FOREIGN_NATIVE_TEXT.replace(
    JSON.stringify(FOREIGN_INSTRUCTIONS),
    JSON.stringify(FOREIGN_REVERSE_INSTRUCTIONS),
);

const RUNTIMES: RuntimeSpec[] = [
    {
        agentRuntimeId: "CODEX_CLI",
        platform: "wsl",
        versionText: "0.142.5",
        buildIdentity: "sha256:ac06f492f3ded7a8e2f36dc961e3cc5276a3c4841a2695d4681d0557c5b30e41",
        outputContractId: "CODEX_NATIVE_PROJECT_SUBAGENT_ONE_FILE_V1",
        materializerCapabilityKey: "codex.cli-project-subagent-exact-file-v1",
    },
    {
        agentRuntimeId: "CODEX_APP",
        platform: "win32",
        versionText: "0.147.0-alpha.1.2",
        buildIdentity: "sha256:fa960ec081bec3629f40c63ed610ebc49c7e5e077dfb42322b08cb6d460f0b8a",
        outputContractId: "CODEX_APP_NATIVE_PROJECT_SUBAGENT_ONE_FILE_V1",
        materializerCapabilityKey: "codex.app-project-subagent-exact-file-v1",
    },
];

const supports = createCodexSubagentTargetSupports({
    adapterVersion: codexProvider.version,
    agentRuntimes: codexProvider.agentRuntimes,
});

describe("Codex one-file exact Subagent targets", () => {
    it("registers independent CLI/App Subagent contracts on the existing Provider", () => {
        expect(codexProvider.version).toBe("0.19.0");
        expect(
            codexProvider.assetTargetCapabilities.filter(
                (row) =>
                    row.entrySupportStatus === "supported" &&
                    (row.assetKind === "Guidance" || row.assetKind === "Subagent") &&
                    row.renderStrategy === "native_file" &&
                    row.targetContextSchemaId.includes("PROJECT"),
            ),
        ).toEqual([
            expect.objectContaining({ agentRuntimeId: "CODEX_CLI", assetKind: "Guidance" }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_CLI",
                assetKind: "Subagent",
                outputContractId: RUNTIMES[0]?.outputContractId,
            }),
            expect.objectContaining({ agentRuntimeId: "CODEX_APP", assetKind: "Guidance" }),
            expect.objectContaining({
                agentRuntimeId: "CODEX_APP",
                assetKind: "Subagent",
                outputContractId: RUNTIMES[1]?.outputContractId,
            }),
        ]);
        expect(supports.CODEX_CLI.materializerCapability.materializerCapabilityKey).toBe(RUNTIMES[0]?.materializerCapabilityKey);
        expect(supports.CODEX_APP.materializerCapability.materializerCapabilityKey).toBe(RUNTIMES[1]?.materializerCapabilityKey);
    });

    it.each(RUNTIMES)("dispatches $agentRuntimeId parent rebase through the frozen Provider facade", async (runtime) => {
        const fixture = analysisFixture(runtime, "parent_rebase_seed", foreignCanonical(), entry(FOREIGN_INSTRUCTIONS));
        expect(await codexProvider.analyzeRender(fixture)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        const materialization = materializationInput(runtime, fixture);
        expect(await codexProvider.materializeRender(materialization)).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: NATIVE_PATH, content: { text: FOREIGN_NATIVE_TEXT } }] }],
        });
        expect(
            await codexProvider.inspectRenderedTarget(
                inspectionInput(materialization, FOREIGN_REVERSE_NATIVE_TEXT, FOREIGN_NATIVE_TEXT),
            ),
        ).toMatchObject({
            status: "complete",
            changes: [
                { changeKind: "file_content_replacement", replacementContent: { text: entry(FOREIGN_REVERSE_INSTRUCTIONS) } },
            ],
        });
    });

    it.each(RUNTIMES)("restores exact $agentRuntimeId native bytes and validates the complete dialect", (runtime) => {
        const fixture = analysisFixture(runtime, "current_exact", originalCanonical(), entry(ORIGINAL_INSTRUCTIONS));
        expect(supports[runtime.agentRuntimeId].materialize(materializationInput(runtime, fixture))).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: NATIVE_PATH, content: { text: NATIVE_TEXT } }] }],
        });
        expect(validateMaterializedNative(originalCanonical(), entry(ORIGINAL_INSTRUCTIONS), NATIVE_TEXT)).toBe(true);
    });

    it.each(RUNTIMES)("rebases all portable fields while preserving $agentRuntimeId native-only bytes", (runtime) => {
        const fixture = analysisFixture(runtime, "parent_rebase_seed", foreignCanonical(), entry(FOREIGN_INSTRUCTIONS));
        expect(supports[runtime.agentRuntimeId].materialize(materializationInput(runtime, fixture))).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ content: { text: FOREIGN_NATIVE_TEXT } }] }],
        });
        expect(FOREIGN_NATIVE_TEXT).toContain('nickname_candidates = ["auditor", "reviewer"]');
        expect(FOREIGN_NATIVE_TEXT).toContain("# preserve this comment");
        expect(validateMaterializedNative(foreignCanonical(), entry(FOREIGN_INSTRUCTIONS), FOREIGN_NATIVE_TEXT)).toBe(true);
    });

    it.each(RUNTIMES)("accepts only a developer-instructions change during $agentRuntimeId reverse", (runtime) => {
        const fixture = analysisFixture(runtime, "current_exact", originalCanonical(), entry(ORIGINAL_INSTRUCTIONS));
        const materialization = materializationInput(runtime, fixture);
        expect(supports[runtime.agentRuntimeId].inspect(inspectionInput(materialization, REVERSE_NATIVE_TEXT))).toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: entry(REVERSE_INSTRUCTIONS) } }],
            files: [{ attributionState: "uniquely_attributable" }],
        });
        const metadataDrift = REVERSE_NATIVE_TEXT.replace("Subagent fixture", "changed Subagent fixture");
        expect(supports[runtime.agentRuntimeId].inspect(inspectionInput(materialization, metadataDrift))).toMatchObject({
            status: "complete",
            changes: [],
            files: [{ attributionState: "conflict", reasonCode: "native_project_exact_file_change_not_reconcilable" }],
        });
    });

    it("inserts and removes optional selectors only when native comments remain lossless", () => {
        const noSelectors = NATIVE_TEXT.replace('model = "gpt-5.4"\n', "").replace('model_reasoning_effort = "high"\n', "");
        const selected = projectCodexSubagentCanonical(originalCanonical(), entry(ORIGINAL_INSTRUCTIONS));
        expect(selected).not.toBeNull();
        expect(rebaseCodexSubagentToml(noSelectors, selected as NonNullable<typeof selected>)).toContain(
            `developer_instructions = ${JSON.stringify(ORIGINAL_INSTRUCTIONS)} # preserve this comment\nmodel = "gpt-5.4"\nmodel_reasoning_effort = "high"\n`,
        );

        const noSelectorsOrFinalNewline = noSelectors.trimEnd();
        const rebasedWithoutFinalNewline = rebaseCodexSubagentToml(
            noSelectorsOrFinalNewline,
            selected as NonNullable<typeof selected>,
        );
        expect(rebasedWithoutFinalNewline).toBe(
            `${noSelectorsOrFinalNewline}\nmodel = "gpt-5.4"\nmodel_reasoning_effort = "high"`,
        );
        expect(
            validateMaterializedNative(originalCanonical(), entry(ORIGINAL_INSTRUCTIONS), rebasedWithoutFinalNewline as string),
        ).toBe(true);

        const inherited = originalCanonical();
        inherited.typeData.execution.model = { mode: "inherit" };
        inherited.typeData.execution.effort = { mode: "inherit" };
        const inheritProjection = projectCodexSubagentCanonical(inherited, entry(ORIGINAL_INSTRUCTIONS));
        const withoutSelectors = rebaseCodexSubagentToml(NATIVE_TEXT, inheritProjection as NonNullable<typeof selected>);
        expect(withoutSelectors).not.toContain("model =");
        expect(withoutSelectors).not.toContain("model_reasoning_effort =");
        expect(withoutSelectors).toContain('nickname_candidates = ["auditor", "reviewer"]');

        const commentedSelector = NATIVE_TEXT.replace('model = "gpt-5.4"', 'model = "gpt-5.4" # native comment');
        expect(rebaseCodexSubagentToml(commentedSelector, inheritProjection as NonNullable<typeof selected>)).toBeNull();
    });

    it.each(RUNTIMES)("blocks $agentRuntimeId unknown behavior, ambiguous TOML, extra files, and unsafe paths", (runtime) => {
        const unknown = analysisFixture(runtime, "parent_rebase_seed", foreignCanonical(), entry(FOREIGN_INSTRUCTIONS));
        const unknownNative = nativeInput(unknown);
        replaceNativeText(unknownNative, NATIVE_TEXT.replace("model =", 'service_tier = "fast"\nmodel ='));
        expect(supports[runtime.agentRuntimeId].analyze(unknown).status).toBe("failed");

        const multiline = analysisFixture(runtime, "parent_rebase_seed", foreignCanonical(), entry(FOREIGN_INSTRUCTIONS));
        const multilineText = NATIVE_TEXT.replace(JSON.stringify(ORIGINAL_INSTRUCTIONS), `"""${ORIGINAL_INSTRUCTIONS}"""`);
        replaceNativeText(nativeInput(multiline), multilineText);
        expect(supports[runtime.agentRuntimeId].analyze(multiline).status).toBe("failed");

        const extraFile = analysisFixture(runtime, "current_exact", originalCanonical(), entry(ORIGINAL_INSTRUCTIONS));
        firstAsset(extraFile).version.files.push(textFile("resource.md", "resource", "resource"));
        expect(supports[runtime.agentRuntimeId].analyze(extraFile).status).toBe("failed");

        for (const relativePath of ["../agent.toml", ".codex/agents/nested/agent.toml", ".codex\\agents\\agent.toml"]) {
            const unsafe = analysisFixture(runtime, "current_exact", originalCanonical(), entry(ORIGINAL_INSTRUCTIONS));
            const [unsafeFile] = nativeInput(unsafe).files;
            expect(unsafeFile).toBeDefined();
            if (unsafeFile === undefined) throw new Error("Subagent native fixture lost its only file");
            unsafeFile.relativePath = relativePath;
            expect(supports[runtime.agentRuntimeId].analyze(unsafe).status).toBe("failed");
        }
    });

    it("rejects synthetic titles, foreign selectors, and behavioral fields Codex cannot represent", () => {
        expect(
            projectCodexSubagentCanonical(
                originalCanonical(),
                JSON.stringify({
                    schemaVersion: 1,
                    sections: [{ title: "Developer instructions", content: ORIGINAL_INSTRUCTIONS }],
                }),
            ),
        ).toBeNull();
        const foreignSelector = originalCanonical();
        foreignSelector.typeData.execution.model = {
            mode: "selected",
            dialectId: "foreign-model-selector-v1",
            selector: "gpt-5.4",
            relativeTier: -1,
        };
        expect(projectCodexSubagentCanonical(foreignSelector, entry(ORIGINAL_INSTRUCTIONS))).toBeNull();

        const unavailableTool = originalCanonical();
        unavailableTool.typeData.tools.availability.unavailable = ["shell"];
        expect(projectCodexSubagentCanonical(unavailableTool, entry(ORIGINAL_INSTRUCTIONS))).toBeNull();

        const isolatedWorkspace = originalCanonical();
        isolatedWorkspace.typeData.execution.workspaceIsolation = { mode: "required" };
        expect(projectCodexSubagentCanonical(isolatedWorkspace, entry(ORIGINAL_INSTRUCTIONS))).toBeNull();

        for (const invalidEntry of [
            "not json",
            JSON.stringify({ schemaVersion: 2, sections: [] }),
            JSON.stringify({ schemaVersion: 1, sections: [] }),
            JSON.stringify({ schemaVersion: 1, sections: ["not a section"] }),
        ]) {
            expect(projectCodexSubagentCanonical(originalCanonical(), invalidEntry)).toBeNull();
        }
    });

    it("requires exact byte reconstruction for body-only reverse", () => {
        expect(reverseCodexSubagentInstruction(NATIVE_TEXT, REVERSE_NATIVE_TEXT)).toBe(entry(REVERSE_INSTRUCTIONS));
        expect(reverseCodexSubagentInstruction(NATIVE_TEXT, `${REVERSE_NATIVE_TEXT}# layout drift\n`)).toBeNull();
        expect(reverseCodexSubagentInstruction("not TOML", REVERSE_NATIVE_TEXT)).toBeNull();
        expect(reverseCodexSubagentInstruction(NATIVE_TEXT, "not TOML")).toBeNull();
    });

    it("rejects malformed raw assignment shapes before editing native bytes", () => {
        const projection = projectCodexSubagentCanonical(originalCanonical(), entry(ORIGINAL_INSTRUCTIONS));
        if (projection === null) throw new Error("missing valid Subagent projection");
        const malformed = [
            `\0${NATIVE_TEXT}`,
            NATIVE_TEXT.replace("name =", "name\r="),
            `${NATIVE_TEXT}name = "duplicate"\n`,
            NATIVE_TEXT.replace('name = "oaam_phase54_subagent"', "name = 42"),
            NATIVE_TEXT.replace('name = "oaam_phase54_subagent"', 'name = "replacement" trailing'),
            NATIVE_TEXT.replace('name = "oaam_phase54_subagent"', 'name = "unterminated'),
            NATIVE_TEXT.replace('name = "oaam_phase54_subagent"', 'name = "unterminated' + "\\"),
        ];
        for (const nativeText of malformed) {
            expect(rebaseCodexSubagentToml(nativeText, projection)).toBeNull();
        }
        expect(rebaseCodexSubagentToml(NATIVE_TEXT.trimEnd(), projection)).toBe(NATIVE_TEXT.trimEnd());
    });
});

function analysisFixture(
    runtime: RuntimeSpec,
    inputRole: "current_exact" | "parent_rebase_seed",
    canonical: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>,
    entryText: string,
): RenderAnalysisInput {
    const versionId = inputRole === "current_exact" ? VERSION_ID : "66666666-6666-4666-8666-666666666666";
    const support = supports[runtime.agentRuntimeId];
    const semanticKinds = [
        "asset.file_inventory",
        "subagent.delegation_metadata",
        "subagent.tool_boundary",
        "subagent.model_hint",
        "subagent.invoked_context",
    ];
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
                    targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
                    renderFacts: [{ key: "oaam.platform", value: runtime.platform, evidenceLevel: "agent_runtime_verified" }],
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
                        ref: { assetId: ASSET_ID, versionId },
                        versionFingerprint: HASH,
                        versionCanonicalContentFingerprint: HASH,
                        status: "complete",
                        canonical: structuredClone(canonical),
                        files: [textFile("instructions.json", entryText, "entry")],
                    },
                    sectionHandles: { [FILE_ID]: "subagent-entry" },
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: semanticKinds.map((semanticKind, index) => ({
            semanticRefFingerprint: `sha256:${String(index + 1).repeat(64)}`,
            consumerAgentRuntimeId: runtime.agentRuntimeId,
            subject:
                semanticKind === "subagent.invoked_context"
                    ? { subjectKind: "file" as const, assetId: ASSET_ID, versionId, fileId: FILE_ID }
                    : { subjectKind: "asset" as const, assetId: ASSET_ID, versionId },
            semanticKind,
        })) as RenderAnalysisInput["requiredSemantics"],
        dialectInputs: [nativeDialectInput(versionId, inputRole, runtime.agentRuntimeId)],
    };
}

function nativeDialectInput(
    targetVersionId: string,
    inputRole: "current_exact" | "parent_rebase_seed",
    agentRuntimeId: RuntimeSpec["agentRuntimeId"],
): RenderAnalysisInput["dialectInputs"][number] {
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
        files: [nativeFile(NATIVE_TEXT)],
    };
    return {
        targetVersion: { assetId: ASSET_ID, versionId: targetVersionId },
        consumerAgentRuntimeIds: [agentRuntimeId],
        inputs: [
            inputRole === "current_exact"
                ? common
                : {
                      ...common,
                      inputRole: "parent_rebase_seed" as const,
                      sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
                  },
        ],
    };
}

function materializationInput(runtime: RuntimeSpec, analysisInput: RenderAnalysisInput): RenderMaterializationInput {
    const support = supports[runtime.agentRuntimeId];
    const analysis = support.analyze(analysisInput);
    if (analysis.status !== "complete") throw new Error(`${runtime.agentRuntimeId} Subagent analysis did not close`);
    const contract = makeNativeProjectExactFileContractParts(support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Subagent exact target profile is missing");
    return {
        schemaVersion: 1,
        deployment: structuredClone(analysisInput.deployment),
        requiredSemantics: structuredClone(analysisInput.requiredSemantics),
        dialectInputs: structuredClone(analysisInput.dialectInputs),
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
                outcome: "preserved" as const,
            })),
        },
    };
}

function inspectionInput(
    materialization: RenderMaterializationInput,
    currentNativeText: string,
    appliedNativeText = NATIVE_TEXT,
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0];
    if (unit === undefined) throw new Error("Subagent materialization output unit is missing");
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
                    relativePath: NATIVE_PATH,
                    state: "changed",
                    appliedContentHash: sha256Text(appliedNativeText),
                    currentContentHash: sha256Text(currentNativeText),
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
                relativePath: NATIVE_PATH,
                appliedContent: { contentKind: "text", text: appliedNativeText },
                currentContent: { contentKind: "text", text: currentNativeText },
                diffHunks: [
                    {
                        hunkFingerprint: HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(appliedNativeText),
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(currentNativeText),
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

function validateMaterializedNative(
    canonical: Extract<AssetKindTypeDataV2, { kind: "Subagent" }>,
    entryText: string,
    nativeText: string,
): boolean {
    const descriptor = nativeFile(nativeText);
    const { text: _text, ...file } = descriptor;
    return validateCodexNativeDialect({
        canonical,
        canonicalFiles: [textFile("instructions.json", entryText, "entry")],
        representation: {
            schemaVersion: 1,
            dialectId: "codex-subagent-toml-v2",
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: [file],
        },
        nativeFiles: [{ relativePath: NATIVE_PATH, bytes: new TextEncoder().encode(nativeText) }],
    });
}

function originalCanonical(): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return subagentCanonical("oaam_phase54_subagent", "OAAM isolated Codex Subagent fixture", "gpt-5.4", "high");
}

function foreignCanonical(): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return subagentCanonical("oaam_phase54_foreign", "Foreign-edited Codex Subagent fixture", "gpt-5.5", "medium");
}

function subagentCanonical(
    name: string,
    description: string,
    model: string,
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
                model: { mode: "selected", dialectId: "codex-subagent-model-v1", selector: model, relativeTier: -1 },
                effort: {
                    mode: "selected",
                    dialectId: "codex-subagent-reasoning-effort-v1",
                    selector: effort,
                    relativeTier: -1,
                },
                sampling: { temperature: { mode: "agent_runtime_default" }, topP: { mode: "agent_runtime_default" } },
            },
            directInvocation: { mode: "delegated_only" },
            presentation: { listing: "agent_runtime_default", color: { mode: "agent_runtime_default" } },
        },
    };
}

function entry(instructions: string): string {
    return JSON.stringify({ schemaVersion: 1, sections: [{ title: "", content: instructions }] });
}

function nativeInput(input: RenderAnalysisInput) {
    const native = input.dialectInputs[0]?.inputs[0];
    if (native?.inputKind !== "native_representation") throw new Error("native Subagent fixture is missing");
    return native;
}

function replaceNativeText(native: ReturnType<typeof nativeInput>, text: string): void {
    const file = native.files[0];
    if (file === undefined || file.contentKind !== "text") throw new Error("native Subagent text file is missing");
    file.text = text;
    file.contentHash = sha256Text(text);
    file.byteSize = Buffer.byteLength(text);
}

function firstAsset(value: RenderAnalysisInput): RenderAnalysisInput["deployment"]["assets"][number] {
    const asset = value.deployment.assets[0];
    if (asset === undefined) throw new Error("Codex Subagent target fixture has no Asset");
    return asset;
}

function nativeFile(text: string) {
    return {
        relativePath: NATIVE_PATH,
        contentKind: "text" as const,
        mediaType: "application/octet-stream",
        contentHash: sha256Text(text),
        byteSize: Buffer.byteLength(text),
        executable: false,
        text,
    };
}

function textFile(logicalPath: string, text: string, role: "entry" | "resource") {
    return {
        contentKind: "text" as const,
        text,
        file: {
            fileId: role === "entry" ? FILE_ID : "88888888-8888-4888-8888-888888888888",
            logicalPath,
            role,
            contentHash: sha256Text(text),
            contentKind: "text" as const,
            mediaType: logicalPath.endsWith(".json") ? "application/json" : "text/markdown",
            byteSize: Buffer.byteLength(text),
            executable: false,
            references: [],
        },
    };
}

function sha256Text(text: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}
