/** Bounded disposable search projection over current Asset authority. */

import type { Database } from "better-sqlite3";
import type {
    AssetManifestV1,
    CatalogSearchAssetMatch,
    CatalogSearchInput,
    CatalogSearchResult,
    PosixRelativePath,
} from "../types";
import { compareUtf8Bytes } from "../foundation/text-order";
import { getAssetSpecHandler } from "../specs/registry";
import type { VersionAuthorityClosureV1 } from "./version-authority";

export const CATALOG_SEARCH_DEFAULT_GROUP_LIMIT = 8;
export const CATALOG_SEARCH_MAXIMUM_GROUP_LIMIT = 20;
export const CATALOG_SEARCH_MAXIMUM_QUERY_CODE_POINTS = 128;
export const CATALOG_SEARCH_MAXIMUM_FILE_BYTES = 65_536;
export const CATALOG_SEARCH_MAXIMUM_ASSET_BYTES = 262_144;
export const CATALOG_SEARCH_MAXIMUM_SNIPPET_CODE_POINTS = 160;

const RECORD_SEPARATOR = "\u001e";
const UNIT_SEPARATOR = "\u001f";
const GROUP_SEPARATOR = "\u001d";
const FIELD_CODES = Object.freeze({
    kind: "\u0001",
    scopePath: "\u0002",
    logicalPath: "\u0003",
    typeMetadata: "\u0004",
    textContent: "\u0005",
});

type SearchDocumentField =
    | { matchedField: "kind" | "scope_path" | "type_metadata"; text: string }
    | { matchedField: "logical_path" | "text_content"; logicalPath: PosixRelativePath; text: string };

interface SearchIndexProjection {
    displayName: string;
    displayDescription: string;
    searchableText: string;
}

interface SearchAssetRow {
    assetId: string;
    kind: string;
    scope: string;
    projectId: string;
    scopePath: string;
    displayName: string;
    displayDescription: string;
    searchableText: string;
}

export function normalizeCatalogSearchInput(input: CatalogSearchInput): { query: string; limitPerGroup: number } {
    const query = input.query.normalize("NFC").trim();
    if (query.length === 0) throw new Error("query must be non-blank");
    if ([...query].some(isSearchControlCharacter)) {
        throw new Error("query must not contain control characters");
    }
    if ([...query].length > CATALOG_SEARCH_MAXIMUM_QUERY_CODE_POINTS) {
        throw new Error(`query must not exceed ${CATALOG_SEARCH_MAXIMUM_QUERY_CODE_POINTS} code points`);
    }
    const limitPerGroup = input.limitPerGroup ?? CATALOG_SEARCH_DEFAULT_GROUP_LIMIT;
    if (!Number.isInteger(limitPerGroup) || limitPerGroup < 1 || limitPerGroup > CATALOG_SEARCH_MAXIMUM_GROUP_LIMIT) {
        throw new Error(`limitPerGroup must be an integer from 1 to ${CATALOG_SEARCH_MAXIMUM_GROUP_LIMIT}`);
    }
    return { query, limitPerGroup };
}

export function buildAssetSearchIndexProjection(
    asset: AssetManifestV1,
    version: VersionAuthorityClosureV1,
): SearchIndexProjection {
    let remainingBytes = CATALOG_SEARCH_MAXIMUM_ASSET_BYTES;
    const take = (value: string, maximumBytes: number): string => {
        const bounded = truncateUtf8(sanitizeSearchText(value), Math.min(maximumBytes, remainingBytes));
        remainingBytes -= Buffer.byteLength(bounded, "utf8");
        return bounded;
    };
    const displayName = take(asset.displayName, CATALOG_SEARCH_MAXIMUM_FILE_BYTES);
    const displayDescription = take(asset.displayDescription, CATALOG_SEARCH_MAXIMUM_FILE_BYTES);
    const records: string[] = [];
    const appendRecord = (code: string, text: string, logicalPath?: string, valueLimit = remainingBytes): void => {
        const cleanPath = logicalPath === undefined ? "" : sanitizeSearchText(logicalPath);
        const prefix = `${RECORD_SEPARATOR}${code}${UNIT_SEPARATOR}${
            logicalPath === undefined ? "" : `${cleanPath}${GROUP_SEPARATOR}`
        }`;
        const prefixBytes = Buffer.byteLength(prefix, "utf8");
        if (prefixBytes >= remainingBytes) return;
        const cleanText = truncateUtf8(sanitizeSearchText(text), Math.min(valueLimit, remainingBytes - prefixBytes));
        if (cleanText.length === 0) return;
        const record = `${prefix}${cleanText}`;
        records.push(record);
        remainingBytes -= Buffer.byteLength(record, "utf8");
    };

    appendRecord(FIELD_CODES.kind, asset.kind);
    if (asset.scopePath !== "") appendRecord(FIELD_CODES.scopePath, asset.scopePath);

    const files = [...version.files].sort((left, right) => compareUtf8Bytes(left.file.logicalPath, right.file.logicalPath));
    for (const file of files) {
        appendRecord(FIELD_CODES.logicalPath, file.file.logicalPath, file.file.logicalPath);
    }

    const metadata = [
        ...new Set(
            getAssetSpecHandler(asset.kind)
                .searchProjection(version.manifest, version.files)
                .map(sanitizeSearchText)
                .filter((value) => value.length > 0),
        ),
    ].sort(compareUtf8Bytes);
    for (const value of metadata) {
        appendRecord(FIELD_CODES.typeMetadata, value, undefined, CATALOG_SEARCH_MAXIMUM_FILE_BYTES);
    }
    for (const file of files) {
        if (file.contentKind === "text") {
            appendRecord(FIELD_CODES.textContent, file.text, file.file.logicalPath, CATALOG_SEARCH_MAXIMUM_FILE_BYTES);
        }
    }

    return { displayName, displayDescription, searchableText: records.join("") };
}

