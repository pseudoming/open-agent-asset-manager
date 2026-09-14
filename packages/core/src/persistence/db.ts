import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    SafeFilesystemError,
    confirmDurableDirectoryNoFollow,
    durableEnsureDirectory,
    durableReplaceFile,
    inspectRegularFileNoFollow,
    samePhysicalPathIdentity,
} from "@oaam/shared/filesystem";
import type { PhysicalPathIdentity } from "@oaam/shared/filesystem";

/**
 * SQLite singleton lifecycle for the OAAM state DB.
 *
 * Schema is the sole DDL truth source — loaded from schema/schema.sql, never
 * hardcoded (AGENTS.md "schema.sql 是 DB DDL 的唯一真相源"). On open we set
 * WAL / synchronous=NORMAL / foreign_keys=ON, then exec the schema.
 *
 * Old-schema detection: getDb probes sqlite_master and existing table columns
 * before exec'ing the new schema. Retired pre-rebuild models and non-empty
 * incompatible Deployment authority fail closed. The one bounded exception is
 * the exact empty schema emitted before Phase 45 Addition 4: because it contains
 * no logical OAAM row, it can be rebuilt from canonical schema.sql without
 * inventing platform identity or observation freshness.
 */

const DEFAULT_DB_PATH = path.join(os.homedir(), ".oaam", "index.db");

export type StateDatabaseInspection =
    | { readonly state: "memory" }
    | { readonly state: "missing" }
    | { readonly state: "current"; readonly identity: PhysicalPathIdentity }
    | {
          readonly state: "compatible_empty_rebuild";
          readonly marker: string;
          readonly identity: PhysicalPathIdentity;
      }
    | { readonly state: "incompatible"; readonly marker: string }
    | { readonly state: "corrupt"; readonly marker: string };

/** Resolve the one configured state-DB path used by both the shared NORMAL
 * singleton and short-lived authority connections. The special `:memory:`
 * target remains available to unit-level callers; durable Stage-R operations
 * reject it at their own boundary. */
export function resolveDbPath(dbPath?: string): string {
    const configured = dbPath || process.env.OAAM_DB_PATH || DEFAULT_DB_PATH;
    return configured === ":memory:" ? configured : path.resolve(configured);
}

function loadSchema(): string {
    return fs.readFileSync(path.join(__dirname, "..", "..", "schema", "schema.sql"), "utf-8");
}

function ensureDatabaseParentDirectory(databasePath: string): void {
    if (databasePath === ":memory:") return;
    const required: string[] = [];
    const root = path.parse(databasePath).root;
    let current = path.dirname(databasePath);

    while (current !== root) {
        try {
            confirmDurableDirectoryNoFollow(current);
            break;
        } catch (error) {
            if (!(error instanceof SafeFilesystemError && error.failureKind === "not_found")) throw error;
            required.push(path.basename(current));
            current = path.dirname(current);
        }
    }
    confirmDurableDirectoryNoFollow(current);
    for (const segment of required.reverse()) {
        durableEnsureDirectory(current, segment);
        current = path.join(current, segment);
    }
}

/**
 * Canonical pre-rebuild signal tables (see file-level comment for rationale).
 */
const OLD_MODEL_TABLES = ["asset_versions", "user_settings"] as const;
const PHASE45_ADDITION_4_COLUMNS = ["platform_instance_id", "observation_attempted_at", "last_complete_observation_at"] as const;

interface TableDescriptor {
    readonly name: string;
    readonly type: "shadow" | "table" | "virtual";
}

interface SchemaObjectDescriptor {
    readonly type: string;
    readonly name: string;
    readonly tableName: string;
    readonly sql: string;
}

type RegularFileInspector = (filePath: string) => PhysicalPathIdentity;

type ExistingStateDatabaseContentInspection =
    | { readonly state: "current" }
    | { readonly state: "compatible_empty_rebuild"; readonly marker: string }
    | { readonly state: "incompatible"; readonly marker: string }
    | { readonly state: "corrupt"; readonly marker: string };

