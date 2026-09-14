/** Render, materialization, inspection, and deployment-authority fingerprints. */
import type { AppliedInputsSnapshotV1 } from "../types";
import type {
    AppliedRenderSnapshotV1,
    DeploymentResidualRenderAuthorityV1,
    RenderOutcomeDetailsV1,
    RemovalIntentFingerprintInputV1,
    RenderOutputUnit,
    RequiredRenderSemantic,
    ResolvedPromotionAuthorization,
    SelectedOutputUnitRenderer,
    TargetFileRenderProvenanceV1,
} from "../contracts/deployment-authority";
import type { AdapterProviderSummary, AgentRuntimeEntryClass } from "../contracts/source-import";
import type {
    AnalysisApprovalRequirement,
    CanonicalRenderSemanticValue,
    ConsumerOutputContractConformanceV1,
    MaterializedRenderFile,
    RenderNativeRepresentationFileInput,
    MaterializationSafeRenderSelection,
    OutputContractDefinitionV1,
    ProviderRenderDialectInputsForAsset,
    RenderDeploymentInput,
    ResolvedSelectedSemanticOption,
    SemanticRenderOption,
    TargetAgentRuntimeRenderContext,
    VersionedContractComponentRef,
} from "../contracts/render";
import type { DeploymentRenderPreviewFingerprintInput } from "../contracts/render-preview";
import type { AgentRuntimeId, AssetKind, Platform, Sha256Digest, UuidV4 } from "../contracts/primitives";
import { sha256Bytes } from "./crypto-bytes";
import { compareCodeUnitText, fingerprintDomain, stableStringify } from "./fingerprint-base";

const APPLIED_RENDER_SNAPSHOT_DOMAIN = "oaam.render.applied-render-snapshot.v1";
const FILE_PROVENANCE_DOMAIN = "oaam.render.file-provenance.v1";
const RESIDUAL_AUTHORITY_ID_DOMAIN = "oaam.render.residual-authority-id.v1";
const RESIDUAL_AUTHORITY_DOMAIN = "oaam.render.residual-authority.v1";
const REMOVAL_INTENT_DOMAIN = "oaam.render.removal-intent.v1";
const SEMANTIC_REF_DOMAIN = "oaam.render.semantic-ref.v1";
const OUTPUT_UNIT_DOMAIN = "oaam.render.output-unit.v1";
const APPLIED_INPUTS_SNAPSHOT_DOMAIN = "oaam.render.applied-inputs-snapshot.v1";
const TARGET_APPLICABILITY_DOMAIN = "oaam.render.target-applicability.v1";
const GLOBAL_PROMOTION_TARGET_DOMAIN = "oaam.promotion.global-target-authority.v1";
const OUTPUT_CONTRACT_DOMAIN = "oaam.render.output-contract.v1";
const MATERIALIZATION_PROFILE_DOMAIN = "oaam.render.materialization-profile.v1";
const CONSUMER_CONFORMANCE_DOMAIN = "oaam.render.consumer-conformance.v1";
const RENDER_REGISTRY_DOMAIN = "oaam.render.registry.v1";
const PROVIDER_DIALECT_INPUT_DOMAIN = "oaam.render.provider-dialect-input.v1";
const RENDER_INPUT_DOMAIN = "oaam.render.input.v1";
const DEPLOYMENT_AUTHORITY_DOMAIN = "oaam.render.deployment-authority.v1";
const RENDER_DEGRADATION_DOMAIN = "oaam.render.degradation.v1";
const RENDER_APPROVAL_DOMAIN = "oaam.render.approval.v1";
const RENDER_OPTION_DOMAIN = "oaam.render.option.v1";
const RENDER_SELECTION_DOMAIN = "oaam.render.selection.v1";
const RENDER_OBSERVATION_SELECTION_DOMAIN = "oaam.render.observation-selection.v1";
const CANONICAL_SEMANTIC_VALUE_DOMAIN = "oaam.render.canonical-semantic-value.v1";
const MATERIALIZATION_DOMAIN = "oaam.render.materialization.v1";
const SEMANTIC_COVERAGE_DOMAIN = "oaam.render.semantic-coverage.v1";
const COMPILATION_DOMAIN = "oaam.render.compilation.v1";
const DEPLOYMENT_RENDER_PREVIEW_DOMAIN = "oaam.render.target-replacement-preview.v2";

