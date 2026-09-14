import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
    AdapterNativeProjectRuleRenderDeclarationV1,
    AssetKindTypeDataV2,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderedTargetInspectionInput,
    Sha256Digest,
} from "@oaam/core";
import { makeNativeProjectExactFileContractParts } from "../../../core/src/render/native-project-exact-file";
import { makeNativeProjectRuleContractParts } from "../../../core/src/render/native-project-rule-profiles";
import { claudecodeProvider } from "../src/claudecode-provider";
import { validateClaudeCodeNativeDialect } from "../src/claudecode-source-read";
import { createClaudeCodeExactFileTargetSupports } from "../src/claudecode-target-exact-file";

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const BODY = "\nAlways preserve `OAAM_RULE_NATIVE_R1` exactly.\n";
const CHANGED_BODY = BODY.replace("R1", "R2");

const targetContextSchemaId = claudecodeProvider.targetContextSchemas[0]?.targetContextSchemaId;
if (targetContextSchemaId === undefined) throw new Error("Claude Code target context schema is missing");
const appTargetContextSchemaId = claudecodeProvider.targetContextSchemas.find(
    (schema) => schema.agentRuntimeId === "CLAUDE_CODE_APP",
)?.targetContextSchemaId;
if (appTargetContextSchemaId === undefined) throw new Error("Claude Code App target context schema is missing");
const supports = createClaudeCodeExactFileTargetSupports({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId,
    appTargetContextSchemaId,
    memoryTargetContextSchemaId: "CLAUDE_CODE_CLI_PROJECT_MEMORY_DIRECTORY_TARGET_V1",
    appMemoryTargetContextSchemaId: "CLAUDE_CODE_APP_PROJECT_MEMORY_DIRECTORY_TARGET_V1",
});

interface RuleSpec {
    supportKey: "Rule" | "AppRule";
    agentRuntimeId: "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP";
    versionText: string;
    buildIdentity: `sha256:${string}`;
    platform: "wsl" | "win32";
    platformInstanceId: string;
    path: string;
    name: string;
}

const SPECS: RuleSpec[] = [
    {
        supportKey: "Rule",
        agentRuntimeId: "CLAUDE_CODE_CLI",
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
        platform: "wsl",
        platformInstanceId: "test-wsl",
        path: ".claude/rules/oaam-always.md",
        name: "oaam-always",
    },
    {
        supportKey: "AppRule",
        agentRuntimeId: "CLAUDE_CODE_APP",
        versionText: "2.1.219",
        buildIdentity: "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637",
        platform: "win32",
        platformInstanceId: "test-win32",
        path: ".claude/rules/oaam-app-always.md",
        name: "oaam-app-always",
    },
];

