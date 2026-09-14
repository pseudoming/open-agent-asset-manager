import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { inspectRegularFileNoFollow } from "@oaam/shared/filesystem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import { createCoreService } from "../../src/orchestration/core-service";
import { closeDb, getDb, stateDatabaseInternalsForTest } from "../../src/persistence/db";
import {
    assertStateProfileStartup,
    StateProfileRecoveryRequiredError,
    stateProfileInternalsForTest,
} from "../../src/persistence/state-profile";

describe("State profile startup classification", () => {
    let sandbox = "";
    let oaamRoot = "";
    let databasePath = "";

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-state-profile-"));
        oaamRoot = path.join(sandbox, "oaam");
        databasePath = path.join(oaamRoot, "index.db");
        closeDb();
        clearRegistry();
    });

    afterEach(() => {
        closeDb();
        clearRegistry();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    function startCore() {
        return createCoreService({
            providers: [],
            platformContexts: [],
            oaamRoot,
            databasePath,
        });
    }

    function captureRecoveryRequired(action: () => unknown): StateProfileRecoveryRequiredError {
        try {
            action();
        } catch (error) {
            expect(error).toBeInstanceOf(StateProfileRecoveryRequiredError);
            return error as StateProfileRecoveryRequiredError;
        }
        throw new Error("expected StateProfileRecoveryRequiredError");
    }

    it("creates canonical state only for a virgin missing profile", () => {
        const core = startCore();

        expect(core.listAdapterProviders().value).toEqual([]);
        expect(fs.existsSync(databasePath)).toBe(true);
        expect(fs.readdirSync(oaamRoot).sort()).toEqual(["index.db", "index.db-shm", "index.db-wal", "transactions"]);

        core.shutdownProcessState();

        expect(fs.readdirSync(oaamRoot).sort()).toEqual(["index.db", "transactions"]);
    });

    it("reopens an existing canonical database without classifying it as missing", () => {
        startCore();
        closeDb();
        clearRegistry();

        const reopened = startCore();

        expect(reopened.listDeployments({}).status).toBe("complete");
    });

    it("keeps the in-memory database classification independent of profile files", () => {
        expect(
            assertStateProfileStartup({
                oaamRoot,
                databasePath: ":memory:",
            }),
        ).toEqual({ state: "memory" });
        expect(fs.existsSync(oaamRoot)).toBe(false);
    });

    it("allows empty known scaffold directories before first database creation", () => {
        for (const directory of ["assets", "deployments", "projects", "transactions"]) {
            fs.mkdirSync(path.join(oaamRoot, directory), { recursive: true });
        }

        startCore();

        expect(fs.existsSync(databasePath)).toBe(true);
    });

    it("treats a known scaffold that disappears before child inspection as material", () => {
        expect(stateProfileInternalsForTest.knownScaffoldContainsMaterial(path.join(oaamRoot, "assets"))).toBe(true);
    });

    it("blocks a missing database beside settings authority without mutating the profile", () => {
        fs.mkdirSync(oaamRoot);
        const settingsPath = path.join(oaamRoot, "settings.json");
        fs.writeFileSync(settingsPath, '{"schemaVersion":1}');
        const before = fs.readFileSync(settingsPath);

        const error = captureRecoveryRequired(startCore);

        expect(error).toMatchObject({
            state: "recovery_required",
            reason: "missing_database",
            databasePath,
            evidencePaths: [settingsPath],
        });
        expect(fs.readFileSync(settingsPath)).toEqual(before);
        expect(fs.existsSync(databasePath)).toBe(false);
        expect(fs.readdirSync(oaamRoot)).toEqual(["settings.json"]);
    });

    it("blocks a missing database when a known scaffold contains recovery material", () => {
        const journalPath = path.join(oaamRoot, "transactions", "pending.json");
        fs.mkdirSync(path.dirname(journalPath), { recursive: true });
        fs.writeFileSync(journalPath, "{}");

        const error = captureRecoveryRequired(startCore);

        expect(error.reason).toBe("missing_database");
        expect(error.evidencePaths).toEqual([path.join(oaamRoot, "transactions")]);
        expect(fs.existsSync(databasePath)).toBe(false);
        expect(fs.readFileSync(journalPath, "utf8")).toBe("{}");
    });

    it("treats a database sidecar without the main database as recovery evidence", () => {
        fs.mkdirSync(oaamRoot);
        const sidecar = `${databasePath}-wal`;
        fs.writeFileSync(sidecar, "orphan");

        const error = captureRecoveryRequired(startCore);

        expect(error.reason).toBe("missing_database");
        expect(error.evidencePaths).toEqual([sidecar]);
        expect(fs.existsSync(databasePath)).toBe(false);
    });

    it("treats a directory masquerading as a database sidecar as recovery evidence", () => {
        const sidecar = `${databasePath}-shm`;
        fs.mkdirSync(sidecar, { recursive: true });

        const error = captureRecoveryRequired(startCore);

        expect(error.reason).toBe("missing_database");
        expect(error.evidencePaths).toEqual([sidecar]);
        expect(fs.existsSync(databasePath)).toBe(false);
    });

    it("treats an unknown empty profile directory as established profile evidence", () => {
        const backupRoot = path.join(oaamRoot, "backups");
        fs.mkdirSync(backupRoot, { recursive: true });

        const error = captureRecoveryRequired(startCore);

        expect(error.reason).toBe("missing_database");
        expect(error.evidencePaths).toEqual([backupRoot]);
        expect(fs.existsSync(databasePath)).toBe(false);
    });

    it("blocks corrupt bytes without creating normal profile scaffolding", () => {
        fs.mkdirSync(oaamRoot);
        fs.writeFileSync(databasePath, "not sqlite");
        const before = fs.readFileSync(databasePath);

        const error = captureRecoveryRequired(startCore);

        expect(error.reason).toBe("corrupt_database");
        expect(fs.readFileSync(databasePath)).toEqual(before);
        expect(fs.readdirSync(oaamRoot)).toEqual(["index.db"]);
    });

    it("blocks a valid SQLite file whose schema is not canonical", () => {
        fs.mkdirSync(oaamRoot);
        const database = new Database(databasePath);
        database.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
        database.close();

        const error = captureRecoveryRequired(startCore);

        expect(error.reason).toBe("incompatible_database");
        expect(fs.readdirSync(oaamRoot)).toEqual(["index.db"]);
    });

    it("blocks an existing database whose quick check reports physical corruption", () => {
        fs.mkdirSync(oaamRoot);
        getDb(databasePath);
        closeDb();
        const setupDb = new Database(databasePath);
        const pageSize = setupDb.pragma("page_size", { simple: true }) as number;
        const row = setupDb.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'idx_deployments_project'").get() as {
            readonly rootpage: number;
        };
        setupDb.close();
        const bytes = fs.readFileSync(databasePath);
        bytes[(row.rootpage - 1) * pageSize] = 0;
        fs.writeFileSync(databasePath, bytes);

        const error = captureRecoveryRequired(startCore);

        expect(error.reason).toBe("corrupt_database");
        expect(error.message).toMatch(/quick_check/u);
    });

    it("rejects a database path replaced during read-only inspection", () => {
        fs.mkdirSync(oaamRoot);
        getDb(databasePath);
        closeDb();
        const identity = inspectRegularFileNoFollow(databasePath);
        let calls = 0;

        const inspection = stateDatabaseInternalsForTest.inspectStateDatabaseWithFileInspector(databasePath, () => {
            calls += 1;
            return calls === 1 ? identity : { ...identity, fileId: `${identity.fileId}-replacement` };
        });

        expect(inspection).toEqual({
            state: "corrupt",
            marker: "database path identity changed during read-only inspection",
        });
    });

    it("rejects a database path that cannot be re-confirmed after inspection", () => {
        fs.mkdirSync(oaamRoot);
        getDb(databasePath);
        closeDb();
        const identity = inspectRegularFileNoFollow(databasePath);
        let calls = 0;

        const inspection = stateDatabaseInternalsForTest.inspectStateDatabaseWithFileInspector(databasePath, () => {
            calls += 1;
            if (calls === 1) return identity;
            throw new Error("fixture identity failure");
        });

        expect(inspection).toEqual({
            state: "corrupt",
            marker: "database path could not be re-confirmed after inspection: Error: fixture identity failure",
        });
    });

    it("does not enter a symlinked profile root or create a database outside it", () => {
        const outside = path.join(sandbox, "outside");
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, "settings.json"), "{}");
        fs.symlinkSync(outside, oaamRoot);

        const error = captureRecoveryRequired(startCore);

        expect(error.reason).toBe("corrupt_database");
        expect(fs.readdirSync(outside)).toEqual(["settings.json"]);
        expect(fs.existsSync(path.join(outside, "index.db"))).toBe(false);
    });

    it("reports an unsafe profile root as missing-state recovery evidence when the database path is separate", () => {
        const outside = path.join(sandbox, "outside-root");
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, oaamRoot);
        const separateDatabasePath = path.join(sandbox, "missing-index.db");

        const error = captureRecoveryRequired(() =>
            assertStateProfileStartup({
                oaamRoot,
                databasePath: separateDatabasePath,
            }),
        );

        expect(error).toMatchObject({
            reason: "missing_database",
            databasePath: separateDatabasePath,
            evidencePaths: [oaamRoot],
        });
        expect(error.cause).toBeDefined();
        expect(fs.readdirSync(outside)).toEqual([]);
    });
});
