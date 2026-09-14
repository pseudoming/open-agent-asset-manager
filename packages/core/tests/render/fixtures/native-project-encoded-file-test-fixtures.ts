/** Deterministic fixtures for one native file encoding a Subagent graph. */

import type {
    AdapterNativeDialectContractV1,
    AdapterProvider,
    AdapterProviderSummary,
    AssetKindTypeDataV2,
    PosixRelativePath,
    Sha256Digest,
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
    computeNativeDialectContractFingerprint,
    computeRenderInputFingerprint,
    computeTargetApplicabilityFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../../../src/foundation/fingerprint";
import { textPayloadStats } from "../../../src/catalog/payload-store";
import { deriveRequiredRenderSemanticsV1 } from "../../../src/render/render-semantics";
import {
    createNativeProjectEncodedFileProviderSupport,
    createVerifiedNativeProjectEncodedFileBuild,
    type EncodedCanonicalSectionDescriptor,
    type NativeProjectEncodedFileRebaseMaterializer,
} from "../../../src/render/native-project-encoded-file";
import { nativeProjectEncodedFileRegistryComponents } from "../../../src/render/native-project-encoded-file-behavior";
import { createRenderRegistry } from "../../../src/render/render-registry";
import {
    ASSET_ID,
    FILE_ID,
    PROJECT_ID,
    VERSION_ID,
    VERSION_ID_2,
    makeTextFile,
    makeVersionClosure,
} from "../../catalog/fixtures/version-v2";

export const ENCODED_HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
export const ENCODED_DIALECT_ID = "fixture-subagent-encoded-v1";
export const ENCODED_PROFILE_ID = "fixture-cli-project-subagent-encoded-v1";
export const ENCODED_OUTPUT_CONTRACT_ID = "FIXTURE_NATIVE_PROJECT_SUBAGENT_ENCODED_V1";
export const ENCODED_TARGET_PATH = ".fixture/agents/reviewer.md" as PosixRelativePath;
export const ENCODED_ENTRY_LOGICAL_PATH = "agent.json" as PosixRelativePath;
export const ENCODED_PROMPT_LOGICAL_PATH = "prompts/start.md" as PosixRelativePath;
export const ENCODED_PROMPT_FILE_ID = "abababab-abab-4bab-8bab-abababababab";
export const ENCODED_ENTRY_TEXT = JSON.stringify({
    schemaVersion: 1,
    sections: [{ title: "Role", content: "Review changes" }],
});
export const ENCODED_REBASED_ENTRY_TEXT = JSON.stringify({
    schemaVersion: 1,
    sections: [{ title: "Role", content: "Review foreign changes" }],
});
export const ENCODED_CHANGED_ENTRY_TEXT = JSON.stringify({
    schemaVersion: 1,
    sections: [{ title: "Role", content: "Review deployed changes" }],
});
export const ENCODED_PROMPT_TEXT = "Start with the changed files.\n";
export const ENCODED_REBASED_PROMPT_TEXT = "Start with the foreign change.\n";
export const ENCODED_CHANGED_PROMPT_TEXT = "Start with tests and changed files.\n";

export const ENCODED_PATH_REF = componentRef("fixture.subagent.encoded-path", "1");
export const ENCODED_PARSER_REF = componentRef("fixture.subagent.encoded-parser", "2");
export const ENCODED_REBASE_REF = componentRef("fixture.subagent.encoded-rebase", "3");

interface NativeEnvelope {
    schemaVersion: 1;
    name: string;
    description: string;
    privateLayout: string;
    entry: string;
    initialPrompt: string | null;
}

export const ENCODED_NATIVE_TEXT = nativeText({
    schemaVersion: 1,
    name: "reviewer",
    description: "Review changes",
    privateLayout: "keep-native-layout",
    entry: ENCODED_ENTRY_TEXT,
    initialPrompt: ENCODED_PROMPT_TEXT,
});
export const ENCODED_REBASED_NATIVE_TEXT = nativeText({
    schemaVersion: 1,
    name: "reviewer",
    description: "Review foreign changes",
    privateLayout: "keep-native-layout",
    entry: ENCODED_REBASED_ENTRY_TEXT,
    initialPrompt: ENCODED_REBASED_PROMPT_TEXT,
});
export const ENCODED_CHANGED_NATIVE_TEXT = nativeText({
    schemaVersion: 1,
    name: "reviewer",
    description: "Review changes",
    privateLayout: "keep-native-layout",
    entry: ENCODED_CHANGED_ENTRY_TEXT,
    initialPrompt: ENCODED_CHANGED_PROMPT_TEXT,
});

export function makeEncodedFileFixture(options: { withPrompt?: boolean; restorationDialectIds?: readonly string[] } = {}) {
    const withPrompt = options.withPrompt ?? true;
    const restorationDialectIds = options.restorationDialectIds ?? [];
    const descriptor = { agentRuntimeId: "FIXTURE_CLI", displayName: "Fixture CLI", entryClass: "cli" as const };
    const nativeDialect = makeEncodedNativeDialectContract();
    const build = createVerifiedNativeProjectEncodedFileBuild({
        agentRuntimeId: descriptor.agentRuntimeId,
        versionText: "1.2.3",
        buildIdentity: `sha256:${"3".repeat(64)}`,
        platform: "wsl",
        materializationProfileId: ENCODED_PROFILE_ID,
        fixtureId: "fixture-cli-1.2.3-project-subagent-encoded-2026-08-03",
        nativeDialectId: ENCODED_DIALECT_ID,
        projectPathValidator: ENCODED_PATH_REF,
        reverseParser: ENCODED_PARSER_REF,
        rebaseMaterializer: ENCODED_REBASE_REF,
        restorationDialectIds,
        parentRebaseFixtureId: "fixture-cli-1.2.3-project-subagent-encoded-parent-v1",
        targetRelativePath: ENCODED_TARGET_PATH,
        canonicalLogicalPaths: withPrompt
            ? [ENCODED_ENTRY_LOGICAL_PATH, ENCODED_PROMPT_LOGICAL_PATH]
            : [ENCODED_ENTRY_LOGICAL_PATH],
        exactLoadMarker: "OAAM_SUBAGENT_ENCODED_FIXTURE_MARKER",
        reverseFixtureId: "native-project-subagent-encoded-reverse-v1",
    });
    const support = createNativeProjectEncodedFileProviderSupport({
        adapterId: "FIXTURE",
        adapterVersion: "0.1.0",
        agentRuntimes: [descriptor],
        agentRuntimeId: descriptor.agentRuntimeId,
        outputContractId: ENCODED_OUTPUT_CONTRACT_ID,
        materializationProfileId: ENCODED_PROFILE_ID,
        nativeDialectId: ENCODED_DIALECT_ID,
        projectPathValidator: { ref: ENCODED_PATH_REF, validate: encodedPathIsValid },
        reverseParser: { ref: ENCODED_PARSER_REF, decode: decodeEncodedNativeFile },
        rebaseMaterializer: encodedRebaseMaterializer,
        restorationDialectIds,
        target: {
            targetContextSchemaId: "FIXTURE_CLI_PROJECT_TARGET_V1",
            requiredFacts: { "oaam.project-binding": "registered", "fixture.mode": "encoded" },
        },
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
        versionText: build.versionText,
        buildIdentity: build.buildIdentity,
        targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
        targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
        renderFacts: [
            { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" as const },
            { key: "oaam.project-binding", value: "registered", evidenceLevel: "local_artifact" as const },
            { key: "fixture.mode", value: "encoded", evidenceLevel: "agent_runtime_verified" as const },
        ],
    };
    const targetContext = {
        ...contextPreimage,
        targetApplicabilityFingerprint: computeTargetApplicabilityFingerprint({
            context: contextPreimage,
            entryClass: descriptor.entryClass,
        }),
    };
    const components = nativeProjectEncodedFileRegistryComponents([provider]);
    const registry = createRenderRegistry({ providers: [provider], ...components });
    const canonical = encodedSubagentCanonical(withPrompt);
    const files = encodedCanonicalFiles(withPrompt);
    const closure = makeVersionClosure({ canonical, files });
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
        sectionHandles: Object.fromEntries(closure.files.map((file) => [file.file.fileId, `encoded-${file.file.role}`])),
    };
    const deploymentPreimage = {
        schemaVersion: 1 as const,
        deploymentId: "11111111-1111-4111-8111-111111111111",
        consumerAgentRuntimeIds: [descriptor.agentRuntimeId],
        platform: "wsl" as const,
        platformInstanceId: "test-wsl",
        targetRootPath: "/tmp/oaam-native-encoded-file-target",
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
    const nativeInputText = withPrompt
        ? ENCODED_NATIVE_TEXT
        : nativeText({
              schemaVersion: 1,
              name: "reviewer",
              description: "Review changes",
              privateLayout: "keep-native-layout",
              entry: ENCODED_ENTRY_TEXT,
              initialPrompt: null,
          });
    const dialectInputs = [
        makeEncodedDialectInput(closure.manifest.versionCanonicalContentFingerprint, nativeDialect, nativeInputText),
    ];
    for (const dialectId of restorationDialectIds) {
        dialectInputs[0]!.inputs.push({
            inputKind: "dialect_restoration",
            restoration: {
                dialectId,
                restorationContractFingerprint: ENCODED_HASH,
                contentHash: ENCODED_HASH,
            },
            content: { contentKind: "text", text: "fixture restoration\n" },
        });
    }
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
        descriptor,
        nativeDialect,
        build,
        support,
        provider,
        targetContext,
        components,
        registry,
        canonical,
        closure,
        deployment,
        requiredSemantics,
        analysisInput,
        nativeInputText,
    };
}

export function makeParentEncodedRebaseFixture() {
    const fixture = makeEncodedFileFixture();
    const canonical = encodedSubagentCanonical(true);
    canonical.typeData.description = "Review foreign changes";
    const files = encodedCanonicalFiles(true, ENCODED_REBASED_ENTRY_TEXT, ENCODED_REBASED_PROMPT_TEXT);
    const closure = makeVersionClosure({
        versionId: VERSION_ID_2,
        revision: 2,
        sourceVersionId: VERSION_ID,
        changeKind: "edit",
        canonical,
        files,
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
    const { renderInputFingerprint: _oldFingerprint, ...deploymentPreimage } = fixture.deployment;
    fixture.deployment = {
        ...deploymentPreimage,
        assets: [asset],
        renderInputFingerprint: computeRenderInputFingerprint({ ...deploymentPreimage, assets: [asset] }),
    };
    fixture.requiredSemantics = deriveRequiredRenderSemanticsV1(fixture.deployment);
    const parent = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
    if (parent.inputKind !== "native_representation") throw new Error("encoded parent native input is missing");
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
                consumerAgentRuntimeIds: ["FIXTURE_CLI"],
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

export function asEncodedFileProvider(fixture: ReturnType<typeof makeEncodedFileFixture>): AdapterProvider {
    return {
        ...structuredClone(fixture.provider),
        dialectContracts: { native: [fixture.nativeDialect], restoration: [], portableEntries: [], portableSelectors: [] },
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

export function encodedMaterializationInput(fixture: ReturnType<typeof makeEncodedFileFixture>): RenderMaterializationInput {
    const analysis = fixture.support.analyze(fixture.analysisInput);
    if (analysis.status !== "complete") throw new Error("encoded-file analysis fixture did not close");
    const profile = fixture.components.outputContracts[0]?.materializationProfiles[0];
    if (profile === undefined) throw new Error("encoded-file profile fixture is missing");
    const selection: MaterializationSafeRenderSelection = {
        schemaVersion: 1,
        outputUnits: analysis.outputUnits,
        outputUnitRenderers: analysis.outputUnits.map((unit) => ({
            outputUnitFingerprint: unit.outputUnitFingerprint,
            rendererAdapterId: fixture.provider.adapterId,
            rendererAdapterVersion: fixture.provider.version,
            materializerCapabilityKey: fixture.support.materializerCapability.materializerCapabilityKey,
            materializationProfileId: ENCODED_PROFILE_ID,
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

export function encodedCanonicalValues(fixture: ReturnType<typeof makeEncodedFileFixture>): CanonicalRenderSemanticValue[] {
    const asset = fixture.analysisInput.deployment.assets[0]!;
    return fixture.requiredSemantics.map((semantic): CanonicalRenderSemanticValue => {
        const file =
            semantic.subject.subjectKind === "file"
                ? asset.version.files.find((candidate) => candidate.file.fileId === semantic.subject.fileId)
                : undefined;
        const value =
            semantic.semanticKind === "asset.file_inventory"
                ? {
                      semanticRefFingerprint: semantic.semanticRefFingerprint,
                      valueKind: "file_inventory" as const,
                      value: asset.version.files.map((candidate) => ({
                          fileId: candidate.file.fileId,
                          logicalPath: candidate.file.logicalPath,
                          role: candidate.file.role,
                          contentKind: candidate.file.contentKind,
                          contentHash: candidate.file.contentHash,
                          executable: candidate.file.executable,
                      })),
                  }
                : file?.contentKind === "text"
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
            ...value,
            canonicalValueFingerprint: computeCanonicalRenderSemanticValueFingerprint({
                semantic,
                assetKind: "Subagent",
                value,
            }),
        } as CanonicalRenderSemanticValue;
    });
}

export function changedEncodedInspection(
    fixture: ReturnType<typeof makeEncodedFileFixture>,
    materialization: RenderMaterializationInput,
    currentText = ENCODED_CHANGED_NATIVE_TEXT,
): RenderedTargetInspectionInput {
    const result = fixture.support.materialize(materialization);
    if (result.materializationState !== "materialized") throw new Error("encoded fixture did not materialize");
    const materializedFile = result.materializedUnits[0]!.files[0]!;
    const unit = materialization.selection.outputUnits[0]!;
    const appliedText = materializedFile.content.contentKind === "text" ? materializedFile.content.text : fixture.nativeInputText;
    return {
        schemaVersion: 1,
        deploymentId: fixture.deployment.deploymentId,
        appliedRenderSnapshot: {
            schemaVersion: 1,
            snapshotState: "applied",
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            compilerPolicyVersion: "core_render_policy_v1",
            selectionFingerprint: ENCODED_HASH,
            compilationFingerprint: ENCODED_HASH,
            decisions: fixture.requiredSemantics.map((semantic) => ({
                semanticRef: semantic,
                consumerOwnerAdapterId: fixture.provider.adapterId,
                consumerOwnerAdapterVersion: fixture.provider.version,
                optionFingerprint: ENCODED_HASH,
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
            inspectionScopeFingerprint: ENCODED_HASH,
            fileStates: [
                {
                    relativePath: ENCODED_TARGET_PATH,
                    state: "changed",
                    appliedContentHash: textPayloadStats(appliedText).contentHash,
                    currentContentHash: textPayloadStats(currentText).contentHash,
                    appliedExecutable: false,
                    currentExecutable: false,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    provenanceFingerprint: ENCODED_HASH,
                },
            ],
            directoryInventories: [],
        },
        files: [
            {
                fileState: "baseline_changed",
                relativePath: ENCODED_TARGET_PATH,
                appliedContent: { contentKind: "text", text: appliedText },
                currentContent: { contentKind: "text", text: currentText },
                diffHunks: [
                    {
                        hunkFingerprint: ENCODED_HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(appliedText),
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(currentText),
                    },
                ],
                attributeChanges: [],
                provenance: {
                    schemaVersion: 1,
                    appliedRenderSnapshotFingerprint: ENCODED_HASH,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    semanticRefFingerprints: materializedFile.semanticRefFingerprints,
                    sectionBindings: materializedFile.sectionBindings,
                    materializationFingerprint: ENCODED_HASH,
                    provenanceFingerprint: ENCODED_HASH,
                },
            },
        ],
        inventoryDeltas: [],
    };
}

export function fullEncodedAppliedSnapshot(
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

export function decodeEncodedNativeFile(input: {
    assetKind: "Subagent";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    nativeText: string;
    sections: EncodedCanonicalSectionDescriptor[];
}) {
    const parsed = parseNativeText(input.nativeText);
    if (
        input.assetKind !== "Subagent" ||
        input.nativeDialectId !== ENCODED_DIALECT_ID ||
        !encodedPathIsValid(input.relativePath) ||
        parsed === null
    ) {
        return null;
    }
    const sections = input.sections.flatMap((section) => {
        if (section.semanticKind === "subagent.invoked_context") {
            return [
                { sectionHandle: section.sectionHandle, canonicalContent: { contentKind: "text" as const, text: parsed.entry } },
            ];
        }
        return parsed.initialPrompt === null
            ? []
            : [
                  {
                      sectionHandle: section.sectionHandle,
                      canonicalContent: { contentKind: "text" as const, text: parsed.initialPrompt },
                  },
              ];
    });
    return sections.length === input.sections.length ? { sections } : null;
}

export const encodedRebaseMaterializer: NativeProjectEncodedFileRebaseMaterializer = {
    ref: ENCODED_REBASE_REF,
    materialize(input) {
        const parsed = parseNativeText(input.parent.file.text);
        const entry = input.targetFiles.find((file) => file.file.role === "entry");
        const resources = input.targetFiles.filter((file) => file.file.role === "resource");
        const prompt = resources[0];
        if (
            input.assetKind !== "Subagent" ||
            input.nativeDialectId !== ENCODED_DIALECT_ID ||
            input.targetCanonical.kind !== "Subagent" ||
            parsed === null ||
            entry?.contentKind !== "text" ||
            resources.length > 1 ||
            (prompt !== undefined && prompt.contentKind !== "text")
        ) {
            return null;
        }
        return {
            nativeText: nativeText({
                ...parsed,
                name: input.targetCanonical.typeData.name,
                description: input.targetCanonical.typeData.description,
                entry: entry.text,
                initialPrompt: prompt?.text ?? null,
            }),
        };
    },
};

function makeEncodedNativeDialectContract(): AdapterNativeDialectContractV1 {
    const definition = {
        kind: "Subagent" as const,
        dialectId: ENCODED_DIALECT_ID,
        nativeFileGraphSchema: componentRef("fixture.subagent.encoded-schema", "4"),
        contentNormalization: componentRef("fixture.subagent.encoded-normalization", "5"),
        nativeToCanonicalParser: ENCODED_PARSER_REF,
        canonicalConsistencyValidator: componentRef("fixture.subagent.encoded-consistency", "6"),
        rebaseMaterializer: ENCODED_REBASE_REF,
        targetApplicabilityPredicate: null,
    };
    return {
        definition,
        validateSameContent(input) {
            if (
                input.canonical.kind !== "Subagent" ||
                input.representation.dialectId !== ENCODED_DIALECT_ID ||
                input.nativeFiles.length !== 1 ||
                input.representation.files.length !== 1 ||
                input.canonicalFiles.length < 1 ||
                input.canonicalFiles.length > 2
            ) {
                return false;
            }
            const nativeFile = input.nativeFiles[0]!;
            const descriptor = input.representation.files[0]!;
            if (nativeFile.relativePath !== descriptor.relativePath || !encodedPathIsValid(nativeFile.relativePath)) return false;
            const stats = textPayloadStats(new TextDecoder("utf-8", { fatal: true }).decode(nativeFile.bytes));
            if (
                descriptor.contentKind !== "text" ||
                descriptor.mediaType !== "text/markdown" ||
                descriptor.executable ||
                descriptor.contentHash !== stats.contentHash ||
                descriptor.byteSize !== stats.byteSize
            ) {
                return false;
            }
            const parsed = parseNativeText(new TextDecoder("utf-8", { fatal: true }).decode(nativeFile.bytes));
            const entry = input.canonicalFiles.find((file) => file.file.role === "entry");
            const resources = input.canonicalFiles.filter((file) => file.file.role === "resource");
            const prompt = resources[0];
            return (
                parsed !== null &&
                parsed.name === input.canonical.typeData.name &&
                parsed.description === input.canonical.typeData.description &&
                entry?.contentKind === "text" &&
                parsed.entry === entry.text &&
                resources.length <= 1 &&
                (prompt === undefined
                    ? parsed.initialPrompt === null
                    : prompt.contentKind === "text" && parsed.initialPrompt === prompt.text)
            );
        },
    };
}

function makeEncodedDialectInput(
    canonicalContentFingerprint: Sha256Digest,
    contract: AdapterNativeDialectContractV1,
    text: string,
): RenderAnalysisInput["dialectInputs"][number] {
    const stats = textPayloadStats(text);
    const file = {
        relativePath: ENCODED_TARGET_PATH,
        contentKind: "text" as const,
        mediaType: "text/markdown",
        executable: false,
        ...stats,
        text,
    };
    const { text: _text, ...descriptor } = file;
    const preimage = {
        schemaVersion: 1 as const,
        dialectId: ENCODED_DIALECT_ID,
        dialectContractFingerprint: computeNativeDialectContractFingerprint(contract.definition),
        canonicalContentFingerprint,
        files: [descriptor],
    };
    const representation = {
        ...preimage,
        representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage),
    };
    const { files: _files, ...metadata } = representation;
    return {
        targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
        consumerAgentRuntimeIds: ["FIXTURE_CLI"],
        inputs: [{ inputKind: "native_representation", inputRole: "current_exact", representation: metadata, files: [file] }],
    };
}

function encodedSubagentCanonical(withPrompt: boolean): Extract<AssetKindTypeDataV2, { kind: "Subagent" }> {
    return {
        kind: "Subagent",
        typeData: {
            schemaVersion: 2,
            name: "reviewer",
            description: "Review changes",
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
                model: { mode: "inherit" },
                effort: { mode: "inherit" },
                sampling: {
                    temperature: { mode: "agent_runtime_default" },
                    topP: { mode: "agent_runtime_default" },
                },
            },
            directInvocation: withPrompt
                ? {
                      mode: "user_selectable",
                      initialPrompt: {
                          mode: "resource",
                          logicalPath: ENCODED_PROMPT_LOGICAL_PATH,
                          dialectId: "fixture-subagent-prompt-v1",
                      },
                  }
                : { mode: "delegated_only" },
            presentation: { listing: "agent_runtime_default", color: { mode: "agent_runtime_default" } },
        },
    };
}

function encodedCanonicalFiles(withPrompt: boolean, entryText = ENCODED_ENTRY_TEXT, promptText = ENCODED_PROMPT_TEXT) {
    const entry = makeTextFile(entryText, ENCODED_ENTRY_LOGICAL_PATH);
    entry.file.mediaType = "application/json";
    if (!withPrompt) return [entry];
    const prompt = makeTextFile(promptText, ENCODED_PROMPT_LOGICAL_PATH);
    prompt.file.fileId = ENCODED_PROMPT_FILE_ID;
    prompt.file.role = "resource";
    prompt.file.mediaType = "text/markdown";
    return [entry, prompt];
}

function encodedPathIsValid(relativePath: PosixRelativePath): boolean {
    return /^\.fixture\/agents\/[a-z0-9-]+\.md$/u.test(relativePath);
}

function nativeText(value: NativeEnvelope): string {
    return `${JSON.stringify(value)}\n`;
}

function parseNativeText(text: string): NativeEnvelope | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return Object.keys(record).sort().join("\0") ===
        ["description", "entry", "initialPrompt", "name", "privateLayout", "schemaVersion"].sort().join("\0") &&
        record.schemaVersion === 1 &&
        typeof record.name === "string" &&
        record.name.trim() !== "" &&
        typeof record.description === "string" &&
        record.description.trim() !== "" &&
        record.privateLayout === "keep-native-layout" &&
        typeof record.entry === "string" &&
        record.entry.trim() !== "" &&
        (record.initialPrompt === null || (typeof record.initialPrompt === "string" && record.initialPrompt.trim() !== ""))
        ? (record as unknown as NativeEnvelope)
        : null;
}

function componentRef(id: string, character: string) {
    return {
        componentId: id,
        componentVersion: 1,
        configFingerprint: `sha256:${character.repeat(64)}` as Sha256Digest,
    };
}
