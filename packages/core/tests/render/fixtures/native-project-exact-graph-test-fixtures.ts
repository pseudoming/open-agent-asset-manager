/** Deterministic Core fixtures for the project exact native file-graph contract. */

import { binaryPayloadStats, textPayloadStats } from "../../../src/catalog/payload-store";
import type { AppliedRenderSnapshotV1 } from "../../../src/contracts/deployment-authority";
import type {
    CanonicalRenderSemanticValue,
    MaterializationSafeRenderSelection,
    RenderAnalysisInput,
    RenderDeploymentInput,
    RenderMaterializationInput,
} from "../../../src/contracts/render";
import type { RenderedTargetInspectionInput } from "../../../src/contracts/reverse";
import type { AdapterTargetBuildCompatibilityPolicyV1 } from "../../../src/contracts/target-build-compatibility";
import {
    computeCanonicalRenderSemanticValueFingerprint,
    computeRenderInputFingerprint,
    computeTargetApplicabilityFingerprint,
} from "../../../src/foundation/fingerprint";
import type { NativeProjectExactGraphCanonicalMaterializer } from "../../../src/render/native-project-exact-graph";
import {
    createNativeGlobalExactGraphProviderSupport,
    createNativeProjectExactGraphProviderSupport,
    createVerifiedNativeGlobalExactGraphBuild,
    createVerifiedNativeProjectExactGraphBuild,
    nativeProjectExactGraphRegistryComponents,
} from "../../../src/render/native-project-exact-graph";
import { createRenderRegistry } from "../../../src/render/render-registry";
import { deriveRequiredRenderSemanticsV1 } from "../../../src/render/render-semantics";
import type { AdapterProvider, AdapterProviderSummary, PosixRelativePath, Sha256Digest } from "../../../src/types";
import {
    ASSET_ID,
    FILE_ID,
    makeBinaryFile,
    makeTextFile,
    makeVersionClosure,
    PROJECT_ID,
    VERSION_ID,
    VERSION_ID_2,
} from "../../catalog/fixtures/version-v2";
import {
    GRAPH_BINARY_RESOURCE,
    GRAPH_BINARY_RESOURCE_PATH,
    GRAPH_BOUNDARY,
    GRAPH_CANONICAL_REF,
    GRAPH_CHANGED_BINARY_RESOURCE,
    GRAPH_CHANGED_ENTRY_TEXT,
    GRAPH_CHANGED_NATIVE_ENTRY_TEXT,
    GRAPH_CHANGED_TEXT_RESOURCE,
    GRAPH_DIALECT_ID,
    GRAPH_ENTRY_PATH,
    GRAPH_ENTRY_TEXT,
    GRAPH_HASH,
    GRAPH_NATIVE_ENTRY_TEXT,
    GRAPH_OUTPUT_CONTRACT_ID,
    GRAPH_PARSER_REF,
    GRAPH_PROFILE_ID,
    GRAPH_REBASE_REF,
    GRAPH_REBASED_ENTRY_TEXT,
    GRAPH_REBASED_NATIVE_ENTRY_TEXT,
    GRAPH_TEXT_RESOURCE,
    GRAPH_TEXT_RESOURCE_PATH,
    GRAPH_VALIDATOR_REF,
    graphCanonicalMaterializer,
    graphRebaseMaterializer,
    graphSkillCanonical,
    makeGraphDialectInput,
    makeGraphNativeDialectContract,
    parseChangedGraphFile,
    projectFixtureGraph,
} from "./native-project-exact-graph-native-test-fixtures";

export {
    GRAPH_BINARY_RESOURCE,
    GRAPH_BINARY_RESOURCE_PATH,
    GRAPH_BOUNDARY,
    GRAPH_CANONICAL_REF,
    GRAPH_CHANGED_BINARY_RESOURCE,
    GRAPH_CHANGED_ENTRY_TEXT,
    GRAPH_CHANGED_NATIVE_ENTRY_TEXT,
    GRAPH_CHANGED_TEXT_RESOURCE,
    GRAPH_DIALECT_ID,
    GRAPH_ENTRY_PATH,
    GRAPH_ENTRY_TEXT,
    GRAPH_HASH,
    GRAPH_NATIVE_ENTRY_TEXT,
    GRAPH_OUTPUT_CONTRACT_ID,
    GRAPH_PARSER_REF,
    GRAPH_PROFILE_ID,
    GRAPH_REBASE_REF,
    GRAPH_REBASED_ENTRY_TEXT,
    GRAPH_REBASED_NATIVE_ENTRY_TEXT,
    GRAPH_TEXT_RESOURCE,
    GRAPH_TEXT_RESOURCE_PATH,
    GRAPH_VALIDATOR_REF,
    graphCanonicalMaterializer,
    graphSkillCanonical,
} from "./native-project-exact-graph-native-test-fixtures";

