import {
    currentClaudeWorkflowTestSupports,
    makeClaudeNativeMaterializationInput,
} from "./claudecode-workflow-target-test-support";
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
import { validateClaudeCodeNativeDialect } from "../src/claudecode-source-read";
import { claudecodeProvider } from "../src/claudecode-provider";
import { createClaudeCodeExactFileTargetSupports } from "../src/claudecode-target-exact-file";
import {
    appMemoryCatalogFixture,
    catalogInspectionInput,
    catalogMaterializationInput,
    catalogOnlyInput,
    CHANGED_MEMORY_CATALOG_TEXT,
    FIRST_MEMORY_VERSION_ID,
    memoryCatalogCanonical,
    memoryCatalogFixture,
    memoryCatalogTargetSupports,
    MEMORY_CATALOG_TEXT,
    providerMemoryMaterializationInput,
    replaceCatalogNative,
    SECOND_MEMORY_VERSION_ID,
} from "./claudecode-memory-catalog-target-test-support";

type ExactKind = "Workflow" | "Memory";

interface ExactFixtureSpec {
    kind: ExactKind;
    nativeDialectId: string;
    nativePath: string;
    nativeText: string;
    canonical: Extract<AssetKindTypeDataV2, { kind: ExactKind }>;
    rebasedCanonical: Extract<AssetKindTypeDataV2, { kind: ExactKind }>;
    entryPath: string;
    entryText: string;
    changedEntryText: string;
    bodyOnlyChangedNativeText: string;
    changedNativeText: string;
    metadataDriftedNativeText: string;
    semanticKinds: string[];
    restorationPayload: Uint8Array | null;
}

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const WORKFLOW_BODY = "\nReply with exactly `OAAM_CC_21220_WORKFLOW_47A9C1` and no other text.\n";
const WORKFLOW_HEADER = [
    "---",
    "# keep workflow layout",
    "description: OAAM isolated Claude Code 2.1.220 Workflow load fixture",
    "disable-model-invocation: true",
    "---",
    "",
].join("\n");
const MEMORY_BODY = "\nAlways answer the isolated memory check with `OAAM_CC_21220_MEMORY_5E71B4`.\n";
const MEMORY_CHANGED_BODY = MEMORY_BODY.replace("5E71B4", "8C20D9");
const MEMORY_HEADER = [
    "---",
    "# keep memory layout",
    "name: OAAM Memory fixture # keep name comment",
    "description: Isolated Claude Code Memory topic # keep description comment",
    "metadata:",
    "  node_type: memory",
    "  type: project",
    "  originSessionId: oaam-phase53-session",
    "---",
    "",
].join("\n");
const MEMORY_CHANGED_HEADER = MEMORY_HEADER.replace("name: OAAM Memory fixture", 'name: "OAAM rebased Memory fixture"').replace(
    "description: Isolated Claude Code Memory topic",
    'description: "Rebased Claude Code Memory topic"',
);
const MEMORY_RESTORATION = Buffer.from(
    JSON.stringify({
        schemaVersion: 1,
        dialectId: "claudecode-memory-topic-v1",
        topLevelType: "",
        metadataType: "project",
        metadataOriginSessionId: "oaam-phase53-session",
        metadataNodeType: "memory",
    }),
);
const targetContextSchemaId = claudecodeProvider.targetContextSchemas[0]?.targetContextSchemaId;
if (targetContextSchemaId === undefined) throw new Error("Claude Code target context schema is missing");
const appTargetContextSchemaId = claudecodeProvider.targetContextSchemas.find(
    (schema) => schema.agentRuntimeId === "CLAUDE_CODE_APP",
)?.targetContextSchemaId;
if (appTargetContextSchemaId === undefined) throw new Error("Claude Code App target context schema is missing");
const memoryTargetContextSchemaId = "CLAUDE_CODE_CLI_PROJECT_MEMORY_DIRECTORY_TARGET_V1";
const appMemoryTargetContextSchemaId = "CLAUDE_CODE_APP_PROJECT_MEMORY_DIRECTORY_TARGET_V1";
const supports = createClaudeCodeExactFileTargetSupports({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId,
    appTargetContextSchemaId,
    memoryTargetContextSchemaId,
    appMemoryTargetContextSchemaId,
});

