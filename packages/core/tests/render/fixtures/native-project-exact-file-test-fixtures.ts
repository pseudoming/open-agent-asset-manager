/** Deterministic Core fixtures for the current-native project exact-file contract. */

import type {
    AdapterProvider,
    AdapterProviderSummary,
    AdapterTargetBuildCompatibilityPolicyV1,
    NativeProjectExactFileAssetKind,
    PosixRelativePath,
    SourceEvidenceLevel,
} from "../../../src/types";
import type {
    CanonicalRenderSemanticValue,
    MaterializationSafeRenderSelection,
    RenderAnalysisInput,
    RenderDeploymentInput,
    RenderMaterializationInput,
} from "../../../src/contracts/render";
import type { AppliedRenderSnapshotV1 } from "../../../src/contracts/deployment-authority";
import type { RenderedTargetInspectionInput } from "../../../src/contracts/reverse";
import {
    computeCanonicalRenderSemanticValueFingerprint,
    computeRenderInputFingerprint,
    computeTargetApplicabilityFingerprint,
} from "../../../src/foundation/fingerprint";
import { textPayloadStats } from "../../../src/catalog/payload-store";
import { deriveRequiredRenderSemanticsV1, entrySemanticKind } from "../../../src/render/render-semantics";
import {
    createNativeProjectExactFileProviderSupport,
    createVerifiedNativeProjectExactFileBuild,
    nativeProjectExactFileRegistryComponents,
    type NativeProjectExactFileRebaseMaterializer,
} from "../../../src/render/native-project-exact-file";
import { createRenderRegistry } from "../../../src/render/render-registry";
import { makeRestorationDialectContract } from "../../source-import/fixtures/dialect-contracts";
import {
    ASSET_ID,
    FILE_ID,
    PROJECT_ID,
    VERSION_ID,
    VERSION_ID_2,
    makeTextFile,
    makeVersionClosure,
} from "../../catalog/fixtures/version-v2";
import {
    EXACT_CHANGED_ENTRY_TEXT,
    EXACT_CHANGED_NATIVE_TEXT,
    EXACT_DIALECT_ID,
    EXACT_ENTRY_TEXT,
    EXACT_HASH,
    EXACT_NATIVE_TEXT,
    EXACT_OUTPUT_CONTRACT_ID,
    EXACT_PARSER_REF,
    EXACT_PATH_REF,
    EXACT_PROFILE_ID,
    EXACT_REBASE_REF,
    EXACT_REBASED_ENTRY_TEXT,
    EXACT_REBASED_NATIVE_TEXT,
    EXACT_TARGET_PATH,
    MEMORY_EXACT_CHANGED_ENTRY_TEXT,
    MEMORY_EXACT_CHANGED_NATIVE_TEXT,
    MEMORY_EXACT_DIALECT_ID,
    MEMORY_EXACT_ENTRY_TEXT,
    MEMORY_EXACT_NATIVE_TEXT,
    MEMORY_EXACT_OUTPUT_CONTRACT_ID,
    MEMORY_EXACT_PROFILE_ID,
    MEMORY_EXACT_REBASED_ENTRY_TEXT,
    MEMORY_EXACT_REBASED_NATIVE_TEXT,
    MEMORY_EXACT_TARGET_PATH,
    type ExactFixtureDefinition,
    exactFixtureDefinition,
    makeExactDialectInput,
    makeExactNativeDialectContract,
    skillCanonical,
} from "./native-project-exact-file-native-test-fixtures";

