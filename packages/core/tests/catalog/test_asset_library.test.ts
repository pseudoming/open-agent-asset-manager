import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreAssetLibraryService } from "../../src/orchestration/core-asset-library-service";
import { queryAssetIndexPage, queryAssetSummaries } from "../../src/catalog/asset-index-query";
import { readAssetVersionManifest, resolveAssetVersionRoot } from "../../src/catalog/asset-library-authority";
import { insertAssetsFts, upsertCurrentAssetIndex } from "../../src/persistence/state-db";
import {
    EMPTY_VERSION_DIALECT_REGISTRY,
    publishAssetVersion,
    publishInitialAssetVersion,
} from "../../src/catalog/version-authority";
import { readAssetManifest, writeAssetManifest } from "../../src/catalog/asset-manifest";
import { resolvePayloadPath } from "../../src/catalog/payload-store";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import { serializeVersionManifest } from "../../src/catalog/version-manifest";
import type { AssetVersionFileContentV2, UuidV4 } from "../../src/types";
import {
    ASSET_ID,
    makeAsset,
    makeBinaryFile,
    makeTextFile,
    makeVersionClosure,
    VERSION_ID,
    VERSION_ID_2,
} from "./fixtures/version-v2";

const SCHEMA_PATH = path.resolve(__dirname, "../../schema/schema.sql");
const PROJECT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as UuidV4;

let root = "";
let assetsRoot = "";
let db: Database.Database;
let generation = 0;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-asset-library-"));
    assetsRoot = path.join(root, "assets");
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync(SCHEMA_PATH, "utf-8"));
    generation = 0;
});

afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
});

function service(instance = "asset-library-test-instance") {
    return createCoreAssetLibraryService({
        assetsRoot,
        db,
        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        catalogGeneration: () => generation,
        cursorInstanceId: instance,
        now: () => 1_000,
    });
}

