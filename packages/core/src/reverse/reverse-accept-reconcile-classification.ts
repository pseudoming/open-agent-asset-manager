/** Pure terminal classification and contradiction evidence for reverse-accept reconciliation. */

import type { Sha256Digest } from "../contracts/primitives";
import type { DeploymentCommitReceiptV1 } from "../deployment/deployment-commit-receipts";
import { stableStringify } from "../foundation/fingerprint";
import type {
    AssetFilesystemCommitReceiptV1,
    ClaimedRenderedTargetCommitIntent,
    ReverseAcceptPreparationMarkerV1,
    ReverseAcceptRecoveryRequiredDetailsV1,
} from "./reverse-accept-marker";

export interface ReverseAcceptReconcileFacts {
    commitReceipt: DeploymentCommitReceiptV1 | null;
    receiptState: "exact" | "missing" | "mismatch" | "unreadable";
    receiptObservedFingerprint?: Sha256Digest;
    databaseState: "pre" | "post" | "other" | "unreadable";
    databaseEvidence?: ReverseAcceptRecoveryRequiredDetailsV1;
    filesystemState: "old" | "post" | "other" | "unreadable";
    assetFilesystemReceipt?: AssetFilesystemCommitReceiptV1;
    filesystemEvidence?: ReverseAcceptRecoveryRequiredDetailsV1;
}

export type ReconcileTerminal =
    | { terminalState: "consumed"; commitReceipt: DeploymentCommitReceiptV1 }
    | {
          terminalState: "failed";
          filesystemTerminalProof:
              | { filesystemTerminalState: "pre_authority" }
              | {
                    filesystemTerminalState: "staged_manifest_published";
                    assetFilesystemReceipt: AssetFilesystemCommitReceiptV1;
                };
      };

export function classifyFacts(
    facts: ReverseAcceptReconcileFacts,
    intent: ClaimedRenderedTargetCommitIntent,
): "consumed" | "failed_pre" | "failed_published" | ReverseAcceptRecoveryRequiredDetailsV1 {
    if (facts.receiptState === "mismatch" || facts.receiptState === "unreadable") {
        return receiptContradiction(facts, intent);
    }
    if (facts.receiptState === "exact") {
        if (facts.databaseState !== "post") {
            return facts.databaseEvidence ?? databasePartial(intent);
        }
        if (facts.filesystemState !== "post") {
            return (
                facts.filesystemEvidence ??
                filesystemMismatch("asset_manifest", intent.expectedPostAssetManifestAuthoritySetFingerprint)
            );
        }
        return "consumed";
    }
    if (facts.databaseState === "post") return receiptContradiction(facts, intent);
    if (facts.databaseState !== "pre") return facts.databaseEvidence ?? databasePartial(intent);
    if (facts.filesystemState === "old") return "failed_pre";
    if (facts.filesystemState === "post") return "failed_published";
    return (
        facts.filesystemEvidence ?? filesystemMismatch("asset_manifest", intent.expectedPostAssetManifestAuthoritySetFingerprint)
    );
}

export function terminalProof(
    classification: "consumed" | "failed_pre" | "failed_published",
    facts: ReverseAcceptReconcileFacts,
): ReconcileTerminal {
    if (classification === "consumed") {
        if (facts.commitReceipt === null) throw new Error("exact receipt disappeared from fact set");
        return { terminalState: "consumed", commitReceipt: facts.commitReceipt };
    }
    if (classification === "failed_pre") {
        return {
            terminalState: "failed",
            filesystemTerminalProof: { filesystemTerminalState: "pre_authority" },
        };
    }
    if (facts.assetFilesystemReceipt === undefined) {
        throw new Error("post filesystem receipt disappeared from fact set");
    }
    return {
        terminalState: "failed",
        filesystemTerminalProof: {
            filesystemTerminalState: "staged_manifest_published",
            assetFilesystemReceipt: facts.assetFilesystemReceipt,
        },
    };
}

