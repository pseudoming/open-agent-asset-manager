import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";
import {
    buildAndVerifyPortableAssetVersionArchive,
    inspectPortableAssetVersionArchive,
    PORTABLE_ASSET_VERSION_INDEX_PATH,
    PORTABLE_ASSET_VERSION_MANIFEST_PATH,
    PORTABLE_ASSET_VERSION_README_PATH,
    PortableAssetVersionArchiveError,
    portableAssetVersionArchiveInternalsForTest,
} from "../../src/orchestration/asset-version-archive";
import { computePortableAssetVersionArchiveIndexFingerprint, stableStringify } from "../../src/foundation/fingerprint";
import { createVersionDialectRegistry, EMPTY_VERSION_DIALECT_REGISTRY } from "../../src/catalog/version-authority";
import type { PortableAssetVersionArchiveIndexV1 } from "../../src/contracts/asset-version-archive";
import { makeDialectVersion } from "./fixtures/version-authority-test-fixtures";
import { makeAsset, makeBinaryFile, makeVersionClosure, PROJECT_ID } from "./fixtures/version-v2";
import { makeNativeDialectContract, makeRestorationDialectContract } from "../source-import/fixtures/dialect-contracts";

const EXPORTED_AT = Date.UTC(2026, 6, 25);

function dialectRegistry() {
    return createVersionDialectRegistry(
        [makeNativeDialectContract("Guidance", "fixture-native-v1")],
        [makeRestorationDialectContract("Guidance", "fixture-restoration-v1")],
        [],
        [],
    );
}

