import { serializePromotionGrant } from "../catalog/promotion-grant-store";
import type { PromotionGrantV1, VersionOriginAuthorityV1 } from "../contracts/persistence";
import type { Sha256Digest, UuidV4 } from "../contracts/primitives";
import type { DeploymentCommitReceiptV1 } from "../deployment/deployment-commit-receipts";
import { buildDeploymentCommitReceipt, validateDeploymentCommitReceipt } from "../deployment/deployment-commit-receipts";
import type { DeploymentSuccessPostconditionV1 } from "../deployment/deployment-state-authority";
import { validateDeploymentSuccessPostcondition } from "../deployment/deployment-state-authority";
import {
    computeAssetFilesystemReceiptFingerprint,
    computeAssetManifestAuthoritySetFingerprint,
    computeReverseAcceptCommitIntentFingerprint,
    computeReverseAcceptMarkerFingerprint,
    computeVersionOriginAuthorityFingerprint,
} from "../foundation/fingerprint";
import { hasExactKeys, isSha256Digest, isStrictObject, isUuidV4 } from "../foundation/validators";

import {
    isSafeNonNegativeInteger,
    isSafePositiveInteger,
    requireIntentJoinsIdentity,
    requireReceiptJoinsClaimedIntent,
    requireReceiptJoinsIntent,
    validateIdentity,
    validateManifestAuthorities,
    validateOriginDraft,
} from "./reverse-accept-marker-fields";
import type {
    AssetFilesystemCommitReceiptV1,
    ClaimedRenderedTargetCommitIntent,
    ConsumedReverseAcceptMarkerV1,
    PreparedAssetManifestAuthority,
    ReverseAcceptFailedFilesystemTerminalProofV1,
    ReverseAcceptPreparationMarkerV1,
    ReverseAcceptRenderAnalysisValidator,
    ReverseAcceptRetiredTerminalProofV1,
    StagedVersionPromotionPublicationV1,
} from "./reverse-accept-marker-model";
import { invalidAuthority } from "./reverse-accept-marker-model";
import { validateRecoveryRequiredDetails } from "./reverse-accept-recovery-evidence-validation";

export {
    validateDatabaseRecoveryEvidence,
    validateDurabilityRecoveryEvidence,
    validateFilesystemRecoveryEvidence,
    validateReceiptRecoveryEvidence,
    validateRecoveryEvidence,
    validateRecoveryRequiredDetails,
} from "./reverse-accept-recovery-evidence-validation";

export function buildAssetFilesystemCommitReceipt(
    input: Omit<AssetFilesystemCommitReceiptV1, "assetFilesystemReceiptFingerprint">,
): AssetFilesystemCommitReceiptV1 {
    const preimage = structuredClone(input);
    const receipt: AssetFilesystemCommitReceiptV1 = {
        ...preimage,
        assetFilesystemReceiptFingerprint: computeAssetFilesystemReceiptFingerprint(preimage),
    };
    validateAssetFilesystemReceipt(receipt);
    return receipt;
}

export function parseReverseAcceptMarker(
    value: unknown,
    renderAnalysisValidator: ReverseAcceptRenderAnalysisValidator,
): ReverseAcceptPreparationMarkerV1 {
    validateReverseAcceptMarker(value, renderAnalysisValidator);
    return structuredClone(value);
}

