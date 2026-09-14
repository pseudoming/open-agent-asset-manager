import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    buildAssetSearchIndexProjection,
    CATALOG_SEARCH_MAXIMUM_ASSET_BYTES,
    CATALOG_SEARCH_MAXIMUM_FILE_BYTES,
    normalizeCatalogSearchInput,
    projectCatalogProjectMatches,
    queryCatalogAssetMatches,
} from "../../src/catalog/catalog-search";
import type { CoreResult, OperationDiagnostic, ProjectManifestV1 } from "../../src/types";
import { createCoreCatalogSearchService } from "../../src/orchestration/core-catalog-search-service";
import { insertAssetsFts, upsertCurrentAssetIndex } from "../../src/persistence/state-db";
import { makeAsset, makeBinaryFile, makeTextFile, makeVersionClosure } from "./fixtures/version-v2";

const SCHEMA_PATH = path.resolve(__dirname, "../../schema/schema.sql");
const ASSET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";

let db: Database.Database;
let root: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-catalog-search-"));
    db = new Database(":memory:");
    db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
});

afterEach(() => {
    if (db.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
});

function project(projectId = PROJECT_A, overrides: Partial<ProjectManifestV1> = {}): ProjectManifestV1 {
    return {
        schemaVersion: 1,
        projectId: projectId as ProjectManifestV1["projectId"],
        rootPath: `/workspace/${projectId}`,
        displayName: "Alpha project",
        deleted: false,
        createdAt: 1,
        updatedAt: 2,
        ...overrides,
    };
}

function indexAsset(
    input: {
        displayName?: string;
        displayDescription?: string;
        scopePath?: string;
        text?: string;
        logicalPath?: string;
        canonical?: Parameters<typeof makeVersionClosure>[0]["canonical"];
        deleted?: boolean;
    } = {},
): string {
    const asset = makeAsset([VERSION_ID], {
        assetId: ASSET_ID,
        kind: input.canonical?.kind ?? "Guidance",
        scope: "project",
        projectId: PROJECT_A,
        scopePath: input.scopePath ?? "packages/core",
        displayName: input.displayName ?? "Fixture guidance",
        displayDescription: input.displayDescription ?? "Searchable description",
    });
    const version = makeVersionClosure({
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        canonical: input.canonical,
        files: [makeTextFile(input.text ?? "canonical body needle", input.logicalPath ?? "docs/AGENTS.md")],
    });
    const search = buildAssetSearchIndexProjection(asset, version);
    upsertCurrentAssetIndex(db, {
        assetId: ASSET_ID,
        kind: asset.kind,
        scope: asset.scope,
        projectId: asset.projectId,
        scopePath: asset.scopePath,
        displayName: asset.displayName,
        displayDescription: asset.displayDescription,
        currentVersionId: VERSION_ID,
        currentRevision: 1,
        currentFingerprint: version.manifest.fingerprint,
        currentVersionStatus: "complete",
        createdAt: 1,
        updatedAt: 2,
        deleted: input.deleted ? 1 : 0,
    });
    insertAssetsFts(db, ASSET_ID, search.displayName, search.displayDescription, search.searchableText);
    return search.searchableText;
}

function diagnostic(code: string): OperationDiagnostic {
    return {
        severity: "warning",
        code,
        message: code,
        path: "",
        traceId: "",
        operation: "project",
        causeKind: "partial",
        retryable: false,
        suggestedActions: [],
        rawSummary: code,
    };
}

describe("catalog search projection", () => {
    it("indexes deterministic current canonical text and metadata while excluding binary and native/restoration bytes", () => {
        const asset = makeAsset([VERSION_ID], {
            assetId: ASSET_ID,
            kind: "Rule",
            scope: "project",
            projectId: PROJECT_A,
            scopePath: "packages/core",
            displayName: "Rule\u0001 name",
            displayDescription: "Description\nline",
        });
        const version = makeVersionClosure({
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            canonical: {
                kind: "Rule",
                typeData: {
                    schemaVersion: 2,
                    name: "Review rule",
                    description: "Metadata needle",
                    activation: { mode: "manual" },
                },
            },
            files: [
                makeBinaryFile(new TextEncoder().encode("binary-secret"), "z.bin"),
                makeTextFile("Text needle\nwith controls\u0000", "a.md"),
            ],
        });
        version.nativePayloads = [
            {
                dialectId: "native",
                files: [{ relativePath: "native.md", bytes: new TextEncoder().encode("native-secret") }],
            },
        ];
        version.restorationPayloads = [{ dialectId: "restore", bytes: new TextEncoder().encode("restoration-secret") }];

        const first = buildAssetSearchIndexProjection(asset, version);
        const second = buildAssetSearchIndexProjection(asset, {
            ...version,
            files: [...version.files].reverse(),
        });

        expect(first).toEqual(second);
        expect(first.displayName).toBe("Rule name");
        expect(first.displayDescription).toBe("Description line");
        expect(first.searchableText).toContain("Metadata needle");
        expect(first.searchableText).toContain("Text needle with controls");
        expect(first.searchableText).toContain("z.bin");
        expect(first.searchableText).not.toContain("binary-secret");
        expect(first.searchableText).not.toContain("native-secret");
        expect(first.searchableText).not.toContain("restoration-secret");
    });

    it("enforces per-file and whole-Asset UTF-8 budgets without splitting a code point", () => {
        const huge = "你".repeat(CATALOG_SEARCH_MAXIMUM_FILE_BYTES);
        const asset = makeAsset([VERSION_ID], {
            assetId: ASSET_ID,
            displayName: huge,
            displayDescription: huge,
        });
        const version = makeVersionClosure({
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            files: [makeTextFile(`${huge}tail-marker`, "AGENTS.md")],
        });
        const projection = buildAssetSearchIndexProjection(asset, version);
        const byteLength =
            Buffer.byteLength(projection.displayName) +
            Buffer.byteLength(projection.displayDescription) +
            Buffer.byteLength(projection.searchableText);

        expect(Buffer.byteLength(projection.displayName)).toBeLessThanOrEqual(CATALOG_SEARCH_MAXIMUM_FILE_BYTES);
        expect(Buffer.byteLength(projection.displayName) % 3).toBe(0);
        expect(byteLength).toBeLessThanOrEqual(CATALOG_SEARCH_MAXIMUM_ASSET_BYTES);
        expect(projection.searchableText).not.toContain("tail-marker");
    });

    it("skips records that cannot fit the remaining budget and empty sanitized text", () => {
        const overlongPath = "a".repeat(CATALOG_SEARCH_MAXIMUM_ASSET_BYTES);
        const asset = makeAsset([VERSION_ID], {
            assetId: ASSET_ID,
            displayName: "",
            displayDescription: "",
        });
        const projection = buildAssetSearchIndexProjection(
            asset,
            makeVersionClosure({
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                files: [makeTextFile("\u0000\u0001", "empty.md"), makeTextFile("unreachable", overlongPath)],
            }),
        );

        expect(projection.searchableText).toContain("Guidance");
        expect(projection.searchableText).not.toContain(overlongPath);
    });

    it("validates query controls, Unicode/byte bounds and group limits", () => {
        expect(normalizeCatalogSearchInput({ query: "  Héllo  " })).toEqual({ query: "Héllo", limitPerGroup: 8 });
        expect(normalizeCatalogSearchInput({ query: "x", limitPerGroup: 20 })).toEqual({ query: "x", limitPerGroup: 20 });
        for (const input of [
            { query: " " },
            { query: "a\u0000b" },
            { query: "a\u0085b" },
            { query: "x".repeat(129) },
            { query: "你".repeat(129) },
            { query: "x", limitPerGroup: 0 },
            { query: "x", limitPerGroup: 21 },
            { query: "x", limitPerGroup: 1.5 },
        ]) {
            expect(() => normalizeCatalogSearchInput(input)).toThrow();
        }
    });
});

describe("catalog search query", () => {
    it("returns bounded deterministic matches for every Asset field and supports one-character queries", () => {
        indexAsset({
            displayName: "Zulu",
            displayDescription: "Description target",
            scopePath: "scope/target",
            logicalPath: "docs/target.md",
            text: "body target",
            canonical: {
                kind: "Rule",
                typeData: {
                    schemaVersion: 2,
                    name: "Metadata target",
                    description: "Rule",
                    activation: { mode: "manual" },
                },
            },
        });
        expect(queryCatalogAssetMatches(db, "Z", 8).items[0]).toMatchObject({ matchedField: "display_name" });
        expect(queryCatalogAssetMatches(db, "Description", 8).items[0]).toMatchObject({
            matchedField: "display_description",
        });
        expect(queryCatalogAssetMatches(db, "Rule", 8).items[0]).toMatchObject({ matchedField: "kind" });
        expect(queryCatalogAssetMatches(db, "scope/target", 8).items[0]).toMatchObject({ matchedField: "scope_path" });
        expect(queryCatalogAssetMatches(db, "docs/target.md", 8).items[0]).toMatchObject({
            matchedField: "logical_path",
            logicalPath: "docs/target.md",
        });
        expect(queryCatalogAssetMatches(db, "Metadata target", 8).items[0]).toMatchObject({
            matchedField: "type_metadata",
        });
        expect(queryCatalogAssetMatches(db, "body target", 8).items[0]).toMatchObject({
            matchedField: "text_content",
            logicalPath: "docs/target.md",
        });
    });

    it("excludes deleted Assets, reports totalCount before the limit and returns bounded plain-text snippets", () => {
        indexAsset({ text: `${"prefix ".repeat(40)}<script>alert(1)</script> needle ${"suffix ".repeat(40)}` });
        const result = queryCatalogAssetMatches(db, "needle", 1);
        expect(result.totalCount).toBe(1);
        expect([...result.items[0]!.snippet].length).toBeLessThanOrEqual(162);
        expect(result.items[0]!.snippet).toContain("needle");
        expect(result.items[0]!.snippet).not.toContain("\u001e");

        db.prepare("UPDATE current_asset_index SET deleted = 1 WHERE asset_id = ?").run(ASSET_ID);
        expect(queryCatalogAssetMatches(db, "needle", 1)).toEqual({ items: [], totalCount: 0 });
    });

    it("treats FTS punctuation as literal bound input rather than query syntax", () => {
        indexAsset({ text: 'literal foo"bar token' });
        expect(queryCatalogAssetMatches(db, 'foo"bar', 8)).toMatchObject({
            items: [{ matchedField: "text_content", snippet: expect.stringContaining('foo"bar') }],
            totalCount: 1,
        });
    });

    it("keeps incremental token prefixes searchable without weakening exact match attribution", () => {
        indexAsset({ displayName: "Foobar guide", text: "body target" });
        expect(queryCatalogAssetMatches(db, "foo", 8)).toMatchObject({
            items: [{ matchedField: "display_name", snippet: expect.stringContaining("Foo") }],
            totalCount: 1,
        });
        expect(queryCatalogAssetMatches(db, "body tar", 8)).toMatchObject({
            items: [
                {
                    matchedField: "text_content",
                    logicalPath: "docs/AGENTS.md",
                    snippet: expect.stringContaining("body tar"),
                },
            ],
            totalCount: 1,
        });
    });

    it("fails closed when a matching FTS row cannot be attributed or has an invalid shape", () => {
        indexAsset();
        db.prepare("UPDATE assets_fts SET searchable_text = ? WHERE asset_id = ?").run("unstructured needle", ASSET_ID);
        expect(() => queryCatalogAssetMatches(db, "needle", 8)).toThrow(/could not be attributed/u);

        for (const malformed of ["\u001e\u0009\u001fneedle", "\u001e\u0003\u001fneedle"]) {
            db.prepare("UPDATE assets_fts SET searchable_text = ? WHERE asset_id = ?").run(malformed, ASSET_ID);
            expect(() => queryCatalogAssetMatches(db, "needle", 8)).toThrow(/could not be attributed/u);
        }

        db.prepare("DELETE FROM assets_fts").run();
        insertAssetsFts(db, ASSET_ID, "needle", "", "needle");
        db.prepare("UPDATE assets_fts SET display_name = NULL WHERE asset_id = ?").run(ASSET_ID);
        expect(() => queryCatalogAssetMatches(db, "needle", 8)).toThrow(/display_name must be a string/u);
    });

    it("groups retained Project matches by authoritative identity and stable display order", () => {
        const results = projectCatalogProjectMatches(
            [
                project(PROJECT_B, { displayName: "Zulu", rootPath: "/workspace/needle-z", deleted: true }),
                project(PROJECT_A, { displayName: "Needle Alpha", rootPath: "/workspace/a" }),
                project("33333333-3333-4333-8333-333333333333", {
                    displayName: "Other",
                    rootPath: "/workspace/no-match",
                }),
            ],
            "needle",
            1,
        );
        expect(results.totalCount).toBe(2);
        expect(results.items).toEqual([
            expect.objectContaining({
                projectId: PROJECT_A,
                matchedField: "display_name",
                deleted: false,
            }),
        ]);
        expect(projectCatalogProjectMatches([project()], "absent", 8)).toEqual({ items: [], totalCount: 0 });
        expect(
            projectCatalogProjectMatches(
                [
                    project(PROJECT_B, { displayName: "Needle", rootPath: "/workspace/b" }),
                    project(PROJECT_A, { displayName: "Needle", rootPath: "/workspace/a" }),
                ],
                "needle",
                8,
            ).items.map((item) => item.projectId),
        ).toEqual([PROJECT_A, PROJECT_B]);
    });
});

describe("catalog search service", () => {
    it("combines Project authority and Asset projection without inventing a second query identity", () => {
        indexAsset({ text: "needle" });
        const service = createCoreCatalogSearchService({
            db,
            listProjects: () => ({ status: "complete", value: [project()], diagnostics: [] }),
        });
        expect(service.searchCatalog({ query: "needle", limitPerGroup: 1 })).toMatchObject({
            status: "complete",
            value: {
                projects: { totalCount: 0 },
                assets: { totalCount: 1 },
            },
        });
        expect(service.searchCatalog({ query: "" })).toMatchObject({
            status: "failed",
            diagnostics: [{ operation: "search", causeKind: "invalid_schema" }],
        });
    });

    it("returns a partial result when either Project authority or the Asset projection is unavailable", () => {
        indexAsset({ text: "needle" });
        const partialProject: CoreResult<ProjectManifestV1[]> = {
            status: "partial",
            value: [project()],
            diagnostics: [diagnostic("project.partial")],
        };
        expect(
            createCoreCatalogSearchService({ db, listProjects: () => partialProject }).searchCatalog({
                query: "needle",
            }),
        ).toMatchObject({ status: "partial", diagnostics: [{ code: "project.partial" }] });

        const failedProject: CoreResult<ProjectManifestV1[]> = {
            status: "failed",
            value: undefined as unknown as ProjectManifestV1[],
            diagnostics: [diagnostic("project.failed")],
        };
        expect(
            createCoreCatalogSearchService({ db, listProjects: () => failedProject }).searchCatalog({
                query: "needle",
            }),
        ).toMatchObject({
            status: "partial",
            value: { projects: { items: [], totalCount: 0 }, assets: { totalCount: 1 } },
        });

        db.close();
        expect(
            createCoreCatalogSearchService({
                db,
                listProjects: () => ({ status: "complete", value: [project()], diagnostics: [] }),
            }).searchCatalog({ query: "Alpha" }),
        ).toMatchObject({
            status: "partial",
            value: { projects: { totalCount: 1 }, assets: { items: [], totalCount: 0 } },
            diagnostics: [{ operation: "search" }],
        });
        expect(
            createCoreCatalogSearchService({ db, listProjects: () => failedProject }).searchCatalog({
                query: "needle",
            }),
        ).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "project.failed" }, { operation: "search" }],
        });
    });
});
