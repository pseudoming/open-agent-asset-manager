/** Prepared Deployment success authority and crash-durable commit execution. */

import Database from "better-sqlite3";
import type { Database as DatabaseConnection } from "better-sqlite3";
import type { UuidV4 } from "../contracts/primitives";
import {
    buildDeploymentCommitReceipt,
    insertDeploymentCommitReceiptInCurrentTransaction,
    readDeploymentCommitReceiptFromConnection,
    receiptsAreExact,
    validateDeploymentCommitReceipt,
} from "./deployment-commit-receipts";
import { validateAppliedInputsSnapshot, validateAppliedRenderSnapshot } from "../render/deployment-render-authority";
import {
    assertCurrentDeploymentInputs,
    commitDeploymentSuccess,
    type DeploymentSuccessCommitInputV1,
} from "./deployment-state-ops";
import {
    computeAppliedInputsSnapshotFingerprint,
    computeAppliedRenderSnapshotFingerprint,
    computeDeploymentFileBaselineSetFingerprint,
    computePreCommitDatabaseStateFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import {
    runDedicatedFullTransaction,
    runDedicatedFullTransactionForTest,
    type FullTransactionLifecycleHooks,
    type FullTransactionOperation,
} from "../persistence/full-transaction-connection";
import { listDeploymentAssets, upsertDeploymentAsset } from "../persistence/state-db";
import { hasExactKeys, isStrictObject } from "../foundation/validators";
import type {
    CanonicalDeploymentPreCommitDatabaseStateV1,
    PreparedDeploymentSuccessAuthorityV1,
    CommitReverseAcceptSuccessCrashDurableInput,
    ReverseAcceptDeploymentAssetVersionTransitionV1,
    CommitReverseAcceptVersionSelectionSuccessCrashDurableInput,
    CommitReverseAcceptSuccessCrashDurableResult,
} from "./deployment-state-authority-model";
import {
    readCanonicalPreStateFromConnection,
    projectExpectedSuccessPostcondition,
    readSuccessPostconditionFromConnection,
} from "./deployment-state-authority-projection";
import {
    validateDeploymentSuccessPostcondition,
    validateCanonicalPreState,
    requireExactAuthority,
    requireExactReceiptLookup,
    requireUuid,
    requireDatabasePath,
} from "./deployment-state-authority-validation";

export interface DeploymentStateAuthorityHooks {
    afterPreStateCas?(db: DatabaseConnection): void;
    afterSuccessMutation?(db: DatabaseConnection): void;
    beforeReceiptInsert?(db: DatabaseConnection): void;
    afterReceiptInsert?(db: DatabaseConnection): void;
}

export interface DeploymentStateAuthorityTestHooks extends DeploymentStateAuthorityHooks {
    fullTransaction?: FullTransactionLifecycleHooks<CommitReverseAcceptSuccessCrashDurableResult>;
}

/** Build the exact pre-state/post-state/receipt proof bundle without mutating DB. */
export function prepareDeploymentSuccessAuthority(
    databasePath: string,
    successCommit: DeploymentSuccessCommitInputV1,
): PreparedDeploymentSuccessAuthorityV1 {
    return prepareDeploymentSuccessAuthorityCore(databasePath, successCommit, null);
}

/**
 * Prepare the exact DB proof for reverse accept. The old DeploymentAsset row
 * remains untouched here; the intended Version transition is validated against
 * the canonical pre-state and applied only inside the later FULL transaction.
 */
export function prepareReverseAcceptDeploymentSuccessAuthority(
    databasePath: string,
    successCommit: DeploymentSuccessCommitInputV1,
    deploymentAssetTransition: ReverseAcceptDeploymentAssetVersionTransitionV1,
): PreparedDeploymentSuccessAuthorityV1 {
    return prepareDeploymentSuccessAuthorityCore(databasePath, successCommit, deploymentAssetTransition);
}

export function prepareDeploymentSuccessAuthorityCore(
    databasePath: string,
    successCommit: DeploymentSuccessCommitInputV1,
    deploymentAssetTransition: ReverseAcceptDeploymentAssetVersionTransitionV1 | null,
): PreparedDeploymentSuccessAuthorityV1 {
    requireDatabasePath(databasePath);
    requireUuid(successCommit.deploymentId, "deploymentId");
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
        const deploymentId = successCommit.deploymentId as UuidV4;
        const preCommitDatabaseState = readCanonicalPreStateFromConnection(db, deploymentId);
        validateDeploymentAssetTransition(preCommitDatabaseState, successCommit, deploymentAssetTransition);
        const expectedSuccessPostcondition = projectExpectedSuccessPostcondition(
            db,
            successCommit,
            preCommitDatabaseState,
            deploymentAssetTransition !== null,
        );
        const commitReceipt = buildDeploymentCommitReceipt({
            schemaVersion: 1,
            deploymentId,
            commitTransactionId: successCommit.transactionId as UuidV4,
            preCommitDatabaseStateFingerprint: computePreCommitDatabaseStateFingerprint(preCommitDatabaseState),
            appliedInputsSnapshotFingerprint: computeAppliedInputsSnapshotFingerprint(successCommit.appliedInputsSnapshot),
            appliedRenderSnapshotFingerprint: computeAppliedRenderSnapshotFingerprint(successCommit.appliedRenderSnapshot),
            deploymentFileBaselineSetFingerprint: computeDeploymentFileBaselineSetFingerprint(expectedSuccessPostcondition),
        });
        return {
            preCommitDatabaseState,
            expectedSuccessPostcondition,
            commitReceipt,
        };
    } finally {
        db.close();
    }
}

