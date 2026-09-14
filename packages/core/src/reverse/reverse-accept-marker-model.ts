import type { PromotionGrantV1, VersionOriginAuthorityV1, VersionPromotionRequirement } from "../contracts/persistence";
import type { EpochMillis, Sha256Digest, UuidV4 } from "../contracts/primitives";
import type { RenderAnalysisView } from "../contracts/render";
import type { DeploymentCommitReceiptV1 } from "../deployment/deployment-commit-receipts";
import type { DeploymentSuccessPostconditionV1 } from "../deployment/deployment-state-authority";

export interface PreparedAssetManifestAuthority {
    assetId: UuidV4;
    assetManifestAuthorityFingerprint: Sha256Digest;
}

export interface ReverseAcceptPreparationIdentityV1 {
    schemaVersion: 1;
    preparationId: UuidV4;
    deploymentId: UuidV4;
    commitTransactionId: UuidV4;
    assetIds: UuidV4[];
    preparationIdentityFingerprint: Sha256Digest;
}

export interface ReverseAcceptVersionOriginDraftV1 {
    previousVersionId: UuidV4;
    previousVersionOriginAuthorityFingerprint: Sha256Digest;
    promotionRequirement: VersionPromotionRequirement;
}

export interface ReverseAcceptMarkerBaseV1 {
    identity: ReverseAcceptPreparationIdentityV1;
    preparationRevision: number;
    markerFingerprint: Sha256Digest;
}

export interface PreparedRenderedTargetAccept extends ReverseAcceptMarkerBaseV1 {
    preparationRevision: 1;
    preparedAt: EpochMillis;
    expiresAt: EpochMillis;
    preparationState: "prepared";
    deploymentAuthorityFingerprint: Sha256Digest;
    assetManifestAuthorities: PreparedAssetManifestAuthority[];
    assetManifestAuthoritySetFingerprint: Sha256Digest;
    inspectionScopeFingerprint: Sha256Digest;
    inspectionResultFingerprint: Sha256Digest;
    stagedAssetId: UuidV4;
    stagedVersionId: UuidV4;
    stagedVersionFingerprint: Sha256Digest;
    stagedVersionOriginDraft: ReverseAcceptVersionOriginDraftV1;
    renderAnalysis: RenderAnalysisView;
}

export type StagedVersionPromotionPublicationV1 =
    | { publicationState: "not_created" }
    | { publicationState: "version_target_grant"; promotionGrant: PromotionGrantV1 };

export interface AssetFilesystemCommitReceiptV1 {
    schemaVersion: 1;
    preparationIdentityFingerprint: Sha256Digest;
    stagedAssetId: UuidV4;
    stagedVersionId: UuidV4;
    stagedVersionFingerprint: Sha256Digest;
    stagedVersionOriginAuthorityFingerprint: Sha256Digest;
    stagedPromotionPublication: StagedVersionPromotionPublicationV1;
    stagedAssetManifestFingerprint: Sha256Digest;
    postAssetManifestAuthoritySetFingerprint: Sha256Digest;
    assetFilesystemReceiptFingerprint: Sha256Digest;
}

export interface ClaimedRenderedTargetCommitIntent {
    commitIntentFingerprint: Sha256Digest;
    preparationIdentityFingerprint: Sha256Digest;
    claimedPreparationRevision: number;
    deploymentAuthorityFingerprint: Sha256Digest;
    assetManifestAuthorities: PreparedAssetManifestAuthority[];
    assetManifestAuthoritySetFingerprint: Sha256Digest;
    inspectionScopeFingerprint: Sha256Digest;
    inspectionResultFingerprint: Sha256Digest;
    stagedAssetId: UuidV4;
    stagedVersionId: UuidV4;
    stagedVersionFingerprint: Sha256Digest;
    stagedVersionOriginAuthority: VersionOriginAuthorityV1;
    stagedPromotionPublication: StagedVersionPromotionPublicationV1;
    stagedAssetManifestFingerprint: Sha256Digest;
    expectedPostAssetManifestAuthoritySetFingerprint: Sha256Digest;
    expectedAssetFilesystemReceiptFingerprint: Sha256Digest;
    freshRenderInputFingerprint: Sha256Digest;
    selectionFingerprint: Sha256Digest;
    compilationFingerprint: Sha256Digest;
    appliedInputsSnapshotFingerprint: Sha256Digest;
    appliedRenderSnapshotFingerprint: Sha256Digest;
    deploymentFileBaselineSetFingerprint: Sha256Digest;
    expectedSuccessPostcondition: DeploymentSuccessPostconditionV1;
    preCommitDatabaseStateFingerprint: Sha256Digest;
    expectedCommitReceiptFingerprint: Sha256Digest;
}

