/**
 * reindex tests (Step 6 / Phase 13).
 *
 * Verifies reindex rebuilds current_asset_index + FTS from manifest files,
 * skips damaged/missing assets, does not mutate manifests, and handles
 * deleted assets correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { queryCatalogAssetMatches } from "../../src/catalog/catalog-search";
import { reindexAssets } from "../../src/catalog/reindex";
import { upsertCurrentAssetIndex, insertAssetsFts } from "../../src/persistence/state-db";
import { writeAssetManifest } from "../../src/catalog/asset-manifest";
import { EMPTY_VERSION_DIALECT_REGISTRY, publishInitialAssetVersion } from "../../src/catalog/version-authority";
import { makeAsset, makeTextFile, makeVersionClosure } from "./fixtures/version-v2";

const SCHEMA_PATH = path.resolve(__dirname, "../../schema/schema.sql");

const ASSET_ID = "00000000-0000-4000-8000-000000000001";
const VERSION_ID = "00000000-0000-4000-8000-000000000002";
const PROJECT_UUID = "11111111-1111-4111-8111-111111111111";

let tmpAssetsRoot: string;
let db: Database.Database;

beforeEach(() => {
    tmpAssetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-reindex-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync(SCHEMA_PATH, "utf-8"));
});

afterEach(() => {
    db.close();
    fs.rmSync(tmpAssetsRoot, { recursive: true, force: true });
});

/** Write a valid Skill asset + version manifest to disk. */
function writeValidAsset(assetsRoot: string, opts?: { deleted?: boolean }): void {
    const asset = makeAsset([VERSION_ID], {
        assetId: ASSET_ID,
        kind: "Guidance",
        scope: "project",
        projectId: PROJECT_UUID,
        scopePath: "packages/core",
        displayName: "my-skill",
        displayDescription: "A useful skill",
        createdAt: 1000,
        updatedAt: 1000,
    });
    const version = makeVersionClosure({
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        files: [makeTextFile("# payloadneedle\n", "AGENTS.md")],
        createdAt: 1000,
    });
    publishInitialAssetVersion({
        assetsRoot,
        transactionId: `txn-${VERSION_ID}`,
        asset,
        version,
        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
    });
    if (opts?.deleted) writeAssetManifest(assetsRoot, { ...asset, deleted: true });
}

