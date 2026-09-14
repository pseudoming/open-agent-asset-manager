import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAssetVersionManifest } from "../../src/catalog/asset-library-authority";
import {
    EMPTY_VERSION_DIALECT_REGISTRY,
    publishAssetVersion,
    publishInitialAssetVersion,
} from "../../src/catalog/version-authority";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import { createCoreAssetLibraryService } from "../../src/orchestration/core-asset-library-service";
import { inspectPortableAssetVersionArchive } from "../../src/orchestration/asset-version-archive";
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

let root = "";
let assetsRoot = "";
let db: Database.Database;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-asset-library-workflows-"));
    assetsRoot = path.join(root, "assets");
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(fs.readFileSync(SCHEMA_PATH, "utf-8"));
});

afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
});

function service() {
    return createCoreAssetLibraryService({
        assetsRoot,
        db,
        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        catalogGeneration: () => 0,
        cursorInstanceId: "asset-library-workflows",
        now: () => 1_000,
    });
}

function uuid(index: number): UuidV4 {
    return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function withFileId(
    file: AssetVersionFileContentV2,
    fileId: UuidV4,
    role: AssetVersionFileContentV2["file"]["role"] = file.file.role,
): AssetVersionFileContentV2 {
    return { ...file, file: { ...file.file, fileId, role } } as AssetVersionFileContentV2;
}

function publishRichVersionHistory(): void {
    const initial = makeVersionClosure({
        files: [
            withFileId(makeBinaryFile(new Uint8Array([0, 1, 2]), "blob.bin"), uuid(201)),
            withFileId(makeTextFile("alpha\n", "docs/alpha.md"), uuid(202), "resource"),
            withFileId(makeTextFile("x".repeat(2 * 1_024 * 1_024 + 1), "huge.md"), uuid(204), "resource"),
            withFileId(makeTextFile("root\n", "root.md"), uuid(206)),
        ],
    });
    publishInitialAssetVersion({
        assetsRoot,
        transactionId: "library-workflows-initial",
        asset: makeAsset([VERSION_ID], {
            displayName: "Library Workflow Fixture",
            displayDescription: "progressive and export workflows",
        }),
        version: initial,
        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
    });
    publishAssetVersion({
        assetsRoot,
        transactionId: "library-workflows-next",
        version: makeVersionClosure({
            versionId: VERSION_ID_2,
            revision: 2,
            sourceVersionId: VERSION_ID,
            changeKind: "edit",
            files: [withFileId(makeTextFile("second\n", "AGENTS.md"), uuid(207))],
            createdAt: 200,
        }),
        dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
    });
}

describe("bounded Asset library workflows", () => {
    it("progressively reads a large canonical text payload with exact byte and line ranges", () => {
        publishRichVersionHistory();
        const library = service();
        const pages = [];
        let cursor: string | undefined;
        do {
            const result = library.readAssetVersionTextPage({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                logicalPath: "huge.md",
                ...(cursor === undefined ? {} : { cursor }),
            });
            expect(result.status).toBe("complete");
            if (!result.value.found) throw new Error("fixture text payload is missing");
            pages.push(result.value.value);
            cursor = result.value.value.hasMore ? result.value.value.nextCursor : undefined;
        } while (cursor !== undefined);

        expect(pages).toHaveLength(9);
        expect(pages[0]).toMatchObject({
            loadedByteStart: 0,
            loadedByteEnd: 256 * 1024,
            totalBytes: 2 * 1024 * 1024 + 1,
            firstLine: 1,
            lastLine: 1,
            totalLines: 1,
            hasMore: true,
        });
        expect(pages.at(-1)).toMatchObject({
            loadedByteStart: 2 * 1024 * 1024,
            loadedByteEnd: 2 * 1024 * 1024 + 1,
            hasMore: false,
        });
        expect(pages.map((page) => page.text).join("")).toBe("x".repeat(2 * 1024 * 1024 + 1));

        const invalidCursor = (pages[0] as Extract<(typeof pages)[number], { hasMore: true }>).nextCursor;
        expect(
            library.readAssetVersionTextPage({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                logicalPath: "blob.bin",
                cursor: invalidCursor,
            }).status,
        ).toBe("failed");

        const invalidOffsetDocument = JSON.parse(Buffer.from(invalidCursor, "base64url").toString("utf-8")) as Record<
            string,
            unknown
        >;
        invalidOffsetDocument.nextByteOffset = 0;
        expect(
            library.readAssetVersionTextPage({
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                logicalPath: "huge.md",
                cursor: Buffer.from(JSON.stringify(invalidOffsetDocument), "utf-8").toString("base64url"),
            }).status,
        ).toBe("failed");
    });

    it("returns a complete cancellable Version file graph and selected text diff", async () => {
        publishRichVersionHistory();
        const library = service();
        const left = readAssetVersionManifest(assetsRoot, ASSET_ID as UuidV4, VERSION_ID as UuidV4)!;
        const right = readAssetVersionManifest(assetsRoot, ASSET_ID as UuidV4, VERSION_ID_2 as UuidV4)!;
        const progress: Array<{ stage: string; completedUnits: number; totalUnits: number }> = [];
        const result = await library.compareAssetVersions(
            {
                assetId: ASSET_ID as UuidV4,
                left: { versionId: VERSION_ID as UuidV4, versionFingerprint: left.fingerprint },
                right: { versionId: VERSION_ID_2 as UuidV4, versionFingerprint: right.fingerprint },
                logicalPath: "docs/alpha.md",
            },
            {
                report(value) {
                    progress.push(value);
                },
                isCancellationRequested() {
                    return false;
                },
            },
        );

        expect(result.status).toBe("complete");
        expect(result.value.files.find((file) => file.logicalPath === "docs/alpha.md")?.changeKind).toBe("removed");
        expect(result.value.files.find((file) => file.logicalPath === "AGENTS.md")?.changeKind).toBe("added");
        expect(result.value.selectedFile).toMatchObject({
            comparisonKind: "text",
            logicalPath: "docs/alpha.md",
            leftLineCount: 2,
            rightLineCount: 0,
            hunks: [
                {
                    leftStart: 1,
                    rightStart: 1,
                    lines: [
                        { lineKind: "remove", text: "alpha", leftLine: 1 },
                        { lineKind: "remove", text: "", leftLine: 2 },
                    ],
                },
            ],
        });
        expect(progress.at(-1)).toMatchObject({ stage: "diffing", completedUnits: 3, totalUnits: 3 });

        await expect(
            library.compareAssetVersions(
                {
                    assetId: ASSET_ID as UuidV4,
                    left: { versionId: VERSION_ID as UuidV4, versionFingerprint: left.fingerprint },
                    right: { versionId: VERSION_ID_2 as UuidV4, versionFingerprint: right.fingerprint },
                },
                { report() {}, isCancellationRequested: () => true },
            ),
        ).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ code: "asset_compare.cancelled" }],
        });
    });

    it("exports one exact immutable Version to a new standard ZIP without overwriting an existing file", async () => {
        publishRichVersionHistory();
        const manifest = readAssetVersionManifest(assetsRoot, ASSET_ID as UuidV4, VERSION_ID as UuidV4);
        if (manifest === null) throw new Error("export fixture Version is required");
        const destinationPath = path.join(root, "fixture-export.zip");
        const input = {
            source: {
                assetId: ASSET_ID as UuidV4,
                versionId: VERSION_ID as UuidV4,
                versionFingerprint: manifest.fingerprint,
                originAuthorityFingerprint: manifest.originAuthority.authorityFingerprint,
            },
            destinationPath,
            userActionEvidenceId: "desktop-save-dialog",
        };

        const exported = await service().exportAssetVersionToFile(input);

        expect(exported).toMatchObject({
            status: "complete",
            value: {
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                versionFingerprint: manifest.fingerprint,
            },
        });
        expect(exported.value.archiveByteLength).toBe(fs.statSync(destinationPath).size);
        await expect(
            inspectPortableAssetVersionArchive(fs.readFileSync(destinationPath), EMPTY_VERSION_DIALECT_REGISTRY),
        ).resolves.toMatchObject({
            version: { manifest: { assetId: ASSET_ID, versionId: VERSION_ID } },
        });
        await expect(service().exportAssetVersionToFile(input)).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ code: "asset_export.failed" }],
        });
        await expect(
            service().exportAssetVersionToFile({
                ...input,
                destinationPath: path.join(root, "stale.zip"),
                source: { ...input.source, originAuthorityFingerprint: sha256Bytes("stale") },
            }),
        ).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: expect.stringContaining("changed before export") }],
        });
        await expect(
            service().exportAssetVersionNativeFilesToFile({
                ...input,
                destinationPath: path.join(root, "native.zip"),
            }),
        ).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ code: "asset_native_export.failed", message: expect.stringContaining("exactly one") }],
        });
    });
});
