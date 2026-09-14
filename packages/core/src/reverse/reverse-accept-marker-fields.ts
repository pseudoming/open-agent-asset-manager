import * as path from "node:path";
import { SafeFilesystemError, inventoryDirectoryNoFollow } from "@oaam/shared/filesystem";
import type { Sha256Digest, UuidV4 } from "../contracts/primitives";
import type { DeploymentCommitReceiptV1 } from "../deployment/deployment-commit-receipts";
import {
    computeReverseAcceptPreparationIdentityFingerprint,
    computeReverseAcceptReservationLocatorFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { hasExactKeys, isSha256Digest, isStrictObject, isUuidV4 } from "../foundation/validators";

import type {
    ClaimedRenderedTargetCommitIntent,
    ReverseAcceptPreparationIdentityV1,
    ReverseAcceptPreparationMarkerV1,
    ReverseAcceptReservationLocatorV1,
    ReverseAcceptVersionOriginDraftV1,
} from "./reverse-accept-marker-model";
import { invalidAuthority, ReverseAcceptMarkerStoreError } from "./reverse-accept-marker-model";

export type FilesystemRecoveryEvidenceKind =
    | "durable_payload"
    | "immutable_version"
    | "version_origin_authority"
    | "promotion_grant"
    | "asset_manifest";

export function expectedFilesystemEvidenceFingerprints(
    evidenceKind: FilesystemRecoveryEvidenceKind,
    intent: ClaimedRenderedTargetCommitIntent,
): Sha256Digest[] {
    if (evidenceKind === "immutable_version") return [intent.stagedVersionFingerprint];
    if (evidenceKind === "version_origin_authority") {
        return [intent.stagedVersionOriginAuthority.authorityFingerprint];
    }
    if (evidenceKind === "promotion_grant") {
        return intent.stagedPromotionPublication.publicationState === "version_target_grant"
            ? [intent.stagedPromotionPublication.promotionGrant.grantFingerprint]
            : [];
    }
    if (evidenceKind === "asset_manifest") {
        return [
            intent.stagedAssetManifestFingerprint,
            intent.assetManifestAuthoritySetFingerprint,
            intent.expectedPostAssetManifestAuthoritySetFingerprint,
            ...intent.assetManifestAuthorities.map((authority) => authority.assetManifestAuthorityFingerprint),
        ];
    }
    const hashes = new Set<Sha256Digest>();
    for (const file of intent.expectedSuccessPostcondition.files) {
        if (file.rowState === "active") hashes.add(file.appliedPayload.contentHash);
    }
    for (const residual of intent.expectedSuccessPostcondition.residualAuthorities) {
        hashes.add(residual.appliedPayload.contentHash);
    }
    return [...hashes];
}

export function requireEvidenceCommon(
    value: Record<string, unknown>,
    evidenceKind: string,
    expectedFingerprint: Sha256Digest,
): void {
    if (value.evidenceKind !== evidenceKind || value.expectedFingerprint !== expectedFingerprint) {
        throw invalidAuthority("recovery evidence does not join claimed intent");
    }
}

export function requireEvidenceKeys(value: Record<string, unknown>, keys: readonly string[]): void {
    if (!hasExactKeys(value, keys)) {
        throw invalidAuthority("recovery evidence has an invalid key set");
    }
}

export function requireDigest(value: unknown, label: string): asserts value is Sha256Digest {
    if (!isSha256Digest(value)) throw invalidAuthority(`${label} is invalid`);
}

export function requireFailureKind(value: unknown): void {
    if (value !== "io_error" && value !== "permission_denied" && value !== "corrupt") {
        throw invalidAuthority("recovery evidence failureKind is invalid");
    }
}

export function inventoryAuthorityIds(directoryPath: string, expectedKind: "marker_directory" | "locator_file"): string[] | null {
    try {
        const inventory = inventoryDirectoryNoFollow(directoryPath);
        const ids: string[] = [];
        for (const entry of inventory.entries) {
            const isMarker = expectedKind === "marker_directory" && entry.identity.entryKind === "directory";
            const isLocator =
                expectedKind === "locator_file" && entry.identity.entryKind === "file" && entry.relativeName.endsWith(".json");
            const candidate = isMarker ? entry.relativeName : isLocator ? entry.relativeName.slice(0, -".json".length) : "";
            if (candidate.length === 0 || !isUuidV4(candidate)) return null;
            ids.push(candidate);
        }
        return ids;
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return [];
        return null;
    }
}

export function isReservationActive(state: ReverseAcceptPreparationMarkerV1["preparationState"]): boolean {
    return state === "claimed" || state === "consumed" || state === "failed" || state === "recovery_required";
}

export function requireIntentJoinsIdentity(intent: unknown, identity: ReverseAcceptPreparationIdentityV1): void {
    const typed = intent as ClaimedRenderedTargetCommitIntent;
    if (
        typed.preparationIdentityFingerprint !== identity.preparationIdentityFingerprint ||
        stableStringify(typed.assetManifestAuthorities.map((item) => item.assetId)) !== stableStringify(identity.assetIds) ||
        typed.expectedSuccessPostcondition.deploymentId !== identity.deploymentId ||
        typed.expectedSuccessPostcondition.commitTransactionId !== identity.commitTransactionId
    ) {
        throw invalidAuthority("claimed intent does not join marker identity");
    }
}

export function requireReceiptJoinsIntent(
    receipt: DeploymentCommitReceiptV1,
    marker: {
        identity: ReverseAcceptPreparationIdentityV1;
        intent: ClaimedRenderedTargetCommitIntent;
    },
): void {
    const intent = marker.intent;
    if (
        receipt.deploymentId !== marker.identity.deploymentId ||
        receipt.commitTransactionId !== marker.identity.commitTransactionId
    ) {
        throw invalidAuthority("Deployment commit receipt contradicts claimed intent identity");
    }
    requireReceiptJoinsClaimedIntent(receipt, intent);
}

export function requireReceiptJoinsClaimedIntent(
    receipt: DeploymentCommitReceiptV1,
    intent: ClaimedRenderedTargetCommitIntent,
): void {
    if (
        receipt.deploymentId !== intent.expectedSuccessPostcondition.deploymentId ||
        receipt.commitTransactionId !== intent.expectedSuccessPostcondition.commitTransactionId ||
        receipt.preCommitDatabaseStateFingerprint !== intent.preCommitDatabaseStateFingerprint ||
        receipt.appliedInputsSnapshotFingerprint !== intent.appliedInputsSnapshotFingerprint ||
        receipt.appliedRenderSnapshotFingerprint !== intent.appliedRenderSnapshotFingerprint ||
        receipt.deploymentFileBaselineSetFingerprint !== intent.deploymentFileBaselineSetFingerprint ||
        receipt.commitReceiptFingerprint !== intent.expectedCommitReceiptFingerprint
    ) {
        throw invalidAuthority("Deployment commit receipt contradicts claimed intent");
    }
}

export function parseLocator(value: unknown): ReverseAcceptReservationLocatorV1 {
    if (!isStrictObject(value) || !hasExactKeys(value, ["identity", "locatorFingerprint"])) {
        throw invalidAuthority("reverse-accept locator has an invalid key set");
    }
    validateIdentity(value.identity);
    if (!isSha256Digest(value.locatorFingerprint)) {
        throw invalidAuthority("reverse-accept locator fingerprint is invalid");
    }
    const preimage = { identity: value.identity };
    if (computeReverseAcceptReservationLocatorFingerprint(preimage) !== value.locatorFingerprint) {
        throw invalidAuthority("reverse-accept locator fingerprint mismatch");
    }
    return structuredClone(value) as unknown as ReverseAcceptReservationLocatorV1;
}

export function validateIdentity(value: unknown): asserts value is ReverseAcceptPreparationIdentityV1 {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "schemaVersion",
            "preparationId",
            "deploymentId",
            "commitTransactionId",
            "assetIds",
            "preparationIdentityFingerprint",
        ]) ||
        value.schemaVersion !== 1 ||
        !isUuidV4(value.preparationId) ||
        !isUuidV4(value.deploymentId) ||
        !isUuidV4(value.commitTransactionId) ||
        !isCanonicalUuidSet(value.assetIds) ||
        !isSha256Digest(value.preparationIdentityFingerprint)
    ) {
        throw invalidAuthority("reverse-accept preparation identity is invalid");
    }
    const typed = value as unknown as ReverseAcceptPreparationIdentityV1;
    const { preparationIdentityFingerprint, ...preimage } = typed;
    if (computeReverseAcceptPreparationIdentityFingerprint(preimage) !== preparationIdentityFingerprint) {
        throw invalidAuthority("reverse-accept preparation identity fingerprint mismatch");
    }
}

