/** Deterministic zero-file Memory Catalog plus deployed Unit context fixture. */

import type {
    AdapterProviderSummary,
    AssetKindTypeDataV2,
    PosixRelativePath,
    RenderAnalysisInput,
    RenderAssetInput,
    RenderDeploymentInput,
    RenderMaterializationInput,
    RenderNativeRepresentationFileInput,
    RenderedTargetInspectionInput,
    Sha256Digest,
    UuidV4,
} from "../../../src/types";
import { textPayloadStats } from "../../../src/catalog/payload-store";
import {
    computeNativeDialectContractFingerprint,
    computeRenderInputFingerprint,
    computeRenderOutputUnitFingerprint,
    computeTargetApplicabilityFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../../../src/foundation/fingerprint";
import { deriveRequiredRenderSemanticsV1 } from "../../../src/render/render-semantics";
import {
    createNativeProjectExactFileProviderSupport,
    createVerifiedNativeProjectExactFileBuild,
    makeNativeProjectExactFileContractParts,
    nativeProjectExactFileRegistryComponents,
} from "../../../src/render/native-project-exact-file";
import type {
    NativeProjectExactFileProviderBehavior,
    NativeProjectExactFileRebaseMaterializer,
} from "../../../src/render/native-project-exact-file-results";
import { createRenderRegistry } from "../../../src/render/render-registry";
import { makeNativeDialectContract } from "../../source-import/fixtures/dialect-contracts";
import { makeTextFile, makeVersionClosure } from "../../catalog/fixtures/version-v2";

export const CATALOG_ASSET_ID = "10101010-1010-4010-8010-101010101010" as UuidV4;
export const CATALOG_VERSION_ID = "20202020-2020-4020-8020-202020202020" as UuidV4;
export const UNIT_ASSET_ID = "30303030-3030-4030-8030-303030303030" as UuidV4;
export const UNIT_VERSION_ID = "40404040-4040-4040-8040-404040404040" as UuidV4;
export const SECOND_UNIT_ASSET_ID = "50505050-5050-4050-8050-505050505050" as UuidV4;
export const SECOND_UNIT_VERSION_ID = "60606060-6060-4060-8060-606060606060" as UuidV4;
export const MEMORY_CATALOG_DIALECT_ID = "fixture-memory-catalog-v1";
export const MEMORY_TOPIC_DIALECT_ID = "fixture-memory-topic-v1";
export const MEMORY_CATALOG_PATH = "MEMORY.md" as PosixRelativePath;
export const FIRST_TOPIC_PATH = "topics/first.md" as PosixRelativePath;
export const SECOND_TOPIC_PATH = "topics/second.md" as PosixRelativePath;
export const CATALOG_TEXT = "# Memory\n\n<!-- keep catalog comment -->\n- [First](topics/first.md) — first hint\n";
export const CHANGED_CATALOG_TEXT =
    "# Memory\n\n<!-- keep catalog comment -->\n- [Second](topics/second.md) — second hint\n" +
    "- [First renamed](topics/first.md) — revised first hint\n";
export const TEST_HASH = `sha256:${"9".repeat(64)}` as Sha256Digest;
export const CATALOG_PROJECT_ID = "70707070-7070-4070-8070-707070707070" as UuidV4;

type MemoryCatalogBehavior = NonNullable<NativeProjectExactFileProviderBehavior["memoryCatalog"]>;

export interface MemoryCatalogFixtureOverrides {
    parse?: MemoryCatalogBehavior["parse"];
    resolveMemberPath?: MemoryCatalogBehavior["resolveMemberPath"];
    rebaseMaterialize?: NativeProjectExactFileRebaseMaterializer["materialize"];
}

export function makeMemoryCatalogExactFileFixture(overrides: MemoryCatalogFixtureOverrides = {}) {
    const descriptor = { agentRuntimeId: "FIXTURE_CLI", displayName: "Fixture CLI", entryClass: "cli" as const };
    const nativeDialect = makeNativeDialectContract("Memory", MEMORY_CATALOG_DIALECT_ID, validateCatalogNative);
    const nativeDialectFingerprint = computeNativeDialectContractFingerprint(nativeDialect.definition);
    const unitNativeDialect = makeNativeDialectContract("Memory", MEMORY_TOPIC_DIALECT_ID, validateUnitNative);
    const unitNativeDialectFingerprint = computeNativeDialectContractFingerprint(unitNativeDialect.definition);
    const support = createNativeProjectExactFileProviderSupport({
        adapterId: "FIXTURE",
        adapterVersion: "0.1.0",
        agentRuntimes: [descriptor],
        agentRuntimeId: descriptor.agentRuntimeId,
        assetKind: "Memory",
        outputContractId: "FIXTURE_NATIVE_PROJECT_MEMORY_CATALOG_V1",
        materializationProfileId: "fixture-cli-project-memory-catalog-v1",
        nativeDialectId: MEMORY_CATALOG_DIALECT_ID,
        projectPathValidator: {
            ref: component("fixture.memory-catalog.path"),
            validate: (relativePath) => relativePath === MEMORY_CATALOG_PATH,
        },
        reverseParser: {
            ref: component("fixture.memory-catalog.reverse"),
            parse: () => null,
        },
        rebaseMaterializer: {
            ref: component("fixture.memory-catalog.rebase"),
            materialize:
                overrides.rebaseMaterialize ??
                ((input) => {
                    if (
                        input.targetCanonical.kind !== "Memory" ||
                        input.targetCanonical.typeData.entityRole !== "catalog" ||
                        input.targetFiles.length !== 0 ||
                        input.parent.file.relativePath !== MEMORY_CATALOG_PATH
                    ) {
                        return null;
                    }
                    return { nativeText: renderCatalog(input.memoryCatalogMembers) };
                }),
        },
        restorationDialectIds: [],
        memoryCatalog: {
            parse:
                overrides.parse ??
                (({ relativePath, nativeDialectId, nativeText }) =>
                    relativePath !== MEMORY_CATALOG_PATH || nativeDialectId !== MEMORY_CATALOG_DIALECT_ID
                        ? null
                        : parseCatalog(nativeText)),
            resolveMemberPath:
                overrides.resolveMemberPath ??
                (({ targetAssetVersionId, dialectInputs }) => {
                    const group = dialectInputs.find((candidate) => candidate.targetVersion.versionId === targetAssetVersionId);
                    const natives = group?.inputs.filter(
                        (candidate) =>
                            candidate.inputKind === "native_representation" &&
                            candidate.representation.dialectId === MEMORY_TOPIC_DIALECT_ID,
                    );
                    const file = natives?.[0]?.inputKind === "native_representation" ? natives[0].files[0] : undefined;
                    return natives?.length === 1 && file?.contentKind === "text" ? file.relativePath : null;
                }),
        },
        target: {
            targetContextSchemaId: "FIXTURE_CLI_PROJECT_MEMORY_TARGET_V1",
            requiredFacts: { "oaam.project-binding": "registered", "oaam.target-kind": "directory" },
        },
        verifiedBuilds: [
            createVerifiedNativeProjectExactFileBuild({
                agentRuntimeId: descriptor.agentRuntimeId,
                versionText: "1.2.3",
                buildIdentity: `sha256:${"3".repeat(64)}`,
                platform: "wsl",
                materializationProfileId: "fixture-cli-project-memory-catalog-v1",
                fixtureId: "fixture-cli-project-memory-catalog-2026-08-03",
                assetKind: "Memory",
                nativeDialectId: MEMORY_CATALOG_DIALECT_ID,
                projectPathValidator: component("fixture.memory-catalog.path"),
                reverseParser: component("fixture.memory-catalog.reverse"),
                rebaseMaterializer: component("fixture.memory-catalog.rebase"),
                restorationDialectIds: [],
                parentRebaseFixtureId: "fixture-cli-project-memory-catalog-parent-rebase-v1",
                targetRelativePath: MEMORY_CATALOG_PATH,
                exactLoadMarker: "OAAM_MEMORY_CATALOG_FIXTURE_MARKER",
                reverseFixtureId: "fixture-memory-catalog-membership-reverse-v1",
            }),
        ],
    });
    const unitSupport = createNativeProjectExactFileProviderSupport({
        adapterId: "FIXTURE",
        adapterVersion: "0.1.0",
        agentRuntimes: [descriptor],
        agentRuntimeId: descriptor.agentRuntimeId,
        assetKind: "Memory",
        outputContractId: "FIXTURE_NATIVE_PROJECT_MEMORY_UNIT_V1",
        materializationProfileId: "fixture-cli-project-memory-unit-v1",
        materializerCapabilityKey: "fixture.project-memory-unit-exact-file-v1",
        nativeDialectId: MEMORY_TOPIC_DIALECT_ID,
        projectPathValidator: {
            ref: component("fixture.memory-unit.path"),
            validate: (relativePath) => relativePath === FIRST_TOPIC_PATH || relativePath === SECOND_TOPIC_PATH,
        },
        reverseParser: {
            ref: component("fixture.memory-unit.reverse"),
            parse: ({ currentNativeText }) => ({ canonicalEntryText: currentNativeText }),
        },
        rebaseMaterializer: null,
        restorationDialectIds: [],
        target: {
            targetContextSchemaId: "FIXTURE_CLI_PROJECT_MEMORY_TARGET_V1",
            requiredFacts: { "oaam.project-binding": "registered", "oaam.target-kind": "directory" },
        },
        verifiedBuilds: [
            createVerifiedNativeProjectExactFileBuild({
                agentRuntimeId: descriptor.agentRuntimeId,
                versionText: "1.2.3",
                buildIdentity: `sha256:${"3".repeat(64)}`,
                platform: "wsl",
                materializationProfileId: "fixture-cli-project-memory-unit-v1",
                fixtureId: "fixture-cli-project-memory-unit-2026-08-03",
                assetKind: "Memory",
                nativeDialectId: MEMORY_TOPIC_DIALECT_ID,
                projectPathValidator: component("fixture.memory-unit.path"),
                reverseParser: component("fixture.memory-unit.reverse"),
                rebaseMaterializer: null,
                restorationDialectIds: [],
                parentRebaseFixtureId: "",
                targetRelativePath: FIRST_TOPIC_PATH,
                exactLoadMarker: "OAAM_MEMORY_UNIT_FIXTURE_MARKER",
                reverseFixtureId: "fixture-memory-unit-reverse-v1",
            }),
        ],
    });
    const provider: AdapterProviderSummary = {
        adapterId: "FIXTURE",
        displayName: "Fixture Provider",
        version: "0.1.0",
        enabled: true,
        agentRuntimes: [descriptor],
        targetContextSchemas: [support.targetContextSchema],
        assetSourceCapabilities: [],
        assetTargetCapabilities: [support.targetCapability, unitSupport.targetCapability],
        materializerCapabilities: [support.materializerCapability, unitSupport.materializerCapability],
        renderContractDeclarations: [support.renderContractDeclaration, unitSupport.renderContractDeclaration],
    };
    const registry = createRenderRegistry({
        providers: [provider],
        ...nativeProjectExactFileRegistryComponents([provider]),
    });
    const initialCatalogCanonical = catalogCanonical([UNIT_VERSION_ID]);
    const catalogClosure = makeVersionClosure({
        assetId: CATALOG_ASSET_ID,
        versionId: CATALOG_VERSION_ID,
        canonical: initialCatalogCanonical,
        files: [],
    });
    const firstUnitClosure = memoryUnitClosure(UNIT_ASSET_ID, UNIT_VERSION_ID, "First", "first.md");
    const secondUnitClosure = memoryUnitClosure(SECOND_UNIT_ASSET_ID, SECOND_UNIT_VERSION_ID, "Second", "second.md");
    const catalogAsset = renderAsset(CATALOG_ASSET_ID, CATALOG_VERSION_ID, catalogClosure, {});
    const firstUnitAsset = renderAsset(UNIT_ASSET_ID, UNIT_VERSION_ID, firstUnitClosure, {
        [firstUnitClosure.files[0]!.file.fileId]: "memory-entry-first",
    });
    const secondUnitAsset = renderAsset(SECOND_UNIT_ASSET_ID, SECOND_UNIT_VERSION_ID, secondUnitClosure, {
        [secondUnitClosure.files[0]!.file.fileId]: "memory-entry-second",
    });
    const targetContextPreimage = {
        schemaVersion: 1 as const,
        agentRuntimeId: descriptor.agentRuntimeId,
        versionText: "1.2.3",
        buildIdentity: `sha256:${"3".repeat(64)}` as Sha256Digest,
        targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
        targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
        renderFacts: [
            { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" as const },
            { key: "oaam.project-binding", value: "registered", evidenceLevel: "local_artifact" as const },
            { key: "oaam.target-kind", value: "directory", evidenceLevel: "local_artifact" as const },
        ],
    };
    const targetContext = {
        ...targetContextPreimage,
        targetApplicabilityFingerprint: computeTargetApplicabilityFingerprint({
            context: targetContextPreimage,
            entryClass: descriptor.entryClass,
        }),
    };
    const catalogNative = nativeFile(MEMORY_CATALOG_PATH, CATALOG_TEXT);
    const catalogDialectInput = nativeInput(
        CATALOG_ASSET_ID,
        CATALOG_VERSION_ID,
        catalogClosure.manifest.versionCanonicalContentFingerprint,
        MEMORY_CATALOG_DIALECT_ID,
        nativeDialectFingerprint,
        catalogNative,
    );
    const firstDialectInput = nativeInput(
        UNIT_ASSET_ID,
        UNIT_VERSION_ID,
        firstUnitClosure.manifest.versionCanonicalContentFingerprint,
        MEMORY_TOPIC_DIALECT_ID,
        unitNativeDialectFingerprint,
        nativeFile(FIRST_TOPIC_PATH, firstUnitClosure.files[0]!.contentKind === "text" ? firstUnitClosure.files[0]!.text : ""),
    );
    const secondDialectInput = nativeInput(
        SECOND_UNIT_ASSET_ID,
        SECOND_UNIT_VERSION_ID,
        secondUnitClosure.manifest.versionCanonicalContentFingerprint,
        MEMORY_TOPIC_DIALECT_ID,
        unitNativeDialectFingerprint,
        nativeFile(SECOND_TOPIC_PATH, secondUnitClosure.files[0]!.contentKind === "text" ? secondUnitClosure.files[0]!.text : ""),
    );
    const assets = [catalogAsset, firstUnitAsset, secondUnitAsset];
    const deploymentPreimage = {
        schemaVersion: 1 as const,
        deploymentId: "80808080-8080-4080-8080-808080808080" as UuidV4,
        consumerAgentRuntimeIds: [descriptor.agentRuntimeId],
        platform: "wsl" as const,
        platformInstanceId: "test-wsl",
        targetRootPath: "/tmp/oaam-memory-catalog-target",
        projectId: CATALOG_PROJECT_ID,
        targetContexts: [targetContext],
        renderRegistryFingerprint: registry.fingerprint,
        assets,
        targetFileSnapshots: [
            {
                relativePath: MEMORY_CATALOG_PATH,
                snapshotState: "present" as const,
                contentHash: catalogNative.contentHash,
                byteSize: catalogNative.byteSize,
                executable: false,
            },
        ],
    };
    const deployment: RenderDeploymentInput = {
        ...deploymentPreimage,
        renderInputFingerprint: computeRenderInputFingerprint(deploymentPreimage),
    };
    const allSemantics = deriveRequiredRenderSemanticsV1(deployment);
    const catalogSemantics = allSemantics.filter(
        (semantic) => semantic.subject.assetId === CATALOG_ASSET_ID && semantic.subject.versionId === CATALOG_VERSION_ID,
    );
    const analysisInput: RenderAnalysisInput = {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: deployment.platform,
            platformInstanceId: deployment.platformInstanceId,
            targetContexts: deployment.targetContexts,
            assets: deployment.assets,
            targetFileSnapshots: deployment.targetFileSnapshots,
            renderInputFingerprint: deployment.renderInputFingerprint,
        },
        requiredSemantics: catalogSemantics,
        dialectInputs: [catalogDialectInput, firstDialectInput, secondDialectInput],
    };
    return {
        descriptor,
        support,
        unitSupport,
        provider,
        registry,
        nativeDialect,
        unitNativeDialect,
        catalogClosure,
        firstUnitClosure,
        secondUnitClosure,
        catalogAsset,
        firstUnitAsset,
        secondUnitAsset,
        catalogDialectInput,
        firstDialectInput,
        secondDialectInput,
        deployment,
        allSemantics,
        catalogSemantics,
        analysisInput,
    };
}

function validateUnitNative(input: Parameters<ReturnType<typeof makeNativeDialectContract>["validateSameContent"]>[0]): boolean {
    if (
        input.canonical.kind !== "Memory" ||
        input.canonical.typeData.entityRole !== "unit" ||
        input.canonicalFiles.length !== 1 ||
        input.nativeFiles.length !== 1 ||
        input.representation.files.length !== 1
    ) {
        return false;
    }
    const canonical = input.canonicalFiles[0];
    const native = input.nativeFiles[0];
    return (
        canonical?.contentKind === "text" &&
        native.relativePath === input.representation.files[0]?.relativePath &&
        new TextDecoder("utf8", { fatal: true }).decode(native.bytes) === canonical.text
    );
}

export function catalogCanonical(memberIds: UuidV4[]): Extract<AssetKindTypeDataV2, { kind: "Memory" }> {
    return {
        kind: "Memory",
        typeData: {
            schemaVersion: 2,
            entityRole: "catalog",
            members: memberIds.map((targetAssetVersionId, index) => ({
                targetAssetVersionId,
                routingTitle: index === 0 ? "First" : "Second",
                routingHint: index === 0 ? "first hint" : "second hint",
            })),
        },
    };
}

export function changedCatalogCanonical(): Extract<AssetKindTypeDataV2, { kind: "Memory" }> {
    return {
        kind: "Memory",
        typeData: {
            schemaVersion: 2,
            entityRole: "catalog",
            members: [
                {
                    targetAssetVersionId: SECOND_UNIT_VERSION_ID,
                    routingTitle: "Second",
                    routingHint: "second hint",
                },
                {
                    targetAssetVersionId: UNIT_VERSION_ID,
                    routingTitle: "First renamed",
                    routingHint: "revised first hint",
                },
            ],
        },
    };
}

export function makeMemoryCatalogMaterializationInput(
    fixture: ReturnType<typeof makeMemoryCatalogExactFileFixture>,
): RenderMaterializationInput {
    const analysis = fixture.support.analyze(fixture.analysisInput);
    if (analysis.status !== "complete") throw new Error("Catalog analysis fixture did not close");
    const contract = makeNativeProjectExactFileContractParts(fixture.support.renderContractDeclaration).outputContract;
    const profile = contract.materializationProfiles[0];
    if (profile === undefined) throw new Error("Catalog materialization profile missing");
    return {
        schemaVersion: 1,
        deployment: structuredClone(fixture.analysisInput.deployment),
        requiredSemantics: structuredClone(fixture.analysisInput.requiredSemantics),
        dialectInputs: structuredClone(fixture.analysisInput.dialectInputs),
        selection: {
            schemaVersion: 1,
            outputUnits: structuredClone(analysis.outputUnits),
            outputUnitRenderers: analysis.outputUnits.map((unit) => ({
                outputUnitFingerprint: unit.outputUnitFingerprint,
                rendererAdapterId: fixture.provider.adapterId,
                rendererAdapterVersion: fixture.provider.version,
                materializerCapabilityKey: fixture.support.materializerCapability.materializerCapabilityKey,
                materializationProfileId: fixture.support.renderContractDeclaration.materializationProfileId,
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

export function makeMemoryCatalogInspectionInput(
    fixture: ReturnType<typeof makeMemoryCatalogExactFileFixture>,
    currentText = CHANGED_CATALOG_TEXT,
): RenderedTargetInspectionInput {
    const materialization = makeMemoryCatalogMaterializationInput(fixture);
    const catalogUnit = materialization.selection.outputUnits[0];
    if (catalogUnit === undefined) throw new Error("Catalog output unit missing");
    const firstUnit = fixtureUnitOutput("FIXTURE_MEMORY_UNIT_FIRST", FIRST_TOPIC_PATH, `sha256:${"1".repeat(64)}`);
    const secondUnit = fixtureUnitOutput("FIXTURE_MEMORY_UNIT_SECOND", SECOND_TOPIC_PATH, `sha256:${"2".repeat(64)}`);
    const catalogSupport = fixture.catalogSemantics.find((semantic) => semantic.semanticKind === "memory.support");
    const firstSupport = fixture.allSemantics.find(
        (semantic) =>
            semantic.semanticKind === "memory.support" &&
            semantic.subject.assetId === UNIT_ASSET_ID &&
            semantic.subject.versionId === UNIT_VERSION_ID,
    );
    const secondSupport = fixture.allSemantics.find(
        (semantic) =>
            semantic.semanticKind === "memory.support" &&
            semantic.subject.assetId === SECOND_UNIT_ASSET_ID &&
            semantic.subject.versionId === SECOND_UNIT_VERSION_ID,
    );
    const renderer = materialization.selection.outputUnitRenderers[0];
    if (catalogSupport === undefined || firstSupport === undefined || secondSupport === undefined || renderer === undefined) {
        throw new Error("Memory Catalog inspection fixture is incomplete");
    }
    return {
        schemaVersion: 1,
        deploymentId: fixture.deployment.deploymentId,
        appliedRenderSnapshot: {
            schemaVersion: 1,
            snapshotState: "applied",
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            compilerPolicyVersion: "core_render_policy_v1",
            selectionFingerprint: TEST_HASH,
            compilationFingerprint: TEST_HASH,
            decisions: [
                fixtureDecision(catalogSupport, catalogUnit.outputUnitFingerprint),
                fixtureDecision(firstSupport, firstUnit.outputUnitFingerprint),
                fixtureDecision(secondSupport, secondUnit.outputUnitFingerprint),
            ],
            outputUnits: [catalogUnit, firstUnit, secondUnit],
            outputUnitRenderers: [renderer],
            semanticCoverageProofs: [],
        },
        appliedAssets: [fixture.catalogAsset, fixture.firstUnitAsset, fixture.secondUnitAsset],
        inspectionScope: {
            inspectionScopeFingerprint: TEST_HASH,
            fileStates: [
                {
                    relativePath: MEMORY_CATALOG_PATH,
                    state: "changed",
                    appliedContentHash: textPayloadStats(CATALOG_TEXT).contentHash,
                    currentContentHash: textPayloadStats(currentText).contentHash,
                    appliedExecutable: false,
                    currentExecutable: false,
                    outputUnitFingerprint: catalogUnit.outputUnitFingerprint,
                    provenanceFingerprint: TEST_HASH,
                },
            ],
            directoryInventories: [],
        },
        files: [
            {
                fileState: "baseline_changed",
                relativePath: MEMORY_CATALOG_PATH,
                appliedContent: { contentKind: "text", text: CATALOG_TEXT },
                currentContent: { contentKind: "text", text: currentText },
                diffHunks: [
                    {
                        hunkFingerprint: TEST_HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(CATALOG_TEXT),
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(currentText),
                    },
                ],
                attributeChanges: [],
                provenance: {
                    schemaVersion: 1,
                    appliedRenderSnapshotFingerprint: TEST_HASH,
                    outputUnitFingerprint: catalogUnit.outputUnitFingerprint,
                    semanticRefFingerprints: [catalogSupport.semanticRefFingerprint],
                    sectionBindings: [],
                    materializationFingerprint: TEST_HASH,
                    provenanceFingerprint: TEST_HASH,
                },
            },
        ],
        inventoryDeltas: [],
    };
}

function memoryUnitClosure(assetId: UuidV4, versionId: UuidV4, name: string, fileName: string) {
    return makeVersionClosure({
        assetId,
        versionId,
        canonical: {
            kind: "Memory",
            typeData: {
                schemaVersion: 2,
                entityRole: "unit",
                card: { name, description: `${name} topic` },
                loading: { card: "high", body: "low" },
                applicabilityRule: "",
            },
        },
        files: [makeTextFile(`# ${name}\n${name} memory.\n`, fileName)],
    });
}

function renderAsset(
    assetId: UuidV4,
    versionId: UuidV4,
    closure: ReturnType<typeof makeVersionClosure>,
    sectionHandles: Record<string, string>,
): RenderAssetInput {
    return {
        scope: "project",
        projectId: CATALOG_PROJECT_ID,
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId, versionId },
            versionFingerprint: closure.manifest.fingerprint,
            versionCanonicalContentFingerprint: closure.manifest.versionCanonicalContentFingerprint,
            status: closure.manifest.status,
            canonical: {
                kind: closure.manifest.kind,
                typeData: structuredClone(closure.manifest.typeData),
            } as AssetKindTypeDataV2,
            files: closure.files,
        },
        sectionHandles,
    };
}

function nativeInput(
    assetId: UuidV4,
    versionId: UuidV4,
    canonicalContentFingerprint: Sha256Digest,
    dialectId: string,
    dialectContractFingerprint: Sha256Digest,
    file: RenderNativeRepresentationFileInput,
): RenderAnalysisInput["dialectInputs"][number] {
    const { text: _text, ...descriptor } = file as Extract<RenderNativeRepresentationFileInput, { contentKind: "text" }>;
    const preimage = {
        schemaVersion: 1 as const,
        dialectId,
        dialectContractFingerprint,
        canonicalContentFingerprint,
        files: [descriptor],
    };
    return {
        targetVersion: { assetId, versionId },
        consumerAgentRuntimeIds: ["FIXTURE_CLI"],
        inputs: [
            {
                inputKind: "native_representation",
                inputRole: "current_exact",
                representation: {
                    ...preimage,
                    representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage),
                },
                files: [file],
            },
        ],
    };
}

function nativeFile(relativePath: PosixRelativePath, text: string): RenderNativeRepresentationFileInput {
    return {
        relativePath,
        contentKind: "text",
        mediaType: "text/markdown",
        ...textPayloadStats(text),
        executable: false,
        text,
    };
}

function parseCatalog(
    text: string,
): { members: Array<{ relativePath: PosixRelativePath; routingTitle: string; routingHint: string }> } | null {
    const members = text.split("\n").flatMap((line) => {
        const match = /^- \[([^\]]+)\]\(([^)]+)\)(?: — (.*))?$/u.exec(line);
        return match === null
            ? []
            : [
                  {
                      relativePath: match[2] as PosixRelativePath,
                      routingTitle: match[1] as string,
                      routingHint: match[3] ?? "",
                  },
              ];
    });
    return new Set(members.map((member) => member.relativePath)).size === members.length ? { members } : null;
}

function renderCatalog(
    members: readonly { relativePath: PosixRelativePath; routingTitle: string; routingHint: string }[],
): string {
    return `# Memory\n\n<!-- keep catalog comment -->\n${members
        .map(
            (member) =>
                `- [${member.routingTitle}](${member.relativePath})${member.routingHint === "" ? "" : ` — ${member.routingHint}`}`,
        )
        .join("\n")}\n`;
}

function validateCatalogNative(
    input: Parameters<ReturnType<typeof makeNativeDialectContract>["validateSameContent"]>[0],
): boolean {
    if (
        input.canonical.kind !== "Memory" ||
        input.canonical.typeData.entityRole !== "catalog" ||
        input.canonicalFiles.length !== 0 ||
        input.nativeFiles.length !== 1 ||
        input.representation.files.length !== 1 ||
        input.nativeFiles[0]?.relativePath !== MEMORY_CATALOG_PATH
    ) {
        return false;
    }
    const parsed = parseCatalog(new TextDecoder("utf8", { fatal: true }).decode(input.nativeFiles[0].bytes));
    const expectedMembers = input.canonical.typeData.members;
    return (
        parsed !== null &&
        parsed.members.length === expectedMembers.length &&
        parsed.members.every((member, index) => {
            const expected = expectedMembers[index];
            return member.routingTitle === expected?.routingTitle && member.routingHint === expected.routingHint;
        })
    );
}

function component(componentId: string) {
    return {
        componentId,
        componentVersion: 1,
        configFingerprint: `sha256:${"5".repeat(64)}` as Sha256Digest,
    };
}

function fixtureDecision(
    semanticRef: ReturnType<typeof makeMemoryCatalogExactFileFixture>["allSemantics"][number],
    outputUnitFingerprint: Sha256Digest,
) {
    return {
        semanticRef,
        consumerOwnerAdapterId: "FIXTURE",
        consumerOwnerAdapterVersion: "0.1.0",
        optionFingerprint: TEST_HASH,
        renderStrategy: "native_file" as const,
        actualReverseExtractPolicy: "can_reconcile" as const,
        outputUnitFingerprints: [outputUnitFingerprint],
        outcome: "preserved" as const,
    };
}

function fixtureUnitOutput(outputContractId: string, relativePath: PosixRelativePath, fingerprint: Sha256Digest) {
    const preimage = {
        outputContractId,
        outputContractFingerprint: fingerprint,
        claims: [{ relativePath, contentKind: "text" as const, executable: false }],
        managedDirectoryBoundaries: [],
    };
    return { ...preimage, outputUnitFingerprint: computeRenderOutputUnitFingerprint(preimage) };
}
