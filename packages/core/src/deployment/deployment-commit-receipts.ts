import * as path from "node:path";
import Database, { type Database as DatabaseConnection } from "better-sqlite3";
import type { Sha256Digest, UuidV4 } from "../contracts/primitives";
import { computeDeploymentCommitReceiptFingerprint, stableStringify } from "../foundation/fingerprint";
import { hasExactKeys, isSha256Digest, isStrictObject, isUuidV4 } from "../foundation/validators";

/** Immutable Stage-R proof written in the same FULL transaction as success state. */
export interface DeploymentCommitReceiptV1 {
    schemaVersion: 1;
    deploymentId: UuidV4;
    commitTransactionId: UuidV4;
    preCommitDatabaseStateFingerprint: Sha256Digest;
    appliedInputsSnapshotFingerprint: Sha256Digest;
    appliedRenderSnapshotFingerprint: Sha256Digest;
    deploymentFileBaselineSetFingerprint: Sha256Digest;
    commitReceiptFingerprint: Sha256Digest;
}

export interface DeploymentCommitReceiptFingerprintInputV1 {
    schemaVersion: 1;
    deploymentId: UuidV4;
    commitTransactionId: UuidV4;
    preCommitDatabaseStateFingerprint: Sha256Digest;
    appliedInputsSnapshotFingerprint: Sha256Digest;
    appliedRenderSnapshotFingerprint: Sha256Digest;
    deploymentFileBaselineSetFingerprint: Sha256Digest;
}

export type DeploymentCommitReceiptLookup =
    | { receiptState: "missing" }
    | { receiptState: "available"; receipt: DeploymentCommitReceiptV1 };

interface DeploymentCommitReceiptRow {
    schemaVersion: number;
    deploymentId: string;
    commitTransactionId: string;
    preCommitDatabaseStateFingerprint: string;
    appliedInputsSnapshotFingerprint: string;
    appliedRenderSnapshotFingerprint: string;
    deploymentFileBaselineSetFingerprint: string;
    commitReceiptFingerprint: string;
}

export function buildDeploymentCommitReceipt(input: DeploymentCommitReceiptFingerprintInputV1): DeploymentCommitReceiptV1 {
    validateReceiptPreimage(input);
    const receipt = {
        ...structuredClone(input),
        commitReceiptFingerprint: computeDeploymentCommitReceiptFingerprint(input),
    };
    validateDeploymentCommitReceipt(receipt);
    return receipt;
}

export function validateDeploymentCommitReceipt(value: unknown): asserts value is DeploymentCommitReceiptV1 {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "schemaVersion",
            "deploymentId",
            "commitTransactionId",
            "preCommitDatabaseStateFingerprint",
            "appliedInputsSnapshotFingerprint",
            "appliedRenderSnapshotFingerprint",
            "deploymentFileBaselineSetFingerprint",
            "commitReceiptFingerprint",
        ])
    ) {
        throw new Error("DeploymentCommitReceipt must be an exact object");
    }
    const receipt = value as unknown as DeploymentCommitReceiptV1;
    const { commitReceiptFingerprint, ...preimage } = receipt;
    validateReceiptPreimage(preimage);
    requireDigest(commitReceiptFingerprint, "commitReceiptFingerprint");
    if (computeDeploymentCommitReceiptFingerprint(preimage) !== commitReceiptFingerprint) {
        throw new Error("DeploymentCommitReceipt fingerprint mismatch");
    }
}

/** Read-only exact lookup for recovery/classification callers. */
export function readDeploymentCommitReceipt(
    databasePath: string,
    deploymentId: UuidV4,
    commitTransactionId: UuidV4,
): DeploymentCommitReceiptLookup {
    requireDatabasePath(databasePath);
    requireUuid(deploymentId, "deploymentId");
    requireUuid(commitTransactionId, "commitTransactionId");
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
        return readDeploymentCommitReceiptFromConnection(db, deploymentId, commitTransactionId);
    } finally {
        db.close();
    }
}

/** @internal State-authority transaction/recovery read; production callers
 * outside deployment-state-authority.ts must use the path-level reader. */
export function readDeploymentCommitReceiptFromConnection(
    db: DatabaseConnection,
    deploymentId: UuidV4,
    commitTransactionId: UuidV4,
): DeploymentCommitReceiptLookup {
    requireUuid(deploymentId, "deploymentId");
    requireUuid(commitTransactionId, "commitTransactionId");
    const row = db
        .prepare<[string, string], Record<string, unknown>>(
            `SELECT
                schema_version, deployment_id, commit_transaction_id,
                pre_commit_database_state_fingerprint,
                applied_inputs_snapshot_fingerprint,
                applied_render_snapshot_fingerprint,
                deployment_file_baseline_set_fingerprint,
                commit_receipt_fingerprint
             FROM deployment_commit_receipts
             WHERE deployment_id = ? AND commit_transaction_id = ?`,
        )
        .get(deploymentId, commitTransactionId);
    if (row === undefined) return { receiptState: "missing" };
    const mapped = mapReceiptRow(row);
    validateDeploymentCommitReceipt(mapped);
    return { receiptState: "available", receipt: mapped };
}