export {
    EXACT_CHANGED_ENTRY_TEXT,
    EXACT_CHANGED_NATIVE_TEXT,
    EXACT_DIALECT_ID,
    EXACT_ENTRY_TEXT,
    EXACT_HASH,
    EXACT_NATIVE_TEXT,
    EXACT_OUTPUT_CONTRACT_ID,
    EXACT_PARSER_REF,
    EXACT_PATH_REF,
    EXACT_PROFILE_ID,
    EXACT_REBASE_REF,
    EXACT_REBASED_ENTRY_TEXT,
    EXACT_REBASED_NATIVE_TEXT,
    EXACT_TARGET_PATH,
    MEMORY_EXACT_CHANGED_ENTRY_TEXT,
    MEMORY_EXACT_CHANGED_NATIVE_TEXT,
    MEMORY_EXACT_DIALECT_ID,
    MEMORY_EXACT_ENTRY_TEXT,
    MEMORY_EXACT_NATIVE_TEXT,
    MEMORY_EXACT_OUTPUT_CONTRACT_ID,
    MEMORY_EXACT_PROFILE_ID,
    MEMORY_EXACT_REBASED_ENTRY_TEXT,
    MEMORY_EXACT_REBASED_NATIVE_TEXT,
    MEMORY_EXACT_TARGET_PATH,
    RULE_EXACT_CHANGED_ENTRY_TEXT,
    RULE_EXACT_CHANGED_NATIVE_TEXT,
    RULE_EXACT_DIALECT_ID,
    RULE_EXACT_ENTRY_TEXT,
    RULE_EXACT_NATIVE_TEXT,
    RULE_EXACT_OUTPUT_CONTRACT_ID,
    RULE_EXACT_PROFILE_ID,
    RULE_EXACT_REBASED_ENTRY_TEXT,
    RULE_EXACT_REBASED_NATIVE_TEXT,
    RULE_EXACT_TARGET_PATH,
    memoryExactCanonical,
    ruleExactCanonical,
    skillCanonical,
} from "./native-project-exact-file-native-test-fixtures";

export const SECOND_EXACT_TARGET_PATH = ".fixture/skills/summarize/SKILL.md" as PosixRelativePath;
export const SECOND_EXACT_ENTRY_TEXT = "# Summarize\nSummarize the current change.\n";
export const SECOND_EXACT_NATIVE_TEXT =
    "---\n# fixture-native-layout: keep\nname: summarize\ndescription: Summarize changes\n" +
    `x-fixture-only: keep-me\n---\n${SECOND_EXACT_ENTRY_TEXT}`;
export const SECOND_EXACT_CHANGED_NATIVE_TEXT = SECOND_EXACT_NATIVE_TEXT.replace(
    "Summarize the current change.",
    "Summarize the change and its tests.",
);

const SECOND_ASSET_ID = "12121212-1212-4121-8121-121212121212";
const SECOND_VERSION_ID = "23232323-2323-4232-8232-232323232323";
const SECOND_FILE_ID = "34343434-3434-4343-8343-343434343434";

