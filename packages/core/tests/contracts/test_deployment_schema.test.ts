/** Deployment-row DDL and observation-freshness invariants. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCHEMA_PATH = path.resolve(__dirname, "../../schema/schema.sql");

function loadSchemaFresh(tmpDbPath: string): Database.Database {
    const db = new Database(tmpDbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    return db;
}

function tableColumns(db: Database.Database, table: string): string[] {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.map((row) => row.name);
}

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-deployment-schema-"));
    dbPath = path.join(tmpDir, "state.db");
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("deployments table (§4.1)", () => {
    it("has the 16 v1 fields with correct names", () => {
        const db = loadSchemaFresh(dbPath);
        const cols = tableColumns(db, "deployments");
        const expected = [
            "deployment_id",
            "consumer_agent_runtime_ids",
            "platform",
            "platform_instance_id",
            "target_root_path",
            "project_id",
            "committed_transaction_id",
            "applied_inputs_snapshot",
            "applied_render_snapshot_ref",
            "observation_state",
            "observation_attempted_at",
            "last_complete_observation_at",
            "blocking_evidence",
            "deleted",
            "created_at",
            "updated_at",
        ];
        for (const column of expected) expect(cols).toContain(column);
        expect(cols).toHaveLength(expected.length);
        db.close();
    });

    it("rejects invalid platform / observation_state / deleted values", () => {
        const db = loadSchemaFresh(dbPath);
        const baseValid = {
            deployment_id: "d1",
            consumer_agent_runtime_ids: "[]",
            platform: "linux",
            platform_instance_id: "local-linux",
            target_root_path: "/tmp",
            project_id: "",
            committed_transaction_id: "",
            applied_inputs_snapshot: "{}",
            applied_render_snapshot_ref: '{"snapshotState":"never"}',
            observation_state: "never",
            observation_attempted_at: 0,
            last_complete_observation_at: 0,
            blocking_evidence: "{}",
            deleted: 0,
            created_at: 1,
            updated_at: 1,
        };
        const insert = db.prepare(
            "INSERT INTO deployments (deployment_id, consumer_agent_runtime_ids, " +
                "platform, platform_instance_id, target_root_path, project_id, committed_transaction_id, " +
                "applied_inputs_snapshot, applied_render_snapshot_ref, observation_state, " +
                "observation_attempted_at, last_complete_observation_at, blocking_evidence, deleted, " +
                "created_at, updated_at) VALUES " +
                "(@deployment_id, @consumer_agent_runtime_ids, @platform, @platform_instance_id, " +
                "@target_root_path, @project_id, @committed_transaction_id, " +
                "@applied_inputs_snapshot, @applied_render_snapshot_ref, @observation_state, " +
                "@observation_attempted_at, @last_complete_observation_at, @blocking_evidence, @deleted, " +
                "@created_at, @updated_at)",
        );
        expect(() => insert.run(baseValid)).not.toThrow();
        expect(() => insert.run({ ...baseValid, deployment_id: "d0", platform_instance_id: "" })).toThrow();
        expect(() => insert.run({ ...baseValid, deployment_id: "d2", platform: "solaris" })).toThrow();
        expect(() => insert.run({ ...baseValid, deployment_id: "d3", observation_state: "needs_recovery" })).toThrow();
        expect(() => insert.run({ ...baseValid, deployment_id: "d3a", observation_attempted_at: 1 })).toThrow();
        expect(() => insert.run({ ...baseValid, deployment_id: "d3b", observation_state: "complete" })).toThrow();
        expect(() =>
            insert.run({
                ...baseValid,
                deployment_id: "d3c",
                observation_state: "complete",
                observation_attempted_at: 2,
                last_complete_observation_at: 1,
            }),
        ).toThrow();
        expect(() =>
            insert.run({
                ...baseValid,
                deployment_id: "d3d",
                observation_state: "partial",
                observation_attempted_at: 2,
                last_complete_observation_at: 1,
            }),
        ).not.toThrow();
        expect(() => insert.run({ ...baseValid, deployment_id: "d4", deleted: 2 })).toThrow();
        expect(() => insert.run({ ...baseValid, deployment_id: "d5", created_at: 10, updated_at: 5 })).toThrow();
        db.close();
    });

    it("does NOT have a status column (status is core-derived, not authoritative)", () => {
        const db = loadSchemaFresh(dbPath);
        expect(tableColumns(db, "deployments")).not.toContain("status");
        db.close();
    });
});
