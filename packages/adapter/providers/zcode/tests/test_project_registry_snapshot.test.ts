import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { readRegularFileBounded } from "@oaam/shared/filesystem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readZcodeProjectRegistry } from "../src/zcode-probe-project-registry";
import { readZcodeProjectRegistrySnapshot } from "../src/zcode-probe-project-registry-snapshot";
import { createProjectRegistry } from "./zcode-registry-fixtures";

let root = "",
    registry = "";
const databases: Database.Database[] = [];
const context = { platform: "linux", platformInstanceId: "fixture", accessRootPath: "/" } as const;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-zcode-wal-snapshot-"));
    registry = path.join(root, "registry.sqlite");
    createProjectRegistry(registry, [{ workspaceKey: "checkpoint", workspacePath: path.join(root, "checkpoint") }]);
});

afterEach(() => {
    for (const database of databases.splice(0)) {
        if (database.inTransaction) database.exec("ROLLBACK");
        database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
});

function activeWal(committed = true): Database.Database {
    const database = new Database(registry);
    databases.push(database);
    database.pragma("journal_mode = WAL");
    database.pragma("wal_autocheckpoint = 0");
    if (committed)
        database
            .prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, 0)")
            .run("committed", path.join(root, "committed"), "id-committed", "private-task");
    return database;
}

function projectedKeys(): string[] {
    const result = readZcodeProjectRegistry(registry, context);
    expect(result.diagnostics).toEqual([]);
    expect(result.status).toBe("complete");
    return result.projects.map((project) => project.runtimeProjectKey).sort();
}

