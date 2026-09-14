import * as crypto from "node:crypto";
import { durableCreateFile } from "@oaam/shared/filesystem";
import type { Database } from "better-sqlite3";
import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import type {
    AssetKind,
    AssetManifestV1,
    AssetLibraryApi,
    AssetLibraryFilter,
    AssetSummaryPage,
    AssetVersionFilePreview,
    AssetVersionFileTreeEntry,
    AssetVersionFileTreePage,
    AssetVersionManifestV2,
    AssetVersionPage,
    AssetVersionSummary,
    AssetVersionTextPage,
    CoreResult,
    ListAssetVersionFileChildrenInput,
    ListAssetVersionPageInput,
    LookupResult,
    OperationDiagnostic,
    PosixRelativePath,
    QueryAssetSummaryPageInput,
    ReadAssetVersionFilePreviewInput,
    ReadAssetVersionTextPageInput,
    UuidV4,
    VersionRef,
} from "../types";
import { countAssetKinds, queryAssetIndexPage, type AssetIndexPageBoundary } from "../catalog/asset-index-query";
import { readAssetManifest, serializeAssetManifest } from "../catalog/asset-manifest";
import { readAssetVersionManifest, resolveAssetVersionRoot } from "../catalog/asset-library-authority";
import { bytesForPayload, readPayload, readVerifiedTextPayloadPage } from "../catalog/payload-store";
import { completeResult } from "../foundation/core-result";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isPosixRelativePath, isUuidV4 } from "../foundation/validators";
import { BUILTIN_ASSET_KINDS } from "../specs/registry";
import { compareAssetVersions as compareImmutableAssetVersions } from "./asset-version-comparison-service";
import {
    exportAssetVersionNativeFilesToFile as exportImmutableAssetVersionNativeFilesToFile,
    exportAssetVersionToFile as exportImmutableAssetVersionToFile,
} from "./asset-version-export-service";

const MAXIMUM_PAGE_SIZE = 50;
const MAXIMUM_KEYWORDS_LENGTH = 1_024;
const MAXIMUM_CURSOR_LENGTH = 16_384;
const MAXIMUM_AUTOMATIC_TEXT_BYTES = 2 * 1_024 * 1_024;
const MAXIMUM_AUTOMATIC_TEXT_LINES = 5_000;
const TEXT_PAGE_BYTES = 256 * 1_024;

export interface CoreAssetLibraryServiceConfiguration {
    assetsRoot: string;
    db: Database;
    dialectRegistry: VersionDialectRegistryV1;
    catalogGeneration(): number;
    cursorInstanceId?: string;
    now(): number;
}

type AssetPageCursor = {
    schemaVersion: 1;
    cursorKind: "asset_page";
    cursorInstanceId: string;
    catalogGeneration: number;
    filter: NormalizedAssetPageFilter;
    after: AssetIndexPageBoundary;
};

type VersionPageCursor = {
    schemaVersion: 1;
    cursorKind: "version_page";
    assetId: UuidV4;
    assetManifestFingerprint: string;
    nextIndex: number;
};

type FileTreeCursor = {
    schemaVersion: 1;
    cursorKind: "file_tree";
    assetId: UuidV4;
    versionId: UuidV4;
    versionFingerprint: string;
    directoryPath: string;
    nextIndex: number;
};

type TextPageCursor = {
    schemaVersion: 1;
    cursorKind: "text_page";
    assetId: UuidV4;
    versionId: UuidV4;
    versionFingerprint: string;
    logicalPath: PosixRelativePath;
    contentHash: string;
    nextByteOffset: number;
};

type LibraryCursor = AssetPageCursor | VersionPageCursor | FileTreeCursor | TextPageCursor;

interface NormalizedAssetPageFilter {
    scope: "global" | "project";
    projectId: string;
    kind: AssetKind;
    keywords: string;
    includeDeleted: boolean;
    pageSize: number;
}