export function commitReverseAcceptSuccessCrashDurable(
    input: CommitReverseAcceptSuccessCrashDurableInput,
): CommitReverseAcceptSuccessCrashDurableResult {
    return commitReverseAcceptSuccessCrashDurableCore(input, null, {}, runDedicatedFullTransaction);
}

export function commitReverseAcceptVersionSelectionSuccessCrashDurable(
    input: CommitReverseAcceptVersionSelectionSuccessCrashDurableInput,
): CommitReverseAcceptSuccessCrashDurableResult {
    return commitReverseAcceptSuccessCrashDurableCore(input, input.deploymentAssetTransition, {}, runDedicatedFullTransaction);
}

/** Test-only crash/fault seam. Production orchestration must call the function above. */
export function commitReverseAcceptSuccessCrashDurableForTest(
    input: CommitReverseAcceptSuccessCrashDurableInput,
    hooks: DeploymentStateAuthorityTestHooks,
): CommitReverseAcceptSuccessCrashDurableResult {
    return commitReverseAcceptSuccessCrashDurableCore(input, null, hooks, (databasePath, operation) =>
        runDedicatedFullTransactionForTest(databasePath, operation, hooks.fullTransaction ?? {}),
    );
}

/** Test-only crash/fault seam for the reverse Version-selection branch. */
export function commitReverseAcceptVersionSelectionSuccessCrashDurableForTest(
    input: CommitReverseAcceptVersionSelectionSuccessCrashDurableInput,
    hooks: DeploymentStateAuthorityTestHooks,
): CommitReverseAcceptSuccessCrashDurableResult {
    return commitReverseAcceptSuccessCrashDurableCore(input, input.deploymentAssetTransition, hooks, (databasePath, operation) =>
        runDedicatedFullTransactionForTest(databasePath, operation, hooks.fullTransaction ?? {}),
    );
}

export type FullTransactionRunner = (
    databasePath: string,
    operation: FullTransactionOperation<CommitReverseAcceptSuccessCrashDurableResult>,
) => CommitReverseAcceptSuccessCrashDurableResult;