function uuid(index: number): UuidV4 {
    return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function seedIndex(count: number): void {
    for (let index = 1; index <= count; index += 1) {
        const assetId = uuid(index);
        const versionId = uuid(index + 10_000);
        const kind = index % 2 === 0 ? "Skill" : "Guidance";
        const displayName = `Asset ${String(index).padStart(3, "0")}`;
        upsertCurrentAssetIndex(db, {
            assetId,
            kind,
            scope: "global",
            projectId: "",
            scopePath: "",
            displayName,
            displayDescription: index === 4 ? 'contains "quoted" search' : "fixture",
            currentVersionId: versionId,
            currentRevision: 1,
            currentFingerprint: `sha256:${"a".repeat(64)}`,
            currentVersionStatus: "complete",
            createdAt: index,
            updatedAt: index,
            deleted: index === count ? 1 : 0,
        });
        insertAssetsFts(db, assetId, displayName, index === 4 ? 'contains "quoted" search' : "fixture", "");
    }
    const projectAssetId = uuid(99_999);
    upsertCurrentAssetIndex(db, {
        assetId: projectAssetId,
        kind: "Memory",
        scope: "project",
        projectId: PROJECT_ID,
        scopePath: "docs",
        displayName: "Project Memory",
        displayDescription: "project-only",
        currentVersionId: uuid(99_998),
        currentRevision: 2,
        currentFingerprint: `sha256:${"b".repeat(64)}`,
        currentVersionStatus: "incomplete",
        createdAt: 1,
        updatedAt: 2,
        deleted: 0,
    });
    insertAssetsFts(db, projectAssetId, "Project Memory", "project-only", "docs");
}

function withFileId(
    file: AssetVersionFileContentV2,
    fileId: UuidV4,
    role: AssetVersionFileContentV2["file"]["role"] = file.file.role,
): AssetVersionFileContentV2 {
    return { ...file, file: { ...file.file, fileId, role } } as AssetVersionFileContentV2;
}

function decodeCursor(cursor: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as Record<string, unknown>;
}

function encodeCursor(cursor: unknown): string {
    return Buffer.from(JSON.stringify(cursor), "utf-8").toString("base64url");
}

function changeCursor(cursor: string, changes: Record<string, unknown>): string {
    return encodeCursor({ ...decodeCursor(cursor), ...changes });
}

function publishRichVersionHistory(): void {
    const richFiles = [
        withFileId(makeBinaryFile(new Uint8Array([0, 1, 2]), "blob.bin"), uuid(201)),
        withFileId(makeTextFile("alpha\n", "docs/alpha.md"), uuid(202), "resource"),
        withFileId(makeTextFile("beta\n", "docs/nested/beta.md"), uuid(203), "resource"),
        withFileId(makeTextFile("x".repeat(2 * 1_024 * 1_024 + 1), "huge.md"), uuid(204), "resource"),
        withFileId(makeTextFile(new Array(5_001).fill("line").join("\n"), "many-lines.md"), uuid(205), "resource"),
        withFileId(makeTextFile("root\n", "root.md"), uuid(206)),
    ];
    const asset = makeAsset([VERSION_ID], {
        displayName: "Library Fixture",
        displayDescription: "rich file graph",
    });
    const initial = makeVersionClosure({ files: richFiles });
    publishInitialAssetVersion({
        assetsRoot,
        transactionId: "library-initial",
        asset,
        version: initial,
        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
    });
    const next = makeVersionClosure({
        versionId: VERSION_ID_2,
        revision: 2,
        sourceVersionId: VERSION_ID,
        changeKind: "edit",
        files: [withFileId(makeTextFile("second\n", "AGENTS.md"), uuid(207))],
        createdAt: 200,
    });
    publishAssetVersion({
        assetsRoot,
        transactionId: "library-next",
        version: next,
        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
    });
}

describe("bounded Asset library queries", () => {
    it("counts all kinds and pages in SQLite order without crossing subject boundaries", () => {
        seedIndex(56);
        const library = service();
        const counts = library.listAssetKindCounts({
            subject: { scope: "global" },
            keywords: "",
        });
        expect(counts.status).toBe("complete");
        expect(counts.value).toEqual([
            { kind: "Guidance", count: 28 },
            { kind: "Rule", count: 0 },
            { kind: "Workflow", count: 0 },
            { kind: "Skill", count: 27 },
            { kind: "Subagent", count: 0 },
            { kind: "Memory", count: 0 },
        ]);

        const first = library.queryAssetSummaryPage({
            subject: { scope: "global" },
            kind: "Guidance",
            keywords: "",
            pageSize: 10,
        });
        expect(first.status).toBe("complete");
        expect(first.value).toMatchObject({ totalCount: 28, hasMore: true });
        expect(first.value.items.map((item) => item.displayName)).toEqual([
            "Asset 001",
            "Asset 003",
            "Asset 005",
            "Asset 007",
            "Asset 009",
            "Asset 011",
            "Asset 013",
            "Asset 015",
            "Asset 017",
            "Asset 019",
        ]);
        if (!first.value.hasMore) throw new Error("fixture expected a second page");
        const second = library.queryAssetSummaryPage({
            subject: { scope: "global" },
            kind: "Guidance",
            keywords: "",
            pageSize: 10,
            cursor: first.value.nextCursor,
        });
        expect(second.value.items[0]?.displayName).toBe("Asset 021");

        const project = library.queryAssetSummaryPage({
            subject: { scope: "project", projectId: PROJECT_ID },
            kind: "Memory",
            keywords: "project",
        });
        expect(project.value).toMatchObject({
            totalCount: 1,
            hasMore: false,
            items: [expect.objectContaining({ displayName: "Project Memory" })],
        });
        expect(
            library.listAssetKindCounts({
                subject: { scope: "global" },
                keywords: '"quoted"',
                includeDeleted: true,
            }).value,
        ).toContainEqual({ kind: "Skill", count: 1 });
    });

    it("rejects stale, foreign, mismatched, malformed, and unbounded page requests", () => {
        seedIndex(4);
        const library = service();
        const first = library.queryAssetSummaryPage({
            subject: { scope: "global" },
            kind: "Guidance",
            keywords: "",
            pageSize: 1,
        });
        if (!first.value.hasMore) throw new Error("fixture expected a cursor");
        const cursor = first.value.nextCursor;
        for (const invalidCursor of [
            changeCursor(cursor, { schemaVersion: 2 }),
            changeCursor(cursor, { cursorKind: "version_page" }),
            changeCursor(cursor, { after: { displayName: 1, assetId: uuid(1) } }),
            changeCursor(cursor, { after: { displayName: "Asset 001", assetId: "bad" } }),
        ]) {
            expect(
                library.queryAssetSummaryPage({
                    subject: { scope: "global" },
                    kind: "Guidance",
                    keywords: "",
                    pageSize: 1,
                    cursor: invalidCursor,
                }).status,
            ).toBe("failed");
        }
        expect(
            library.queryAssetSummaryPage({
                subject: { scope: "global" },
                kind: "Skill",
                keywords: "",
                pageSize: 1,
                cursor,
            }).status,
        ).toBe("failed");
        for (const malformedCursor of ["", "x".repeat(16_385), encodeCursor(1), encodeCursor(null), encodeCursor([])]) {
            expect(
                library.queryAssetSummaryPage({
                    subject: { scope: "global" },
                    kind: "Guidance",
                    keywords: "",
                    cursor: malformedCursor,
                }).status,
            ).toBe("failed");
        }
        expect(
            service("another-instance").queryAssetSummaryPage({
                subject: { scope: "global" },
                kind: "Guidance",
                keywords: "",
                pageSize: 1,
                cursor,
            }).status,
        ).toBe("failed");
        expect(
            library.queryAssetSummaryPage({
                subject: { scope: "global" },
                kind: "Guidance",
                keywords: "",
                pageSize: 0,
            }).status,
        ).toBe("failed");
        expect(
            library.queryAssetSummaryPage({
                subject: { scope: "global" },
                kind: "Guidance",
                keywords: "",
                pageSize: 1.5,
            }).status,
        ).toBe("failed");
        generation += 1;
        expect(
            library.queryAssetSummaryPage({
                subject: { scope: "global" },
                kind: "Guidance",
                keywords: "",
                pageSize: 1,
                cursor,
            }).status,
        ).toBe("failed");
        expect(
            library.queryAssetSummaryPage({
                subject: { scope: "global" },
                kind: "Guidance",
                keywords: "",
                cursor: "not-json",
            }).status,
        ).toBe("failed");
        expect(
            library.queryAssetSummaryPage({
                subject: { scope: "global" },
                kind: "Guidance",
                keywords: "",
                pageSize: 51,
            }).status,
        ).toBe("failed");
        expect(
            library.listAssetKindCounts({
                subject: { scope: "project", projectId: "bad" as UuidV4 },
                keywords: "",
            }).status,
        ).toBe("failed");
        expect(
            library.listAssetKindCounts({
                subject: { scope: "global" },
                keywords: "x".repeat(1_025),
            }).status,
        ).toBe("failed");
        expect(
            library.listAssetKindCounts({
                subject: { scope: "global" },
                keywords: "\0",
            }).status,
        ).toBe("failed");
    });

    it("keeps the compatibility query SQL-bounded across every legacy filter", () => {
        seedIndex(4);
        expect(
            queryAssetSummaries(db, {
                keywords: "project",
                filter: {
                    kind: "Memory",
                    scope: "project",
                    projectId: PROJECT_ID,
                    scopePathPrefix: "docs",
                    includeDeleted: true,
                    currentVersionStatus: "incomplete",
                },
                limit: 1,
                offset: 0,
            }),
        ).toMatchObject({ totalCount: 1, items: [expect.objectContaining({ displayName: "Project Memory" })] });
        expect(
            queryAssetSummaries(db, {
                keywords: "",
                filter: { includeDeleted: true },
                limit: 2,
                offset: 1,
            }),
        ).toMatchObject({ totalCount: 5, items: { length: 2 } });
        expect(
            queryAssetSummaries(db, {
                keywords: "",
                filter: { includeDeleted: true, scopePathPrefix: "" },
            }).totalCount,
        ).toBe(5);
    });

    it("rejects corrupt string and numeric values projected from the disposable index", () => {
        seedIndex(1);
        db.prepare("UPDATE current_asset_index SET display_name = x'01' WHERE asset_id = ?").run(uuid(1));
        expect(() =>
            queryAssetIndexPage(db, { scope: "global", projectId: "", kind: "Guidance", keywords: "", includeDeleted: true }, 1),
        ).toThrow(/display_name/u);

        db.prepare("UPDATE current_asset_index SET display_name = ?, current_revision = 1 WHERE asset_id = ?").run(
            "Asset 001",
            uuid(1),
        );
        db.pragma("ignore_check_constraints = ON");
        db.prepare("UPDATE current_asset_index SET current_revision = -1 WHERE asset_id = ?").run(uuid(1));
        expect(() =>
            queryAssetIndexPage(db, { scope: "global", projectId: "", kind: "Guidance", keywords: "", includeDeleted: true }, 1),
        ).toThrow(/current_revision/u);
    });
});

describe("manifest-only Version and bounded file reads", () => {
    it("pages Version metadata and an implicit file tree without opening unrelated payloads", () => {
        publishRichVersionHistory();
        fs.rmSync(path.join(assetsRoot, ASSET_ID, "versions", VERSION_ID, "payloads"), {
            recursive: true,
            force: true,
        });
        const library = service();
        const versionPage = library.listAssetVersionPage({ assetId: ASSET_ID as UuidV4, pageSize: 1 });
        expect(versionPage.value).toMatchObject({
            found: true,
            value: {
                totalCount: 2,
                hasMore: true,
                items: [expect.objectContaining({ versionId: VERSION_ID_2, revision: 2, fileCount: 1 })],
            },
        });
        if (!versionPage.value.found || !versionPage.value.value.hasMore) throw new Error("fixture expected history cursor");
        const older = library.listAssetVersionPage({
            assetId: ASSET_ID as UuidV4,
            pageSize: 1,
            cursor: versionPage.value.value.nextCursor,
        });
        expect(older.value).toMatchObject({
            found: true,
            value: {
                hasMore: false,
                items: [expect.objectContaining({ versionId: VERSION_ID, revision: 1, fileCount: 6 })],
            },
        });

        const rootPage = library.listAssetVersionFileChildren({
            assetId: ASSET_ID as UuidV4,
            versionId: VERSION_ID as UuidV4,
            directoryPath: "",
            pageSize: 2,
        });
        expect(rootPage.value).toMatchObject({
            found: true,
            value: {
                totalCount: 5,
                hasMore: true,
                entries: [
                    { entryKind: "directory", relativeName: "docs", descendantFileCount: 2 },
                    { entryKind: "file", relativeName: "blob.bin" },
                ],
            },
        });
        if (!rootPage.value.found || !rootPage.value.value.hasMore) throw new Error("fixture expected file cursor");
        const remainder = library.listAssetVersionFileChildren({
            assetId: ASSET_ID as UuidV4,
            versionId: VERSION_ID as UuidV4,
            directoryPath: "",
            pageSize: 2,
            cursor: rootPage.value.value.nextCursor,
        });
        expect(remainder.value).toMatchObject({
            found: true,
            value: {
                totalCount: 5,
                hasMore: true,
                entries: [
                    { entryKind: "file", relativeName: "huge.md" },
                    { entryKind: "file", relativeName: "many-lines.md" },
                ],
            },
        });
        expect(
            library.listAssetVersionFileChildren({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                directoryPath: "docs",
            }).value,
        ).toMatchObject({
            found: true,
            value: {
                hasMore: false,
                entries: [
                    { entryKind: "directory", relativeName: "nested" },
                    { entryKind: "file", relativeName: "alpha.md" },
                ],
            },
        });
    });

    it("returns exact small text and metadata-only binary or large-text dispositions", () => {
        publishRichVersionHistory();
        const library = service();
        expect(
            library.readAssetVersionFilePreview({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                logicalPath: "docs/alpha.md",
            }).value,
        ).toMatchObject({ found: true, value: { previewKind: "text", text: "alpha\n", lineCount: 2 } });
        expect(
            library.readAssetVersionFilePreview({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                logicalPath: "blob.bin",
            }).value,
        ).toMatchObject({ found: true, value: { previewKind: "binary" } });
        expect(
            library.readAssetVersionFilePreview({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                logicalPath: "huge.md",
            }).value,
        ).toMatchObject({ found: true, value: { previewKind: "large_text", limitReason: "byte_limit" } });
        expect(
            library.readAssetVersionFilePreview({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                logicalPath: "many-lines.md",
            }).value,
        ).toMatchObject({
            found: true,
            value: { previewKind: "large_text", limitReason: "line_limit", observedLineCount: 5_001 },
        });
    });

    it("fails closed for stale cursors, invalid paths, missing authority, and corrupt payloads", () => {
        publishRichVersionHistory();
        const library = service();
        const first = library.listAssetVersionPage({ assetId: ASSET_ID as UuidV4, pageSize: 1 });
        if (!first.value.found || !first.value.value.hasMore) throw new Error("fixture expected history cursor");
        const versionCursor = first.value.value.nextCursor;
        for (const invalidCursor of [
            changeCursor(versionCursor, { schemaVersion: 2 }),
            changeCursor(versionCursor, { cursorKind: "file_tree" }),
            changeCursor(versionCursor, { assetId: uuid(700) }),
            changeCursor(versionCursor, { nextIndex: 1.5 }),
            changeCursor(versionCursor, { nextIndex: 0 }),
            changeCursor(versionCursor, { nextIndex: 99 }),
        ]) {
            expect(
                library.listAssetVersionPage({
                    assetId: ASSET_ID as UuidV4,
                    pageSize: 1,
                    cursor: invalidCursor,
                }).status,
            ).toBe("failed");
        }
        const asset = readAssetManifest(assetsRoot, ASSET_ID)!;
        writeAssetManifest(assetsRoot, { ...asset, displayDescription: "changed", updatedAt: asset.updatedAt + 1 });
        expect(
            library.listAssetVersionPage({
                assetId: ASSET_ID as UuidV4,
                pageSize: 1,
                cursor: first.value.value.nextCursor,
            }).status,
        ).toBe("failed");
        expect(library.listAssetVersionPage({ assetId: uuid(999) }).value).toEqual({ found: false });
        expect(
            library.listAssetVersionFileChildren({
                assetId: uuid(999),
                versionId: uuid(998),
                directoryPath: "",
            }).value,
        ).toEqual({ found: false });
        expect(
            library.readAssetVersionFilePreview({
                assetId: uuid(999),
                versionId: uuid(998),
                logicalPath: "missing.md",
            }).value,
        ).toEqual({ found: false });
        expect(
            library.readAssetVersionTextPage({
                assetId: uuid(999),
                versionId: uuid(998),
                logicalPath: "missing.md",
            }).value,
        ).toEqual({ found: false });
        expect(
            library.readAssetVersionTextPage({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                logicalPath: "missing.md",
            }).value,
        ).toEqual({ found: false });
        expect(
            library.readAssetVersionTextPage({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                logicalPath: "../bad",
            }).status,
        ).toBe("failed");
        expect(
            library.listAssetVersionFileChildren({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                directoryPath: "../bad",
            }).status,
        ).toBe("failed");
        expect(
            library.readAssetVersionFilePreview({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                logicalPath: "../bad",
            }).status,
        ).toBe("failed");
        expect(
            library.listAssetVersionFileChildren({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                directoryPath: "missing",
            }).status,
        ).toBe("failed");
        expect(
            library.readAssetVersionFilePreview({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                logicalPath: "missing.md",
            }).value,
        ).toEqual({ found: false });

        const rootPage = library.listAssetVersionFileChildren({
            assetId: ASSET_ID as UuidV4,
            versionId: VERSION_ID as UuidV4,
            directoryPath: "",
            pageSize: 1,
        });
        if (!rootPage.value.found || !rootPage.value.value.hasMore) throw new Error("fixture expected a file cursor");
        const fileCursor = rootPage.value.value.nextCursor;
        for (const invalidCursor of [
            changeCursor(fileCursor, { schemaVersion: 2 }),
            changeCursor(fileCursor, { cursorKind: "version_page" }),
            changeCursor(fileCursor, { assetId: uuid(701) }),
            changeCursor(fileCursor, { versionId: uuid(702) }),
            changeCursor(fileCursor, { versionFingerprint: `sha256:${"f".repeat(64)}` }),
            changeCursor(fileCursor, { directoryPath: "other" }),
            changeCursor(fileCursor, { nextIndex: 1.5 }),
            changeCursor(fileCursor, { nextIndex: 0 }),
            changeCursor(fileCursor, { nextIndex: 99 }),
        ]) {
            expect(
                library.listAssetVersionFileChildren({
                    assetId: ASSET_ID as UuidV4,
                    versionId: VERSION_ID as UuidV4,
                    directoryPath: "",
                    pageSize: 1,
                    cursor: invalidCursor,
                }).status,
            ).toBe("failed");
        }

        const manifest = library.getVersionManifest({
            assetId: ASSET_ID as UuidV4,
            versionId: VERSION_ID as UuidV4,
        }).value.value!;
        const alpha = manifest.files.find((file) => file.logicalPath === "docs/alpha.md")!;
        fs.writeFileSync(resolvePayloadPath(path.join(assetsRoot, ASSET_ID, "versions", VERSION_ID), alpha.contentHash), "bad");
        expect(
            library.readAssetVersionFilePreview({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                logicalPath: "docs/alpha.md",
            }).status,
        ).toBe("failed");
        expect(
            library.getVersionManifest({
                assetId: uuid(999),
                versionId: uuid(998),
            }).value,
        ).toEqual({ found: false });
    });

    it("rejects enclosing Asset/Version identity drift and invalid direct authority paths", () => {
        publishRichVersionHistory();
        expect(readAssetVersionManifest(assetsRoot, ASSET_ID as UuidV4, VERSION_ID as UuidV4)).not.toBeNull();

        const otherAssetId = uuid(801);
        writeAssetManifest(assetsRoot, { ...makeAsset([VERSION_ID]), assetId: otherAssetId });
        const otherVersionRoot = path.join(assetsRoot, otherAssetId, "versions", VERSION_ID);
        fs.mkdirSync(otherVersionRoot, { recursive: true });
        fs.copyFileSync(
            path.join(assetsRoot, ASSET_ID, "versions", VERSION_ID, "version.json"),
            path.join(otherVersionRoot, "version.json"),
        );
        expect(() => readAssetVersionManifest(assetsRoot, otherAssetId, VERSION_ID as UuidV4)).toThrow(/identity/u);

        const differentVersionId = uuid(802);
        const originalAsset = readAssetManifest(assetsRoot, ASSET_ID)!;
        writeAssetManifest(assetsRoot, { ...originalAsset, versionIds: [differentVersionId] });
        const mismatchedVersionRoot = path.join(assetsRoot, ASSET_ID, "versions", differentVersionId);
        fs.mkdirSync(mismatchedVersionRoot, { recursive: true });
        fs.copyFileSync(
            path.join(assetsRoot, ASSET_ID, "versions", VERSION_ID, "version.json"),
            path.join(mismatchedVersionRoot, "version.json"),
        );
        expect(() => readAssetVersionManifest(assetsRoot, ASSET_ID as UuidV4, differentVersionId)).toThrow(/identity/u);

        writeAssetManifest(assetsRoot, { ...originalAsset, kind: "Rule" });
        expect(() => readAssetVersionManifest(assetsRoot, ASSET_ID as UuidV4, VERSION_ID as UuidV4)).toThrow(/identity/u);

        expect(() => readAssetVersionManifest(assetsRoot, "bad" as UuidV4, VERSION_ID as UuidV4)).toThrow(/UUID/u);
        expect(() => readAssetVersionManifest(assetsRoot, ASSET_ID as UuidV4, "bad" as UuidV4)).toThrow(/UUID/u);
        expect(() => resolveAssetVersionRoot(assetsRoot, "bad" as UuidV4, VERSION_ID as UuidV4)).toThrow(/UUID/u);
        expect(() => resolveAssetVersionRoot(assetsRoot, ASSET_ID as UuidV4, "bad" as UuidV4)).toThrow(/UUID/u);
    });

    it("detects a text payload whose bytes violate canonical text normalization", () => {
        const raw = Buffer.from("line\r\n", "utf-8");
        const file = withFileId(makeTextFile("placeholder\n", "raw.md"), uuid(901), "entry");
        file.file.contentHash = sha256Bytes(raw);
        file.file.byteSize = raw.length;
        const closure = makeVersionClosure({ files: [file] });
        fs.mkdirSync(assetsRoot);
        writeAssetManifest(assetsRoot, makeAsset([VERSION_ID]));
        const versionRoot = resolveAssetVersionRoot(assetsRoot, ASSET_ID as UuidV4, VERSION_ID as UuidV4);
        fs.mkdirSync(path.join(versionRoot, "payloads"), { recursive: true });
        fs.writeFileSync(path.join(versionRoot, "version.json"), serializeVersionManifest(closure.manifest));
        fs.writeFileSync(resolvePayloadPath(versionRoot, file.file.contentHash), raw);

        expect(
            service().readAssetVersionFilePreview({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                logicalPath: "raw.md",
            }).status,
        ).toBe("failed");
    });

    it("redacts non-Error failures from a malformed database boundary", () => {
        const malformedDb = {
            prepare() {
                throw "malformed database";
            },
        } as unknown as Database.Database;
        const result = createCoreAssetLibraryService({
            assetsRoot,
            db: malformedDb,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            catalogGeneration: () => 0,
            cursorInstanceId: "malformed-db",
            now: () => 1_000,
        }).listAssetKindCounts({ subject: { scope: "global" }, keywords: "" });
        expect(result).toMatchObject({
            status: "failed",
            diagnostics: [{ rawSummary: "malformed database" }],
        });
    });
});