/** @internal The only production importer is deployment-state-authority.ts,
 * which calls this inside its pre-state/success/receipt FULL transaction. */
export function insertDeploymentCommitReceiptInCurrentTransaction(
    db: DatabaseConnection,
    receipt: DeploymentCommitReceiptV1,
): void {
    validateDeploymentCommitReceipt(receipt);
    db.prepare(
        `INSERT INTO deployment_commit_receipts (
            schema_version, deployment_id, commit_transaction_id,
            pre_commit_database_state_fingerprint,
            applied_inputs_snapshot_fingerprint,
            applied_render_snapshot_fingerprint,
            deployment_file_baseline_set_fingerprint,
            commit_receipt_fingerprint
        ) VALUES (
            @schemaVersion, @deploymentId, @commitTransactionId,
            @preCommitDatabaseStateFingerprint,
            @appliedInputsSnapshotFingerprint,
            @appliedRenderSnapshotFingerprint,
            @deploymentFileBaselineSetFingerprint,
            @commitReceiptFingerprint
        )`,
    ).run(receipt);
}

export function receiptsAreExact(left: DeploymentCommitReceiptV1, right: DeploymentCommitReceiptV1): boolean {
    validateDeploymentCommitReceipt(left);
    validateDeploymentCommitReceipt(right);
    return stableStringify(left) === stableStringify(right);
}

function validateReceiptPreimage(value: unknown): asserts value is DeploymentCommitReceiptFingerprintInputV1 {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "schemaVersion",
            "deploymentId",
            "commitTransactionId",
            "preCommitDatabaseStateFingerprint",
            "appliedInputsSnapshotFingerprint",
            "appliedRenderSnapshotFingerprint",
            "deploymentFileBaselineSetFingerprint",
        ])
    ) {
        throw new Error("DeploymentCommitReceipt preimage must be an exact object");
    }
    if (value.schemaVersion !== 1) {
        throw new Error("DeploymentCommitReceipt schemaVersion must be 1");
    }
    requireUuid(value.deploymentId, "deploymentId");
    requireUuid(value.commitTransactionId, "commitTransactionId");
    requireDigest(value.preCommitDatabaseStateFingerprint, "preCommitDatabaseStateFingerprint");
    requireDigest(value.appliedInputsSnapshotFingerprint, "appliedInputsSnapshotFingerprint");
    requireDigest(value.appliedRenderSnapshotFingerprint, "appliedRenderSnapshotFingerprint");
    requireDigest(value.deploymentFileBaselineSetFingerprint, "deploymentFileBaselineSetFingerprint");
}

function mapReceiptRow(row: Record<string, unknown>): DeploymentCommitReceiptRow {
    return {
        schemaVersion: row.schema_version as number,
        deploymentId: row.deployment_id as string,
        commitTransactionId: row.commit_transaction_id as string,
        preCommitDatabaseStateFingerprint: row.pre_commit_database_state_fingerprint as string,
        appliedInputsSnapshotFingerprint: row.applied_inputs_snapshot_fingerprint as string,
        appliedRenderSnapshotFingerprint: row.applied_render_snapshot_fingerprint as string,
        deploymentFileBaselineSetFingerprint: row.deployment_file_baseline_set_fingerprint as string,
        commitReceiptFingerprint: row.commit_receipt_fingerprint as string,
    };
}

function requireUuid(value: unknown, field: string): asserts value is UuidV4 {
    if (!isUuidV4(value)) throw new Error(`DeploymentCommitReceipt ${field} must be UUID v4`);
}

function requireDigest(value: unknown, field: string): asserts value is Sha256Digest {
    if (!isSha256Digest(value)) {
        throw new Error(`DeploymentCommitReceipt ${field} must be a SHA-256 digest`);
    }
}

function requireDatabasePath(databasePath: string): void {
    if (
        databasePath.length === 0 ||
        databasePath === ":memory:" ||
        databasePath.includes("\0") ||
        !path.isAbsolute(databasePath) ||
        path.normalize(databasePath) !== databasePath
    ) {
        throw new Error("DeploymentCommitReceipt lookup requires a canonical absolute DB path");
    }
}