export function computeDeploymentRenderPreviewFingerprint(input: DeploymentRenderPreviewFingerprintInput): Sha256Digest {
    return fingerprintDomain(DEPLOYMENT_RENDER_PREVIEW_DOMAIN, input);
}

type SemanticRenderOptionFingerprintPreimage = SemanticRenderOption extends infer T
    ? T extends SemanticRenderOption
        ? Omit<T, "optionFingerprint" | "diagnostics">
        : never
    : never;

type CanonicalRenderSemanticValuePreimage = CanonicalRenderSemanticValue extends infer T
    ? T extends CanonicalRenderSemanticValue
        ? Omit<T, "canonicalValueFingerprint">
        : never
    : never;

/**
 * Bind the durable Deployment state that a reverse preparation observed to the
 * fresh provider registry/render input used for that preparation. This is not
 * a second Deployment authority: every field is projected from the current DB
 * authority or the fresh render operation and is re-projected at commit time.
 */
export function computeDeploymentAuthorityFingerprint(input: {
    deploymentId: UuidV4;
    deleted: boolean;
    platform: Platform;
    platformInstanceId: string;
    targetRootPath: string;
    projectId: string;
    consumerAgentRuntimeIds: AgentRuntimeId[];
    deploymentAssets: {
        assetId: UuidV4;
        versionId: UuidV4;
        sortOrder: number;
        allowIncomplete: boolean;
        deleted: boolean;
    }[];
    appliedCompilationFingerprint: Sha256Digest;
    committedTransactionId: UuidV4 | "";
    renderRegistryFingerprint: Sha256Digest;
    freshRenderInputFingerprint: Sha256Digest;
}): Sha256Digest {
    return fingerprintDomain(DEPLOYMENT_AUTHORITY_DOMAIN, {
        deploymentId: input.deploymentId,
        deleted: input.deleted,
        platform: input.platform,
        platformInstanceId: input.platformInstanceId,
        targetRootPath: input.targetRootPath,
        projectId: input.projectId,
        consumerAgentRuntimeIds: [...input.consumerAgentRuntimeIds].sort(compareCodeUnitText),
        deploymentAssets: [...input.deploymentAssets].sort(
            (left, right) =>
                left.sortOrder - right.sortOrder ||
                compareCodeUnitText(`${left.assetId}\0${left.versionId}`, `${right.assetId}\0${right.versionId}`),
        ),
        appliedCompilationFingerprint: input.appliedCompilationFingerprint,
        committedTransactionId: input.committedTransactionId,
        renderRegistryFingerprint: input.renderRegistryFingerprint,
        freshRenderInputFingerprint: input.freshRenderInputFingerprint,
    });
}

export function computeAppliedRenderSnapshotFingerprint(snapshot: AppliedRenderSnapshotV1): Sha256Digest {
    return fingerprintDomain(APPLIED_RENDER_SNAPSHOT_DOMAIN, snapshot);
}

export function computeTargetFileRenderProvenanceFingerprint(
    provenance: Omit<TargetFileRenderProvenanceV1, "provenanceFingerprint">,
): Sha256Digest {
    return fingerprintDomain(FILE_PROVENANCE_DOMAIN, provenance);
}

export function computeDeploymentResidualAuthorityId(
    residual: Omit<DeploymentResidualRenderAuthorityV1, "residualAuthorityId" | "residualAuthorityFingerprint">,
): Sha256Digest {
    return fingerprintDomain(RESIDUAL_AUTHORITY_ID_DOMAIN, residual);
}

export function computeDeploymentResidualAuthorityFingerprint(
    residual: Omit<DeploymentResidualRenderAuthorityV1, "residualAuthorityFingerprint">,
): Sha256Digest {
    return fingerprintDomain(RESIDUAL_AUTHORITY_DOMAIN, residual);
}