export function validateReverseAcceptMarker(
    value: unknown,
    renderAnalysisValidator: ReverseAcceptRenderAnalysisValidator,
): asserts value is ReverseAcceptPreparationMarkerV1 {
    if (!isStrictObject(value) || typeof value.preparationState !== "string") {
        throw invalidAuthority("reverse-accept marker must be a strict discriminated object");
    }
    if (value.preparationState === "prepared") {
        if (
            !hasExactKeys(value, [
                "identity",
                "preparationRevision",
                "markerFingerprint",
                "preparedAt",
                "expiresAt",
                "preparationState",
                "deploymentAuthorityFingerprint",
                "assetManifestAuthorities",
                "assetManifestAuthoritySetFingerprint",
                "inspectionScopeFingerprint",
                "inspectionResultFingerprint",
                "stagedAssetId",
                "stagedVersionId",
                "stagedVersionFingerprint",
                "stagedVersionOriginDraft",
                "renderAnalysis",
            ])
        ) {
            throw invalidAuthority("prepared reverse-accept marker has an invalid key set");
        }
        validateIdentity(value.identity);
        if (value.preparationRevision !== 1) {
            throw invalidAuthority("prepared reverse-accept marker revision must be 1");
        }
        if (
            !isSafeNonNegativeInteger(value.preparedAt) ||
            !isSafeNonNegativeInteger(value.expiresAt) ||
            value.expiresAt <= value.preparedAt
        ) {
            throw invalidAuthority("prepared reverse-accept marker has an invalid TTL interval");
        }
        for (const key of [
            "deploymentAuthorityFingerprint",
            "assetManifestAuthoritySetFingerprint",
            "inspectionScopeFingerprint",
            "inspectionResultFingerprint",
            "stagedVersionFingerprint",
        ] as const) {
            if (!isSha256Digest(value[key])) {
                throw invalidAuthority(`prepared reverse-accept marker ${key} is invalid`);
            }
        }
        if (!isUuidV4(value.stagedAssetId) || !isUuidV4(value.stagedVersionId)) {
            throw invalidAuthority("prepared reverse-accept marker staged IDs must be UUID v4");
        }
        validateManifestAuthorities(value.assetManifestAuthorities, value.identity.assetIds);
        if (!value.identity.assetIds.includes(value.stagedAssetId)) {
            throw invalidAuthority("staged Asset is outside the preparation authority set");
        }
        if (
            computeAssetManifestAuthoritySetFingerprint(value.assetManifestAuthorities as PreparedAssetManifestAuthority[]) !==
            value.assetManifestAuthoritySetFingerprint
        ) {
            throw invalidAuthority("Asset manifest authority set fingerprint mismatch");
        }
        validateOriginDraft(value.stagedVersionOriginDraft);
        renderAnalysisValidator.validate(value.renderAnalysis);
    } else if (value.preparationState === "cancelled" || value.preparationState === "expired") {
        if (!hasExactKeys(value, ["identity", "preparationRevision", "markerFingerprint", "preparationState"])) {
            throw invalidAuthority("terminal reverse-accept marker has an invalid key set");
        }
        validateIdentity(value.identity);
        if (!isSafePositiveInteger(value.preparationRevision) || value.preparationRevision < 2) {
            throw invalidAuthority("terminal reverse-accept marker revision must be at least 2");
        }
    } else if (value.preparationState === "claimed") {
        if (!hasExactKeys(value, ["identity", "preparationRevision", "markerFingerprint", "preparationState", "intent"])) {
            throw invalidAuthority("claimed reverse-accept marker has an invalid key set");
        }
        validateIdentity(value.identity);
        if (value.preparationRevision !== 2) {
            throw invalidAuthority("claimed reverse-accept marker revision must be 2");
        }
        validateClaimedIntent(value.intent);
        requireIntentJoinsIdentity(value.intent, value.identity);
    } else if (value.preparationState === "consumed") {
        if (
            !hasExactKeys(value, [
                "identity",
                "preparationRevision",
                "markerFingerprint",
                "preparationState",
                "intent",
                "commitReceipt",
            ])
        ) {
            throw invalidAuthority("consumed reverse-accept marker has an invalid key set");
        }
        validateIdentity(value.identity);
        if (!isSafePositiveInteger(value.preparationRevision) || value.preparationRevision < 3) {
            throw invalidAuthority("consumed reverse-accept marker revision must be at least 3");
        }
        validateClaimedIntent(value.intent);
        requireIntentJoinsIdentity(value.intent, value.identity);
        validateDeploymentCommitReceipt(value.commitReceipt);
        requireReceiptJoinsIntent(value.commitReceipt, value as unknown as ConsumedReverseAcceptMarkerV1);
    } else if (value.preparationState === "failed") {
        if (
            !hasExactKeys(value, [
                "identity",
                "preparationRevision",
                "markerFingerprint",
                "preparationState",
                "intent",
                "filesystemTerminalProof",
            ])
        ) {
            throw invalidAuthority("failed reverse-accept marker has an invalid key set");
        }
        validateIdentity(value.identity);
        if (!isSafePositiveInteger(value.preparationRevision) || value.preparationRevision < 3) {
            throw invalidAuthority("failed reverse-accept marker revision must be at least 3");
        }
        validateClaimedIntent(value.intent);
        requireIntentJoinsIdentity(value.intent, value.identity);
        validateFilesystemTerminalProof(
            value.filesystemTerminalProof,
            value.intent as unknown as ClaimedRenderedTargetCommitIntent,
        );
    } else if (value.preparationState === "recovery_required") {
        if (
            !hasExactKeys(value, [
                "identity",
                "preparationRevision",
                "markerFingerprint",
                "preparationState",
                "intent",
                "reasonCode",
                "evidence",
            ])
        ) {
            throw invalidAuthority("recovery-required marker has an invalid key set");
        }
        validateIdentity(value.identity);
        if (!isSafePositiveInteger(value.preparationRevision) || value.preparationRevision < 3) {
            throw invalidAuthority("recovery-required marker revision must be at least 3");
        }
        validateClaimedIntent(value.intent);
        requireIntentJoinsIdentity(value.intent, value.identity);
        validateRecoveryRequiredDetails(
            { reasonCode: value.reasonCode, evidence: value.evidence } as never,
            value.intent as unknown as ClaimedRenderedTargetCommitIntent,
        );
    } else if (value.preparationState === "retired") {
        if (
            !hasExactKeys(value, [
                "identity",
                "preparationRevision",
                "markerFingerprint",
                "preparationState",
                "intent",
                "retiredTerminalProof",
            ])
        ) {
            throw invalidAuthority("retired reverse-accept marker has an invalid key set");
        }
        validateIdentity(value.identity);
        if (!isSafePositiveInteger(value.preparationRevision) || value.preparationRevision < 4) {
            throw invalidAuthority("retired reverse-accept marker revision must be at least 4");
        }
        validateClaimedIntent(value.intent);
        requireIntentJoinsIdentity(value.intent, value.identity);
        validateRetiredTerminalProof(value.retiredTerminalProof, value.intent as unknown as ClaimedRenderedTargetCommitIntent);
    } else {
        throw invalidAuthority("reverse-accept marker state is unsupported");
    }

    if (!isSha256Digest(value.markerFingerprint)) {
        throw invalidAuthority("reverse-accept marker fingerprint is invalid");
    }
    const typed = value as unknown as ReverseAcceptPreparationMarkerV1;
    const { markerFingerprint, ...preimage } = typed;
    if (computeReverseAcceptMarkerFingerprint(preimage) !== markerFingerprint) {
        throw invalidAuthority("reverse-accept marker fingerprint mismatch");
    }
}

