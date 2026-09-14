/** Read-only filtering and public projection over the disposable current-Asset index. */

import type { Database } from "better-sqlite3";
import type { AssetKind, AssetListFilter, CurrentAssetSummary, QueryAssetsInput, UuidV4, VersionStatus } from "../types";
import { compareUtf8Bytes } from "../foundation/text-order";
import { listCurrentAssetIndex } from "../persistence/state-db";

type CurrentAssetIndexRow = ReturnType<typeof listCurrentAssetIndex>[number];

export function listAssetSummaries(db: Database, filter: AssetListFilter): CurrentAssetSummary[] {
    return listCurrentAssetIndex(db, filter.includeDeleted ?? false)
        .filter((row) => matchesAssetFilter(row, filter))
        .sort(compareAssetRows)
        .map(projectCurrentAssetSummary);
}

export function queryAssetSummaries(db: Database, input: QueryAssetsInput) {
    if (!Number.isInteger(input.limit ?? 100) || (input.limit ?? 100) < 1) {
        throw new Error("limit must be a positive integer");
    }
    if (!Number.isInteger(input.offset ?? 0) || (input.offset ?? 0) < 0) {
        throw new Error("offset must be a non-negative integer");
    }
    const filter = input.filter ?? {};
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    const query = buildIndexQuery(filter, input.keywords);
    const totalCount = readCount(db, query);
    const rows = db
        .prepare(
            `SELECT a.*
             FROM current_asset_index AS a
             ${query.whereSql}
             ORDER BY a.display_name COLLATE BINARY, a.asset_id COLLATE BINARY
             LIMIT @limit OFFSET @offset`,
        )
        .all({ ...query.params, limit, offset }) as Record<string, unknown>[];
    return {
        items: rows.map(mapCurrentAssetIndexRow).map(projectCurrentAssetSummary),
        totalCount,
    };
}

export interface AssetLibraryIndexFilter {
    scope: "global" | "project";
    projectId: string;
    kind?: AssetKind;
    keywords: string;
    includeDeleted: boolean;
}

export interface AssetIndexPageBoundary {
    displayName: string;
    assetId: string;
}

export function countAssetKinds(db: Database, filter: Omit<AssetLibraryIndexFilter, "kind">): ReadonlyMap<AssetKind, number> {
    const query = buildLibraryQuery(filter);
    const rows = db
        .prepare(
            `SELECT a.kind, COUNT(*) AS item_count
             FROM current_asset_index AS a
             ${query.whereSql}
             GROUP BY a.kind`,
        )
        .all(query.params) as Record<string, unknown>[];
    return new Map(
        rows.map((row) => {
            const kind = requireString(row.kind, "kind") as AssetKind;
            return [kind, requireNonNegativeInteger(row.item_count, "item_count")] as const;
        }),
    );
}

export function queryAssetIndexPage(
    db: Database,
    filter: AssetLibraryIndexFilter,
    pageSize: number,
    after?: AssetIndexPageBoundary,
): { items: CurrentAssetSummary[]; totalCount: number; hasMore: boolean } {
    const query = buildLibraryQuery(filter, after);
    const totalCount = readCount(db, buildLibraryQuery(filter));
    const rows = db
        .prepare(
            `SELECT a.*
             FROM current_asset_index AS a
             ${query.whereSql}
             ORDER BY a.display_name COLLATE BINARY, a.asset_id COLLATE BINARY
             LIMIT @limit`,
        )
        .all({ ...query.params, limit: pageSize + 1 }) as Record<string, unknown>[];
    return {
        items: rows.slice(0, pageSize).map(mapCurrentAssetIndexRow).map(projectCurrentAssetSummary),
        totalCount,
        hasMore: rows.length > pageSize,
    };
}

function matchesAssetFilter(row: CurrentAssetIndexRow, filter: AssetListFilter): boolean {
    return (
        (filter.kind === undefined || row.kind === filter.kind) &&
        (filter.scope === undefined || row.scope === filter.scope) &&
        (filter.projectId === undefined || row.projectId === filter.projectId) &&
        (filter.currentVersionStatus === undefined || row.currentVersionStatus === filter.currentVersionStatus) &&
        (filter.scopePathPrefix === undefined ||
            filter.scopePathPrefix === "" ||
            row.scopePath === filter.scopePathPrefix ||
            row.scopePath.startsWith(`${filter.scopePathPrefix}/`))
    );
}

function projectCurrentAssetSummary(row: CurrentAssetIndexRow): CurrentAssetSummary {
    return {
        assetId: row.assetId as UuidV4,
        kind: row.kind as AssetKind,
        scope: row.scope as CurrentAssetSummary["scope"],
        projectId: row.projectId,
        scopePath: row.scopePath,
        displayName: row.displayName,
        displayDescription: row.displayDescription,
        currentVersionId: row.currentVersionId as UuidV4,
        currentRevision: row.currentRevision,
        currentFingerprint: row.currentFingerprint as CurrentAssetSummary["currentFingerprint"],
        currentVersionStatus: row.currentVersionStatus as VersionStatus,
        assetCreatedAt: row.createdAt,
        assetUpdatedAt: row.updatedAt,
        deleted: row.deleted === 1,
    };
}