export function computeRemovalIntentFingerprint(intent: RemovalIntentFingerprintInputV1): Sha256Digest {
    return fingerprintDomain(REMOVAL_INTENT_DOMAIN, intent);
}

export function computeSemanticRefFingerprint(semantic: Omit<RequiredRenderSemantic, "semanticRefFingerprint">): Sha256Digest {
    return fingerprintDomain(SEMANTIC_REF_DOMAIN, semantic);
}

export function computeRenderOutputUnitFingerprint(outputUnit: Omit<RenderOutputUnit, "outputUnitFingerprint">): Sha256Digest {
    return fingerprintDomain(OUTPUT_UNIT_DOMAIN, {
        outputContractId: outputUnit.outputContractId,
        outputContractFingerprint: outputUnit.outputContractFingerprint,
        claims: [...outputUnit.claims].sort((left, right) => compareCodeUnitText(left.relativePath, right.relativePath)),
        managedDirectoryBoundaries: [...outputUnit.managedDirectoryBoundaries].sort((left, right) =>
            compareCodeUnitText(left.relativePath, right.relativePath),
        ),
    });
}

export function computeTargetApplicabilityFingerprint(input: {
    context: Omit<TargetAgentRuntimeRenderContext, "targetApplicabilityFingerprint">;
    entryClass: AgentRuntimeEntryClass;
}): Sha256Digest {
    return fingerprintDomain(TARGET_APPLICABILITY_DOMAIN, {
        schemaVersion: input.context.schemaVersion,
        agentRuntimeId: input.context.agentRuntimeId,
        entryClass: input.entryClass,
        versionText: input.context.versionText,
        buildIdentity: input.context.buildIdentity,
        targetContextSchemaId: input.context.targetContextSchemaId,
        targetContextSchemaFingerprint: input.context.targetContextSchemaFingerprint,
        renderFacts: [...input.context.renderFacts].sort((left, right) => compareCodeUnitText(left.key, right.key)),
    });
}

export function computeGlobalPromotionTargetAuthorityFingerprint(input: {
    platform: Platform;
    platformInstanceId: string;
    targetRootPath: string;
    consumerAgentRuntimeIds: readonly string[];
}): Sha256Digest {
    return fingerprintDomain(GLOBAL_PROMOTION_TARGET_DOMAIN, {
        platform: input.platform,
        platformInstanceId: input.platformInstanceId,
        targetRootPath: input.targetRootPath,
        consumerAgentRuntimeIds: [...input.consumerAgentRuntimeIds].sort(compareCodeUnitText),
    });
}

export function computeOutputContractFingerprint(
    definition: Omit<OutputContractDefinitionV1, "outputContractFingerprint">,
): Sha256Digest {
    return fingerprintDomain(OUTPUT_CONTRACT_DOMAIN, {
        outputContractId: definition.outputContractId,
        pathAndFileGrammar: definition.pathAndFileGrammar,
        markerAndSectionGrammar: definition.markerAndSectionGrammar,
        generatedWrapperGrammar: definition.generatedWrapperGrammar,
        materializationValidator: definition.materializationValidator,
        reverseInspectionValidator: definition.reverseInspectionValidator,
        materializationProfiles: [...definition.materializationProfiles]
            .sort((left, right) => compareCodeUnitText(left.materializationProfileId, right.materializationProfileId))
            .map((profile) => ({
                materializationProfileId: profile.materializationProfileId,
                constraintValidator: profile.constraintValidator,
            })),
    });
}

export function computeMaterializationProfileConstraintFingerprint(input: {
    outputContractFingerprint: Sha256Digest;
    materializationProfileId: string;
    constraintValidator: VersionedContractComponentRef;
}): Sha256Digest {
    return fingerprintDomain(MATERIALIZATION_PROFILE_DOMAIN, input);
}