const CLAIMED_INTENT_KEYS = [
    "commitIntentFingerprint",
    "preparationIdentityFingerprint",
    "claimedPreparationRevision",
    "deploymentAuthorityFingerprint",
    "assetManifestAuthorities",
    "assetManifestAuthoritySetFingerprint",
    "inspectionScopeFingerprint",
    "inspectionResultFingerprint",
    "stagedAssetId",
    "stagedVersionId",
    "stagedVersionFingerprint",
    "stagedVersionOriginAuthority",
    "stagedPromotionPublication",
    "stagedAssetManifestFingerprint",
    "expectedPostAssetManifestAuthoritySetFingerprint",
    "expectedAssetFilesystemReceiptFingerprint",
    "freshRenderInputFingerprint",
    "selectionFingerprint",
    "compilationFingerprint",
    "appliedInputsSnapshotFingerprint",
    "appliedRenderSnapshotFingerprint",
    "deploymentFileBaselineSetFingerprint",
    "expectedSuccessPostcondition",
    "preCommitDatabaseStateFingerprint",
    "expectedCommitReceiptFingerprint",
] as const;

export function validateClaimedIntent(value: unknown): asserts value is ClaimedRenderedTargetCommitIntent {
    if (!isStrictObject(value) || !hasExactKeys(value, CLAIMED_INTENT_KEYS)) {
        throw invalidAuthority("claimed reverse-accept intent has an invalid key set");
    }
    if (!isSafePositiveInteger(value.claimedPreparationRevision)) {
        throw invalidAuthority("claimed preparation revision must be a positive safe integer");
    }
    if (!isUuidV4(value.stagedAssetId) || !isUuidV4(value.stagedVersionId)) {
        throw invalidAuthority("claimed reverse-accept staged IDs must be UUID v4");
    }
    for (const key of [
        "commitIntentFingerprint",
        "preparationIdentityFingerprint",
        "deploymentAuthorityFingerprint",
        "assetManifestAuthoritySetFingerprint",
        "inspectionScopeFingerprint",
        "inspectionResultFingerprint",
        "stagedVersionFingerprint",
        "stagedAssetManifestFingerprint",
        "expectedPostAssetManifestAuthoritySetFingerprint",
        "expectedAssetFilesystemReceiptFingerprint",
        "freshRenderInputFingerprint",
        "selectionFingerprint",
        "compilationFingerprint",
        "appliedInputsSnapshotFingerprint",
        "appliedRenderSnapshotFingerprint",
        "deploymentFileBaselineSetFingerprint",
        "preCommitDatabaseStateFingerprint",
        "expectedCommitReceiptFingerprint",
    ] as const) {
        if (!isSha256Digest(value[key])) {
            throw invalidAuthority(`claimed reverse-accept intent ${key} is invalid`);
        }
    }
    if (!Array.isArray(value.assetManifestAuthorities)) {
        throw invalidAuthority("claimed Asset manifest authorities must be an array");
    }
    validateManifestAuthorities(
        value.assetManifestAuthorities,
        (value.assetManifestAuthorities as PreparedAssetManifestAuthority[]).map((authority) => authority.assetId),
    );
    if (
        computeAssetManifestAuthoritySetFingerprint(value.assetManifestAuthorities as PreparedAssetManifestAuthority[]) !==
        value.assetManifestAuthoritySetFingerprint
    ) {
        throw invalidAuthority("claimed Asset manifest authority set fingerprint mismatch");
    }
    if (
        !(value.assetManifestAuthorities as PreparedAssetManifestAuthority[]).some(
            (authority) => authority.assetId === value.stagedAssetId,
        )
    ) {
        throw invalidAuthority("claimed staged Asset is outside the authority set");
    }
    validateReverseOriginAuthority(value.stagedVersionOriginAuthority);
    const origin = value.stagedVersionOriginAuthority as Extract<VersionOriginAuthorityV1, { originKind: "reverse_accept" }>;
    if (origin.assetId !== value.stagedAssetId || origin.versionId !== value.stagedVersionId) {
        throw invalidAuthority("claimed reverse origin does not match staged Asset/Version");
    }
    validateStagedPromotionPublication(
        value.stagedPromotionPublication,
        value.stagedAssetId as UuidV4,
        value.stagedVersionId as UuidV4,
        origin,
    );
    validateDeploymentSuccessPostcondition(value.expectedSuccessPostcondition);
    const expectedSuccess = value.expectedSuccessPostcondition as DeploymentSuccessPostconditionV1;
    const expectedReceipt = buildDeploymentCommitReceipt({
        schemaVersion: 1,
        deploymentId: expectedSuccess.deploymentId,
        commitTransactionId: expectedSuccess.commitTransactionId,
        preCommitDatabaseStateFingerprint: value.preCommitDatabaseStateFingerprint as Sha256Digest,
        appliedInputsSnapshotFingerprint: value.appliedInputsSnapshotFingerprint as Sha256Digest,
        appliedRenderSnapshotFingerprint: value.appliedRenderSnapshotFingerprint as Sha256Digest,
        deploymentFileBaselineSetFingerprint: value.deploymentFileBaselineSetFingerprint as Sha256Digest,
    });
    if (expectedReceipt.commitReceiptFingerprint !== value.expectedCommitReceiptFingerprint) {
        throw invalidAuthority("claimed expected DB receipt fingerprint mismatch");
    }
    const expectedFilesystemReceipt = buildAssetFilesystemCommitReceipt({
        schemaVersion: 1,
        preparationIdentityFingerprint: value.preparationIdentityFingerprint as Sha256Digest,
        stagedAssetId: value.stagedAssetId as UuidV4,
        stagedVersionId: value.stagedVersionId as UuidV4,
        stagedVersionFingerprint: value.stagedVersionFingerprint as Sha256Digest,
        stagedVersionOriginAuthorityFingerprint: origin.authorityFingerprint,
        stagedPromotionPublication: value.stagedPromotionPublication as StagedVersionPromotionPublicationV1,
        stagedAssetManifestFingerprint: value.stagedAssetManifestFingerprint as Sha256Digest,
        postAssetManifestAuthoritySetFingerprint: value.expectedPostAssetManifestAuthoritySetFingerprint as Sha256Digest,
    });
    if (expectedFilesystemReceipt.assetFilesystemReceiptFingerprint !== value.expectedAssetFilesystemReceiptFingerprint) {
        throw invalidAuthority("claimed expected Asset filesystem receipt fingerprint mismatch");
    }
    const typed = value as unknown as ClaimedRenderedTargetCommitIntent;
    const { commitIntentFingerprint, ...preimage } = typed;
    if (computeReverseAcceptCommitIntentFingerprint(preimage) !== commitIntentFingerprint) {
        throw invalidAuthority("claimed reverse-accept intent fingerprint mismatch");
    }
}