const FIXTURES: ExactFixtureSpec[] = [
    {
        kind: "Workflow",
        nativeDialectId: "claudecode-command-markdown-v1",
        nativePath: ".claude/commands/oaam-phase53-workflow.md",
        nativeText: `${WORKFLOW_HEADER}${WORKFLOW_BODY}`,
        canonical: workflowCanonical(),
        rebasedCanonical: workflowCanonical(),
        entryPath: "WORKFLOW.md",
        entryText: WORKFLOW_BODY,
        changedEntryText: WORKFLOW_BODY.replace("47A9C1", "B0D1A2"),
        bodyOnlyChangedNativeText: `${WORKFLOW_HEADER}${WORKFLOW_BODY.replace("47A9C1", "B0D1A2")}`,
        changedNativeText: `${WORKFLOW_HEADER}${WORKFLOW_BODY.replace("47A9C1", "B0D1A2")}`,
        metadataDriftedNativeText: `${WORKFLOW_HEADER.replace("Workflow load fixture", "changed Workflow fixture")}${WORKFLOW_BODY.replace("47A9C1", "B0D1A2")}`,
        semanticKinds: ["asset.file_inventory", "workflow.activation", "workflow.content"],
        restorationPayload: null,
    },
    {
        kind: "Memory",
        nativeDialectId: "claudecode-memory-topic-v1",
        nativePath: "topics/oaam-phase53-memory.md",
        nativeText: `${MEMORY_HEADER}${MEMORY_BODY}`,
        canonical: memoryCanonical("OAAM Memory fixture", "Isolated Claude Code Memory topic"),
        rebasedCanonical: memoryCanonical("OAAM rebased Memory fixture", "Rebased Claude Code Memory topic"),
        entryPath: "memory.md",
        entryText: MEMORY_BODY,
        changedEntryText: MEMORY_CHANGED_BODY,
        bodyOnlyChangedNativeText: `${MEMORY_HEADER}${MEMORY_CHANGED_BODY}`,
        changedNativeText: `${MEMORY_CHANGED_HEADER}${MEMORY_CHANGED_BODY}`,
        metadataDriftedNativeText: `${MEMORY_CHANGED_HEADER.replace("type: project", "type: reference")}${MEMORY_CHANGED_BODY}`,
        semanticKinds: ["asset.file_inventory", "memory.support", "memory.content"],
        restorationPayload: MEMORY_RESTORATION,
    },
];
const APP_WORKFLOW_BODY = "\nReply with exactly `OAAM_APP_WORKFLOW_LOADED_20260804_R1` and no other text.\n";
const APP_WORKFLOW_CHANGED_BODY = APP_WORKFLOW_BODY.replace("20260804_R1", "20260804_R2");
const APP_WORKFLOW_HEADER = [
    "---",
    "# keep App workflow layout",
    "description: OAAM isolated Claude App Workflow load fixture",
    "disable-model-invocation: true",
    "---",
    "",
].join("\n");
const APP_WORKFLOW_CANONICAL = workflowCanonical();
APP_WORKFLOW_CANONICAL.typeData.name = "oaam-phase53-app-workflow";
APP_WORKFLOW_CANONICAL.typeData.description = "OAAM isolated Claude App Workflow load fixture";
APP_WORKFLOW_CANONICAL.typeData.invocation.commandNames = ["oaam-phase53-app-workflow"];
const APP_WORKFLOW_SPEC: ExactFixtureSpec = {
    kind: "Workflow",
    nativeDialectId: "claudecode-command-markdown-v1",
    nativePath: ".claude/commands/oaam-phase53-app-workflow.md",
    nativeText: `${APP_WORKFLOW_HEADER}${APP_WORKFLOW_BODY}`,
    canonical: APP_WORKFLOW_CANONICAL,
    rebasedCanonical: structuredClone(APP_WORKFLOW_CANONICAL),
    entryPath: "WORKFLOW.md",
    entryText: APP_WORKFLOW_BODY,
    changedEntryText: APP_WORKFLOW_CHANGED_BODY,
    bodyOnlyChangedNativeText: `${APP_WORKFLOW_HEADER}${APP_WORKFLOW_CHANGED_BODY}`,
    changedNativeText: `${APP_WORKFLOW_HEADER}${APP_WORKFLOW_CHANGED_BODY}`,
    metadataDriftedNativeText: `${APP_WORKFLOW_HEADER.replace("App Workflow load fixture", "changed App Workflow fixture")}${APP_WORKFLOW_CHANGED_BODY}`,
    semanticKinds: ["asset.file_inventory", "workflow.activation", "workflow.content"],
    restorationPayload: null,
};

