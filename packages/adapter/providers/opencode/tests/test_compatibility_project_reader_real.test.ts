import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { immutableReadOnlyDatabaseUri, readCompatibleOpenCodeProjects } from "../src/opencode-compatibility-project-reader";

let sandbox = "";
let databasePath = "";
const originalSqliteUseUri = process.env.SQLITE_USE_URI;
process.env.SQLITE_USE_URI = "1";

afterAll(() => {
    if (originalSqliteUseUri === undefined) {
        delete process.env.SQLITE_USE_URI;
    } else {
        process.env.SQLITE_USE_URI = originalSqliteUseUri;
    }
});

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-compatibility-reader-"));
    databasePath = path.join(sandbox, "opencode registry #1.db");
    const database = new Database(databasePath);
    database.exec(`
        CREATE TABLE project (
            id TEXT PRIMARY KEY,
            worktree TEXT NOT NULL,
            vcs TEXT,
            name TEXT,
            icon_url TEXT,
            icon_url_override TEXT,
            icon_color TEXT,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            time_initialized INTEGER,
            sandboxes TEXT NOT NULL,
            commands TEXT
        );
        CREATE TABLE project_directory (
            project_id TEXT NOT NULL,
            directory TEXT NOT NULL,
            type TEXT,
            strategy TEXT,
            time_created INTEGER NOT NULL,
            PRIMARY KEY (project_id, directory)
        );
        INSERT INTO project (
            id, worktree, vcs, name, icon_url, icon_url_override, icon_color,
            time_created, time_updated, time_initialized, sandboxes, commands
        ) VALUES (
            'project-real', '/work/real', 'git', '真实项目', NULL, NULL, NULL,
            1, 2, NULL, '["/work/sandbox"]', NULL
        );
        INSERT INTO project_directory (
            project_id, directory, type, strategy, time_created
        ) VALUES (
            'project-real', '/work/additional', 'worktree', NULL, 1
        );
    `);
    database.close();
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("real OpenCode compatibility project reader", () => {
    it("uses a percent-encoded immutable read-only SQLite URI", () => {
        const uri = immutableReadOnlyDatabaseUri(databasePath);
        expect(uri).toContain("opencode%20registry%20%231.db");
        expect(uri).toMatch(/^file:.*\?mode=ro&immutable=1$/u);
    });

    it("reads a known clean registry without changing bytes, metadata, or inventory", () => {
        const before = state();
        const result = readCompatibleOpenCodeProjects(databasePath);
        const after = state();

        expect(result).toMatchObject({
            status: "complete",
            readerVersion: "12.11.1",
            schemaFingerprint: "opencode-project-registry-20260423070820",
            projects: [
                {
                    id: "project-real",
                    worktree: "/work/real",
                    name: "真实项目",
                    sandboxes: ["/work/additional", "/work/sandbox"],
                },
            ],
        });
        expect(after).toEqual(before);
    });

    it("fails closed when SQLite URI interpretation was not authorized for the reader process", () => {
        delete process.env.SQLITE_USE_URI;
        try {
            expect(readCompatibleOpenCodeProjects(databasePath)).toMatchObject({
                status: "failed",
                failureCode: "sqlite_uri_disabled",
            });
        } finally {
            process.env.SQLITE_USE_URI = "1";
        }
    });

    it("rejects a corrupt database and a schema with an unreviewed extra column", () => {
        fs.writeFileSync(databasePath, "not sqlite");
        expect(readCompatibleOpenCodeProjects(databasePath)).toMatchObject({
            status: "failed",
            failureCode: "sqlite_invalid",
        });

        fs.rmSync(databasePath);
        const database = new Database(databasePath);
        database.exec(`
            CREATE TABLE project (
                id TEXT PRIMARY KEY,
                worktree TEXT NOT NULL,
                vcs TEXT,
                name TEXT,
                icon_url TEXT,
                icon_url_override TEXT,
                icon_color TEXT,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                time_initialized INTEGER,
                sandboxes TEXT NOT NULL,
                commands TEXT,
                future TEXT
            );
            CREATE TABLE project_directory (
                project_id TEXT NOT NULL,
                directory TEXT NOT NULL,
                type TEXT,
                strategy TEXT,
                time_created INTEGER NOT NULL,
                PRIMARY KEY (project_id, directory)
            );
        `);
        database.close();
        expect(readCompatibleOpenCodeProjects(databasePath)).toMatchObject({
            status: "failed",
            failureCode: "schema_project",
        });
    });
});

function state() {
    return {
        inventory: fs.readdirSync(sandbox).sort(),
        identity: identity(databasePath),
        size: fs.statSync(databasePath, { bigint: true }).size.toString(),
        mtimeNanoseconds: fs.statSync(databasePath, { bigint: true }).mtimeNs.toString(),
        sha256: crypto.createHash("sha256").update(fs.readFileSync(databasePath)).digest("hex"),
    };
}

function identity(filePath: string): string {
    const stat = fs.statSync(filePath, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
}