export function makeExactFileFixture(
    options: {
        assetKind?: Extract<NativeProjectExactFileAssetKind, "Rule" | "Skill" | "Memory">;
        rebaseMaterializer?: NativeProjectExactFileRebaseMaterializer;
        restorationDialectIds?: readonly string[];
        materializerCapabilityKey?: string;
        targetKind?: "directory";
        targetKindEvidenceLevel?: SourceEvidenceLevel;
        buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
        currentVersionText?: string;
        currentBuildIdentity?: `sha256:${string}`;
    } = {},
) {
    const definition = exactFixtureDefinition(options.assetKind ?? "Skill");
    const descriptor = { agentRuntimeId: "FIXTURE_CLI", displayName: "Fixture CLI", entryClass: "cli" as const };
    const rebaseMaterializer = options.rebaseMaterializer ?? {
        ref: EXACT_REBASE_REF,
        materialize: definition.rebaseNativeText,
    };
    const restorationDialectIds = [...(options.restorationDialectIds ?? [])];
    const nativeDialect = makeExactNativeDialectContract(definition, rebaseMaterializer.ref);
    const restorationDialects = restorationDialectIds.map((dialectId) =>
        makeRestorationDialectContract(definition.assetKind, dialectId),
    );
    const build = createVerifiedNativeProjectExactFileBuild({
        agentRuntimeId: descriptor.agentRuntimeId,
        versionText: "1.2.3",
        buildIdentity: `sha256:${"3".repeat(64)}`,
        platform: "wsl",
        materializationProfileId: definition.profileId,
        fixtureId: definition.fixtureId,
        assetKind: definition.assetKind,
        nativeDialectId: definition.nativeDialectId,
        projectPathValidator: EXACT_PATH_REF,
        reverseParser: EXACT_PARSER_REF,
        rebaseMaterializer: rebaseMaterializer.ref,
        restorationDialectIds,
        parentRebaseFixtureId: definition.parentRebaseFixtureId,
        targetRelativePath: definition.targetPath,
        exactLoadMarker: definition.exactLoadMarker,
        reverseFixtureId: definition.reverseFixtureId,
    });
    const support = createNativeProjectExactFileProviderSupport({
        adapterId: "FIXTURE",
        adapterVersion: "0.1.0",
        agentRuntimes: [descriptor],
        agentRuntimeId: descriptor.agentRuntimeId,
        assetKind: definition.assetKind,
        outputContractId: definition.outputContractId,
        materializationProfileId: definition.profileId,
        materializerCapabilityKey: options.materializerCapabilityKey,
        nativeDialectId: definition.nativeDialectId,
        projectPathValidator: { ref: EXACT_PATH_REF, validate: definition.validatePath },
        reverseParser: { ref: EXACT_PARSER_REF, parse: definition.parseChangedNativeText },
        rebaseMaterializer,
        restorationDialectIds,
        target: {
            targetContextSchemaId: "FIXTURE_CLI_PROJECT_TARGET_V1",
            requiredFacts: {
                "oaam.project-binding": "registered",
                ...(options.targetKind === undefined ? {} : { "oaam.target-kind": options.targetKind }),
                "fixture.mode": "exact",
            },
        },
        buildCompatibility: options.buildCompatibility,
        verifiedBuilds: [build],
    });
    const provider: AdapterProviderSummary = {
        adapterId: "FIXTURE",
        displayName: "Fixture Provider",
        version: "0.1.0",
        enabled: true,
        agentRuntimes: [descriptor],
        targetContextSchemas: [support.targetContextSchema],
        assetSourceCapabilities: [],
        assetTargetCapabilities: [support.targetCapability],
        materializerCapabilities: [support.materializerCapability],
        renderContractDeclarations: [support.renderContractDeclaration],
    };
    const contextPreimage = {
        schemaVersion: 1 as const,
        agentRuntimeId: descriptor.agentRuntimeId,
        versionText: options.currentVersionText ?? build.versionText,
        buildIdentity: options.currentBuildIdentity ?? build.buildIdentity,
        targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
        targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
        renderFacts: [
            { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" as const },
            { key: "oaam.project-binding", value: "registered", evidenceLevel: "local_artifact" as const },
            ...(options.targetKind === undefined
                ? []
                : [
                      {
                          key: "oaam.target-kind",
                          value: options.targetKind,
                          evidenceLevel: options.targetKindEvidenceLevel ?? ("local_artifact" as const),
                      },
                  ]),
            { key: "fixture.mode", value: "exact", evidenceLevel: "agent_runtime_verified" as const },
        ],
    };
    const targetContext = {
        ...contextPreimage,
        targetApplicabilityFingerprint: computeTargetApplicabilityFingerprint({
            context: contextPreimage,
            entryClass: descriptor.entryClass,
        }),
    };
    const components = nativeProjectExactFileRegistryComponents([provider]);
    const registry = createRenderRegistry({ providers: [provider], ...components });
    const canonical = definition.canonical();
    const closure = makeVersionClosure({ canonical, files: [makeTextFile(definition.entryText, definition.logicalPath)] });
    const asset: RenderDeploymentInput["assets"][number] = {
        scope: "project",
        projectId: PROJECT_ID,
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId: ASSET_ID, versionId: VERSION_ID },
            versionFingerprint: closure.manifest.fingerprint,
            versionCanonicalContentFingerprint: closure.manifest.versionCanonicalContentFingerprint,
            status: closure.manifest.status,
            canonical,
            files: closure.files,
        },
        sectionHandles: { [FILE_ID]: `${definition.assetKind.toLowerCase()}-entry` },
    };
    const deploymentPreimage = {
        schemaVersion: 1 as const,
        deploymentId: "11111111-1111-4111-8111-111111111111",
        consumerAgentRuntimeIds: [descriptor.agentRuntimeId],
        platform: "wsl" as const,
        platformInstanceId: "test-wsl",
        targetRootPath: "/tmp/oaam-native-exact-file-target",
        projectId: PROJECT_ID,
        targetContexts: [targetContext],
        renderRegistryFingerprint: registry.fingerprint,
        assets: [asset],
    };
    const deployment: RenderDeploymentInput = {
        ...deploymentPreimage,
        renderInputFingerprint: computeRenderInputFingerprint(deploymentPreimage),
    };
    const requiredSemantics = deriveRequiredRenderSemanticsV1(deployment);
    const dialectInputs = [makeExactDialectInput(closure.manifest.versionCanonicalContentFingerprint, nativeDialect, definition)];
    const analysisInput: RenderAnalysisInput = {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: deployment.platform,
            platformInstanceId: deployment.platformInstanceId,
            targetContexts: deployment.targetContexts,
            assets: deployment.assets,
            renderInputFingerprint: deployment.renderInputFingerprint,
        },
        requiredSemantics,
        dialectInputs,
    };
    return {
        definition,
        descriptor,
        nativeDialect,
        restorationDialects,
        rebaseMaterializer,
        build,
        support,
        provider,
        components,
        registry,
        targetContext,
        deployment,
        analysisInput,
        requiredSemantics,
        closure,
    };
}