describe("portable single-Version archive", () => {
    it("round-trips one canonical/native/restoration closure through an independently readable standard ZIP", async () => {
        const { version } = makeDialectVersion();
        const built = await buildAndVerifyPortableAssetVersionArchive({
            asset: makeAsset(),
            version,
            dialectRegistry: dialectRegistry(),
            exportedAt: EXPORTED_AT,
        });
        expect(built.index).toMatchObject({
            schemaVersion: 1,
            archiveFormat: "oaam_asset_version",
            exportedAt: EXPORTED_AT,
            sourceAsset: {
                assetId: version.manifest.assetId,
                displayName: "Fixture Guidance",
                scope: "global",
            },
            version: {
                versionId: version.manifest.versionId,
                fingerprint: version.manifest.fingerprint,
                manifestPath: PORTABLE_ASSET_VERSION_MANIFEST_PATH,
            },
        });
        expect(built.index.canonicalFiles[0]?.archivePath).toBe("canonical/p~%41%47%45%4E%54%53%2Emd");
        expect(built.index.nativeRepresentations[0]?.files[0]?.archivePath).toContain(
            "native/d~666978747572652d6e61746976652d7631/",
        );

        const reader = new ZipReader(new Uint8ArrayReader(built.bytes), { useWebWorkers: false, strictness: "strict" });
        const entries = await reader.getEntries({ strictness: "strict" });
        await reader.close();
        expect(entries.map((entry) => entry.filename).sort()).toEqual(
            [
                PORTABLE_ASSET_VERSION_INDEX_PATH,
                PORTABLE_ASSET_VERSION_MANIFEST_PATH,
                PORTABLE_ASSET_VERSION_README_PATH,
                ...built.index.canonicalFiles.map((file) => file.archivePath),
                ...built.index.nativeRepresentations.flatMap((native) => native.files.map((file) => file.archivePath)),
                ...built.index.restorationPayloads.map((payload) => payload.archivePath),
            ].sort(),
        );

        const reopened = await inspectPortableAssetVersionArchive(built.bytes, dialectRegistry());
        expect(reopened.index).toEqual(built.index);
        expect(reopened.version.manifest).toEqual(version.manifest);
        expect(reopened.version.files).toEqual(version.files);
        expect(Buffer.from(reopened.version.nativePayloads[0]!.files[0]!.bytes)).toEqual(
            Buffer.from(version.nativePayloads[0]!.files[0]!.bytes),
        );
        expect(Buffer.from(reopened.version.restorationPayloads[0]!.bytes)).toEqual(
            Buffer.from(version.restorationPayloads[0]!.bytes),
        );
    });

    it("rejects invalid source authority before creating an archive", async () => {
        const version = makeVersionClosure();
        await expect(
            buildAndVerifyPortableAssetVersionArchive({
                asset: makeAsset(),
                version,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                exportedAt: -1,
            }),
        ).rejects.toMatchObject({ code: "asset_export.exported_at_invalid" });

        await expect(
            buildAndVerifyPortableAssetVersionArchive({
                asset: makeAsset([], { displayName: "" }),
                version,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                exportedAt: EXPORTED_AT,
            }),
        ).rejects.toThrow(/displayName/u);

        await expect(
            buildAndVerifyPortableAssetVersionArchive({
                asset: makeAsset([], { versionIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"] }),
                version,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                exportedAt: EXPORTED_AT,
            }),
        ).rejects.toMatchObject({ code: "asset_export.source_mismatch" });

        const invalidVersion = makeVersionClosure();
        invalidVersion.manifest.fingerprint = `sha256:${"f".repeat(64)}`;
        await expect(
            buildAndVerifyPortableAssetVersionArchive({
                asset: makeAsset(),
                version: invalidVersion,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                exportedAt: EXPORTED_AT,
            }),
        ).rejects.toThrow(/fingerprint/u);
    });

    it("preserves binary canonical content and project placement without making placement an import grant", async () => {
        const version = makeVersionClosure({ files: [makeBinaryFile()] });
        const asset = makeAsset([version.manifest.versionId], {
            scope: "project",
            projectId: PROJECT_ID,
            scopePath: "packages/app",
        });
        const built = await buildAndVerifyPortableAssetVersionArchive({
            asset,
            version,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            exportedAt: 0,
        });
        const reopened = await inspectPortableAssetVersionArchive(built.bytes, EMPTY_VERSION_DIALECT_REGISTRY);
        expect(reopened.index.sourceAsset).toMatchObject({
            scope: "project",
            projectId: PROJECT_ID,
            scopePath: "packages/app",
        });
        expect(reopened.version.files[0]).toMatchObject({ contentKind: "binary" });
        expect(Buffer.from((reopened.version.files[0] as { bytes: Uint8Array }).bytes)).toEqual(Buffer.from([1, 2, 3]));
    });

    it("rejects modified index identity, fingerprint, inventory, and payload bytes", async () => {
        const version = makeVersionClosure();
        const built = await buildAndVerifyPortableAssetVersionArchive({
            asset: makeAsset(),
            version,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            exportedAt: EXPORTED_AT,
        });

        const fingerprintTamper = await rewriteArchive(built.bytes, (entries) => {
            const index = parseIndex(entries);
            index.exportedAt += 1;
            entries.set(PORTABLE_ASSET_VERSION_INDEX_PATH, jsonBytes(index));
        });
        await expect(inspectPortableAssetVersionArchive(fingerprintTamper, EMPTY_VERSION_DIALECT_REGISTRY)).rejects.toMatchObject(
            {
                code: "asset_export.index_fingerprint_mismatch",
            },
        );

        const identityTamper = await rewriteArchive(built.bytes, (entries) => {
            const index = parseIndex(entries);
            index.version.versionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
            replaceIndex(entries, index);
        });
        await expect(inspectPortableAssetVersionArchive(identityTamper, EMPTY_VERSION_DIALECT_REGISTRY)).rejects.toMatchObject({
            code: "asset_export.identity_mismatch",
        });

        const graphTamper = await rewriteArchive(built.bytes, (entries) => {
            const index = parseIndex(entries);
            index.canonicalFiles[0]!.archivePath = "canonical/p~other";
            replaceIndex(entries, index);
        });
        await expect(inspectPortableAssetVersionArchive(graphTamper, EMPTY_VERSION_DIALECT_REGISTRY)).rejects.toMatchObject({
            code: "asset_export.index_mismatch",
        });

        const unexpected = await rewriteArchive(built.bytes, (entries) => {
            entries.set("unexpected.txt", new TextEncoder().encode("unexpected"));
        });
        await expect(inspectPortableAssetVersionArchive(unexpected, EMPTY_VERSION_DIALECT_REGISTRY)).rejects.toMatchObject({
            code: "asset_export.inventory_mismatch",
        });

        const payloadTamper = await rewriteArchive(built.bytes, (entries) => {
            entries.set(built.index.canonicalFiles[0]!.archivePath, new TextEncoder().encode("xxxxxxxxxxx"));
        });
        await expect(inspectPortableAssetVersionArchive(payloadTamper, EMPTY_VERSION_DIALECT_REGISTRY)).rejects.toMatchObject({
            code: "asset_export.body_mismatch",
        });
    });

    it("rejects malformed and unsafe standard ZIP structures before treating them as import material", async () => {
        const version = makeVersionClosure();
        const built = await buildAndVerifyPortableAssetVersionArchive({
            asset: makeAsset(),
            version,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            exportedAt: EXPORTED_AT,
        });

        const missingIndex = await rewriteArchive(built.bytes, (entries) => {
            entries.delete(PORTABLE_ASSET_VERSION_INDEX_PATH);
        });
        await expect(inspectPortableAssetVersionArchive(missingIndex, EMPTY_VERSION_DIALECT_REGISTRY)).rejects.toMatchObject({
            code: "asset_export.inventory_mismatch",
        });

        const invalidJson = await rewriteArchive(built.bytes, (entries) => {
            entries.set(PORTABLE_ASSET_VERSION_INDEX_PATH, new TextEncoder().encode("{"));
        });
        await expect(inspectPortableAssetVersionArchive(invalidJson, EMPTY_VERSION_DIALECT_REGISTRY)).rejects.toMatchObject({
            code: "asset_export.index_invalid",
        });

        const extraField = await rewriteArchive(built.bytes, (entries) => {
            const index = { ...parseIndex(entries), extra: true };
            entries.set(PORTABLE_ASSET_VERSION_INDEX_PATH, jsonBytes(index));
        });
        await expect(inspectPortableAssetVersionArchive(extraField, EMPTY_VERSION_DIALECT_REGISTRY)).rejects.toMatchObject({
            code: "asset_export.index_invalid",
        });

        const invalidPlacement = await rewriteArchive(built.bytes, (entries) => {
            const index = parseIndex(entries);
            index.sourceAsset.projectId = "not-empty";
            replaceIndex(entries, index);
        });
        await expect(inspectPortableAssetVersionArchive(invalidPlacement, EMPTY_VERSION_DIALECT_REGISTRY)).rejects.toMatchObject({
            code: "asset_export.index_invalid",
        });

        expect(() => portableAssetVersionArchiveInternalsForTest.assertPortableArchivePaths(["../escape"])).toThrow(/unsafe/u);
        expect(() => portableAssetVersionArchiveInternalsForTest.assertPortableArchivePaths(["A", "a"])).toThrow(/collide/u);
        expect(portableAssetVersionArchiveInternalsForTest.encodeArchiveSegment("A.txt")).toBe("p~%41%2Etxt");
        expect(() => portableAssetVersionArchiveInternalsForTest.parseArchiveIndex(new Uint8Array([0xff]))).toThrow(/UTF-8/u);
    });

    it("normalizes non-archive failures and preserves the original incomplete-writer error", async () => {
        await expect(
            inspectPortableAssetVersionArchive(new Uint8Array([1, 2, 3]), EMPTY_VERSION_DIALECT_REGISTRY),
        ).rejects.toMatchObject({ code: "asset_export.archive_invalid" });
        await expect(
            portableAssetVersionArchiveInternalsForTest.closeIncompleteZip({
                close: async () => {
                    throw new Error("close failed");
                },
            }),
        ).resolves.toBeUndefined();
    });

    it("enforces bounded metadata, portable paths, and writer cleanup across each hostile branch", async () => {
        const mockEntry = (overrides: Record<string, unknown> = {}) =>
            ({
                filename: "entry",
                directory: false,
                encrypted: false,
                uncompressedSize: 0,
                getData: async () => new Uint8Array(),
                ...overrides,
            }) as never;

        expect(() => portableAssetVersionArchiveInternalsForTest.validateArchiveEntryMetadata([])).toThrow(/entry count/u);
        expect(() =>
            portableAssetVersionArchiveInternalsForTest.validateArchiveEntryMetadata(new Array(100_004).fill(mockEntry())),
        ).toThrow(/entry count/u);
        expect(() =>
            portableAssetVersionArchiveInternalsForTest.validateArchiveEntryMetadata([
                mockEntry({ filename: "A" }),
                mockEntry({ filename: "a" }),
                mockEntry({ filename: "b" }),
            ]),
        ).toThrow(/colliding/u);
        for (const overrides of [
            { directory: true },
            { encrypted: true },
            { unixMode: 0xa000 },
            { uncompressedSize: Number.NaN },
            { uncompressedSize: -1 },
        ]) {
            expect(() =>
                portableAssetVersionArchiveInternalsForTest.validateArchiveEntryMetadata([
                    mockEntry({ filename: "a", ...overrides }),
                    mockEntry({ filename: "b" }),
                    mockEntry({ filename: "c" }),
                ]),
            ).toThrow(/unsupported/u);
        }
        expect(() =>
            portableAssetVersionArchiveInternalsForTest.validateArchiveEntryMetadata([
                mockEntry({ filename: "a", unixMode: 0x8000, uncompressedSize: 6_000_000_000 }),
                mockEntry({ filename: "b", uncompressedSize: 6_000_000_000 }),
                mockEntry({ filename: "c", uncompressedSize: 6_000_000_000 }),
            ]),
        ).toThrow(/uncompressed size/u);

        for (const unsafe of ["", "/x", "x/", "x\\y", "x\0y", "x//y", "x/./y", "x/../y"]) {
            expect(() => portableAssetVersionArchiveInternalsForTest.assertPortableArchivePaths([unsafe])).toThrow(/unsafe/u);
        }
        expect(() =>
            portableAssetVersionArchiveInternalsForTest.assertArchiveSizeBoundary(
                new Array(100_004).fill({ archivePath: "safe", bytes: new Uint8Array() }) as never,
            ),
        ).toThrow(/too many/u);
        expect(() =>
            portableAssetVersionArchiveInternalsForTest.assertArchiveSizeBoundary([
                {
                    archivePath: "safe",
                    bytes: { byteLength: 18_000_000_000 } as Uint8Array,
                },
            ]),
        ).toThrow(/exceeds/u);

        await expect(
            portableAssetVersionArchiveInternalsForTest.extractBoundedEntry(mockEntry({ uncompressedSize: 2 }), 1),
        ).rejects.toThrow(/exceeds/u);
        await expect(
            portableAssetVersionArchiveInternalsForTest.extractBoundedEntry(
                mockEntry({ uncompressedSize: 1, getData: async () => new Uint8Array(2) }),
                1,
            ),
        ).rejects.toThrow(/expanded/u);

        let cleanupCalls = 0;
        await expect(
            portableAssetVersionArchiveInternalsForTest.writePortableArchiveEntries(
                [{ archivePath: "safe", bytes: new Uint8Array() }],
                EXPORTED_AT,
                () => ({
                    add: async () => {
                        throw new Error("writer failed");
                    },
                    close: async () => {
                        cleanupCalls += 1;
                        return new Uint8Array();
                    },
                }),
            ),
        ).rejects.toMatchObject({ code: "asset_export.archive_failed" });
        expect(cleanupCalls).toBe(1);

        await expect(
            portableAssetVersionArchiveInternalsForTest.writePortableArchiveEntries(
                [{ archivePath: "safe", bytes: new Uint8Array() }],
                EXPORTED_AT,
                () => ({
                    add: async () => {
                        throw new PortableAssetVersionArchiveError("fixture", "fixture");
                    },
                    close: async () => new Uint8Array(),
                }),
            ),
        ).rejects.toMatchObject({ code: "fixture" });
    });
});

function parseIndex(entries: Map<string, Uint8Array>): PortableAssetVersionArchiveIndexV1 {
    return JSON.parse(
        new TextDecoder().decode(entries.get(PORTABLE_ASSET_VERSION_INDEX_PATH)),
    ) as PortableAssetVersionArchiveIndexV1;
}

function replaceIndex(entries: Map<string, Uint8Array>, index: PortableAssetVersionArchiveIndexV1): void {
    const { indexFingerprint: _stored, ...preimage } = index;
    entries.set(
        PORTABLE_ASSET_VERSION_INDEX_PATH,
        jsonBytes({
            ...preimage,
            indexFingerprint: computePortableAssetVersionArchiveIndexFingerprint(preimage),
        }),
    );
}

function jsonBytes(value: unknown): Uint8Array {
    return new TextEncoder().encode(`${stableStringify(value)}\n`);
}

async function rewriteArchive(source: Uint8Array, mutate: (entries: Map<string, Uint8Array>) => void): Promise<Uint8Array> {
    const reader = new ZipReader(new Uint8ArrayReader(source), { useWebWorkers: false, strictness: "strict" });
    const sourceEntries = await reader.getEntries({ strictness: "strict" });
    const entries = new Map<string, Uint8Array>();
    for (const entry of sourceEntries) {
        if (!entry.directory && "getData" in entry) {
            entries.set(
                entry.filename,
                await entry.getData(new Uint8ArrayWriter(), { useWebWorkers: false, strictness: "strict" }),
            );
        }
    }
    await reader.close();
    mutate(entries);

    const output = new Uint8ArrayWriter();
    const writer = new ZipWriter(output, { useWebWorkers: false });
    for (const [filename, bytes] of entries) {
        await writer.add(filename, new Uint8ArrayReader(bytes), { level: 0, lastModDate: new Date(EXPORTED_AT) });
    }
    return writer.close();
}