describe("Claude Code exact-native project Rule targets", () => {
    it.each(SPECS)("restores $agentRuntimeId current-exact bytes through the frozen Provider facade", async (spec) => {
        const current = fixture(spec, "current_exact");
        const analysis = await claudecodeProvider.analyzeRender(current);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.outputUnits).toEqual([
            expect.objectContaining({
                outputContractId:
                    spec.supportKey === "Rule"
                        ? "CLAUDECODE_NATIVE_PROJECT_RULE_EXACT_FILE_V1"
                        : "CLAUDECODE_APP_NATIVE_PROJECT_RULE_EXACT_FILE_V1",
                claims: [{ relativePath: spec.path, contentKind: "text", executable: false }],
            }),
        ]);

        const materialization = materializationInput(spec, current);
        const materialized = await claudecodeProvider.materializeRender(materialization);
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: spec.path, content: { text: nativeText(spec) } }] }],
        });
        expect(nativeMatches(spec, BODY, nativeText(spec), ruleCanonical(spec.name))).toBe(true);
    });

    it.each(SPECS)("keeps the $agentRuntimeId canonical fallback for a new Rule with no Claude lineage", async (spec) => {
        const canonical = fixture(spec, "current_exact");
        canonical.dialectInputs = [];
        const analysis = await claudecodeProvider.analyzeRender(canonical);
        const outputContractId =
            spec.supportKey === "Rule" ? "CLAUDECODE_NATIVE_PROJECT_RULE_V1" : "CLAUDECODE_APP_NATIVE_PROJECT_RULE_V1";
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.outputUnits).toEqual([
            expect.objectContaining({
                outputContractId,
                claims: [{ relativePath: spec.path, contentKind: "text", executable: false }],
            }),
        ]);
        expect(
            await claudecodeProvider.materializeRender(canonicalMaterializationInput(canonical, analysis, outputContractId)),
        ).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: spec.path, content: { text: BODY } }] }],
        });
    });

    it.each(SPECS)("never lets an invalid $agentRuntimeId native lineage fall through to canonical Rule bytes", async (spec) => {
        const invalid = fixture(spec, "current_exact");
        const native = invalid.dialectInputs[0]?.inputs[0];
        if (native?.inputKind !== "native_representation" || native.files[0] === undefined) {
            throw new Error("Rule native fixture missing");
        }
        native.files[0].relativePath = "../escape.md";
        const analysis = await claudecodeProvider.analyzeRender(invalid);
        expect(analysis.status).toBe("failed");
        expect(analysis.outputUnits).toEqual([]);
        expect(analysis.outputUnits.some((unit) => unit.outputContractId.endsWith("PROJECT_RULE_V1"))).toBe(false);
    });

    it("classifies one CLI exact-native Rule and one new canonical Rule in the same target cell", async () => {
        const spec = SPECS[0];
        if (spec === undefined) throw new Error("CLI Rule fixture missing");
        const native = fixture(spec, "current_exact");
        const canonical = fixture(spec, "current_exact");
        canonical.dialectInputs = [];
        reidentifyRuleFixture(canonical, {
            assetId: "66666666-6666-4666-8666-666666666666",
            versionId: "77777777-7777-4777-8777-777777777777",
            fileId: "88888888-8888-4888-8888-888888888888",
            name: "oaam-canonical-always",
        });
        const combined: RenderAnalysisInput = {
            schemaVersion: 1,
            deployment: {
                ...native.deployment,
                assets: [...native.deployment.assets, ...canonical.deployment.assets],
            },
            requiredSemantics: [...native.requiredSemantics, ...canonical.requiredSemantics],
            dialectInputs: native.dialectInputs,
        };
        const analysis = await claudecodeProvider.analyzeRender(combined);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.outputUnits.map((unit) => unit.outputContractId).sort()).toEqual([
            "CLAUDECODE_NATIVE_PROJECT_RULE_EXACT_FILE_V1",
            "CLAUDECODE_NATIVE_PROJECT_RULE_V1",
        ]);
        expect(new Set(analysis.semanticOptions.map((option) => option.semanticRefFingerprint)).size).toBe(6);
    });

    it.each(SPECS)("rebases only $agentRuntimeId canonical body and preserves the Claude header byte-for-byte", (spec) => {
        const rebased = fixture(spec, "parent_rebase_seed", CHANGED_BODY);
        const support = supports[spec.supportKey];
        const analysis = support.analyze(rebased);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        const materialized = support.materialize(materializationInput(spec, rebased));
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ content: { text: `${header(spec)}${CHANGED_BODY}` } }] }],
        });
        expect(nativeMatches(spec, CHANGED_BODY, `${header(spec)}${CHANGED_BODY}`, ruleCanonical(spec.name))).toBe(true);
    });

    it.each(SPECS)("accepts only a $agentRuntimeId body change during reverse inspection", (spec) => {
        const current = fixture(spec, "current_exact");
        const materialization = materializationInput(spec, current);
        const support = supports[spec.supportKey];
        expect(support.inspect(inspectionInput(spec, materialization, `${header(spec)}${CHANGED_BODY}`))).toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: CHANGED_BODY } }],
            files: [{ attributionState: "uniquely_attributable" }],
        });
        expect(
            support.inspect(
                inspectionInput(
                    spec,
                    materialization,
                    `${header(spec).replace("# preserve native layout", "# drifted layout")}${CHANGED_BODY}`,
                ),
            ),
        ).toMatchObject({
            status: "complete",
            changes: [],
            files: [{ attributionState: "conflict", reasonCode: "native_project_exact_file_change_not_reconcilable" }],
        });
    });

    it.each(
        SPECS,
    )("blocks a $agentRuntimeId parent rebase when canonical Rule behavior no longer matches its native seed", (spec) => {
        const description = fixture(spec, "parent_rebase_seed", CHANGED_BODY);
        const descriptionAsset = ruleAsset(description);
        descriptionAsset.version.canonical.typeData.description = "changed outside Claude";
        expect(supports[spec.supportKey].analyze(description).status).toBe("failed");

        const activation = fixture(spec, "parent_rebase_seed", CHANGED_BODY);
        const activationAsset = ruleAsset(activation);
        activationAsset.version.canonical.typeData.activation = { mode: "path", globs: ["src/**/*.ts"] };
        expect(supports[spec.supportKey].analyze(activation).status).toBe("failed");

        const renamed = fixture(spec, "parent_rebase_seed", CHANGED_BODY);
        const renamedAsset = ruleAsset(renamed);
        renamedAsset.version.canonical.typeData.name = "renamed";
        expect(supports[spec.supportKey].analyze(renamed).status).toBe("failed");
    });

    it.each(SPECS)("rejects unsafe $agentRuntimeId paths, incomplete assets, extra files, and foreign restoration", (spec) => {
        const unsafe = fixture(spec, "current_exact");
        const native = unsafe.dialectInputs[0]?.inputs[0];
        if (native?.inputKind !== "native_representation" || native.files[0] === undefined) {
            throw new Error("Rule native fixture missing");
        }
        native.files[0].relativePath = "../escape.md";
        expect(supports[spec.supportKey].analyze(unsafe).status).toBe("failed");

        const incomplete = fixture(spec, "current_exact");
        ruleAsset(incomplete).version.status = "incomplete";
        expect(supports[spec.supportKey].analyze(incomplete).status).toBe("failed");

        const extra = fixture(spec, "current_exact");
        ruleAsset(extra).version.files.push(textFile("RESOURCE.md", "not part of a one-file Rule\n"));
        expect(supports[spec.supportKey].analyze(extra).status).toBe("failed");

        const restoration = fixture(spec, "current_exact");
        restoration.dialectInputs[0]?.inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: "foreign-runtime-private-v1",
                restorationContractFingerprint: HASH,
                contentHash: HASH,
            },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(supports[spec.supportKey].analyze(restoration).status).toBe("failed");
    });

    it("preserves a nested path-activated Rule instead of shrinking the cell to unconditional fixtures", () => {
        const baseSpec = SPECS[0];
        if (baseSpec === undefined) throw new Error("CLI Rule fixture missing");
        const spec = { ...baseSpec, path: ".claude/rules/nested/typescript.md", name: "TypeScript" };
        const canonical = ruleCanonical(spec.name, "TS files", { mode: "path", globs: ["src/**/*.ts"] });
        const native = [
            "---",
            "# preserve nested Rule layout",
            "name: TypeScript",
            "description: TS files",
            "paths: [src/**/*.ts]",
            "---",
            "",
        ].join("\n");
        const current = fixture(spec, "current_exact", BODY, canonical, `${native}${BODY}`);
        const materialized = supports.Rule.materialize(materializationInput(spec, current));
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: spec.path, content: { text: `${native}${BODY}` } }] }],
        });
    });
});

