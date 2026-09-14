import * as crypto from "node:crypto";
import type {
    AssetKindTypeDataV2,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderedTargetInspectionInput,
    Sha256Digest,
} from "@oaam/core";
import { makeNativeProjectExactFileContractParts } from "../../../core/src/render/native-project-exact-file";
import { claudecodeProvider } from "../src/claudecode-provider";
import { createClaudeCodeExactFileTargetSupports } from "../src/claudecode-target-exact-file";

const HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const CATALOG_ASSET_ID = "99999999-9999-4999-8999-999999999999";
const CATALOG_VERSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CATALOG_CHILD_VERSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FIRST_MEMORY_ASSET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const FIRST_MEMORY_VERSION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SECOND_MEMORY_ASSET_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const SECOND_MEMORY_VERSION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
export const MEMORY_CATALOG_TEXT = "# Memory\n\n<!-- preserve catalog layout -->\n- [First](topics/first.md) — first hint\n";
export const CHANGED_MEMORY_CATALOG_TEXT =
    "# Memory\n\n<!-- preserve catalog layout -->\n- [Second](topics/second.md) — second hint\n" +
    "- [First renamed](topics/first.md) — revised first hint\n";
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
export const memoryCatalogTargetSupports = createClaudeCodeExactFileTargetSupports({
    adapterVersion: claudecodeProvider.version,
    agentRuntimes: claudecodeProvider.agentRuntimes,
    targetContextSchemaId,
    appTargetContextSchemaId,
    memoryTargetContextSchemaId,
    appMemoryTargetContextSchemaId,
});

export function memoryCatalogFixture(inputRole: "current_exact" | "parent_rebase_seed"): RenderAnalysisInput {
    const catalogVersionId = inputRole === "current_exact" ? CATALOG_VERSION_ID : CATALOG_CHILD_VERSION_ID;
    const catalogCanonical =
        inputRole === "current_exact"
            ? memoryCatalogCanonical([FIRST_MEMORY_VERSION_ID])
            : memoryCatalogCanonical([SECOND_MEMORY_VERSION_ID, FIRST_MEMORY_VERSION_ID]);
    const catalogAsset = {
        scope: "project" as const,
        projectId: PROJECT_ID,
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId: CATALOG_ASSET_ID, versionId: catalogVersionId },
            versionFingerprint: HASH,
            versionCanonicalContentFingerprint: HASH,
            status: "complete" as const,
            canonical: catalogCanonical,
            files: [],
        },
        sectionHandles: {},
    };
    const firstUnit = memoryUnitAsset(FIRST_MEMORY_ASSET_ID, FIRST_MEMORY_VERSION_ID, "First", "first.md");
    const secondUnit = memoryUnitAsset(SECOND_MEMORY_ASSET_ID, SECOND_MEMORY_VERSION_ID, "Second", "second.md");
    const catalogNative = nativeFile("MEMORY.md", MEMORY_CATALOG_TEXT);
    const catalogGroup = nativeRepresentationGroup(
        CATALOG_ASSET_ID,
        catalogVersionId,
        "claudecode-memory-catalog-v1",
        catalogNative,
        inputRole,
    );
    const dialectInputs = [
        catalogGroup,
        nativeRepresentationGroup(
            FIRST_MEMORY_ASSET_ID,
            FIRST_MEMORY_VERSION_ID,
            "claudecode-memory-topic-v1",
            nativeFile("topics/first.md", `${MEMORY_HEADER}# First\nFirst memory.\n`),
            "current_exact",
        ),
        nativeRepresentationGroup(
            SECOND_MEMORY_ASSET_ID,
            SECOND_MEMORY_VERSION_ID,
            "claudecode-memory-topic-v1",
            nativeFile("topics/second.md", `${MEMORY_HEADER}# Second\nSecond memory.\n`),
            "current_exact",
        ),
    ];
    const semantics = [
        semantic(CATALOG_ASSET_ID, catalogVersionId, "asset.file_inventory", 1),
        semantic(CATALOG_ASSET_ID, catalogVersionId, "memory.support", 2),
        semantic(FIRST_MEMORY_ASSET_ID, FIRST_MEMORY_VERSION_ID, "asset.file_inventory", 3),
        semantic(FIRST_MEMORY_ASSET_ID, FIRST_MEMORY_VERSION_ID, "memory.support", 4),
        semantic(FIRST_MEMORY_ASSET_ID, FIRST_MEMORY_VERSION_ID, "memory.content", 5, FILE_ID),
        semantic(SECOND_MEMORY_ASSET_ID, SECOND_MEMORY_VERSION_ID, "asset.file_inventory", 6),
        semantic(SECOND_MEMORY_ASSET_ID, SECOND_MEMORY_VERSION_ID, "memory.support", 7),
        semantic(SECOND_MEMORY_ASSET_ID, SECOND_MEMORY_VERSION_ID, "memory.content", 8, FILE_ID),
    ];
    const schema = memoryCatalogTargetSupports.MemoryCatalog.targetContextSchema;
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
                    targetContextSchemaId: schema.targetContextSchemaId,
                    targetContextSchemaFingerprint: schema.schemaFingerprint,
                    renderFacts: [
                        { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
                        { key: "oaam.project-binding", value: "registered", evidenceLevel: "local_artifact" },
                        { key: "oaam.target-kind", value: "directory", evidenceLevel: "local_artifact" },
                    ],
                    targetApplicabilityFingerprint: HASH,
                },
            ],
            assets: [catalogAsset, firstUnit, secondUnit],
            targetFileSnapshots: [
                {
                    relativePath: "MEMORY.md",
                    snapshotState: "present",
                    contentHash: catalogNative.contentHash,
                    byteSize: catalogNative.byteSize,
                    executable: false,
                },
            ],
            renderInputFingerprint: HASH,
        },
        requiredSemantics: semantics as RenderAnalysisInput["requiredSemantics"],
        dialectInputs,
    };
}

