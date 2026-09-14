import {
    computeReverseAcceptCommitIntentFingerprint,
    computeReverseAcceptMarkerFingerprint,
    computeReverseAcceptPreparationIdentityFingerprint,
} from "../foundation/fingerprint";

import { isCanonicalUuidSet, validateIdentity } from "./reverse-accept-marker-fields";
import type {
    AssetFilesystemCommitReceiptV1,
    ClaimedRenderedTargetCommitIntent,
    PreparedRenderedTargetAccept,
    ReverseAcceptPreparationIdentityV1,
    ReverseAcceptPreparationMarkerV1,
    ReverseAcceptRenderAnalysisValidator,
} from "./reverse-accept-marker-model";
import { ReverseAcceptMarkerStoreError } from "./reverse-accept-marker-model";
import { requireIntentExtendsPrepared } from "./reverse-accept-marker-store";
import {
    validateAssetFilesystemReceipt,
    validateClaimedIntent,
    validateReverseAcceptMarker,
} from "./reverse-accept-marker-validation";

export function buildReverseAcceptPreparationIdentity(
    input: Omit<ReverseAcceptPreparationIdentityV1, "schemaVersion" | "preparationIdentityFingerprint">,
): ReverseAcceptPreparationIdentityV1 {
    if (!isCanonicalUuidSet(input.assetIds)) {
        throw new ReverseAcceptMarkerStoreError(
            "invalid_input",
            "reverse-accept assetIds must be canonical sorted unique UUID v4 values",
        );
    }
    const preimage = { schemaVersion: 1 as const, ...structuredClone(input) };
    const identity = {
        ...preimage,
        preparationIdentityFingerprint: computeReverseAcceptPreparationIdentityFingerprint(preimage),
    };
    validateIdentity(identity);
    return identity;
}

export function buildPreparedReverseAcceptMarker(
    input: Omit<PreparedRenderedTargetAccept, "preparationRevision" | "preparationState" | "markerFingerprint">,
    renderAnalysisValidator: ReverseAcceptRenderAnalysisValidator,
): PreparedRenderedTargetAccept {
    const preimage = {
        ...structuredClone(input),
        preparationRevision: 1 as const,
        preparationState: "prepared" as const,
    };
    const marker = {
        ...preimage,
        markerFingerprint: computeReverseAcceptMarkerFingerprint(preimage),
    };
    validateReverseAcceptMarker(marker, renderAnalysisValidator);
    return marker;
}

export function buildClaimedRenderedTargetCommitIntent(
    input: Omit<ClaimedRenderedTargetCommitIntent, "commitIntentFingerprint">,
): ClaimedRenderedTargetCommitIntent {
    const preimage = structuredClone(input);
    const intent: ClaimedRenderedTargetCommitIntent = {
        ...preimage,
        commitIntentFingerprint: computeReverseAcceptCommitIntentFingerprint(preimage),
    };
    validateClaimedIntent(intent);
    return intent;
}

/** Test-only strict validator seam for persisted reverse-accept marker branches. */
export function validateReverseAcceptMarkerForTest(
    value: unknown,
    renderAnalysisValidator: ReverseAcceptRenderAnalysisValidator,
): asserts value is ReverseAcceptPreparationMarkerV1 {
    validateReverseAcceptMarker(value, renderAnalysisValidator);
}

/** Test-only strict validator seam for the claimed cross-authority intent. */
export function validateClaimedRenderedTargetCommitIntentForTest(
    value: unknown,
): asserts value is ClaimedRenderedTargetCommitIntent {
    validateClaimedIntent(value);
}

/** Test-only strict validator seam for the filesystem publication receipt. */
export function validateAssetFilesystemCommitReceiptForTest(value: unknown): asserts value is AssetFilesystemCommitReceiptV1 {
    validateAssetFilesystemReceipt(value);
}

/** Test-only join seam for the prepared-to-claimed authority transition. */
export function requireIntentExtendsPreparedForTest(
    intent: ClaimedRenderedTargetCommitIntent,
    prepared: PreparedRenderedTargetAccept,
): void {
    requireIntentExtendsPrepared(intent, prepared);
}