export function queryCatalogAssetMatches(db: Database, query: string, limit: number): CatalogSearchResult["assets"] {
    const params = searchSqlParameters(query);
    const where = `a.deleted = 0 AND ${params.where}`;
    const count = db
        .prepare(
            `SELECT COUNT(*) AS item_count
             FROM current_asset_index AS a
             JOIN assets_fts ON assets_fts.asset_id = a.asset_id
             WHERE ${where}`,
        )
        .get(params.values) as { item_count: number };
    const rows = db
        .prepare(
            `SELECT
                 a.asset_id,
                 a.kind,
                 a.scope,
                 a.project_id,
                 a.scope_path,
                 assets_fts.display_name,
                 assets_fts.display_description,
                 assets_fts.searchable_text
             FROM current_asset_index AS a
             JOIN assets_fts ON assets_fts.asset_id = a.asset_id
             WHERE ${where}
             ORDER BY a.display_name COLLATE BINARY, a.asset_id COLLATE BINARY
             LIMIT @limit`,
        )
        .all({ ...params.values, limit }) as Record<string, unknown>[];
    return {
        items: rows.map(mapSearchAssetRow).map((row) => projectAssetMatch(row, query)),
        totalCount: count.item_count,
    };
}

export function projectCatalogProjectMatches(
    projects: readonly {
        projectId: string;
        displayName: string;
        rootPath: string;
        deleted: boolean;
    }[],
    query: string,
    limit: number,
): CatalogSearchResult["projects"] {
    const matches = projects
        .flatMap((project) => {
            const displayName = sanitizeSearchText(project.displayName);
            const rootPath = sanitizeSearchText(project.rootPath);
            const displayIndex = findFoldedIndex(displayName, query);
            const rootIndex = findFoldedIndex(rootPath, query);
            if (displayIndex < 0 && rootIndex < 0) return [];
            const matchedField = displayIndex >= 0 ? ("display_name" as const) : ("root_path" as const);
            const source = matchedField === "display_name" ? displayName : rootPath;
            const index = matchedField === "display_name" ? displayIndex : rootIndex;
            return [
                {
                    projectId: project.projectId as CatalogSearchResult["projects"]["items"][number]["projectId"],
                    displayName,
                    rootPath,
                    deleted: project.deleted,
                    matchedField,
                    snippet: buildSnippet(source, index, query),
                },
            ];
        })
        .sort(
            (left, right) =>
                compareUtf8Bytes(left.displayName, right.displayName) || compareUtf8Bytes(left.projectId, right.projectId),
        );
    return { items: matches.slice(0, limit), totalCount: matches.length };
}

function searchSqlParameters(query: string): { where: string; values: Record<string, string> } {
    const exactMatch =
        "(instr(lower(assets_fts.display_name), lower(@query)) > 0 OR " +
        "instr(lower(assets_fts.display_description), lower(@query)) > 0 OR " +
        "instr(lower(assets_fts.searchable_text), lower(@query)) > 0)";
    return [...query].length < 3
        ? { where: exactMatch, values: { query } }
        : {
              where: `assets_fts MATCH @ftsQuery AND ${exactMatch}`,
              values: { query, ftsQuery: `"${query.replaceAll('"', '""')}"*` },
          };
}