export function validateReverseOriginAuthority(
    value: unknown,
): asserts value is Extract<VersionOriginAuthorityV1, { originKind: "reverse_accept" }> {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "schemaVersion",
            "assetId",
            "versionId",
            "originKind",
            "previousVersionId",
            "previousVersionOriginAuthorityFingerprint",
            "reversePreparationIdentityFingerprint",
            "userActionEvidenceId",
            "promotionRequirement",
            "createdAt",
            "authorityFingerprint",
        ]) ||
        value.schemaVersion !== 1 ||
        value.originKind !== "reverse_accept" ||
        !isUuidV4(value.assetId) ||
        !isUuidV4(value.versionId) ||
        !isUuidV4(value.previousVersionId) ||
        !isSha256Digest(value.previousVersionOriginAuthorityFingerprint) ||
        !isSha256Digest(value.reversePreparationIdentityFingerprint) ||
        typeof value.userActionEvidenceId !== "string" ||
        value.userActionEvidenceId.trim().length === 0 ||
        (value.promotionRequirement !== "not_required" && value.promotionRequirement !== "requires_current_authorization") ||
        !isSafeNonNegativeInteger(value.createdAt) ||
        !isSha256Digest(value.authorityFingerprint)
    ) {
        throw invalidAuthority("staged reverse origin authority is invalid");
    }
    const typed = value as unknown as Extract<VersionOriginAuthorityV1, { originKind: "reverse_accept" }>;
    const { authorityFingerprint, ...preimage } = typed;
    if (computeVersionOriginAuthorityFingerprint(preimage) !== authorityFingerprint) {
        throw invalidAuthority("staged reverse origin authority fingerprint mismatch");
    }
}