export function makeTwoAssetExactFileFixture() {
    const fixture = makeExactFileFixture();
    const canonical = skillCanonical();
    canonical.typeData.name = "summarize";
    canonical.typeData.description = "Summarize changes";
    canonical.typeData.whenToUse = "When a concise change summary is needed";
    const file = makeTextFile(SECOND_EXACT_ENTRY_TEXT, "SKILL.md");
    file.file.fileId = SECOND_FILE_ID;
    const secondClosure = makeVersionClosure({
        assetId: SECOND_ASSET_ID,
        versionId: SECOND_VERSION_ID,
        canonical,
        files: [file],
    });
    const secondAsset = structuredClone(fixture.deployment.assets[0]!);
    secondAsset.version = {
        ref: { assetId: SECOND_ASSET_ID, versionId: SECOND_VERSION_ID },
        versionFingerprint: secondClosure.manifest.fingerprint,
        versionCanonicalContentFingerprint: secondClosure.manifest.versionCanonicalContentFingerprint,
        status: secondClosure.manifest.status,
        canonical,
        files: secondClosure.files,
    };
    secondAsset.sectionHandles = { [SECOND_FILE_ID]: "summarize-skill-entry" };
    const assets = [fixture.deployment.assets[0]!, secondAsset];
    const { renderInputFingerprint: _renderInputFingerprint, ...deploymentPreimage } = fixture.deployment;
    fixture.deployment = {
        ...deploymentPreimage,
        assets,
        renderInputFingerprint: computeRenderInputFingerprint({ ...deploymentPreimage, assets }),
    };
    fixture.requiredSemantics = deriveRequiredRenderSemanticsV1(fixture.deployment);
    fixture.analysisInput = {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: fixture.deployment.platform,
            platformInstanceId: fixture.deployment.platformInstanceId,
            targetContexts: fixture.deployment.targetContexts,
            assets: fixture.deployment.assets,
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
        },
        requiredSemantics: fixture.requiredSemantics,
        dialectInputs: [
            structuredClone(fixture.analysisInput.dialectInputs[0]!),
            makeExactDialectInput(
                secondClosure.manifest.versionCanonicalContentFingerprint,
                fixture.nativeDialect,
                fixture.definition,
                {
                    targetVersion: { assetId: SECOND_ASSET_ID, versionId: SECOND_VERSION_ID },
                    relativePath: SECOND_EXACT_TARGET_PATH,
                    nativeText: SECOND_EXACT_NATIVE_TEXT,
                },
            ),
        ],
    };
    return { ...fixture, secondClosure };
}

