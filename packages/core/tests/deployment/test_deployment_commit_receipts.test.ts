import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    buildDeploymentCommitReceipt,
    readDeploymentCommitReceipt,
    receiptsAreExact,
    validateDeploymentCommitReceipt,
} from "../../src/deployment/deployment-commit-receipts";
import {
    commitReverseAcceptSuccessCrashDurable,
    prepareDeploymentSuccessAuthority,
} from "../../src/deployment/deployment-state-authority";
import {
    DEPLOYMENT_ID,
    TRANSACTION_ID,
    initializeStateDatabase,
    makeSuccessInput,
    seedDeployment,
} from "../reverse/fixtures/reverse-accept-db-fixtures";

const A = `sha256:${"a".repeat(64)}` as const;
const B = `sha256:${"b".repeat(64)}` as const;
const C = `sha256:${"c".repeat(64)}` as const;
const D = `sha256:${"d".repeat(64)}` as const;

let root: string;
let databasePath: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-receipt-"));
    databasePath = path.join(root, "state.db");
    initializeStateDatabase(databasePath);
    seedDeployment(databasePath);
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe("DeploymentCommitReceipt authority", () => {
    it("builds and validates the exact fingerprinted 8-field authority", () => {
        const receipt = fixtureReceipt();
        expect(receipt).toMatchObject({
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_ID,
            commitTransactionId: TRANSACTION_ID,
        });
        expect(() => validateDeploymentCommitReceipt(receipt)).not.toThrow();

        const extra = { ...receipt, createdAt: 1 };
        expect(() => validateDeploymentCommitReceipt(extra)).toThrow(/exact object/);
        expect(() => validateDeploymentCommitReceipt({ ...receipt, schemaVersion: 2 })).toThrow(/schemaVersion/);
        expect(() => validateDeploymentCommitReceipt({ ...receipt, deploymentId: "bad" })).toThrow(/deploymentId/);
        expect(() => validateDeploymentCommitReceipt({ ...receipt, commitTransactionId: "bad" })).toThrow(/commitTransactionId/);
        expect(() =>
            validateDeploymentCommitReceipt({
                ...receipt,
                preCommitDatabaseStateFingerprint: "bad",
            }),
        ).toThrow(/preCommitDatabaseStateFingerprint/);
        expect(() => validateDeploymentCommitReceipt({ ...receipt, commitReceiptFingerprint: A })).toThrow(
            /fingerprint mismatch/,
        );
        expect(() => buildDeploymentCommitReceipt({} as Parameters<typeof buildDeploymentCommitReceipt>[0])).toThrow(
            /preimage must be an exact object/,
        );
    });

    it("compares complete receipts, not only their composite identity", () => {
        const receipt = fixtureReceipt();
        expect(receiptsAreExact(receipt, structuredClone(receipt))).toBe(true);
        const changed = buildDeploymentCommitReceipt({
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_ID,
            commitTransactionId: TRANSACTION_ID,
            preCommitDatabaseStateFingerprint: B,
            appliedInputsSnapshotFingerprint: B,
            appliedRenderSnapshotFingerprint: C,
            deploymentFileBaselineSetFingerprint: D,
        });
        expect(receiptsAreExact(receipt, changed)).toBe(false);
    });

    it("reads missing and atomically committed receipts by exact transaction key", () => {
        expect(readDeploymentCommitReceipt(databasePath, DEPLOYMENT_ID, TRANSACTION_ID)).toEqual({ receiptState: "missing" });
        const successCommit = makeSuccessInput();
        const preparedAuthority = prepareDeploymentSuccessAuthority(databasePath, successCommit);
        const result = commitReverseAcceptSuccessCrashDurable({
            databasePath,
            successCommit,
            preparedAuthority,
        });
        expect(result.commitState).toBe("committed");
        expect(readDeploymentCommitReceipt(databasePath, DEPLOYMENT_ID, TRANSACTION_ID)).toEqual({
            receiptState: "available",
            receipt: preparedAuthority.commitReceipt,
        });
    });

    it("rejects malformed stored rows instead of projecting a partial receipt", () => {
        const db = new Database(databasePath);
        db.pragma("foreign_keys = ON");
        db.prepare(
            `INSERT INTO deployment_commit_receipts VALUES (
                1, ?, ?, ?, ?, ?, ?, ?
            )`,
        ).run(DEPLOYMENT_ID, TRANSACTION_ID, "bad", B, C, D, A);
        db.close();
        expect(() => readDeploymentCommitReceipt(databasePath, DEPLOYMENT_ID, TRANSACTION_ID)).toThrow(
            /preCommitDatabaseStateFingerprint/,
        );
    });

    it("rejects invalid lookup paths and identities before opening SQLite", () => {
        expect(() => readDeploymentCommitReceipt(":memory:", DEPLOYMENT_ID, TRANSACTION_ID)).toThrow(/canonical absolute/);
        expect(() => readDeploymentCommitReceipt(databasePath, "bad" as typeof DEPLOYMENT_ID, TRANSACTION_ID)).toThrow(
            /deploymentId/,
        );
        expect(() => readDeploymentCommitReceipt(databasePath, DEPLOYMENT_ID, "bad" as typeof TRANSACTION_ID)).toThrow(
            /commitTransactionId/,
        );
    });
});

function fixtureReceipt() {
    return buildDeploymentCommitReceipt({
        schemaVersion: 1,
        deploymentId: DEPLOYMENT_ID,
        commitTransactionId: TRANSACTION_ID,
        preCommitDatabaseStateFingerprint: A,
        appliedInputsSnapshotFingerprint: B,
        appliedRenderSnapshotFingerprint: C,
        deploymentFileBaselineSetFingerprint: D,
    });
}
