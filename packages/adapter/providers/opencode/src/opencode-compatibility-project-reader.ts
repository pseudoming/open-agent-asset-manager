/** Fixed low-confidence SQLite reader for one stopped OpenCode compatibility fallback. */

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const MAXIMUM_PROJECTS = 10_000;
const MAXIMUM_PROJECT_DIRECTORIES = 100_000;
const MAXIMUM_SANDBOXES_PER_PROJECT = 4_096;
const MAXIMUM_IDENTITY_TEXT_BYTES = 32_768;
const MAXIMUM_PROJECT_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const EXPECTED_READER_VERSION = "12.11.1";
const CURRENT_SCHEMA_FINGERPRINT = "opencode-project-registry-20260423070820";

interface TableColumn {
    readonly cid: unknown;
    readonly name: unknown;
    readonly type: unknown;
    readonly notnull: unknown;
    readonly dflt_value: unknown;
    readonly pk: unknown;
}

interface ProjectRow {
    readonly id: unknown;
    readonly worktree: unknown;
    readonly name: unknown;
    readonly sandboxes: unknown;
}

interface ProjectDirectoryRow {
    readonly project_id: unknown;
    readonly directory: unknown;
}

interface ReaderProject {
    readonly id: string;
    readonly worktree: string;
    readonly name: string;
    readonly sandboxes: readonly string[];
}

export interface OpenCodeCompatibilityReaderOutput {
    readonly status: "complete" | "failed";
    readonly readerVersion: string;
    readonly sqliteVersion: string;
    readonly schemaFingerprint: string;
    readonly projects: readonly ReaderProject[];
    readonly failureCode: string;
}

interface ProjectDatabase {
    readonly pragma: (source: string) => unknown;
    readonly prepare: (source: string) => {
        readonly all: (...parameters: readonly unknown[]) => unknown[];
        readonly get: (...parameters: readonly unknown[]) => unknown;
    };
    readonly close: () => void;
}

type OpenProjectDatabase = (databasePath: string) => ProjectDatabase;

const EXPECTED_PROJECT_SCHEMA = [
    column(0, "id", "TEXT", 0, 1),
    column(1, "worktree", "TEXT", 1, 0),
    column(2, "vcs", "TEXT", 0, 0),
    column(3, "name", "TEXT", 0, 0),
    column(4, "icon_url", "TEXT", 0, 0),
    column(5, "icon_url_override", "TEXT", 0, 0),
    column(6, "icon_color", "TEXT", 0, 0),
    column(7, "time_created", "INTEGER", 1, 0),
    column(8, "time_updated", "INTEGER", 1, 0),
    column(9, "time_initialized", "INTEGER", 0, 0),
    column(10, "sandboxes", "TEXT", 1, 0),
    column(11, "commands", "TEXT", 0, 0),
] as const;

const EXPECTED_PROJECT_DIRECTORY_SCHEMA = [
    column(0, "project_id", "TEXT", 1, 1),
    column(1, "directory", "TEXT", 1, 2),
    column(2, "type", "TEXT", 0, 0),
    column(3, "strategy", "TEXT", 0, 0),
    column(4, "time_created", "INTEGER", 1, 0),
] as const;

export function readCompatibleOpenCodeProjects(
    databasePath: string,
    openDatabase: OpenProjectDatabase = openReadOnlyDatabase,
): OpenCodeCompatibilityReaderOutput {
    let database: ProjectDatabase | null = null;
    try {
        database = openDatabase(databasePath);
        database.pragma("query_only = ON");
        requireExactSchema(database, "project", EXPECTED_PROJECT_SCHEMA);
        requireExactSchema(database, "project_directory", EXPECTED_PROJECT_DIRECTORY_SCHEMA);
        const projectRows = database
            .prepare("SELECT id, worktree, name, sandboxes FROM project ORDER BY id LIMIT ?")
            .all(MAXIMUM_PROJECTS + 1) as ProjectRow[];
        if (projectRows.length > MAXIMUM_PROJECTS) throw new RangeError("project_limit");
        const directoryRows = database
            .prepare("SELECT project_id, directory FROM project_directory ORDER BY project_id, directory LIMIT ?")
            .all(MAXIMUM_PROJECT_DIRECTORIES + 1) as ProjectDirectoryRow[];
        if (directoryRows.length > MAXIMUM_PROJECT_DIRECTORIES) throw new RangeError("project_directory_limit");
        const sqliteVersionRow = database.prepare("SELECT sqlite_version() AS version").get() as
            | { readonly version?: unknown }
            | undefined;
        const projects = materializeProjects(projectRows, directoryRows);
        if (Buffer.byteLength(JSON.stringify(projects), "utf8") > MAXIMUM_PROJECT_OUTPUT_BYTES) {
            throw new RangeError("project_output_limit");
        }
        return {
            status: "complete",
            readerVersion: installedReaderVersion(),
            sqliteVersion: requireText(sqliteVersionRow?.version, false),
            schemaFingerprint: CURRENT_SCHEMA_FINGERPRINT,
            projects,
            failureCode: "",
        };
    } catch (error) {
        return failed(classifyFailure(error));
    } finally {
        database?.close();
    }
}