describe("Claude Code one-file exact targets", () => {
    it("binds App legacy Workflow current-exact, parent rebase, and reverse to the App entry", async () => {
        const current = appWorkflowFixture("current_exact");
        const currentAnalysis = await claudecodeProvider.analyzeRender(current);
        expect(currentAnalysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        const currentMaterialization = makeClaudeNativeMaterializationInput(
            current,
            currentClaudeWorkflowTestSupports.appProject,
        );
        expect(await claudecodeProvider.materializeRender(currentMaterialization)).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [
                { files: [{ relativePath: APP_WORKFLOW_SPEC.nativePath, content: { text: APP_WORKFLOW_SPEC.nativeText } }] },
            ],
        });
        expect(
            await claudecodeProvider.inspectRenderedTarget(
                inspectionInput(APP_WORKFLOW_SPEC, currentMaterialization, APP_WORKFLOW_SPEC.bodyOnlyChangedNativeText),
            ),
        ).toMatchObject({
            status: "complete",
            changes: [
                { changeKind: "file_content_replacement", replacementContent: { text: APP_WORKFLOW_SPEC.changedEntryText } },
            ],
        });

        const rebased = appWorkflowFixture("parent_rebase_seed", APP_WORKFLOW_SPEC.changedEntryText);
        expect(currentClaudeWorkflowTestSupports.appProject.analyze(rebased)).toMatchObject({
            status: "complete",
            blockedSemanticRefs: [],
            diagnostics: [],
        });
        expect(
            currentClaudeWorkflowTestSupports.appProject.materialize(
                makeClaudeNativeMaterializationInput(rebased, currentClaudeWorkflowTestSupports.appProject),
            ),
        ).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ content: { text: APP_WORKFLOW_SPEC.changedNativeText } }] }],
        });
    });

    it("dispatches one Deployment containing a shared Catalog and independent Memory Units", async () => {
        const full = memoryCatalogFixture("current_exact");
        const analysis = await claudecodeProvider.analyzeRender(full);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.outputUnits).toHaveLength(3);

        const catalogInput = catalogOnlyInput(full);
        const catalogAnalysis = memoryCatalogTargetSupports.MemoryCatalog.analyze(catalogInput);
        expect(catalogAnalysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        const materialization = catalogMaterializationInput(catalogInput, catalogAnalysis);
        expect(memoryCatalogTargetSupports.MemoryCatalog.materialize(materialization)).toMatchObject({
            status: "complete",
            materializationState: "materialized",
        });
        const providerMaterialization = providerMemoryMaterializationInput(full, analysis);
        const providerMaterialized = await claudecodeProvider.materializeRender(providerMaterialization);
        expect(providerMaterialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
        });
        if (providerMaterialized.materializationState !== "materialized") throw new Error("Memory materialization blocked");
        expect(providerMaterialized.materializedUnits).toHaveLength(3);
        expect(providerMaterialized.materializedUnits.flatMap((unit) => unit.files)).toContainEqual(
            expect.objectContaining({
                relativePath: "MEMORY.md",
                content: { contentKind: "text", text: MEMORY_CATALOG_TEXT },
            }),
        );

        expect(
            await claudecodeProvider.inspectRenderedTarget(catalogInspectionInput(full, providerMaterialization)),
        ).toMatchObject({
            status: "complete",
            changes: [
                {
                    changeKind: "asset_type_data_replacement",
                    replacement: memoryCatalogCanonical([SECOND_MEMORY_VERSION_ID, FIRST_MEMORY_VERSION_ID]),
                },
            ],
            files: [{ attributionState: "uniquely_attributable" }],
        });
    });

    it("dispatches the same exact Memory closure through distinct App contracts and build authority", async () => {
        const fixture = appMemoryCatalogFixture("current_exact");
        const analysis = await claudecodeProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(analysis.outputUnits.map((unit) => unit.outputContractId).sort()).toEqual([
            "CLAUDECODE_APP_NATIVE_PROJECT_MEMORY_CATALOG_V1",
            "CLAUDECODE_APP_NATIVE_PROJECT_MEMORY_TOPIC_V1",
            "CLAUDECODE_APP_NATIVE_PROJECT_MEMORY_TOPIC_V1",
        ]);

        const materializationInput = providerMemoryMaterializationInput(fixture, analysis, "CLAUDE_CODE_APP");
        const materialized = await claudecodeProvider.materializeRender(materializationInput);
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: expect.arrayContaining([
                expect.objectContaining({ files: [expect.objectContaining({ relativePath: "MEMORY.md" })] }),
                expect.objectContaining({ files: [expect.objectContaining({ relativePath: "topics/first.md" })] }),
                expect.objectContaining({ files: [expect.objectContaining({ relativePath: "topics/second.md" })] }),
            ]),
        });
        expect(
            await claudecodeProvider.inspectRenderedTarget(
                catalogInspectionInput(fixture, materializationInput, "CLAUDE_CODE_APP"),
            ),
        ).toMatchObject({
            status: "complete",
            changes: [{ changeKind: "asset_type_data_replacement" }],
            files: [{ attributionState: "uniquely_attributable" }],
        });
    });

    it("rebases a foreign Catalog while preserving Claude comments and exact Unit routing", () => {
        const full = memoryCatalogFixture("parent_rebase_seed");
        const catalogInput = catalogOnlyInput(full);
        const analysis = memoryCatalogTargetSupports.MemoryCatalog.analyze(catalogInput);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        expect(
            memoryCatalogTargetSupports.MemoryCatalog.materialize(catalogMaterializationInput(catalogInput, analysis)),
        ).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ content: { contentKind: "text", text: CHANGED_MEMORY_CATALOG_TEXT } }] }],
        });

        const noRows = memoryCatalogFixture("parent_rebase_seed");
        replaceCatalogNative(noRows, "# Memory without rows\n");
        const noRowsInput = catalogOnlyInput(noRows);
        const noRowsAnalysis = memoryCatalogTargetSupports.MemoryCatalog.analyze(noRowsInput);
        expect(
            memoryCatalogTargetSupports.MemoryCatalog.materialize(catalogMaterializationInput(noRowsInput, noRowsAnalysis)),
        ).toMatchObject({
            status: "complete",
            materializedUnits: [
                {
                    files: [
                        {
                            content: {
                                text: expect.stringContaining("# Memory without rows\n\n- [Second](topics/second.md)"),
                            },
                        },
                    ],
                },
            ],
        });

        const malformed = memoryCatalogFixture("parent_rebase_seed");
        replaceCatalogNative(malformed, "# Memory\n- [broken\n");
        expect(memoryCatalogTargetSupports.MemoryCatalog.analyze(catalogOnlyInput(malformed))).toMatchObject({
            status: "failed",
        });

        const unsafeTitle = memoryCatalogFixture("parent_rebase_seed");
        const catalog = unsafeTitle.deployment.assets.find(
            (asset) => asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "catalog",
        );
        if (catalog?.version.canonical.kind !== "Memory" || catalog.version.canonical.typeData.entityRole !== "catalog") {
            throw new Error("Catalog canonical fixture missing");
        }
        const firstMember = catalog.version.canonical.typeData.members[0];
        if (firstMember === undefined) throw new Error("Catalog member fixture missing");
        firstMember.routingTitle = "unsafe\ntitle";
        expect(memoryCatalogTargetSupports.MemoryCatalog.analyze(catalogOnlyInput(unsafeTitle))).toMatchObject({
            status: "failed",
        });
    });

    it.each(FIXTURES)("dispatches $kind through the frozen Provider facade", async (spec) => {
        const fixture = analysisFixture(spec, "current_exact");
        const analysis = await claudecodeProvider.analyzeRender(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });

        const materialization =
            spec.kind === "Workflow"
                ? makeClaudeNativeMaterializationInput(fixture, currentClaudeWorkflowTestSupports.project)
                : materializationInput(spec, fixture);
        const materialized = await claudecodeProvider.materializeRender(materialization);
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ content: { text: spec.nativeText } }] }],
        });

        const inspection = await claudecodeProvider.inspectRenderedTarget(
            inspectionInput(spec, materialization, spec.bodyOnlyChangedNativeText),
        );
        expect(inspection).toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: spec.changedEntryText } }],
        });
    });

    it.each(FIXTURES)("restores exact $kind native bytes and validates the complete native dialect", (spec) => {
        const fixture = analysisFixture(spec, "current_exact");
        const materialized = supports[spec.kind].materialize(materializationInput(spec, fixture));
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ relativePath: spec.nativePath, content: { text: spec.nativeText } }] }],
        });
        expect(validateMaterializedNative(spec, spec.entryText, spec.nativeText)).toBe(true);
    });

    it.each(FIXTURES)("rebases a foreign-edited $kind body while preserving the Claude header byte-for-byte", (spec) => {
        const fixture = analysisFixture(spec, "parent_rebase_seed", spec.changedEntryText, spec.rebasedCanonical);
        const analysis = supports[spec.kind].analyze(fixture);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [], diagnostics: [] });
        const materialized = supports[spec.kind].materialize(materializationInput(spec, fixture));
        expect(materialized).toMatchObject({
            status: "complete",
            materializationState: "materialized",
            materializedUnits: [{ files: [{ content: { text: spec.changedNativeText } }] }],
        });
        expect(validateMaterializedNative(spec, spec.changedEntryText, spec.changedNativeText, spec.rebasedCanonical)).toBe(true);
    });

    it("preserves and rebases a legacy Workflow command without frontmatter", () => {
        const spec = bareWorkflowFixture();
        const current = analysisFixture(spec, "current_exact");
        expect(supports.Workflow.materialize(materializationInput(spec, current))).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ content: { text: spec.nativeText } }] }],
        });
        expect(validateMaterializedNative(spec, spec.entryText, spec.nativeText)).toBe(true);

        const rebased = analysisFixture(spec, "parent_rebase_seed", spec.changedEntryText);
        expect(supports.Workflow.materialize(materializationInput(spec, rebased))).toMatchObject({
            status: "complete",
            materializedUnits: [{ files: [{ content: { text: spec.changedNativeText } }] }],
        });
        expect(validateMaterializedNative(spec, spec.changedEntryText, spec.changedNativeText)).toBe(true);
    });

    it.each(FIXTURES)("accepts only a body change during $kind reverse inspection", (spec) => {
        const fixture = analysisFixture(spec, "current_exact");
        const materialization = materializationInput(spec, fixture);
        const bodyOnly = supports[spec.kind].inspect(inspectionInput(spec, materialization, spec.bodyOnlyChangedNativeText));
        expect(bodyOnly).toMatchObject({
            status: "complete",
            changes: [{ changeKind: "file_content_replacement", replacementContent: { text: spec.changedEntryText } }],
            files: [{ attributionState: "uniquely_attributable" }],
        });

        const metadataDrift = supports[spec.kind].inspect(inspectionInput(spec, materialization, spec.metadataDriftedNativeText));
        expect(metadataDrift).toMatchObject({
            status: "complete",
            changes: [],
            files: [{ attributionState: "conflict", reasonCode: "native_project_exact_file_change_not_reconcilable" }],
        });
    });

    it.each(
        FIXTURES,
    )("blocks unrepresentable $kind metadata, extra files, foreign restoration, and unsafe native paths", (spec) => {
        const metadata = analysisFixture(spec, "parent_rebase_seed", spec.changedEntryText);
        const metadataAsset = metadata.deployment.assets[0];
        if (metadataAsset === undefined) throw new Error("metadata fixture asset missing");
        const canonical = metadataAsset.version.canonical;
        if (canonical.kind !== spec.kind) throw new Error("fixture kind mismatch");
        canonical.typeData.description = `${canonical.typeData.description} changed outside Claude`;
        expect(supports[spec.kind].analyze(metadata).status).toBe("failed");

        const multiFile = analysisFixture(spec, "current_exact");
        const multiFileAsset = multiFile.deployment.assets[0];
        if (multiFileAsset === undefined) throw new Error("multi-file fixture asset missing");
        multiFileAsset.version.files.push(textFile("resource.md", "resource"));
        expect(supports[spec.kind].analyze(multiFile).status).toBe("failed");

        const restoration = analysisFixture(spec, "current_exact");
        const restorationGroup = restoration.dialectInputs[0];
        if (restorationGroup === undefined) throw new Error("restoration fixture group missing");
        restorationGroup.inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: "foreign-runtime-private-v1",
                restorationContractFingerprint: HASH,
                contentHash: HASH,
            },
            content: { contentKind: "binary", bytes: Uint8Array.of(1) },
        });
        expect(supports[spec.kind].analyze(restoration).status).toBe("failed");

        const unsafePath = analysisFixture(spec, "current_exact");
        const native = unsafePath.dialectInputs[0]?.inputs[0];
        if (native?.inputKind !== "native_representation") throw new Error("native fixture missing");
        const nativeFile = native.files[0];
        if (nativeFile === undefined) throw new Error("native fixture file missing");
        nativeFile.relativePath = "../escape.md";
        expect(supports[spec.kind].analyze(unsafePath).status).toBe("failed");
    });

    it.each([
        ["Workflow", ".claude/commands/.md"],
        ["Workflow", ".claude\\commands\\unsafe.md"],
        ["Workflow", ".claude/commands/unsafe\0.md"],
        ["Memory", "MEMORY.md"],
        ["Memory", "nested/MEMORY.md"],
        ["Memory", "team/shared.md"],
        ["Memory", "topics/.md"],
    ] as const)("rejects an invalid %s native target path", (kind, relativePath) => {
        const spec = FIXTURES.find((candidate) => candidate.kind === kind);
        if (spec === undefined) throw new Error(`missing ${kind} fixture`);
        const unsafePath = analysisFixture(spec, "current_exact");
        const native = unsafePath.dialectInputs[0]?.inputs[0];
        if (native?.inputKind !== "native_representation") throw new Error("native fixture missing");
        const nativeFile = native.files[0];
        if (nativeFile === undefined) throw new Error("native fixture file missing");
        nativeFile.relativePath = relativePath;
        expect(supports[kind].analyze(unsafePath).status).toBe("failed");
    });

    it("requires exact Memory restoration metadata and Unit semantics for parent rebase", () => {
        const spec = FIXTURES.find((candidate) => candidate.kind === "Memory");
        if (spec === undefined) throw new Error("missing Memory fixture");
        const missing = analysisFixture(spec, "parent_rebase_seed", spec.changedEntryText, spec.rebasedCanonical);
        missing.dialectInputs[0]?.inputs.splice(1, 1);
        expect(supports.Memory.analyze(missing).status).toBe("failed");

        const mismatched = analysisFixture(spec, "parent_rebase_seed", spec.changedEntryText, spec.rebasedCanonical);
        const restoration = mismatched.dialectInputs[0]?.inputs[1];
        if (restoration?.inputKind !== "dialect_restoration" || restoration.content.contentKind !== "binary") {
            throw new Error("Memory restoration fixture missing");
        }
        restoration.content.bytes = Buffer.from(
            JSON.stringify({
                schemaVersion: 1,
                dialectId: "claudecode-memory-topic-v1",
                topLevelType: "",
                metadataType: "reference",
                metadataOriginSessionId: "oaam-phase53-session",
                metadataNodeType: "memory",
            }),
        );
        expect(supports.Memory.materialize(materializationInputWithoutClosureCheck(spec, mismatched))).toMatchObject({
            status: "failed",
        });

        const catalog = analysisFixture(spec, "current_exact");
        const asset = catalog.deployment.assets[0];
        if (asset?.version.canonical.kind !== "Memory") throw new Error("Memory canonical fixture missing");
        asset.version.canonical.typeData = { schemaVersion: 2, entityRole: "catalog", members: [] };
        expect(supports.Memory.analyze(catalog).status).toBe("failed");

        const wrongLoading = analysisFixture(spec, "parent_rebase_seed", spec.changedEntryText, spec.rebasedCanonical);
        const wrongAsset = wrongLoading.deployment.assets[0];
        if (wrongAsset?.version.canonical.kind !== "Memory" || wrongAsset.version.canonical.typeData.entityRole !== "unit") {
            throw new Error("Memory Unit fixture missing");
        }
        wrongAsset.version.canonical.typeData.loading.body = "high";
        expect(supports.Memory.materialize(materializationInputWithoutClosureCheck(spec, wrongLoading))).toMatchObject({
            status: "failed",
        });
    });

    it("rebases missing and quoted Memory card fields without losing native layout or comments", () => {
        const spec = FIXTURES.find((candidate) => candidate.kind === "Memory");
        if (spec === undefined) throw new Error("missing Memory fixture");

        const missingName = analysisFixture(
            spec,
            "parent_rebase_seed",
            spec.changedEntryText,
            memoryCanonical("Inserted Memory name", "Rebased Claude Code Memory topic"),
        );
        const missingNameNative = missingName.dialectInputs[0]?.inputs[0];
        if (missingNameNative?.inputKind !== "native_representation") throw new Error("Memory native fixture missing");
        const missingNameText = `${MEMORY_HEADER.replace("name: OAAM Memory fixture # keep name comment\n", "")}${MEMORY_BODY}`;
        missingNameNative.files = [nativeFile(spec.nativePath, missingNameText)];
        expect(supports.Memory.materialize(materializationInputWithoutClosureCheck(spec, missingName))).toMatchObject({
            status: "complete",
            materializedUnits: [
                {
                    files: [
                        {
                            content: {
                                text: expect.stringContaining('name: "Inserted Memory name"'),
                            },
                        },
                    ],
                },
            ],
        });

        const escapedComment = analysisFixture(spec, "parent_rebase_seed", spec.changedEntryText, spec.rebasedCanonical);
        const escapedNative = escapedComment.dialectInputs[0]?.inputs[0];
        if (escapedNative?.inputKind !== "native_representation") throw new Error("Memory native fixture missing");
        const quotedHeader = MEMORY_HEADER.replace(
            "name: OAAM Memory fixture # keep name comment",
            'name: "OAAM \\"#\\" Memory fixture" # keep quoted comment',
        ).replace("description: Isolated Claude Code Memory topic # keep description comment", "description: Plain description");
        escapedNative.files = [nativeFile(spec.nativePath, `${quotedHeader}${MEMORY_BODY}`)];
        expect(supports.Memory.materialize(materializationInputWithoutClosureCheck(spec, escapedComment))).toMatchObject({
            status: "complete",
            materializedUnits: [
                {
                    files: [
                        {
                            content: {
                                text: expect.stringContaining("# keep quoted comment"),
                            },
                        },
                    ],
                },
            ],
        });
    });
});