export function computeConsumerConformanceFingerprint(input: {
    conformance: Omit<ConsumerOutputContractConformanceV1, "conformanceFingerprint">;
    entryClass: AgentRuntimeEntryClass;
}): Sha256Digest {
    return fingerprintDomain(CONSUMER_CONFORMANCE_DOMAIN, {
        ...input.conformance,
        entryClass: input.entryClass,
    });
}

export function computeRenderRegistryFingerprint(input: {
    providers: readonly AdapterProviderSummary[];
    outputContracts: readonly OutputContractDefinitionV1[];
    consumerConformances: readonly ConsumerOutputContractConformanceV1[];
}): Sha256Digest {
    return fingerprintDomain(RENDER_REGISTRY_DOMAIN, {
        providers: [...input.providers]
            .sort((left, right) => compareCodeUnitText(left.adapterId, right.adapterId))
            .map((provider) => ({
                adapterId: provider.adapterId,
                version: provider.version,
                agentRuntimeOwners: [...provider.agentRuntimes]
                    .sort((left, right) => compareCodeUnitText(left.agentRuntimeId, right.agentRuntimeId))
                    .map((runtime) => ({
                        agentRuntimeId: runtime.agentRuntimeId,
                        entryClass: runtime.entryClass,
                    })),
                targetContextSchemas: [...provider.targetContextSchemas]
                    .sort((left, right) => compareCodeUnitText(left.targetContextSchemaId, right.targetContextSchemaId))
                    .map(({ diagnostics: _diagnostics, ...schema }) => ({
                        ...schema,
                        factRules: [...schema.factRules].sort((left, right) => compareCodeUnitText(left.key, right.key)),
                    })),
                targetCapabilities: [...provider.assetTargetCapabilities]
                    .map(({ diagnostics: _diagnostics, ...capability }) => capability)
                    .sort((left, right) => compareCodeUnitText(stableStringify(left), stableStringify(right))),
                materializerCapabilities: [...provider.materializerCapabilities]
                    .sort((left, right) => compareCodeUnitText(left.materializerCapabilityKey, right.materializerCapabilityKey))
                    .map(({ diagnostics: _diagnostics, ...capability }) => ({
                        ...capability,
                        materializationProfileIds: [...capability.materializationProfileIds].sort(compareCodeUnitText),
                    })),
            })),
        outputContracts: [...input.outputContracts].sort((left, right) =>
            compareCodeUnitText(left.outputContractId, right.outputContractId),
        ),
        consumerConformanceFingerprints: [...input.consumerConformances]
            .map((item) => item.conformanceFingerprint)
            .sort(compareCodeUnitText),
    });
}

export function computeProviderRenderDialectInputFingerprint(input: {
    adapterId: string;
    adapterVersion: string;
    dialectInputs: readonly ProviderRenderDialectInputsForAsset[];
}): Sha256Digest {
    return fingerprintDomain(PROVIDER_DIALECT_INPUT_DOMAIN, {
        adapterId: input.adapterId,
        adapterVersion: input.adapterVersion,
        dialectInputs: [...input.dialectInputs]
            .sort((left, right) =>
                compareCodeUnitText(
                    `${left.targetVersion.assetId}\0${left.targetVersion.versionId}\0${left.consumerAgentRuntimeIds.join("\0")}`,
                    `${right.targetVersion.assetId}\0${right.targetVersion.versionId}\0${right.consumerAgentRuntimeIds.join("\0")}`,
                ),
            )
            .map((group) => ({
                targetVersion: group.targetVersion,
                consumerAgentRuntimeIds: [...group.consumerAgentRuntimeIds],
                inputs: [...group.inputs]
                    .map((item) => {
                        if (item.inputKind === "dialect_restoration") {
                            return {
                                inputKind: item.inputKind,
                                restoration: item.restoration,
                                content: renderContentReceipt(item.content),
                            };
                        }
                        if (item.inputKind === "canonical_materialization") {
                            return {
                                inputKind: item.inputKind,
                                nativeDialectId: item.nativeDialectId,
                                materializer: item.materializer,
                                degradationKinds: [...item.degradationKinds].sort(compareCodeUnitText),
                                ...(item.substituteAssetKind === undefined
                                    ? {}
                                    : { substituteAssetKind: item.substituteAssetKind }),
                                reasonCode: item.reasonCode,
                                ...(item.nativePreservationSeed === undefined
                                    ? {}
                                    : {
                                          nativePreservationSeed: {
                                              representation: item.nativePreservationSeed.representation,
                                              files: nativeRepresentationFilesReceipt(item.nativePreservationSeed.files),
                                          },
                                      }),
                                ...(item.logicalDirectoryPaths === undefined
                                    ? {}
                                    : {
                                          logicalDirectoryPaths: [...item.logicalDirectoryPaths],
                                      }),
                            };
                        }
                        return {
                            inputKind: item.inputKind,
                            inputRole: item.inputRole,
                            ...(item.inputRole === "parent_rebase_seed" ? { sourceVersion: item.sourceVersion } : {}),
                            representation: item.representation,
                            files: nativeRepresentationFilesReceipt(item.files),
                        };
                    })
                    .sort((left, right) => compareCodeUnitText(stableStringify(left), stableStringify(right))),
            })),
    });
}

