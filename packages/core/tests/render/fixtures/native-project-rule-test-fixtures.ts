/** Deterministic Core fixtures for the native project-Rule contract. */

import type { AdapterProviderSummary } from "../../../src/contracts/source-import";
import type {
    CanonicalRenderSemanticValue,
    MaterializationSafeRenderSelection,
    RenderAnalysisInput,
    RenderDeploymentInput,
    RenderMaterializationInput,
} from "../../../src/contracts/render";
import type { AppliedRenderSnapshotV1 } from "../../../src/contracts/deployment-authority";
import type { RenderedTargetInspectionInput } from "../../../src/contracts/reverse";
import type { Sha256Digest } from "../../../src/types";
import {
    createNativeProjectRuleProviderSupport,
    createVerifiedNativeProjectRuleBuild,
    nativeProjectRuleRegistryComponents,
} from "../../../src/render/native-project-rule";
import { createRenderRegistry } from "../../../src/render/render-registry";
import {
    computeCanonicalRenderSemanticValueFingerprint,
    computeRenderInputFingerprint,
    computeTargetApplicabilityFingerprint,
} from "../../../src/foundation/fingerprint";
import { deriveRequiredRenderSemanticsV1 } from "../../../src/render/render-analysis";
import { textPayloadStats } from "../../../src/catalog/payload-store";
import { ASSET_ID, FILE_ID, PROJECT_ID, VERSION_ID, makeTextFile, makeVersionClosure } from "../../catalog/fixtures/version-v2";

export const RULE_HASH = `sha256:${"8".repeat(64)}` as Sha256Digest;
export const RULE_DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
export const RULE_PROFILE_ID = "fixture-cli-project-rule-v1";
export const RULE_OUTPUT_CONTRACT_ID = "FIXTURE_NATIVE_PROJECT_RULE_V1";
export const RULE_TEXT = "# Review TypeScript changes\n";

export function makeRuleFixture() {
    const descriptor = {
        agentRuntimeId: "FIXTURE_CLI",
        displayName: "Fixture CLI",
        entryClass: "cli" as const,
    };
    const build = createVerifiedNativeProjectRuleBuild({
        agentRuntimeId: descriptor.agentRuntimeId,
        versionText: "1.2.3",
        buildIdentity: `sha256:${"1".repeat(64)}`,
        platform: "wsl",
        materializationProfileId: RULE_PROFILE_ID,
        fixtureId: "fixture-cli-1.2.3-project-rule-2026-07-21",
        targetRelativeDirectory: ".fixture/rules",
        targetFileNameSuffix: ".md",
        fixtureRuleName: "typescript-review",
        exactLoadMarker: "OAAM_RULE_FIXTURE_MARKER",
        reverseFixtureId: "native-project-rule-whole-file-reverse-v1",
    });
    const support = createNativeProjectRuleProviderSupport({
        adapterId: "FIXTURE",
        adapterVersion: "0.1.0",
        agentRuntimes: [descriptor],
        agentRuntimeId: descriptor.agentRuntimeId,
        outputContractId: RULE_OUTPUT_CONTRACT_ID,
        materializationProfileId: RULE_PROFILE_ID,
        target: {
            relativeDirectory: ".fixture/rules",
            fileNameSuffix: ".md",
            targetContextSchemaId: "FIXTURE_CLI_PROJECT_TARGET_V1",
            requiredFacts: {
                "oaam.project-binding": "registered",
            },
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
        ],
    };
    const targetContext = {
        ...contextPreimage,
        targetApplicabilityFingerprint: computeTargetApplicabilityFingerprint({
            context: contextPreimage,
            entryClass: descriptor.entryClass,
        }),
    };
    const components = nativeProjectRuleRegistryComponents([provider]);
    const registry = createRenderRegistry({ providers: [provider], ...components });
    const canonical = {
        kind: "Rule" as const,
        typeData: {
            schemaVersion: 2 as const,
            name: "typescript-review",
            description: "",
            activation: { mode: "always" as const },
        },
    };
    const closure = makeVersionClosure({
        canonical,
        files: [makeTextFile(RULE_TEXT, "rule.md")],
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
        sectionHandles: { [FILE_ID]: "rule-entry" },
    };
    const deploymentPreimage = {
        schemaVersion: 1 as const,
        deploymentId: RULE_DEPLOYMENT_ID,
        consumerAgentRuntimeIds: [descriptor.agentRuntimeId],
        platform: "wsl" as const,
        platformInstanceId: "test-wsl",
        targetRootPath: "/tmp/oaam-native-rule-target",
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
        dialectInputs: [],
    };
    return {
        descriptor,
        build,
        support,
        provider,
        components,
        registry,
        targetContext,
        deployment,
        analysisInput,
        requiredSemantics,
    };
}

export function ruleMaterializationInput(fixture: ReturnType<typeof makeRuleFixture>): RenderMaterializationInput {
    const analysis = fixture.support.analyze(fixture.analysisInput);
    if (analysis.status !== "complete") throw new Error("Rule analysis fixture did not close");
    const profile = fixture.components.outputContracts[0]?.materializationProfiles.find(
        (candidate) => candidate.materializationProfileId === RULE_PROFILE_ID,
    );
    if (profile === undefined) throw new Error("Rule profile fixture missing");
    const selection: MaterializationSafeRenderSelection = {
        schemaVersion: 1,
        outputUnits: analysis.outputUnits,
        outputUnitRenderers: analysis.outputUnits.map((unit) => ({
            outputUnitFingerprint: unit.outputUnitFingerprint,
            rendererAdapterId: fixture.provider.adapterId,
            rendererAdapterVersion: fixture.provider.version,
            materializerCapabilityKey: fixture.support.materializerCapability.materializerCapabilityKey,
            materializationProfileId: RULE_PROFILE_ID,
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
        dialectInputs: [],
        selection,
    };
}

export function ruleCanonicalValues(fixture: ReturnType<typeof makeRuleFixture>): CanonicalRenderSemanticValue[] {
    const asset = fixture.analysisInput.deployment.assets[0]!;
    const file = asset.version.files[0]!;
    if (file.contentKind !== "text") throw new Error("Rule fixture must contain one text entry");
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
                : semantic.semanticKind === "rule.content"
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
                assetKind: "Rule",
                value: base,
            }),
        } as CanonicalRenderSemanticValue;
    });
}

