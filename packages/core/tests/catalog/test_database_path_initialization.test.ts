import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("database path initialization", () => {
    let root: string;

    beforeEach(() => {
        vi.resetModules();
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-database-path-"));
    });

    afterEach(async () => {
        const { closeDb } = await import("../../src/persistence/db");
        closeDb();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("creates a nested custom database parent through Shared", async () => {
        const { getDb } = await import("../../src/persistence/db");
        const nestedPath = path.join(root, "custom", "nested", "state.db");
        const db = getDb(nestedPath);
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'deployments'").get()).toEqual({
            name: "deployments",
        });
        expect(fs.statSync(path.dirname(nestedPath)).isDirectory()).toBe(true);
    });

    it("keeps the special in-memory database independent of filesystem parent initialization", async () => {
        const { getDb } = await import("../../src/persistence/db");
        const db = getDb(":memory:");
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'deployments'").get()).toEqual({
            name: "deployments",
        });
        expect(fs.readdirSync(root)).toEqual([]);
    });

    it("rejects a symlinked database parent without creating the database outside it", async () => {
        const { getDb } = await import("../../src/persistence/db");
        const actual = path.join(root, "actual");
        const linked = path.join(root, "linked");
        fs.mkdirSync(actual);
        fs.symlinkSync(actual, linked);
        expect(() => getDb(path.join(linked, "state.db"))).toThrow(/symbolic|symlink/u);
        expect(fs.readdirSync(actual)).toEqual([]);
    });

    it("rejects a parent path replaced by a regular file after database inspection", async () => {
        const { stateDatabaseInternalsForTest } = await import("../../src/persistence/db");
        const parentPath = path.join(root, "custom");
        const databasePath = path.join(parentPath, "state.db");

        expect(() =>
            stateDatabaseInternalsForTest.getDbWithPostInspectionHook(databasePath, () => {
                fs.writeFileSync(parentPath, "not a directory");
            }),
        ).toThrow(/regular file|directory|wrong entry type/u);
        expect(fs.readFileSync(parentPath, "utf8")).toBe("not a directory");
        expect(fs.existsSync(databasePath)).toBe(false);
    });
});