function nativeRepresentationFilesReceipt(files: readonly RenderNativeRepresentationFileInput[]) {
    return [...files]
        .sort((left, right) => compareCodeUnitText(left.relativePath, right.relativePath))
        .map((file) => ({
            relativePath: file.relativePath,
            contentKind: file.contentKind,
            mediaType: file.mediaType,
            contentHash: file.contentKind === "text" ? sha256Bytes(Buffer.from(file.text, "utf-8")) : sha256Bytes(file.bytes),
            byteSize: file.contentKind === "text" ? Buffer.byteLength(file.text, "utf-8") : file.bytes.byteLength,
            executable: file.executable,
        }));
}

export function computeRenderInputFingerprint(input: Omit<RenderDeploymentInput, "renderInputFingerprint">): Sha256Digest {
    return fingerprintDomain(RENDER_INPUT_DOMAIN, {
        schemaVersion: input.schemaVersion,
        deploymentId: input.deploymentId,
        consumerAgentRuntimeIds: [...input.consumerAgentRuntimeIds].sort(compareCodeUnitText),
        platform: input.platform,
        platformInstanceId: input.platformInstanceId,
        targetRootPath: input.targetRootPath,
        projectId: input.projectId,
        targetContexts: [...input.targetContexts]
            .sort((left, right) => compareCodeUnitText(left.agentRuntimeId, right.agentRuntimeId))
            .map((context) => ({
                ...context,
                renderFacts: [...context.renderFacts].sort((left, right) => compareCodeUnitText(left.key, right.key)),
            })),
        renderRegistryFingerprint: input.renderRegistryFingerprint,
        assets: input.assets.map((asset) => ({
            scope: asset.scope,
            projectId: asset.projectId,
            scopePath: asset.scopePath,
            allowIncomplete: asset.allowIncomplete,
            version: {
                ref: asset.version.ref,
                versionFingerprint: asset.version.versionFingerprint,
                versionCanonicalContentFingerprint: asset.version.versionCanonicalContentFingerprint,
                status: asset.version.status,
                canonical: asset.version.canonical,
                files: asset.version.files.map((file) => ({
                    file: {
                        ...file.file,
                        references: file.file.references.map(({ diagnostics: _diagnostics, ...reference }) => reference),
                    },
                    content: renderContentReceipt(file),
                })),
            },
            sectionHandles: asset.sectionHandles,
        })),
    });
}

export function computeRenderDegradationFingerprint(input: {
    adapterId: string;
    adapterVersion: string;
    renderInputFingerprint: Sha256Digest;
    semanticRefFingerprint: Sha256Digest;
    renderStrategy: string;
    outcome: Extract<RenderOutcomeDetailsV1, { outcome: "degraded" }>;
    actualReverseExtractPolicy: string;
    reasonCode: string;
}): Sha256Digest {
    return fingerprintDomain(RENDER_DEGRADATION_DOMAIN, {
        adapterId: input.adapterId,
        adapterVersion: input.adapterVersion,
        renderInputFingerprint: input.renderInputFingerprint,
        semanticRefFingerprint: input.semanticRefFingerprint,
        renderStrategy: input.renderStrategy,
        degradationKinds: [...input.outcome.degradationKinds].sort(compareCodeUnitText),
        actualReverseExtractPolicy: input.actualReverseExtractPolicy,
        reasonCode: input.reasonCode,
    });
}