export const GRAPH_TEXT_FILE_ID = "11111111-2222-4333-8444-555555555555";
export const GRAPH_BINARY_FILE_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const GLOBAL_GRAPH_VALIDATOR_REF = { ...GRAPH_VALIDATOR_REF, componentId: "fixture.skill.global-graph" };

export function makeExactGraphFixture(
    options: {
        adapterVersion?: string;
        outputContractId?: string;
        materializationProfileId?: string;
        canonicalMaterializer?: NativeProjectExactGraphCanonicalMaterializer;
        canonical?: ReturnType<typeof graphSkillCanonical>;
        buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
        jsoncTopLevelPropertyPatch?: {
            propertyName: string;
            allowedContainerRelativePaths: readonly PosixRelativePath[];
        };
        nativeDirectories?: readonly PosixRelativePath[];
        targetRootPath?: string;
    } = {},
) {
    const descriptor = { agentRuntimeId: "FIXTURE_CLI", displayName: "Fixture CLI", entryClass: "cli" as const };
    const jsoncTopLevelPropertyPatch =
        options.jsoncTopLevelPropertyPatch === undefined
            ? undefined
            : {
                  propertyName: options.jsoncTopLevelPropertyPatch.propertyName,
                  allowedContainerRelativePaths: [...options.jsoncTopLevelPropertyPatch.allowedContainerRelativePaths],
              };
    const nativeDialect = makeGraphNativeDialectContract();
    const patchBytes =
        options.jsoncTopLevelPropertyPatch === undefined ? undefined : new TextEncoder().encode('["resources/marker.txt"]');
    const graphProjector = (files: Parameters<typeof projectFixtureGraph>[0]) => {
        const projected = projectFixtureGraph(files);
        if (projected === null || options.jsoncTopLevelPropertyPatch === undefined) return projected;
        return {
            ...projected,
            graphIdentityRelativePath: GRAPH_BINARY_RESOURCE_PATH,
            managedDirectoryBoundaries: [],
        };
    };
    const build = createVerifiedNativeProjectExactGraphBuild({
        agentRuntimeId: descriptor.agentRuntimeId,
        versionText: "1.2.3",
        buildIdentity: `sha256:${"3".repeat(64)}`,
        platform: "wsl",
        materializationProfileId: options.materializationProfileId ?? GRAPH_PROFILE_ID,
        fixtureId: "fixture-cli-1.2.3-project-skill-graph-2026-08-03",
        assetKind: "Skill",
        nativeDialectId: GRAPH_DIALECT_ID,
        projectGraphValidator: GRAPH_VALIDATOR_REF,
        reverseParser: GRAPH_PARSER_REF,
        rebaseMaterializer: GRAPH_REBASE_REF,
        ...(options.canonicalMaterializer === undefined
            ? {}
            : {
                  canonicalMaterialization: {
                      materializer: options.canonicalMaterializer.ref,
                      degradationKinds: options.canonicalMaterializer.degradationKinds,
                      ...(options.canonicalMaterializer.substituteAssetKind === undefined
                          ? {}
                          : { substituteAssetKind: options.canonicalMaterializer.substituteAssetKind }),
                      reasonCode: options.canonicalMaterializer.reasonCode,
                      ...(options.canonicalMaterializer.assessLoss === undefined ? {} : { assessesLoss: true as const }),
                      ...(options.canonicalMaterializer.preservationDialectIds === undefined
                          ? {}
                          : { preservationDialectIds: options.canonicalMaterializer.preservationDialectIds }),
                  },
              }),
        restorationDialectIds: [],
        ...(options.jsoncTopLevelPropertyPatch === undefined ? {} : { jsoncTopLevelPropertyPatch }),
        parentRebaseFixtureId: "fixture-cli-1.2.3-project-skill-graph-parent-rebase-v1",
        targetGraphIdentity: options.jsoncTopLevelPropertyPatch === undefined ? GRAPH_ENTRY_PATH : GRAPH_BINARY_RESOURCE_PATH,
        targetRelativePaths: [
            GRAPH_BINARY_RESOURCE_PATH,
            GRAPH_ENTRY_PATH,
            GRAPH_TEXT_RESOURCE_PATH,
        ].sort() as PosixRelativePath[],
        exactLoadMarker: "OAAM_SKILL_GRAPH_FIXTURE_MARKER",
        reverseFixtureId: "native-project-skill-graph-existing-files-reverse-v1",
    });
    const support = createNativeProjectExactGraphProviderSupport({
        adapterId: "FIXTURE",
        adapterVersion: options.adapterVersion ?? "0.1.0",
        agentRuntimes: [descriptor],
        agentRuntimeId: descriptor.agentRuntimeId,
        assetKind: "Skill",
        outputContractId: options.outputContractId ?? GRAPH_OUTPUT_CONTRACT_ID,
        materializationProfileId: options.materializationProfileId ?? GRAPH_PROFILE_ID,
        nativeDialectId: GRAPH_DIALECT_ID,
        projectGraphValidator: { ref: GRAPH_VALIDATOR_REF, project: graphProjector },
        reverseParser: { ref: GRAPH_PARSER_REF, parse: parseChangedGraphFile },
        rebaseMaterializer: graphRebaseMaterializer,
        ...(options.canonicalMaterializer === undefined ? {} : { canonicalMaterializer: options.canonicalMaterializer }),
        restorationDialectIds: [],
        ...(options.jsoncTopLevelPropertyPatch === undefined ? {} : { jsoncTopLevelPropertyPatch }),
        target: {
            targetContextSchemaId: "FIXTURE_CLI_PROJECT_TARGET_V1",
            requiredFacts: { "oaam.project-binding": "registered", "fixture.mode": "exact-graph" },
        },
        ...(options.buildCompatibility === undefined ? {} : { buildCompatibility: options.buildCompatibility }),
        verifiedBuilds: [build],
    });
    const provider: AdapterProviderSummary = {
        adapterId: "FIXTURE",
        displayName: "Fixture Provider",
        version: options.adapterVersion ?? "0.1.0",
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
            { key: "fixture.mode", value: "exact-graph", evidenceLevel: "agent_runtime_verified" as const },
        ],
    };
    const targetContext = {
        ...contextPreimage,
        targetApplicabilityFingerprint: computeTargetApplicabilityFingerprint({
            context: contextPreimage,
            entryClass: descriptor.entryClass,
        }),
    };
    const components = nativeProjectExactGraphRegistryComponents(
        [provider],
        new Map([[provider.adapterId, support.canonicalMaterializationValidators]]),
    );
    const registry = createRenderRegistry({ providers: [provider], ...components });
    const canonical = options.canonical ?? graphSkillCanonical();
    const closure = makeVersionClosure({
        canonical,
        files: makeGraphFiles(patchBytes === undefined ? {} : { binaryResource: patchBytes }),
    });
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
        sectionHandles: Object.fromEntries(closure.files.map((file) => [file.file.fileId, `skill-${file.file.logicalPath}`])),
    };
    const deploymentPreimage = {
        schemaVersion: 1 as const,
        deploymentId: "11111111-1111-4111-8111-111111111111",
        consumerAgentRuntimeIds: [descriptor.agentRuntimeId],
        platform: "wsl" as const,
        platformInstanceId: "test-wsl",
        targetRootPath: options.targetRootPath ?? "/tmp/oaam-native-exact-graph-target",
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
    const dialectInputs: RenderAnalysisInput["dialectInputs"] =
        options.canonicalMaterializer === undefined
            ? [
                  makeGraphDialectInput(closure.manifest.versionCanonicalContentFingerprint, nativeDialect, {
                      ...(patchBytes === undefined ? {} : { binaryResource: patchBytes }),
                      ...(options.nativeDirectories === undefined ? {} : { directories: options.nativeDirectories }),
                  }),
              ]
            : [
                  {
                      targetVersion: { assetId: ASSET_ID, versionId: VERSION_ID },
                      consumerAgentRuntimeIds: ["FIXTURE_CLI"],
                      inputs: [
                          {
                              inputKind: "canonical_materialization" as const,
                              nativeDialectId: GRAPH_DIALECT_ID,
                              materializer: structuredClone(options.canonicalMaterializer.ref),
                              degradationKinds: structuredClone(options.canonicalMaterializer.degradationKinds),
                              ...(options.canonicalMaterializer.substituteAssetKind === undefined
                                  ? {}
                                  : { substituteAssetKind: options.canonicalMaterializer.substituteAssetKind }),
                              reasonCode: options.canonicalMaterializer.reasonCode,
                          },
                      ],
                  },
              ];
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
        patchBytes,
        graphProjector,
    };
}