export type ReverseAcceptFailedFilesystemTerminalProofV1 =
    | { filesystemTerminalState: "pre_authority" }
    | {
          filesystemTerminalState: "staged_manifest_published";
          assetFilesystemReceipt: AssetFilesystemCommitReceiptV1;
      };

export type ClaimedReverseAcceptMarkerV1 = ReverseAcceptMarkerBaseV1 & {
    preparationState: "claimed";
    intent: ClaimedRenderedTargetCommitIntent;
};

export type ConsumedReverseAcceptMarkerV1 = ReverseAcceptMarkerBaseV1 & {
    preparationState: "consumed";
    intent: ClaimedRenderedTargetCommitIntent;
    commitReceipt: DeploymentCommitReceiptV1;
};

export type FailedReverseAcceptMarkerV1 = ReverseAcceptMarkerBaseV1 & {
    preparationState: "failed";
    intent: ClaimedRenderedTargetCommitIntent;
    filesystemTerminalProof: ReverseAcceptFailedFilesystemTerminalProofV1;
};

export type ReverseAcceptFilesystemRecoveryEvidenceV1 =
    | {
          evidenceKind:
              | "durable_payload"
              | "immutable_version"
              | "version_origin_authority"
              | "promotion_grant"
              | "asset_manifest";
          observedState: "missing";
          expectedFingerprint: Sha256Digest;
      }
    | {
          evidenceKind:
              | "durable_payload"
              | "immutable_version"
              | "version_origin_authority"
              | "promotion_grant"
              | "asset_manifest";
          observedState: "mismatch";
          expectedFingerprint: Sha256Digest;
          observedFingerprint: Sha256Digest;
      }
    | {
          evidenceKind:
              | "durable_payload"
              | "immutable_version"
              | "version_origin_authority"
              | "promotion_grant"
              | "asset_manifest";
          observedState: "unreadable";
          expectedFingerprint: Sha256Digest;
          failureKind: "io_error" | "permission_denied" | "corrupt";
      };

export interface ReverseAcceptDurabilityRecoveryEvidenceV1 {
    evidenceKind:
        | "durable_payload"
        | "immutable_version"
        | "version_origin_authority"
        | "promotion_grant"
        | "asset_manifest"
        | "terminal_marker";
    observedState: "durability_unconfirmed";
    expectedFingerprint: Sha256Digest;
    failureKind: "flush_failed" | "identity_changed" | "platform_unconfirmed";
}

export type ReverseAcceptDatabaseRecoveryEvidenceV1 =
    | {
          evidenceKind: "database_postcondition";
          postconditionKind: "applied_inputs_snapshot" | "applied_render_snapshot" | "deployment_file_baseline_set";
          observedState: "mismatch" | "partial";
          expectedFingerprint: Sha256Digest;
          observedFingerprint: Sha256Digest;
      }
    | {
          evidenceKind: "database_postcondition";
          postconditionKind: "applied_inputs_snapshot" | "applied_render_snapshot" | "deployment_file_baseline_set";
          observedState: "unreadable";
          expectedFingerprint: Sha256Digest;
          failureKind: "io_error" | "permission_denied" | "corrupt";
      };

