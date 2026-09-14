import type { AdapterId, AgentRuntimeId, EpochMillis, FileRole, PosixRelativePath, Sha256Digest, UuidV4 } from "./primitives";
import type { PromotionGrantTarget } from "./persistence";
import type {
    MaterializationProfileId,
    MaterializerCapabilityKey,
    OutputContractFingerprint,
    OutputContractId,
} from "./source-import";

export type RenderSemanticKind =
    | "asset.file_inventory"
    | "guidance.base_context"
    | "guidance.content"
    | "rule.activation"
    | "rule.content"
    | "workflow.activation"
    | "workflow.content"
    | "workflow.reference"
    | "skill.discovery_metadata"
    | "skill.body"
    | "skill.resource"
    | "subagent.delegation_metadata"
    | "subagent.invoked_context"
    | "subagent.resource"
    | "subagent.tool_boundary"
    | "subagent.model_hint"
    | "memory.support"
    | "memory.content";

export type RenderSemanticSubject =
    | { subjectKind: "asset"; assetId: UuidV4; versionId: UuidV4 }
    | {
          subjectKind: "file";
          assetId: UuidV4;
          versionId: UuidV4;
          fileId: UuidV4;
      }
    | {
          subjectKind: "missing_required_file_role";
          assetId: UuidV4;
          versionId: UuidV4;
          fileRole: Extract<FileRole, "entry">;
      };

export interface RequiredRenderSemantic {
    semanticRefFingerprint: Sha256Digest;
    consumerAgentRuntimeId: AgentRuntimeId;
    subject: RenderSemanticSubject;
    semanticKind: RenderSemanticKind;
}

export type RenderStrategy =
    | "native_file"
    | "native_directory"
    | "native_graph"
    | "native_import"
    | "inline"
    | "reference_with_intro";

export type RenderDegradationKind =
    | "target_runtime_missing_asset_kind"
    | "trigger_or_loading_level_lost"
    | "workflow_trigger_lost"
    | "workflow_permission_lost"
    | "workflow_runtime_lost"
    | "workflow_variable_lost"
    | "permission_or_tool_boundary_lost"
    | "folder_asset_flattened"
    | "memory_semantics_lost"
    | "runtime_specific_metadata_lost"
    | "reverse_extract_pollution_risk";

export type ActualReverseExtractPolicy = "can_reconcile" | "ignore_generated_wrapper" | "unsupported";

export type RenderOutcomeDetailsV1 =
    | { outcome: "preserved" }
    | {
          outcome: "degraded";
          degradationKinds: [RenderDegradationKind, ...RenderDegradationKind[]];
          degradationFingerprint: Sha256Digest;
      };

export type AppliedRenderApprovalEvidence =
    | {
          approvalState: "approved";
          approvalSource: "one_time_user_approval";
          userActionEvidenceId: string;
          resolvedAt: EpochMillis;
          approvalFingerprint: Sha256Digest;
      }
    | {
          approvalState: "approved";
          approvalSource: "saved_user_policy";
          policyId: string;
          policyRevision: number;
          resolvedAt: EpochMillis;
          approvalFingerprint: Sha256Digest;
      };

export interface RenderOutputClaim {
    relativePath: PosixRelativePath;
    contentKind: "text" | "binary";
    executable: boolean;
}

export type RenderManagedDirectoryBoundary =
    | {
          relativePath: PosixRelativePath;
          boundaryKind: "directory_inventory";
      }
    | {
          /** Exact desired directory graph carried by a Version-native V2 envelope. */
          schemaVersion: 2;
          relativePath: PosixRelativePath;
          boundaryKind: "directory_inventory";
          desiredDirectoryPaths: PosixRelativePath[];
      };

export interface RenderOutputUnit {
    outputUnitFingerprint: Sha256Digest;
    outputContractId: OutputContractId;
    outputContractFingerprint: OutputContractFingerprint;
    claims: RenderOutputClaim[];
    managedDirectoryBoundaries: RenderManagedDirectoryBoundary[];
}

export interface MaterializationSemanticCoverageProof {
    outputUnitFingerprint: Sha256Digest;
    coveredSemanticRefFingerprints: Sha256Digest[];
    coverageFingerprint: Sha256Digest;
}

export interface SelectedOutputUnitRenderer {
    outputUnitFingerprint: Sha256Digest;
    rendererAdapterId: AdapterId;
    rendererAdapterVersion: string;
    materializerCapabilityKey: MaterializerCapabilityKey;
    materializationProfileId: MaterializationProfileId;
    profileConstraintFingerprint: Sha256Digest;
}

export type ResolvedPromotionAuthorization =
    | {
          promotionAuthorizationState: "not_required";
          assetId: UuidV4;
          versionId: UuidV4;
          target: PromotionGrantTarget;
          versionOriginAuthorityFingerprint: Sha256Digest;
      }
    | {
          promotionAuthorizationState: "authorized";
          assetId: UuidV4;
          versionId: UuidV4;
          target: PromotionGrantTarget;
          versionOriginAuthorityFingerprint: Sha256Digest;
          authorizationSource: "version_target_grant" | "asset_all_versions_target_grant" | "restricted_source_full_access";
          authorityId: string;
          authorityRevision: number;
          authorityFingerprint: Sha256Digest;
      };

