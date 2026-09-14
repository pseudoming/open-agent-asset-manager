import type { PublishReverseAcceptedAssetVersionInputV1, VersionAuthorityClosureV1 } from "../catalog/version-authority";
import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import type { CoreResult } from "../contracts/core-service";
import type { VersionOriginAuthorityV1 } from "../contracts/persistence";
import type { Sha256Digest, UuidV4 } from "../contracts/primitives";
import type { RenderAnalysisView, RenderDeploymentInput } from "../contracts/render";
import type {
    CancelRenderedTargetAcceptInput,
    CommitRenderedTargetAcceptInput,
    PrepareRenderedTargetAcceptInput,
    RenderedTargetAcceptCommitView,
    RenderedTargetAcceptPreparationView,
} from "../contracts/reverse";
import type {
    DeploymentPayloadInput,
    publishDeploymentPayloads,
    readDeploymentPayload,
} from "../deployment/deployment-payload-store";
import type {
    CommitReverseAcceptSuccessCrashDurableResult,
    CommitReverseAcceptVersionSelectionSuccessCrashDurableInput,
    PreparedDeploymentSuccessAuthorityV1,
    ReverseAcceptDeploymentAssetVersionTransitionV1,
} from "../deployment/deployment-state-authority";
import type { DeploymentSuccessCommitInputV1 } from "../deployment/deployment-state-ops";
import type { AuthorityLockLeaseProof, tryAcquireAuthorityLockLease } from "../foundation/authority-locks";
import type { acquireAllLocks } from "../foundation/physical-path-locks";
import type {
    PreparedAssetManifestAuthority,
    PreparedRenderedTargetAccept,
    ReverseAcceptRenderAnalysisValidator,
    ReverseAcceptVersionOriginDraftV1,
} from "./reverse-accept-marker";

export interface ResolveFreshReverseAcceptPreparationInput {
    request: PrepareRenderedTargetAcceptInput;
    preparationId: UuidV4;
    commitTransactionId: UuidV4;
    stagedVersionId: UuidV4;
}

/**
 * No-write result of re-reading the inspection/Deployment/Asset authorities and
 * running a fresh render analysis. Phase 21 supplies the operational resolver;
 * Stage R only owns the durable preparation protocol around this result.
 */
export interface FreshReverseAcceptPreparationDraft {
    deploymentAuthorityFingerprint: Sha256Digest;
    assetManifestAuthorities: PreparedAssetManifestAuthority[];
    inspectionScopeFingerprint: Sha256Digest;
    inspectionResultFingerprint: Sha256Digest;
    stagedAssetId: UuidV4;
    stagedVersionFingerprint: Sha256Digest;
    stagedVersionOriginDraft: ReverseAcceptVersionOriginDraftV1;
    promotionState: "already_authorized" | "user_confirmation_required";
    renderAnalysis: RenderAnalysisView;
}

export interface ResolveFreshReverseAcceptCommitInput {
    request: CommitRenderedTargetAcceptInput;
    preparation: PreparedRenderedTargetAccept;
    stagedVersionOriginAuthority: Extract<VersionOriginAuthorityV1, { originKind: "reverse_accept" }>;
    promotionGrantId: UuidV4 | "";
    assetAuthorityLeaseProof: AuthorityLockLeaseProof;
    settingsAuthorityLeaseProof: AuthorityLockLeaseProof;
}

/**
 * No-write Core-owned result of the complete fresh reverse pipeline. The
 * Phase-21 resolver must re-read inspection/runtime state, rebuild the staged
 * Version, rerun analysis/selection/materialization/compile and project the
 * exact Deployment success input. Stage R validates all cross-authority joins
 * before it accepts this draft as a durable commit intent.
 */
export interface FreshReverseAcceptCommitDraft {
    deploymentAuthorityFingerprint: Sha256Digest;
    assetManifestAuthorities: PreparedAssetManifestAuthority[];
    inspectionScopeFingerprint: Sha256Digest;
    inspectionResultFingerprint: Sha256Digest;
    deployment: RenderDeploymentInput;
    renderAnalysis: RenderAnalysisView;
    selectionFingerprint: Sha256Digest;
    compilationFingerprint: Sha256Digest;
    stagedVersion: VersionAuthorityClosureV1;
    /**
     * Exact bytes required by the new active DeploymentFile baselines. They
     * remain transient until the claimed marker is durable; Stage R publishes
     * them before opening the final FULL database transaction.
     */
    deploymentPayloads: DeploymentPayloadInput[];
    successCommit: DeploymentSuccessCommitInputV1;
}

export interface ReverseAcceptServiceConfiguration {
    transactionsRoot: string;
    assetsRoot: string;
    deploymentsRoot: string;
    authorityLocksRoot: string;
    databasePath: string;
    dialectRegistry: VersionDialectRegistryV1;
    preparationTtlMs: number;
    renderAnalysisValidator: ReverseAcceptRenderAnalysisValidator;
    resolveFreshPreparation(
        input: ResolveFreshReverseAcceptPreparationInput,
    ): Promise<CoreResult<FreshReverseAcceptPreparationDraft>>;
    resolveFreshCommit(input: ResolveFreshReverseAcceptCommitInput): Promise<CoreResult<FreshReverseAcceptCommitDraft>>;
    now?(): number;
    newUuid?(): UuidV4;
}

export interface ReverseAcceptService {
    prepareRenderedTargetAccept(
        input: PrepareRenderedTargetAcceptInput,
    ): Promise<CoreResult<RenderedTargetAcceptPreparationView>>;
    commitRenderedTargetAccept(input: CommitRenderedTargetAcceptInput): Promise<CoreResult<RenderedTargetAcceptCommitView>>;
    cancelRenderedTargetAccept(input: CancelRenderedTargetAcceptInput): Promise<CoreResult<void>>;
}

export type AcquireLocks = typeof acquireAllLocks;
export type AcquireAuthorityLease = typeof tryAcquireAuthorityLockLease;

export interface ReverseAcceptCommitDependencies {
    acquireAssetLocks: AcquireAuthorityLease;
    acquireSettingsLock: AcquireAuthorityLease;
    publishVersion(input: PublishReverseAcceptedAssetVersionInputV1): void;
    publishDeploymentPayloads: typeof publishDeploymentPayloads;
    readDeploymentPayload: typeof readDeploymentPayload;
    prepareDatabaseAuthority(
        databasePath: string,
        successCommit: DeploymentSuccessCommitInputV1,
        deploymentAssetTransition: ReverseAcceptDeploymentAssetVersionTransitionV1,
    ): PreparedDeploymentSuccessAuthorityV1;
    commitDatabase(
        input: CommitReverseAcceptVersionSelectionSuccessCrashDurableInput,
    ): CommitReverseAcceptSuccessCrashDurableResult;
}
