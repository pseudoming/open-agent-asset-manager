/** Database startup compatibility and default-path behavior. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";

let tmpDir: string;

const PRE_ADDITION_4_DEPLOYMENTS_DDL = `
CREATE TABLE deployments (
    deployment_id              TEXT    NOT NULL PRIMARY KEY,
    consumer_agent_runtime_ids TEXT    NOT NULL CHECK (json_valid(consumer_agent_runtime_ids)),
    platform                   TEXT    NOT NULL CHECK (platform IN ('win32', 'darwin', 'linux', 'wsl')),
    target_root_path           TEXT    NOT NULL,
    project_id                 TEXT    NOT NULL,
    committed_transaction_id   TEXT    NOT NULL,
    applied_inputs_snapshot    TEXT    NOT NULL CHECK (json_valid(applied_inputs_snapshot)),
    applied_render_snapshot_ref TEXT   NOT NULL CHECK (json_valid(applied_render_snapshot_ref)),
    observation_state          TEXT    NOT NULL
        CHECK (observation_state IN ('never', 'in_progress', 'complete', 'partial', 'failed')),
    blocking_evidence          TEXT    NOT NULL CHECK (json_valid(blocking_evidence)),
    deleted                    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    created_at                 INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at                 INTEGER NOT NULL CHECK (updated_at >= created_at)
);
`;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-deployment-environment-schema-"));
    vi.resetModules();
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tableNames(db: Database.Database): Set<string> {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    return new Set(rows.map((row) => row.name));
}

function createPreAddition4Database(databasePath: string): Database.Database {
    const db = new Database(databasePath);
    db.exec(PRE_ADDITION_4_DEPLOYMENTS_DDL);
    db.exec(fs.readFileSync(path.join(__dirname, "..", "..", "schema", "schema.sql"), "utf8"));
    return db;
}

describe("database startup compatibility", () => {
    it("rebuilds the exact empty pre-Addition-4 schema from canonical schema.sql", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const { assertStateProfileStartup } = await import("../../src/persistence/state-profile");
        const stalePath = path.join(tmpDir, "empty-pre-addition-4.db");
        createPreAddition4Database(stalePath).close();

        expect(
            assertStateProfileStartup({
                oaamRoot: tmpDir,
                databasePath: stalePath,
            }),
        ).toEqual({ state: "compatible_empty_rebuild" });
        const db = getDb(stalePath);
        const columns = db.prepare("PRAGMA table_info(deployments)").all() as Array<{ name: string }>;
        expect(columns.map((column) => column.name)).toEqual([
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
        ]);
        expect(db.prepare("PRAGMA quick_check").pluck().get()).toBe("ok");
        closeDb();
    });

    it("does not enter projection rebuild with only an exact empty pre-Addition-4 database", async () => {
        const { closeDb } = await import("../../src/persistence/db");
        const { StateProfileRecoveryRequiredError } = await import("../../src/persistence/state-profile");
        const { assertStateProfileRestoreStartup } = await import("../../src/orchestration/state-profile-startup");
        const { buildRestoreMarker, RESTORE_MARKER_NAME, serializeRestoreMarker } = await import(
            "../../src/orchestration/state-restore-model"
        );
        const oaamRoot = path.join(tmpDir, "profile");
        const stalePath = path.join(oaamRoot, "index.db");
        fs.mkdirSync(oaamRoot);
        createPreAddition4Database(stalePath).close();
        const restoreId = "00000000-0000-4000-8000-000000000347";
        const transactionPath = path.join(tmpDir, `.profile.restore-txn-${restoreId}`);
        fs.mkdirSync(transactionPath);
        fs.writeFileSync(
            path.join(transactionPath, RESTORE_MARKER_NAME),
            serializeRestoreMarker(
                buildRestoreMarker({
                    restoreId,
                    backupId: "00000000-0000-4000-8000-000000000147",
                    archiveContentHash: `sha256:${"a".repeat(64)}`,
                    sourceSnapshotFingerprint: `sha256:${"a".repeat(64)}`,
                    profileSnapshotFingerprint: `sha256:${"a".repeat(64)}`,
                    oaamRoot,
                    databasePath: stalePath,
                    transactionPath,
                    stagedPath: path.join(transactionPath, "staged"),
                    displacedPath: path.join(transactionPath, "displaced"),
                    phase: "reprojecting",
                }),
            ),
        );

        expect(() => assertStateProfileRestoreStartup({ oaamRoot, databasePath: stalePath })).toThrow(
            expect.objectContaining<StateProfileRecoveryRequiredError>({
                reason: "restore_reconciliation",
                evidencePaths: [transactionPath],
            }),
        );
        closeDb();
    });

    it("rebuilds the exact empty pre-Addition-4 schema when no WAL sidecar was ever used", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const stalePath = path.join(tmpDir, "empty-delete-journal-pre-addition-4.db");
        const setupDb = createPreAddition4Database(stalePath);
        setupDb.pragma("journal_mode = DELETE");
        setupDb.close();

        const db = getDb(stalePath);
        expect(db.prepare("PRAGMA quick_check").pluck().get()).toBe("ok");
        closeDb();
    });

    it("does not rebuild a pre-Addition-4 schema containing Deployment authority", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const stalePath = path.join(tmpDir, "non-empty-pre-addition-4.db");
        const setupDb = createPreAddition4Database(stalePath);
        setupDb
            .prepare(
                `INSERT INTO deployments (
                    deployment_id, consumer_agent_runtime_ids, platform, target_root_path, project_id,
                    committed_transaction_id, applied_inputs_snapshot, applied_render_snapshot_ref,
                    observation_state, blocking_evidence, deleted, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run("legacy-deployment", "[]", "win32", "C:\\fixture", "", "", "{}", "{}", "never", "{}", 0, 1, 1);
        setupDb.close();

        expect(() => getDb(stalePath)).toThrowError(/deployments missing platform_instance_id/);
        closeDb();
    });

    it("does not rebuild a pre-Addition-4 schema containing non-Deployment catalog authority", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const stalePath = path.join(tmpDir, "non-empty-catalog-pre-addition-4.db");
        const setupDb = createPreAddition4Database(stalePath);
        setupDb
            .prepare(
                `INSERT INTO project_index (
                    project_id, root_path, display_name, deleted, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run("existing-project", "/existing", "Existing", 0, 1, 1);
        setupDb.close();

        expect(() => getDb(stalePath)).toThrowError(/deployments missing platform_instance_id/);
        closeDb();
    });

    it("does not rebuild a pre-Addition-4 schema whose table shape is not exact", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const stalePath = path.join(tmpDir, "shape-drift-pre-addition-4.db");
        const setupDb = createPreAddition4Database(stalePath);
        setupDb.exec("ALTER TABLE project_index ADD COLUMN unexpected TEXT");
        setupDb.close();

        expect(() => getDb(stalePath)).toThrowError(/deployments missing platform_instance_id/);
        closeDb();
    });

    it("does not rebuild a pre-Addition-4 schema that fails quick_check", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const stalePath = path.join(tmpDir, "check-failure-pre-addition-4.db");
        const setupDb = createPreAddition4Database(stalePath);
        setupDb.pragma("ignore_check_constraints = ON");
        setupDb
            .prepare(
                `INSERT INTO project_index (
                    project_id, root_path, display_name, deleted, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run("invalid-project", "/invalid", "invalid", 0, -1, -1);
        setupDb.close();

        expect(() => getDb(stalePath)).toThrowError(/deployments missing platform_instance_id/);
        closeDb();
    });

    it("does not rebuild a pre-Addition-4 schema with an orphaned foreign key", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const stalePath = path.join(tmpDir, "foreign-key-failure-pre-addition-4.db");
        const setupDb = createPreAddition4Database(stalePath);
        setupDb.pragma("foreign_keys = OFF");
        setupDb
            .prepare(
                `INSERT INTO deployment_assets (
                    deployment_asset_id, deployment_id, asset_id, version_id, sort_order,
                    allow_incomplete, deleted, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run("orphan", "missing-deployment", "asset", "version", 0, 0, 0, 1, 1);
        setupDb.close();

        expect(() => getDb(stalePath)).toThrowError(/foreign_key_check reported orphan rows/);
        closeDb();
    });

    it("rejects a Deployment schema that predates durable platform-instance identity", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const stalePath = path.join(tmpDir, "pre-platform-instance.db");
        const setupDb = new Database(stalePath);
        setupDb.exec("CREATE TABLE deployments (" + "deployment_id TEXT PRIMARY KEY, applied_render_snapshot_ref TEXT NOT NULL)");
        setupDb.close();
        expect(() => getDb(stalePath)).toThrowError(/deployments missing platform_instance_id/);
        closeDb();
    });

    it("rejects Deployment schemas that predate truthful observation-attempt freshness", async () => {
        const { getDb, closeDb } = await import("../../src/persistence/db");
        const cases = [
            {
                name: "pre-attempt",
                columns: "deployment_id TEXT PRIMARY KEY, applied_render_snapshot_ref TEXT, platform_instance_id TEXT",
                expected: /deployments missing observation_attempted_at/,
            },
            {
                name: "pre-complete",
                columns:
                    "deployment_id TEXT PRIMARY KEY, applied_render_snapshot_ref TEXT, platform_instance_id TEXT, " +
                    "observation_attempted_at INTEGER",
                expected: /deployments missing last_complete_observation_at/,
            },
        ];
        for (const fixture of cases) {
            const stalePath = path.join(tmpDir, `${fixture.name}.db`);
            const setupDb = new Database(stalePath);
            setupDb.exec(`CREATE TABLE deployments (${fixture.columns})`);
            setupDb.close();
            expect(() => getDb(stalePath)).toThrowError(fixture.expected);
            closeDb();
        }
    });

    it("rejects an old schema installed after read-only inspection", async () => {
        const { closeDb, getDb, stateDatabaseInternalsForTest } = await import("../../src/persistence/db");
        const databasePath = path.join(tmpDir, "old-schema-race.db");
        getDb(databasePath);
        closeDb();

        expect(() =>
            stateDatabaseInternalsForTest.getDbWithPostInspectionHook(databasePath, () => {
                const replacement = new Database(databasePath);
                replacement.exec("CREATE TABLE asset_versions (version_id TEXT PRIMARY KEY)");
                replacement.close();
            }),
        ).toThrowError(/asset_versions/u);
        closeDb();
    });

    it("rejects a same-schema database replacement after read-only inspection", async () => {
        const { closeDb, getDb, stateDatabaseInternalsForTest } = await import("../../src/persistence/db");
        const databasePath = path.join(tmpDir, "same-schema-race.db");
        const replacementPath = path.join(tmpDir, "same-schema-replacement.db");
        getDb(databasePath);
        closeDb();
        fs.copyFileSync(databasePath, replacementPath);

        expect(() =>
            stateDatabaseInternalsForTest.getDbWithPostInspectionHook(databasePath, () => {
                fs.renameSync(replacementPath, databasePath);
            }),
        ).toThrowError(/identity changed between read-only inspection and open/u);
        closeDb();
    });

    it("rejects a database path that disappears after read-only inspection", async () => {
        const { closeDb, getDb, stateDatabaseInternalsForTest } = await import("../../src/persistence/db");
        const databasePath = path.join(tmpDir, "disappearing-database-race.db");
        getDb(databasePath);
        closeDb();

        expect(() =>
            stateDatabaseInternalsForTest.getDbWithPostInspectionHook(databasePath, () => {
                fs.rmSync(databasePath);
            }),
        ).toThrowError(/could not be bound to the inspected file before open/u);
        closeDb();
    });

    it("rejects canonical schema drift installed after read-only inspection", async () => {
        const { closeDb, getDb, stateDatabaseInternalsForTest } = await import("../../src/persistence/db");
        const databasePath = path.join(tmpDir, "canonical-schema-race.db");
        getDb(databasePath);
        closeDb();

        expect(() =>
            stateDatabaseInternalsForTest.getDbWithPostInspectionHook(databasePath, () => {
                const replacement = new Database(databasePath);
                replacement.exec("DROP INDEX idx_deployments_project");
                replacement.close();
            }),
        ).toThrowError(/schema changed between read-only inspection and open/u);
        closeDb();
    });

    it("uses DEFAULT_DB_PATH when neither a path nor override is provided", async () => {
        const originalHome = process.env.HOME;
        const originalDbPath = process.env.OAAM_DB_PATH;
        process.env.HOME = tmpDir;
        delete process.env.OAAM_DB_PATH;
        try {
            const { getDb, closeDb } = await import("../../src/persistence/db");
            const db = getDb();
            expect(tableNames(db).has("deployments")).toBe(true);
            closeDb();
        } finally {
            process.env.HOME = originalHome;
            if (originalDbPath !== undefined) process.env.OAAM_DB_PATH = originalDbPath;
        }
    });
});