export function makeParentRebaseFixture(options: Parameters<typeof makeExactFileFixture>[0] = {}) {
    const fixture = makeExactFileFixture(options);
    const canonical = fixture.definition.canonical();
    if (canonical.kind === "Skill") canonical.typeData.description = "Review foreign changes";
    if (canonical.kind === "Memory" && canonical.typeData.entityRole === "unit") {
        canonical.typeData.card.description = "Foreign review conventions";
    }
    const closure = makeVersionClosure({
        versionId: VERSION_ID_2,
        revision: 2,
        sourceVersionId: VERSION_ID,
        changeKind: "edit",
        canonical,
        files: [makeTextFile(fixture.definition.rebasedEntryText, fixture.definition.logicalPath)],
    });
    const asset = structuredClone(fixture.deployment.assets[0]!);
    asset.version = {
        ref: { assetId: ASSET_ID, versionId: VERSION_ID_2 },
        versionFingerprint: closure.manifest.fingerprint,
        versionCanonicalContentFingerprint: closure.manifest.versionCanonicalContentFingerprint,
        status: closure.manifest.status,
        canonical,
        files: closure.files,
    };
    const { renderInputFingerprint: _oldRenderInputFingerprint, ...deploymentPreimage } = fixture.deployment;
    fixture.deployment = {
        ...deploymentPreimage,
        assets: [asset],
        renderInputFingerprint: computeRenderInputFingerprint({ ...deploymentPreimage, assets: [asset] }),
    };
    fixture.requiredSemantics = deriveRequiredRenderSemanticsV1(fixture.deployment);
    const parent = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
    if (parent.inputKind !== "native_representation") throw new Error("parent native fixture is missing");
    fixture.analysisInput = {
        schemaVersion: 1,
        deployment: {
            schemaVersion: 1,
            platform: fixture.deployment.platform,
            platformInstanceId: fixture.deployment.platformInstanceId,
            targetContexts: fixture.deployment.targetContexts,
            assets: fixture.deployment.assets,
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
        },
        requiredSemantics: fixture.requiredSemantics,
        dialectInputs: [
            {
                targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID_2 },
                consumerAgentRuntimeIds: [fixture.descriptor.agentRuntimeId],
                inputs: [
                    {
                        inputKind: "native_representation",
                        inputRole: "parent_rebase_seed",
                        sourceVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
                        representation: structuredClone(parent.representation),
                        files: structuredClone(parent.files),
                    },
                ],
            },
        ],
    };
    return { ...fixture, closure };
}

export function asExactFileProvider(fixture: ReturnType<typeof makeExactFileFixture>): AdapterProvider {
    return {
        ...structuredClone(fixture.provider),
        dialectContracts: {
            native: [fixture.nativeDialect],
            restoration: fixture.restorationDialects,
            portableEntries: [],
            portableSelectors: [],
        },
        probe: async () => {
            throw new Error("not called");
        },
        read: async () => {
            throw new Error("not called");
        },
        analyzeRender: async (input) => fixture.support.analyze(input),
        materializeRender: async (input) => fixture.support.materialize(input),
        inspectRenderedTarget: async (input) => fixture.support.inspect(input),
    };
}