export function appMemoryCatalogFixture(inputRole: "current_exact" | "parent_rebase_seed"): RenderAnalysisInput {
    const fixture = memoryCatalogFixture(inputRole);
    const context = fixture.deployment.targetContexts[0];
    if (context === undefined) throw new Error("Memory target context missing");
    const schema = memoryCatalogTargetSupports.AppMemoryCatalog.targetContextSchema;
    fixture.deployment.platform = "win32";
    fixture.deployment.platformInstanceId = "test-win32";
    context.agentRuntimeId = "CLAUDE_CODE_APP";
    context.versionText = "2.1.219";
    context.buildIdentity = "sha256:10f4c1f85b07f3cf6b8fff930fd26ecd475bd146a378acfafa559a6db9d89637";
    context.targetContextSchemaId = schema.targetContextSchemaId;
    context.targetContextSchemaFingerprint = schema.schemaFingerprint;
    context.renderFacts = context.renderFacts.map((fact) => (fact.key === "oaam.platform" ? { ...fact, value: "win32" } : fact));
    fixture.requiredSemantics = fixture.requiredSemantics.map((semantic) => ({
        ...semantic,
        consumerAgentRuntimeId: "CLAUDE_CODE_APP",
    }));
    for (const group of fixture.dialectInputs) group.consumerAgentRuntimeIds = ["CLAUDE_CODE_APP"];
    return fixture;
}