export type ReverseAcceptCommitReceiptRecoveryEvidenceV1 =
    | {
          evidenceKind: "database_commit_receipt";
          observedState: "missing";
          expectedFingerprint: Sha256Digest;
      }
    | {
          evidenceKind: "database_commit_receipt";
          observedState: "mismatch" | "partial";
          expectedFingerprint: Sha256Digest;
          observedFingerprint: Sha256Digest;
      }
    | {
          evidenceKind: "database_commit_receipt";
          observedState: "unexpected_present";
          expectedFingerprint: Sha256Digest;
          observedFingerprint: Sha256Digest;
      }
    | {
          evidenceKind: "database_commit_receipt";
          observedState: "unreadable";
          expectedFingerprint: Sha256Digest;
          failureKind: "io_error" | "permission_denied" | "corrupt";
      };

export type NonEmptyEvidence<T> = [T, ...T[]];

export type ReverseAcceptRecoveryRequiredDetailsV1 =
    | {
          reasonCode: "receipt_contradiction";
          evidence: NonEmptyEvidence<ReverseAcceptCommitReceiptRecoveryEvidenceV1>;
      }
    | {
          reasonCode: "database_postcondition_partial";
          evidence: NonEmptyEvidence<ReverseAcceptDatabaseRecoveryEvidenceV1>;
      }
    | {
          reasonCode: "asset_filesystem_mismatch";
          evidence: NonEmptyEvidence<ReverseAcceptFilesystemRecoveryEvidenceV1>;
      }
    | {
          reasonCode: "durability_unconfirmed";
          evidence: NonEmptyEvidence<ReverseAcceptDurabilityRecoveryEvidenceV1>;
      };

export type RecoveryRequiredReverseAcceptMarkerV1 = ReverseAcceptMarkerBaseV1 & {
    preparationState: "recovery_required";
    intent: ClaimedRenderedTargetCommitIntent;
} & ReverseAcceptRecoveryRequiredDetailsV1;

export type ReverseAcceptRetiredTerminalProofV1 =
    | { terminalState: "consumed"; commitReceipt: DeploymentCommitReceiptV1 }
    | {
          terminalState: "failed";
          filesystemTerminalProof: ReverseAcceptFailedFilesystemTerminalProofV1;
      };

export type RetiredReverseAcceptMarkerV1 = ReverseAcceptMarkerBaseV1 & {
    preparationState: "retired";
    intent: ClaimedRenderedTargetCommitIntent;
    retiredTerminalProof: ReverseAcceptRetiredTerminalProofV1;
};

export type ReverseAcceptClaimedDerivedMarkerV1 =
    | ClaimedReverseAcceptMarkerV1
    | ConsumedReverseAcceptMarkerV1
    | FailedReverseAcceptMarkerV1
    | RecoveryRequiredReverseAcceptMarkerV1
    | RetiredReverseAcceptMarkerV1;

export type ReverseAcceptPreparationMarkerV1 =
    | PreparedRenderedTargetAccept
    | (ReverseAcceptMarkerBaseV1 & { preparationState: "cancelled" })
    | (ReverseAcceptMarkerBaseV1 & { preparationState: "expired" })
    | ReverseAcceptClaimedDerivedMarkerV1;

export type ReverseAcceptTransitionedMarkerV1 = Exclude<ReverseAcceptPreparationMarkerV1, PreparedRenderedTargetAccept>;

export type ReverseAcceptMutableMarkerV1 = Exclude<ReverseAcceptPreparationMarkerV1, RetiredReverseAcceptMarkerV1>;

export interface ReverseAcceptReservationLocatorV1 {
    identity: ReverseAcceptPreparationIdentityV1;
    locatorFingerprint: Sha256Digest;
}

export type ReverseAcceptMarkerReadResult<T> =
    | { state: "available"; value: T }
    | { state: "missing" }
    | { state: "unreadable"; error: unknown };

export interface ReverseAcceptRenderAnalysisValidator {
    validate(value: unknown): asserts value is RenderAnalysisView;
}

