import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    createVersionDialectRegistry,
    EMPTY_VERSION_DIALECT_REGISTRY,
    publishInitialAssetVersion,
    type VersionAuthorityClosureV1,
} from "../../src/catalog/version-authority";
import type { VersionNativeRepresentationV1, VersionNativeRepresentationV2 } from "../../src/contracts/persistence";
import { computeVersionFingerprint, computeVersionNativeRepresentationFingerprint } from "../../src/foundation/fingerprint";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import {
    buildAndVerifyNativeAssetVersionArchive,
    NativeAssetVersionArchiveError,
    nativeAssetVersionArchiveInternalsForTest,
} from "../../src/orchestration/asset-version-native-archive";
import { exportAssetVersionNativeFilesToFile } from "../../src/orchestration/asset-version-export-service";
import type { ExportAssetVersionNativeFilesToFileInputV1, PosixRelativePath, UuidV4 } from "../../src/types";
import {
    makeNativeDialectContract,
    makeRestorationDialectContract,
    nativeDialectFingerprint,
} from "../source-import/fixtures/dialect-contracts";
import { makeDialectVersion } from "./fixtures/version-authority-test-fixtures";
import { ASSET_ID, makeAsset, makeVersionClosure, VERSION_ID } from "./fixtures/version-v2";

let root = "";
let assetsRoot = "";

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-native-version-export-"));
    assetsRoot = path.join(root, "assets");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function registry(dialects: readonly string[] = ["fixture-native-v1"]) {
    return createVersionDialectRegistry(
        dialects.map((dialectId) => makeNativeDialectContract("Guidance", dialectId)),
        [makeRestorationDialectContract("Guidance", "fixture-restoration-v1")],
        [],
        [],
    );
}

function exactInput(version: VersionAuthorityClosureV1, destinationPath = path.join(root, "native.zip")) {
    return {
        source: {
            assetId: ASSET_ID as UuidV4,
            versionId: VERSION_ID as UuidV4,
            versionFingerprint: version.manifest.fingerprint,
            originAuthorityFingerprint: version.manifest.originAuthority.authorityFingerprint,
        },
        destinationPath,
        userActionEvidenceId: "desktop-native-export",
    } satisfies ExportAssetVersionNativeFilesToFileInputV1;
}

function createOnly(filePath: string, bytes: Uint8Array): void {
    fs.writeFileSync(filePath, bytes, { flag: "wx" });
}

function setNativePath(version: VersionAuthorityClosureV1, relativePath: string, executable = false): void {
    const representation = version.manifest.nativeRepresentations[0] as VersionNativeRepresentationV1;
    const payload = version.nativePayloads[0] as VersionAuthorityClosureV1["nativePayloads"][number];
    const preimage: Omit<VersionNativeRepresentationV1, "representationFingerprint"> = {
        ...representation,
        files: representation.files.map((file) => ({
            ...file,
            relativePath: relativePath as PosixRelativePath,
            executable,
        })),
    };
    version.manifest.nativeRepresentations = [
        { ...preimage, representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage) },
    ];
    version.nativePayloads = [
        {
            ...payload,
            files: payload.files.map((file) => ({ ...file, relativePath: relativePath as PosixRelativePath })),
        },
    ];
    version.manifest.fingerprint = computeVersionFingerprint(
        version.manifest.versionCanonicalContentFingerprint,
        version.manifest.nativeRepresentations,
        version.manifest.dialectRestorationPayloads,
        version.manifest.portableDialectContracts,
    );
}