/**
 * Returns the first incompatible schema marker found. canonicalEmptyBytes is
 * present only when the exact old shape is proven to contain no logical OAAM
 * data and may therefore be replaced without inventing authority.
 */
function detectOldSchema(
    db: Database.Database,
): { readonly marker: string; readonly canonicalEmptyBytes?: Buffer<ArrayBufferLike> } | null {
    const existing = tableNames(db);
    const existingSet = new Set(existing);
    for (const old of OLD_MODEL_TABLES) {
        if (existingSet.has(old)) {
            return { marker: old };
        }
    }
    if (existingSet.has("deployments")) {
        const columns = tableColumnNames(db, "deployments");
        if (columns.has("adapter_id")) return { marker: "deployments.adapter_id" };
        if (!columns.has("applied_render_snapshot_ref")) {
            return { marker: "deployments missing applied_render_snapshot_ref" };
        }
        const missingAddition4Columns = PHASE45_ADDITION_4_COLUMNS.filter((column) => !columns.has(column));
        if (missingAddition4Columns.length > 0) {
            const marker = `deployments missing ${missingAddition4Columns[0]}`;
            const canonicalEmptyBytes =
                missingAddition4Columns.length === PHASE45_ADDITION_4_COLUMNS.length
                    ? canonicalReplacementForExactEmptyPreAddition4Schema(db)
                    : undefined;
            return canonicalEmptyBytes === undefined ? { marker } : { marker, canonicalEmptyBytes };
        }
    }
    if (existingSet.has("deployment_files")) {
        const columns = tableColumnNames(db, "deployment_files");
        if (columns.has("applied_content_hash")) {
            return { marker: "deployment_files.applied_content_hash" };
        }
        if (!columns.has("baseline_state")) return { marker: "deployment_files missing baseline_state" };
    }
    return null;
}

function tableDescriptors(db: Database.Database): TableDescriptor[] {
    return db
        .prepare<[], TableDescriptor>(
            `SELECT name, type
             FROM pragma_table_list
             WHERE schema = 'main' AND name NOT LIKE 'sqlite_%'
             ORDER BY name`,
        )
        .all()
        .map((row) => ({ name: row.name, type: row.type }));
}

function tableNames(db: Database.Database): string[] {
    return tableDescriptors(db).map((table) => table.name);
}

function tableColumnNames(db: Database.Database, tableName: string): Set<string> {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
}

function tableColumnNameList(db: Database.Database, tableName: string): string[] {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
}

function equalStringLists(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function equalTableDescriptors(left: readonly TableDescriptor[], right: readonly TableDescriptor[]): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value.name === right[index]?.name && value.type === right[index]?.type)
    );
}

function schemaObjectDescriptors(db: Database.Database): SchemaObjectDescriptor[] {
    return db
        .prepare<[], { readonly type: string; readonly name: string; readonly tableName: string; readonly sql: string }>(
            `SELECT type, name, tbl_name AS tableName, sql
             FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'
             ORDER BY type, name`,
        )
        .all()
        .map((row) => ({
            type: row.type,
            name: row.name,
            tableName: row.tableName,
            sql: row.sql.replace(/\s+/gu, " ").trim(),
        }));
}

function equalSchemaObjectDescriptors(
    left: readonly SchemaObjectDescriptor[],
    right: readonly SchemaObjectDescriptor[],
): boolean {
    return (
        left.length === right.length &&
        left.every(
            (value, index) =>
                value.type === right[index]?.type &&
                value.name === right[index]?.name &&
                value.tableName === right[index]?.tableName &&
                value.sql === right[index]?.sql,
        )
    );
}

function hasCanonicalSchema(db: Database.Database): boolean {
    const canonical = new Database(":memory:");
    try {
        canonical.exec(loadSchema());
        return equalSchemaObjectDescriptors(schemaObjectDescriptors(db), schemaObjectDescriptors(canonical));
    } finally {
        canonical.close();
    }
}