function analysisFixture(
    spec: ExactFixtureSpec,
    inputRole: "current_exact" | "parent_rebase_seed",
    entryText = spec.entryText,
    canonical = spec.canonical,
): RenderAnalysisInput {
    const versionId = inputRole === "current_exact" ? VERSION_ID : "66666666-6666-4666-8666-666666666666";
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
            files: [textFile(spec.entryPath, entryText)],
        },
        sectionHandles: { [FILE_ID]: `${spec.kind.toLowerCase()}-entry` },
    };
    const targetContextSchema = supports[spec.kind].targetContextSchema;
    const dialectInput = nativeDialectInput(spec, versionId, inputRole);
    const semantics = spec.semanticKinds.map((semanticKind, index) => ({
        semanticRefFingerprint: `sha256:${String(index + 1).repeat(64)}`,
        consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
        subject:
            semanticKind.endsWith("content") || semanticKind === "skill.body" || semanticKind === "subagent.invoked_context"
                ? { subjectKind: "file" as const, assetId: ASSET_ID, versionId, fileId: FILE_ID }
                : { subjectKind: "asset" as const, assetId: ASSET_ID, versionId },
        semanticKind,
    }));
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
                    versionText: "2.1.220",
                    buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
                    targetContextSchemaId: targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: targetContextSchema.schemaFingerprint,
                    renderFacts:
                        spec.kind === "Memory"
                            ? [
                                  { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
                                  { key: "oaam.project-binding", value: "registered", evidenceLevel: "local_artifact" },
                                  { key: "oaam.target-kind", value: "directory", evidenceLevel: "local_artifact" },
                              ]
                            : [{ key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" }],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [asset],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: semantics as RenderAnalysisInput["requiredSemantics"],
        dialectInputs: [dialectInput],
    };
}

function nativeDialectInput(
    spec: ExactFixtureSpec,
    targetVersionId: string,
    inputRole: "current_exact" | "parent_rebase_seed",
): RenderAnalysisInput["dialectInputs"][number] {
    const file = nativeFile(spec.nativePath, spec.nativeText);
    const common = {
        inputKind: "native_representation" as const,
        inputRole,
        representation: {
            schemaVersion: 1 as const,
            dialectId: spec.nativeDialectId,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
        },
        files: [file],
    };
    const inputs: RenderAnalysisInput["dialectInputs"][number]["inputs"] = [
        inputRole === "current_exact"
            ? common
            : {
                  ...common,
                  inputRole: "parent_rebase_seed" as const,
                  sourceVersion: { assetId: ASSET_ID, versionId: PARENT_VERSION_ID },
              },
    ];
    if (spec.restorationPayload !== null) {
        inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId: spec.nativeDialectId,
                restorationContractFingerprint: HASH,
                contentHash: sha256Bytes(spec.restorationPayload),
            },
            content: { contentKind: "binary", bytes: new Uint8Array(spec.restorationPayload) },
        });
    }
    return {
        targetVersion: { assetId: ASSET_ID, versionId: targetVersionId },
        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        inputs,
    };
}

