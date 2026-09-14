/** Shared deterministic fixtures for the split render authority tests. */

import type { AdapterProviderSummary } from "../../../src/contracts/source-import";
import type {
    CanonicalRenderSemanticValue,
    MaterializationSafeRenderSelection,
    RenderAnalysisInput,
    RenderDeploymentInput,
    RenderMaterializationInput,
} from "../../../src/contracts/render";
import type { RenderedTargetInspectionInput } from "../../../src/contracts/reverse";
import type { AppliedRenderSnapshotV1 } from "../../../src/contracts/deployment-authority";
import type { Sha256Digest } from "../../../src/types";
import {
    createNativeProjectGuidanceProviderSupport,
    createVerifiedNativeProjectGuidanceBuild,
    makeVerifiedNativeProjectGuidanceTargetContextForTest,
    nativeProjectGuidanceRegistryComponents,
} from "../../../src/render/native-project-guidance";
import { createRenderRegistry } from "../../../src/render/render-registry";
import {
    computeCanonicalRenderSemanticValueFingerprint,
    computeRenderInputFingerprint,
} from "../../../src/foundation/fingerprint";
import { deriveRequiredRenderSemanticsV1 } from "../../../src/render/render-analysis";
import { textPayloadStats } from "../../../src/catalog/payload-store";
import { ASSET_ID, FILE_ID, PROJECT_ID, VERSION_ID, makeTextFile, makeVersionClosure } from "../../catalog/fixtures/version-v2";

export const HASH = `sha256:${"9".repeat(64)}` as Sha256Digest;

export const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
export const CLAUDE_CODE_CLI_PROJECT_GUIDANCE_PROFILE = "claude-code-cli-project-guidance-v1";
export const ANTIGRAVITY_CLI_PROJECT_GUIDANCE_PROFILE = "antigravity-cli-project-guidance-v1";
export const CLAUDE_CODE_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID = "CLAUDECODE_NATIVE_PROJECT_GUIDANCE_V1";
export const ANTIGRAVITY_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID = "ANTIGRAVITY_NATIVE_PROJECT_GUIDANCE_V1";

export type RuntimeFixtureKind = "claude" | "antigravity";

export function makeFixture(
    kind: RuntimeFixtureKind,
    generation: { adapterVersion: string; outputSuffix: string } = { adapterVersion: "0.3.0", outputSuffix: "" },
) {
    const adapterId = kind === "claude" ? "CLAUDECODE" : "ANTIGRAVITY";
    const agentRuntimeId = kind === "claude" ? "CLAUDE_CODE_CLI" : "ANTIGRAVITY_CLI";
    const profile =
        (kind === "claude" ? CLAUDE_CODE_CLI_PROJECT_GUIDANCE_PROFILE : ANTIGRAVITY_CLI_PROJECT_GUIDANCE_PROFILE) +
        generation.outputSuffix;
    const descriptor = {
        agentRuntimeId,
        displayName: `${agentRuntimeId} fixture`,
        entryClass: "cli" as const,
    };
    const build = createVerifiedNativeProjectGuidanceBuild({
        agentRuntimeId,
        versionText: kind === "claude" ? "2.1.191" : "1.1.2",
        buildIdentity:
            kind === "claude"
                ? "sha256:1038dba88bdf1b80941dc3e383e93b088325b00497329ac50da460c8786d5bee"
                : "sha256:70bf6eaf2e82fbb243db999b9c7c61fcf7f6e537f41980650eb2341ed84b24de",
        platform: "wsl",
        materializationProfileId: profile,
        fixtureId:
            kind === "claude"
                ? "claude-code-cli-2.1.191-wsl-project-claude-md-2026-07-14"
                : "antigravity-cli-1.1.2-wsl-registered-project-agents-md-2026-07-14",
        targetRelativePath: kind === "claude" ? "CLAUDE.md" : "AGENTS.md",
        exactLoadMarker: kind === "claude" ? "OAAM_CC_21191_CLAUDE_ONLY_B7F24D" : "OAAM_AGY_112_AGENTS_ONLY_7C91E4",
        reverseFixtureId: "native-project-guidance-whole-file-reverse-v1",
    });
    const support = createNativeProjectGuidanceProviderSupport({
        adapterId,
        adapterVersion: generation.adapterVersion,
        agentRuntimes: [descriptor],
        agentRuntimeId,
        outputContractId: (kind === "claude"
            ? CLAUDE_CODE_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID
            : ANTIGRAVITY_PROJECT_GUIDANCE_OUTPUT_CONTRACT_ID
        ).replace("_V1", generation.outputSuffix.toUpperCase().replaceAll("-", "_") + "_V1"),
        materializationProfileId: profile,
        target:
            kind === "claude"
                ? {
                      relativePath: "CLAUDE.md",
                      targetContextSchemaId: "CLAUDE_CODE_CLI_PROJECT_GUIDANCE_TARGET_V1",
                      requiredFacts: {},
                  }
                : {
                      relativePath: "AGENTS.md",
                      targetContextSchemaId: "ANTIGRAVITY_CLI_PROJECT_GUIDANCE_TARGET_V1",
                      requiredFacts: { "oaam.project-binding": "registered" },
                  },
        verifiedBuilds: [build],
    });
    const provider: AdapterProviderSummary = {
        adapterId,
        displayName: `${adapterId} fixture`,
        version: generation.adapterVersion,
        enabled: true,
        agentRuntimes: [descriptor],
        targetContextSchemas: [support.targetContextSchema],
        assetSourceCapabilities: [],
        assetTargetCapabilities: [support.targetCapability],
        materializerCapabilities: [support.materializerCapability],
        renderContractDeclarations: [support.renderContractDeclaration],
    };
    const targetContext = makeVerifiedNativeProjectGuidanceTargetContextForTest({
        provider,
        build,
    });
    const components = nativeProjectGuidanceRegistryComponents([provider]);
    const registry = createRenderRegistry({ providers: [provider], ...components });
    const closure = makeVersionClosure({ files: [makeTextFile("# Project guidance\n")] });
    const asset: RenderDeploymentInput["assets"][number] = {
        scope: "project" as const,
        projectId: PROJECT_ID,
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId: ASSET_ID, versionId: VERSION_ID },
            versionFingerprint: closure.manifest.fingerprint,
            versionCanonicalContentFingerprint: closure.manifest.versionCanonicalContentFingerprint,
            status: closure.manifest.status,
            canonical: { kind: "Guidance", typeData: { schemaVersion: 1 } },
            files: closure.files,
        },
        sectionHandles: { [FILE_ID]: "project-guidance-entry" },
    };
    const deploymentPreimage = {
        schemaVersion: 1 as const,
        deploymentId: DEPLOYMENT_ID,
        consumerAgentRuntimeIds: [agentRuntimeId],
        platform: "wsl" as const,
        platformInstanceId: "test-wsl",
        targetRootPath: "/tmp/oaam-native-guidance-target",
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
        kind,
        adapterId,
        agentRuntimeId,
        profile,
        descriptor,
        support,
        provider,
        components,
        registry,
        build,
        targetContext,
        deployment,
        analysisInput,
        requiredSemantics,
    };
}