export function createCoreAssetLibraryService(configuration: CoreAssetLibraryServiceConfiguration): AssetLibraryApi {
    const cursorInstanceId = configuration.cursorInstanceId ?? crypto.randomUUID();
    const service: AssetLibraryApi = {
        listAssetKindCounts(input) {
            return run("asset", () => {
                const filter = normalizeLibraryFilter(input);
                const counts = countAssetKinds(configuration.db, filter);
                return BUILTIN_ASSET_KINDS.map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
            });
        },
        queryAssetSummaryPage(input) {
            return run<AssetSummaryPage>("asset", () => {
                const filter = normalizeAssetPageFilter(input);
                const cursor =
                    input.cursor === undefined
                        ? undefined
                        : requireAssetPageCursor(
                              decodeCursor(input.cursor),
                              cursorInstanceId,
                              configuration.catalogGeneration(),
                              filter,
                          );
                const page = queryAssetIndexPage(configuration.db, filter, filter.pageSize, cursor?.after);
                if (!page.hasMore) return { items: page.items, totalCount: page.totalCount, hasMore: false };
                const last = page.items[page.items.length - 1] as (typeof page.items)[number];
                return {
                    items: page.items,
                    totalCount: page.totalCount,
                    hasMore: true,
                    nextCursor: encodeCursor({
                        schemaVersion: 1,
                        cursorKind: "asset_page",
                        cursorInstanceId,
                        catalogGeneration: configuration.catalogGeneration(),
                        filter,
                        after: { displayName: last.displayName, assetId: last.assetId },
                    }),
                } satisfies AssetSummaryPage;
            });
        },
        getVersionManifest(ref) {
            return run("version", () => lookupVersionManifest(configuration.assetsRoot, ref));
        },
        listAssetVersionPage(input) {
            return run("version", () => listVersionPage(configuration.assetsRoot, input));
        },
        listAssetVersionFileChildren(input) {
            return run("version", () => listFileChildren(configuration.assetsRoot, input));
        },
        readAssetVersionFilePreview(input) {
            return run("version", () => readFilePreview(configuration.assetsRoot, input));
        },
        readAssetVersionTextPage(input) {
            return run("version", () => readTextPage(configuration.assetsRoot, input));
        },
        compareAssetVersions(input, observer) {
            return compareImmutableAssetVersions(configuration.assetsRoot, input, observer);
        },
        exportAssetVersionToFile(input) {
            return exportImmutableAssetVersionToFile(
                configuration.assetsRoot,
                configuration.dialectRegistry,
                configuration.now,
                durableCreateFile,
                input,
            );
        },
        exportAssetVersionNativeFilesToFile(input) {
            return exportImmutableAssetVersionNativeFilesToFile(
                configuration.assetsRoot,
                configuration.dialectRegistry,
                configuration.now,
                durableCreateFile,
                input,
            );
        },
    };
    return Object.freeze(service);
}

function readTextPage(assetsRoot: string, input: ReadAssetVersionTextPageInput): LookupResult<AssetVersionTextPage> {
    requireUuid(input.assetId, "assetId");
    requireUuid(input.versionId, "versionId");
    if (!isPosixRelativePath(input.logicalPath)) throw new Error("logicalPath must be a normalized POSIX-relative path");
    const manifest = readAssetVersionManifest(assetsRoot, input.assetId, input.versionId);
    if (manifest === null) return { found: false };
    const file = manifest.files.find((candidate) => candidate.logicalPath === input.logicalPath);
    if (file === undefined) return { found: false };
    if (file.contentKind !== "text") throw new Error("progressive text pages require a text Version member");
    const cursor =
        input.cursor === undefined
            ? undefined
            : requireTextPageCursor(decodeCursor(input.cursor), input, manifest.fingerprint, file.contentHash);
    const byteOffset = cursor?.nextByteOffset ?? 0;
    const page = readVerifiedTextPayloadPage(
        resolveAssetVersionRoot(assetsRoot, input.assetId, input.versionId),
        file.contentHash,
        file.byteSize,
        byteOffset,
        TEXT_PAGE_BYTES,
    );
    if (page.loadedByteEnd >= page.totalBytes) {
        return { found: true, value: { file, ...page, hasMore: false } };
    }
    return {
        found: true,
        value: {
            file,
            ...page,
            hasMore: true,
            nextCursor: encodeCursor({
                schemaVersion: 1,
                cursorKind: "text_page",
                assetId: input.assetId,
                versionId: input.versionId,
                versionFingerprint: manifest.fingerprint,
                logicalPath: input.logicalPath,
                contentHash: file.contentHash,
                nextByteOffset: page.loadedByteEnd,
            }),
        },
    };
}