function materializationInput(
    spec: ExactFixtureSpec,
    analysisInput: RenderAnalysisInput,
    support: (typeof supports)[keyof typeof supports] = supports[spec.kind],
): RenderMaterializationInput {
    return makeClaudeNativeMaterializationInput(analysisInput, support);
}

function appWorkflowFixture(
    inputRole: "current_exact" | "parent_rebase_seed",
    entryText = APP_WORKFLOW_SPEC.entryText,
): RenderAnalysisInput {
    const fixture = analysisFixture(APP_WORKFLOW_SPEC, inputRole, entryText);
    fixture.deployment.platform = "win32";
    fixture.deployment.platformInstanceId = "test-win32";
    const context = fixture.deployment.targetContexts[0];
    if (context === undefined) throw new Error("App Workflow target context is missing");
    context.agentRuntimeId = "CLAUDE_CODE_APP";
    context.versionText = "2.1.219";
    context.buildIdentity = "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637";
    context.targetContextSchemaId = supports.AppWorkflow.targetContextSchema.targetContextSchemaId;
    context.targetContextSchemaFingerprint = supports.AppWorkflow.targetContextSchema.schemaFingerprint;
    context.renderFacts = [{ key: "oaam.platform", value: "win32", evidenceLevel: "agent_runtime_verified" }];
    for (const semantic of fixture.requiredSemantics) semantic.consumerAgentRuntimeId = "CLAUDE_CODE_APP";
    for (const group of fixture.dialectInputs) group.consumerAgentRuntimeIds = ["CLAUDE_CODE_APP"];
    return fixture;
}

