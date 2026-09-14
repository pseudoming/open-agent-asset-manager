import { currentClaudeWorkflowTestSupports } from "./claudecode-workflow-target-test-support";
import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
    AdapterProviderSummary,
    AssetKindTypeDataV2,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderedTargetInspectionInput,
    Sha256Digest,
} from "@oaam/core";
import { makeNativeProjectExactGraphContractParts } from "../../../core/src/render/native-project-exact-graph";
import { nativeProjectRuleRegistryComponents } from "../../../core/src/render/native-project-rule";
import { assetSemanticKinds, fileSemanticKinds, requiredSemantic } from "../../../core/src/render/render-semantics";
import { claudecodeProvider } from "../src/claudecode-provider";
import { createClaudeCodeGlobalNativeDocumentTargetSupports } from "../src/claudecode-target-exact-graph";

const HASH = `sha256:${"7".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";

const previousSupports = createClaudeCodeGlobalNativeDocumentTargetSupports({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    cliTargetContextSchemaId: "CLAUDE_CODE_CLI_GLOBAL_CONFIG_TARGET_V1",
    appTargetContextSchemaId: "CLAUDE_CODE_APP_GLOBAL_CONFIG_TARGET_V1",
});

const supports = {
    ...previousSupports,
    Workflow: currentClaudeWorkflowTestSupports.global,
    AppWorkflow: currentClaudeWorkflowTestSupports.appGlobal,
};

type GlobalDocumentSupport = (typeof supports)[keyof typeof supports];
type GlobalDocumentKind = "Rule" | "Workflow";
interface GlobalDocumentSpec {
    support: GlobalDocumentSupport;
    agentRuntimeId: "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP";
    platform: "wsl" | "win32";
    versionText: string;
    buildIdentity: `sha256:${string}`;
    assetKind: GlobalDocumentKind;
    dialectId: string;
    nativePath: string;
    logicalPath: "RULE.md" | "WORKFLOW.md";
    name: string;
    description: string;
}

const SPECS: GlobalDocumentSpec[] = [
    {
        support: supports.Rule,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        platform: "wsl",
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        assetKind: "Rule",
        dialectId: "claudecode-rule-markdown-v1",
        nativePath: "rules/oaam-phase53-global-rule.md",
        logicalPath: "RULE.md",
        name: "oaam-phase53-global-rule",
        description: "",
    },
    {
        support: supports.AppRule,
        agentRuntimeId: "CLAUDE_CODE_APP",
        platform: "win32",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        assetKind: "Rule",
        dialectId: "claudecode-rule-markdown-v1",
        nativePath: "rules/oaam-phase53-app-global-rule.md",
        logicalPath: "RULE.md",
        name: "oaam-phase53-app-global-rule",
        description: "",
    },
    {
        support: supports.Workflow,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        platform: "wsl",
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        assetKind: "Workflow",
        dialectId: "claudecode-command-markdown-v1",
        nativePath: "commands/oaam-phase53-global-workflow.md",
        logicalPath: "WORKFLOW.md",
        name: "oaam-phase53-global-workflow",
        description: "Global Claude Workflow fixture",
    },
    {
        support: supports.AppWorkflow,
        agentRuntimeId: "CLAUDE_CODE_APP",
        platform: "win32",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        assetKind: "Workflow",
        dialectId: "claudecode-command-markdown-v1",
        nativePath: "commands/oaam-phase53-app-global-workflow.md",
        logicalPath: "WORKFLOW.md",
        name: "oaam-phase53-app-global-workflow",
        description: "Global Claude App Workflow fixture",
    },
];

describe("Claude Code user-global native Rule and Markdown Workflow targets", () => {
    it.each(
        SPECS,
    )("keeps $agentRuntimeId $assetKind current bytes, parent private syntax, and body-only reverse", async (spec) => {
        expect(spec.support.renderContractDeclaration).toMatchObject({
            declarationKind: "native_global_exact_graph_v1",
            agentRuntimeId: spec.agentRuntimeId,
            assetKind: spec.assetKind,
            nativeDialectId: spec.dialectId,
        });
        for (const inputRole of ["current_exact", "parent_rebase_seed"] as const) {
            const fixture = analysisFixture(spec, inputRole, inputRole === "current_exact" ? body(spec, "R1") : body(spec, "R2"));
            expect(await claudecodeProvider.analyzeRender(fixture)).toMatchObject({
                status: "complete",
                blockedSemanticRefs: [],
                diagnostics: [],
                outputUnits: [
                    expect.objectContaining({
                        outputContractId: spec.support.renderContractDeclaration.outputContractId,
                        claims: [{ relativePath: spec.nativePath, contentKind: "text", executable: false }],
                    }),
                ],
            });
            const materialization = materializationInput(spec, fixture);
            await expect(claudecodeProvider.materializeRender(materialization)).resolves.toMatchObject({
                status: "complete",
                materializationState: "materialized",
                materializedUnits: [
                    {
                        files: [
                            expect.objectContaining({
                                relativePath: spec.nativePath,
                                content: {
                                    contentKind: "text",
                                    text: `${header(spec)}${body(spec, inputRole === "current_exact" ? "R1" : "R2")}`,
                                },
                            }),
                        ],
                    },
                ],
            });
        }

        const current = analysisFixture(spec, "current_exact", body(spec, "R1"));
        const materialization = materializationInput(spec, current);
        await expect(
            claudecodeProvider.inspectRenderedTarget(
                inspectionInput(spec, materialization, `${header(spec)}${body(spec, "R2")}`),
            ),
        ).resolves.toMatchObject({
            status: "complete",
            files: [{ relativePath: spec.nativePath, attributionState: "uniquely_attributable" }],
            changes: [
                {
                    changeKind: "file_content_replacement",
                    replacementContent: { contentKind: "text", text: body(spec, "R2") },
                },
            ],
        });
    });

    it.each(SPECS)("fails closed for malformed $agentRuntimeId $assetKind native graphs and metadata drift", async (spec) => {
        const extra = analysisFixture(spec, "current_exact", body(spec, "R1"));
        const native = requiredNative(extra);
        const nativeFile = native.files[0];
        const representationFile = native.representation.files[0];
        if (nativeFile === undefined || representationFile === undefined) throw new Error("fixture file missing");
        native.files.push(structuredClone(nativeFile));
        native.representation.files.push(structuredClone(representationFile));
        expect(spec.support.analyze(extra).status).toBe("failed");

        const wrongPath = analysisFixture(spec, "current_exact", body(spec, "R1"));
        const wrongNative = requiredNative(wrongPath);
        const wrongNativeFile = wrongNative.files[0];
        const wrongRepresentationFile = wrongNative.representation.files[0];
        if (wrongNativeFile === undefined || wrongRepresentationFile === undefined) throw new Error("fixture file missing");
        wrongNativeFile.relativePath = "../escape.md";
        wrongRepresentationFile.relativePath = "../escape.md";
        expect(spec.support.analyze(wrongPath).status).toBe("failed");

        const empty = analysisFixture(spec, "current_exact", "");
        expect(spec.support.analyze(empty).status).toBe("failed");

        const parent = analysisFixture(spec, "parent_rebase_seed", body(spec, "R2"));
        parent.dialectInputs[0]?.inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: "foreign-private-v1",
                restorationContractFingerprint: HASH,
                contentHash: HASH,
            },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(spec.support.analyze(parent).status).toBe("failed");

        const current = analysisFixture(spec, "current_exact", body(spec, "R1"));
        const materialization = materializationInput(spec, current);
        await expect(
            claudecodeProvider.inspectRenderedTarget(
                inspectionInput(
                    spec,
                    materialization,
                    `${header(spec).replace("# preserve user-global layout", "# changed private layout")}${body(spec, "R2")}`,
                ),
            ),
        ).resolves.toMatchObject({
            status: "complete",
            changes: [],
            files: [{ attributionState: "conflict", reasonCode: "native_global_exact_graph_content_not_reconcilable" }],
        });
    });

    it.each(
        SPECS.filter((spec) => spec.assetKind === "Rule"),
    )("uses the $agentRuntimeId global canonical Rule fallback only when no Claude lineage exists", async (spec) => {
        const fixture = analysisFixture(spec, "current_exact", body(spec, "R1"));
        fixture.dialectInputs = [];
        const analysis = await claudecodeProvider.analyzeRender(fixture);
        const outputContractId =
            spec.agentRuntimeId === "CLAUDE_CODE_APP"
                ? "CLAUDECODE_APP_NATIVE_GLOBAL_RULE_V1"
                : "CLAUDECODE_NATIVE_GLOBAL_RULE_V1";
        expect(analysis).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
            outputUnits: [expect.objectContaining({ outputContractId })],
        });
        const materialization = canonicalRuleMaterializationInput(fixture, analysis, outputContractId);
        const materializedResult = await claudecodeProvider.materializeRender(materialization);
        expect(materializedResult).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: spec.nativePath, content: { text: body(spec, "R1") } }] }],
        });
        if (materializedResult.materializationState !== "materialized") {
            throw new Error("global canonical Rule did not materialize");
        }
        const materialized = materializedResult.materializedUnits[0]?.files[0];
        if (materialized === undefined) throw new Error("global canonical Rule file missing");
        await expect(
            claudecodeProvider.inspectRenderedTarget(inspectionInput(spec, materialization, body(spec, "R2"), materialized)),
        ).resolves.toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: body(spec, "R2") } }],
            files: [{ attributionState: "uniquely_attributable" }],
        });
    });
});

function analysisFixture(
    spec: GlobalDocumentSpec,
    inputRole: "current_exact" | "parent_rebase_seed",
    targetText: string,
): RenderAnalysisInput {
    const versionId = inputRole === "current_exact" ? VERSION_ID : "55555555-5555-4555-8555-555555555555";
    const canonical = canonicalValue(spec);
    const file = textFile(spec.logicalPath, targetText);
    const nativeText = `${header(spec)}${inputRole === "current_exact" ? targetText : body(spec, "R1")}`;
    const nativeFile = nativeInputFile(spec.nativePath, nativeText);
    const native = {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: spec.dialectId,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: [nativeDescriptor(nativeFile)],
        },
        files: [nativeFile],
    };
    const asset = {
        scope: "global" as const,
        projectId: "",
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId: ASSET_ID, versionId },
            versionFingerprint: HASH,
            versionCanonicalContentFingerprint: HASH,
            status: "complete" as const,
            canonical,
            files: [file],
        },
        sectionHandles: { [FILE_ID]: `${spec.assetKind.toLowerCase()}-entry` },
    };
    const requiredSemantics = [
        ...assetSemanticKinds(spec.assetKind).map((semanticKind) =>
            requiredSemantic(spec.agentRuntimeId, { subjectKind: "asset", assetId: ASSET_ID, versionId }, semanticKind),
        ),
        ...fileSemanticKinds(spec.assetKind, file).map((semanticKind) =>
            requiredSemantic(
                spec.agentRuntimeId,
                { subjectKind: "file", assetId: ASSET_ID, versionId, fileId: FILE_ID },
                semanticKind,
            ),
        ),
    ];
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: spec.platform,
            platformInstanceId: `test-${spec.platform}`,
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: spec.agentRuntimeId,
                    versionText: spec.versionText,
                    buildIdentity: spec.buildIdentity,
                    targetContextSchemaId: spec.support.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: spec.support.targetContextSchema.schemaFingerprint,
                    renderFacts: [{ key: "oaam.platform", value: spec.platform, evidenceLevel: "agent_runtime_verified" }],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [asset],
            renderInputFingerprint: HASH,
        },
        requiredSemantics,
        dialectInputs: [
            {
                targetVersion: { assetId: ASSET_ID, versionId },
                consumerAgentRuntimeIds: [spec.agentRuntimeId],
                inputs: [
                    inputRole === "current_exact"
                        ? native
                        : {
                              ...native,
                              inputRole: "parent_rebase_seed" as const,
                              sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
                          },
                ],
            },
        ],
    };
}

function materializationInput(spec: GlobalDocumentSpec, fixture: RenderAnalysisInput): RenderMaterializationInput {
    const analysis = spec.support.analyze(fixture);
    if (analysis.status !== "complete") throw new Error("global native document analysis did not close");
    const contract = makeNativeProjectExactGraphContractParts(spec.support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("global native document profile missing");
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
                rendererAdapterId: claudecodeProvider.adapterId,
                rendererAdapterVersion: claudecodeProvider.version,
                materializerCapabilityKey: spec.support.materializerCapability.materializerCapabilityKey,
                materializationProfileId: spec.support.renderContractDeclaration.materializationProfileId,
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
    spec: GlobalDocumentSpec,
    materialization: RenderMaterializationInput,
    currentText: string,
    materializedOverride?: {
        relativePath: string;
        content: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
        executable: boolean;
        semanticRefFingerprints: Sha256Digest[];
        sectionBindings: never[] | Array<{ sectionHandle: string; startByte: number; endByte: number }>;
    },
): RenderedTargetInspectionInput {
    const result = spec.support.materialize(materialization);
    const unit = materialization.selection.outputUnits[0];
    const materialized =
        materializedOverride ??
        (result.materializationState === "materialized" ? result.materializedUnits[0]?.files[0] : undefined);
    if (unit === undefined || materialized?.content.contentKind !== "text") {
        throw new Error("global native document materialization missing");
    }
    const appliedText = materialized.content.text;
    return {
        schemaVersion: 1,
        deploymentId: "66666666-6666-4666-8666-666666666666",
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
                renderStrategy: "native_graph",
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
                    relativePath: spec.nativePath,
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
                relativePath: spec.nativePath,
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
                    semanticRefFingerprints: materialized.semanticRefFingerprints,
                    sectionBindings: materialized.sectionBindings,
                    materializationFingerprint: HASH,
                    provenanceFingerprint: HASH,
                },
            },
        ],
        inventoryDeltas: [],
    };
}

function canonicalRuleMaterializationInput(
    fixture: RenderAnalysisInput,
    analysis: Awaited<ReturnType<typeof claudecodeProvider.analyzeRender>>,
    outputContractId: string,
): RenderMaterializationInput {
    if (analysis.status !== "complete") throw new Error("global canonical Rule analysis did not close");
    const unit = analysis.outputUnits[0];
    const capability = claudecodeProvider.materializerCapabilities.find(
        (candidate) => candidate.outputContractId === outputContractId,
    );
    const profile = nativeProjectRuleRegistryComponents([providerSummary()]).outputContracts.find(
        (candidate) => candidate.outputContractId === outputContractId,
    )?.materializationProfiles[0];
    if (unit === undefined || capability === undefined || profile === undefined) {
        throw new Error("global canonical Rule materialization authority missing");
    }
    return {
        schemaVersion: 1,
        deployment: structuredClone(fixture.deployment),
        requiredSemantics: structuredClone(fixture.requiredSemantics),
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

function canonicalValue(spec: GlobalDocumentSpec): AssetKindTypeDataV2 {
    if (spec.assetKind === "Rule") {
        return {
            kind: "Rule",
            typeData: { schemaVersion: 2, name: spec.name, description: spec.description, activation: { mode: "always" } },
        };
    }
    return {
        kind: "Workflow",
        typeData: {
            schemaVersion: 2,
            name: spec.name,
            description: spec.description,
            implementation: {
                kind: "instructions",
                instructionDialectId: spec.dialectId,
                execution: {
                    mode: "caller",
                    agent: { mode: "agent_runtime_default" },
                    model: { mode: "inherit" },
                    effort: { mode: "inherit" },
                    shell: { mode: "selected", dialectId: "claudecode-shell-selector-v1", selector: "bash" },
                },
                toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
            },
            invocation: {
                commandNames: [spec.name],
                userInvocable: true,
                agentInvocable: false,
                argumentHint: "",
                argumentNames: [],
            },
        },
    };
}

function header(spec: GlobalDocumentSpec): string {
    return spec.assetKind === "Rule"
        ? [
              "---",
              "# preserve user-global layout",
              `name: ${spec.name}`,
              `description: ${JSON.stringify(spec.description)}`,
              "---",
              "",
          ].join("\n")
        : [
              "---",
              "# preserve user-global layout",
              `description: ${spec.description}`,
              "disable-model-invocation: true",
              "---",
              "",
          ].join("\n");
}

function body(spec: GlobalDocumentSpec, marker: "R1" | "R2"): string {
    return spec.assetKind === "Rule"
        ? `\nAlways preserve OAAM_GLOBAL_RULE_${marker}.\n`
        : `\nReply with exactly OAAM_GLOBAL_WORKFLOW_${marker}.\n`;
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
            mediaType: "text/markdown",
            byteSize: Buffer.byteLength(text),
            executable: false,
            references: [],
        },
    };
}

function nativeInputFile(relativePath: string, text: string) {
    return {
        relativePath,
        contentKind: "text" as const,
        mediaType: "text/markdown",
        contentHash: sha256Text(text),
        byteSize: Buffer.byteLength(text),
        executable: false,
        text,
    };
}

function nativeDescriptor(file: ReturnType<typeof nativeInputFile>) {
    const { text: _text, ...descriptor } = file;
    return descriptor;
}

function requiredNative(input: RenderAnalysisInput) {
    const native = input.dialectInputs[0]?.inputs[0];
    if (native?.inputKind !== "native_representation") throw new Error("global native document fixture missing");
    return native;
}

function sha256Text(text: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}