function fixture(
    spec: RuleSpec,
    inputRole: "current_exact" | "parent_rebase_seed",
    entryText = BODY,
    canonical = ruleCanonical(spec.name),
    sourceNativeText = nativeText(spec),
): RenderAnalysisInput {
    const versionId = inputRole === "current_exact" ? VERSION_ID : "66666666-6666-4666-8666-666666666666";
    const support = supports[spec.supportKey];
    const asset = {
        scope: "project" as const,
        projectId: PROJECT_ID,
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId: ASSET_ID, versionId },
            versionFingerprint: HASH,
            versionCanonicalContentFingerprint: HASH,
            status: "complete" as const,
            canonical: structuredClone(canonical),
            files: [textFile("RULE.md", entryText)],
        },
        sectionHandles: { [FILE_ID]: "rule-entry" },
    };
    const common = {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: "claudecode-rule-markdown-v1",
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
        },
        files: [nativeFile(spec.path, sourceNativeText)],
    };
    const native =
        inputRole === "current_exact"
            ? common
            : {
                  ...common,
                  inputRole: "parent_rebase_seed" as const,
                  sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
              };
    return {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: spec.platform,
            platformInstanceId: spec.platformInstanceId,
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: spec.agentRuntimeId,
                    versionText: spec.versionText,
                    buildIdentity: spec.buildIdentity,
                    targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
                    renderFacts: [{ key: "oaam.platform", value: spec.platform, evidenceLevel: "agent_runtime_verified" }],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [asset],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: [
            semantic("1", spec.agentRuntimeId, versionId, "asset.file_inventory"),
            semantic("2", spec.agentRuntimeId, versionId, "rule.activation"),
            semantic("3", spec.agentRuntimeId, versionId, "rule.content", FILE_ID),
        ],
        dialectInputs: [
            { targetVersion: { assetId: ASSET_ID, versionId }, consumerAgentRuntimeIds: [spec.agentRuntimeId], inputs: [native] },
        ],
    };
}

