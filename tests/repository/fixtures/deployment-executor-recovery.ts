import { selectedWslTargetTransactions } from "../../../packages/core/src/deployment/selected-wsl-target-transaction";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { readRegularFileNoFollow } from "@oaam/shared/filesystem";
import { readJournal, scanJournals } from "../../../packages/core/src/deployment/deployment-journal";
import { recoverDeployment } from "../../../packages/core/src/deployment/deployment-recovery";
import { loadDeploymentBaseline } from "../../../packages/core/src/deployment/deployment-state-ops";
import type { DeploymentTargetExecution } from "../../../packages/core/src/orchestration/restricted-target-channel";
import { getDeployment } from "../../../packages/core/src/persistence/state-db";

export interface RetainedExecutorRecoveryCase {
    mode: "restore-old" | "third-value";
    stateRoot: string;
    targetRootPath: string;
    executionRootPath: string;
    platformInstanceId: string;
    deploymentId: string;
    transactionId: string;
    committedTransactionId: string;
    databaseSha256: string;
    journalSha256: string;
    targetSha256: string;
}

const digest = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Resume the original durable transaction. No fixture creation, recompilation,
 * new transaction or State restoration may substitute for that transaction. */
export function recoverRetainedExecutorCase(input: RetainedExecutorRecoveryCase, execution: DeploymentTargetExecution) {
    const databasePath = path.join(input.stateRoot, "index.db");
    const transactionsRoot = path.join(input.stateRoot, "transactions");
    const journalPath = path.join(transactionsRoot, input.transactionId, "journal.json");
    assert.equal(digest(fs.readFileSync(databasePath)), input.databaseSha256);
    assert.equal(digest(fs.readFileSync(journalPath)), input.journalSha256);
    const journal = readJournal(transactionsRoot, input.transactionId);
    assert.ok(journal && journal.transactionId === input.transactionId && journal.deploymentId === input.deploymentId);
    assert.equal(journal.entries.length, 1);
    const entry = journal.entries[0]!;
    assert.equal(entry.relativePath, "AGENTS.md");
    const target = path.join(input.targetRootPath, entry.relativePath);
    assert.equal(digest(readRegularFileNoFollow(target).bytes), input.targetSha256);
    assert.equal(`sha256:${input.targetSha256}`, entry.newHash);
    const db = new Database(databasePath, { fileMustExist: true });
    const result = (() => {
        try {
            db.pragma("synchronous = FULL");
            db.pragma("foreign_keys = ON");
            const deployment = getDeployment(db, input.deploymentId);
            assert.ok(deployment);
            assert.equal(deployment.targetRootPath, input.targetRootPath);
            assert.equal(deployment.platformInstanceId, input.platformInstanceId);
            assert.equal(deployment.committedTransactionId, input.committedTransactionId);
            assert.notEqual(deployment.committedTransactionId, input.transactionId);
            assert.deepEqual(scanJournals(transactionsRoot, input.deploymentId), {
                matchingTxnIds: [input.transactionId],
                corruptTxnIds: [],
            });
            const baseline = loadDeploymentBaseline(db, input.deploymentId);
            const third = Buffer.from("# OAAM independent retained-transaction third value\n");
            if (input.mode === "third-value") {
                assert.notEqual(`sha256:${digest(third)}`, entry.oldHash);
                assert.notEqual(`sha256:${digest(third)}`, entry.newHash);
                // The selected case deliberately models an external edit in the
                // exact OAAM-owned file after its recovery inputs were snapshotted.
                fs.writeFileSync(target, third);
            }
            const recovered = recoverDeployment(
                db,
                transactionsRoot,
                input.transactionId,
                selectedWslTargetTransactions(execution),
            );
            const observed = readRegularFileNoFollow(target);
            if (input.mode === "restore-old") {
                assert.deepEqual(recovered, { outcome: "recovered_to_old", reasonCode: "", journalResolved: true });
                assert.equal(`sha256:${digest(observed.bytes)}`, entry.oldHash);
                assert.equal(observed.executable, entry.oldExecutable);
                assert.equal(readJournal(transactionsRoot, input.transactionId), null);
            } else {
                assert.deepEqual(recovered, {
                    outcome: "blocked",
                    reasonCode: "blocked_by_recovery_target_changed",
                    journalResolved: false,
                });
                assert.deepEqual(Buffer.from(observed.bytes), third);
                assert.equal(digest(fs.readFileSync(journalPath)), input.journalSha256);
            }
            assert.deepEqual(getDeployment(db, input.deploymentId), deployment);
            assert.deepEqual(loadDeploymentBaseline(db, input.deploymentId), baseline);
            return {
                mode: input.mode,
                deploymentId: input.deploymentId,
                transactionId: input.transactionId,
                committedTransactionId: input.committedTransactionId,
                recovered,
                targetSha256: digest(observed.bytes),
                deployment,
                baseline,
            };
        } finally {
            db.close();
        }
    })();
    assert.equal(digest(fs.readFileSync(databasePath)), input.databaseSha256, "recovery must not rewrite durable State");
    return result;
}