function listVersionPage(assetsRoot: string, input: ListAssetVersionPageInput): LookupResult<AssetVersionPage> {
    requireUuid(input.assetId, "assetId");
    const pageSize = requirePageSize(input.pageSize);
    const asset = readAssetManifest(assetsRoot, input.assetId);
    if (asset === null) return { found: false };
    const authorityFingerprint = assetManifestFingerprint(asset);
    const cursor =
        input.cursor === undefined
            ? undefined
            : requireVersionPageCursor(decodeCursor(input.cursor), input.assetId, authorityFingerprint);
    const start = cursor?.nextIndex ?? 0;
    if (start > asset.versionIds.length) throw new Error("Version page cursor is outside the Asset history");
    const orderedIds = [...asset.versionIds].reverse();
    const selectedIds = orderedIds.slice(start, start + pageSize);
    const items = selectedIds.map((versionId) => {
        return projectVersionSummary(
            readAssetVersionManifest(assetsRoot, input.assetId, versionId as UuidV4) as AssetVersionManifestV2,
        );
    });
    const nextIndex = start + items.length;
    if (nextIndex >= orderedIds.length) {
        return { found: true, value: { items, totalCount: orderedIds.length, hasMore: false } };
    }
    return {
        found: true,
        value: {
            items,
            totalCount: orderedIds.length,
            hasMore: true,
            nextCursor: encodeCursor({
                schemaVersion: 1,
                cursorKind: "version_page",
                assetId: input.assetId,
                assetManifestFingerprint: authorityFingerprint,
                nextIndex,
            }),
        },
    };
}

function listFileChildren(assetsRoot: string, input: ListAssetVersionFileChildrenInput): LookupResult<AssetVersionFileTreePage> {
    requireUuid(input.assetId, "assetId");
    requireUuid(input.versionId, "versionId");
    const directoryPath = requireDirectoryPath(input.directoryPath);
    const pageSize = requirePageSize(input.pageSize);
    const manifest = readAssetVersionManifest(assetsRoot, input.assetId, input.versionId);
    if (manifest === null) return { found: false };
    const cursor =
        input.cursor === undefined
            ? undefined
            : requireFileTreeCursor(decodeCursor(input.cursor), input, manifest.fingerprint, directoryPath);
    const entries = collectImmediateChildren(manifest, directoryPath);
    if (directoryPath !== "" && entries.length === 0) {
        throw new Error("Version file-tree directory does not exist");
    }
    const start = cursor?.nextIndex ?? 0;
    if (start > entries.length) throw new Error("File-tree cursor is outside the directory");
    const pageEntries = entries.slice(start, start + pageSize);
    const nextIndex = start + pageEntries.length;
    if (nextIndex >= entries.length) {
        return { found: true, value: { entries: pageEntries, totalCount: entries.length, hasMore: false } };
    }
    return {
        found: true,
        value: {
            entries: pageEntries,
            totalCount: entries.length,
            hasMore: true,
            nextCursor: encodeCursor({
                schemaVersion: 1,
                cursorKind: "file_tree",
                assetId: input.assetId,
                versionId: input.versionId,
                versionFingerprint: manifest.fingerprint,
                directoryPath,
                nextIndex,
            }),
        },
    };
}

function readFilePreview(assetsRoot: string, input: ReadAssetVersionFilePreviewInput): LookupResult<AssetVersionFilePreview> {
    requireUuid(input.assetId, "assetId");
    requireUuid(input.versionId, "versionId");
    if (!isPosixRelativePath(input.logicalPath)) throw new Error("logicalPath must be a normalized POSIX-relative path");
    const manifest = readAssetVersionManifest(assetsRoot, input.assetId, input.versionId);
    if (manifest === null) return { found: false };
    const file = manifest.files.find((candidate) => candidate.logicalPath === input.logicalPath);
    if (file === undefined) return { found: false };
    if (file.contentKind === "binary") {
        return { found: true, value: { previewKind: "binary", file } };
    }
    if (file.byteSize > MAXIMUM_AUTOMATIC_TEXT_BYTES) {
        return { found: true, value: { previewKind: "large_text", file, limitReason: "byte_limit" } };
    }
    const bytes = readPayload(
        resolveAssetVersionRoot(assetsRoot, input.assetId, input.versionId),
        file.contentHash,
        file.byteSize,
    ).bytes;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(bytesForPayload(text, "text")).equals(Buffer.from(bytes))) {
        throw new Error("canonical text payload is not normalized");
    }
    const lineCount = text.split("\n").length;
    if (lineCount > MAXIMUM_AUTOMATIC_TEXT_LINES) {
        return {
            found: true,
            value: { previewKind: "large_text", file, limitReason: "line_limit", observedLineCount: lineCount },
        };
    }
    return { found: true, value: { previewKind: "text", file, text, lineCount } };
}