interface IndexQuery {
    whereSql: string;
    params: Record<string, string | number>;
}

function buildIndexQuery(filter: AssetListFilter, keywords: string): IndexQuery {
    const clauses: string[] = [];
    const params: Record<string, string | number> = {};
    if (!(filter.includeDeleted ?? false)) clauses.push("a.deleted = 0");
    if (filter.kind !== undefined) {
        clauses.push("a.kind = @kind");
        params.kind = filter.kind;
    }
    if (filter.scope !== undefined) {
        clauses.push("a.scope = @scope");
        params.scope = filter.scope;
    }
    if (filter.projectId !== undefined) {
        clauses.push("a.project_id = @projectId");
        params.projectId = filter.projectId;
    }
    if (filter.currentVersionStatus !== undefined) {
        clauses.push("a.current_version_status = @currentVersionStatus");
        params.currentVersionStatus = filter.currentVersionStatus;
    }
    if (filter.scopePathPrefix !== undefined && filter.scopePathPrefix !== "") {
        clauses.push("(a.scope_path = @scopePathPrefix OR a.scope_path LIKE @scopePathDescendant ESCAPE '\\')");
        params.scopePathPrefix = filter.scopePathPrefix;
        params.scopePathDescendant = `${escapeLike(filter.scopePathPrefix)}/%`;
    }
    appendKeywordClause(clauses, params, keywords);
    return { whereSql: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, params };
}

function buildLibraryQuery(filter: AssetLibraryIndexFilter, after?: AssetIndexPageBoundary): IndexQuery {
    const clauses = ["a.scope = @scope", "a.project_id = @projectId"];
    const params: Record<string, string | number> = {
        scope: filter.scope,
        projectId: filter.projectId,
    };
    if (!filter.includeDeleted) clauses.push("a.deleted = 0");
    if (filter.kind !== undefined) {
        clauses.push("a.kind = @kind");
        params.kind = filter.kind;
    }
    appendKeywordClause(clauses, params, filter.keywords);
    if (after !== undefined) {
        clauses.push(
            "(a.display_name COLLATE BINARY > @afterDisplayName COLLATE BINARY OR " +
                "(a.display_name = @afterDisplayName AND a.asset_id COLLATE BINARY > @afterAssetId COLLATE BINARY))",
        );
        params.afterDisplayName = after.displayName;
        params.afterAssetId = after.assetId;
    }
    return { whereSql: `WHERE ${clauses.join(" AND ")}`, params };
}

function appendKeywordClause(clauses: string[], params: Record<string, string | number>, keywords: string): void {
    const trimmed = keywords.trim();
    if (trimmed === "") return;
    clauses.push("a.asset_id IN (SELECT asset_id FROM assets_fts WHERE assets_fts MATCH @ftsQuery)");
    params.ftsQuery = `"${trimmed.replaceAll('"', '""')}"`;
}

function readCount(db: Database, query: IndexQuery): number {
    const row = db
        .prepare(`SELECT COUNT(*) AS item_count FROM current_asset_index AS a ${query.whereSql}`)
        .get(query.params) as Record<string, unknown>;
    return requireNonNegativeInteger(row.item_count, "item_count");
}

function mapCurrentAssetIndexRow(row: Record<string, unknown>): CurrentAssetIndexRow {
    return {
        assetId: requireString(row.asset_id, "asset_id"),
        kind: requireString(row.kind, "kind"),
        scope: requireString(row.scope, "scope"),
        projectId: requireString(row.project_id, "project_id"),
        scopePath: requireString(row.scope_path, "scope_path"),
        displayName: requireString(row.display_name, "display_name"),
        displayDescription: requireString(row.display_description, "display_description"),
        currentVersionId: requireString(row.current_version_id, "current_version_id"),
        currentRevision: requireNonNegativeInteger(row.current_revision, "current_revision"),
        currentFingerprint: requireString(row.current_fingerprint, "current_fingerprint"),
        currentVersionStatus: requireString(row.current_version_status, "current_version_status"),
        createdAt: requireNonNegativeInteger(row.created_at, "created_at"),
        updatedAt: requireNonNegativeInteger(row.updated_at, "updated_at"),
        deleted: requireNonNegativeInteger(row.deleted, "deleted"),
    };
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== "string") throw new Error(`current_asset_index.${field} must be a string`);
    return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
    if (!Number.isInteger(value) || (value as number) < 0) {
        throw new Error(`current_asset_index.${field} must be a non-negative integer`);
    }
    return value as number;
}

function escapeLike(value: string): string {
    return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function compareAssetRows(left: CurrentAssetIndexRow, right: CurrentAssetIndexRow): number {
    return compareUtf8Bytes(left.displayName, right.displayName) || compareUtf8Bytes(left.assetId, right.assetId);
}