export function exactMaterializationInput(fixture: ReturnType<typeof makeExactFileFixture>): RenderMaterializationInput {
    const analysis = fixture.support.analyze(fixture.analysisInput);
    if (analysis.status !== "complete") throw new Error("exact-file analysis fixture did not close");
    const profile = fixture.components.outputContracts[0]?.materializationProfiles.find(
        (candidate) => candidate.materializationProfileId === fixture.definition.profileId,
    );
    if (profile === undefined) throw new Error("exact-file profile fixture missing");
    const selection: MaterializationSafeRenderSelection = {
        schemaVersion: 1,
        outputUnits: analysis.outputUnits,
        outputUnitRenderers: analysis.outputUnits.map((unit) => ({
            outputUnitFingerprint: unit.outputUnitFingerprint,
            rendererAdapterId: fixture.provider.adapterId,
            rendererAdapterVersion: fixture.provider.version,
            materializerCapabilityKey: fixture.support.materializerCapability.materializerCapabilityKey,
            materializationProfileId: fixture.definition.profileId,
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
    };
    return {
        schemaVersion: 1,
        deployment: structuredClone(fixture.analysisInput.deployment),
        requiredSemantics: structuredClone(fixture.requiredSemantics),
        dialectInputs: structuredClone(fixture.analysisInput.dialectInputs),
        selection,
    };
}

export function exactCanonicalValues(fixture: ReturnType<typeof makeExactFileFixture>): CanonicalRenderSemanticValue[] {
    const asset = fixture.analysisInput.deployment.assets[0]!;
    const file = asset.version.files[0]!;
    if (file.contentKind !== "text") throw new Error("exact-file fixture must contain one text entry");
    return fixture.requiredSemantics.map((semantic): CanonicalRenderSemanticValue => {
        const base =
            semantic.semanticKind === "asset.file_inventory"
                ? {
                      semanticRefFingerprint: semantic.semanticRefFingerprint,
                      valueKind: "file_inventory" as const,
                      value: [
                          {
                              fileId: file.file.fileId,
                              logicalPath: file.file.logicalPath,
                              role: file.file.role,
                              contentKind: file.file.contentKind,
                              contentHash: file.file.contentHash,
                              executable: file.file.executable,
                          },
                      ],
                  }
                : semantic.semanticKind === entrySemanticKind(fixture.definition.assetKind)
                  ? {
                        semanticRefFingerprint: semantic.semanticRefFingerprint,
                        valueKind: "file_content" as const,
                        value: { contentKind: "text" as const, text: file.text },
                    }
                  : {
                        semanticRefFingerprint: semantic.semanticRefFingerprint,
                        valueKind: "asset_type_data" as const,
                        value: asset.version.canonical,
                    };
        return {
            ...base,
            canonicalValueFingerprint: computeCanonicalRenderSemanticValueFingerprint({
                semantic,
                assetKind: fixture.definition.assetKind,
                value: base,
            }),
        } as CanonicalRenderSemanticValue;
    });
}

export function changedExactFileInspection(
    fixture: ReturnType<typeof makeExactFileFixture>,
    materialization: RenderMaterializationInput,
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0]!;
    return {
        schemaVersion: 1,
        deploymentId: fixture.deployment.deploymentId,
        appliedRenderSnapshot: {
            schemaVersion: 1,
            snapshotState: "applied",
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            compilerPolicyVersion: "core_render_policy_v1",
            selectionFingerprint: EXACT_HASH,
            compilationFingerprint: EXACT_HASH,
            decisions: fixture.requiredSemantics.map((semantic) => ({
                semanticRef: semantic,
                consumerOwnerAdapterId: fixture.provider.adapterId,
                consumerOwnerAdapterVersion: fixture.provider.version,
                optionFingerprint: EXACT_HASH,
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
            inspectionScopeFingerprint: EXACT_HASH,
            fileStates: [
                {
                    relativePath: fixture.definition.targetPath,
                    state: "changed",
                    appliedContentHash: textPayloadStats(fixture.definition.nativeText).contentHash,
                    currentContentHash: textPayloadStats(fixture.definition.changedNativeText).contentHash,
                    appliedExecutable: false,
                    currentExecutable: false,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    provenanceFingerprint: EXACT_HASH,
                },
            ],
            directoryInventories: [],
        },
        files: [
            {
                fileState: "baseline_changed",
                relativePath: fixture.definition.targetPath,
                appliedContent: { contentKind: "text", text: fixture.definition.nativeText },
                currentContent: { contentKind: "text", text: fixture.definition.changedNativeText },
                diffHunks: [
                    {
                        hunkFingerprint: EXACT_HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(fixture.definition.nativeText),
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(fixture.definition.changedNativeText),
                    },
                ],
                attributeChanges: [],
                provenance: {
                    schemaVersion: 1,
                    appliedRenderSnapshotFingerprint: EXACT_HASH,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    semanticRefFingerprints: fixture.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint),
                    sectionBindings: [],
                    materializationFingerprint: EXACT_HASH,
                    provenanceFingerprint: EXACT_HASH,
                },
            },
        ],
        inventoryDeltas: [],
    };
}

export function fullExactFileAppliedSnapshot(
    snapshot: RenderedTargetInspectionInput["appliedRenderSnapshot"],
): Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }> {
    return {
        ...structuredClone(snapshot),
        promotionAuthorizations: [],
        decisions: snapshot.decisions.map((decision) => ({
            ...structuredClone(decision),
            approval: { approvalState: "not_required" as const },
        })),
    };
}