describe("reindexAssets", () => {
    it("indexes a valid asset into current_asset_index + FTS", () => {
        writeValidAsset(tmpAssetsRoot);
        const report = reindexAssets(tmpAssetsRoot, db);
        expect(report.scannedAssets).toBe(1);
        expect(report.indexedAssets).toBe(1);
        expect(report.skippedAssets).toBe(0);
        // Check current_asset_index
        const row = db.prepare("SELECT * FROM current_asset_index WHERE asset_id = ?").get(ASSET_ID) as {
            kind: string;
            display_name: string;
            current_version_id: string;
        };
        expect(row.kind).toBe("Guidance");
        expect(row.display_name).toBe("my-skill");
        expect(row.current_version_id).toBe(VERSION_ID);
        // Check FTS
        const fts = db.prepare("SELECT asset_id FROM assets_fts WHERE assets_fts MATCH 'skill'").all() as { asset_id: string }[];
        expect(fts.length).toBe(1);
        expect(fts[0].asset_id).toBe(ASSET_ID);
        expect(queryCatalogAssetMatches(db, "payloadneedle", 8)).toMatchObject({
            items: [{ assetId: ASSET_ID, matchedField: "text_content", logicalPath: "AGENTS.md" }],
            totalCount: 1,
        });
    });

    it("skips missing asset manifest (diagnostic, no crash)", () => {
        // Create an empty dir (no asset.json)
        fs.mkdirSync(path.join(tmpAssetsRoot, "00000000-0000-4000-8000-000000000099"), { recursive: true });
        const report = reindexAssets(tmpAssetsRoot, db);
        expect(report.scannedAssets).toBe(1);
        expect(report.skippedAssets).toBe(1);
        expect(report.diagnostics.length).toBe(1);
        expect(report.diagnostics[0].code).toBe("reindex.asset_missing");
    });

    it("skips deleted asset by default (removes from index)", () => {
        writeValidAsset(tmpAssetsRoot, { deleted: true });
        // Pre-insert into index so we can verify removal
        upsertCurrentAssetIndex(db, {
            assetId: ASSET_ID,
            kind: "Skill",
            scope: "project",
            projectId: PROJECT_UUID,
            scopePath: "",
            displayName: "old",
            displayDescription: "",
            currentVersionId: VERSION_ID,
            currentRevision: 1,
            currentFingerprint: `sha256:${"a".repeat(64)}`,
            currentVersionStatus: "complete",
            createdAt: 1000,
            updatedAt: 1000,
            deleted: 0,
        });
        const report = reindexAssets(tmpAssetsRoot, db);
        expect(report.skippedAssets).toBe(1);
        // Should have been removed from index
        const row = db.prepare("SELECT * FROM current_asset_index WHERE asset_id = ?").get(ASSET_ID);
        expect(row).toBeUndefined();
    });

    it("includes deleted asset when includeDeleted=true", () => {
        writeValidAsset(tmpAssetsRoot, { deleted: true });
        const report = reindexAssets(tmpAssetsRoot, db, { includeDeleted: true });
        expect(report.indexedAssets).toBe(1);
        const row = db.prepare("SELECT deleted FROM current_asset_index WHERE asset_id = ?").get(ASSET_ID) as { deleted: number };
        expect(row.deleted).toBe(1);
    });

    it("skips when version manifest is missing", () => {
        writeValidAsset(tmpAssetsRoot);
        // Remove version.json
        fs.unlinkSync(path.join(tmpAssetsRoot, ASSET_ID, "versions", VERSION_ID, "version.json"));
        const report = reindexAssets(tmpAssetsRoot, db);
        expect(report.skippedAssets).toBe(1);
        expect(report.diagnostics.some((d: { code: string }) => d.code === "reindex.version_missing")).toBe(true);
    });

    it("does NOT modify the manifest files on disk", () => {
        writeValidAsset(tmpAssetsRoot);
        const assetJsonPath = path.join(tmpAssetsRoot, ASSET_ID, "asset.json");
        const original = fs.readFileSync(assetJsonPath, "utf-8");
        reindexAssets(tmpAssetsRoot, db);
        expect(fs.readFileSync(assetJsonPath, "utf-8")).toBe(original);
    });

    it("clears FTS on full reindex", () => {
        insertAssetsFts(db, "stale-id", "stale", "should be cleared", "stale.md");
        writeValidAsset(tmpAssetsRoot);
        reindexAssets(tmpAssetsRoot, db);
        const stale = db.prepare("SELECT asset_id FROM assets_fts WHERE assets_fts MATCH 'stale'").all();
        expect(stale).toHaveLength(0);
    });

    it("handles empty assets dir gracefully", () => {
        const report = reindexAssets(tmpAssetsRoot, db);
        expect(report.scannedAssets).toBe(0);
        expect(report.indexedAssets).toBe(0);
        expect(report.skippedAssets).toBe(0);
    });

    it("reindex specific assetIds only (no full FTS clear)", () => {
        insertAssetsFts(db, "keep-me", "keep", "should stay", "keep.md");
        writeValidAsset(tmpAssetsRoot);
        reindexAssets(tmpAssetsRoot, db, { assetIds: [ASSET_ID] });
        const keep = db.prepare("SELECT asset_id FROM assets_fts WHERE assets_fts MATCH 'keep'").all();
        expect(keep.length).toBe(1); // not cleared
    });
});