export function changedRuleInspection(
    fixture: ReturnType<typeof makeRuleFixture>,
    materialization: RenderMaterializationInput,
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0]!;
    const currentText = "# Review TypeScript and tests\n";
    return {
        schemaVersion: 1,
        deploymentId: RULE_DEPLOYMENT_ID,
        appliedRenderSnapshot: {
            schemaVersion: 1,
            snapshotState: "applied",
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            compilerPolicyVersion: "core_render_policy_v1",
            selectionFingerprint: RULE_HASH,
            compilationFingerprint: RULE_HASH,
            decisions: fixture.requiredSemantics.map((semantic) => ({
                semanticRef: semantic,
                consumerOwnerAdapterId: fixture.provider.adapterId,
                consumerOwnerAdapterVersion: fixture.provider.version,
                optionFingerprint: RULE_HASH,
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
            inspectionScopeFingerprint: RULE_HASH,
            fileStates: [
                {
                    relativePath: unit.claims[0]!.relativePath,
                    state: "changed",
                    appliedContentHash: textPayloadStats(RULE_TEXT).contentHash,
                    currentContentHash: textPayloadStats(currentText).contentHash,
                    appliedExecutable: false,
                    currentExecutable: false,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    provenanceFingerprint: RULE_HASH,
                },
            ],
            directoryInventories: [],
        },
        files: [
            {
                fileState: "baseline_changed",
                relativePath: unit.claims[0]!.relativePath,
                appliedContent: { contentKind: "text", text: RULE_TEXT },
                currentContent: { contentKind: "text", text: currentText },
                diffHunks: [
                    {
                        hunkFingerprint: RULE_HASH,
                        appliedStartByte: 0,
                        appliedEndByte: Buffer.byteLength(RULE_TEXT),
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(currentText),
                    },
                ],
                attributeChanges: [],
                provenance: {
                    schemaVersion: 1,
                    appliedRenderSnapshotFingerprint: RULE_HASH,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    semanticRefFingerprints: fixture.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint),
                    sectionBindings: [],
                    materializationFingerprint: RULE_HASH,
                    provenanceFingerprint: RULE_HASH,
                },
            },
        ],
        inventoryDeltas: [],
    };
}

export function fullRuleAppliedSnapshot(
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