export function validateStagedPromotionPublication(
    value: unknown,
    assetId: UuidV4,
    versionId: UuidV4,
    origin: Extract<VersionOriginAuthorityV1, { originKind: "reverse_accept" }>,
): asserts value is StagedVersionPromotionPublicationV1 {
    if (!isStrictObject(value) || typeof value.publicationState !== "string") {
        throw invalidAuthority("staged promotion publication is invalid");
    }
    if (value.publicationState === "not_created") {
        if (!hasExactKeys(value, ["publicationState"])) {
            throw invalidAuthority("not-created promotion publication has extra fields");
        }
        return;
    }
    if (value.publicationState !== "version_target_grant" || !hasExactKeys(value, ["publicationState", "promotionGrant"])) {
        throw invalidAuthority("staged promotion publication branch is invalid");
    }
    try {
        serializePromotionGrant(value.promotionGrant as PromotionGrantV1);
    } catch {
        throw invalidAuthority("staged promotion grant is invalid");
    }
    const grant = value.promotionGrant as PromotionGrantV1;
    if (
        grant.subject.subjectKind !== "asset_version" ||
        grant.subject.assetId !== assetId ||
        grant.subject.versionId !== versionId ||
        grant.userActionEvidenceId !== origin.userActionEvidenceId ||
        grant.updatedAt !== origin.createdAt
    ) {
        throw invalidAuthority("staged promotion grant does not bind the reverse origin");
    }
}