describe("ZCode committed in-memory WAL snapshot", () => {
    it("does not expose the first WAL transaction before it has any commit marker", () => {
        const database = activeWal(false);
        database.pragma("cache_size = 1");
        database.exec("BEGIN IMMEDIATE");
        const insert = database.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, 0)");
        for (let index = 0; index < 80; index += 1) {
            insert.run(`pending-${index}`, path.join(root, `pending-${index}`), "x".repeat(3_000), `task-${index}`);
        }
        expect(fs.statSync(`${registry}-wal`).size).toBeGreaterThan(32);
        expect(projectedKeys()).toEqual(["checkpoint"]);
        expect(database.inTransaction).toBe(true);
    });

    it("combines the latest commit with a main database held at a partial checkpoint by an older reader", () => {
        const database = activeWal();
        const reader = new Database(registry);
        databases.push(reader);
        reader.exec("BEGIN");
        expect(reader.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 2 });
        database.prepare("INSERT INTO tasks VALUES (?, ?, NULL, ?, 0)").run("newer", path.join(root, "newer"), "newer-task");
        const checkpoint = database.pragma("wal_checkpoint(PASSIVE)") as Array<{ log: number; checkpointed: number }>;
        expect(checkpoint[0]?.checkpointed).toBeLessThan(checkpoint[0]?.log ?? 0);
        const before = [registry, `${registry}-wal`, `${registry}-shm`].map((filePath) => fs.readFileSync(filePath));
        expect(projectedKeys()).toEqual(["checkpoint", "committed", "newer"]);
        expect([registry, `${registry}-wal`, `${registry}-shm`].map((filePath) => fs.readFileSync(filePath))).toEqual(before);
        expect(reader.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 2 });
        expect(reader.inTransaction).toBe(true);
    });

    it("ignores a real spilled uncommitted transaction after the latest commit", () => {
        const database = activeWal();
        const committedLength = fs.statSync(`${registry}-wal`).size;
        database.pragma("cache_size = 1");
        database.exec("BEGIN IMMEDIATE");
        const insert = database.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, 0)");
        for (let index = 0; index < 80; index += 1) {
            insert.run(`pending-${index}`, path.join(root, `pending-${index}`), "x".repeat(3_000), `task-${index}`);
        }
        expect(fs.statSync(`${registry}-wal`).size).toBeGreaterThan(committedLength);
        const before = [registry, `${registry}-wal`, `${registry}-shm`].map((filePath) => fs.readFileSync(filePath));
        expect(projectedKeys()).toEqual(["checkpoint", "committed"]);
        expect([registry, `${registry}-wal`, `${registry}-shm`].map((filePath) => fs.readFileSync(filePath))).toEqual(before);
        expect(database.inTransaction).toBe(true);
    });

    it("uses new committed frames after reset without applying stale frames from the previous WAL generation", () => {
        const database = activeWal();
        const insert = database.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, 0)");
        database.transaction(() => {
            for (let index = 0; index < 50; index += 1) {
                insert.run(`retained-${index}`, path.join(root, `retained-${index}`), "x".repeat(2_000), `task-${index}`);
            }
        })();
        const previous = fs.readFileSync(`${registry}-wal`);
        database.pragma("wal_checkpoint(RESTART)");
        database
            .prepare("UPDATE tasks SET workspace_path = ? WHERE workspace_key = ?")
            .run(path.join(root, "changed"), "committed");
        const reset = fs.readFileSync(`${registry}-wal`);
        expect(reset.length).toBe(previous.length);
        expect(reset.subarray(16, 24)).not.toEqual(previous.subarray(16, 24));
        const result = readZcodeProjectRegistry(registry, context);
        expect(result.status).toBe("complete");
        expect(result.diagnostics).toEqual([]);
        expect(result.projects).toHaveLength(52);
        expect(result.projects.find((project) => project.runtimeProjectKey === "committed")?.hostPath).toBe(
            path.join(root, "changed"),
        );
        expect(fs.readFileSync(`${registry}-wal`)).toEqual(reset);
    });

    it.each([
        [
            "header",
            (bytes: Buffer) => {
                bytes[24] = (bytes[24] ?? 0) ^ 1;
                return bytes;
            },
        ],
        [
            "frame",
            (bytes: Buffer) => {
                bytes[48] = (bytes[48] ?? 0) ^ 1;
                return bytes;
            },
        ],
        [
            "page number",
            (bytes: Buffer) => {
                bytes.writeUInt32BE(0, 32);
                return bytes;
            },
        ],
        [
            "page limit",
            (bytes: Buffer) => {
                bytes.writeUInt32BE(0xffffffff, 36);
                return bytes;
            },
        ],
        ["short header", (bytes: Buffer) => bytes.subarray(0, 20)],
        ["short frame", (bytes: Buffer) => bytes.subarray(0, bytes.length - 1)],
        [
            "version",
            (bytes: Buffer) => {
                bytes.writeUInt32BE(1, 4);
                return bytes;
            },
        ],
        [
            "page size",
            (bytes: Buffer) => {
                bytes.writeUInt32BE(1, 8);
                return bytes;
            },
        ],
    ] as const)("rejects invalid WAL %s instead of publishing checkpoint-only completeness", (_name, corrupt) => {
        activeWal();
        const original = fs.readFileSync(`${registry}-wal`);
        const damaged = corrupt(Buffer.from(original));
        expect(() =>
            readZcodeProjectRegistrySnapshot(registry, {
                read: (filePath, limit) => (filePath === `${registry}-wal` ? damaged : readRegularFileBounded(filePath, limit)),
            }),
        ).toThrow(expect.objectContaining({ code: "zcode_project_registry_wal_invalid" }));
        expect(fs.readFileSync(`${registry}-wal`)).toEqual(original);
    });

    it("rejects a real source change between the captured main and WAL", () => {
        const database = activeWal();
        let changed = false;
        expect(() =>
            readZcodeProjectRegistrySnapshot(registry, {
                read: (filePath, limit) => {
                    const bytes = readRegularFileBounded(filePath, limit);
                    if (!changed && filePath === registry) {
                        changed = true;
                        database
                            .prepare("INSERT INTO tasks VALUES (?, ?, NULL, ?, 0)")
                            .run("new", path.join(root, "new"), "new-task");
                    }
                    return bytes;
                },
            }),
        ).toThrow(expect.objectContaining({ code: "zcode_project_registry_snapshot_unstable" }));
        expect(changed).toBe(true);
        expect(projectedKeys()).toEqual(["checkpoint", "committed", "new"]);
    });

    it.each(["main", "WAL"] as const)("rejects changed %s bytes even when the observation metadata is unchanged", (part) => {
        activeWal();
        const changedPath = part === "main" ? registry : `${registry}-wal`;
        let observations = 0;
        expect(() =>
            readZcodeProjectRegistrySnapshot(registry, {
                read: (filePath, limit) => {
                    const bytes = Buffer.from(readRegularFileBounded(filePath, limit));
                    if (filePath === changedPath && ++observations === 2) bytes[100] = (bytes[100] ?? 0) ^ 1;
                    return bytes;
                },
            }),
        ).toThrow(expect.objectContaining({ code: "zcode_project_registry_snapshot_unstable" }));
        expect(observations).toBe(2);
    });

    it("rejects a possible rollback journal and untrusted WAL sidecars without changing them", () => {
        fs.writeFileSync(`${registry}-journal`, "hot rollback journal");
        expect(readZcodeProjectRegistry(registry, context)).toMatchObject({
            status: "partial",
            projects: [],
            diagnostics: [expect.objectContaining({ code: "zcode_project_registry_journal_active" })],
        });
        expect(fs.readFileSync(`${registry}-journal`, "utf8")).toBe("hot rollback journal");
        fs.rmSync(`${registry}-journal`);
        fs.symlinkSync(registry, `${registry}-wal`);
        expect(readZcodeProjectRegistry(registry, context)).toMatchObject({
            status: "partial",
            projects: [],
            diagnostics: [expect.objectContaining({ code: "zcode_project_registry_snapshot_unstable" })],
        });
        expect(fs.lstatSync(`${registry}-wal`).isSymbolicLink()).toBe(true);
    });

    it("stops before reading when the bounded observation deadline expires", () => {
        const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(5_001);
        const read = vi.fn(readRegularFileBounded);
        expect(() => readZcodeProjectRegistrySnapshot(registry, { now, read })).toThrow(
            expect.objectContaining({ code: "zcode_project_registry_snapshot_unstable" }),
        );
        expect(read).not.toHaveBeenCalled();
    });
});