function lookupVersionManifest(assetsRoot: string, ref: VersionRef): LookupResult<AssetVersionManifestV2> {
    requireUuid(ref.assetId, "assetId");
    requireUuid(ref.versionId, "versionId");
    const manifest = readAssetVersionManifest(assetsRoot, ref.assetId, ref.versionId);
    return manifest === null ? { found: false } : { found: true, value: manifest };
}

function collectImmediateChildren(manifest: AssetVersionManifestV2, directoryPath: string): AssetVersionFileTreeEntry[] {
    const prefix = directoryPath === "" ? "" : `${directoryPath}/`;
    const directories = new Map<string, number>();
    const files: AssetVersionFileTreeEntry[] = [];
    for (const file of manifest.files) {
        if (!file.logicalPath.startsWith(prefix)) continue;
        const remainder = file.logicalPath.slice(prefix.length);
        const separator = remainder.indexOf("/");
        if (separator === -1) {
            files.push({ entryKind: "file", relativeName: remainder, file });
            continue;
        }
        const relativeName = remainder.slice(0, separator);
        directories.set(relativeName, (directories.get(relativeName) ?? 0) + 1);
    }
    const directoryEntries: AssetVersionFileTreeEntry[] = [...directories].map(([relativeName, descendantFileCount]) => ({
        entryKind: "directory",
        relativeName,
        logicalPath: `${prefix}${relativeName}` as PosixRelativePath,
        descendantFileCount,
    }));
    return [...directoryEntries.sort(compareTreeEntryName), ...files.sort(compareTreeEntryName)];
}

function compareTreeEntryName(left: AssetVersionFileTreeEntry, right: AssetVersionFileTreeEntry): number {
    return compareUtf8Bytes(left.relativeName, right.relativeName);
}

function projectVersionSummary(manifest: AssetVersionManifestV2): AssetVersionSummary {
    return {
        assetId: manifest.assetId,
        versionId: manifest.versionId,
        revision: manifest.revision,
        status: manifest.status,
        fingerprint: manifest.fingerprint,
        originAuthorityFingerprint: manifest.originAuthority.authorityFingerprint,
        versionCanonicalContentFingerprint: manifest.versionCanonicalContentFingerprint,
        changeKind: manifest.changeKind,
        sourceVersionId: manifest.sourceVersionId,
        sourceDeploymentId: manifest.sourceDeploymentId,
        changeNote: manifest.changeNote,
        fileCount: manifest.files.length,
        createdAt: manifest.createdAt,
    };
}

function requireTextPageCursor(
    cursor: LibraryCursor,
    input: ReadAssetVersionTextPageInput,
    versionFingerprint: string,
    contentHash: string,
): TextPageCursor {
    if (
        cursor.cursorKind !== "text_page" ||
        cursor.schemaVersion !== 1 ||
        cursor.assetId !== input.assetId ||
        cursor.versionId !== input.versionId ||
        cursor.versionFingerprint !== versionFingerprint ||
        cursor.logicalPath !== input.logicalPath ||
        cursor.contentHash !== contentHash ||
        !Number.isSafeInteger(cursor.nextByteOffset) ||
        cursor.nextByteOffset < 1
    ) {
        throw new Error("text-page cursor does not match the selected immutable Version member");
    }
    return cursor;
}

function normalizeLibraryFilter(input: AssetLibraryFilter) {
    const subject = normalizeSubject(input.subject);
    return {
        ...subject,
        keywords: requireKeywords(input.keywords),
        includeDeleted: input.includeDeleted ?? false,
    };
}

function normalizeAssetPageFilter(input: QueryAssetSummaryPageInput): NormalizedAssetPageFilter {
    return {
        ...normalizeLibraryFilter(input),
        kind: input.kind,
        pageSize: requirePageSize(input.pageSize),
    };
}

function normalizeSubject(subject: AssetLibraryFilter["subject"]): { scope: "global" | "project"; projectId: string } {
    if (subject.scope === "global") return { scope: "global", projectId: "" };
    requireUuid(subject.projectId, "projectId");
    return { scope: "project", projectId: subject.projectId };
}