export function computeRenderApprovalFingerprint(input: {
    renderInputFingerprint: Sha256Digest;
    semanticRefFingerprint: Sha256Digest;
    renderStrategy: string;
    outcome: RenderOutcomeDetailsV1;
    actualReverseExtractPolicy: string;
    concerns: readonly string[];
}): Sha256Digest {
    return fingerprintDomain(RENDER_APPROVAL_DOMAIN, {
        renderInputFingerprint: input.renderInputFingerprint,
        semanticRefFingerprint: input.semanticRefFingerprint,
        renderStrategy: input.renderStrategy,
        outcome:
            input.outcome.outcome === "preserved"
                ? input.outcome
                : {
                      ...input.outcome,
                      degradationKinds: [...input.outcome.degradationKinds].sort(compareCodeUnitText),
                  },
        actualReverseExtractPolicy: input.actualReverseExtractPolicy,
        concerns: [...input.concerns].sort(compareCodeUnitText),
    });
}

export function computeRenderOptionFingerprint(input: {
    adapterId: string;
    adapterVersion: string;
    renderInputFingerprint: Sha256Digest;
    providerRenderDialectInputFingerprint: Sha256Digest;
    option: SemanticRenderOptionFingerprintPreimage;
}): Sha256Digest {
    return fingerprintDomain(RENDER_OPTION_DOMAIN, {
        adapterId: input.adapterId,
        adapterVersion: input.adapterVersion,
        renderInputFingerprint: input.renderInputFingerprint,
        providerRenderDialectInputFingerprint: input.providerRenderDialectInputFingerprint,
        semanticRefFingerprint: input.option.semanticRefFingerprint,
        renderStrategy: input.option.renderStrategy,
        outcome:
            input.option.outcome === "preserved"
                ? { outcome: "preserved" }
                : {
                      outcome: "degraded",
                      degradationKinds: [...input.option.degradationKinds].sort(compareCodeUnitText),
                      degradationFingerprint: input.option.degradationFingerprint,
                  },
        actualReverseExtractPolicy: input.option.actualReverseExtractPolicy,
        approvalRequirement: canonicalApprovalRequirement(input.option.approvalRequirement),
        requiredOutputUnitFingerprints: [...input.option.requiredOutputUnitFingerprints].sort(compareCodeUnitText),
        ...(input.option.substituteAssetKind === undefined ? {} : { substituteAssetKind: input.option.substituteAssetKind }),
        reasonCode: input.option.reasonCode,
    });
}

export function computeRenderSelectionFingerprint(input: {
    compilerPolicyVersion: "core_render_policy_v1";
    renderInputFingerprint: Sha256Digest;
    semanticOptions: readonly ResolvedSelectedSemanticOption[];
    outputUnits: readonly RenderOutputUnit[];
    outputUnitRenderers: readonly SelectedOutputUnitRenderer[];
    promotionAuthorizations: readonly ResolvedPromotionAuthorization[];
}): Sha256Digest {
    return fingerprintDomain(RENDER_SELECTION_DOMAIN, {
        compilerPolicyVersion: input.compilerPolicyVersion,
        renderInputFingerprint: input.renderInputFingerprint,
        semanticOptions: [...input.semanticOptions].sort((left, right) =>
            compareCodeUnitText(left.semanticRefFingerprint, right.semanticRefFingerprint),
        ),
        outputUnits: [...input.outputUnits].sort((left, right) =>
            compareCodeUnitText(left.outputUnitFingerprint, right.outputUnitFingerprint),
        ),
        outputUnitRenderers: [...input.outputUnitRenderers].sort((left, right) =>
            compareCodeUnitText(left.outputUnitFingerprint, right.outputUnitFingerprint),
        ),
        promotionAuthorizations: [...input.promotionAuthorizations].sort((left, right) =>
            compareCodeUnitText(
                `${left.assetId}\0${left.versionId}\0${stableStringify(left.target)}`,
                `${right.assetId}\0${right.versionId}\0${stableStringify(right.target)}`,
            ),
        ),
    });
}