function projectAssetMatch(row: SearchAssetRow, query: string): CatalogSearchAssetMatch {
    const base = {
        assetId: row.assetId as CatalogSearchAssetMatch["assetId"],
        kind: row.kind as CatalogSearchAssetMatch["kind"],
        scope: row.scope as CatalogSearchAssetMatch["scope"],
        projectId: row.projectId,
        scopePath: row.scopePath,
        displayName: row.displayName,
    };
    const displayNameIndex = findFoldedIndex(row.displayName, query);
    if (displayNameIndex >= 0) {
        return {
            ...base,
            matchedField: "display_name",
            snippet: buildSnippet(row.displayName, displayNameIndex, query),
        };
    }
    const descriptionIndex = findFoldedIndex(row.displayDescription, query);
    if (descriptionIndex >= 0) {
        return {
            ...base,
            matchedField: "display_description",
            snippet: buildSnippet(row.displayDescription, descriptionIndex, query),
        };
    }
    for (const field of parseSearchDocument(row.searchableText)) {
        const index = findFoldedIndex(field.text, query);
        if (index < 0) continue;
        return field.matchedField === "logical_path" || field.matchedField === "text_content"
            ? {
                  ...base,
                  matchedField: field.matchedField,
                  logicalPath: field.logicalPath,
                  snippet: buildSnippet(field.text, index, query),
              }
            : {
                  ...base,
                  matchedField: field.matchedField,
                  snippet: buildSnippet(field.text, index, query),
              };
    }
    throw new Error(`search projection match for Asset ${row.assetId} could not be attributed`);
}

function parseSearchDocument(value: string): SearchDocumentField[] {
    return value
        .split(RECORD_SEPARATOR)
        .filter((record) => record.length > 0)
        .flatMap((record): SearchDocumentField[] => {
            const unit = record.indexOf(UNIT_SEPARATOR);
            if (unit < 1) return [];
            const code = record.slice(0, unit);
            const body = record.slice(unit + 1);
            if (code === FIELD_CODES.kind) return [{ matchedField: "kind", text: body }];
            if (code === FIELD_CODES.scopePath) return [{ matchedField: "scope_path", text: body }];
            if (code === FIELD_CODES.typeMetadata) return [{ matchedField: "type_metadata", text: body }];
            if (code !== FIELD_CODES.logicalPath && code !== FIELD_CODES.textContent) return [];
            const group = body.indexOf(GROUP_SEPARATOR);
            if (group < 1) return [];
            const logicalPath = body.slice(0, group) as PosixRelativePath;
            const text = body.slice(group + 1);
            return [
                code === FIELD_CODES.logicalPath
                    ? { matchedField: "logical_path", logicalPath, text }
                    : { matchedField: "text_content", logicalPath, text },
            ];
        });
}

function mapSearchAssetRow(row: Record<string, unknown>): SearchAssetRow {
    const read = (name: string): string => {
        const value = row[name];
        if (typeof value !== "string") throw new Error(`catalog search row ${name} must be a string`);
        return value;
    };
    return {
        assetId: read("asset_id"),
        kind: read("kind"),
        scope: read("scope"),
        projectId: read("project_id"),
        scopePath: read("scope_path"),
        displayName: read("display_name"),
        displayDescription: read("display_description"),
        searchableText: read("searchable_text"),
    };
}

function sanitizeSearchText(value: string): string {
    return [...value.normalize("NFC")]
        .map((character) => (isSearchControlCharacter(character) ? " " : character))
        .join("")
        .replace(/\s+/gu, " ")
        .trim();
}

function isSearchControlCharacter(character: string): boolean {
    const codeUnit = character.charCodeAt(0);
    return codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f);
}

function truncateUtf8(value: string, maximumBytes: number): string {
    if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
    let result = "";
    let used = 0;
    for (const character of value) {
        const bytes = Buffer.byteLength(character, "utf8");
        if (used + bytes > maximumBytes) break;
        result += character;
        used += bytes;
    }
    return result;
}

function findFoldedIndex(value: string, query: string): number {
    return value.toLocaleLowerCase("en-US").indexOf(query.toLocaleLowerCase("en-US"));
}

function buildSnippet(value: string, matchIndex: number, query: string): string {
    const codePoints = [...value];
    const prefixCodePoints = [...value.slice(0, matchIndex)].length;
    const matchCodePoints = Math.max(1, [...query].length);
    const context = Math.max(0, CATALOG_SEARCH_MAXIMUM_SNIPPET_CODE_POINTS - matchCodePoints);
    let start = Math.max(0, prefixCodePoints - Math.floor(context / 2));
    const end = Math.min(codePoints.length, start + CATALOG_SEARCH_MAXIMUM_SNIPPET_CODE_POINTS);
    start = Math.max(0, end - CATALOG_SEARCH_MAXIMUM_SNIPPET_CODE_POINTS);
    return `${start > 0 ? "…" : ""}${codePoints.slice(start, end).join("")}${end < codePoints.length ? "…" : ""}`;
}