export function makeGlobalExactGraphFixture(
    options: { canonicalMaterializer?: NativeProjectExactGraphCanonicalMaterializer } = {},
) {
    const projectFixture = makeExactGraphFixture(options);
    const outputContractId = "FIXTURE_NATIVE_GLOBAL_SKILL_GRAPH_V1";
    const materializationProfileId = "fixture-cli-global-skill-graph-v1";
    const build = createVerifiedNativeGlobalExactGraphBuild({
        agentRuntimeId: projectFixture.descriptor.agentRuntimeId,
        versionText: "1.2.3",
        buildIdentity: `sha256:${"3".repeat(64)}`,
        platform: "wsl",
        materializationProfileId,
        fixtureId: "fixture-cli-1.2.3-global-skill-graph-2026-08-03",
        assetKind: "Skill",
        nativeDialectId: GRAPH_DIALECT_ID,
        globalGraphValidator: GLOBAL_GRAPH_VALIDATOR_REF,
        reverseParser: GRAPH_PARSER_REF,
        rebaseMaterializer: GRAPH_REBASE_REF,
        ...(projectFixture.support.renderContractDeclaration.canonicalMaterialization === undefined
            ? {}
            : { canonicalMaterialization: projectFixture.support.renderContractDeclaration.canonicalMaterialization }),
        restorationDialectIds: [],
        parentRebaseFixtureId: "fixture-cli-1.2.3-global-skill-graph-parent-rebase-v1",
        targetGraphIdentity: GRAPH_ENTRY_PATH,
        targetRelativePaths: [
            GRAPH_BINARY_RESOURCE_PATH,
            GRAPH_ENTRY_PATH,
            GRAPH_TEXT_RESOURCE_PATH,
        ].sort() as PosixRelativePath[],
        exactLoadMarker: "OAAM_GLOBAL_SKILL_GRAPH_FIXTURE_MARKER",
        reverseFixtureId: "native-global-skill-graph-existing-files-reverse-v1",
    });
    const support = createNativeGlobalExactGraphProviderSupport({
        adapterId: "FIXTURE",
        adapterVersion: "0.1.0",
        agentRuntimes: [projectFixture.descriptor],
        agentRuntimeId: projectFixture.descriptor.agentRuntimeId,
        assetKind: "Skill",
        outputContractId,
        materializationProfileId,
        nativeDialectId: GRAPH_DIALECT_ID,
        globalGraphValidator: { ref: GLOBAL_GRAPH_VALIDATOR_REF, validate: projectFixtureGraph },
        reverseParser: { ref: GRAPH_PARSER_REF, parse: parseChangedGraphFile },
        rebaseMaterializer: graphRebaseMaterializer,
        ...(options.canonicalMaterializer === undefined ? {} : { canonicalMaterializer: options.canonicalMaterializer }),
        restorationDialectIds: [],
        target: {
            targetContextSchemaId: "FIXTURE_CLI_GLOBAL_TARGET_V1",
            requiredFacts: { "fixture.mode": "exact-global-graph" },
        },
        verifiedBuilds: [build],
    });
    const provider: AdapterProviderSummary = {
        ...projectFixture.provider,
        targetContextSchemas: [support.targetContextSchema],
        assetTargetCapabilities: [support.targetCapability],
        materializerCapabilities: [support.materializerCapability],
        renderContractDeclarations: [support.renderContractDeclaration],
    };
    const contextPreimage = {
        schemaVersion: 1 as const,
        agentRuntimeId: projectFixture.descriptor.agentRuntimeId,
        versionText: build.versionText,
        buildIdentity: build.buildIdentity,
        targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
        targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
        renderFacts: [
            { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" as const },
            { key: "fixture.mode", value: "exact-global-graph", evidenceLevel: "agent_runtime_verified" as const },
        ],
    };
    const targetContext = {
        ...contextPreimage,
        targetApplicabilityFingerprint: computeTargetApplicabilityFingerprint({
            context: contextPreimage,
            entryClass: projectFixture.descriptor.entryClass,
        }),
    };
    const components = nativeProjectExactGraphRegistryComponents(
        [provider],
        new Map([[provider.adapterId, support.canonicalMaterializationValidators]]),
    );
    const registry = createRenderRegistry({ providers: [provider], ...components });
    const asset = structuredClone(projectFixture.deployment.assets[0]!);
    asset.scope = "global";
    asset.projectId = "";
    const deploymentPreimage = {
        schemaVersion: 1 as const,
        deploymentId: "22222222-2222-4222-8222-222222222222",
        consumerAgentRuntimeIds: [projectFixture.descriptor.agentRuntimeId],
        platform: "wsl" as const,
        platformInstanceId: "test-wsl",
        targetRootPath: "/tmp/oaam-native-global-exact-graph-target",
        projectId: "",
        targetContexts: [targetContext],
        renderRegistryFingerprint: registry.fingerprint,
        assets: [asset],
    };
    const deployment: RenderDeploymentInput = {
        ...deploymentPreimage,
        renderInputFingerprint: computeRenderInputFingerprint(deploymentPreimage),
    };
    const requiredSemantics = deriveRequiredRenderSemanticsV1(deployment);
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
        dialectInputs: structuredClone(projectFixture.analysisInput.dialectInputs),
    };
    return {
        ...projectFixture,
        build,
        support,
        provider,
        targetContext,
        components,
        registry,
        deployment,
        requiredSemantics,
        analysisInput,
    };
}