function materializationInput(spec: RuleSpec, analysisInput: RenderAnalysisInput): RenderMaterializationInput {
    const support = supports[spec.supportKey];
    const analysis = support.analyze(analysisInput);
    if (analysis.status !== "complete") throw new Error("Rule analysis fixture did not close");
    const contract = makeNativeProjectExactFileContractParts(support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Rule materialization profile missing");
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
                rendererAdapterId: "CLAUDECODE",
                rendererAdapterVersion: claudecodeProvider.version,
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

function canonicalMaterializationInput(
    analysisInput: RenderAnalysisInput,
    analysis: Awaited<ReturnType<typeof claudecodeProvider.analyzeRender>>,
    outputContractId: string,
): RenderMaterializationInput {
    if (analysis.status !== "complete") throw new Error("canonical Rule analysis did not close");
    const declaration = claudecodeProvider.renderContractDeclarations.find(
        (candidate): candidate is AdapterNativeProjectRuleRenderDeclarationV1 =>
            candidate.declarationKind === "native_project_rule_v1" && candidate.outputContractId === outputContractId,
    );
    const materializer = claudecodeProvider.materializerCapabilities.find(
        (candidate) => candidate.outputContractId === outputContractId,
    );
    if (declaration === undefined || materializer === undefined) throw new Error("canonical Rule declaration missing");
    const profile = makeNativeProjectRuleContractParts(declaration).outputContract.materializationProfiles[0];
    if (profile === undefined) throw new Error("canonical Rule profile missing");
    return {
        schemaVersion: 1,
        deployment: structuredClone(analysisInput.deployment),
        requiredSemantics: structuredClone(analysisInput.requiredSemantics),
        dialectInputs: [],
        selection: {
            schemaVersion: 1,
            outputUnits: analysis.outputUnits,
            outputUnitRenderers: analysis.outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                rendererAdapterId: "CLAUDECODE",
                rendererAdapterVersion: claudecodeProvider.version,
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
                outcome: "preserved" as const,
            })),
        },
    };
}

