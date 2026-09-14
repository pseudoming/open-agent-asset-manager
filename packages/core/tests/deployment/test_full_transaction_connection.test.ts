import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    runDedicatedFullTransaction,
    runDedicatedFullTransactionForTest,
    validateDedicatedFullConfigurationForTest,
} from "../../src/persistence/full-transaction-connection";

const SCHEMA_PATH = path.resolve(__dirname, "../../schema/schema.sql");

let root: string;
let databasePath: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-full-transaction-"));
    databasePath = path.join(root, "state.db");
    const db = new Database(databasePath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    db.close();
});

afterEach(async () => {
    vi.resetModules();
    const dbModule = await import("../../src/persistence/db");
    dbModule.closeDb();
    fs.rmSync(root, { recursive: true, force: true });
});

describe("dedicated FULL transaction connection", () => {
    it("rejects every unverified durability configuration value", () => {
        expect(() => validateDedicatedFullConfigurationForTest(1, 1, 2)).toThrow(/WAL/);
        expect(() => validateDedicatedFullConfigurationForTest("delete", 1, 2)).toThrow(/WAL/);
        expect(() => validateDedicatedFullConfigurationForTest("wal", 0, 2)).toThrow(/foreign_keys/);
        expect(() => validateDedicatedFullConfigurationForTest("wal", 1, 1)).toThrow(/synchronous=FULL/);
        expect(() => validateDedicatedFullConfigurationForTest("WAL", 1, 2)).not.toThrow();
    });

    it("proves WAL/FULL before BEGIN, commits, reads back, and closes", () => {
        const events: string[] = [];
        const result = runDedicatedFullTransactionForTest(
            databasePath,
            {
                mutate(db) {
                    events.push(`mutate:${db.inTransaction}`);
                    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
                    expect(db.pragma("synchronous", { simple: true })).toBe(2);
                    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
                    db.prepare(
                        `INSERT INTO deployments (
                            deployment_id, consumer_agent_runtime_ids, platform, platform_instance_id,
                            target_root_path, project_id, committed_transaction_id,
                            applied_inputs_snapshot, applied_render_snapshot_ref,
                            observation_state, observation_attempted_at, last_complete_observation_at,
                            blocking_evidence,
                            deleted, created_at, updated_at
                        ) VALUES (
                            '00000000-0000-4000-8000-000000000001', '[]', 'linux', 'local-linux',
                            '/root', '', '', '{}', '{"snapshotState":"never"}',
                            'never', 0, 0, '{}', 0, 1, 1
                        )`,
                    ).run();
                    return "written";
                },
                verifyAfterCommit(db, value) {
                    events.push(`verify:${db.inTransaction}:${value}`);
                    expect(db.prepare("SELECT COUNT(*) AS n FROM deployments").get()).toEqual({ n: 1 });
                },
            },
            {
                afterDurabilityConfigured(db) {
                    events.push(`configured:${db.inTransaction}`);
                },
                afterBegin(db) {
                    events.push(`begin:${db.inTransaction}`);
                },
                beforeCommit(db, value) {
                    events.push(`before:${db.inTransaction}:${value}`);
                },
                afterCommit(db, value) {
                    events.push(`after:${db.inTransaction}:${value}`);
                },
            },
        );
        expect(result).toBe("written");
        expect(events).toEqual([
            "configured:false",
            "begin:true",
            "mutate:true",
            "before:true:written",
            "after:false:written",
            "verify:false:written",
        ]);
    });

    it("does not mutate the shared NORMAL singleton", async () => {
        vi.resetModules();
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const shared = getDb(databasePath);
        expect(shared.pragma("synchronous", { simple: true })).toBe(1);
        runDedicatedFullTransaction(databasePath, {
            mutate(db) {
                expect(db.pragma("synchronous", { simple: true })).toBe(2);
                return undefined;
            },
            verifyAfterCommit() {},
        });
        expect(shared.pragma("synchronous", { simple: true })).toBe(1);
        closeDb();
    });

    it("rolls back mutation and before-COMMIT failures", () => {
        expect(() =>
            runDedicatedFullTransaction(databasePath, {
                mutate(db) {
                    db.prepare("UPDATE deployments SET observation_state='failed' WHERE deployment_id='missing'").run();
                    throw new Error("mutation failed");
                },
                verifyAfterCommit() {
                    throw new Error("must not verify");
                },
            }),
        ).toThrow(/mutation failed/);

        seedDeployment();
        expect(() =>
            runDedicatedFullTransactionForTest(
                databasePath,
                {
                    mutate(db) {
                        db.prepare(
                            "UPDATE deployments SET observation_state='failed', observation_attempted_at=2 WHERE deployment_id=?",
                        ).run("00000000-0000-4000-8000-000000000001");
                        return undefined;
                    },
                    verifyAfterCommit() {
                        throw new Error("must not verify");
                    },
                },
                {
                    beforeCommit: () => {
                        throw new Error("before commit failed");
                    },
                },
            ),
        ).toThrow(/before commit failed/);
        expect(readObservationState()).toBe("never");
    });

    it("preserves the original error if the transaction was already rolled back", () => {
        seedDeployment();
        expect(() =>
            runDedicatedFullTransactionForTest(
                databasePath,
                {
                    mutate(db) {
                        db.prepare(
                            "UPDATE deployments SET observation_state='failed', observation_attempted_at=2 WHERE deployment_id=?",
                        ).run("00000000-0000-4000-8000-000000000001");
                        return undefined;
                    },
                    verifyAfterCommit() {},
                },
                {
                    beforeCommit(db) {
                        db.exec("ROLLBACK");
                        throw new Error("original failure");
                    },
                },
            ),
        ).toThrow(/original failure/);
        expect(readObservationState()).toBe("never");
    });

    it("a post-COMMIT hook/readback failure reports unknown but leaves the commit durable", () => {
        seedDeployment();
        expect(() =>
            runDedicatedFullTransactionForTest(
                databasePath,
                {
                    mutate(db) {
                        db.prepare(
                            "UPDATE deployments SET observation_state='complete', observation_attempted_at=2, " +
                                "last_complete_observation_at=2 WHERE deployment_id=?",
                        ).run("00000000-0000-4000-8000-000000000001");
                        return undefined;
                    },
                    verifyAfterCommit() {},
                },
                {
                    afterCommit: () => {
                        throw new Error("lost after commit");
                    },
                },
            ),
        ).toThrow(/lost after commit/);
        expect(readObservationState()).toBe("complete");

        expect(() =>
            runDedicatedFullTransaction(databasePath, {
                mutate(db) {
                    db.prepare(
                        "UPDATE deployments SET observation_state='failed', observation_attempted_at=2 WHERE deployment_id=?",
                    ).run("00000000-0000-4000-8000-000000000001");
                    return undefined;
                },
                verifyAfterCommit() {
                    throw new Error("readback failed");
                },
            }),
        ).toThrow(/readback failed/);
        expect(readObservationState()).toBe("failed");
    });

    it("rejects non-durable paths, missing files, and non-WAL databases", () => {
        const operation = {
            mutate: () => undefined,
            verifyAfterCommit: () => undefined,
        };
        for (const invalid of ["", ":memory:", "relative.db", `${databasePath}\0bad`]) {
            expect(() => runDedicatedFullTransaction(invalid, operation)).toThrow(/canonical absolute/);
        }
        expect(() => runDedicatedFullTransaction(path.join(root, "missing.db"), operation)).toThrow();

        const deleteModePath = path.join(root, "delete-mode.db");
        const deleteMode = new Database(deleteModePath);
        deleteMode.pragma("journal_mode = DELETE");
        deleteMode.close();
        expect(() => runDedicatedFullTransaction(deleteModePath, operation)).toThrow(/requires.*WAL/);
    });
});

function seedDeployment(): void {
    const db = new Database(databasePath);
    db.pragma("foreign_keys = ON");
    db.prepare(
        `INSERT INTO deployments (
            deployment_id, consumer_agent_runtime_ids, platform, platform_instance_id,
            target_root_path, project_id, committed_transaction_id,
            applied_inputs_snapshot, applied_render_snapshot_ref,
            observation_state, observation_attempted_at, last_complete_observation_at,
            blocking_evidence,
            deleted, created_at, updated_at
        ) VALUES (
            '00000000-0000-4000-8000-000000000001', '[]', 'linux', 'local-linux',
            '/root', '', '', '{}', '{"snapshotState":"never"}',
            'never', 0, 0, '{}', 0, 1, 1
        )`,
    ).run();
    db.close();
}

function readObservationState(): string {
    const db = new Database(databasePath, { readonly: true });
    try {
        return (
            db.prepare("SELECT observation_state FROM deployments").get() as {
                observation_state: string;
            }
        ).observation_state;
    } finally {
        db.close();
    }
}
