import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/persistence/db", () => ({
    getDb: vi.fn(),
}));

import { getDb } from "../../src/persistence/db";
import { reindexAssets } from "../../src/catalog/reindex";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("reindexAssets: getDb fallback", () => {
    it("uses getDb() when db not passed", () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-getdb-"));
        const db = new Database(":memory:");
        db.pragma("foreign_keys = ON");
        const schemaPath = path.resolve(__dirname, "../../schema/schema.sql");
        db.exec(fs.readFileSync(schemaPath, "utf-8"));
        vi.mocked(getDb).mockReturnValue(db);
        const report = reindexAssets(tmpDir);
        expect(report.scannedAssets).toBe(0);
        vi.restoreAllMocks();
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});
