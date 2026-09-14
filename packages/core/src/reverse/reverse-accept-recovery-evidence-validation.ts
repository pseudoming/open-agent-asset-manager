/** Strict validation for reverse-accept recovery-required evidence families. */

import type { Sha256Digest } from "../contracts/primitives";
import { hasExactKeys, isStrictObject } from "../foundation/validators";

import type { FilesystemRecoveryEvidenceKind } from "./reverse-accept-marker-fields";
import {
    expectedFilesystemEvidenceFingerprints,
    requireDigest,
    requireEvidenceCommon,
    requireEvidenceKeys,
    requireFailureKind,
} from "./reverse-accept-marker-fields";
import type { ClaimedRenderedTargetCommitIntent, ReverseAcceptRecoveryRequiredDetailsV1 } from "./reverse-accept-marker-model";
import { invalidAuthority } from "./reverse-accept-marker-model";

export function validateRecoveryRequiredDetails(
    value: unknown,
    intent: ClaimedRenderedTargetCommitIntent,
): asserts value is ReverseAcceptRecoveryRequiredDetailsV1 {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, ["reasonCode", "evidence"]) ||
        !Array.isArray(value.evidence) ||
        value.evidence.length === 0
    ) {
        throw invalidAuthority("recovery-required details require non-empty strict evidence");
    }
    for (const evidence of value.evidence) {
        validateRecoveryEvidence(value.reasonCode, evidence, intent);
    }
}

export function validateRecoveryEvidence(reasonCode: unknown, value: unknown, intent: ClaimedRenderedTargetCommitIntent): void {
    if (!isStrictObject(value)) {
        throw invalidAuthority("recovery evidence must be a strict object");
    }
    if (reasonCode === "receipt_contradiction") {
        validateReceiptRecoveryEvidence(value, intent);
        return;
    }
    if (reasonCode === "database_postcondition_partial") {
        validateDatabaseRecoveryEvidence(value, intent);
        return;
    }
    if (reasonCode === "asset_filesystem_mismatch") {
        validateFilesystemRecoveryEvidence(value, intent);
        return;
    }
    if (reasonCode === "durability_unconfirmed") {
        validateDurabilityRecoveryEvidence(value, intent);
        return;
    }
    throw invalidAuthority("recovery-required reasonCode is unsupported");
}

export function validateReceiptRecoveryEvidence(value: Record<string, unknown>, intent: ClaimedRenderedTargetCommitIntent): void {
    requireEvidenceCommon(value, "database_commit_receipt", intent.expectedCommitReceiptFingerprint);
    if (value.observedState === "missing") {
        requireEvidenceKeys(value, ["evidenceKind", "observedState", "expectedFingerprint"]);
    } else if (value.observedState === "mismatch" || value.observedState === "partial") {
        requireEvidenceKeys(value, ["evidenceKind", "observedState", "expectedFingerprint", "observedFingerprint"]);
        requireDigest(value.observedFingerprint, "receipt observedFingerprint");
        if (value.observedFingerprint === value.expectedFingerprint) {
            throw invalidAuthority("receipt mismatch evidence is not a mismatch");
        }
    } else if (value.observedState === "unexpected_present") {
        requireEvidenceKeys(value, ["evidenceKind", "observedState", "expectedFingerprint", "observedFingerprint"]);
        requireDigest(value.observedFingerprint, "receipt observedFingerprint");
        if (value.observedFingerprint !== value.expectedFingerprint) {
            throw invalidAuthority("unexpected receipt evidence is not the exact claimed receipt");
        }
    } else if (value.observedState === "unreadable") {
        requireEvidenceKeys(value, ["evidenceKind", "observedState", "expectedFingerprint", "failureKind"]);
        requireFailureKind(value.failureKind);
    } else {
        throw invalidAuthority("commit receipt recovery evidence state is invalid");
    }
}