export function commitReverseAcceptSuccessCrashDurableCore(
    sourceInput: CommitReverseAcceptSuccessCrashDurableInput,
    deploymentAssetTransition: ReverseAcceptDeploymentAssetVersionTransitionV1 | null,
    hooks: DeploymentStateAuthorityHooks,
    runTransaction: FullTransactionRunner,
): CommitReverseAcceptSuccessCrashDurableResult {
    const input = structuredClone(sourceInput);
    validateCommitInput(input, deploymentAssetTransition);
    const expected = input.preparedAuthority;
    const expectedReceipt = expected.commitReceipt;
    const operation: FullTransactionOperation<CommitReverseAcceptSuccessCrashDurableResult> = {
        mutate(db) {
            const existing = readDeploymentCommitReceiptFromConnection(
                db,
                expectedReceipt.deploymentId,
                expectedReceipt.commitTransactionId,
            );
            if (existing.receiptState === "available") {
                if (!receiptsAreExact(existing.receipt, expectedReceipt)) {
                    throw new Error("existing DeploymentCommitReceipt contradicts expected receipt");
                }
                const postcondition = readSuccessPostconditionFromConnection(
                    db,
                    expectedReceipt.deploymentId,
                    expectedReceipt.commitTransactionId,
                );
                requireExactAuthority(postcondition, expected.expectedSuccessPostcondition, "existing receipt postcondition");
                assertCurrentDeploymentInputs(db, expectedReceipt.deploymentId, input.successCommit.appliedInputsSnapshot);
                return {
                    commitState: "already_committed",
                    commitReceipt: existing.receipt,
                    successPostcondition: postcondition,
                };
            }

            const currentPreState = readCanonicalPreStateFromConnection(db, expectedReceipt.deploymentId);
            requireExactAuthority(currentPreState, expected.preCommitDatabaseState, "pre-commit database state CAS");
            hooks.afterPreStateCas?.(db);

            if (deploymentAssetTransition !== null) {
                applyDeploymentAssetTransition(
                    db,
                    expected.preCommitDatabaseState,
                    input.successCommit,
                    deploymentAssetTransition,
                );
            }

            commitDeploymentSuccess(db, input.successCommit);
            hooks.afterSuccessMutation?.(db);
            const postcondition = readSuccessPostconditionFromConnection(
                db,
                expectedReceipt.deploymentId,
                expectedReceipt.commitTransactionId,
            );
            requireExactAuthority(postcondition, expected.expectedSuccessPostcondition, "success postcondition");
            hooks.beforeReceiptInsert?.(db);
            insertDeploymentCommitReceiptInCurrentTransaction(db, expectedReceipt);
            hooks.afterReceiptInsert?.(db);
            const reopened = requireExactReceiptLookup(
                readDeploymentCommitReceiptFromConnection(db, expectedReceipt.deploymentId, expectedReceipt.commitTransactionId),
                expectedReceipt,
                "inside final transaction",
            );
            return {
                commitState: "committed",
                commitReceipt: reopened,
                successPostcondition: postcondition,
            };
        },
        verifyAfterCommit(db, result) {
            const receipt = requireExactReceiptLookup(
                readDeploymentCommitReceiptFromConnection(db, expectedReceipt.deploymentId, expectedReceipt.commitTransactionId),
                expectedReceipt,
                "post-COMMIT",
            );
            const postcondition = readSuccessPostconditionFromConnection(
                db,
                expectedReceipt.deploymentId,
                expectedReceipt.commitTransactionId,
            );
            requireExactAuthority(postcondition, expected.expectedSuccessPostcondition, "post-COMMIT success postcondition");
            assertCurrentDeploymentInputs(db, expectedReceipt.deploymentId, input.successCommit.appliedInputsSnapshot);
            requireExactAuthority(result.commitReceipt, receipt, "returned commit receipt");
            requireExactAuthority(result.successPostcondition, postcondition, "returned success postcondition");
        },
    };
    return runTransaction(input.databasePath, operation);
}

export function validateCommitInput(
    input: CommitReverseAcceptSuccessCrashDurableInput,
    deploymentAssetTransition: ReverseAcceptDeploymentAssetVersionTransitionV1 | null,
): void {
    requireDatabasePath(input.databasePath);
    if (!isStrictObject(input.successCommit) || !isStrictObject(input.preparedAuthority)) {
        throw new Error("reverse success commit input must be exact authority objects");
    }
    validateCanonicalPreState(input.preparedAuthority.preCommitDatabaseState);
    validateDeploymentSuccessPostcondition(input.preparedAuthority.expectedSuccessPostcondition);
    validateDeploymentCommitReceipt(input.preparedAuthority.commitReceipt);
    validateAppliedInputsSnapshot(input.successCommit.appliedInputsSnapshot);
    validateAppliedRenderSnapshot(input.successCommit.appliedRenderSnapshot);
    requireUuid(input.successCommit.deploymentId, "success deploymentId");
    requireUuid(input.successCommit.transactionId, "success transactionId");
    const receipt = input.preparedAuthority.commitReceipt;
    if (
        receipt.deploymentId !== input.successCommit.deploymentId ||
        receipt.commitTransactionId !== input.successCommit.transactionId ||
        input.preparedAuthority.preCommitDatabaseState.deployment.deploymentId !== receipt.deploymentId ||
        input.preparedAuthority.expectedSuccessPostcondition.deploymentId !== receipt.deploymentId ||
        input.preparedAuthority.expectedSuccessPostcondition.commitTransactionId !== receipt.commitTransactionId
    ) {
        throw new Error("reverse success authority identities do not join exactly");
    }
    if (
        computePreCommitDatabaseStateFingerprint(input.preparedAuthority.preCommitDatabaseState) !==
            receipt.preCommitDatabaseStateFingerprint ||
        computeAppliedInputsSnapshotFingerprint(input.successCommit.appliedInputsSnapshot) !==
            receipt.appliedInputsSnapshotFingerprint ||
        computeAppliedRenderSnapshotFingerprint(input.successCommit.appliedRenderSnapshot) !==
            receipt.appliedRenderSnapshotFingerprint ||
        computeDeploymentFileBaselineSetFingerprint(input.preparedAuthority.expectedSuccessPostcondition) !==
            receipt.deploymentFileBaselineSetFingerprint
    ) {
        throw new Error("reverse success prepared authority fingerprint join is invalid");
    }
    validateDeploymentAssetTransition(
        input.preparedAuthority.preCommitDatabaseState,
        input.successCommit,
        deploymentAssetTransition,
    );
}