export function validateManifestAuthorities(value: unknown, assetIds: readonly UuidV4[]): void {
    if (!Array.isArray(value) || value.length !== assetIds.length) {
        throw invalidAuthority("Asset manifest authority set does not cover every locked Asset");
    }
    const observedIds: string[] = [];
    for (const authority of value) {
        if (
            !isStrictObject(authority) ||
            !hasExactKeys(authority, ["assetId", "assetManifestAuthorityFingerprint"]) ||
            !isUuidV4(authority.assetId) ||
            !isSha256Digest(authority.assetManifestAuthorityFingerprint)
        ) {
            throw invalidAuthority("Asset manifest authority entry is invalid");
        }
        observedIds.push(authority.assetId);
    }
    if (observedIds.some((assetId, index) => assetId !== assetIds[index])) {
        throw invalidAuthority("Asset manifest authorities are not aligned with canonical assetIds");
    }
}

export function validateOriginDraft(value: unknown): asserts value is ReverseAcceptVersionOriginDraftV1 {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, ["previousVersionId", "previousVersionOriginAuthorityFingerprint", "promotionRequirement"]) ||
        !isUuidV4(value.previousVersionId) ||
        !isSha256Digest(value.previousVersionOriginAuthorityFingerprint) ||
        (value.promotionRequirement !== "not_required" && value.promotionRequirement !== "requires_current_authorization")
    ) {
        throw invalidAuthority("reverse-accept Version origin draft is invalid");
    }
}

