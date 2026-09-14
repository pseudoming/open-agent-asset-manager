import type { AdapterProbeResult } from "@oaam/core";
import { readCommittedSqliteSnapshot } from "@oaam/shared/filesystem";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPathRule } from "../src/antigravity-paths";
import { readAntigravityCliProjectIndex } from "../src/antigravity-probe-cli-project-index";
import { discoverAntigravityProjects } from "../src/antigravity-probe-projects";

let root = "",
    registry = "";
const databases: Database.Database[] = [];
const context = () => ({ platform: "linux" as const, platformInstanceId: "fixture", accessRootPath: root });
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-antigravity-cli-index-"));
    registry = path.join(root, "conversation_summaries.db");
});
afterEach(() => {
    for (const database of databases.splice(0)) {
        if (database.inTransaction) database.exec("ROLLBACK");
        database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
});
function database(): Database.Database {
    const db = new Database(registry);
    databases.push(db);
    db.exec("CREATE TABLE conversation_summaries (project_id TEXT, workspace_uris TEXT, private_conversation TEXT)");
    return db;
}
function add(db: Database.Database, id: string, workspaces: unknown) {
    db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?)").run(
        id,
        typeof workspaces === "string" ? workspaces : JSON.stringify(workspaces),
        "private-content-never-selected",
    );
}
function uris(...names: string[]) {
    return names.map((name) => pathToFileURL(path.join(root, name)).href);
}
function observe(overrides: Parameters<typeof readAntigravityCliProjectIndex>[3] = {}) {
    return readAntigravityCliProjectIndex(registry, "cli-index", context(), overrides);
}