export function validateDeploymentAssetTransition(
    preState: CanonicalDeploymentPreCommitDatabaseStateV1,
    successCommit: DeploymentSuccessCommitInputV1,
    transition: ReverseAcceptDeploymentAssetVersionTransitionV1 | null,
): void {
    if (transition === null) return;
    if (!isStrictObject(transition) || !hasExactKeys(transition, ["assetId", "previousVersionId", "stagedVersionId"])) {
        throw new Error("reverse DeploymentAsset transition must be an exact object");
    }
    requireUuid(transition.assetId, "transition assetId");
    requireUuid(transition.previousVersionId, "transition previousVersionId");
    requireUuid(transition.stagedVersionId, "transition stagedVersionId");
    if (transition.previousVersionId === transition.stagedVersionId) {
        throw new Error("reverse DeploymentAsset transition must advance the Version");
    }
    if (
        successCommit.deploymentId !== preState.deployment.deploymentId ||
        successCommit.appliedInputsSnapshot.deploymentId !== preState.deployment.deploymentId
    ) {
        throw new Error("reverse DeploymentAsset transition belongs to another Deployment");
    }
    const active = preState.deploymentAssets.filter((item) => !item.deleted && item.assetId === transition.assetId);
    if (active.length !== 1 || active[0]?.versionId !== transition.previousVersionId) {
        throw new Error("reverse DeploymentAsset transition has no exact active old Version");
    }
    const expectedConsumers = preState.deployment.consumerAgentRuntimeIds;
    if (stableStringify(successCommit.appliedInputsSnapshot.consumerAgentRuntimeIds) !== stableStringify(expectedConsumers)) {
        throw new Error("reverse AppliedInputsSnapshot changes Deployment consumers");
    }
    const expectedAssets = preState.deploymentAssets
        .filter((item) => !item.deleted)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((item) => ({
            assetId: item.assetId,
            versionId: item.assetId === transition.assetId ? transition.stagedVersionId : item.versionId,
            allowIncomplete: item.allowIncomplete,
        }));
    if (stableStringify(successCommit.appliedInputsSnapshot.assets) !== stableStringify(expectedAssets)) {
        throw new Error("reverse AppliedInputsSnapshot is not the exact one-Version Deployment transition");
    }
}

export function applyDeploymentAssetTransition(
    db: DatabaseConnection,
    preState: CanonicalDeploymentPreCommitDatabaseStateV1,
    successCommit: DeploymentSuccessCommitInputV1,
    transition: ReverseAcceptDeploymentAssetVersionTransitionV1,
): void {
    const expected = preState.deploymentAssets.find(
        (item) => !item.deleted && item.assetId === transition.assetId,
    ) as CanonicalDeploymentPreCommitDatabaseStateV1["deploymentAssets"][number];
    const current = listDeploymentAssets(db, preState.deployment.deploymentId, true).find(
        (item) => item.assetId === transition.assetId,
    );
    if (
        current === undefined ||
        stableStringify({
            deploymentAssetId: current.deploymentAssetId,
            assetId: current.assetId,
            versionId: current.versionId,
            sortOrder: current.sortOrder,
            allowIncomplete: current.allowIncomplete === 1,
            deleted: current.deleted === 1,
            createdAt: current.createdAt,
            updatedAt: current.updatedAt,
        }) !== stableStringify(expected)
    ) {
        throw new Error("reverse DeploymentAsset transition lost its exact old authority");
    }
    if (successCommit.now < current.updatedAt) {
        throw new Error("reverse DeploymentAsset transition time precedes current authority");
    }
    upsertDeploymentAsset(
        db,
        preState.deployment.deploymentId,
        transition.assetId,
        transition.stagedVersionId,
        current.sortOrder,
        current.allowIncomplete,
        successCommit.now,
    );
}
