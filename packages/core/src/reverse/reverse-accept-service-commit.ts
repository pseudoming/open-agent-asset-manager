import { readPromotionGrantAuthority } from "../catalog/promotion-grant-store";
import { readAssetManifestAuthority, readAssetManifestAuthoritySet, readVersionAuthority } from "../catalog/version-authority";
import type { AssetVersionManifestV2 } from "../contracts/asset-version";
import type { CoreResult } from "../contracts/core-service";
import type { Sha256Digest } from "../contracts/primitives";
import type { RenderedTargetAcceptCommitView } from "../contracts/reverse";
import { readDeploymentCommitReceipt, receiptsAreExact } from "../deployment/deployment-commit-receipts";
import {
    type CommitReverseAcceptSuccessCrashDurableResult,
    type PreparedDeploymentSuccessAuthorityV1,
    type ReverseAcceptDeploymentAssetVersionTransitionV1,
    readCanonicalDeploymentPreCommitDatabaseState,
    readDeploymentSuccessPostcondition,
} from "../deployment/deployment-state-authority";
import {
    computeAssetManifestFileFingerprint,
    computePostAssetManifestAuthoritySetFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { completeResult } from "../foundation/core-result";
import {
    type AssetFilesystemCommitReceiptV1,
    buildAssetFilesystemCommitReceipt,
    type ClaimedReverseAcceptMarkerV1,
    type ReverseAcceptMarkerStore,
} from "./reverse-accept-marker";
import type { NormalizedFreshReverseAcceptCommitDraft } from "./reverse-accept-service-draft";
import type { ReverseAcceptCommitDependencies, ReverseAcceptServiceConfiguration } from "./reverse-accept-service-model";
import {
    diagnosticForError,
    failedCommit,
    ReverseAcceptServiceFailure,
    requireExactValue,
} from "./reverse-accept-service-shared";

export function executeClaimedCommit(input: {
    configuration: Readonly<ReverseAcceptServiceConfiguration>;
    markerStore: ReverseAcceptMarkerStore;
    commitDependencies: ReverseAcceptCommitDependencies;
    claimed: ClaimedReverseAcceptMarkerV1;
    normalized: NormalizedFreshReverseAcceptCommitDraft;
    preparedDatabaseAuthority: PreparedDeploymentSuccessAuthorityV1;
    deploymentAssetTransition: ReverseAcceptDeploymentAssetVersionTransitionV1;
    expectedFilesystemReceipt: AssetFilesystemCommitReceiptV1;
}): CoreResult<RenderedTargetAcceptCommitView> {
    try {
        input.commitDependencies.publishVersion({
            assetsRoot: input.configuration.assetsRoot,
            transactionId: input.claimed.identity.commitTransactionId,
            version: input.normalized.stagedVersion,
            dialectRegistry: input.configuration.dialectRegistry,
            promotion:
                input.normalized.stagedPromotionPublication.publicationState === "not_created"
                    ? { promotionAction: "import_only" }
                    : {
                          promotionAction: "publish_grant",
                          grant: input.normalized.stagedPromotionPublication.promotionGrant,
                      },
        });
        publishAndVerifyDeploymentPayloads(input);
    } catch (error) {
        return classifyClaimedBeforeDatabase(input, error);
    }

    const filesystemReceipt = readExactAssetFilesystemReceipt(input);
    if (filesystemReceipt === null) {
        return failedCommit(
            new ReverseAcceptServiceFailure(
                "reverse_accept.asset_publication_unconfirmed",
                "published Asset filesystem authority could not be verified exactly",
                "unavailable",
            ),
        );
    }

    let committed: CommitReverseAcceptSuccessCrashDurableResult;
    try {
        committed = input.commitDependencies.commitDatabase({
            databasePath: input.configuration.databasePath,
            successCommit: input.normalized.successCommit,
            preparedAuthority: input.preparedDatabaseAuthority,
            deploymentAssetTransition: input.deploymentAssetTransition,
        });
        requireExactValue(
            committed.commitReceipt,
            input.preparedDatabaseAuthority.commitReceipt,
            "FULL transaction commit receipt",
        );
        requireExactValue(
            committed.successPostcondition,
            input.preparedDatabaseAuthority.expectedSuccessPostcondition,
            "FULL transaction success postcondition",
        );
    } catch (error) {
        return classifyClaimedAfterDatabaseAttempt(input, filesystemReceipt, error);
    }

    try {
        input.markerStore.consumeClaimed(
            input.claimed.identity.preparationId,
            input.claimed.preparationRevision,
            input.claimed.markerFingerprint,
            committed.commitReceipt,
        );
    } catch (error) {
        return failedCommit(error);
    }
    return committedResult(input.normalized.stagedVersion.manifest);
}

export function publishAndVerifyDeploymentPayloads(input: Parameters<typeof executeClaimedCommit>[0]): void {
    input.commitDependencies.publishDeploymentPayloads({
        deploymentsRoot: input.configuration.deploymentsRoot,
        deploymentId: input.claimed.identity.deploymentId,
        transactionId: input.claimed.identity.commitTransactionId,
        payloads: input.normalized.deploymentPayloads,
    });
    for (const payload of input.normalized.deploymentPayloads) {
        const reopened = input.commitDependencies.readDeploymentPayload({
            deploymentsRoot: input.configuration.deploymentsRoot,
            deploymentId: input.claimed.identity.deploymentId,
            contentHash: payload.contentHash,
            expectedByteSize: payload.bytes.byteLength,
        });
        if (!Buffer.from(reopened).equals(Buffer.from(payload.bytes))) {
            throw new ReverseAcceptServiceFailure(
                "reverse_accept.deployment_payload_unconfirmed",
                "published Deployment payload could not be verified exactly",
                "unavailable",
            );
        }
    }
    const completePostPayloads = new Map<Sha256Digest, number>();
    for (const file of input.preparedDatabaseAuthority.expectedSuccessPostcondition.files) {
        if (file.rowState === "active") {
            completePostPayloads.set(file.appliedPayload.contentHash, file.appliedPayload.byteSize);
        }
    }
    for (const residual of input.preparedDatabaseAuthority.expectedSuccessPostcondition.residualAuthorities) {
        completePostPayloads.set(residual.appliedPayload.contentHash, residual.appliedPayload.byteSize);
    }
    for (const [contentHash, byteSize] of completePostPayloads) {
        input.commitDependencies.readDeploymentPayload({
            deploymentsRoot: input.configuration.deploymentsRoot,
            deploymentId: input.claimed.identity.deploymentId,
            contentHash,
            expectedByteSize: byteSize,
        });
    }
}

export function classifyClaimedBeforeDatabase(
    input: Parameters<typeof executeClaimedCommit>[0],
    error: unknown,
): CoreResult<RenderedTargetAcceptCommitView> {
    if (!databaseStillExactPreState(input)) return failedCommit(error);
    if (assetManifestSetIsExactOld(input)) {
        return publishFailedMarker(input, { filesystemTerminalState: "pre_authority" }, error);
    }
    const filesystemReceipt = readExactAssetFilesystemReceipt(input);
    if (filesystemReceipt !== null) {
        return publishFailedMarker(
            input,
            {
                filesystemTerminalState: "staged_manifest_published",
                assetFilesystemReceipt: filesystemReceipt,
            },
            error,
        );
    }
    return failedCommit(error);
}

export function classifyClaimedAfterDatabaseAttempt(
    input: Parameters<typeof executeClaimedCommit>[0],
    filesystemReceipt: AssetFilesystemCommitReceiptV1,
    error: unknown,
): CoreResult<RenderedTargetAcceptCommitView> {
    const lookup = readDeploymentCommitReceipt(
        input.configuration.databasePath,
        input.claimed.identity.deploymentId,
        input.claimed.identity.commitTransactionId,
    );
    if (lookup.receiptState === "available" && receiptsAreExact(lookup.receipt, input.preparedDatabaseAuthority.commitReceipt)) {
        try {
            const postcondition = readDeploymentSuccessPostcondition(
                input.configuration.databasePath,
                input.claimed.identity.deploymentId,
                input.claimed.identity.commitTransactionId,
            );
            requireExactValue(
                postcondition,
                input.preparedDatabaseAuthority.expectedSuccessPostcondition,
                "post-error DB success authority",
            );
            input.markerStore.consumeClaimed(
                input.claimed.identity.preparationId,
                input.claimed.preparationRevision,
                input.claimed.markerFingerprint,
                lookup.receipt,
            );
            return committedResult(input.normalized.stagedVersion.manifest);
        } catch {
            return failedCommit(error);
        }
    }
    if (lookup.receiptState === "missing" && databaseStillExactPreState(input)) {
        return publishFailedMarker(
            input,
            {
                filesystemTerminalState: "staged_manifest_published",
                assetFilesystemReceipt: filesystemReceipt,
            },
            error,
        );
    }
    return failedCommit(error);
}

export function publishFailedMarker(
    input: Parameters<typeof executeClaimedCommit>[0],
    proof:
        | { filesystemTerminalState: "pre_authority" }
        | {
              filesystemTerminalState: "staged_manifest_published";
              assetFilesystemReceipt: AssetFilesystemCommitReceiptV1;
          },
    cause: unknown,
): CoreResult<RenderedTargetAcceptCommitView> {
    try {
        input.markerStore.failClaimed(
            input.claimed.identity.preparationId,
            input.claimed.preparationRevision,
            input.claimed.markerFingerprint,
            proof,
        );
    } catch (error) {
        return failedCommit(error);
    }
    const diagnostics = [diagnosticForError(cause)];
    if (proof.filesystemTerminalState === "pre_authority") {
        return {
            status: "failed",
            value: {
                commitState: "not_committed",
                versionPublicationState: "not_published",
            },
            diagnostics,
        };
    }
    return {
        status: "partial",
        value: {
            commitState: "not_committed",
            versionPublicationState: "published_not_selected",
            version: {
                assetId: input.normalized.stagedVersion.manifest.assetId,
                versionId: input.normalized.stagedVersion.manifest.versionId,
            },
        },
        diagnostics,
    };
}

export function databaseStillExactPreState(input: Parameters<typeof executeClaimedCommit>[0]): boolean {
    try {
        const receipt = readDeploymentCommitReceipt(
            input.configuration.databasePath,
            input.claimed.identity.deploymentId,
            input.claimed.identity.commitTransactionId,
        );
        if (receipt.receiptState !== "missing") return false;
        const current = readCanonicalDeploymentPreCommitDatabaseState(
            input.configuration.databasePath,
            input.claimed.identity.deploymentId,
        );
        return stableStringify(current) === stableStringify(input.preparedDatabaseAuthority.preCommitDatabaseState);
    } catch {
        return false;
    }
}

export function assetManifestSetIsExactOld(input: Parameters<typeof executeClaimedCommit>[0]): boolean {
    try {
        return (
            stableStringify(readAssetManifestAuthoritySet(input.configuration.assetsRoot, input.claimed.identity.assetIds)) ===
            stableStringify(input.claimed.intent.assetManifestAuthorities)
        );
    } catch {
        return false;
    }
}

export function readExactAssetFilesystemReceipt(
    input: Parameters<typeof executeClaimedCommit>[0],
): AssetFilesystemCommitReceiptV1 | null {
    try {
        const stagedAsset = readAssetManifestAuthority(input.configuration.assetsRoot, input.claimed.intent.stagedAssetId);
        if (
            stagedAsset === null ||
            computeAssetManifestFileFingerprint(stagedAsset.manifest) !== input.claimed.intent.stagedAssetManifestFingerprint
        ) {
            return null;
        }
        const version = readVersionAuthority(
            input.configuration.assetsRoot,
            input.claimed.intent.stagedAssetId,
            input.claimed.intent.stagedVersionId,
            input.configuration.dialectRegistry,
        );
        if (stableStringify(version) !== stableStringify(input.normalized.stagedVersion)) {
            return null;
        }
        const publication = input.claimed.intent.stagedPromotionPublication;
        if (publication.publicationState === "version_target_grant") {
            const grant = readPromotionGrantAuthority(
                input.configuration.assetsRoot,
                input.claimed.intent.stagedAssetId,
                publication.promotionGrant.promotionGrantId,
            );
            if (stableStringify(grant) !== stableStringify(publication.promotionGrant)) {
                return null;
            }
        }
        const currentAuthorities = readAssetManifestAuthoritySet(input.configuration.assetsRoot, input.claimed.identity.assetIds);
        if (
            computePostAssetManifestAuthoritySetFingerprint(currentAuthorities) !==
            input.claimed.intent.expectedPostAssetManifestAuthoritySetFingerprint
        ) {
            return null;
        }
        const receipt = buildAssetFilesystemCommitReceipt({
            schemaVersion: 1,
            preparationIdentityFingerprint: input.claimed.intent.preparationIdentityFingerprint,
            stagedAssetId: input.claimed.intent.stagedAssetId,
            stagedVersionId: input.claimed.intent.stagedVersionId,
            stagedVersionFingerprint: input.claimed.intent.stagedVersionFingerprint,
            stagedVersionOriginAuthorityFingerprint: input.claimed.intent.stagedVersionOriginAuthority.authorityFingerprint,
            stagedPromotionPublication: input.claimed.intent.stagedPromotionPublication,
            stagedAssetManifestFingerprint: input.claimed.intent.stagedAssetManifestFingerprint,
            postAssetManifestAuthoritySetFingerprint: input.claimed.intent.expectedPostAssetManifestAuthoritySetFingerprint,
        });
        return stableStringify(receipt) === stableStringify(input.expectedFilesystemReceipt) ? receipt : null;
    } catch {
        return null;
    }
}

export function committedResult(manifest: AssetVersionManifestV2): CoreResult<RenderedTargetAcceptCommitView> {
    return completeResult({
        commitState: "committed",
        version: { assetId: manifest.assetId, versionId: manifest.versionId },
    });
}
