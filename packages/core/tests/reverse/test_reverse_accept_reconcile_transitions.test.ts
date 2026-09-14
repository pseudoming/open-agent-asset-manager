import Database from "better-sqlite3";
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDeploymentCommitReceipt } from "../../src/deployment/deployment-commit-receipts";
import { tryAcquireAuthorityLockLease } from "../../src/foundation/authority-locks";
import { stableStringify } from "../../src/foundation/fingerprint";
import { acquireAllLocks, computeDeploymentOperationKey } from "../../src/foundation/physical-path-locks";
import {
    buildAssetFilesystemCommitReceipt,
    createReverseAcceptMarkerStore,
    reverseAcceptScanBlocksScope,
    scanReverseAcceptReservations,
} from "../../src/reverse/reverse-accept-marker";
import {
    readReverseAcceptReconcileFactsForTest,
    reconcileReverseAcceptPreparation,
    reconcileReverseAcceptPreparationForTest,
} from "../../src/reverse/reverse-accept-reconcile";
import { createReverseAcceptService } from "../../src/reverse/reverse-accept-service";
import type { UuidV4 } from "../../src/types";
import {
    ASSET_UUID,
    commitRequest,
    createHarness,
    DEPLOYMENT_UUID,
    exactAnalysisValidator,
    harness,
    HASH_A,
    leaveClaimedAfterCommit,
    leaveClaimedBeforeFilesystem,
    PREPARATION_ID,
    prepare,
    reconcileConfiguration,
    TRANSACTION_UUID,
} from "./fixtures/reverse-accept-commit-test-fixtures";