function requireKeywords(value: string): string {
    if (value.includes("\0") || value.length > MAXIMUM_KEYWORDS_LENGTH) {
        throw new Error(`keywords must contain no NUL and be at most ${MAXIMUM_KEYWORDS_LENGTH} characters`);
    }
    return value.trim();
}

function requirePageSize(value: number | undefined): number {
    const pageSize = value ?? MAXIMUM_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAXIMUM_PAGE_SIZE) {
        throw new Error(`pageSize must be an integer from 1 through ${MAXIMUM_PAGE_SIZE}`);
    }
    return pageSize;
}

function requireDirectoryPath(value: string): string {
    if (value === "") return value;
    if (!isPosixRelativePath(value)) throw new Error("directoryPath must be empty or a normalized POSIX-relative path");
    return value;
}

function assetManifestFingerprint(asset: AssetManifestV1): string {
    return sha256Bytes(Buffer.from(serializeAssetManifest(asset), "utf-8"));
}

function encodeCursor(cursor: LibraryCursor): string {
    return Buffer.from(JSON.stringify(cursor), "utf-8").toString("base64url");
}

function decodeCursor(value: string): LibraryCursor {
    if (value.length === 0 || value.length > MAXIMUM_CURSOR_LENGTH) throw new Error("library cursor has an invalid length");
    try {
        const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf-8"));
        if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
            throw new Error("cursor payload is not an object");
        }
        return decoded as LibraryCursor;
    } catch (error) {
        throw new Error(`library cursor is invalid: ${String(error)}`);
    }
}

function requireAssetPageCursor(
    cursor: LibraryCursor,
    cursorInstanceId: string,
    catalogGeneration: number,
    filter: NormalizedAssetPageFilter,
): AssetPageCursor {
    if (
        cursor.schemaVersion !== 1 ||
        cursor.cursorKind !== "asset_page" ||
        cursor.cursorInstanceId !== cursorInstanceId ||
        cursor.catalogGeneration !== catalogGeneration ||
        JSON.stringify(cursor.filter) !== JSON.stringify(filter) ||
        typeof cursor.after?.displayName !== "string" ||
        !isUuidV4(cursor.after.assetId)
    ) {
        throw new Error("Asset page cursor is stale or belongs to another query");
    }
    return cursor;
}

function requireVersionPageCursor(cursor: LibraryCursor, assetId: UuidV4, assetManifestFingerprint: string): VersionPageCursor {
    if (
        cursor.schemaVersion !== 1 ||
        cursor.cursorKind !== "version_page" ||
        cursor.assetId !== assetId ||
        cursor.assetManifestFingerprint !== assetManifestFingerprint ||
        !Number.isInteger(cursor.nextIndex) ||
        cursor.nextIndex < 1
    ) {
        throw new Error("Version page cursor is stale or belongs to another Asset");
    }
    return cursor;
}

function requireFileTreeCursor(
    cursor: LibraryCursor,
    input: ListAssetVersionFileChildrenInput,
    versionFingerprint: string,
    directoryPath: string,
): FileTreeCursor {
    if (
        cursor.schemaVersion !== 1 ||
        cursor.cursorKind !== "file_tree" ||
        cursor.assetId !== input.assetId ||
        cursor.versionId !== input.versionId ||
        cursor.versionFingerprint !== versionFingerprint ||
        cursor.directoryPath !== directoryPath ||
        !Number.isInteger(cursor.nextIndex) ||
        cursor.nextIndex < 1
    ) {
        throw new Error("File-tree cursor is stale or belongs to another directory");
    }
    return cursor;
}

function requireUuid(value: string, label: string): asserts value is UuidV4 {
    if (!isUuidV4(value)) throw new Error(`${label} must be UUID v4`);
}

function run<T>(operation: OperationDiagnostic["operation"], action: () => T): CoreResult<T> {
    try {
        return completeResult(action());
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: "failed",
            value: undefined as T,
            diagnostics: [
                {
                    severity: "error",
                    code: `${operation}.library_read_failed`,
                    message,
                    path: "",
                    traceId: "",
                    operation,
                    causeKind: "invalid_schema",
                    retryable: false,
                    suggestedActions: [],
                    rawSummary: message,
                },
            ],
        };
    }
}