export function validateAssetFilesystemReceipt(value: unknown): asserts value is AssetFilesystemCommitReceiptV1 {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "schemaVersion",
            "preparationIdentityFingerprint",
            "stagedAssetId",
            "stagedVersionId",
            "stagedVersionFingerprint",
            "stagedVersionOriginAuthorityFingerprint",
            "stagedPromotionPublication",
            "stagedAssetManifestFingerprint",
            "postAssetManifestAuthoritySetFingerprint",
            "assetFilesystemReceiptFingerprint",
        ]) ||
        value.schemaVersion !== 1 ||
        !isUuidV4(value.stagedAssetId) ||
        !isUuidV4(value.stagedVersionId)
    ) {
        throw invalidAuthority("Asset filesystem receipt has an invalid shape");
    }
    for (const key of [
        "preparationIdentityFingerprint",
        "stagedVersionFingerprint",
        "stagedVersionOriginAuthorityFingerprint",
        "stagedAssetManifestFingerprint",
        "postAssetManifestAuthoritySetFingerprint",
        "assetFilesystemReceiptFingerprint",
    ] as const) {
        if (!isSha256Digest(value[key])) {
            throw invalidAuthority(`Asset filesystem receipt ${key} is invalid`);
        }
    }
    if (!isStrictObject(value.stagedPromotionPublication)) {
        throw invalidAuthority("Asset filesystem receipt promotion publication is invalid");
    }
    if (value.stagedPromotionPublication.publicationState === "not_created") {
        if (!hasExactKeys(value.stagedPromotionPublication, ["publicationState"])) {
            throw invalidAuthority("Asset filesystem receipt has invalid no-grant publication");
        }
    } else if (
        value.stagedPromotionPublication.publicationState === "version_target_grant" &&
        hasExactKeys(value.stagedPromotionPublication, ["publicationState", "promotionGrant"])
    ) {
        try {
            serializePromotionGrant(value.stagedPromotionPublication.promotionGrant as PromotionGrantV1);
        } catch {
            throw invalidAuthority("Asset filesystem receipt promotion grant is invalid");
        }
    } else {
        throw invalidAuthority("Asset filesystem receipt promotion branch is invalid");
    }
    const typed = value as unknown as AssetFilesystemCommitReceiptV1;
    const { assetFilesystemReceiptFingerprint, ...preimage } = typed;
    if (computeAssetFilesystemReceiptFingerprint(preimage) !== assetFilesystemReceiptFingerprint) {
        throw invalidAuthority("Asset filesystem receipt fingerprint mismatch");
    }
}

export function validateFilesystemTerminalProof(
    value: unknown,
    intent: ClaimedRenderedTargetCommitIntent,
): asserts value is ReverseAcceptFailedFilesystemTerminalProofV1 {
    if (!isStrictObject(value) || typeof value.filesystemTerminalState !== "string") {
        throw invalidAuthority("reverse-accept filesystem terminal proof is invalid");
    }
    if (value.filesystemTerminalState === "pre_authority") {
        if (!hasExactKeys(value, ["filesystemTerminalState"])) {
            throw invalidAuthority("pre-authority terminal proof has extra fields");
        }
        return;
    }
    if (
        value.filesystemTerminalState !== "staged_manifest_published" ||
        !hasExactKeys(value, ["filesystemTerminalState", "assetFilesystemReceipt"])
    ) {
        throw invalidAuthority("published filesystem terminal proof branch is invalid");
    }
    validateAssetFilesystemReceipt(value.assetFilesystemReceipt);
    const receipt = value.assetFilesystemReceipt as AssetFilesystemCommitReceiptV1;
    if (receipt.assetFilesystemReceiptFingerprint !== intent.expectedAssetFilesystemReceiptFingerprint) {
        throw invalidAuthority("published filesystem proof contradicts claimed intent");
    }
}

export function validateRetiredTerminalProof(
    value: unknown,
    intent: ClaimedRenderedTargetCommitIntent,
): asserts value is ReverseAcceptRetiredTerminalProofV1 {
    if (!isStrictObject(value) || typeof value.terminalState !== "string") {
        throw invalidAuthority("reverse-accept retired terminal proof is invalid");
    }
    if (value.terminalState === "consumed") {
        if (!hasExactKeys(value, ["terminalState", "commitReceipt"])) {
            throw invalidAuthority("retired consumed proof has an invalid key set");
        }
        validateDeploymentCommitReceipt(value.commitReceipt);
        requireReceiptJoinsClaimedIntent(value.commitReceipt as DeploymentCommitReceiptV1, intent);
        return;
    }
    if (value.terminalState !== "failed" || !hasExactKeys(value, ["terminalState", "filesystemTerminalProof"])) {
        throw invalidAuthority("retired failed proof has an invalid key set");
    }
    validateFilesystemTerminalProof(value.filesystemTerminalProof, intent);
}