describe("reverse-accept reconcile transitions", () => {
    it("fails closed across missing, busy, unstable, and resolved reservation states", async () => {
        const configuration = reconcileConfiguration(harness);
        expect(reconcileReverseAcceptPreparation(configuration, PREPARATION_ID)).toEqual({
            reconcileState: "global_freeze",
        });
        const service = createReverseAcceptService(harness.configuration());
        await prepare(service);
        const store = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        expect(reconcileReverseAcceptPreparation(configuration, PREPARATION_ID)).toEqual({
            reconcileState: "pending",
            preparationState: "prepared",
        });

        const assetLease = tryAcquireAuthorityLockLease(configuration.authorityLocksRoot, "assets", [ASSET_UUID]);
        expect(assetLease).not.toBeNull();
        try {
            expect(reconcileReverseAcceptPreparation(configuration, PREPARATION_ID)).toEqual({
                reconcileState: "busy",
                deploymentId: DEPLOYMENT_UUID,
            });
        } finally {
            assetLease?.release();
        }
        const deploymentLock = acquireAllLocks(configuration.transactionsRoot, [computeDeploymentOperationKey(DEPLOYMENT_UUID)]);
        expect(deploymentLock).not.toBeNull();
        try {
            expect(reconcileReverseAcceptPreparation(configuration, PREPARATION_ID)).toEqual({
                reconcileState: "busy",
                deploymentId: DEPLOYMENT_UUID,
            });
        } finally {
            deploymentLock?.release();
        }

        let reads = 0;
        const disappears = {
            ...store,
            readMarker(preparationId: UuidV4) {
                reads += 1;
                return reads === 1 ? store.readMarker(preparationId) : ({ state: "missing" } as const);
            },
        };
        expect(
            reconcileReverseAcceptPreparationForTest(configuration, PREPARATION_ID, disappears, () => {
                throw new Error("facts must not be read");
            }),
        ).toMatchObject({ reconcileState: "scoped_freeze", deploymentId: DEPLOYMENT_UUID });

        reads = 0;
        const changesIdentity = {
            ...store,
            readMarker(preparationId: UuidV4) {
                reads += 1;
                const value = store.readMarker(preparationId);
                if (reads === 1 || value.state !== "available") return value;
                return {
                    state: "available" as const,
                    value: {
                        ...value.value,
                        identity: {
                            ...value.value.identity,
                            preparationIdentityFingerprint: HASH_A,
                        },
                    },
                };
            },
        };
        expect(
            reconcileReverseAcceptPreparationForTest(configuration, PREPARATION_ID, changesIdentity, () => {
                throw new Error("facts must not be read");
            }),
        ).toEqual({ reconcileState: "global_freeze" });

        const repairFails = {
            ...store,
            repairLocatorFromMarker() {
                throw new Error("locator repair failed");
            },
        };
        expect(
            reconcileReverseAcceptPreparationForTest(configuration, PREPARATION_ID, repairFails, () => {
                throw new Error("facts must not be read");
            }),
        ).toMatchObject({ reconcileState: "scoped_freeze", deploymentId: DEPLOYMENT_UUID });

        expect(
            await service.cancelRenderedTargetAccept({
                preparationId: PREPARATION_ID,
                expectedPreparationRevision: 1,
            }),
        ).toMatchObject({ status: "complete" });
        expect(reconcileReverseAcceptPreparation(configuration, PREPARATION_ID)).toEqual({
            reconcileState: "resolved",
            preparationState: "cancelled",
        });
    });

    it("converges a lost consumed-marker transition from exact post authorities", async () => {
        const store = await leaveClaimedAfterCommit(harness);

        const database = new Database(harness.databasePath);
        const row = database
            .prepare<[], { applied_inputs_snapshot: string }>(
                "SELECT applied_inputs_snapshot FROM deployments WHERE deployment_id = ?",
            )
            .get(DEPLOYMENT_UUID);
        if (row === undefined) throw new Error("Deployment snapshot fixture missing");
        const changedSnapshot = JSON.parse(row.applied_inputs_snapshot) as {
            assets: Array<{ allowIncomplete: boolean }>;
        };
        changedSnapshot.assets[0]!.allowIncomplete = !changedSnapshot.assets[0]!.allowIncomplete;
        database
            .prepare("UPDATE deployments SET applied_inputs_snapshot = ? WHERE deployment_id = ?")
            .run(stableStringify(changedSnapshot), DEPLOYMENT_UUID);
        database.close();
        expect(reconcileReverseAcceptPreparation(reconcileConfiguration(harness), PREPARATION_ID)).toMatchObject({
            reconcileState: "recovery_required",
            reasonCode: "database_postcondition_partial",
            preparationRevision: 3,
        });
        const restore = new Database(harness.databasePath);
        restore
            .prepare("UPDATE deployments SET applied_inputs_snapshot = ? WHERE deployment_id = ?")
            .run(row.applied_inputs_snapshot, DEPLOYMENT_UUID);
        restore.close();

        expect(reconcileReverseAcceptPreparation(reconcileConfiguration(harness), PREPARATION_ID)).toMatchObject({
            reconcileState: "retired",
            terminalState: "consumed",
            preparationRevision: 5,
        });
        const retiredScan = scanReverseAcceptReservations(
            harness.transactionsRoot,
            createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis)),
        );
        expect(reverseAcceptScanBlocksScope(retiredScan, { deploymentId: DEPLOYMENT_UUID })).toBe(false);
    });

    it("converges an unstarted publication to failed and then retires it", async () => {
        const store = await leaveClaimedBeforeFilesystem(harness);
        expect(reconcileReverseAcceptPreparation(reconcileConfiguration(harness), PREPARATION_ID)).toMatchObject({
            reconcileState: "retired",
            terminalState: "failed",
            preparationRevision: 4,
        });
        expect(store.readMarker(PREPARATION_ID)).toMatchObject({
            state: "available",
            value: {
                preparationState: "retired",
                retiredTerminalProof: { terminalState: "failed" },
            },
        });
    });

    it("moves contradictory failed and consumed terminals through recovery-required", async () => {
        await leaveClaimedBeforeFilesystem(harness);
        const store = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        const claimed = store.readMarker(PREPARATION_ID);
        if (claimed.state !== "available" || claimed.value.preparationState !== "claimed") {
            throw new Error("claimed fixture missing");
        }
        const failed = store.resolveRecovery(PREPARATION_ID, claimed.value.preparationRevision, claimed.value.markerFingerprint, {
            terminalState: "failed",
            filesystemTerminalProof: { filesystemTerminalState: "pre_authority" },
        });
        const intent = failed.intent;
        const receipt = buildDeploymentCommitReceipt({
            schemaVersion: 1,
            deploymentId: intent.expectedSuccessPostcondition.deploymentId,
            commitTransactionId: intent.expectedSuccessPostcondition.commitTransactionId,
            preCommitDatabaseStateFingerprint: intent.preCommitDatabaseStateFingerprint,
            appliedInputsSnapshotFingerprint: intent.appliedInputsSnapshotFingerprint,
            appliedRenderSnapshotFingerprint: intent.appliedRenderSnapshotFingerprint,
            deploymentFileBaselineSetFingerprint: intent.deploymentFileBaselineSetFingerprint,
        });
        expect(
            reconcileReverseAcceptPreparationForTest(reconcileConfiguration(harness), PREPARATION_ID, store, () => ({
                commitReceipt: receipt,
                receiptState: "exact",
                databaseState: "post",
                filesystemState: "post",
                assetFilesystemReceipt: buildAssetFilesystemCommitReceipt({
                    schemaVersion: 1,
                    preparationIdentityFingerprint: intent.preparationIdentityFingerprint,
                    stagedAssetId: intent.stagedAssetId,
                    stagedVersionId: intent.stagedVersionId,
                    stagedVersionFingerprint: intent.stagedVersionFingerprint,
                    stagedVersionOriginAuthorityFingerprint: intent.stagedVersionOriginAuthority.authorityFingerprint,
                    stagedPromotionPublication: intent.stagedPromotionPublication,
                    stagedAssetManifestFingerprint: intent.stagedAssetManifestFingerprint,
                    postAssetManifestAuthoritySetFingerprint: intent.expectedPostAssetManifestAuthoritySetFingerprint,
                }),
            })),
        ).toMatchObject({
            reconcileState: "recovery_required",
            reasonCode: "receipt_contradiction",
            preparationRevision: 4,
        });
        expect(
            reconcileReverseAcceptPreparationForTest(reconcileConfiguration(harness), PREPARATION_ID, store, () => ({
                commitReceipt: null,
                receiptState: "missing",
                databaseState: "pre",
                filesystemState: "old",
            })),
        ).toMatchObject({
            reconcileState: "retired",
            terminalState: "failed",
            preparationRevision: 6,
        });
        expect(reconcileReverseAcceptPreparation(reconcileConfiguration(harness), PREPARATION_ID)).toEqual({
            reconcileState: "resolved",
            preparationState: "retired",
        });

        const committedHarness = createHarness();
        try {
            const service = createReverseAcceptService(committedHarness.configuration());
            await prepare(service);
            expect((await service.commitRenderedTargetAccept(commitRequest(committedHarness.analysis))).status).toBe("complete");
            const committedStore = createReverseAcceptMarkerStore(
                committedHarness.transactionsRoot,
                exactAnalysisValidator(committedHarness.analysis),
            );
            const committedMarker = committedStore.readMarker(PREPARATION_ID);
            if (committedMarker.state !== "available" || committedMarker.value.preparationState !== "consumed") {
                throw new Error("consumed fixture missing");
            }
            const facts = readReverseAcceptReconcileFactsForTest(
                reconcileConfiguration(committedHarness),
                committedMarker.value.intent,
            );
            expect(
                reconcileReverseAcceptPreparationForTest(
                    reconcileConfiguration(committedHarness),
                    PREPARATION_ID,
                    committedStore,
                    () => ({
                        commitReceipt: null,
                        receiptState: "missing",
                        databaseState: "pre",
                        filesystemState: "old",
                    }),
                ),
            ).toMatchObject({
                reconcileState: "recovery_required",
                reasonCode: "receipt_contradiction",
                preparationRevision: 4,
            });
            expect(
                reconcileReverseAcceptPreparationForTest(
                    reconcileConfiguration(committedHarness),
                    PREPARATION_ID,
                    committedStore,
                    () => facts,
                ),
            ).toMatchObject({
                reconcileState: "retired",
                terminalState: "consumed",
                preparationRevision: 6,
            });
        } finally {
            fs.rmSync(committedHarness.root, { recursive: true, force: true });
        }
    });

    it("retires existing failed and consumed terminals only after exact production revalidation", async () => {
        await leaveClaimedBeforeFilesystem(harness);
        const failedStore = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        const claimed = failedStore.readMarker(PREPARATION_ID);
        if (claimed.state !== "available" || claimed.value.preparationState !== "claimed") {
            throw new Error("claimed fixture missing");
        }
        failedStore.resolveRecovery(PREPARATION_ID, claimed.value.preparationRevision, claimed.value.markerFingerprint, {
            terminalState: "failed",
            filesystemTerminalProof: { filesystemTerminalState: "pre_authority" },
        });
        expect(reconcileReverseAcceptPreparation(reconcileConfiguration(harness), PREPARATION_ID)).toMatchObject({
            reconcileState: "retired",
            terminalState: "failed",
            preparationRevision: 4,
        });

        const consumedHarness = createHarness();
        try {
            const service = createReverseAcceptService(consumedHarness.configuration());
            await prepare(service);
            expect((await service.commitRenderedTargetAccept(commitRequest(consumedHarness.analysis))).status).toBe("complete");
            expect(reconcileReverseAcceptPreparation(reconcileConfiguration(consumedHarness), PREPARATION_ID)).toMatchObject({
                reconcileState: "retired",
                terminalState: "consumed",
                preparationRevision: 4,
            });
        } finally {
            fs.rmSync(consumedHarness.root, { recursive: true, force: true });
        }
    });

    it("moves a failed terminal to recovery-required when its filesystem proof direction changed", async () => {
        await leaveClaimedBeforeFilesystem(harness);
        const store = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        const claimed = store.readMarker(PREPARATION_ID);
        if (claimed.state !== "available" || claimed.value.preparationState !== "claimed") {
            throw new Error("claimed fixture missing");
        }
        const failed = store.resolveRecovery(PREPARATION_ID, claimed.value.preparationRevision, claimed.value.markerFingerprint, {
            terminalState: "failed",
            filesystemTerminalProof: { filesystemTerminalState: "pre_authority" },
        });
        const intent = failed.intent;
        const filesystemReceipt = buildAssetFilesystemCommitReceipt({
            schemaVersion: 1,
            preparationIdentityFingerprint: intent.preparationIdentityFingerprint,
            stagedAssetId: intent.stagedAssetId,
            stagedVersionId: intent.stagedVersionId,
            stagedVersionFingerprint: intent.stagedVersionFingerprint,
            stagedVersionOriginAuthorityFingerprint: intent.stagedVersionOriginAuthority.authorityFingerprint,
            stagedPromotionPublication: intent.stagedPromotionPublication,
            stagedAssetManifestFingerprint: intent.stagedAssetManifestFingerprint,
            postAssetManifestAuthoritySetFingerprint: intent.expectedPostAssetManifestAuthoritySetFingerprint,
        });

        expect(
            reconcileReverseAcceptPreparationForTest(reconcileConfiguration(harness), PREPARATION_ID, store, () => ({
                commitReceipt: null,
                receiptState: "missing",
                databaseState: "pre",
                filesystemState: "post",
                assetFilesystemReceipt: filesystemReceipt,
            })),
        ).toMatchObject({
            reconcileState: "recovery_required",
            reasonCode: "asset_filesystem_mismatch",
            preparationRevision: 4,
        });
        expect(store.readMarker(PREPARATION_ID)).toMatchObject({
            state: "available",
            value: {
                preparationState: "recovery_required",
                evidence: [
                    {
                        evidenceKind: "asset_manifest",
                        observedState: "mismatch",
                        expectedFingerprint: intent.assetManifestAuthoritySetFingerprint,
                        observedFingerprint: intent.expectedPostAssetManifestAuthoritySetFingerprint,
                    },
                ],
            },
        });
        expect(
            reconcileReverseAcceptPreparationForTest(reconcileConfiguration(harness), PREPARATION_ID, store, () => ({
                commitReceipt: null,
                receiptState: "missing",
                databaseState: "pre",
                filesystemState: "old",
            })),
        ).toMatchObject({
            reconcileState: "retired",
            terminalState: "failed",
            preparationRevision: 6,
        });

        const stagedHarness = createHarness();
        try {
            await leaveClaimedBeforeFilesystem(stagedHarness);
            const stagedStore = createReverseAcceptMarkerStore(
                stagedHarness.transactionsRoot,
                exactAnalysisValidator(stagedHarness.analysis),
            );
            const stagedClaimed = stagedStore.readMarker(PREPARATION_ID);
            if (stagedClaimed.state !== "available" || stagedClaimed.value.preparationState !== "claimed") {
                throw new Error("claimed staged fixture missing");
            }
            const stagedIntent = stagedClaimed.value.intent;
            const stagedReceipt = buildAssetFilesystemCommitReceipt({
                schemaVersion: 1,
                preparationIdentityFingerprint: stagedIntent.preparationIdentityFingerprint,
                stagedAssetId: stagedIntent.stagedAssetId,
                stagedVersionId: stagedIntent.stagedVersionId,
                stagedVersionFingerprint: stagedIntent.stagedVersionFingerprint,
                stagedVersionOriginAuthorityFingerprint: stagedIntent.stagedVersionOriginAuthority.authorityFingerprint,
                stagedPromotionPublication: stagedIntent.stagedPromotionPublication,
                stagedAssetManifestFingerprint: stagedIntent.stagedAssetManifestFingerprint,
                postAssetManifestAuthoritySetFingerprint: stagedIntent.expectedPostAssetManifestAuthoritySetFingerprint,
            });
            stagedStore.resolveRecovery(
                PREPARATION_ID,
                stagedClaimed.value.preparationRevision,
                stagedClaimed.value.markerFingerprint,
                {
                    terminalState: "failed",
                    filesystemTerminalProof: {
                        filesystemTerminalState: "staged_manifest_published",
                        assetFilesystemReceipt: stagedReceipt,
                    },
                },
            );
            expect(
                reconcileReverseAcceptPreparationForTest(
                    reconcileConfiguration(stagedHarness),
                    PREPARATION_ID,
                    stagedStore,
                    () => ({
                        commitReceipt: null,
                        receiptState: "missing",
                        databaseState: "pre",
                        filesystemState: "old",
                    }),
                ),
            ).toMatchObject({
                reconcileState: "recovery_required",
                reasonCode: "asset_filesystem_mismatch",
                preparationRevision: 4,
            });
        } finally {
            fs.rmSync(stagedHarness.root, { recursive: true, force: true });
        }
    });

    it("persists receipt contradiction evidence and resolves it after facts are repaired", async () => {
        const store = await leaveClaimedBeforeFilesystem(harness);
        const wrongReceipt = buildDeploymentCommitReceipt({
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_UUID,
            commitTransactionId: TRANSACTION_UUID,
            preCommitDatabaseStateFingerprint: HASH_A,
            appliedInputsSnapshotFingerprint: HASH_A,
            appliedRenderSnapshotFingerprint: HASH_A,
            deploymentFileBaselineSetFingerprint: HASH_A,
        });
        const db = new Database(harness.databasePath);
        db.prepare(
            `INSERT INTO deployment_commit_receipts (
                schema_version, deployment_id, commit_transaction_id,
                pre_commit_database_state_fingerprint,
                applied_inputs_snapshot_fingerprint,
                applied_render_snapshot_fingerprint,
                deployment_file_baseline_set_fingerprint,
                commit_receipt_fingerprint
             ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            wrongReceipt.deploymentId,
            wrongReceipt.commitTransactionId,
            wrongReceipt.preCommitDatabaseStateFingerprint,
            wrongReceipt.appliedInputsSnapshotFingerprint,
            wrongReceipt.appliedRenderSnapshotFingerprint,
            wrongReceipt.deploymentFileBaselineSetFingerprint,
            wrongReceipt.commitReceiptFingerprint,
        );
        db.close();

        expect(reconcileReverseAcceptPreparation(reconcileConfiguration(harness), PREPARATION_ID)).toMatchObject({
            reconcileState: "recovery_required",
            reasonCode: "receipt_contradiction",
            preparationRevision: 3,
        });
        const repair = new Database(harness.databasePath);
        repair
            .prepare("DELETE FROM deployment_commit_receipts WHERE deployment_id = ? AND commit_transaction_id = ?")
            .run(DEPLOYMENT_UUID, TRANSACTION_UUID);
        repair.close();
        expect(reconcileReverseAcceptPreparation(reconcileConfiguration(harness), PREPARATION_ID)).toMatchObject({
            reconcileState: "retired",
            terminalState: "failed",
            preparationRevision: 5,
        });
        expect(store.readMarker(PREPARATION_ID)).toMatchObject({
            state: "available",
            value: { preparationState: "retired" },
        });
    });
});
