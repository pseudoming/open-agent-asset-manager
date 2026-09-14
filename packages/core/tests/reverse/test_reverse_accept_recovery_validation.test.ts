import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDeploymentCommitReceipt } from "../../src/deployment/deployment-commit-receipts";
import { computeReverseAcceptMarkerFingerprint, stableStringify } from "../../src/foundation/fingerprint";
import {
    createReverseAcceptMarkerStore,
    createReverseAcceptMarkerStoreForTest,
    reverseAcceptScanBlocksScope,
    scanReverseAcceptReservations,
    validateReverseAcceptMarkerForTest,
} from "../../src/reverse/reverse-accept-marker";
import { reconcileReverseAcceptPreparation } from "../../src/reverse/reverse-accept-reconcile";
import { createReverseAcceptService } from "../../src/reverse/reverse-accept-service";
import type { Sha256Digest, UuidV4 } from "../../src/types";
import {
    DEPLOYMENT_UUID,
    exactAnalysisValidator,
    harness,
    HASH_A,
    HASH_B,
    leaveClaimedBeforeFilesystem,
    PREPARATION_ID,
    prepare,
    reconcileConfiguration,
} from "./fixtures/reverse-accept-commit-test-fixtures";

describe("reverse-accept recovery validation", () => {
    it("strictly validates every typed recovery-evidence family and terminal tombstone", async () => {
        const store = await leaveClaimedBeforeFilesystem(harness);
        const claimed = store.readMarker(PREPARATION_ID);
        if (claimed.state !== "available" || claimed.value.preparationState !== "claimed") {
            throw new Error("claimed fixture missing");
        }
        const intent = claimed.value.intent;
        const otherThan = (fingerprint: Sha256Digest): Sha256Digest => (fingerprint === HASH_A ? HASH_B : HASH_A);
        let revision = claimed.value.preparationRevision;
        let markerFingerprint = claimed.value.markerFingerprint;
        const advance = (details: Parameters<typeof store.markRecoveryRequired>[3]) => {
            const next = store.markRecoveryRequired(PREPARATION_ID, revision, markerFingerprint, details);
            revision = next.preparationRevision;
            markerFingerprint = next.markerFingerprint;
            validateReverseAcceptMarkerForTest(next, exactAnalysisValidator(harness.analysis));
        };
        const reject = (details: unknown) => {
            expect(() => store.markRecoveryRequired(PREPARATION_ID, revision, markerFingerprint, details as never)).toThrow();
        };

        for (const evidence of [
            {
                evidenceKind: "database_commit_receipt",
                observedState: "missing",
                expectedFingerprint: intent.expectedCommitReceiptFingerprint,
            },
            {
                evidenceKind: "database_commit_receipt",
                observedState: "partial",
                expectedFingerprint: intent.expectedCommitReceiptFingerprint,
                observedFingerprint: otherThan(intent.expectedCommitReceiptFingerprint),
            },
            {
                evidenceKind: "database_commit_receipt",
                observedState: "unreadable",
                expectedFingerprint: intent.expectedCommitReceiptFingerprint,
                failureKind: "io_error",
            },
            {
                evidenceKind: "database_commit_receipt",
                observedState: "unexpected_present",
                expectedFingerprint: intent.expectedCommitReceiptFingerprint,
                observedFingerprint: intent.expectedCommitReceiptFingerprint,
            },
        ] as const) {
            advance({ reasonCode: "receipt_contradiction", evidence: [evidence] });
        }
        for (const [postconditionKind, expectedFingerprint] of [
            ["applied_inputs_snapshot", intent.appliedInputsSnapshotFingerprint],
            ["applied_render_snapshot", intent.appliedRenderSnapshotFingerprint],
            ["deployment_file_baseline_set", intent.deploymentFileBaselineSetFingerprint],
        ] as const) {
            advance({
                reasonCode: "database_postcondition_partial",
                evidence: [
                    {
                        evidenceKind: "database_postcondition",
                        postconditionKind,
                        observedState: "partial",
                        expectedFingerprint,
                        observedFingerprint: otherThan(expectedFingerprint),
                    },
                ],
            });
            advance({
                reasonCode: "database_postcondition_partial",
                evidence: [
                    {
                        evidenceKind: "database_postcondition",
                        postconditionKind,
                        observedState: "unreadable",
                        expectedFingerprint,
                        failureKind: "permission_denied",
                    },
                ],
            });
        }
        const activeFile = intent.expectedSuccessPostcondition.files.find((file) => file.rowState === "active");
        if (activeFile?.rowState !== "active") throw new Error("active payload fixture missing");
        const filesystemExpected = [
            ["durable_payload", activeFile.appliedPayload.contentHash],
            ["immutable_version", intent.stagedVersionFingerprint],
            ["version_origin_authority", intent.stagedVersionOriginAuthority.authorityFingerprint],
            ["asset_manifest", intent.expectedPostAssetManifestAuthoritySetFingerprint],
        ] as const;
        for (const [evidenceKind, expectedFingerprint] of filesystemExpected) {
            advance({
                reasonCode: "asset_filesystem_mismatch",
                evidence: [{ evidenceKind, observedState: "missing", expectedFingerprint }],
            });
            advance({
                reasonCode: "asset_filesystem_mismatch",
                evidence: [
                    {
                        evidenceKind,
                        observedState: "mismatch",
                        expectedFingerprint,
                        observedFingerprint: otherThan(expectedFingerprint),
                    },
                ],
            });
            advance({
                reasonCode: "asset_filesystem_mismatch",
                evidence: [
                    {
                        evidenceKind,
                        observedState: "unreadable",
                        expectedFingerprint,
                        failureKind: "corrupt",
                    },
                ],
            });
        }
        for (const failureKind of ["flush_failed", "identity_changed", "platform_unconfirmed"] as const) {
            advance({
                reasonCode: "durability_unconfirmed",
                evidence: [
                    {
                        evidenceKind: "terminal_marker",
                        observedState: "durability_unconfirmed",
                        expectedFingerprint: markerFingerprint,
                        failureKind,
                    },
                ],
            });
        }

        for (const malformed of [
            null,
            { reasonCode: "receipt_contradiction", evidence: [] },
            { reasonCode: "unknown", evidence: [{}] },
            { reasonCode: "receipt_contradiction", evidence: [null] },
            {
                reasonCode: "receipt_contradiction",
                evidence: [
                    {
                        evidenceKind: "database_commit_receipt",
                        observedState: "unknown",
                        expectedFingerprint: intent.expectedCommitReceiptFingerprint,
                    },
                ],
            },
            {
                reasonCode: "receipt_contradiction",
                evidence: [
                    {
                        evidenceKind: "database_commit_receipt",
                        observedState: "mismatch",
                        expectedFingerprint: intent.expectedCommitReceiptFingerprint,
                        observedFingerprint: intent.expectedCommitReceiptFingerprint,
                    },
                ],
            },
            {
                reasonCode: "receipt_contradiction",
                evidence: [
                    {
                        evidenceKind: "database_commit_receipt",
                        observedState: "unexpected_present",
                        expectedFingerprint: intent.expectedCommitReceiptFingerprint,
                        observedFingerprint: otherThan(intent.expectedCommitReceiptFingerprint),
                    },
                ],
            },
            {
                reasonCode: "receipt_contradiction",
                evidence: [
                    {
                        evidenceKind: "database_commit_receipt",
                        observedState: "missing",
                        expectedFingerprint: HASH_A,
                    },
                ],
            },
            {
                reasonCode: "receipt_contradiction",
                evidence: [
                    {
                        evidenceKind: "database_commit_receipt",
                        observedState: "missing",
                        expectedFingerprint: intent.expectedCommitReceiptFingerprint,
                        extra: true,
                    },
                ],
            },
            {
                reasonCode: "receipt_contradiction",
                evidence: [
                    {
                        evidenceKind: "database_commit_receipt",
                        observedState: "unreadable",
                        expectedFingerprint: intent.expectedCommitReceiptFingerprint,
                        failureKind: "unknown",
                    },
                ],
            },
            {
                reasonCode: "database_postcondition_partial",
                evidence: [
                    {
                        evidenceKind: "database_postcondition",
                        postconditionKind: "unknown",
                        observedState: "mismatch",
                        expectedFingerprint: HASH_A,
                        observedFingerprint: HASH_B,
                    },
                ],
            },
            {
                reasonCode: "database_postcondition_partial",
                evidence: [
                    {
                        evidenceKind: "unknown",
                        postconditionKind: "applied_inputs_snapshot",
                        observedState: "mismatch",
                        expectedFingerprint: intent.appliedInputsSnapshotFingerprint,
                        observedFingerprint: HASH_A,
                    },
                ],
            },
            {
                reasonCode: "database_postcondition_partial",
                evidence: [
                    {
                        evidenceKind: "database_postcondition",
                        postconditionKind: "applied_inputs_snapshot",
                        observedState: "mismatch",
                        expectedFingerprint: intent.appliedInputsSnapshotFingerprint,
                        observedFingerprint: intent.appliedInputsSnapshotFingerprint,
                    },
                ],
            },
            {
                reasonCode: "database_postcondition_partial",
                evidence: [
                    {
                        evidenceKind: "database_postcondition",
                        postconditionKind: "applied_inputs_snapshot",
                        observedState: "missing",
                        expectedFingerprint: intent.appliedInputsSnapshotFingerprint,
                    },
                ],
            },
            {
                reasonCode: "asset_filesystem_mismatch",
                evidence: [
                    {
                        evidenceKind: "promotion_grant",
                        observedState: "missing",
                        expectedFingerprint: HASH_A,
                    },
                ],
            },
            {
                reasonCode: "asset_filesystem_mismatch",
                evidence: [
                    {
                        evidenceKind: "unknown",
                        observedState: "missing",
                        expectedFingerprint: HASH_A,
                    },
                ],
            },
            {
                reasonCode: "asset_filesystem_mismatch",
                evidence: [
                    {
                        evidenceKind: "immutable_version",
                        observedState: "missing",
                        expectedFingerprint: "invalid-digest",
                    },
                ],
            },
            {
                reasonCode: "asset_filesystem_mismatch",
                evidence: [
                    {
                        evidenceKind: "immutable_version",
                        observedState: "mismatch",
                        expectedFingerprint: intent.stagedVersionFingerprint,
                        observedFingerprint: intent.stagedVersionFingerprint,
                    },
                ],
            },
            {
                reasonCode: "asset_filesystem_mismatch",
                evidence: [
                    {
                        evidenceKind: "immutable_version",
                        observedState: "partial",
                        expectedFingerprint: intent.stagedVersionFingerprint,
                    },
                ],
            },
            {
                reasonCode: "durability_unconfirmed",
                evidence: [
                    {
                        evidenceKind: "terminal_marker",
                        observedState: "durability_unconfirmed",
                        expectedFingerprint: HASH_A,
                        failureKind: "unknown",
                    },
                ],
            },
            {
                reasonCode: "durability_unconfirmed",
                evidence: [
                    {
                        evidenceKind: "unknown",
                        observedState: "durability_unconfirmed",
                        expectedFingerprint: HASH_A,
                        failureKind: "flush_failed",
                    },
                ],
            },
            {
                reasonCode: "durability_unconfirmed",
                evidence: [
                    {
                        evidenceKind: "immutable_version",
                        observedState: "durability_unconfirmed",
                        expectedFingerprint: HASH_A,
                        failureKind: "flush_failed",
                    },
                ],
            },
        ]) {
            reject(malformed);
        }

        const recoveryRead = store.readMarker(PREPARATION_ID);
        if (recoveryRead.state !== "available" || recoveryRead.value.preparationState !== "recovery_required") {
            throw new Error("recovery-required fixture missing");
        }
        for (const malformedMarker of [
            { ...structuredClone(recoveryRead.value), extra: true },
            { ...structuredClone(recoveryRead.value), preparationRevision: 2 },
        ]) {
            expect(() => validateReverseAcceptMarkerForTest(malformedMarker, exactAnalysisValidator(harness.analysis))).toThrow();
        }

        const terminal = store.resolveRecovery(PREPARATION_ID, revision, markerFingerprint, {
            terminalState: "failed",
            filesystemTerminalProof: { filesystemTerminalState: "pre_authority" },
        });
        const retired = store.retireTerminal(PREPARATION_ID, terminal.preparationRevision, terminal.markerFingerprint);
        validateReverseAcceptMarkerForTest(retired, exactAnalysisValidator(harness.analysis));
        const contradictoryReceipt = buildDeploymentCommitReceipt({
            schemaVersion: 1,
            deploymentId: intent.expectedSuccessPostcondition.deploymentId,
            commitTransactionId: intent.expectedSuccessPostcondition.commitTransactionId,
            preCommitDatabaseStateFingerprint: otherThan(intent.preCommitDatabaseStateFingerprint),
            appliedInputsSnapshotFingerprint: intent.appliedInputsSnapshotFingerprint,
            appliedRenderSnapshotFingerprint: intent.appliedRenderSnapshotFingerprint,
            deploymentFileBaselineSetFingerprint: intent.deploymentFileBaselineSetFingerprint,
        });
        for (const malformedMarker of [
            { ...structuredClone(retired), extra: true },
            { ...structuredClone(retired), preparationRevision: 3 },
            { ...structuredClone(retired), retiredTerminalProof: null },
            {
                ...structuredClone(retired),
                retiredTerminalProof: { terminalState: "consumed", commitReceipt: null },
            },
            {
                ...structuredClone(retired),
                retiredTerminalProof: {
                    terminalState: "consumed",
                    commitReceipt: null,
                    extra: true,
                },
            },
            {
                ...structuredClone(retired),
                retiredTerminalProof: {
                    terminalState: "consumed",
                    commitReceipt: contradictoryReceipt,
                },
            },
            {
                ...structuredClone(retired),
                retiredTerminalProof: { terminalState: "unknown" },
            },
        ]) {
            expect(() => validateReverseAcceptMarkerForTest(malformedMarker, exactAnalysisValidator(harness.analysis))).toThrow();
        }

        expect(() =>
            store.markRecoveryRequired(PREPARATION_ID, retired.preparationRevision, retired.markerFingerprint, {
                reasonCode: "receipt_contradiction",
                evidence: [
                    {
                        evidenceKind: "database_commit_receipt",
                        observedState: "missing",
                        expectedFingerprint: intent.expectedCommitReceiptFingerprint,
                    },
                ],
            }),
        ).toThrow(/already retired/);
        expect(() => store.retireTerminal(PREPARATION_ID, retired.preparationRevision, retired.markerFingerprint)).toThrow(
            /not terminal/,
        );
        const missingPreparationId = "11111111-1111-4111-8111-111111111111" as UuidV4;
        expect(() =>
            store.markRecoveryRequired(missingPreparationId, 2, HASH_A, {
                reasonCode: "receipt_contradiction",
                evidence: [
                    {
                        evidenceKind: "database_commit_receipt",
                        observedState: "missing",
                        expectedFingerprint: intent.expectedCommitReceiptFingerprint,
                    },
                ],
            }),
        ).toThrow(/unavailable/);
        expect(() => store.retireTerminal(missingPreparationId, 3, HASH_A)).toThrow(/unavailable/);
        expect(() =>
            store.resolveRecovery(missingPreparationId, 3, HASH_A, {
                terminalState: "failed",
                filesystemTerminalProof: { filesystemTerminalState: "pre_authority" },
            }),
        ).toThrow(/unavailable/);
        expect(() =>
            store.resolveRecovery(PREPARATION_ID, retired.preparationRevision, retired.markerFingerprint, {
                terminalState: "failed",
                filesystemTerminalProof: { filesystemTerminalState: "pre_authority" },
            }),
        ).toThrow(/already retired/);
    });

    it("distinguishes injected pre-publication failure from post-publication retirement acknowledgement loss", async () => {
        await leaveClaimedBeforeFilesystem(harness);
        const first = reconcileReverseAcceptPreparation(reconcileConfiguration(harness), PREPARATION_ID);
        expect(first.reconcileState).toBe("retired");
        const markerPath = path.join(harness.transactionsRoot, "reverse-accept", PREPARATION_ID, "marker.json");
        const retired = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as Record<string, unknown>;
        retired.preparationState = "failed";
        retired.preparationRevision = 3;
        retired.filesystemTerminalProof = (
            retired.retiredTerminalProof as { filesystemTerminalProof: unknown }
        ).filesystemTerminalProof;
        delete retired.retiredTerminalProof;
        const { markerFingerprint: _old, ...preimage } = retired;
        retired.markerFingerprint = computeReverseAcceptMarkerFingerprint(preimage as never);
        fs.writeFileSync(markerPath, stableStringify(retired));

        const faulting = createReverseAcceptMarkerStoreForTest(
            harness.transactionsRoot,
            exactAnalysisValidator(harness.analysis),
            {
                beforeMarkerTransition(_current, next) {
                    if (next.preparationState === "retired") throw new Error("retire-flush-failed");
                },
            },
        );
        const current = faulting.readMarker(PREPARATION_ID);
        if (current.state !== "available" || current.value.preparationState !== "failed") {
            throw new Error("failed terminal fixture missing");
        }
        expect(() =>
            faulting.retireTerminal(PREPARATION_ID, current.value.preparationRevision, current.value.markerFingerprint),
        ).toThrow("retire-flush-failed");
        expect(faulting.readMarker(PREPARATION_ID)).toMatchObject({
            state: "available",
            value: { preparationState: "failed" },
        });

        const lostAcknowledgement = createReverseAcceptMarkerStoreForTest(
            harness.transactionsRoot,
            exactAnalysisValidator(harness.analysis),
            {
                afterMarkerTransition(next) {
                    if (next.preparationState === "retired") {
                        throw new Error("retire-acknowledgement-lost");
                    }
                },
            },
        );
        const terminal = lostAcknowledgement.readMarker(PREPARATION_ID);
        if (terminal.state !== "available" || terminal.value.preparationState !== "failed") {
            throw new Error("failed terminal fixture missing after injected publication failure");
        }
        expect(() =>
            lostAcknowledgement.retireTerminal(
                PREPARATION_ID,
                terminal.value.preparationRevision,
                terminal.value.markerFingerprint,
            ),
        ).toThrow("retire-acknowledgement-lost");
        expect(lostAcknowledgement.readMarker(PREPARATION_ID)).toMatchObject({
            state: "available",
            value: { preparationState: "retired" },
        });
        expect(
            reverseAcceptScanBlocksScope(scanReverseAcceptReservations(harness.transactionsRoot, lostAcknowledgement), {
                deploymentId: DEPLOYMENT_UUID,
            }),
        ).toBe(false);
    });

    it("does not freeze a valid prepared marker before claim", async () => {
        const service = createReverseAcceptService(harness.configuration());
        await prepare(service);
        const store = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        const prepared = scanReverseAcceptReservations(harness.transactionsRoot, store);
        expect(prepared).toEqual({ globalFreeze: false, activePreparations: [] });
        expect(reverseAcceptScanBlocksScope(prepared, { deploymentId: DEPLOYMENT_UUID })).toBe(false);
    });
});
