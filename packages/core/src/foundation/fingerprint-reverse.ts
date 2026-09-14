/** Reverse-accept and durable Deployment receipt fingerprint families. */
import type {
    AssetFilesystemCommitReceiptV1,
    ClaimedRenderedTargetCommitIntent,
    PreparedAssetManifestAuthority,
    ReverseAcceptPreparationIdentityV1,
    ReverseAcceptPreparationMarkerV1,
    ReverseAcceptReservationLocatorV1,
} from "../reverse/reverse-accept-marker";
import type { AssetManifestV1 } from "../contracts/core-service";
import type { DeploymentCommitReceiptV1 } from "../deployment/deployment-commit-receipts";
import type {
    CanonicalDeploymentPreCommitDatabaseStateV1,
    DeploymentSuccessPostconditionV1,
} from "../deployment/deployment-state-authority";
import type { Sha256Digest } from "../contracts/primitives";
import { compareCodeUnitText, fingerprintDomain } from "./fingerprint-base";

const REVERSE_PREPARATION_IDENTITY_DOMAIN = "oaam.render.reverse-preparation-identity.v1";
const ASSET_MANIFEST_FILE_DOMAIN = "oaam.asset.manifest-file.v1";
const ASSET_MANIFEST_AUTHORITY_DOMAIN = "oaam.asset.manifest-authority.v1";
const ASSET_MANIFEST_AUTHORITY_SET_DOMAIN = "oaam.asset.manifest-authority-set.v1";
const POST_ASSET_MANIFEST_AUTHORITY_SET_DOMAIN = "oaam.asset.post-manifest-authority-set.v1";
const ASSET_FILESYSTEM_RECEIPT_DOMAIN = "oaam.render.reverse-asset-filesystem-receipt.v1";
const REVERSE_COMMIT_INTENT_DOMAIN = "oaam.render.reverse-commit-intent.v1";
const REVERSE_RESERVATION_LOCATOR_DOMAIN = "oaam.render.reverse-reservation-locator.v1";
const REVERSE_ACCEPT_MARKER_DOMAIN = "oaam.render.reverse-accept-marker.v1";
const DEPLOYMENT_FILE_BASELINE_SET_DOMAIN = "oaam.render.deployment-file-baseline-set.v1";
const PRE_COMMIT_DATABASE_STATE_DOMAIN = "oaam.render.precommit-database-state.v1";
const DEPLOYMENT_COMMIT_RECEIPT_DOMAIN = "oaam.render.deployment-commit-receipt.v1";

export function computeReverseAcceptPreparationIdentityFingerprint(
    identity: Omit<ReverseAcceptPreparationIdentityV1, "preparationIdentityFingerprint">,
): Sha256Digest {
    return fingerprintDomain(REVERSE_PREPARATION_IDENTITY_DOMAIN, identity);
}

export function computeAssetManifestAuthoritySetFingerprint(
    authorities: readonly PreparedAssetManifestAuthority[],
): Sha256Digest {
    return fingerprintDomain(
        ASSET_MANIFEST_AUTHORITY_SET_DOMAIN,
        [...authorities].sort((left, right) => compareCodeUnitText(left.assetId, right.assetId)),
    );
}

export function computeAssetManifestFileFingerprint(manifest: AssetManifestV1): Sha256Digest {
    return fingerprintDomain(ASSET_MANIFEST_FILE_DOMAIN, manifest);
}

export function computeAssetManifestAuthorityFingerprint(input: {
    assetId: string;
    scope: string;
    projectId: string;
    scopePath: string;
    deleted: boolean;
    assetManifestFingerprint: Sha256Digest;
    versionIds: readonly string[];
    currentVersionId: string;
    revisionAllocationBase: number;
}): Sha256Digest {
    return fingerprintDomain(ASSET_MANIFEST_AUTHORITY_DOMAIN, {
        ...input,
        versionIds: [...input.versionIds],
    });
}

export function computePostAssetManifestAuthoritySetFingerprint(
    authorities: readonly PreparedAssetManifestAuthority[],
): Sha256Digest {
    return fingerprintDomain(
        POST_ASSET_MANIFEST_AUTHORITY_SET_DOMAIN,
        [...authorities].sort((left, right) => compareCodeUnitText(left.assetId, right.assetId)),
    );
}

export function computeAssetFilesystemReceiptFingerprint(
    receipt: Omit<AssetFilesystemCommitReceiptV1, "assetFilesystemReceiptFingerprint">,
): Sha256Digest {
    return fingerprintDomain(ASSET_FILESYSTEM_RECEIPT_DOMAIN, receipt);
}

export function computeReverseAcceptCommitIntentFingerprint(
    intent: Omit<ClaimedRenderedTargetCommitIntent, "commitIntentFingerprint">,
): Sha256Digest {
    return fingerprintDomain(REVERSE_COMMIT_INTENT_DOMAIN, intent);
}

export function computeReverseAcceptReservationLocatorFingerprint(
    locator: Omit<ReverseAcceptReservationLocatorV1, "locatorFingerprint">,
): Sha256Digest {
    return fingerprintDomain(REVERSE_RESERVATION_LOCATOR_DOMAIN, locator);
}

type ReverseAcceptMarkerFingerprintPreimage = ReverseAcceptPreparationMarkerV1 extends infer T
    ? T extends ReverseAcceptPreparationMarkerV1
        ? Omit<T, "markerFingerprint">
        : never
    : never;

export function computeReverseAcceptMarkerFingerprint(marker: ReverseAcceptMarkerFingerprintPreimage): Sha256Digest {
    return fingerprintDomain(REVERSE_ACCEPT_MARKER_DOMAIN, marker);
}

export function computeDeploymentFileBaselineSetFingerprint(postcondition: DeploymentSuccessPostconditionV1): Sha256Digest {
    return fingerprintDomain(DEPLOYMENT_FILE_BASELINE_SET_DOMAIN, postcondition);
}

export function computePreCommitDatabaseStateFingerprint(state: CanonicalDeploymentPreCommitDatabaseStateV1): Sha256Digest {
    return fingerprintDomain(PRE_COMMIT_DATABASE_STATE_DOMAIN, state);
}

export function computeDeploymentCommitReceiptFingerprint(
    receipt: Omit<DeploymentCommitReceiptV1, "commitReceiptFingerprint">,
): Sha256Digest {
    return fingerprintDomain(DEPLOYMENT_COMMIT_RECEIPT_DOMAIN, receipt);
}