function canonicalReplacementForExactEmptyPreAddition4Schema(db: Database.Database): Buffer<ArrayBufferLike> | undefined {
    const canonical = new Database(":memory:");
    try {
        canonical.exec(loadSchema());
        const actualTables = tableDescriptors(db);
        const canonicalTables = tableDescriptors(canonical);
        if (!equalTableDescriptors(actualTables, canonicalTables)) return undefined;

        for (const tableName of canonicalTables.map((table) => table.name)) {
            const actualColumns = tableColumnNameList(db, tableName);
            const expectedColumns = tableColumnNameList(canonical, tableName);
            const compatibleExpectedColumns =
                tableName === "deployments"
                    ? expectedColumns.filter(
                          (column) => !PHASE45_ADDITION_4_COLUMNS.includes(column as (typeof PHASE45_ADDITION_4_COLUMNS)[number]),
                      )
                    : expectedColumns;
            if (!equalStringLists(actualColumns, compatibleExpectedColumns)) return undefined;
        }

        for (const table of canonicalTables) {
            if (table.type !== "shadow" && db.prepare(`SELECT 1 FROM ${table.name} LIMIT 1`).get() !== undefined) {
                return undefined;
            }
        }
        return canonical.serialize();
    } finally {
        canonical.close();
    }
}

function closeForCanonicalReplacement(db: Database.Database): void {
    const journalMode = db.pragma("journal_mode", { simple: true });
    if (journalMode === "wal") {
        db.pragma("wal_checkpoint(TRUNCATE)");
        db.pragma("journal_mode = DELETE");
    }
    db.close();
}

function inspectExistingDatabase(
    databasePath: string,
    initialIdentity: PhysicalPathIdentity,
    inspectRegularFile: RegularFileInspector,
): StateDatabaseInspection {
    let result: ExistingStateDatabaseContentInspection;
    try {
        const db = new Database(databasePath, { readonly: true, fileMustExist: true });
        try {
            if (db.prepare("PRAGMA quick_check").pluck().get() !== "ok") {
                result = { state: "corrupt", marker: "PRAGMA quick_check did not return ok" };
            } else if ((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length !== 0) {
                result = { state: "corrupt", marker: "PRAGMA foreign_key_check reported orphan rows" };
            } else {
                const oldSchema = detectOldSchema(db);
                if (oldSchema?.canonicalEmptyBytes !== undefined) {
                    result = { state: "compatible_empty_rebuild", marker: oldSchema.marker };
                } else if (oldSchema !== null) {
                    result = { state: "incompatible", marker: oldSchema.marker };
                } else if (!hasCanonicalSchema(db)) {
                    result = { state: "incompatible", marker: "schema differs from canonical schema.sql" };
                } else {
                    result = { state: "current" };
                }
            }
        } finally {
            db.close();
        }
    } catch (error) {
        result = { state: "corrupt", marker: String(error) };
    }

    try {
        const finalIdentity = inspectRegularFile(databasePath);
        if (!samePhysicalPathIdentity(initialIdentity, finalIdentity)) {
            return { state: "corrupt", marker: "database path identity changed during read-only inspection" };
        }
        return result.state === "current" || result.state === "compatible_empty_rebuild"
            ? { ...result, identity: finalIdentity }
            : result;
    } catch (error) {
        return {
            state: "corrupt",
            marker: `database path could not be re-confirmed after inspection: ${String(error)}`,
        };
    }
}

/**
 * Inspect one existing state DB without creating its file, parent directory,
 * schema, journal or WAL sidecars.
 */
function inspectStateDatabaseWithFileInspector(
    dbPath: string | undefined,
    inspectRegularFile: RegularFileInspector,
): StateDatabaseInspection {
    const resolvedPath = resolveDbPath(dbPath);
    if (resolvedPath === ":memory:") return { state: "memory" };
    try {
        return inspectExistingDatabase(resolvedPath, inspectRegularFile(resolvedPath), inspectRegularFile);
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") {
            return { state: "missing" };
        }
        return {
            state: "corrupt",
            marker: `database path is not a stable regular file: ${String(error)}`,
        };
    }
}