export function materializationInput(fixture: ReturnType<typeof makeFixture>): RenderMaterializationInput {
    const analysis = fixture.support.analyze(fixture.analysisInput);
    if (analysis.status !== "complete") throw new Error("analysis fixture did not close");
    const profile = fixture.components.outputContracts[0]?.materializationProfiles.find(
        (item) => item.materializationProfileId === fixture.profile,
    );
    if (profile === undefined) throw new Error("profile fixture missing");
    const selection: MaterializationSafeRenderSelection = {
        schemaVersion: 1,
        outputUnits: analysis.outputUnits,
        outputUnitRenderers: analysis.outputUnits.map((unit) => ({
            outputUnitFingerprint: unit.outputUnitFingerprint,
            rendererAdapterId: fixture.provider.adapterId,
            rendererAdapterVersion: fixture.provider.version,
            materializerCapabilityKey: fixture.support.materializerCapability.materializerCapabilityKey,
            materializationProfileId: fixture.profile,
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

export function canonicalValues(fixture: ReturnType<typeof makeFixture>): CanonicalRenderSemanticValue[] {
    const file = fixture.analysisInput.deployment.assets[0]!.version.files[0]!;
    if (file.contentKind !== "text") {
        throw new Error("project Guidance fixture must contain one text entry");
    }
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
                : semantic.semanticKind === "guidance.content"
                  ? {
                        semanticRefFingerprint: semantic.semanticRefFingerprint,
                        valueKind: "file_content" as const,
                        value: { contentKind: "text" as const, text: file.text },
                    }
                  : {
                        semanticRefFingerprint: semantic.semanticRefFingerprint,
                        valueKind: "asset_type_data" as const,
                        value: {
                            kind: "Guidance" as const,
                            typeData: { schemaVersion: 1 as const },
                        },
                    };
        return {
            ...base,
            canonicalValueFingerprint: computeCanonicalRenderSemanticValueFingerprint({
                semantic,
                assetKind: "Guidance",
                value: base,
            }),
        } as CanonicalRenderSemanticValue;
    });
}

export function changedInspection(
    fixture: ReturnType<typeof makeFixture>,
    materialization: RenderMaterializationInput,
): RenderedTargetInspectionInput {
    const unit = materialization.selection.outputUnits[0]!;
    const currentText = "# User-edited project guidance\n";
    const contentDecision = fixture.requiredSemantics.find((semantic) => semantic.semanticKind === "guidance.content")!;
    return {
        schemaVersion: 1,
        deploymentId: DEPLOYMENT_ID,
        appliedRenderSnapshot: {
            schemaVersion: 1,
            snapshotState: "applied",
            renderInputFingerprint: fixture.deployment.renderInputFingerprint,
            compilerPolicyVersion: "core_render_policy_v1",
            selectionFingerprint: HASH,
            compilationFingerprint: HASH,
            decisions: fixture.requiredSemantics.map((semantic) => ({
                semanticRef: semantic,
                consumerOwnerAdapterId: fixture.provider.adapterId,
                consumerOwnerAdapterVersion: fixture.provider.version,
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
                    relativePath: unit.claims[0]!.relativePath,
                    state: "changed",
                    appliedContentHash: textPayloadStats("# Project guidance\n").contentHash,
                    currentContentHash: textPayloadStats(currentText).contentHash,
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
                relativePath: unit.claims[0]!.relativePath,
                appliedContent: { contentKind: "text", text: "# Project guidance\n" },
                currentContent: { contentKind: "text", text: currentText },
                diffHunks: [
                    {
                        hunkFingerprint: HASH,
                        appliedStartByte: 0,
                        appliedEndByte: 19,
                        currentStartByte: 0,
                        currentEndByte: Buffer.byteLength(currentText),
                    },
                ],
                attributeChanges: [],
                provenance: {
                    schemaVersion: 1,
                    appliedRenderSnapshotFingerprint: HASH,
                    outputUnitFingerprint: unit.outputUnitFingerprint,
                    semanticRefFingerprints: fixture.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint),
                    sectionBindings: [],
                    materializationFingerprint: HASH,
                    provenanceFingerprint: HASH,
                },
            },
        ],
        inventoryDeltas: [],
    };
}

export function fullAppliedSnapshot(
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