export function providerMemoryMaterializationInput(
    input: RenderAnalysisInput,
    analysis: Awaited<ReturnType<typeof claudecodeProvider.analyzeRender>>,
    agentRuntimeId: "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP" = "CLAUDE_CODE_CLI",
): RenderMaterializationInput {
    if (analysis.status !== "complete") throw new Error("Memory analysis fixture did not close");
    const rendererFor = (unit: (typeof analysis.outputUnits)[number]) => {
        const supports =
            agentRuntimeId === "CLAUDE_CODE_APP"
                ? {
                      unit: memoryCatalogTargetSupports.AppMemory,
                      catalog: memoryCatalogTargetSupports.AppMemoryCatalog,
                  }
                : { unit: memoryCatalogTargetSupports.Memory, catalog: memoryCatalogTargetSupports.MemoryCatalog };
        const support =
            unit.outputContractId === supports.catalog.renderContractDeclaration.outputContractId
                ? supports.catalog
                : supports.unit;
        const contract = makeNativeProjectExactFileContractParts(support.renderContractDeclaration).outputContract;
        const profile = contract.materializationProfiles[0];
        if (profile === undefined) throw new Error("Memory materialization profile missing");
        return {
            outputUnitFingerprint: unit.outputUnitFingerprint,
            rendererAdapterId: "CLAUDECODE" as const,
            rendererAdapterVersion: claudecodeProvider.version,
            materializerCapabilityKey: support.materializerCapability.materializerCapabilityKey,
            materializationProfileId: support.renderContractDeclaration.materializationProfileId,
            profileConstraintFingerprint: profile.profileConstraintFingerprint,
        };
    };
    return {
        schemaVersion: 1,
        deployment: structuredClone(input.deployment),
        requiredSemantics: structuredClone(input.requiredSemantics),
        dialectInputs: structuredClone(input.dialectInputs),
        selection: {
            schemaVersion: 1,
            outputUnits: structuredClone(analysis.outputUnits),
            outputUnitRenderers: analysis.outputUnits.map(rendererFor),
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

export function replaceCatalogNative(input: RenderAnalysisInput, text: string): void {
    const native = input.dialectInputs[0]?.inputs[0];
    if (native?.inputKind !== "native_representation" || native.files[0]?.contentKind !== "text") {
        throw new Error("Catalog parent fixture missing");
    }
    native.files[0] = nativeFile("MEMORY.md", text);
    input.deployment.targetFileSnapshots = [
        {
            relativePath: native.files[0].relativePath,
            snapshotState: "present",
            contentHash: native.files[0].contentHash,
            byteSize: native.files[0].byteSize,
            executable: native.files[0].executable,
        },
    ];
}

export function catalogOnlyInput(full: RenderAnalysisInput): RenderAnalysisInput {
    return {
        schemaVersion: 1,
        deployment: structuredClone(full.deployment),
        requiredSemantics: structuredClone(full.requiredSemantics.filter((item) => item.subject.assetId === CATALOG_ASSET_ID)),
        dialectInputs: structuredClone(full.dialectInputs),
    };
}

export function catalogMaterializationInput(
    input: RenderAnalysisInput,
    analysis: ReturnType<typeof memoryCatalogTargetSupports.MemoryCatalog.analyze>,
): RenderMaterializationInput {
    if (analysis.status !== "complete") throw new Error("Catalog analysis fixture did not close");
    const support = memoryCatalogTargetSupports.MemoryCatalog;
    const contract = makeNativeProjectExactFileContractParts(support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Catalog materialization profile missing");
    return {
        schemaVersion: 1,
        deployment: structuredClone(input.deployment),
        requiredSemantics: structuredClone(input.requiredSemantics),
        dialectInputs: structuredClone(input.dialectInputs),
        selection: {
            schemaVersion: 1,
            outputUnits: structuredClone(analysis.outputUnits),
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

export function catalogInspectionInput(
    full: RenderAnalysisInput,
    materialization: RenderMaterializationInput,
    agentRuntimeId: "CLAUDE_CODE_CLI" | "CLAUDE_CODE_APP" = "CLAUDE_CODE_CLI",
): RenderedTargetInspectionInput {
    const catalogSupport =
        agentRuntimeId === "CLAUDE_CODE_APP"
            ? memoryCatalogTargetSupports.AppMemoryCatalog
            : memoryCatalogTargetSupports.MemoryCatalog;
    const catalogUnit = materialization.selection.outputUnits.find(
        (unit) => unit.outputContractId === catalogSupport.renderContractDeclaration.outputContractId,
    );
    if (catalogUnit === undefined) throw new Error("Catalog output unit missing");
    const firstUnit = materialization.selection.outputUnits.find((unit) =>
        unit.claims.some((claim) => claim.relativePath === "topics/first.md"),
    );
    const secondUnit = materialization.selection.outputUnits.find((unit) =>
        unit.claims.some((claim) => claim.relativePath === "topics/second.md"),
    );
    if (firstUnit === undefined || secondUnit === undefined) throw new Error("Memory Unit output missing");
    const supportFor = (assetId: string) => {
        const result = full.requiredSemantics.find(
            (semantic) => semantic.subject.assetId === assetId && semantic.semanticKind === "memory.support",
        );
        if (result === undefined) throw new Error("Memory support semantic missing");
        return result;
    };
    const renderer = materialization.selection.outputUnitRenderers.find(
        (candidate) => candidate.outputUnitFingerprint === catalogUnit.outputUnitFingerprint,
    );
    if (renderer === undefined) throw new Error("Catalog renderer missing");
    const decisions = [
        [supportFor(CATALOG_ASSET_ID), catalogUnit.outputUnitFingerprint],
        [supportFor(FIRST_MEMORY_ASSET_ID), firstUnit.outputUnitFingerprint],
        [supportFor(SECOND_MEMORY_ASSET_ID), secondUnit.outputUnitFingerprint],
    ].map(([semanticRef, outputUnitFingerprint]) => ({
        semanticRef,
        consumerOwnerAdapterId: "CLAUDECODE",
        consumerOwnerAdapterVersion: claudecodeProvider.version,
        optionFingerprint: HASH,
        renderStrategy: "native_file" as const,
        actualReverseExtractPolicy: "can_reconcile" as const,
        outputUnitFingerprints: [outputUnitFingerprint as Sha256Digest],
        outcome: "preserved" as const,
    }));
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
            decisions: decisions as never,
            outputUnits: structuredClone(materialization.selection.outputUnits),
            outputUnitRenderers: structuredClone(materialization.selection.outputUnitRenderers),
            semanticCoverageProofs: [],
        },
        appliedAssets: structuredClone(full.deployment.assets),
        inspectionScope: {
            inspectionScopeFingerprint: HASH,
            fileStates: [
                {
                    relativePath: "MEMORY.md",
                    state: "changed",
                    appliedContentHash: sha256Text(MEMORY_CATALOG_TEXT),
                    currentContentHash: sha256Text(CHANGED_MEMORY_CATALOG_TEXT),
                    appliedExecutable: false,
                    currentExecutable: false,
                    outputUnitFingerprint: catalogUnit.outputUnitFingerprint,
                    provenanceFingerprint: HASH,
                },
            ],
            directoryInventories: [],
        },
        files: [
            {
                fileState: "baseline_changed",
                relativePath: "MEMORY.md",
                appliedContent: { contentKind: "text", text: MEMORY_CATALOG_TEXT },
                currentContent: { contentKind: "text", text: CHANGED_MEMORY_CATALOG_TEXT },
                diffHunks: [
                    {
                        hunkFingerprint: HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(MEMORY_CATALOG_TEXT),
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(CHANGED_MEMORY_CATALOG_TEXT),
                    },
                ],
                attributeChanges: [],
                provenance: {
                    schemaVersion: 1,
                    appliedRenderSnapshotFingerprint: HASH,
                    outputUnitFingerprint: catalogUnit.outputUnitFingerprint,
                    semanticRefFingerprints: [supportFor(CATALOG_ASSET_ID).semanticRefFingerprint],
                    sectionBindings: [],
                    materializationFingerprint: HASH,
                    provenanceFingerprint: HASH,
                },
            },
        ],
        inventoryDeltas: [],
    };
}

export function memoryCatalogCanonical(versionIds: string[]): Extract<AssetKindTypeDataV2, { kind: "Memory" }> {
    return {
        kind: "Memory",
        typeData: {
            schemaVersion: 2,
            entityRole: "catalog",
            members: versionIds.map((targetAssetVersionId, index) => ({
                targetAssetVersionId,
                routingTitle: index === 0 && versionIds.length === 1 ? "First" : index === 0 ? "Second" : "First renamed",
                routingHint:
                    index === 0 && versionIds.length === 1 ? "first hint" : index === 0 ? "second hint" : "revised first hint",
            })),
        },
    };
}

function memoryUnitAsset(assetId: string, versionId: string, name: string, logicalPath: string) {
    return {
        scope: "project" as const,
        projectId: PROJECT_ID,
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId, versionId },
            versionFingerprint: HASH,
            versionCanonicalContentFingerprint: HASH,
            status: "complete" as const,
            canonical: memoryCanonical("OAAM Memory fixture", "Isolated Claude Code Memory topic"),
            files: [textFile(logicalPath, `# ${name}\n${name} memory.\n`)],
        },
        sectionHandles: { [FILE_ID]: `${name.toLowerCase()}-memory-entry` },
    };
}

function nativeRepresentationGroup(
    assetId: string,
    versionId: string,
    dialectId: string,
    file: ReturnType<typeof nativeFile>,
    inputRole: "current_exact" | "parent_rebase_seed",
): RenderAnalysisInput["dialectInputs"][number] {
    const common = {
        inputKind: "native_representation" as const,
        representation: {
            schemaVersion: 1 as const,
            dialectId,
            dialectContractFingerprint: HASH,
            canonicalContentFingerprint: HASH,
            representationFingerprint: HASH,
        },
        files: [file],
    };
    const nativeInput =
        inputRole === "current_exact"
            ? { ...common, inputRole }
            : {
                  ...common,
                  inputRole,
                  sourceVersion: { assetId, versionId: CATALOG_VERSION_ID },
              };
    return {
        targetVersion: { assetId, versionId },
        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        inputs: [
            nativeInput,
            ...(dialectId === "claudecode-memory-topic-v1"
                ? [
                      {
                          inputKind: "dialect_restoration" as const,
                          restoration: {
                              dialectId,
                              restorationContractFingerprint: HASH,
                              contentHash: sha256Bytes(MEMORY_RESTORATION),
                          },
                          content: { contentKind: "binary" as const, bytes: new Uint8Array(MEMORY_RESTORATION) },
                      },
                  ]
                : []),
        ],
    };
}

function semantic(assetId: string, versionId: string, semanticKind: string, ordinal: number, fileId?: string) {
    return {
        semanticRefFingerprint: `sha256:${ordinal.toString(16).repeat(64)}` as Sha256Digest,
        consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
        subject:
            fileId === undefined
                ? { subjectKind: "asset" as const, assetId, versionId }
                : { subjectKind: "file" as const, assetId, versionId, fileId },
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

function sha256Text(text: string): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function sha256Bytes(bytes: Uint8Array): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}