export type ExactGraphFixture = ReturnType<typeof makeExactGraphFixture> | ReturnType<typeof makeGlobalExactGraphFixture>;

export function makeParentGraphRebaseFixture() {
    const fixture = makeExactGraphFixture();
    const canonical = graphSkillCanonical();
    canonical.typeData.description = "Review foreign changes";
    const files = makeGraphFiles({
        entryText: GRAPH_REBASED_ENTRY_TEXT,
        textResource: GRAPH_CHANGED_TEXT_RESOURCE,
        textResourceExecutable: true,
    });
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
    const { renderInputFingerprint: _old, ...preimage } = fixture.deployment;
    fixture.deployment = {
        ...preimage,
        assets: [asset],
        renderInputFingerprint: computeRenderInputFingerprint({ ...preimage, assets: [asset] }),
    };
    fixture.requiredSemantics = deriveRequiredRenderSemanticsV1(fixture.deployment);
    const parent = fixture.analysisInput.dialectInputs[0]!.inputs[0]!;
    if (parent.inputKind !== "native_representation") throw new Error("graph parent native input is missing");
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

export function asExactGraphProvider(fixture: ExactGraphFixture): AdapterProvider {
    return {
        ...structuredClone(fixture.provider),
        canonicalMaterializationValidators: fixture.support.canonicalMaterializationValidators,
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

export function exactGraphMaterializationInput(fixture: ExactGraphFixture): RenderMaterializationInput {
    const analysis = fixture.support.analyze(fixture.analysisInput);
    if (analysis.status !== "complete") throw new Error("exact-graph analysis fixture did not close");
    const profile = fixture.components.outputContracts[0]?.materializationProfiles[0];
    if (profile === undefined) throw new Error("exact-graph profile fixture is missing");
    const selection: MaterializationSafeRenderSelection = {
        schemaVersion: 1,
        outputUnits: analysis.outputUnits,
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
            ...(option.outcome === "degraded"
                ? { outcome: "degraded" as const, degradationFingerprint: option.degradationFingerprint }
                : { outcome: "preserved" as const }),
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

export function exactGraphCanonicalValues(fixture: ExactGraphFixture): CanonicalRenderSemanticValue[] {
    const asset = fixture.analysisInput.deployment.assets[0]!;
    return fixture.requiredSemantics.map((semantic): CanonicalRenderSemanticValue => {
        const subject = semantic.subject;
        const file =
            subject.subjectKind === "file" ? asset.version.files.find((item) => item.file.fileId === subject.fileId) : undefined;
        const value =
            semantic.semanticKind === "asset.file_inventory"
                ? {
                      semanticRefFingerprint: semantic.semanticRefFingerprint,
                      valueKind: "file_inventory" as const,
                      value: asset.version.files.map((item) => ({
                          fileId: item.file.fileId,
                          logicalPath: item.file.logicalPath,
                          role: item.file.role,
                          contentKind: item.file.contentKind,
                          contentHash: item.file.contentHash,
                          executable: item.file.executable,
                      })),
                  }
                : file !== undefined
                  ? {
                        semanticRefFingerprint: semantic.semanticRefFingerprint,
                        valueKind: "file_content" as const,
                        value:
                            file.contentKind === "text"
                                ? { contentKind: "text" as const, text: file.text }
                                : { contentKind: "binary" as const, bytes: new Uint8Array(file.bytes) },
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
                assetKind: "Skill",
                value,
            }),
        } as CanonicalRenderSemanticValue;
    });
}

export function changedExactGraphInspection(
    fixture: ExactGraphFixture,
    materialization: RenderMaterializationInput,
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0]!;
    const changedFiles = [
        changedTextFile(
            fixture,
            unit.outputUnitFingerprint,
            GRAPH_ENTRY_PATH,
            GRAPH_NATIVE_ENTRY_TEXT,
            GRAPH_CHANGED_NATIVE_ENTRY_TEXT,
        ),
        changedTextFile(
            fixture,
            unit.outputUnitFingerprint,
            GRAPH_TEXT_RESOURCE_PATH,
            GRAPH_TEXT_RESOURCE,
            GRAPH_CHANGED_TEXT_RESOURCE,
            true,
        ),
        changedBinaryFile(fixture, unit.outputUnitFingerprint),
    ];
    return {
        schemaVersion: 1,
        deploymentId: fixture.deployment.deploymentId,
        appliedRenderSnapshot: {
            schemaVersion: 1,
            snapshotState: "applied",
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            compilerPolicyVersion: "core_render_policy_v1",
            selectionFingerprint: GRAPH_HASH,
            compilationFingerprint: GRAPH_HASH,
            decisions: fixture.requiredSemantics.map((semantic) => ({
                semanticRef: semantic,
                consumerOwnerAdapterId: fixture.provider.adapterId,
                consumerOwnerAdapterVersion: fixture.provider.version,
                optionFingerprint: GRAPH_HASH,
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
            inspectionScopeFingerprint: GRAPH_HASH,
            fileStates: changedFiles.map((file) => ({
                relativePath: file.relativePath,
                state: "changed" as const,
                appliedContentHash: contentHash(file.appliedContent),
                currentContentHash: contentHash(file.currentContent),
                appliedExecutable: false,
                currentExecutable: file.attributeChanges[0]?.currentValue ?? false,
                outputUnitFingerprint: unit.outputUnitFingerprint,
                provenanceFingerprint: GRAPH_HASH,
            })),
            directoryInventories: [
                {
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    boundary: { relativePath: GRAPH_BOUNDARY, boundaryKind: "directory_inventory" },
                    currentDescendantPaths: [GRAPH_BINARY_RESOURCE_PATH, GRAPH_ENTRY_PATH, GRAPH_TEXT_RESOURCE_PATH].sort(),
                },
            ],
        },
        files: changedFiles,
        inventoryDeltas: [],
    };
}

export function fullExactGraphAppliedSnapshot(
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

export function makeGraphFiles(
    options: { entryText?: string; textResource?: string; textResourceExecutable?: boolean; binaryResource?: Uint8Array } = {},
) {
    const entry = makeTextFile(options.entryText ?? GRAPH_ENTRY_TEXT, "SKILL.md");
    const text = makeTextFile(options.textResource ?? GRAPH_TEXT_RESOURCE, "resources/marker.txt");
    text.file.fileId = GRAPH_TEXT_FILE_ID;
    text.file.role = "resource";
    text.file.mediaType = "text/plain";
    text.file.executable = options.textResourceExecutable ?? false;
    const binary = makeBinaryFile(new Uint8Array(options.binaryResource ?? GRAPH_BINARY_RESOURCE), "resources/tool.bin");
    binary.file.fileId = GRAPH_BINARY_FILE_ID;
    return [entry, text, binary];
}

function changedTextFile(
    fixture: ExactGraphFixture,
    outputUnitFingerprint: Sha256Digest,
    relativePath: PosixRelativePath,
    appliedText: string,
    currentText: string,
    executable = false,
) {
    const logicalPath = relativePath.slice(GRAPH_BOUNDARY.length + 1);
    const canonical = fixture.closure.files.find((file) => file.file.logicalPath === logicalPath);
    const semanticRefs = fixture.requiredSemantics
        .filter(
            (semantic) =>
                semantic.subject.subjectKind === "asset" ||
                (semantic.subject.subjectKind === "file" && semantic.subject.fileId === canonical?.file.fileId),
        )
        .map((semantic) => semantic.semanticRefFingerprint);
    return {
        fileState: "baseline_changed" as const,
        relativePath,
        appliedContent: { contentKind: "text" as const, text: appliedText },
        currentContent: { contentKind: "text" as const, text: currentText },
        diffHunks: [
            {
                hunkFingerprint: digest(relativePath === GRAPH_ENTRY_PATH ? "7" : "8"),
                appliedStartByte: 0,
                appliedEndByte: Buffer.byteLength(appliedText),
                currentStartByte: 0,
                currentEndByte: Buffer.byteLength(currentText),
            },
        ],
        attributeChanges: executable
            ? [
                  {
                      attributeChangeFingerprint: digest("a"),
                      attributeKind: "executable" as const,
                      appliedValue: false,
                      currentValue: true,
                  },
              ]
            : [],
        provenance: {
            schemaVersion: 1 as const,
            appliedRenderSnapshotFingerprint: GRAPH_HASH,
            outputUnitFingerprint,
            semanticRefFingerprints: semanticRefs,
            sectionBindings: [],
            materializationFingerprint: GRAPH_HASH,
            provenanceFingerprint: GRAPH_HASH,
        },
    };
}

function changedBinaryFile(fixture: ExactGraphFixture, outputUnitFingerprint: Sha256Digest) {
    const semanticRefs = fixture.requiredSemantics
        .filter(
            (semantic) =>
                semantic.subject.subjectKind === "asset" ||
                (semantic.subject.subjectKind === "file" && semantic.subject.fileId === GRAPH_BINARY_FILE_ID),
        )
        .map((semantic) => semantic.semanticRefFingerprint);
    return {
        fileState: "baseline_changed" as const,
        relativePath: GRAPH_BINARY_RESOURCE_PATH,
        appliedContent: { contentKind: "binary" as const, bytes: new Uint8Array(GRAPH_BINARY_RESOURCE) },
        currentContent: { contentKind: "binary" as const, bytes: new Uint8Array(GRAPH_CHANGED_BINARY_RESOURCE) },
        diffHunks: [
            {
                hunkFingerprint: digest("9"),
                appliedStartByte: 0,
                appliedEndByte: GRAPH_BINARY_RESOURCE.length,
                currentStartByte: 0,
                currentEndByte: GRAPH_CHANGED_BINARY_RESOURCE.length,
            },
        ],
        attributeChanges: [],
        provenance: {
            schemaVersion: 1 as const,
            appliedRenderSnapshotFingerprint: GRAPH_HASH,
            outputUnitFingerprint,
            semanticRefFingerprints: semanticRefs,
            sectionBindings: [],
            materializationFingerprint: GRAPH_HASH,
            provenanceFingerprint: GRAPH_HASH,
        },
    };
}

function contentHash(content: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array }) {
    return content.contentKind === "text"
        ? textPayloadStats(content.text).contentHash
        : binaryPayloadStats(content.bytes).contentHash;
}

function digest(character: string) {
    return `sha256:${character.repeat(64)}` as Sha256Digest;
}
