import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";

export function createProjectRegistry(
    registryPath: string,
    rows: Array<{
        workspaceKey: unknown;
        workspacePath: unknown;
        workspaceIdentity?: unknown;
        deleted?: number;
    }>,
): void {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const database = new Database(registryPath);
    try {
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
            "INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, deleted) VALUES (?, ?, ?, ?, ?)",
        );
        rows.forEach((row, index) => {
            insert.run(row.workspaceKey, row.workspacePath, row.workspaceIdentity ?? null, `task-${index}`, row.deleted ?? 0);
        });
    } finally {
        database.close();
    }
}