/**
 * Fresh, read-only promotion authority observed for one exact Deployment Asset.
 *
 * This is deliberately separate from ResolvedPromotionAuthorization: required
 * and unavailable observations can explain the next user action, but they are
 * never accepted by render selection or persisted as applied authority.
 */
export type PromotionAuthorizationInspection =
    | ResolvedPromotionAuthorization
    | {
          promotionAuthorizationState: "required";
          assetId: UuidV4;
          versionId: UuidV4;
          target: PromotionGrantTarget;
          versionOriginAuthorityFingerprint: Sha256Digest;
      }
    | {
          promotionAuthorizationState: "unavailable";
          assetId: UuidV4;
          versionId: UuidV4;
          target: PromotionGrantTarget;
          diagnosticCode: string;
      };

export interface AppliedRenderDecisionBaseV1 {
    semanticRef: RequiredRenderSemantic;
    consumerOwnerAdapterId: AdapterId;
    consumerOwnerAdapterVersion: string;
    optionFingerprint: Sha256Digest;
    renderStrategy: RenderStrategy;
    approval: AppliedRenderApprovalEvidence | { approvalState: "not_required" };
    actualReverseExtractPolicy: ActualReverseExtractPolicy;
    outputUnitFingerprints: Sha256Digest[];
}

export type AppliedRenderDecisionV1 = AppliedRenderDecisionBaseV1 & RenderOutcomeDetailsV1;

export type AppliedRenderSnapshotV1 =
    | { schemaVersion: 1; snapshotState: "never" }
    | {
          schemaVersion: 1;
          snapshotState: "applied";
          renderInputFingerprint: Sha256Digest;
          compilerPolicyVersion: "core_render_policy_v1";
          selectionFingerprint: Sha256Digest;
          compilationFingerprint: Sha256Digest;
          promotionAuthorizations: ResolvedPromotionAuthorization[];
          decisions: AppliedRenderDecisionV1[];
          outputUnits: RenderOutputUnit[];
          outputUnitRenderers: SelectedOutputUnitRenderer[];
          semanticCoverageProofs: MaterializationSemanticCoverageProof[];
      };

export interface RenderedSectionBinding {
    sectionHandle: string;
    semanticRefFingerprints: Sha256Digest[];
}

export interface DurableAppliedPayloadRefV1 {
    contentKind: "text" | "binary";
    contentHash: Sha256Digest;
    byteSize: number;
}

export interface TargetFileRenderProvenanceV1 {
    schemaVersion: 1;
    provenanceFingerprint: Sha256Digest;
    appliedRenderSnapshotFingerprint: Sha256Digest;
    outputUnitFingerprint: Sha256Digest;
    materializationFingerprint: Sha256Digest;
    semanticRefFingerprints: Sha256Digest[];
    sectionBindings: RenderedSectionBinding[];
}

export interface DeploymentResidualRenderAuthorityV1 {
    schemaVersion: 1;
    residualAuthorityId: string;
    residualAuthorityFingerprint: Sha256Digest;
    deploymentId: UuidV4;
    relativePath: PosixRelativePath;
    appliedPayload: DurableAppliedPayloadRefV1;
    appliedExecutable: boolean;
    previousProvenance: TargetFileRenderProvenanceV1;
    removalIntentFingerprint: Sha256Digest;
}

export type DeploymentResidualAuthorityBodyV1 = Omit<
    DeploymentResidualRenderAuthorityV1,
    "residualAuthorityId" | "residualAuthorityFingerprint" | "deploymentId" | "relativePath"
>;

export type AppliedRenderSnapshotRefV1 =
    | { snapshotState: "never" }
    | { snapshotState: "applied"; snapshotFingerprint: Sha256Digest };

export type DeploymentFileBaselineStateV1 =
    | {
          rowState: "active";
          appliedPayload: DurableAppliedPayloadRefV1;
          appliedExecutable: boolean;
          provenance: TargetFileRenderProvenanceV1;
      }
    | {
          rowState: "removed";
          latestResidualAuthorityId: string;
      };

export type DeploymentFileObservationV1 =
    | {
          observedState: "present";
          observedContentHash: Sha256Digest;
          observedExecutable: boolean;
      }
    | { observedState: "missing" };

export interface DeploymentFileAuthorityProjectionInputV1 {
    deploymentFileId: string;
    relativePath: PosixRelativePath;
    baselineState: DeploymentFileBaselineStateV1;
    observation: DeploymentFileObservationV1;
    observedAt: EpochMillis;
    createdAt: EpochMillis;
    updatedAt: EpochMillis;
}

export type DeploymentFileAuthorityProjectionV1 = {
    deploymentFileId: string;
    relativePath: PosixRelativePath;
    observedAt: EpochMillis;
    createdAt: EpochMillis;
    updatedAt: EpochMillis;
} & (
    | {
          rowState: "active";
          appliedPayload: DurableAppliedPayloadRefV1;
          appliedExecutable: boolean;
          provenance: TargetFileRenderProvenanceV1;
          observation: DeploymentFileObservationV1;
      }
    | {
          rowState: "removed";
          latestResidualAuthorityId: string;
          observation: { observedState: "missing" };
      }
);

export interface RemovalIntentFingerprintInputV1 {
    deploymentId: UuidV4;
    relativePath: PosixRelativePath;
    previousProvenanceFingerprint: Sha256Digest;
    nextCompilationFingerprint: Sha256Digest;
    reason: "absent_from_new_desired_set";
}