export type ReverseAcceptMarkerStoreErrorCode =
    | "invalid_input"
    | "marker_exists"
    | "locator_exists"
    | "marker_unavailable"
    | "marker_state_conflict"
    | "marker_revision_stale"
    | "publication_verification_failed";

export class ReverseAcceptMarkerStoreError extends Error {
    constructor(
        readonly code: ReverseAcceptMarkerStoreErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "ReverseAcceptMarkerStoreError";
    }
}

export interface ReverseAcceptMarkerStore {
    readMarker(preparationId: UuidV4): ReverseAcceptMarkerReadResult<ReverseAcceptPreparationMarkerV1>;
    readLocator(preparationId: UuidV4): ReverseAcceptMarkerReadResult<ReverseAcceptReservationLocatorV1>;
    publishPrepared(marker: PreparedRenderedTargetAccept): void;
    /** Caller must hold the Deployment operation lock shared with deploy/recovery. */
    repairLocatorFromMarker(marker: ReverseAcceptPreparationMarkerV1): "matched" | "rebuilt";
    /** Caller must hold the Deployment operation lock shared with deploy/recovery. */
    transitionPrepared(
        preparationId: UuidV4,
        expectedPreparationRevision: number,
        expectedMarkerFingerprint: Sha256Digest,
        nextState: "cancelled" | "expired",
    ): Extract<ReverseAcceptPreparationMarkerV1, { preparationState: "cancelled" | "expired" }>;
    /** Caller holds sorted Asset locks, then the Deployment operation lock. */
    claimPrepared(
        preparationId: UuidV4,
        expectedPreparationRevision: number,
        expectedMarkerFingerprint: Sha256Digest,
        intent: ClaimedRenderedTargetCommitIntent,
    ): ClaimedReverseAcceptMarkerV1;
    /** Caller holds the same Asset -> Deployment lock closure used for claim. */
    consumeClaimed(
        preparationId: UuidV4,
        expectedPreparationRevision: number,
        expectedMarkerFingerprint: Sha256Digest,
        commitReceipt: DeploymentCommitReceiptV1,
    ): ConsumedReverseAcceptMarkerV1;
    /** Caller holds the same Asset -> Deployment lock closure used for claim. */
    failClaimed(
        preparationId: UuidV4,
        expectedPreparationRevision: number,
        expectedMarkerFingerprint: Sha256Digest,
        filesystemTerminalProof: ReverseAcceptFailedFilesystemTerminalProofV1,
    ): FailedReverseAcceptMarkerV1;
    /** Caller holds sorted Asset locks, then the Deployment operation lock. */
    markRecoveryRequired(
        preparationId: UuidV4,
        expectedPreparationRevision: number,
        expectedMarkerFingerprint: Sha256Digest,
        details: ReverseAcceptRecoveryRequiredDetailsV1,
    ): RecoveryRequiredReverseAcceptMarkerV1;
    /** Resolve claimed/recovery-required evidence to one exact terminal branch. */
    resolveRecovery(
        preparationId: UuidV4,
        expectedPreparationRevision: number,
        expectedMarkerFingerprint: Sha256Digest,
        terminalProof: ReverseAcceptRetiredTerminalProofV1,
    ): ConsumedReverseAcceptMarkerV1 | FailedReverseAcceptMarkerV1;
    /** Reverify consumed/failed proof before releasing the reservation. */
    retireTerminal(
        preparationId: UuidV4,
        expectedPreparationRevision: number,
        expectedMarkerFingerprint: Sha256Digest,
    ): RetiredReverseAcceptMarkerV1;
}

export interface ReverseAcceptReservationScanResult {
    globalFreeze: boolean;
    activePreparations: ReverseAcceptPreparationIdentityV1[];
}

/** Inventory every durable reservation without treating its locator as state authority. */
export function invalidAuthority(message: string): ReverseAcceptMarkerStoreError {
    return new ReverseAcceptMarkerStoreError("marker_unavailable", message);
}