/** Operation-local read-only selection identity. It carries no approval or promotion authority. */
export function computeRenderObservationSelectionFingerprint(input: {
    renderInputFingerprint: Sha256Digest;
    selection: MaterializationSafeRenderSelection;
}): Sha256Digest {
    return fingerprintDomain(RENDER_OBSERVATION_SELECTION_DOMAIN, {
        renderInputFingerprint: input.renderInputFingerprint,
        semanticOptions: [...input.selection.semanticOptions].sort((left, right) =>
            compareCodeUnitText(left.semanticRefFingerprint, right.semanticRefFingerprint),
        ),
        outputUnits: [...input.selection.outputUnits].sort((left, right) =>
            compareCodeUnitText(left.outputUnitFingerprint, right.outputUnitFingerprint),
        ),
        outputUnitRenderers: [...input.selection.outputUnitRenderers].sort((left, right) =>
            compareCodeUnitText(left.outputUnitFingerprint, right.outputUnitFingerprint),
        ),
    });
}

export function computeCanonicalRenderSemanticValueFingerprint(input: {
    semantic: RequiredRenderSemantic;
    assetKind: AssetKind;
    value: CanonicalRenderSemanticValuePreimage;
}): Sha256Digest {
    return fingerprintDomain(CANONICAL_SEMANTIC_VALUE_DOMAIN, {
        semanticRefFingerprint: input.semantic.semanticRefFingerprint,
        assetKind: input.assetKind,
        semanticKind: input.semantic.semanticKind,
        subject: input.semantic.subject,
        valueKind: input.value.valueKind,
        value: canonicalSemanticValuePayload(input.value),
    });
}

export function computeMaterializationFingerprint(input: {
    rendererAdapterId: string;
    rendererAdapterVersion: string;
    renderInputFingerprint: Sha256Digest;
    selectionFingerprint: Sha256Digest;
    outputUnitFingerprint: Sha256Digest;
    materializerCapabilityKey: string;
    materializationProfileId: string;
    profileConstraintFingerprint: Sha256Digest;
    providerRenderDialectInputFingerprint: Sha256Digest;
    files: readonly MaterializedRenderFile[];
}): Sha256Digest {
    return fingerprintDomain(MATERIALIZATION_DOMAIN, {
        ...input,
        files: canonicalMaterializedFiles(input.files),
    });
}

export function computeSemanticCoverageFingerprint(input: {
    outputContractFingerprint: Sha256Digest;
    profileConstraintFingerprint: Sha256Digest;
    outputUnitFingerprint: Sha256Digest;
    canonicalValues: readonly CanonicalRenderSemanticValue[];
    files: readonly MaterializedRenderFile[];
    coveredSemanticRefFingerprints: readonly Sha256Digest[];
}): Sha256Digest {
    return fingerprintDomain(SEMANTIC_COVERAGE_DOMAIN, {
        outputContractFingerprint: input.outputContractFingerprint,
        profileConstraintFingerprint: input.profileConstraintFingerprint,
        outputUnitFingerprint: input.outputUnitFingerprint,
        canonicalValueFingerprints: input.canonicalValues
            .map((value) => value.canonicalValueFingerprint)
            .sort(compareCodeUnitText),
        files: canonicalMaterializedFiles(input.files),
        coveredSemanticRefFingerprints: [...input.coveredSemanticRefFingerprints].sort(compareCodeUnitText),
    });
}