export function requireCanonicalRoot(root: string): void {
    if (
        root.length === 0 ||
        root.includes("\0") ||
        !path.isAbsolute(root) ||
        path.normalize(root) !== root ||
        root === path.parse(root).root
    ) {
        throw new ReverseAcceptMarkerStoreError("invalid_input", "transactionsRoot must be a non-root canonical absolute path");
    }
}

export function requirePreparationId(preparationId: string): asserts preparationId is UuidV4 {
    if (!isUuidV4(preparationId)) {
        throw new ReverseAcceptMarkerStoreError("invalid_input", "preparationId must be a UUID v4");
    }
}

export function requireAuthorityPathIdentity(
    identity: ReverseAcceptPreparationIdentityV1,
    preparationId: UuidV4,
    authorityKind: "marker" | "locator",
): void {
    if (identity.preparationId !== preparationId) {
        throw invalidAuthority(`reverse-accept ${authorityKind} identity does not match its fixed preparation path`);
    }
}

export function isCanonicalUuidSet(value: unknown): value is UuidV4[] {
    if (!Array.isArray(value) || value.length === 0) return false;
    return value.every((item, index) => isUuidV4(item) && (index === 0 || (value[index - 1] as string) < item));
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isSafePositiveInteger(value: unknown): value is number {
    return isSafeNonNegativeInteger(value) && value >= 1;
}