export function validateDatabaseRecoveryEvidence(
    value: Record<string, unknown>,
    intent: ClaimedRenderedTargetCommitIntent,
): void {
    const expectedByKind: Record<string, Sha256Digest> = {
        applied_inputs_snapshot: intent.appliedInputsSnapshotFingerprint,
        applied_render_snapshot: intent.appliedRenderSnapshotFingerprint,
        deployment_file_baseline_set: intent.deploymentFileBaselineSetFingerprint,
    };
    if (value.evidenceKind !== "database_postcondition" || typeof value.postconditionKind !== "string") {
        throw invalidAuthority("database recovery evidence discriminator is invalid");
    }
    const expected = expectedByKind[value.postconditionKind];
    if (expected === undefined || value.expectedFingerprint !== expected) {
        throw invalidAuthority("database recovery evidence does not join claimed intent");
    }
    if (value.observedState === "mismatch" || value.observedState === "partial") {
        requireEvidenceKeys(value, [
            "evidenceKind",
            "postconditionKind",
            "observedState",
            "expectedFingerprint",
            "observedFingerprint",
        ]);
        requireDigest(value.observedFingerprint, "database observedFingerprint");
        if (value.observedFingerprint === value.expectedFingerprint) {
            throw invalidAuthority("database mismatch evidence is not a mismatch");
        }
    } else if (value.observedState === "unreadable") {
        requireEvidenceKeys(value, ["evidenceKind", "postconditionKind", "observedState", "expectedFingerprint", "failureKind"]);
        requireFailureKind(value.failureKind);
    } else {
        throw invalidAuthority("database recovery evidence state is invalid");
    }
}

export function validateFilesystemRecoveryEvidence(
    value: Record<string, unknown>,
    intent: ClaimedRenderedTargetCommitIntent,
): void {
    const allowedKinds = new Set<string>([
        "durable_payload",
        "immutable_version",
        "version_origin_authority",
        "promotion_grant",
        "asset_manifest",
    ]);
    if (typeof value.evidenceKind !== "string" || !allowedKinds.has(value.evidenceKind)) {
        throw invalidAuthority("filesystem recovery evidence kind is invalid");
    }
    requireDigest(value.expectedFingerprint, "filesystem expectedFingerprint");
    const allowedExpected = expectedFilesystemEvidenceFingerprints(value.evidenceKind as FilesystemRecoveryEvidenceKind, intent);
    if (!allowedExpected.includes(value.expectedFingerprint)) {
        throw invalidAuthority("filesystem recovery evidence does not join claimed intent");
    }
    if (value.observedState === "missing") {
        requireEvidenceKeys(value, ["evidenceKind", "observedState", "expectedFingerprint"]);
    } else if (value.observedState === "mismatch") {
        requireEvidenceKeys(value, ["evidenceKind", "observedState", "expectedFingerprint", "observedFingerprint"]);
        requireDigest(value.observedFingerprint, "filesystem observedFingerprint");
        if (value.observedFingerprint === value.expectedFingerprint) {
            throw invalidAuthority("filesystem mismatch evidence is not a mismatch");
        }
    } else if (value.observedState === "unreadable") {
        requireEvidenceKeys(value, ["evidenceKind", "observedState", "expectedFingerprint", "failureKind"]);
        requireFailureKind(value.failureKind);
    } else {
        throw invalidAuthority("filesystem recovery evidence state is invalid");
    }
}

export function validateDurabilityRecoveryEvidence(
    value: Record<string, unknown>,
    intent: ClaimedRenderedTargetCommitIntent,
): void {
    const allowedKinds = new Set([
        "durable_payload",
        "immutable_version",
        "version_origin_authority",
        "promotion_grant",
        "asset_manifest",
        "terminal_marker",
    ]);
    if (
        typeof value.evidenceKind !== "string" ||
        !allowedKinds.has(value.evidenceKind) ||
        value.observedState !== "durability_unconfirmed"
    ) {
        throw invalidAuthority("durability recovery evidence discriminator is invalid");
    }
    requireEvidenceKeys(value, ["evidenceKind", "observedState", "expectedFingerprint", "failureKind"]);
    requireDigest(value.expectedFingerprint, "durability expectedFingerprint");
    if (
        value.evidenceKind !== "terminal_marker" &&
        !expectedFilesystemEvidenceFingerprints(value.evidenceKind as FilesystemRecoveryEvidenceKind, intent).includes(
            value.expectedFingerprint,
        )
    ) {
        throw invalidAuthority("durability recovery evidence does not join claimed intent");
    }
    if (
        value.failureKind !== "flush_failed" &&
        value.failureKind !== "identity_changed" &&
        value.failureKind !== "platform_unconfirmed"
    ) {
        throw invalidAuthority("durability recovery evidence failureKind is invalid");
    }
}