export function runOpenCodeCompatibilityReaderMain(
    arguments_: readonly string[] = process.argv.slice(2),
    writeOutput: (value: string) => void = (value) => process.stdout.write(value),
    readProjects: (databasePath: string) => OpenCodeCompatibilityReaderOutput = readCompatibleOpenCodeProjects,
): number {
    const [databasePath] = arguments_;
    const output =
        arguments_.length === 1 && databasePath !== undefined && databasePath.length > 0 && !databasePath.includes("\0")
            ? readProjects(databasePath)
            : failed("invalid_arguments");
    writeOutput(`${JSON.stringify(output)}\n`);
    return output.status === "complete" ? 0 : 2;
}

function openReadOnlyDatabase(databasePath: string): ProjectDatabase {
    if (process.env.SQLITE_USE_URI !== "1") throw new TypeError("sqlite_uri_disabled");
    return new Database(immutableReadOnlyDatabaseUri(databasePath), {
        readonly: true,
        fileMustExist: true,
        timeout: 0,
    }) as unknown as ProjectDatabase;
}

export function immutableReadOnlyDatabaseUri(databasePath: string): string {
    if (!path.isAbsolute(databasePath) || databasePath.includes("\0")) throw new TypeError("database_path_invalid");
    const url = pathToFileURL(databasePath);
    if (url.host.length > 0) {
        return `file:////${url.host}${url.pathname}?mode=ro&immutable=1`;
    }
    url.searchParams.set("mode", "ro");
    url.searchParams.set("immutable", "1");
    return url.href;
}

function requireExactSchema(database: ProjectDatabase, tableName: string, expected: readonly ReturnType<typeof column>[]): void {
    const observed = database.pragma(`table_info(${tableName})`);
    if (!Array.isArray(observed) || JSON.stringify(observed.map(normalizeColumn)) !== JSON.stringify(expected)) {
        throw new TypeError(`schema_${tableName}`);
    }
}

function normalizeColumn(value: unknown): ReturnType<typeof column> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("schema_column");
    const record = value as TableColumn;
    if (
        !Number.isSafeInteger(record.cid) ||
        typeof record.name !== "string" ||
        typeof record.type !== "string" ||
        (record.notnull !== 0 && record.notnull !== 1) ||
        record.dflt_value !== null ||
        !Number.isSafeInteger(record.pk)
    ) {
        throw new TypeError("schema_column");
    }
    return column(record.cid as number, record.name, record.type, record.notnull, record.pk as number);
}

function column(cid: number, name: string, type: string, notnull: 0 | 1, pk: number) {
    return { cid, name, type, notnull, dflt_value: null, pk } as const;
}

function materializeProjects(projectRows: readonly ProjectRow[], directoryRows: readonly ProjectDirectoryRow[]): ReaderProject[] {
    const projects = new Map<string, { id: string; worktree: string; name: string; paths: Set<string> }>();
    for (const row of projectRows) {
        const id = requireText(row.id, false);
        if (projects.has(id)) throw new TypeError("duplicate_project");
        const worktree = requireText(row.worktree, false);
        const name = row.name === null ? "" : requireText(row.name, true);
        projects.set(id, {
            id,
            worktree,
            name,
            paths: new Set(requireStringArray(row.sandboxes)),
        });
    }
    for (const row of directoryRows) {
        const projectId = requireText(row.project_id, false);
        const project = projects.get(projectId);
        if (project === undefined) throw new TypeError("orphan_project_directory");
        project.paths.add(requireText(row.directory, false));
        if (project.paths.size > MAXIMUM_SANDBOXES_PER_PROJECT) throw new RangeError("sandbox_limit");
    }
    return [...projects.values()].map((project) => ({
        id: project.id,
        worktree: project.worktree,
        name: project.name,
        sandboxes: [...project.paths].sort(),
    }));
}

function requireStringArray(value: unknown): string[] {
    let parsed: unknown;
    try {
        parsed = typeof value === "string" ? JSON.parse(value) : value;
    } catch {
        throw new TypeError("invalid_sandboxes");
    }
    if (!Array.isArray(parsed) || parsed.length > MAXIMUM_SANDBOXES_PER_PROJECT) {
        throw new TypeError("invalid_sandboxes");
    }
    return parsed.map((item) => requireText(item, false));
}

function requireText(value: unknown, allowEmpty: boolean): string {
    if (
        typeof value !== "string" ||
        value.includes("\0") ||
        value.trim() !== value ||
        (!allowEmpty && value.length === 0) ||
        Buffer.byteLength(value, "utf8") > MAXIMUM_IDENTITY_TEXT_BYTES
    ) {
        throw new TypeError("invalid_text");
    }
    return value;
}

function installedReaderVersion(): string {
    const manifest = require("better-sqlite3/package.json") as { readonly version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "";
}

function classifyFailure(error: unknown): string {
    if (error instanceof RangeError) return error.message;
    if (error instanceof TypeError) return error.message;
    const code =
        typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
            ? error.code.toLowerCase()
            : "";
    if (code.includes("busy") || code.includes("locked")) return "sqlite_busy";
    if (code.includes("cantopen")) return "sqlite_cantopen";
    return "sqlite_invalid";
}

function failed(failureCode: string): OpenCodeCompatibilityReaderOutput {
    return {
        status: "failed",
        readerVersion: EXPECTED_READER_VERSION,
        sqliteVersion: "",
        schemaFingerprint: "",
        projects: [],
        failureCode,
    };
}

if (require.main === module) {
    process.exitCode = runOpenCodeCompatibilityReaderMain();
}
