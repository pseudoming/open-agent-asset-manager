/** Shared deterministic fixtures for the split Deployment tests. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";
import { localTargetTransactions } from "../../../src/deployment/local-target-transaction";
import {
    executeDeploymentForTest as executeDeploymentForTestStrict,
    type DeployDeps,
    type DeployExecutorOptions,
    type DeployResult,
} from "../../../src/deployment/deployment-executor";
import { insertDeployment, upsertDeploymentAsset, type DeploymentRow } from "../../../src/persistence/state-db";
import type { TargetPlan } from "../../../src/deployment/deployment-target-plan";
import { sha256Bytes } from "../../../src/foundation/crypto-bytes";
import { makeExecutionAuthority, makeTestTargetPlan, seedActiveBaseline } from "./deployment-authority-fixtures";

export const SCHEMA_PATH = path.resolve(__dirname, "../../../schema/schema.sql");

export const D1 = "00000000-0000-4000-8000-000000000001";

export const D2 = "00000000-0000-4000-8000-000000000002";

export const A1 = "00000000-0000-4000-8000-000000000010";

export const V1 = "00000000-0000-4000-8000-000000000020";

export const P1 = "00000000-0000-4000-8000-000000000030";

export function sha(s: string): string {
    return sha256Bytes(Buffer.from(s, "utf-8"));
}

export function freshDb(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    return db;
}

export function deployRow(deploymentId: string, rootPath: string): DeploymentRow {
    return {
        deploymentId,
        consumerAgentRuntimeIds: '["CLAUDE_CODE_CLI"]',
        platform: "linux",
        platformInstanceId: "local-linux",
        targetRootPath: rootPath,
        projectId: "",
        committedTransactionId: "",
        appliedInputsSnapshot: `{"schemaVersion":1,"deploymentId":"${deploymentId}","consumerAgentRuntimeIds":["CLAUDE_CODE_CLI"],"assets":[]}`,
        appliedRenderSnapshotRef: '{"snapshotState":"never"}',
        observationState: "never",
        observationAttemptedAt: 0,
        lastCompleteObservationAt: 0,
        blockingEvidence:
            '{"schemaVersion":1,"reasonCode":"","operation":"","contextFingerprint":"","occurredAt":0,"diagnostics":[],"suggestedActions":[],"retryable":false}',
        deleted: 0,
        createdAt: 1000,
        updatedAt: 1000,
    };
}

export interface H {
    db: Database.Database;
    root: string;
    txnRoot: string;
    deploymentsRoot: string;
    opts: DeployExecutorOptions;
    cleanup: () => void;
}

export function harness(): H {
    const db = freshDb();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-exec-target-"));
    const txnRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-exec-txn-"));
    const deploymentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-exec-deployments-"));
    insertDeployment(db, deployRow(D1, root));
    upsertDeploymentAsset(db, D1, A1, V1, 1, 0, 5000);
    let clock = 5000;
    return {
        db,
        root,
        txnRoot,
        deploymentsRoot,
        opts: {
            targetExecution: localTargetTransactions,
            db,
            transactionsRoot: txnRoot,
            deploymentsRoot,
            deploymentId: D1,
            now: () => (clock += 100),
        },
        cleanup: () => {
            try {
                fs.rmSync(root, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
            try {
                fs.rmSync(txnRoot, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
            try {
                fs.rmSync(deploymentsRoot, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
        },
    };
}

export function executeDeployment(opts: DeployExecutorOptions, plan: TargetPlan): DeployResult {
    return executeDeploymentForTestStrict(opts, plan, makeExecutionAuthority(plan), {});
}

export function executeRawStrict(
    opts: DeployExecutorOptions,
    plan: TargetPlan,
    authority: ReturnType<typeof makeExecutionAuthority>,
    runtimeReplacementAuthority?: Parameters<typeof executeDeploymentForTestStrict>[4],
): DeployResult {
    return executeDeploymentForTestStrict(opts, plan, authority, {}, runtimeReplacementAuthority);
}

export function executeDeploymentForTest(opts: DeployExecutorOptions, plan: TargetPlan, deps: Partial<DeployDeps>): DeployResult {
    return executeDeploymentForTestStrict(opts, plan, makeExecutionAuthority(plan), deps);
}

export function seedRealBaseline(h: H, deploymentId: string, relativePath: string, text: string, executable = false): void {
    seedActiveBaseline({
        db: h.db,
        deploymentsRoot: h.deploymentsRoot,
        deploymentId,
        transactionId: deploymentId === D1 ? "44444444-4444-4444-8444-444444444444" : "55555555-5555-4555-8555-555555555555",
        plan: textPlan(relativePath, text, executable),
        relativePath,
    });
}

export function textPlan(rel: string, text: string, executable = false): TargetPlan {
    return makeTestTargetPlan([{ relativePath: rel, content: { contentKind: "text", text }, executable }]);
}

export function writeFile(root: string, rel: string, content: string): void {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

export function readFile(root: string, rel: string): string {
    return fs.readFileSync(path.join(root, rel), "utf-8");
}

export function exists(root: string, rel: string): boolean {
    return fs.existsSync(path.join(root, rel));
}
