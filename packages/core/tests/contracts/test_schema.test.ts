/**
 * Schema invariants + old-model backflow guards (Step 3 / Phase 10).
 *
 * Codifies GLOBAL_DBA_REVIEW §4 (per-table DDL) + §6 CHANGE_REQUIRED #3
 * (old-model backflow guard). If anyone re-introduces a retired old-model
 * table/column/sentinel, or drops a v1 invariant, this test goes red.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";

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
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
    }[];
    return rows.map((r) => r.name);
}

function tableNames(db: Database.Database): Set<string> {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
}

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-schema-"));
    dbPath = path.join(tmpDir, "state.db");
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// 1. v1 表集合 — 9 张表存在(Stage R新增internal commit receipt)
// ============================================================

describe("v1 schema: 9 owner/projection/internal tables present", () => {
    it("has all 9 approved tables (no old-model tables)", () => {
        const db = loadSchemaFresh(dbPath);
        const names = tableNames(db);
        // v1 tables
        expect(names.has("deployments")).toBe(true);
        expect(names.has("deployment_assets")).toBe(true);
        expect(names.has("deployment_files")).toBe(true);
        expect(names.has("deployment_render_snapshots")).toBe(true);
        expect(names.has("deployment_residual_authorities")).toBe(true);
        expect(names.has("deployment_commit_receipts")).toBe(true);
        expect(names.has("current_asset_index")).toBe(true);
        expect(names.has("project_index")).toBe(true);
        // assets_fts is a virtual table — appears in sqlite_master with type='table'
        // but PRAGMA table_info treats it specially; verify presence by name.
        expect(names.has("assets_fts")).toBe(true);

        // Old-model tables MUST be absent (backflow guard).
        expect(names.has("asset_versions")).toBe(false);
        expect(names.has("user_settings")).toBe(false);
        // Note: old `assets` table name collides conceptually with current_asset_index,
        // but the old `assets` table is NOT created by this schema; only current_asset_index is.
        expect(names.has("assets")).toBe(false);
        db.close();
    });
});

// ============================================================
// 1b. Schema-wide old-model backflow guard(GLOBAL_DBA_REVIEW §6 CHANGE_REQUIRED #3)
//
// 第一批 schema guard 必须覆盖 DBA 审计要求的全部旧模型回流信号:
//   - 旧表不存在:asset_versions / asset_version_files / user_settings / 旧 assets
//   - 旧 __global__ sentinel 不存在(任何表的任何行)
//   - 旧「正文 content 权威列」不存在(注意 v1 的合法 hash/status 字段不能误伤)
//   - 不使用 SQLite TEXT datetime(时间字段必须是 INTEGER epoch millis)
//   - schema.sql 不含 INSERT OR REPLACE(违反软删恢复语义)
// 这是 schema-as-truth-source + core validator 之外的额外防线,防止未来有人
// 在 schema.sql 里偷偷把旧模型写回来。
// ============================================================

describe("schema-wide old-model backflow guard (§6 CHANGE_REQUIRED #3)", () => {
    const schemaText = fs.readFileSync(SCHEMA_PATH, "utf-8");

    it("does not define retired old-model tables", () => {
        // Read all CREATE TABLE names from the schema text itself (authoritative).
        const createTableMatches = [...schemaText.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)];
        const definedTables = new Set(createTableMatches.map((m) => m[1].toLowerCase()));

        // v1 allowed tables.
        const allowed = new Set([
            "deployments",
            "deployment_assets",
            "deployment_files",
            "deployment_render_snapshots",
            "deployment_residual_authorities",
            "deployment_commit_receipts",
            "current_asset_index",
            "project_index",
            "assets_fts",
        ]);
        for (const t of allowed) {
            expect(definedTables.has(t)).toBe(true);
        }

        // Retired old-model tables MUST NOT be defined.
        const retired = [
            "asset_versions",
            "asset_version_files",
            "user_settings",
            "assets",
            "projects", // old pre-rebuild table; v1 uses project_index (projection)
        ];
        for (const t of retired) {
            expect(definedTables.has(t.toLowerCase())).toBe(false);
        }
    });

    it("no table column is a bare `content` authority column (v1 has content_hash, not content)", () => {
        const db = loadSchemaFresh(dbPath);
        for (const t of [
            "deployments",
            "deployment_assets",
            "deployment_files",
            "deployment_render_snapshots",
            "deployment_residual_authorities",
            "deployment_commit_receipts",
            "current_asset_index",
            "project_index",
        ]) {
            const cols = tableColumns(db, t);
            // Bare `content` is the old-model full-text authority column. v1 uses
            // applied_content_hash / observed_content_hash / display_* (NOT bare content).
            expect(cols).not.toContain("content");
            // Also assert the legitimate hash columns DO exist where expected (no false
            // positive from this guard masking a real rename).
            if (t === "deployment_files") {
                expect(cols).toContain("baseline_state");
                expect(cols).toContain("observed_content_hash");
            }
        }
        db.close();
    });

    it("no table has an authoritative `status` column (status is core-derived, not stored)", () => {
        const db = loadSchemaFresh(dbPath);
        for (const t of [
            "deployments",
            "deployment_assets",
            "deployment_files",
            "deployment_render_snapshots",
            "deployment_residual_authorities",
            "deployment_commit_receipts",
            "current_asset_index",
            "project_index",
        ]) {
            const cols = tableColumns(db, t);
            expect(cols).not.toContain("status");
        }
        // Legit v1 status-ish fields (must NOT be flagged by the guard above):
        expect(tableColumns(db, "current_asset_index")).toContain("current_version_status");
        expect(tableColumns(db, "deployment_files")).toContain("observed_state");
        expect(tableColumns(db, "deployments")).toContain("observation_state");
        db.close();
    });

    it("all time fields are INTEGER epoch millis (no SQLite TEXT datetime)", () => {
        const db = loadSchemaFresh(dbPath);
        for (const t of [
            "deployments",
            "deployment_assets",
            "deployment_files",
            "deployment_render_snapshots",
            "deployment_residual_authorities",
            "deployment_commit_receipts",
            "current_asset_index",
            "project_index",
        ]) {
            const rows = db.prepare(`PRAGMA table_info(${t})`).all() as {
                name: string;
                type: string;
            }[];
            for (const col of rows) {
                if (col.name === "created_at" || col.name === "updated_at" || col.name === "observed_at") {
                    // Must be INTEGER (epoch millis), NOT TEXT (SQLite datetime).
                    expect(col.type.toUpperCase()).toBe("INTEGER");
                }
            }
        }
        db.close();
    });

    it("schema.sql does not contain `INSERT OR REPLACE` (violates soft-delete recovery)", () => {
        // INSERT OR REPLACE = INSERT OR REPLACE 的先删后插语义破坏外键/触发器/软删除生命周期
        // (GLOBAL_DBA_REVIEW §5「禁止 INSERT OR REPLACE」)。
        expect(schemaText).not.toMatch(/INSERT\s+OR\s+REPLACE/i);
    });

    it("no row anywhere uses the retired __global__ sentinel as project_id", () => {
        // The old model used a virtual `__global__` Project row. v1 uses empty
        // string for global (projectId = ""). Verify the schema itself doesn't
        // encode __global__ anywhere (e.g. as a default or seed), and that a
        // fresh DB has no such row.
        expect(schemaText).not.toMatch(/__global__/);
        const db = loadSchemaFresh(dbPath);
        // No table should contain a row with project_id = '__global__' on a fresh DB
        // (the DB is empty after schema load; this is a forward guard against seeds).
        for (const t of ["deployments", "current_asset_index"]) {
            const rows = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = '__global__'`).get() as { n: number };
            expect(rows.n).toBe(0);
        }
        db.close();
    });
});

// ============================================================
// 3. deployment_assets 字段 + FK + partial UNIQUE(GLOBAL_DBA_REVIEW §4.2)
// ============================================================

describe("deployment_assets table (§4.2)", () => {
    it("has the 9 v1 fields", () => {
        const db = loadSchemaFresh(dbPath);
        const cols = tableColumns(db, "deployment_assets");
        const expected = [
            "deployment_asset_id",
            "deployment_id",
            "asset_id",
            "version_id",
            "sort_order",
            "allow_incomplete",
            "deleted",
            "created_at",
            "updated_at",
        ];
        for (const c of expected) {
            expect(cols).toContain(c);
        }
        db.close();
    });

    it("FK to deployments is ON DELETE RESTRICT (cannot delete parent with children)", () => {
        const db = loadSchemaFresh(dbPath);
        db.prepare(
            "INSERT INTO deployments (deployment_id, consumer_agent_runtime_ids, " +
                "platform, platform_instance_id, target_root_path, project_id, committed_transaction_id, " +
                "applied_inputs_snapshot, applied_render_snapshot_ref, observation_state, " +
                "observation_attempted_at, last_complete_observation_at, blocking_evidence, deleted, " +
                "created_at, updated_at) VALUES " +
                "('d1','[]','linux','local-linux','/p','','','{}','{\"snapshotState\":\"never\"}','never',0,0,'{}',0,1,1)",
        ).run();
        db.prepare(
            "INSERT INTO deployment_assets (deployment_asset_id, deployment_id, asset_id, " +
                "version_id, sort_order, allow_incomplete, deleted, created_at, updated_at) " +
                "VALUES ('da1','d1','a1','v1',0,0,0,1,1)",
        ).run();
        // Deleting the parent must fail (RESTRICT).
        expect(() => db.prepare("DELETE FROM deployments WHERE deployment_id = 'd1'").run()).toThrow();
        db.close();
    });

    it("partial UNIQUE on (deployment_id, sort_order) only applies to active rows", () => {
        const db = loadSchemaFresh(dbPath);
        db.prepare(
            "INSERT INTO deployments (deployment_id, consumer_agent_runtime_ids, " +
                "platform, platform_instance_id, target_root_path, project_id, committed_transaction_id, " +
                "applied_inputs_snapshot, applied_render_snapshot_ref, observation_state, " +
                "observation_attempted_at, last_complete_observation_at, blocking_evidence, deleted, " +
                "created_at, updated_at) VALUES " +
                "('d1','[]','linux','local-linux','/p','','','{}','{\"snapshotState\":\"never\"}','never',0,0,'{}',0,1,1)",
        ).run();
        const ins = db.prepare(
            "INSERT INTO deployment_assets (deployment_asset_id, deployment_id, asset_id, " +
                "version_id, sort_order, allow_incomplete, deleted, created_at, updated_at) " +
                "VALUES (?, 'd1', ?, 'v1', ?, 0, ?, 1, 1)",
        );
        // Two active rows with same sort_order must collide.
        ins.run("da1", "a1", 0, 0);
        expect(() => ins.run("da2", "a2", 0, 0)).toThrow();
        // A soft-deleted row with the same sort_order must NOT collide (partial UNIQUE).
        expect(() => ins.run("da2", "a2", 0, 1)).not.toThrow();
        db.close();
    });
});

// ============================================================
// 4. deployment_files 字段 + observed_state 约束(GLOBAL_DBA_REVIEW §4.3)
// ============================================================

describe("deployment_files table (§4.3)", () => {
    it("has the 11 Stage P fields", () => {
        const db = loadSchemaFresh(dbPath);
        const cols = tableColumns(db, "deployment_files");
        const expected = [
            "deployment_file_id",
            "deployment_id",
            "relative_path",
            "baseline_state",
            "observed_state",
            "observed_content_hash",
            "observed_executable",
            "observed_at",
            "deleted",
            "created_at",
            "updated_at",
        ];
        for (const c of expected) {
            expect(cols).toContain(c);
        }
        db.close();
    });

    it("observed_state only accepts present|missing", () => {
        const db = loadSchemaFresh(dbPath);
        db.prepare(
            "INSERT INTO deployments (deployment_id, consumer_agent_runtime_ids, " +
                "platform, platform_instance_id, target_root_path, project_id, committed_transaction_id, " +
                "applied_inputs_snapshot, applied_render_snapshot_ref, observation_state, " +
                "observation_attempted_at, last_complete_observation_at, blocking_evidence, deleted, " +
                "created_at, updated_at) VALUES " +
                "('d1','[]','linux','local-linux','/p','','','{}','{\"snapshotState\":\"never\"}','never',0,0,'{}',0,1,1)",
        ).run();
        const ins = db.prepare(
            "INSERT INTO deployment_files (deployment_file_id, deployment_id, relative_path, " +
                "baseline_state, observed_state, observed_content_hash, " +
                "observed_executable, observed_at, deleted, created_at, updated_at) " +
                'VALUES (?, \'d1\', ?, \'{"rowState":"removed","latestResidualAuthorityId":"sha256:x"}\', ?, \'\', 0, 1, 0, 1, 1)',
        );
        expect(() => ins.run("f1", "a.md", "present")).not.toThrow();
        expect(() => ins.run("f2", "b.md", "missing")).not.toThrow();
        // Invalid observed_state.
        expect(() => ins.run("f3", "c.md", "never")).toThrow();
        expect(() => ins.run("f4", "d.md", "unknown")).toThrow();
        db.close();
    });

    it("accepts epoch zero but rejects negative timestamps and malformed baseline JSON", () => {
        const db = loadSchemaFresh(dbPath);
        db.prepare(
            `INSERT INTO deployments (
                deployment_id, consumer_agent_runtime_ids, platform, platform_instance_id, target_root_path,
                project_id, committed_transaction_id, applied_inputs_snapshot,
                applied_render_snapshot_ref, observation_state,
                observation_attempted_at, last_complete_observation_at, blocking_evidence,
                deleted, created_at, updated_at
             ) VALUES ('d1','[]','linux','local-linux','/p','','','{}','{"snapshotState":"never"}','never',0,0,'{}',0,1,1)`,
        ).run();
        const insert = db.prepare(
            `INSERT INTO deployment_files (
                deployment_file_id, deployment_id, relative_path, baseline_state,
                observed_state, observed_content_hash, observed_executable, observed_at,
                deleted, created_at, updated_at
             ) VALUES (?, 'd1', 'a.md', ?, 'missing', '', 0, ?, 0, 1, 1)`,
        );
        expect(() => insert.run("f1", "not-json", 1)).toThrow();
        expect(() => insert.run("f2", '{"rowState":"removed"}', 0)).not.toThrow();
        db.prepare("DELETE FROM deployment_files WHERE deployment_file_id='f2'").run();
        expect(() => insert.run("f3", '{"rowState":"removed"}', -1)).toThrow();
        db.close();
    });
});

describe("Deployment immutable authority tables (Stage P)", () => {
    it("have exact columns, JSON checks, immutable timestamps and FK RESTRICT", () => {
        const db = loadSchemaFresh(dbPath);
        expect(tableColumns(db, "deployment_render_snapshots")).toEqual([
            "snapshot_fingerprint",
            "deployment_id",
            "snapshot_json",
            "deleted",
            "created_at",
            "updated_at",
        ]);
        const snapshotPk = (
            db.prepare("PRAGMA table_info(deployment_render_snapshots)").all() as Array<{
                name: string;
                pk: number;
            }>
        )
            .filter((column) => column.pk > 0)
            .sort((left, right) => left.pk - right.pk)
            .map((column) => column.name);
        expect(snapshotPk).toEqual(["deployment_id", "snapshot_fingerprint"]);
        expect(tableColumns(db, "deployment_residual_authorities")).toEqual([
            "residual_authority_id",
            "deployment_id",
            "relative_path",
            "authority_body",
            "residual_authority_fingerprint",
            "deleted",
            "created_at",
            "updated_at",
        ]);
        db.prepare(
            `INSERT INTO deployments (
                deployment_id, consumer_agent_runtime_ids, platform, platform_instance_id, target_root_path,
                project_id, committed_transaction_id, applied_inputs_snapshot,
                applied_render_snapshot_ref, observation_state,
                observation_attempted_at, last_complete_observation_at, blocking_evidence,
                deleted, created_at, updated_at
             ) VALUES ('d1','[]','linux','local-linux','/p','','','{}','{"snapshotState":"never"}','never',0,0,'{}',0,1,1)`,
        ).run();
        expect(() => db.prepare(`INSERT INTO deployment_render_snapshots VALUES ('s1','d1','bad',0,1,1)`).run()).toThrow();
        expect(() => db.prepare(`INSERT INTO deployment_render_snapshots VALUES ('s2','d1','{}',0,1,2)`).run()).toThrow();
        db.prepare(`INSERT INTO deployment_render_snapshots VALUES ('s3','d1','{}',0,1,1)`).run();
        expect(() =>
            db.prepare(`INSERT INTO deployment_residual_authorities VALUES ('r1','d1','a.md','bad','f',0,1,1)`).run(),
        ).toThrow();
        db.prepare(`INSERT INTO deployment_residual_authorities VALUES ('r2','d1','a.md','{}','f',0,1,1)`).run();
        expect(() => db.prepare("DELETE FROM deployments WHERE deployment_id='d1'").run()).toThrow();
        db.close();
    });
});

describe("deployment_commit_receipts internal crash authority (Stage R)", () => {
    it("has the exact 8-column composite-key WITHOUT ROWID layout", () => {
        const db = loadSchemaFresh(dbPath);
        expect(tableColumns(db, "deployment_commit_receipts")).toEqual([
            "schema_version",
            "deployment_id",
            "commit_transaction_id",
            "pre_commit_database_state_fingerprint",
            "applied_inputs_snapshot_fingerprint",
            "applied_render_snapshot_fingerprint",
            "deployment_file_baseline_set_fingerprint",
            "commit_receipt_fingerprint",
        ]);
        const primaryKey = (
            db.prepare("PRAGMA table_info(deployment_commit_receipts)").all() as Array<{
                name: string;
                pk: number;
            }>
        )
            .filter((column) => column.pk > 0)
            .sort((left, right) => left.pk - right.pk)
            .map((column) => column.name);
        expect(primaryKey).toEqual(["deployment_id", "commit_transaction_id"]);
        const createSql = db
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='deployment_commit_receipts'")
            .get() as { sql: string };
        expect(createSql.sql).toMatch(/WITHOUT\s+ROWID/i);
        expect(tableColumns(db, "deployment_commit_receipts")).not.toEqual(
            expect.arrayContaining(["created_at", "updated_at", "deleted", "revision", "status"]),
        );
        db.close();
    });

    it("enforces schemaVersion, FK RESTRICT and immutable composite identity", () => {
        const db = loadSchemaFresh(dbPath);
        db.prepare(
            `INSERT INTO deployments (
                deployment_id, consumer_agent_runtime_ids, platform, platform_instance_id, target_root_path,
                project_id, committed_transaction_id, applied_inputs_snapshot,
                applied_render_snapshot_ref, observation_state,
                observation_attempted_at, last_complete_observation_at, blocking_evidence,
                deleted, created_at, updated_at
             ) VALUES ('d1','[]','linux','local-linux','/p','','','{}','{"snapshotState":"never"}','never',0,0,'{}',0,1,1)`,
        ).run();
        const insert = db.prepare(
            `INSERT INTO deployment_commit_receipts VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?
            )`,
        );
        expect(() => insert.run(2, "d1", "t1", "p", "i", "r", "b", "c")).toThrow();
        expect(() => insert.run(1, "missing", "t1", "p", "i", "r", "b", "c")).toThrow();
        insert.run(1, "d1", "t1", "p", "i", "r", "b", "c");
        expect(() => insert.run(1, "d1", "t1", "other", "i", "r", "b", "c2")).toThrow();
        expect(() => db.prepare("DELETE FROM deployments WHERE deployment_id='d1'").run()).toThrow();
        db.close();
    });
});

// ============================================================
// 7. current_asset_index 字段 + global 组合 CHECK(GLOBAL_DBA_REVIEW §4.4)
// ============================================================

describe("current_asset_index table (§4.4)", () => {
    it("has the 14 v1 projected fields", () => {
        const db = loadSchemaFresh(dbPath);
        const cols = tableColumns(db, "current_asset_index");
        const expected = [
            "asset_id",
            "kind",
            "scope",
            "project_id",
            "scope_path",
            "display_name",
            "display_description",
            "current_version_id",
            "current_revision",
            "current_fingerprint",
            "current_version_status",
            "created_at",
            "updated_at",
            "deleted",
        ];
        for (const c of expected) {
            expect(cols).toContain(c);
        }
        db.close();
    });

    it("kind CHECK only accepts the 6 v1 AssetKind values", () => {
        const db = loadSchemaFresh(dbPath);
        const ins = db.prepare(
            "INSERT INTO current_asset_index (asset_id, kind, scope, project_id, scope_path, " +
                "display_name, display_description, current_version_id, current_revision, " +
                "current_fingerprint, current_version_status, created_at, updated_at, deleted) " +
                "VALUES (?, ?, 'global', '', '', 'n', '', 'v1', 1, 'sha256:x', 'complete', 1, 1, 0)",
        );
        for (const k of ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"]) {
            expect(() => ins.run(`a-${k}`, k)).not.toThrow();
        }
        // AgentRule is retired.
        expect(() => ins.run("a-bad", "AgentRule")).toThrow();
        db.close();
    });

    it("global combo CHECK: scope='global' requires empty project_id and scope_path", () => {
        const db = loadSchemaFresh(dbPath);
        const ins = db.prepare(
            "INSERT INTO current_asset_index (asset_id, kind, scope, project_id, scope_path, " +
                "display_name, display_description, current_version_id, current_revision, " +
                "current_fingerprint, current_version_status, created_at, updated_at, deleted) " +
                "VALUES ('a1', ?, ?, ?, ?, 'n', '', 'v1', 1, 'sha256:x', 'complete', 1, 1, 0)",
        );
        // Valid global.
        expect(() => ins.run("Guidance", "global", "", "")).not.toThrow();
        // Invalid global with non-empty project_id.
        expect(() => ins.run("Guidance", "global", "p1", "")).toThrow();
        // Invalid global with non-empty scope_path.
        expect(() => ins.run("Guidance", "global", "", "sub")).toThrow();
        db.close();
    });
});

// ============================================================
// 6. project_index 字段(GLOBAL_DBA_REVIEW §4.6)
// ============================================================

describe("project_index table (§4.6)", () => {
    it("has the 6 v1 projected fields", () => {
        const db = loadSchemaFresh(dbPath);
        const cols = tableColumns(db, "project_index");
        for (const c of ["project_id", "root_path", "display_name", "deleted", "created_at", "updated_at"]) {
            expect(cols).toContain(c);
        }
        db.close();
    });
});

// ============================================================
// 7. db.ts old-schema detection(GLOBAL_DBA_REVIEW §6 CHANGE_REQUIRED #3)
// ============================================================

describe("db.ts old-schema detection", () => {
    beforeEach(() => {
        // db.ts holds a module-level _db singleton; reset modules so each test
        // starts with a fresh singleton state.
        vi.resetModules();
    });

    it("opens cleanly on an empty path (creates v1 schema)", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const freshPath = path.join(tmpDir, "fresh.db");
        const db = getDb(freshPath);
        expect(tableNames(db).has("deployments")).toBe(true);
        closeDb();
    });

    it("resolves durable paths while preserving SQLite's in-memory target", async () => {
        const { resolveDbPath } = await import("../../src/persistence/db");
        expect(resolveDbPath(":memory:")).toBe(":memory:");
        expect(resolveDbPath("relative.db")).toBe(path.resolve("relative.db"));
    });

    it("returns the cached singleton on second getDb call (no path arg)", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const freshPath = path.join(tmpDir, "cached.db");
        const first = getDb(freshPath);
        const second = getDb();
        expect(second).toBe(first); // same cached instance
        closeDb();
    });

    it("reopens an existing current Stage-P schema without misclassifying it as retired", async () => {
        const currentPath = path.join(tmpDir, "current-p6.db");
        const firstModule = await import("../../src/persistence/db");
        firstModule.getDb(currentPath);
        firstModule.closeDb();
        vi.resetModules();
        const reopenedModule = await import("../../src/persistence/db");
        const reopened = reopenedModule.getDb(currentPath);
        expect(tableNames(reopened).has("deployment_render_snapshots")).toBe(true);
        reopenedModule.closeDb();
    });

    it("throws diagnostic when an old-model table is present (no migration)", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const stalePath = path.join(tmpDir, "stale.db");
        // Pre-create a DB with an old-model table.
        const setupDb = new Database(stalePath);
        setupDb.exec("CREATE TABLE asset_versions (version_id TEXT);");
        setupDb.close();
        expect(() => getDb(stalePath)).toThrowError(/pre-rebuild prototype.*asset_versions/);
        // _db should remain null after the throw (close was called inside the guard);
        // closeDb is a no-op on a null singleton.
        closeDb();
    });

    it("throws on user_settings old-model table too", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const stalePath = path.join(tmpDir, "stale2.db");
        const setupDb = new Database(stalePath);
        setupDb.exec("CREATE TABLE user_settings (key TEXT, value TEXT);");
        setupDb.close();
        expect(() => getDb(stalePath)).toThrowError(/pre-rebuild prototype.*user_settings/);
        closeDb();
    });

    it("rejects a pre-Stage-P Deployment schema instead of opening mixed old/new tables", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const stalePath = path.join(tmpDir, "pre-p6.db");
        const setupDb = new Database(stalePath);
        setupDb.exec(
            "CREATE TABLE deployments (" +
                "deployment_id TEXT PRIMARY KEY, adapter_id TEXT NOT NULL, " +
                "consumer_agent_runtime_ids TEXT NOT NULL, applied_inputs_snapshot TEXT NOT NULL)",
        );
        setupDb.close();
        expect(() => getDb(stalePath)).toThrowError(/retired schema marker.*deployments\.adapter_id/);
        closeDb();
    });

    it("rejects a partial DeploymentFile schema missing the strict baseline branch", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const stalePath = path.join(tmpDir, "pre-p6-files.db");
        const setupDb = new Database(stalePath);
        setupDb.exec(
            "CREATE TABLE deployment_files (" + "deployment_file_id TEXT PRIMARY KEY, applied_content_hash TEXT NOT NULL)",
        );
        setupDb.close();
        expect(() => getDb(stalePath)).toThrowError(/retired schema marker.*deployment_files\.applied_content_hash/);
        closeDb();
    });

    it("rejects partially rewritten Deployment tables missing final Stage-P columns", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const staleDeploymentPath = path.join(tmpDir, "partial-deployment.db");
        const deploymentDb = new Database(staleDeploymentPath);
        deploymentDb.exec(
            "CREATE TABLE deployments (" + "deployment_id TEXT PRIMARY KEY, consumer_agent_runtime_ids TEXT NOT NULL)",
        );
        deploymentDb.close();
        expect(() => getDb(staleDeploymentPath)).toThrowError(/deployments missing applied_render_snapshot_ref/);
        closeDb();

        vi.resetModules();
        const dbModule = await import("../../src/persistence/db");
        const staleFilesPath = path.join(tmpDir, "partial-deployment-files.db");
        const filesDb = new Database(staleFilesPath);
        filesDb.exec("CREATE TABLE deployment_files (deployment_file_id TEXT PRIMARY KEY)");
        filesDb.close();
        expect(() => dbModule.getDb(staleFilesPath)).toThrowError(/deployment_files missing baseline_state/);
        dbModule.closeDb();
    });
});