describe("Antigravity CLI project-index anchors", () => {
    it("deduplicates exact anchor rows, preserves extra workspaces and excludes empty runtime-only entries", async () => {
        const db = database();
        add(db, "project", uris("primary", "additional"));
        add(db, "project", uris("primary", "additional"));
        add(db, "default-cli-project", "");
        add(db, "virtual", []);
        const result = await observe();
        expect(result.status).toBe("complete");
        expect(result.diagnostics).toEqual([]);
        expect(result.records).toEqual([
            expect.objectContaining({
                runtimeProjectKey: "project",
                agentRuntimeIds: ["ANTIGRAVITY_CLI"],
                workspaces: [
                    { path: path.join(root, "primary"), role: "primary" },
                    { path: path.join(root, "additional"), role: "additional" },
                ],
                evidence: [expect.objectContaining({ agentRuntimeResourceId: "cli-index", evidenceLevel: "local_artifact" })],
            }),
        ]);
        expect(JSON.stringify(result)).not.toContain("private-content");
        expect(JSON.stringify(result)).not.toContain("private_conversation");
    });

    it("reads a real committed WAL while excluding a spilled uncommitted transaction and changing no source bytes", async () => {
        const db = database();
        add(db, "checkpoint", uris("checkpoint"));
        db.pragma("journal_mode = WAL");
        db.pragma("wal_autocheckpoint = 0");
        add(db, "committed", uris("committed"));
        db.pragma("cache_size = 1");
        db.exec("BEGIN IMMEDIATE");
        for (let index = 0; index < 80; index += 1) add(db, `pending-${index}`, uris(`pending-${index}-${"x".repeat(2000)}`));
        const sourcePaths = [registry, `${registry}-wal`, `${registry}-shm`];
        const before = sourcePaths.map((file) => fs.readFileSync(file));
        const result = await observe();
        expect(result.status).toBe("complete");
        expect(result.records.map((record) => record.runtimeProjectKey).sort()).toEqual(["checkpoint", "committed"]);
        expect(db.inTransaction).toBe(true);
        expect(sourcePaths.map((file) => fs.readFileSync(file))).toEqual(before);
        expect(fs.readdirSync(root).sort()).toEqual(sourcePaths.map((file) => path.basename(file)).sort());
    });

    it("opens only the in-memory image when a live database has no sidecars", async () => {
        const db = database();
        add(db, "project", uris("project"));
        db.close();
        databases.pop();
        const before = fs.readFileSync(registry);
        let captured: Buffer | undefined;
        const result = await observe({ readSnapshot: (file) => (captured = readCommittedSqliteSnapshot(file)) });
        expect(result.status).toBe("complete");
        expect(captured?.some((byte) => byte !== 0)).toBe(false);
        expect(fs.readFileSync(registry)).toEqual(before);
        expect(fs.readdirSync(root)).toEqual(["conversation_summaries.db"]);
    });

    it("retains valid anchors beside malformed records without treating an empty field as malformed", async () => {
        const db = database();
        add(db, "valid", uris("valid"));
        add(db, "empty", "");
        add(db, "", uris("missing-id"));
        add(db, "json-invalid", "not-json");
        add(db, "bad-array", [3]);
        add(db, "object", {});
        add(db, "relative", ["relative"]);
        add(db, "foreign", ["file://server/share/project"]);
        add(
            db,
            "many",
            Array.from({ length: 65 }, (_, index) => uris(`${index}`)[0]),
        );
        add(db, "oversized", "x".repeat(65537));
        const result = await observe();
        expect(result.status).toBe("partial");
        expect(result.records.map((record) => record.runtimeProjectKey)).toEqual(["valid"]);
        expect(result.diagnostics).toEqual([expect.objectContaining({ code: "antigravity_cli_project_index_entry_invalid" })]);
    });

    it("refuses the entire projection beyond the distinct anchor bound", async () => {
        const db = database();
        db.transaction(() => {
            for (let index = 0; index < 1025; index += 1) add(db, `project-${index}`, uris(`${index}`));
        })();
        const result = await observe();
        expect(result.records).toEqual([]);
        expect(result.diagnostics[0]?.code).toBe("antigravity_cli_project_index_too_large");
    });

    it("refuses an unselected index before reading and preserves denied access without parsing", async () => {
        const readSnapshot = vi.fn(() => {
            throw Object.assign(new Error("private"), { code: "EACCES" });
        });
        const outside = await readAntigravityCliProjectIndex(
            registry,
            "index",
            { ...context(), accessRootPath: path.join(root, "selected") },
            { readSnapshot },
        );
        expect(outside.diagnostics[0]?.code).toBe("antigravity_cli_project_index_path_outside_selection");
        expect(readSnapshot).not.toHaveBeenCalled();
        expect((await observe({ readSnapshot })).diagnostics[0]?.causeKind).toBe("permission_denied");
    });

    it("reports missing schema and a hot rollback journal instead of claiming enumeration completed", async () => {
        const db = new Database(registry);
        databases.push(db);
        db.exec("CREATE TABLE conversation_summaries (project_id TEXT)");
        expect((await observe()).diagnostics[0]?.code).toBe("antigravity_cli_project_index_schema_invalid");
        fs.writeFileSync(`${registry}-journal`, "active-journal");
        const result = await observe();
        expect(result.records).toEqual([]);
        expect(result.diagnostics[0]?.code).toBe("antigravity_cli_project_index_sqlite_snapshot_journal_active");
    });

    it("composes the index into global discovery but does not read it in a project-scoped probe", async () => {
        const rule = getPathRule("linux", root);
        if (rule === null) throw new Error("missing fixture rule");
        fs.mkdirSync(path.dirname(rule.cliSummariesDbPath), { recursive: true });
        registry = rule.cliSummariesDbPath;
        const db = database();
        add(db, "from-cli-index", uris("project"));
        const resource = (
            id: string,
            file: string,
            available = false,
        ): AdapterProbeResult["observation"]["agentRuntimeResources"][number] => ({
            agentRuntimeResourceId: id,
            path: file,
            roles: ["project_registry"],
            accessStatus: available ? "available" : "not_found",
            locatorEvidence: [],
            diagnostics: [],
        });
        const args = [
            resource("shared", rule.sharedProjectsRoot),
            resource("app", rule.appSummariesPath),
            resource("ide", rule.ideSummariesPath),
            resource("index", registry, true),
        ] as const;
        const global = await discoverAntigravityProjects(
            { authorizationScope: "global", platformContext: context() },
            {},
            rule,
            ...args,
        );
        expect(global.indexes.cli).toBe("complete");
        expect(global.records.map((record) => record.runtimeProjectKey)).toEqual(["from-cli-index"]);
        fs.writeFileSync(`${registry}-journal`, "active-journal");
        const project = await discoverAntigravityProjects(
            { authorizationScope: "project", projectRootPath: path.join(root, "selected"), platformContext: context() },
            {},
            rule,
            ...args,
        );
        expect(project.diagnostics).toEqual([]);
        expect(project.records).toHaveLength(1);
        expect(project.records[0]?.workspaces[0]?.path).toBe(path.join(root, "selected"));
    });
});
