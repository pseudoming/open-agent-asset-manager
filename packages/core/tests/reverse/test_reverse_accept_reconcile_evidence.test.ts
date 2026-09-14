import { inventoryDirectoryNoFollow, SafeFilesystemError } from "@oaam/shared/filesystem";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readAssetManifest, writeAssetManifest } from "../../src/catalog/asset-manifest";
import { writePayload } from "../../src/catalog/payload-store";
import { buildPromotionGrantAuthority, serializePromotionGrant } from "../../src/catalog/promotion-grant-store";
import { readVersionAuthority } from "../../src/catalog/version-authority";
import { EMPTY_VERSION_DIALECT_REGISTRY } from "../../src/catalog/version-dialect-registry";
import { serializeVersionManifest } from "../../src/catalog/version-manifest";
import { buildDeploymentCommitReceipt } from "../../src/deployment/deployment-commit-receipts";
import { computeVersionCanonicalContentFingerprint, computeVersionFingerprint } from "../../src/foundation/fingerprint";
import { buildAssetFilesystemCommitReceipt, createReverseAcceptMarkerStore } from "../../src/reverse/reverse-accept-marker";
import {
    readReverseAcceptReconcileFactsForTest,
    reconcileReverseAcceptPreparation,
    reconcileReverseAcceptPreparationForTest,
    type ReverseAcceptReconcileFactsForTest,
} from "../../src/reverse/reverse-accept-reconcile";
import { makeTextFile } from "../catalog/fixtures/version-v2";
import {
    ASSET_UUID,
    commitRequest,
    createHarness,
    exactAnalysisValidator,
    harness,
    HASH_A,
    leaveClaimedAfterCommit,
    leaveClaimedBeforeFilesystem,
    PREPARATION_ID,
    reconcileConfiguration,
    STAGED_VERSION_ID,
} from "./fixtures/reverse-accept-commit-test-fixtures";