describe("reindexAssets: corrupted authority manifests", () => {
    it("rejects an empty Version history as an invalid Asset instead of inventing a current Version", () => {
        writeValidAsset(tmpAssetsRoot);
        // Corrupt the manifest: empty versionIds
        const assetJsonPath = path.join(tmpAssetsRoot, ASSET_ID, "asset.json");
        const manifest = JSON.parse(fs.readFileSync(assetJsonPath, "utf-8"));
        manifest.versionIds = [];
        fs.writeFileSync(assetJsonPath, JSON.stringify(manifest));
        const report = reindexAssets(tmpAssetsRoot, db);
        expect(report.skippedAssets).toBe(1);
        expect(report.indexedAssets).toBe(0);
        expect(report.diagnostics.some((d: { code: string }) => d.code === "reindex.asset_error")).toBe(true);
    });

    it("catches error on corrupted asset dir (diagnostic, no crash)", () => {
        // Create a dir that will cause readAssetManifest to throw (non-safe-segment name)
        // Actually we can't easily force a throw via safe dirs. Instead, corrupt the asset.json
        // to be invalid JSON which makes parseAssetManifest throw.
        const badDir = path.join(tmpAssetsRoot, ASSET_ID);
        fs.mkdirSync(badDir, { recursive: true });
        fs.writeFileSync(path.join(badDir, "asset.json"), "{invalid json");
        const report = reindexAssets(tmpAssetsRoot, db);
        expect(report.skippedAssets).toBe(1);
        expect(report.diagnostics.some((d: { code: string }) => d.code === "reindex.asset_error")).toBe(true);
    });
});

describe("reindexAssets: branch coverage", () => {
    it("handles non-existent assets root (scanAssetDirs empty)", () => {
        const report = reindexAssets("/nonexistent/path/that/does/not/exist", db);
        expect(report.scannedAssets).toBe(0);
    });

    it("catches SyntaxError from corrupt JSON and skips asset (Error.message branch)", () => {
        // This triggers JSON.parse SyntaxError (an Error subclass), exercising
        // the catch block's `err instanceof Error` true-branch. The non-Error
        // throw (String(err)) false-branch is defensive-unreachable in normal
        // operation — JSON.parse and fs.readFileSync both throw Error subclasses.
        const badDir = path.join(tmpAssetsRoot, ASSET_ID);
        fs.mkdirSync(badDir, { recursive: true });
        fs.writeFileSync(path.join(badDir, "asset.json"), "not json at all {{{");
        const report = reindexAssets(tmpAssetsRoot, db);
        expect(report.skippedAssets).toBe(1);
    });

    it("reports a non-missing Version authority failure through the outer diagnostic", () => {
        writeValidAsset(tmpAssetsRoot);
        const payloads = path.join(tmpAssetsRoot, ASSET_ID, "versions", VERSION_ID, "payloads");
        const payload = path.join(payloads, fs.readdirSync(payloads)[0]);
        fs.writeFileSync(payload, "tampered");
        const report = reindexAssets(tmpAssetsRoot, db);
        expect(report.diagnostics[0]?.code).toBe("reindex.asset_error");
    });

    it("does not turn an unsafe assets-root entry type into an empty index", () => {
        const fileRoot = path.join(tmpAssetsRoot, "not-a-directory");
        fs.writeFileSync(fileRoot, "x");
        expect(() => reindexAssets(fileRoot, db)).toThrow(/directory|entry type/i);
    });
});

describe("reindexAssets: scanAssetDirs filtering", () => {
    it("skips non-directory entries and .staging dir", () => {
        // Create a valid asset, a stray file, and a .staging dir
        writeValidAsset(tmpAssetsRoot);
        fs.writeFileSync(path.join(tmpAssetsRoot, "stray-file.txt"), "x");
        fs.mkdirSync(path.join(tmpAssetsRoot, ".staging"), { recursive: true });
        const report = reindexAssets(tmpAssetsRoot, db);
        // Only the valid asset dir should be scanned
        expect(report.scannedAssets).toBe(1);
        expect(report.indexedAssets).toBe(1);
    });
});

// ============================================================
// Addition 1: stale projection cleanup tests
// ============================================================