export function terminalMatchesCurrent(
    terminal: ReconcileTerminal,
    current: Extract<ReverseAcceptPreparationMarkerV1, { preparationState: "consumed" | "failed" }>,
): boolean {
    if (current.preparationState === "consumed") {
        // Both the durable marker parser and the independently reopened DB
        // receipt validator already require the exact intent-bound receipt
        // fingerprint. Once both classify as consumed, comparing the same
        // content-addressed body again would add only an unreachable
        // hash-collision branch.
        return terminal.terminalState === "consumed";
    }
    return (
        terminal.terminalState === "failed" &&
        stableStringify(current.filesystemTerminalProof) === stableStringify(terminal.filesystemTerminalProof)
    );
}

export function terminalConflictEvidence(
    current: Extract<ReverseAcceptPreparationMarkerV1, { preparationState: "consumed" | "failed" }>,
    classification: "consumed" | "failed_pre" | "failed_published",
    facts: ReverseAcceptReconcileFacts,
): ReverseAcceptRecoveryRequiredDetailsV1 {
    if (current.preparationState === "consumed") {
        return receiptContradiction(facts, current.intent);
    }
    if (classification === "consumed") {
        return {
            reasonCode: "receipt_contradiction",
            evidence: [
                {
                    evidenceKind: "database_commit_receipt",
                    observedState: "unexpected_present",
                    expectedFingerprint: current.intent.expectedCommitReceiptFingerprint,
                    observedFingerprint: current.intent.expectedCommitReceiptFingerprint,
                },
            ],
        };
    }
    const expectedFingerprint =
        current.filesystemTerminalProof.filesystemTerminalState === "pre_authority"
            ? current.intent.assetManifestAuthoritySetFingerprint
            : current.intent.expectedPostAssetManifestAuthoritySetFingerprint;
    const observedFingerprint =
        classification === "failed_pre"
            ? current.intent.assetManifestAuthoritySetFingerprint
            : current.intent.expectedPostAssetManifestAuthoritySetFingerprint;
    return filesystemMismatch("asset_manifest", expectedFingerprint, observedFingerprint);
}

function receiptContradiction(
    facts: ReverseAcceptReconcileFacts,
    intent: ClaimedRenderedTargetCommitIntent,
): ReverseAcceptRecoveryRequiredDetailsV1 {
    if (facts.receiptState === "mismatch" && facts.receiptObservedFingerprint !== undefined) {
        return {
            reasonCode: "receipt_contradiction",
            evidence: [
                {
                    evidenceKind: "database_commit_receipt",
                    observedState: "mismatch",
                    expectedFingerprint: intent.expectedCommitReceiptFingerprint,
                    observedFingerprint: facts.receiptObservedFingerprint,
                },
            ],
        };
    }
    if (facts.receiptState === "missing") {
        return {
            reasonCode: "receipt_contradiction",
            evidence: [
                {
                    evidenceKind: "database_commit_receipt",
                    observedState: "missing",
                    expectedFingerprint: intent.expectedCommitReceiptFingerprint,
                },
            ],
        };
    }
    return {
        reasonCode: "receipt_contradiction",
        evidence: [
            {
                evidenceKind: "database_commit_receipt",
                observedState: "unreadable",
                expectedFingerprint: intent.expectedCommitReceiptFingerprint,
                failureKind: "corrupt",
            },
        ],
    };
}

function databasePartial(intent: ClaimedRenderedTargetCommitIntent): ReverseAcceptRecoveryRequiredDetailsV1 {
    return {
        reasonCode: "database_postcondition_partial",
        evidence: [
            {
                evidenceKind: "database_postcondition",
                postconditionKind: "applied_inputs_snapshot",
                observedState: "unreadable",
                expectedFingerprint: intent.appliedInputsSnapshotFingerprint,
                failureKind: "corrupt",
            },
        ],
    };
}

export function filesystemMismatch(
    evidenceKind: "asset_manifest",
    expectedFingerprint: Sha256Digest,
    observedFingerprint?: Sha256Digest,
): ReverseAcceptRecoveryRequiredDetailsV1 {
    return {
        reasonCode: "asset_filesystem_mismatch",
        evidence: [
            observedFingerprint === undefined
                ? { evidenceKind, observedState: "missing", expectedFingerprint }
                : {
                      evidenceKind,
                      observedState: "mismatch",
                      expectedFingerprint,
                      observedFingerprint,
                  },
        ],
    };
}