describe("Asset Version original-file export", () => {
    it("emits explicit ZIP directory entries for a V2 empty-directory graph", async () => {
        const { version } = makeDialectVersion();
        setNativePath(version, "bundle/entry.md");
        const legacy = version.manifest.nativeRepresentations[0] as VersionNativeRepresentationV1;
        const preimage: Omit<VersionNativeRepresentationV2, "representationFingerprint"> = {
            ...legacy,
            schemaVersion: 2,
            directories: ["bundle", "bundle/empty"] as PosixRelativePath[],
        };
        version.manifest.nativeRepresentations = [
            { ...preimage, representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage) },
        ];
        version.manifest.fingerprint = computeVersionFingerprint(
            version.manifest.versionCanonicalContentFingerprint,
            version.manifest.nativeRepresentations,
            version.manifest.dialectRestorationPayloads,
            version.manifest.portableDialectContracts,
        );

        const archive = await buildAndVerifyNativeAssetVersionArchive({
            representation: version.manifest.nativeRepresentations[0]!,
            payload: version.nativePayloads[0]!,
            exportedAt: 1_000,
        });
        const reader = new ZipReader(new Uint8ArrayReader(archive.bytes), { useWebWorkers: false, strictness: "strict" });
        const entries = await reader.getEntries({ strictness: "strict" });
        await reader.close();
        expect(entries.map((entry) => [entry.filename, entry.directory])).toEqual([
            ["bundle/", true],
            ["bundle/empty/", true],
            ["bundle/entry.md", false],
        ]);
        expect(archive.fileCount).toBe(1);
    });

    it("writes only the exact native graph at ZIP root and preserves executable mode", async () => {
        const { version, nativeBytes } = makeDialectVersion();
        setNativePath(version, ".agents/workflows/git-squash-helper.md", true);
        const dialectRegistry = registry();
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "native-export",
            asset: makeAsset([VERSION_ID]),
            version,
            dialectRegistry,
        });

        const result = await exportAssetVersionNativeFilesToFile(
            assetsRoot,
            dialectRegistry,
            () => 1_000,
            createOnly,
            exactInput(version),
        );

        expect(result).toMatchObject({
            status: "complete",
            value: {
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                dialectId: "fixture-native-v1",
                representationFingerprint: version.manifest.nativeRepresentations[0]?.representationFingerprint,
                fileCount: 1,
            },
        });
        const reader = new ZipReader(new Uint8ArrayReader(fs.readFileSync(path.join(root, "native.zip"))), {
            useWebWorkers: false,
            strictness: "strict",
        });
        const entries = await reader.getEntries({ strictness: "strict" });
        expect(entries.map((entry) => entry.filename)).toEqual([".agents/workflows/git-squash-helper.md"]);
        expect(entries[0]?.unixMode).toBe(0o100755);
        expect(await entries[0]?.getData?.(new Uint8ArrayWriter(), { useWebWorkers: false, strictness: "strict" })).toEqual(
            new Uint8Array(nativeBytes),
        );
        await reader.close();
        await expect(
            exportAssetVersionNativeFilesToFile(assetsRoot, dialectRegistry, () => 1_000, createOnly, exactInput(version)),
        ).resolves.toMatchObject({ status: "failed", diagnostics: [{ code: "asset_native_export.failed" }] });
        await expect(
            exportAssetVersionNativeFilesToFile(
                assetsRoot,
                dialectRegistry,
                () => 1_000,
                () => {
                    throw "non-error native export failure";
                },
                exactInput(version, path.join(root, "other.zip")),
            ),
        ).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ rawSummary: "non-error native export failure" }],
        });
    });

    it("rejects stale source authority, missing native material, and ambiguous native dialects", async () => {
        const noNative = makeVersionClosure();
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "native-export-none",
            asset: makeAsset([VERSION_ID]),
            version: noNative,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        await expect(
            exportAssetVersionNativeFilesToFile(
                assetsRoot,
                EMPTY_VERSION_DIALECT_REGISTRY,
                () => 1_000,
                createOnly,
                exactInput(noNative),
            ),
        ).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: expect.stringContaining("exactly one") }],
        });

        fs.rmSync(assetsRoot, { recursive: true, force: true });
        const { version } = makeDialectVersion();
        const first = version.manifest.nativeRepresentations[0] as VersionNativeRepresentationV1;
        const firstPayload = version.nativePayloads[0] as VersionAuthorityClosureV1["nativePayloads"][number];
        const secondPreimage: Omit<VersionNativeRepresentationV1, "representationFingerprint"> = {
            ...first,
            dialectId: "fixture-native-v2",
            dialectContractFingerprint: nativeDialectFingerprint("Guidance", "fixture-native-v2"),
            files: first.files.map((file) => ({ ...file, relativePath: "second.md" as PosixRelativePath })),
        };
        const second = {
            ...secondPreimage,
            representationFingerprint: computeVersionNativeRepresentationFingerprint(secondPreimage),
        };
        version.manifest.nativeRepresentations = [first, second];
        version.nativePayloads = [
            firstPayload,
            {
                dialectId: "fixture-native-v2",
                files: firstPayload.files.map((file) => ({ ...file, relativePath: "second.md" as PosixRelativePath })),
            },
        ];
        version.manifest.fingerprint = computeVersionFingerprint(
            version.manifest.versionCanonicalContentFingerprint,
            version.manifest.nativeRepresentations,
            version.manifest.dialectRestorationPayloads,
            version.manifest.portableDialectContracts,
        );
        const dialectRegistry = registry(["fixture-native-v1", "fixture-native-v2"]);
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "native-export-ambiguous",
            asset: makeAsset([VERSION_ID]),
            version,
            dialectRegistry,
        });
        await expect(
            exportAssetVersionNativeFilesToFile(assetsRoot, dialectRegistry, () => 1_000, createOnly, exactInput(version)),
        ).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: expect.stringContaining("exactly one") }],
        });
        await expect(
            exportAssetVersionNativeFilesToFile(assetsRoot, dialectRegistry, () => 1_000, createOnly, {
                ...exactInput(version, path.join(root, "stale.zip")),
                source: { ...exactInput(version).source, versionFingerprint: sha256Bytes("stale") },
            }),
        ).resolves.toMatchObject({
            status: "failed",
            diagnostics: [{ message: expect.stringContaining("changed before export") }],
        });
    });

    it("rejects traversal, Windows-incompatible names, case collisions, and descriptor/payload drift", async () => {
        const { version } = makeDialectVersion();
        const representation = version.manifest.nativeRepresentations[0] as VersionNativeRepresentationV1;
        const payload = version.nativePayloads[0] as VersionAuthorityClosureV1["nativePayloads"][number];
        for (const relativePath of ["../escape.md", "CON.md", "trailing. "]) {
            await expect(
                buildAndVerifyNativeAssetVersionArchive({
                    representation: {
                        ...representation,
                        files: representation.files.map((file) => ({
                            ...file,
                            relativePath: relativePath as PosixRelativePath,
                        })),
                    },
                    payload: {
                        ...payload,
                        files: payload.files.map((file) => ({ ...file, relativePath: relativePath as PosixRelativePath })),
                    },
                    exportedAt: 1_000,
                }),
            ).rejects.toThrow();
        }

        const sourceFile = representation.files[0] as (typeof representation.files)[number];
        const sourcePayload = payload.files[0] as (typeof payload.files)[number];
        await expect(
            buildAndVerifyNativeAssetVersionArchive({
                representation: {
                    ...representation,
                    files: [
                        { ...sourceFile, relativePath: "A.md" as PosixRelativePath },
                        { ...sourceFile, relativePath: "a.md" as PosixRelativePath },
                    ],
                },
                payload: {
                    ...payload,
                    files: [
                        { ...sourcePayload, relativePath: "A.md" as PosixRelativePath },
                        { ...sourcePayload, relativePath: "a.md" as PosixRelativePath },
                    ],
                },
                exportedAt: 1_000,
            }),
        ).rejects.toThrow(/collide/u);
        await expect(
            buildAndVerifyNativeAssetVersionArchive({
                representation,
                payload: {
                    ...payload,
                    files: payload.files.map((file) => ({ ...file, bytes: new Uint8Array([1]) })),
                },
                exportedAt: 1_000,
            }),
        ).rejects.toThrow(/differs/u);
    });

    it("rejects invalid archive identity, inventory, portable-path aliases, and file/directory collisions", async () => {
        const { version } = makeDialectVersion();
        const representation = version.manifest.nativeRepresentations[0] as VersionNativeRepresentationV1;
        const payload = version.nativePayloads[0] as VersionAuthorityClosureV1["nativePayloads"][number];
        const sourceFile = representation.files[0] as (typeof representation.files)[number];
        const sourcePayload = payload.files[0] as (typeof payload.files)[number];
        await expect(
            buildAndVerifyNativeAssetVersionArchive({
                representation: {
                    ...representation,
                    files: [
                        { ...sourceFile, relativePath: "b.md" as PosixRelativePath },
                        { ...sourceFile, relativePath: "a.md" as PosixRelativePath },
                    ],
                },
                payload: {
                    ...payload,
                    files: [
                        { ...sourcePayload, relativePath: "b.md" as PosixRelativePath },
                        { ...sourcePayload, relativePath: "a.md" as PosixRelativePath },
                    ],
                },
                exportedAt: 1_000,
            }),
        ).resolves.toMatchObject({ fileCount: 2 });
        await expect(buildAndVerifyNativeAssetVersionArchive({ representation, payload, exportedAt: -1 })).rejects.toMatchObject({
            code: "asset_native_export.exported_at_invalid",
        });
        await expect(
            buildAndVerifyNativeAssetVersionArchive({
                representation,
                payload: { ...payload, dialectId: "other" },
                exportedAt: 1_000,
            }),
        ).rejects.toMatchObject({ code: "asset_native_export.dialect_mismatch" });
        await expect(
            buildAndVerifyNativeAssetVersionArchive({
                representation,
                payload: { ...payload, files: [] },
                exportedAt: 1_000,
            }),
        ).rejects.toMatchObject({ code: "asset_native_export.payload_mismatch" });
        await expect(
            buildAndVerifyNativeAssetVersionArchive({
                representation,
                payload: {
                    ...payload,
                    files: [
                        ...payload.files,
                        {
                            ...(payload.files[0] as (typeof payload.files)[number]),
                            relativePath: "extra.md" as PosixRelativePath,
                        },
                    ],
                },
                exportedAt: 1_000,
            }),
        ).rejects.toMatchObject({ code: "asset_native_export.payload_mismatch" });

        const entry = {
            relativePath: "asset.md",
            bytes: new Uint8Array(),
            contentHash: sha256Bytes(new Uint8Array()),
            executable: false,
        };
        expect(() => nativeAssetVersionArchiveInternalsForTest.validateNativeArchiveEntries([])).toThrow(/file count/u);
        expect(() =>
            nativeAssetVersionArchiveInternalsForTest.validateNativeArchiveEntries(new Array(100_001).fill(entry)),
        ).toThrow(/file count/u);
        for (const relativePath of [
            "",
            "/root",
            "folder/",
            "folder//file",
            "folder/./file",
            "folder/../file",
            "name?.md",
            "name\u001f.md",
            "name. ",
        ]) {
            expect(() =>
                nativeAssetVersionArchiveInternalsForTest.validateNativeArchiveEntries([{ ...entry, relativePath }] as never),
            ).toThrow();
        }
        expect(() =>
            nativeAssetVersionArchiveInternalsForTest.validateNativeArchiveEntries([
                { ...entry, relativePath: "a" },
                { ...entry, relativePath: "a-elsewhere" },
                { ...entry, relativePath: "a/child" },
            ] as never),
        ).toThrow(/file and directory/u);
        expect(() =>
            nativeAssetVersionArchiveInternalsForTest.validateNativeArchiveEntries([
                { ...entry, bytes: { byteLength: 17_179_869_185 } },
            ] as never),
        ).toThrow(/export boundary/u);
        expect(() => nativeAssetVersionArchiveInternalsForTest.validateNativeArchiveDirectories(["ASSET.md"], [entry])).toThrow(
            /collide/u,
        );
        expect(() => nativeAssetVersionArchiveInternalsForTest.validateNativeArchiveDirectories(["Dir", "dir"], [])).toThrow(
            /collide/u,
        );
    });

    it("fails closed on writer and reopened ZIP metadata/body counterexamples", async () => {
        const expected = {
            relativePath: "asset.md",
            bytes: new TextEncoder().encode("body"),
            contentHash: sha256Bytes("body"),
            executable: false,
        };
        let cleanupCalls = 0;
        await expect(
            nativeAssetVersionArchiveInternalsForTest.writeNativeArchive([expected], 1_000, () => ({
                add: async () => {
                    throw new Error("writer failed");
                },
                close: async () => {
                    cleanupCalls += 1;
                    throw new Error("cleanup failed");
                },
            })),
        ).rejects.toMatchObject({ code: "asset_native_export.archive_failed" });
        expect(cleanupCalls).toBe(1);
        await expect(
            nativeAssetVersionArchiveInternalsForTest.writeNativeArchive([expected], 1_000, () => ({
                add: async () => {
                    throw new NativeAssetVersionArchiveError("fixture", "fixture");
                },
                close: async () => new Uint8Array(),
            })),
        ).rejects.toMatchObject({ code: "fixture" });
        await expect(
            nativeAssetVersionArchiveInternalsForTest.closeIncompleteNativeZip({ close: async () => new Uint8Array() }),
        ).resolves.toBeUndefined();

        const fakeEntry = (overrides: Record<string, unknown> = {}) => ({
            filename: "asset.md",
            directory: false,
            encrypted: false,
            uncompressedSize: 4,
            unixMode: 0o100644,
            getData: async () => new TextEncoder().encode("body"),
            ...overrides,
        });
        const verify = async (entries: readonly unknown[]) => {
            let closed = false;
            const promise = nativeAssetVersionArchiveInternalsForTest.verifyNativeArchive(new Uint8Array(), [expected], () => ({
                getEntries: async () => entries as never,
                close: async () => {
                    closed = true;
                },
            }));
            await expect(promise).rejects.toBeInstanceOf(NativeAssetVersionArchiveError);
            expect(closed).toBe(true);
        };
        await verify([]);
        for (const overrides of [
            { filename: "other.md" },
            { directory: true },
            { encrypted: true },
            { uncompressedSize: 3 },
            { unixMode: 0o100755 },
        ]) {
            await verify([fakeEntry(overrides)]);
        }
        const withoutGetData = fakeEntry() as Record<string, unknown>;
        delete withoutGetData.getData;
        await verify([withoutGetData]);
        await verify([fakeEntry({ getData: async () => new Uint8Array() })]);
        await verify([fakeEntry({ getData: async () => new TextEncoder().encode("fail") })]);

        const fakeDirectory = (overrides: Record<string, unknown> = {}) => ({
            filename: "bundle/",
            directory: true,
            encrypted: false,
            uncompressedSize: 0,
            unixMode: 0o040755,
            ...overrides,
        });
        const verifyDirectory = async (directory: unknown) => {
            let closed = false;
            const promise = nativeAssetVersionArchiveInternalsForTest.verifyNativeArchive(
                new Uint8Array(),
                [expected],
                () => ({
                    getEntries: async () => [directory, fakeEntry()] as never,
                    close: async () => {
                        closed = true;
                    },
                }),
                ["bundle"],
            );
            await expect(promise).rejects.toBeInstanceOf(NativeAssetVersionArchiveError);
            expect(closed).toBe(true);
        };
        for (const directory of [
            undefined,
            fakeDirectory({ filename: "other/" }),
            fakeDirectory({ directory: false }),
            fakeDirectory({ encrypted: true }),
            fakeDirectory({ uncompressedSize: 1 }),
            fakeDirectory({ unixMode: 0o040700 }),
        ]) {
            await verifyDirectory(directory);
        }
    });
});