export function computeCompilationFingerprint(input: {
    deploymentId: string;
    renderInputFingerprint: Sha256Digest;
    selectionFingerprint: Sha256Digest;
    units: readonly {
        outputUnitFingerprint: Sha256Digest;
        materializationFingerprint: Sha256Digest;
        semanticCoverageFingerprint: Sha256Digest;
    }[];
    files: readonly {
        relativePath: string;
        content: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
        executable: boolean;
        outputUnitFingerprint: Sha256Digest;
        materializationFingerprint: Sha256Digest;
        semanticRefFingerprints: readonly Sha256Digest[];
        sectionBindings: readonly {
            sectionHandle: string;
            semanticRefFingerprints: readonly Sha256Digest[];
        }[];
    }[];
}): Sha256Digest {
    return fingerprintDomain(COMPILATION_DOMAIN, {
        deploymentId: input.deploymentId,
        renderInputFingerprint: input.renderInputFingerprint,
        selectionFingerprint: input.selectionFingerprint,
        units: [...input.units].sort((left, right) =>
            compareCodeUnitText(left.outputUnitFingerprint, right.outputUnitFingerprint),
        ),
        files: [...input.files]
            .sort((left, right) => compareCodeUnitText(left.relativePath, right.relativePath))
            .map((file) => ({
                relativePath: file.relativePath,
                ...renderContentReceipt(file.content),
                executable: file.executable,
                outputUnitFingerprint: file.outputUnitFingerprint,
                materializationFingerprint: file.materializationFingerprint,
                semanticRefFingerprints: [...file.semanticRefFingerprints].sort(compareCodeUnitText),
                sectionBindings: canonicalSectionBindings(file.sectionBindings),
            })),
    });
}

export function computeAppliedInputsSnapshotFingerprint(snapshot: AppliedInputsSnapshotV1): Sha256Digest {
    return fingerprintDomain(APPLIED_INPUTS_SNAPSHOT_DOMAIN, snapshot);
}

function canonicalApprovalRequirement(requirement: AnalysisApprovalRequirement): AnalysisApprovalRequirement {
    return requirement.approvalState === "not_required"
        ? requirement
        : {
              ...requirement,
              concerns: [...requirement.concerns].sort(compareCodeUnitText) as typeof requirement.concerns,
          };
}

function canonicalSemanticValuePayload(value: CanonicalRenderSemanticValuePreimage): unknown {
    if (value.valueKind === "file_inventory") {
        return [...value.value].sort((left, right) =>
            compareCodeUnitText(`${left.logicalPath}\0${left.fileId}`, `${right.logicalPath}\0${right.fileId}`),
        );
    }
    if (value.valueKind === "file_content") return renderContentReceipt(value.value);
    return value.value;
}

function canonicalMaterializedFiles(files: readonly MaterializedRenderFile[]): unknown[] {
    return [...files]
        .sort((left, right) => compareCodeUnitText(left.relativePath, right.relativePath))
        .map((file) => ({
            relativePath: file.relativePath,
            ...renderContentReceipt(file.content),
            executable: file.executable,
            semanticRefFingerprints: [...file.semanticRefFingerprints].sort(compareCodeUnitText),
            sectionBindings: canonicalSectionBindings(file.sectionBindings),
        }));
}

function canonicalSectionBindings(
    bindings: readonly {
        sectionHandle: string;
        semanticRefFingerprints: readonly Sha256Digest[];
    }[],
): unknown[] {
    return [...bindings]
        .sort((left, right) => compareCodeUnitText(left.sectionHandle, right.sectionHandle))
        .map((binding) => ({
            sectionHandle: binding.sectionHandle,
            semanticRefFingerprints: [...binding.semanticRefFingerprints].sort(compareCodeUnitText),
        }));
}

function renderContentReceipt(content: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array }): {
    contentKind: "text" | "binary";
    contentHash: Sha256Digest;
    byteSize: number;
} {
    if (content.contentKind === "text") {
        return {
            contentKind: "text",
            contentHash: sha256Bytes(Buffer.from(content.text, "utf-8")),
            byteSize: Buffer.byteLength(content.text, "utf-8"),
        };
    }
    return {
        contentKind: "binary",
        contentHash: sha256Bytes(content.bytes),
        byteSize: content.bytes.byteLength,
    };
}