describe("reindexAssets: stale projection cleanup", () => {
    it("full reindex clears stale current_asset_index rows", () => {
        // Pre-seed a stale projection
        upsertCurrentAssetIndex(db, {
            assetId: "00000000-0000-4000-8000-000000000099",
            kind: "Skill",
            scope: "global",
            projectId: "",
            scopePath: "",
            displayName: "stale",
            displayDescription: "",
            currentVersionId: VERSION_ID,
            currentRevision: 1,
            currentFingerprint: `sha256:${"a".repeat(64)}`,
            currentVersionStatus: "complete",
            createdAt: 1000,
            updatedAt: 1000,
            deleted: 0,
        });
        insertAssetsFts(db, "00000000-0000-4000-8000-000000000099", "stale", "", "");
        // Full reindex on empty dir
        const report = reindexAssets(tmpAssetsRoot, db);
        const caiCount = (db.prepare("SELECT COUNT(*) as n FROM current_asset_index").get() as { n: number }).n;
        const ftsCount = (db.prepare("SELECT COUNT(*) as n FROM assets_fts").get() as { n: number }).n;
        expect(caiCount).toBe(0); // stale cai cleared
        expect(ftsCount).toBe(0); // stale fts cleared
    });

    it("partial reindex of deleted asset clears stale FTS", () => {
        writeValidAsset(tmpAssetsRoot, { deleted: true });
        // Pre-seed FTS + cai
        insertAssetsFts(db, ASSET_ID, "my-skill", "", "");
        upsertCurrentAssetIndex(db, {
            assetId: ASSET_ID,
            kind: "Skill",
            scope: "project",
            projectId: PROJECT_UUID,
            scopePath: "packages/core",
            displayName: "my-skill",
            displayDescription: "",
            currentVersionId: VERSION_ID,
            currentRevision: 1,
            currentFingerprint: `sha256:${"a".repeat(64)}`,
            currentVersionStatus: "complete",
            createdAt: 1000,
            updatedAt: 1000,
            deleted: 0,
        });
        reindexAssets(tmpAssetsRoot, db, { assetIds: [ASSET_ID] });
        const ftsCount = (
            db.prepare("SELECT COUNT(*) as n FROM assets_fts WHERE assets_fts MATCH 'skill'").get() as { n: number }
        ).n;
        const caiExists = !!db.prepare("SELECT 1 FROM current_asset_index WHERE asset_id = ?").get(ASSET_ID);
        expect(ftsCount).toBe(0); // stale FTS removed
        expect(caiExists).toBe(false); // stale cai removed
    });

    it("partial reindex of missing manifest clears stale cai + FTS", () => {
        // Pre-seed projections for an asset that has no manifest on disk
        insertAssetsFts(db, "00000000-0000-4000-8000-000000000077", "ghost", "", "");
        upsertCurrentAssetIndex(db, {
            assetId: "00000000-0000-4000-8000-000000000077",
            kind: "Skill",
            scope: "global",
            projectId: "",
            scopePath: "",
            displayName: "ghost",
            displayDescription: "",
            currentVersionId: VERSION_ID,
            currentRevision: 1,
            currentFingerprint: `sha256:${"a".repeat(64)}`,
            currentVersionStatus: "complete",
            createdAt: 1000,
            updatedAt: 1000,
            deleted: 0,
        });
        reindexAssets(tmpAssetsRoot, db, { assetIds: ["00000000-0000-4000-8000-000000000077"] });
        const ftsCount = (
            db.prepare("SELECT COUNT(*) as n FROM assets_fts WHERE assets_fts MATCH 'ghost'").get() as { n: number }
        ).n;
        const caiExists = !!db
            .prepare("SELECT 1 FROM current_asset_index WHERE asset_id = ?")
            .get("00000000-0000-4000-8000-000000000077");
        expect(ftsCount).toBe(0);
        expect(caiExists).toBe(false);
    });

    it("valid partial reindex does not clear other assets' FTS", () => {
        writeValidAsset(tmpAssetsRoot);
        // Pre-seed another asset's FTS
        insertAssetsFts(db, "00000000-0000-4000-8000-000000000088", "keep-me", "", "");
        reindexAssets(tmpAssetsRoot, db, { assetIds: [ASSET_ID] });
        const keep = db.prepare("SELECT asset_id FROM assets_fts WHERE assets_fts MATCH 'keep'").all();
        expect(keep.length).toBe(1); // other asset's FTS preserved
    });
});
