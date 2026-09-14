import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlatformContext } from "@oaam/core";
import { readZcodeProjectRegistry } from "../src/zcode-probe-project-registry";
import { createProjectRegistry } from "./zcode-registry-fixtures";

let sandbox = "";
let registry = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-zcode-registry-"));
    registry = path.join(sandbox, "tasks-index.sqlite");
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("ZCode project registry", () => {
    it("projects only live workspace identity/path fields from a safe SQLite snapshot", () => {
        const first = path.join(sandbox, "project-a");
        const deleted = path.join(sandbox, "deleted");
        fs.mkdirSync(first);
        fs.mkdirSync(deleted);
        createProjectRegistry(registry, [
            { workspaceKey: "workspace-a", workspacePath: first, workspaceIdentity: "identity-a" },
            { workspaceKey: "workspace-a", workspacePath: first, workspaceIdentity: "identity-a" },
            { workspaceKey: "workspace-deleted", workspacePath: deleted, deleted: 1 },
        ]);
        const result = readZcodeProjectRegistry(registry, context());
        expect(result).toMatchObject({ status: "complete", diagnostics: [] });
        expect(result.projects).toEqual([
            expect.objectContaining({
                runtimeProjectKey: "workspace-a",
                runtimePath: first,
                hostPath: first,
                locatorKey: expect.stringMatching(/^registry-entry:[0-9a-f]{64}$/u),
            }),
        ]);
        expect(JSON.stringify(result)).not.toContain("task-");
    });

    it("drops conflicting keys and physical paths instead of choosing by row order", () => {
        const first = path.join(sandbox, "project-a");
        const second = path.join(sandbox, "project-b");
        fs.mkdirSync(first);
        fs.mkdirSync(second);
        createProjectRegistry(registry, [
            { workspaceKey: "same-key", workspacePath: first },
            { workspaceKey: "same-key", workspacePath: second },
            { workspaceKey: "path-a", workspacePath: first },
            { workspaceKey: "path-b", workspacePath: first },
        ]);
        const result = readZcodeProjectRegistry(registry, context());
        expect(result.status).toBe("partial");
        expect(result.projects).toEqual([]);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "zcode_project_registry_identity_ambiguous" }));
    });

    it("rejects malformed rows and paths outside the selected access root", () => {
        const selected = path.join(sandbox, "selected");
        const valid = path.join(selected, "project");
        fs.mkdirSync(valid, { recursive: true });
        createProjectRegistry(registry, [
            { workspaceKey: Buffer.from([7]), workspacePath: valid },
            { workspaceKey: "outside", workspacePath: path.join(sandbox, "outside") },
            { workspaceKey: "valid", workspacePath: valid },
        ]);
        const result = readZcodeProjectRegistry(registry, context(selected));
        expect(result.status).toBe("partial");
        expect(result.projects).toEqual([expect.objectContaining({ runtimeProjectKey: "valid", hostPath: valid })]);
        expect(result.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining(["zcode_project_registry_entry_invalid", "zcode_project_registry_path_unreachable"]),
        );
    });

    it("rejects corrupt, wrong-schema, symlink, and oversized registry files", () => {
        fs.writeFileSync(registry, "not sqlite");
        expect(readZcodeProjectRegistry(registry, context())).toMatchObject({
            status: "partial",
            projects: [],
            diagnostics: [expect.objectContaining({ code: "zcode_project_registry_invalid" })],
        });

        fs.rmSync(registry);
        const database = new Database(registry);
        database.exec("CREATE TABLE tasks (workspace_key TEXT)");
        database.close();
        expect(readZcodeProjectRegistry(registry, context())).toMatchObject({
            diagnostics: [expect.objectContaining({ code: "zcode_project_registry_schema_invalid" })],
        });

        const real = path.join(sandbox, "real.sqlite");
        createProjectRegistry(real, []);
        fs.rmSync(registry);
        fs.symlinkSync(real, registry);
        expect(readZcodeProjectRegistry(registry, context())).toMatchObject({
            diagnostics: [expect.objectContaining({ code: "zcode_project_registry_snapshot_unstable" })],
        });

        fs.rmSync(registry);
        fs.writeFileSync(registry, "");
        fs.truncateSync(registry, 64 * 1024 * 1024 + 1);
        expect(readZcodeProjectRegistry(registry, context())).toMatchObject({
            diagnostics: [expect.objectContaining({ code: "zcode_project_registry_invalid" })],
        });
    });

    it("fails the entire projection when the bounded distinct-row limit is exceeded", () => {
        const database = new Database(registry);
        database.exec(`
            CREATE TABLE tasks (
                workspace_key TEXT NOT NULL,
                workspace_path TEXT NOT NULL,
                workspace_identity TEXT,
                task_id TEXT NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (workspace_key, task_id)
            );
        `);
        const insert = database.prepare(
            "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, deleted) VALUES (?, ?, NULL, ?, 0)",
        );
        const transaction = database.transaction(() => {
            for (let index = 0; index < 1025; index += 1) {
                insert.run(`workspace-${index}`, path.join(sandbox, `project-${index}`), `task-${index}`);
            }
        });
        transaction();
        database.close();
        expect(readZcodeProjectRegistry(registry, context())).toMatchObject({
            status: "partial",
            projects: [],
            diagnostics: [expect.objectContaining({ code: "zcode_project_registry_too_large" })],
        });
    });

    it("includes committed WAL-only Projects while leaving the active main, WAL and SHM bytes unchanged", () => {
        const checkpointed = path.join(sandbox, "checkpointed");
        const walOnly = path.join(sandbox, "wal-only");
        fs.mkdirSync(checkpointed);
        fs.mkdirSync(walOnly);
        createProjectRegistry(registry, [
            { workspaceKey: "checkpointed", workspacePath: checkpointed, workspaceIdentity: "checkpointed" },
        ]);
        const database = new Database(registry);
        database.pragma("journal_mode = WAL");
        database.pragma("wal_autocheckpoint = 0");
        database
            .prepare(
                "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, deleted) VALUES (?, ?, ?, ?, 0)",
            )
            .run("wal-only", walOnly, "wal-only", "task-wal-only");
        try {
            const sources = [registry, `${registry}-wal`, `${registry}-shm`];
            const before = sources.map((filePath) => fs.readFileSync(filePath));
            const result = readZcodeProjectRegistry(registry, context());
            expect(result.status).toBe("complete");
            expect(result.projects).toEqual([
                expect.objectContaining({ runtimeProjectKey: "checkpointed" }),
                expect.objectContaining({ runtimeProjectKey: "wal-only" }),
            ]);
            expect(result.diagnostics).toEqual([]);
            expect(sources.map((filePath) => fs.readFileSync(filePath))).toEqual(before);
            expect(fs.readdirSync(sandbox).sort()).toEqual([
                "checkpointed",
                "tasks-index.sqlite",
                "tasks-index.sqlite-shm",
                "tasks-index.sqlite-wal",
                "wal-only",
            ]);
        } finally {
            database.close();
        }
    });
});

function context(accessRootPath = "/"): PlatformContext {
    return { platform: "linux", platformInstanceId: "fixture", accessRootPath };
}
