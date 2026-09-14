/** Deployment database authority proof and postcondition shapes. */

import type {
    DeploymentFileAuthorityProjectionV1,
    DeploymentResidualRenderAuthorityV1,
    DurableAppliedPayloadRefV1,
    TargetFileRenderProvenanceV1,
} from "../contracts/deployment-authority";
import type { AgentRuntimeId, EpochMillis, Platform, PosixRelativePath, Sha256Digest, UuidV4 } from "../contracts/primitives";
import type { DeploymentBlockingEvidenceV1, ObservationState } from "../types";
import type { DeploymentCommitReceiptV1 } from "./deployment-commit-receipts";
import type { DeploymentSuccessCommitInputV1 } from "./deployment-state-ops";

export type DeploymentFileBaselinePostconditionEntryV1 =
    | {
          rowState: "active";
          deploymentFileId: string;
          relativePath: PosixRelativePath;
          appliedPayload: DurableAppliedPayloadRefV1;
          appliedExecutable: boolean;
          observedState: "present";
          observedContentHash: Sha256Digest;
          observedExecutable: boolean;
          provenance: TargetFileRenderProvenanceV1;
      }
    | {
          rowState: "removed";
          deploymentFileId: string;
          relativePath: PosixRelativePath;
          observedState: "missing";
          latestResidualAuthorityId: string;
      };

export interface DeploymentSuccessPostconditionV1 {
    schemaVersion: 1;
    deploymentId: UuidV4;
    commitTransactionId: UuidV4;
    deploymentObservationState: "complete";
    deploymentObservationAttemptedAt: EpochMillis;
    deploymentLastCompleteObservationAt: EpochMillis;
    deploymentBlockingEvidence: DeploymentBlockingEvidenceV1;
    files: DeploymentFileBaselinePostconditionEntryV1[];
    residualAuthorities: DeploymentResidualRenderAuthorityV1[];
}

export interface CanonicalDeploymentPreCommitDatabaseStateV1 {
    schemaVersion: 1;
    deployment: {
        deploymentId: UuidV4;
        consumerAgentRuntimeIds: AgentRuntimeId[];
        platform: Platform;
        platformInstanceId: string;
        targetRootPath: string;
        projectId: string;
        committedTransactionId: UuidV4 | "";
        appliedInputsSnapshotFingerprint: Sha256Digest;
        appliedRenderSnapshotFingerprint: Sha256Digest;
        observationState: ObservationState;
        observationAttemptedAt: EpochMillis;
        lastCompleteObservationAt: EpochMillis;
        blockingEvidence: DeploymentBlockingEvidenceV1;
        deleted: boolean;
        createdAt: EpochMillis;
        updatedAt: EpochMillis;
    };
    deploymentAssets: {
        deploymentAssetId: string;
        assetId: UuidV4;
        versionId: UuidV4;
        sortOrder: number;
        allowIncomplete: boolean;
        deleted: boolean;
        createdAt: EpochMillis;
        updatedAt: EpochMillis;
    }[];
    deploymentFiles: DeploymentFileAuthorityProjectionV1[];
    residualAuthorities: DeploymentResidualRenderAuthorityV1[];
}

export interface PreparedDeploymentSuccessAuthorityV1 {
    preCommitDatabaseState: CanonicalDeploymentPreCommitDatabaseStateV1;
    expectedSuccessPostcondition: DeploymentSuccessPostconditionV1;
    commitReceipt: DeploymentCommitReceiptV1;
}

export interface CommitReverseAcceptSuccessCrashDurableInput {
    databasePath: string;
    successCommit: DeploymentSuccessCommitInputV1;
    preparedAuthority: PreparedDeploymentSuccessAuthorityV1;
}

export interface ReverseAcceptDeploymentAssetVersionTransitionV1 {
    assetId: UuidV4;
    previousVersionId: UuidV4;
    stagedVersionId: UuidV4;
}

export interface CommitReverseAcceptVersionSelectionSuccessCrashDurableInput extends CommitReverseAcceptSuccessCrashDurableInput {
    deploymentAssetTransition: ReverseAcceptDeploymentAssetVersionTransitionV1;
}

export interface CommitReverseAcceptSuccessCrashDurableResult {
    commitState: "committed" | "already_committed";
    commitReceipt: DeploymentCommitReceiptV1;
    successPostcondition: DeploymentSuccessPostconditionV1;
}