export function inspectStateDatabase(dbPath?: string): StateDatabaseInspection {
    return inspectStateDatabaseWithFileInspector(dbPath, inspectRegularFileNoFollow);
}

function incompatibleDatabaseError(
    databasePath: string,
    inspection: Extract<StateDatabaseInspection, { readonly state: "corrupt" | "incompatible" }>,
): Error {
    const marker = inspection.marker;
    const description =
        inspection.state === "incompatible"
            ? `appears to be a pre-rebuild prototype or another incompatible schema ` +
              `(found retired schema marker "${marker}")`
            : `is ${inspection.state} (${marker})`;
    return new Error(
        `OAAM state DB at ${databasePath} ${description}. ` +
            "Automatic replacement is permitted only for a missing database in a virgin profile or the exact empty " +
            "pre-Addition-4 schema; established, corrupt or incompatible authority must remain fail-closed for reviewed recovery.",
    );
}

function assertInspectedDatabaseIdentity(databasePath: string, inspection: StateDatabaseInspection): void {
    if (inspection.state !== "current" && inspection.state !== "compatible_empty_rebuild") return;
    try {
        const currentIdentity = inspectRegularFileNoFollow(databasePath);
        if (samePhysicalPathIdentity(inspection.identity, currentIdentity)) return;
    } catch (error) {
        throw incompatibleDatabaseError(databasePath, {
            state: "corrupt",
            marker: `database path could not be bound to the inspected file before open: ${String(error)}`,
        });
    }
    throw incompatibleDatabaseError(databasePath, {
        state: "corrupt",
        marker: "database path identity changed between read-only inspection and open",
    });
}

let _db: Database.Database | null = null;

const NOOP_POST_INSPECTION = (): void => {};

function openDatabase(
    dbPath: string | undefined,
    postInspection: (databasePath: string, inspection: StateDatabaseInspection) => void,
): Database.Database {
    if (_db) return _db;

    const resolvedPath = resolveDbPath(dbPath);
    const inspection = inspectStateDatabase(resolvedPath);
    if (inspection.state === "corrupt" || inspection.state === "incompatible") {
        throw incompatibleDatabaseError(resolvedPath, inspection);
    }
    postInspection(resolvedPath, inspection);
    assertInspectedDatabaseIdentity(resolvedPath, inspection);
    ensureDatabaseParentDirectory(resolvedPath);

    let db = new Database(resolvedPath);
    assertInspectedDatabaseIdentity(resolvedPath, inspection);

    // Old-schema guard must run BEFORE we exec the new schema, otherwise an
    // existing pre-rebuild DB would silently gain v1 tables alongside old ones.
    const oldSchema = detectOldSchema(db);
    if (oldSchema?.canonicalEmptyBytes !== undefined) {
        closeForCanonicalReplacement(db);
        durableReplaceFile(resolvedPath, oldSchema.canonicalEmptyBytes);
        db = new Database(resolvedPath);
    } else if (oldSchema !== null) {
        db.close();
        throw incompatibleDatabaseError(resolvedPath, { state: "incompatible", marker: oldSchema.marker });
    } else if (inspection.state === "current" && !hasCanonicalSchema(db)) {
        db.close();
        throw incompatibleDatabaseError(resolvedPath, {
            state: "incompatible",
            marker: "schema changed between read-only inspection and open",
        });
    }

    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");

    db.exec(loadSchema());

    _db = db;
    return db;
}

export function getDb(dbPath?: string): Database.Database {
    return openDatabase(dbPath, NOOP_POST_INSPECTION);
}

export function closeDb(): void {
    if (_db) {
        _db.close();
        _db = null;
    }
}

/** @internal Deterministic race and identity seams; production imports are forbidden. */
export const stateDatabaseInternalsForTest = Object.freeze({
    getDbWithPostInspectionHook: openDatabase,
    inspectStateDatabaseWithFileInspector,
});