function inspectionInput(
    spec: RuleSpec,
    materialization: RenderMaterializationInput,
    currentNativeText: string,
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0];
    if (unit === undefined) throw new Error("Rule output unit missing");
    const applied = nativeText(spec);
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
                consumerOwnerAdapterId: "CLAUDECODE",
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
                    relativePath: spec.path,
                    state: "changed",
                    appliedContentHash: sha256Text(applied),
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
                relativePath: spec.path,
                appliedContent: { contentKind: "text", text: applied },
                currentContent: { contentKind: "text", text: currentNativeText },
                diffHunks: [
                    {
                        hunkFingerprint: HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(applied),
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

function nativeMatches(spec: RuleSpec, body: string, text: string, canonical: ReturnType<typeof ruleCanonical>): boolean {
    const descriptor = nativeFile(spec.path, text);
    const { text: _text, ...file } = descriptor;
    return validateClaudeCodeNativeDialect({
        canonical,
        canonicalFiles: [textFile("RULE.md", body)],
        representation: {
            schemaVersion: 1,
            dialectId: "claudecode-rule-markdown-v1",
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: [file],
        },
        nativeFiles: [{ relativePath: spec.path, bytes: new TextEncoder().encode(text) }],
    });
}

function header(spec: RuleSpec): string {
    return ["---", "# preserve native layout", `name: ${spec.name}`, 'description: ""', "---", ""].join("\n");
}

function nativeText(spec: RuleSpec): string {
    return `${header(spec)}${BODY}`;
}

function ruleCanonical(
    name: string,
    description = "",
    activation: Extract<AssetKindTypeDataV2, { kind: "Rule" }>["typeData"]["activation"] = { mode: "always" },
): Extract<AssetKindTypeDataV2, { kind: "Rule" }> {
    return { kind: "Rule", typeData: { schemaVersion: 2, name, description, activation } };
}

function ruleAsset(input: RenderAnalysisInput) {
    const asset = input.deployment.assets[0];
    if (asset?.version.canonical.kind !== "Rule") throw new Error("Rule fixture missing");
    return asset;
}

function reidentifyRuleFixture(
    input: RenderAnalysisInput,
    ids: { assetId: string; versionId: string; fileId: string; name: string },
): void {
    const asset = ruleAsset(input);
    const previousFileId = asset.version.files[0]?.file.fileId;
    if (previousFileId === undefined) throw new Error("Rule entry missing");
    const entryFile = asset.version.files[0];
    if (entryFile === undefined) throw new Error("Rule entry missing");
    asset.version.ref = { assetId: ids.assetId, versionId: ids.versionId };
    asset.version.canonical.typeData.name = ids.name;
    entryFile.file.fileId = ids.fileId;
    asset.sectionHandles = { [ids.fileId]: asset.sectionHandles[previousFileId] ?? "rule-entry" };
    for (const [index, semanticRef] of input.requiredSemantics.entries()) {
        semanticRef.semanticRefFingerprint = `sha256:${String(index + 4).repeat(64)}` as Sha256Digest;
        semanticRef.subject =
            semanticRef.subject.subjectKind === "file"
                ? { subjectKind: "file", assetId: ids.assetId, versionId: ids.versionId, fileId: ids.fileId }
                : { subjectKind: "asset", assetId: ids.assetId, versionId: ids.versionId };
    }
}

function semantic(
    value: string,
    agentRuntimeId: RuleSpec["agentRuntimeId"],
    versionId: string,
    semanticKind: string,
    fileId?: string,
) {
    return {
        semanticRefFingerprint: `sha256:${value.repeat(64)}` as Sha256Digest,
        consumerAgentRuntimeId: agentRuntimeId,
        subject:
            fileId === undefined
                ? { subjectKind: "asset" as const, assetId: ASSET_ID, versionId }
                : { subjectKind: "file" as const, assetId: ASSET_ID, versionId, fileId },
        semanticKind,
    };
}

function nativeFile(relativePath: string, text: string) {
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

function textFile(logicalPath: string, text: string) {
    return {
        contentKind: "text" as const,
        text,
        file: {
            fileId: logicalPath === "RULE.md" ? FILE_ID : "88888888-8888-4888-8888-888888888888",
            logicalPath,
            role: logicalPath === "RULE.md" ? ("entry" as const) : ("resource" as const),
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
    return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}