function materializationInputWithoutClosureCheck(
    spec: ExactFixtureSpec,
    analysisInput: RenderAnalysisInput,
): RenderMaterializationInput {
    const support = supports[spec.kind];
    const contract = makeNativeProjectExactFileContractParts(support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("exact target profile is missing");
    const analysis = support.analyze(analysisInput);
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

function inspectionInput(
    spec: ExactFixtureSpec,
    materialization: RenderMaterializationInput,
    currentNativeText: string,
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0];
    if (unit === undefined) throw new Error("materialization fixture output unit missing");
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
                renderStrategy:
                    materialization.selection.semanticOptions.find(
                        (option) => option.semanticRefFingerprint === semantic.semanticRefFingerprint,
                    )?.renderStrategy ?? "native_file",
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
                    appliedContentHash: sha256Text(spec.nativeText),
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
                relativePath: spec.nativePath,
                appliedContent: { contentKind: "text", text: spec.nativeText },
                currentContent: { contentKind: "text", text: currentNativeText },
                diffHunks: [
                    {
                        hunkFingerprint: HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(spec.nativeText),
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
    spec: ExactFixtureSpec,
    entryText: string,
    nativeText: string,
    canonical = spec.canonical,
): boolean {
    const descriptor = nativeFile(spec.nativePath, nativeText);
    const { text: _text, ...file } = descriptor;
    return validateClaudeCodeNativeDialect({
        canonical,
        canonicalFiles: [textFile(spec.entryPath, entryText)],
        representation: {
            schemaVersion: 1,
            dialectId: spec.nativeDialectId,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
            files: [file],
        },
        nativeFiles: [{ relativePath: spec.nativePath, bytes: new TextEncoder().encode(nativeText) }],
    });
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
            fileId: logicalPath === "resource.md" ? "88888888-8888-4888-8888-888888888888" : FILE_ID,
            logicalPath,
            role: logicalPath === "resource.md" ? ("resource" as const) : ("entry" as const),
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

function sha256Bytes(bytes: Uint8Array): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function bareWorkflowFixture(): ExactFixtureSpec {
    const canonical = workflowCanonical();
    canonical.typeData.name = "plain";
    canonical.typeData.description = "";
    canonical.typeData.invocation.commandNames = ["plain"];
    canonical.typeData.invocation.agentInvocable = true;
    const changed = WORKFLOW_BODY.replace("47A9C1", "B0D1A2");
    return {
        kind: "Workflow",
        nativeDialectId: "claudecode-command-markdown-v1",
        nativePath: ".claude/commands/plain.md",
        nativeText: WORKFLOW_BODY,
        canonical,
        rebasedCanonical: structuredClone(canonical),
        entryPath: "WORKFLOW.md",
        entryText: WORKFLOW_BODY,
        changedEntryText: changed,
        bodyOnlyChangedNativeText: changed,
        changedNativeText: changed,
        metadataDriftedNativeText: changed,
        semanticKinds: ["asset.file_inventory", "workflow.activation", "workflow.content"],
        restorationPayload: null,
    };
}

function memoryCanonical(name: string, description: string): Extract<AssetKindTypeDataV2, { kind: "Memory" }> {
    return {
        kind: "Memory",
        typeData: {
            schemaVersion: 2,
            entityRole: "unit",
            card: { name, description },
            loading: { card: "high", body: "low" },
            applicabilityRule: "",
        },
    };
}

function workflowCanonical(): Extract<AssetKindTypeDataV2, { kind: "Workflow" }> {
    return {
        kind: "Workflow",
        typeData: {
            schemaVersion: 2,
            name: "oaam-phase53-workflow",
            description: "OAAM isolated Claude Code 2.1.220 Workflow load fixture",
            implementation: {
                kind: "instructions",
                instructionDialectId: "claudecode-command-markdown-v1",
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
                commandNames: ["oaam-phase53-workflow"],
                userInvocable: true,
                agentInvocable: false,
                argumentHint: "",
                argumentNames: [],
            },
        },
    };
}