describe("reverse-accept reconcile evidence and durability", () => {
    it("applies receipt, database, and filesystem recovery priority with idempotent evidence", async () => {
        const store = await leaveClaimedBeforeFilesystem(harness);
        const claimedRead = store.readMarker(PREPARATION_ID);
        if (claimedRead.state !== "available" || claimedRead.value.preparationState !== "claimed") {
            throw new Error("claimed fixture missing");
        }
        const intent = claimedRead.value.intent;
        const exactReceipt = buildDeploymentCommitReceipt({
            schemaVersion: 1,
            deploymentId: intent.expectedSuccessPostcondition.deploymentId,
            commitTransactionId: intent.expectedSuccessPostcondition.commitTransactionId,
            preCommitDatabaseStateFingerprint: intent.preCommitDatabaseStateFingerprint,
            appliedInputsSnapshotFingerprint: intent.appliedInputsSnapshotFingerprint,
            appliedRenderSnapshotFingerprint: intent.appliedRenderSnapshotFingerprint,
            deploymentFileBaselineSetFingerprint: intent.deploymentFileBaselineSetFingerprint,
        });
        const configuration = reconcileConfiguration(harness);
        const receiptMismatch = () => ({
            commitReceipt: exactReceipt,
            receiptState: "mismatch" as const,
            receiptObservedFingerprint: HASH_A,
            databaseState: "pre" as const,
            filesystemState: "old" as const,
        });
        expect(reconcileReverseAcceptPreparationForTest(configuration, PREPARATION_ID, store, receiptMismatch)).toMatchObject({
            reconcileState: "recovery_required",
            reasonCode: "receipt_contradiction",
            preparationRevision: 3,
        });
        expect(reconcileReverseAcceptPreparationForTest(configuration, PREPARATION_ID, store, receiptMismatch)).toMatchObject({
            preparationRevision: 3,
        });

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
            reconcileReverseAcceptPreparationForTest(configuration, PREPARATION_ID, store, () => ({
                commitReceipt: exactReceipt,
                receiptState: "exact",
                databaseState: "other",
                databaseEvidence: {
                    reasonCode: "database_postcondition_partial",
                    evidence: [
                        {
                            evidenceKind: "database_postcondition",
                            postconditionKind: "applied_inputs_snapshot",
                            observedState: "mismatch",
                            expectedFingerprint: intent.appliedInputsSnapshotFingerprint,
                            observedFingerprint: HASH_A,
                        },
                    ],
                },
                filesystemState: "post",
                assetFilesystemReceipt: filesystemReceipt,
            })),
        ).toMatchObject({
            reasonCode: "database_postcondition_partial",
            preparationRevision: 4,
        });
        expect(
            reconcileReverseAcceptPreparationForTest(configuration, PREPARATION_ID, store, () => ({
                commitReceipt: null,
                receiptState: "missing",
                databaseState: "pre",
                filesystemState: "other",
                filesystemEvidence: {
                    reasonCode: "asset_filesystem_mismatch",
                    evidence: [
                        {
                            evidenceKind: "immutable_version",
                            observedState: "missing",
                            expectedFingerprint: intent.stagedVersionFingerprint,
                        },
                    ],
                },
            })),
        ).toMatchObject({
            reasonCode: "asset_filesystem_mismatch",
            preparationRevision: 5,
        });
        expect(
            reconcileReverseAcceptPreparationForTest(configuration, PREPARATION_ID, store, () => ({
                commitReceipt: null,
                receiptState: "missing",
                databaseState: "pre",
                filesystemState: "old",
            })),
        ).toMatchObject({
            reconcileState: "retired",
            terminalState: "failed",
            preparationRevision: 7,
        });
    });

    it("maps post-authority durability failures and never treats visible bytes as durable proof", async () => {
        const store = await leaveClaimedAfterCommit(harness);
        const claimed = store.readMarker(PREPARATION_ID);
        if (claimed.state !== "available" || claimed.value.preparationState !== "claimed") {
            throw new Error("claimed post-authority fixture missing");
        }
        const configuration = reconcileConfiguration(harness);
        const cases = [
            ["io_error", "flush_failed"],
            ["stale", "identity_changed"],
            ["unsupported_platform", "platform_unconfirmed"],
        ] as const;
        for (const [failureKind, expectedFailureKind] of cases) {
            const facts = readReverseAcceptReconcileFactsForTest(configuration, claimed.value.intent, {
                inventoryDirectory: inventoryDirectoryNoFollow,
                confirmFile(filePath) {
                    throw new SafeFilesystemError({
                        failureKind,
                        operation: "confirm_durable_file",
                        targetPath: filePath,
                        message: "injected durability confirmation failure",
                    });
                },
                confirmDirectory() {
                    throw new Error("directory confirmation must not follow a file failure");
                },
            });
            expect(facts).toMatchObject({
                receiptState: "exact",
                databaseState: "post",
                filesystemState: "other",
                filesystemEvidence: {
                    reasonCode: "durability_unconfirmed",
                    evidence: [{ failureKind: expectedFailureKind }],
                },
            });
            expect(reconcileReverseAcceptPreparationForTest(configuration, PREPARATION_ID, store, () => facts)).toMatchObject({
                reconcileState: "recovery_required",
                reasonCode: "durability_unconfirmed",
            });
        }

        const directoryFacts = readReverseAcceptReconcileFactsForTest(configuration, claimed.value.intent, {
            inventoryDirectory: inventoryDirectoryNoFollow,
            confirmFile() {},
            confirmDirectory(directoryPath) {
                throw new SafeFilesystemError({
                    failureKind: "symlink_or_reparse",
                    operation: "confirm_durable_directory",
                    targetPath: directoryPath,
                    message: "injected directory identity replacement",
                });
            },
        });
        expect(directoryFacts.filesystemEvidence).toMatchObject({
            reasonCode: "durability_unconfirmed",
            evidence: [{ failureKind: "identity_changed" }],
        });
        expect(
            reconcileReverseAcceptPreparationForTest(configuration, PREPARATION_ID, store, () => directoryFacts),
        ).toMatchObject({ reasonCode: "durability_unconfirmed" });

        const plainErrorFacts = readReverseAcceptReconcileFactsForTest(configuration, claimed.value.intent, {
            inventoryDirectory: inventoryDirectoryNoFollow,
            confirmFile() {
                throw new Error("injected non-filesystem flush failure");
            },
            confirmDirectory() {},
        });
        expect(plainErrorFacts.filesystemEvidence).toMatchObject({
            reasonCode: "durability_unconfirmed",
            evidence: [{ failureKind: "flush_failed" }],
        });

        const beforeLateMutation = readAssetManifest(harness.assetsRoot, ASSET_UUID);
        if (beforeLateMutation === null) throw new Error("post Asset fixture missing");
        let mutatedAfterConfirmation = false;
        const lateMutationFacts = readReverseAcceptReconcileFactsForTest(configuration, claimed.value.intent, {
            inventoryDirectory: inventoryDirectoryNoFollow,
            confirmFile() {},
            confirmDirectory(directoryPath) {
                if (!mutatedAfterConfirmation && directoryPath === configuration.assetsRoot) {
                    writeAssetManifest(harness.assetsRoot, {
                        ...beforeLateMutation,
                        displayName: `${beforeLateMutation.displayName} late mutation`,
                    });
                    mutatedAfterConfirmation = true;
                }
            },
        });
        expect(mutatedAfterConfirmation).toBe(true);
        expect(lateMutationFacts).toMatchObject({
            filesystemState: "other",
            filesystemEvidence: { reasonCode: "asset_filesystem_mismatch" },
        });
        writeAssetManifest(harness.assetsRoot, beforeLateMutation);

        const inventoryFacts = readReverseAcceptReconcileFactsForTest(configuration, claimed.value.intent, {
            inventoryDirectory(directoryPath) {
                throw new SafeFilesystemError({
                    failureKind: "stale",
                    operation: "inventory_directory",
                    targetPath: directoryPath,
                    message: "injected Version inventory replacement",
                });
            },
            confirmFile() {
                throw new Error("file confirmation must not follow inventory failure");
            },
            confirmDirectory() {
                throw new Error("directory confirmation must not follow inventory failure");
            },
        });
        expect(inventoryFacts.filesystemEvidence).toMatchObject({
            reasonCode: "durability_unconfirmed",
            evidence: [{ evidenceKind: "immutable_version", failureKind: "identity_changed" }],
        });

        expect(reconcileReverseAcceptPreparation(configuration, PREPARATION_ID)).toMatchObject({
            reconcileState: "retired",
            terminalState: "consumed",
        });
    });

    it("classifies production database and filesystem corruption without guessing a terminal", async () => {
        await leaveClaimedAfterCommit(harness);
        const store = createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
        const claimed = store.readMarker(PREPARATION_ID);
        if (claimed.state !== "available" || claimed.value.preparationState !== "claimed") {
            throw new Error("claimed post-authority fixture missing");
        }
        const configuration = reconcileConfiguration(harness);
        const missingDatabaseFacts = readReverseAcceptReconcileFactsForTest(
            { ...configuration, databasePath: path.join(harness.root, "missing.sqlite") },
            claimed.value.intent,
        );
        expect(missingDatabaseFacts).toMatchObject({
            receiptState: "unreadable",
            databaseState: "unreadable",
            filesystemState: "post",
        });

        const currentAsset = readAssetManifest(harness.assetsRoot, ASSET_UUID);
        if (currentAsset === null) throw new Error("post Asset fixture missing");
        writeAssetManifest(harness.assetsRoot, {
            ...currentAsset,
            displayName: `${currentAsset.displayName} externally changed`,
        });
        expect(readReverseAcceptReconcileFactsForTest(configuration, claimed.value.intent)).toMatchObject({
            filesystemState: "other",
            filesystemEvidence: { reasonCode: "asset_filesystem_mismatch" },
        });
        writeAssetManifest(harness.assetsRoot, currentAsset);

        const versionRoot = path.join(harness.assetsRoot, ASSET_UUID, "versions", STAGED_VERSION_ID);
        const currentVersion = readVersionAuthority(
            harness.assetsRoot,
            ASSET_UUID,
            STAGED_VERSION_ID,
            EMPTY_VERSION_DIALECT_REGISTRY,
        );
        if (currentVersion === null) throw new Error("post Version fixture missing");
        const replacementFile = makeTextFile("# different valid Version\n");
        writePayload(versionRoot, replacementFile.text, "text");
        const replacementManifest = structuredClone(currentVersion.manifest);
        replacementManifest.files = [replacementFile.file];
        replacementManifest.versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(
            replacementManifest,
            replacementManifest.files,
        );
        replacementManifest.fingerprint = computeVersionFingerprint(
            replacementManifest.versionCanonicalContentFingerprint,
            replacementManifest.nativeRepresentations,
            replacementManifest.dialectRestorationPayloads,
            replacementManifest.portableDialectContracts,
        );
        fs.writeFileSync(path.join(versionRoot, "version.json"), serializeVersionManifest(replacementManifest));
        expect(readReverseAcceptReconcileFactsForTest(configuration, claimed.value.intent)).toMatchObject({
            filesystemState: "other",
            filesystemEvidence: { reasonCode: "asset_filesystem_mismatch" },
        });
        fs.writeFileSync(path.join(versionRoot, "version.json"), serializeVersionManifest(currentVersion.manifest));

        fs.writeFileSync(path.join(versionRoot, "version.json"), "{corrupt");
        expect(readReverseAcceptReconcileFactsForTest(configuration, claimed.value.intent)).toMatchObject({
            filesystemState: "unreadable",
            filesystemEvidence: { reasonCode: "asset_filesystem_mismatch" },
        });
        fs.writeFileSync(path.join(versionRoot, "version.json"), serializeVersionManifest(currentVersion.manifest));

        const restricted = createHarness("requires_current_authorization");
        try {
            const request = commitRequest(restricted.analysis);
            request.newVersionPromotion = {
                promotionAction: "grant_staged_version_current_target",
            };
            const restrictedStore = await leaveClaimedAfterCommit(restricted, request);
            const restrictedClaimed = restrictedStore.readMarker(PREPARATION_ID);
            if (
                restrictedClaimed.state !== "available" ||
                restrictedClaimed.value.preparationState !== "claimed" ||
                restrictedClaimed.value.intent.stagedPromotionPublication.publicationState !== "version_target_grant"
            ) {
                throw new Error("claimed promotion-grant fixture missing");
            }
            const grant = restrictedClaimed.value.intent.stagedPromotionPublication.promotionGrant;
            const replacementGrant = buildPromotionGrantAuthority({
                promotionGrantId: grant.promotionGrantId,
                subject: grant.subject,
                target: grant.target,
                userActionEvidenceId: "different-user-action",
                updatedAt: grant.updatedAt + 1,
            });
            fs.writeFileSync(
                path.join(restricted.assetsRoot, ASSET_UUID, "promotion-grants", `${grant.promotionGrantId}.json`),
                serializePromotionGrant(replacementGrant),
            );
            expect(
                readReverseAcceptReconcileFactsForTest(reconcileConfiguration(restricted), restrictedClaimed.value.intent),
            ).toMatchObject({
                filesystemState: "other",
                filesystemEvidence: { reasonCode: "asset_filesystem_mismatch" },
            });
            fs.writeFileSync(
                path.join(restricted.assetsRoot, ASSET_UUID, "promotion-grants", `${grant.promotionGrantId}.json`),
                serializePromotionGrant(grant),
            );
            const restoredClaimed = restrictedStore.readMarker(PREPARATION_ID);
            if (restoredClaimed.state !== "available" || restoredClaimed.value.preparationState !== "claimed") {
                throw new Error("restored promotion-grant fixture is not claimed");
            }
            const recovery = restrictedStore.markRecoveryRequired(
                PREPARATION_ID,
                restoredClaimed.value.preparationRevision,
                restoredClaimed.value.markerFingerprint,
                {
                    reasonCode: "asset_filesystem_mismatch",
                    evidence: [
                        {
                            evidenceKind: "promotion_grant",
                            observedState: "missing",
                            expectedFingerprint: grant.grantFingerprint,
                        },
                    ],
                },
            );
            expect(recovery.preparationState).toBe("recovery_required");
            expect(reconcileReverseAcceptPreparation(reconcileConfiguration(restricted), PREPARATION_ID)).toMatchObject({
                reconcileState: "retired",
                terminalState: "consumed",
            });
        } finally {
            fs.rmSync(restricted.root, { recursive: true, force: true });
        }
    });

    it("reconfirms an accumulated residual payload before retiring a lost commit acknowledgement", async () => {
        const residualHarness = createHarness("not_required", false, true);
        try {
            const store = await leaveClaimedAfterCommit(residualHarness);
            const claimed = store.readMarker(PREPARATION_ID);
            if (claimed.state !== "available" || claimed.value.preparationState !== "claimed") {
                throw new Error("claimed residual fixture missing");
            }
            const residual = claimed.value.intent.expectedSuccessPostcondition.residualAuthorities[0];
            if (residual === undefined) throw new Error("residual authority fixture missing");
            const recovery = store.markRecoveryRequired(
                PREPARATION_ID,
                claimed.value.preparationRevision,
                claimed.value.markerFingerprint,
                {
                    reasonCode: "durability_unconfirmed",
                    evidence: [
                        {
                            evidenceKind: "durable_payload",
                            observedState: "durability_unconfirmed",
                            expectedFingerprint: residual.appliedPayload.contentHash,
                            failureKind: "flush_failed",
                        },
                    ],
                },
            );
            expect(recovery.preparationState).toBe("recovery_required");
            expect(reconcileReverseAcceptPreparation(reconcileConfiguration(residualHarness), PREPARATION_ID)).toMatchObject({
                reconcileState: "retired",
                terminalState: "consumed",
            });
        } finally {
            fs.rmSync(residualHarness.root, { recursive: true, force: true });
        }
    });

    it("fails closed for every classifier fallback and inconsistent injected fact set", async () => {
        const store = await leaveClaimedBeforeFilesystem(harness);
        const claimed = store.readMarker(PREPARATION_ID);
        if (claimed.state !== "available" || claimed.value.preparationState !== "claimed") {
            throw new Error("claimed fixture missing");
        }
        const intent = claimed.value.intent;
        const configuration = reconcileConfiguration(harness);
        const exactReceipt = buildDeploymentCommitReceipt({
            schemaVersion: 1,
            deploymentId: intent.expectedSuccessPostcondition.deploymentId,
            commitTransactionId: intent.expectedSuccessPostcondition.commitTransactionId,
            preCommitDatabaseStateFingerprint: intent.preCommitDatabaseStateFingerprint,
            appliedInputsSnapshotFingerprint: intent.appliedInputsSnapshotFingerprint,
            appliedRenderSnapshotFingerprint: intent.appliedRenderSnapshotFingerprint,
            deploymentFileBaselineSetFingerprint: intent.deploymentFileBaselineSetFingerprint,
        });
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
        const classify = (facts: ReverseAcceptReconcileFactsForTest) =>
            reconcileReverseAcceptPreparationForTest(configuration, PREPARATION_ID, store, () => facts);

        expect(
            classify({
                commitReceipt: exactReceipt,
                receiptState: "exact",
                databaseState: "other",
                filesystemState: "post",
                assetFilesystemReceipt: filesystemReceipt,
            }),
        ).toMatchObject({ reasonCode: "database_postcondition_partial" });
        expect(
            classify({
                commitReceipt: exactReceipt,
                receiptState: "exact",
                databaseState: "post",
                filesystemState: "other",
            }),
        ).toMatchObject({ reasonCode: "asset_filesystem_mismatch" });
        expect(
            classify({
                commitReceipt: null,
                receiptState: "missing",
                databaseState: "post",
                filesystemState: "old",
            }),
        ).toMatchObject({ reasonCode: "receipt_contradiction" });
        expect(
            classify({
                commitReceipt: null,
                receiptState: "missing",
                databaseState: "other",
                filesystemState: "old",
            }),
        ).toMatchObject({ reasonCode: "database_postcondition_partial" });
        expect(
            classify({
                commitReceipt: null,
                receiptState: "missing",
                databaseState: "pre",
                filesystemState: "other",
            }),
        ).toMatchObject({ reasonCode: "asset_filesystem_mismatch" });
        expect(
            classify({
                commitReceipt: null,
                receiptState: "unreadable",
                databaseState: "pre",
                filesystemState: "old",
            }),
        ).toMatchObject({ reasonCode: "receipt_contradiction" });

        expect(() =>
            classify({
                commitReceipt: null,
                receiptState: "exact",
                databaseState: "post",
                filesystemState: "post",
                assetFilesystemReceipt: filesystemReceipt,
            }),
        ).toThrow("exact receipt disappeared from fact set");
        expect(() =>
            classify({
                commitReceipt: null,
                receiptState: "missing",
                databaseState: "pre",
                filesystemState: "post",
            }),
        ).toThrow("post filesystem receipt disappeared from fact set");
        expect(
            classify({
                commitReceipt: null,
                receiptState: "missing",
                databaseState: "pre",
                filesystemState: "post",
                assetFilesystemReceipt: filesystemReceipt,
            }),
        ).toMatchObject({ reconcileState: "retired", terminalState: "failed" });
    });
});
