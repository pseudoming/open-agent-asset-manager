import { Uint8ArrayReader, Uint8ArrayWriter, type Entry, type FileEntry, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { parseVersionManifest, serializeVersionManifest } from "../catalog/version-manifest";
import { bytesForPayload } from "../catalog/payload-store";
import { type VersionAuthorityClosureV1, validateVersionMaterialClosure } from "../catalog/version-authority";
import { requireValidAssetManifest } from "../catalog/asset-manifest-authority";
import type { PortableAssetVersionArchiveIndexV1 } from "../contracts/asset-version-archive";
import type { AssetVersionFileContentV2 } from "../contracts/asset-version";
import type { AssetManifestV1 } from "../contracts/core-service";
import type { Sha256Digest } from "../contracts/primitives";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { computePortableAssetVersionArchiveIndexFingerprint, stableStringify } from "../foundation/fingerprint";
import {
    schemaArrayWithUniqueKey as array,
    schemaLiteral as literal,
    schemaObject as object,
    schemaStringEnum as oneOf,
    validateStrict,
    type StrictSchema,
} from "../foundation/strict-schema";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isPosixRelativePath, isSha256Digest, isUuidV4 } from "../foundation/validators";
import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";

export const PORTABLE_ASSET_VERSION_INDEX_PATH = "metadata/export.json";
export const PORTABLE_ASSET_VERSION_MANIFEST_PATH = "metadata/version.json";
export const PORTABLE_ASSET_VERSION_README_PATH = "README.md";

const MAXIMUM_ARCHIVE_FILES = 100_000;
const MAXIMUM_ARCHIVE_UNCOMPRESSED_BYTES = 16 * 1024 * 1024 * 1024;
const MAXIMUM_METADATA_BYTES = 64 * 1024 * 1024;
const MAXIMUM_README_BYTES = 1024 * 1024;
const MINIMUM_ZIP_DATE = Date.UTC(1980, 0, 1);
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_REGULAR_FILE = 0x8000;

export interface BuildPortableAssetVersionArchiveInputV1 {
    asset: AssetManifestV1;
    version: VersionAuthorityClosureV1;
    dialectRegistry: VersionDialectRegistryV1;
    exportedAt: number;
}

export interface VerifiedPortableAssetVersionArchiveV1 {
    bytes: Uint8Array;
    index: PortableAssetVersionArchiveIndexV1;
}

export interface PortableAssetVersionImportHandoffV1 {
    index: PortableAssetVersionArchiveIndexV1;
    version: VersionAuthorityClosureV1;
}

export class PortableAssetVersionArchiveError extends Error {
    public constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "PortableAssetVersionArchiveError";
    }
}

export async function buildAndVerifyPortableAssetVersionArchive(
    input: BuildPortableAssetVersionArchiveInputV1,
): Promise<VerifiedPortableAssetVersionArchiveV1> {
    validateExportSource(input);
    const index = buildArchiveIndex(input);
    const sourceEntries = archiveSourceEntries(index, input.version);
    assertArchiveSizeBoundary(sourceEntries);
    const bytes = await writePortableArchiveEntries(sourceEntries, input.exportedAt);
    await inspectPortableAssetVersionArchive(bytes, input.dialectRegistry);
    return { bytes, index };
}

export async function inspectPortableAssetVersionArchive(
    archiveBytes: Uint8Array,
    dialectRegistry: VersionDialectRegistryV1,
): Promise<PortableAssetVersionImportHandoffV1> {
    const reader = new ZipReader(new Uint8ArrayReader(archiveBytes), {
        useWebWorkers: false,
        strictness: "strict",
    });
    try {
        const entries = await reader.getEntries({ strictness: "strict" });
        validateArchiveEntryMetadata(entries);
        const indexBytes = await extractBoundedEntry(
            requireFileEntry(entries, PORTABLE_ASSET_VERSION_INDEX_PATH),
            MAXIMUM_METADATA_BYTES,
        );
        const index = parseArchiveIndex(indexBytes);
        const manifestBytes = await extractBoundedEntry(
            requireFileEntry(entries, PORTABLE_ASSET_VERSION_MANIFEST_PATH),
            MAXIMUM_METADATA_BYTES,
        );
        const manifest = parseVersionManifest(decodeUtf8(manifestBytes, "Version manifest"));
        validateIndexAgainstManifest(index, manifest);
        await extractBoundedEntry(requireFileEntry(entries, PORTABLE_ASSET_VERSION_README_PATH), MAXIMUM_README_BYTES);
        const expected = expectedArchiveEntries(index, manifest, entries);
        validateExactArchiveInventory(entries, expected);

        const canonicalDescriptorByPath = new Map(manifest.files.map((file) => [file.logicalPath, file] as const));
        const files: AssetVersionFileContentV2[] = [];
        for (const mapping of index.canonicalFiles) {
            const descriptor = canonicalDescriptorByPath.get(
                mapping.logicalPath,
            ) as VersionAuthorityClosureV1["manifest"]["files"][number];
            const bytes = await extractExactPayload(
                requireFileEntry(entries, mapping.archivePath),
                descriptor.byteSize,
                descriptor.contentHash,
            );
            files.push(
                descriptor.contentKind === "text"
                    ? {
                          file: descriptor,
                          contentKind: "text",
                          text: decodeUtf8(bytes, `canonical file ${mapping.logicalPath}`),
                      }
                    : { file: descriptor, contentKind: "binary", bytes },
            );
        }

        const nativePayloads = [];
        for (const representation of index.nativeRepresentations) {
            const descriptor = manifest.nativeRepresentations.find(
                (item) => item.dialectId === representation.dialectId,
            ) as VersionAuthorityClosureV1["manifest"]["nativeRepresentations"][number];
            const descriptorByPath = new Map(descriptor.files.map((file) => [file.relativePath, file] as const));
            const nativeFiles = [];
            for (const mapping of representation.files) {
                const file = descriptorByPath.get(mapping.relativePath) as (typeof descriptor.files)[number];
                nativeFiles.push({
                    relativePath: mapping.relativePath,
                    bytes: await extractExactPayload(
                        requireFileEntry(entries, mapping.archivePath),
                        file.byteSize,
                        file.contentHash,
                    ),
                });
            }
            nativePayloads.push({ dialectId: representation.dialectId, files: nativeFiles });
        }

        const restorationPayloads = [];
        for (const mapping of index.restorationPayloads) {
            const descriptor = manifest.dialectRestorationPayloads.find(
                (item) => item.dialectId === mapping.dialectId,
            ) as VersionAuthorityClosureV1["manifest"]["dialectRestorationPayloads"][number];
            restorationPayloads.push({
                dialectId: mapping.dialectId,
                bytes: await extractExactPayload(
                    requireFileEntry(entries, mapping.archivePath),
                    mapping.byteSize,
                    descriptor.contentHash,
                ),
            });
        }
        const version = { manifest, files, nativePayloads, restorationPayloads };
        validateVersionMaterialClosure(version, dialectRegistry);
        return { index, version };
    } catch (error) {
        if (error instanceof PortableAssetVersionArchiveError) throw error;
        throw archiveError("asset_export.archive_invalid", `portable Version archive is invalid: ${String(error)}`);
    } finally {
        await reader.close();
    }
}

interface ArchiveSourceEntry {
    archivePath: string;
    bytes: Uint8Array;
}

function validateExportSource(input: BuildPortableAssetVersionArchiveInputV1): void {
    requireValidAssetManifest(input.asset);
    if (!Number.isSafeInteger(input.exportedAt) || input.exportedAt < 0) {
        throw archiveError("asset_export.exported_at_invalid", "exportedAt must be a non-negative epoch-ms integer");
    }
    if (
        input.version.manifest.assetId !== input.asset.assetId ||
        input.version.manifest.kind !== input.asset.kind ||
        !input.asset.versionIds.includes(input.version.manifest.versionId)
    ) {
        throw archiveError("asset_export.source_mismatch", "Version does not belong to the selected Asset authority");
    }
    validateVersionMaterialClosure(input.version, input.dialectRegistry);
}

function buildArchiveIndex(input: BuildPortableAssetVersionArchiveInputV1): PortableAssetVersionArchiveIndexV1 {
    const preimage: Omit<PortableAssetVersionArchiveIndexV1, "indexFingerprint"> = {
        schemaVersion: 1,
        archiveFormat: "oaam_asset_version",
        exportedAt: input.exportedAt,
        sourceAsset: {
            assetId: input.asset.assetId,
            displayName: input.asset.displayName,
            displayDescription: input.asset.displayDescription,
            scope: input.asset.scope,
            projectId: input.asset.projectId,
            scopePath: input.asset.scopePath,
        },
        version: {
            versionId: input.version.manifest.versionId,
            fingerprint: input.version.manifest.fingerprint,
            manifestPath: PORTABLE_ASSET_VERSION_MANIFEST_PATH,
        },
        canonicalFiles: input.version.manifest.files.map((file) => ({
            logicalPath: file.logicalPath,
            archivePath: canonicalArchivePath(file.logicalPath),
        })),
        nativeRepresentations: input.version.manifest.nativeRepresentations.map((representation) => ({
            dialectId: representation.dialectId,
            files: representation.files.map((file) => ({
                relativePath: file.relativePath,
                archivePath: nativeArchivePath(representation.dialectId, file.relativePath),
            })),
        })),
        restorationPayloads: input.version.restorationPayloads.map((payload) => ({
            dialectId: payload.dialectId,
            archivePath: restorationArchivePath(payload.dialectId),
            byteSize: payload.bytes.byteLength,
        })),
    };
    return {
        ...preimage,
        indexFingerprint: computePortableAssetVersionArchiveIndexFingerprint(preimage),
    };
}

function archiveSourceEntries(
    index: PortableAssetVersionArchiveIndexV1,
    version: VersionAuthorityClosureV1,
): ArchiveSourceEntry[] {
    const canonicalByPath = new Map(version.files.map((file) => [file.file.logicalPath, file] as const));
    const nativeByDialect = new Map(version.nativePayloads.map((payload) => [payload.dialectId, payload] as const));
    const restorationByDialect = new Map(version.restorationPayloads.map((payload) => [payload.dialectId, payload] as const));
    const payloadEntries: ArchiveSourceEntry[] = [];
    for (const mapping of index.canonicalFiles) {
        const file = canonicalByPath.get(mapping.logicalPath) as VersionAuthorityClosureV1["files"][number];
        payloadEntries.push({
            archivePath: mapping.archivePath,
            bytes: file.contentKind === "text" ? bytesForPayload(file.text, "text") : new Uint8Array(file.bytes),
        });
    }
    for (const representation of index.nativeRepresentations) {
        const payload = nativeByDialect.get(representation.dialectId) as VersionAuthorityClosureV1["nativePayloads"][number];
        const filesByPath = new Map(payload.files.map((file) => [file.relativePath, file] as const));
        for (const mapping of representation.files) {
            const file = filesByPath.get(mapping.relativePath) as (typeof payload.files)[number];
            payloadEntries.push({ archivePath: mapping.archivePath, bytes: new Uint8Array(file.bytes) });
        }
    }
    for (const mapping of index.restorationPayloads) {
        const payload = restorationByDialect.get(mapping.dialectId) as VersionAuthorityClosureV1["restorationPayloads"][number];
        payloadEntries.push({ archivePath: mapping.archivePath, bytes: new Uint8Array(payload.bytes) });
    }
    return [
        ...payloadEntries,
        {
            archivePath: PORTABLE_ASSET_VERSION_INDEX_PATH,
            bytes: new TextEncoder().encode(`${stableStringify(index)}\n`),
        },
        {
            archivePath: PORTABLE_ASSET_VERSION_MANIFEST_PATH,
            bytes: new TextEncoder().encode(serializeVersionManifest(version.manifest)),
        },
        {
            archivePath: PORTABLE_ASSET_VERSION_README_PATH,
            bytes: new TextEncoder().encode(readmeText(index)),
        },
    ].sort((left, right) => compareUtf8Bytes(left.archivePath, right.archivePath));
}

function expectedArchiveEntries(
    index: PortableAssetVersionArchiveIndexV1,
    manifest: VersionAuthorityClosureV1["manifest"],
    entries: Entry[],
): Map<string, number> {
    const expected = new Map<string, number>();
    expected.set(
        PORTABLE_ASSET_VERSION_INDEX_PATH,
        requireFileEntry(entries, PORTABLE_ASSET_VERSION_INDEX_PATH).uncompressedSize,
    );
    expected.set(
        PORTABLE_ASSET_VERSION_MANIFEST_PATH,
        requireFileEntry(entries, PORTABLE_ASSET_VERSION_MANIFEST_PATH).uncompressedSize,
    );
    expected.set(
        PORTABLE_ASSET_VERSION_README_PATH,
        requireFileEntry(entries, PORTABLE_ASSET_VERSION_README_PATH).uncompressedSize,
    );
    const canonicalByPath = new Map(manifest.files.map((file) => [file.logicalPath, file] as const));
    for (const mapping of index.canonicalFiles) {
        expected.set(mapping.archivePath, (canonicalByPath.get(mapping.logicalPath) as { byteSize: number }).byteSize);
    }
    for (const representation of index.nativeRepresentations) {
        const descriptor = manifest.nativeRepresentations.find(
            (item) => item.dialectId === representation.dialectId,
        ) as VersionAuthorityClosureV1["manifest"]["nativeRepresentations"][number];
        const files = new Map(descriptor.files.map((file) => [file.relativePath, file] as const));
        for (const mapping of representation.files) {
            expected.set(mapping.archivePath, (files.get(mapping.relativePath) as { byteSize: number }).byteSize);
        }
    }
    for (const mapping of index.restorationPayloads) expected.set(mapping.archivePath, mapping.byteSize);
    return expected;
}

function validateIndexAgainstManifest(
    index: PortableAssetVersionArchiveIndexV1,
    manifest: VersionAuthorityClosureV1["manifest"],
): void {
    if (
        index.sourceAsset.assetId !== manifest.assetId ||
        index.version.versionId !== manifest.versionId ||
        index.version.fingerprint !== manifest.fingerprint
    ) {
        throw archiveError("asset_export.identity_mismatch", "archive index and Version manifest identities differ");
    }
    const canonical = manifest.files.map((file) => ({
        logicalPath: file.logicalPath,
        archivePath: canonicalArchivePath(file.logicalPath),
    }));
    const native = manifest.nativeRepresentations.map((representation) => ({
        dialectId: representation.dialectId,
        files: representation.files.map((file) => ({
            relativePath: file.relativePath,
            archivePath: nativeArchivePath(representation.dialectId, file.relativePath),
        })),
    }));
    const restorations = manifest.dialectRestorationPayloads.map((payload) => ({
        dialectId: payload.dialectId,
        archivePath: restorationArchivePath(payload.dialectId),
    }));
    if (
        stableStringify(index.canonicalFiles) !== stableStringify(canonical) ||
        stableStringify(index.nativeRepresentations) !== stableStringify(native) ||
        stableStringify(index.restorationPayloads.map(({ byteSize: _size, ...payload }) => payload)) !==
            stableStringify(restorations)
    ) {
        throw archiveError("asset_export.index_mismatch", "archive index does not match the Version material graph");
    }
}

function parseArchiveIndex(bytes: Uint8Array): PortableAssetVersionArchiveIndexV1 {
    let parsed: unknown;
    try {
        parsed = JSON.parse(decodeUtf8(bytes, "archive index")) as unknown;
    } catch (error) {
        throw archiveError("asset_export.index_invalid", `archive index is not strict UTF-8 JSON: ${String(error)}`);
    }
    if (!validateStrict(archiveIndexSchema, parsed)) {
        throw archiveError("asset_export.index_invalid", "archive index does not match the strict V1 schema");
    }
    const index = parsed as PortableAssetVersionArchiveIndexV1;
    const { indexFingerprint: _stored, ...preimage } = index;
    if (computePortableAssetVersionArchiveIndexFingerprint(preimage) !== index.indexFingerprint) {
        throw archiveError("asset_export.index_fingerprint_mismatch", "archive index fingerprint does not match its body");
    }
    if (
        (index.sourceAsset.scope === "global" && (index.sourceAsset.projectId !== "" || index.sourceAsset.scopePath !== "")) ||
        (index.sourceAsset.scope === "project" && !isUuidV4(index.sourceAsset.projectId))
    ) {
        throw archiveError("asset_export.index_invalid", "archive source placement is inconsistent");
    }
    const paths = [
        PORTABLE_ASSET_VERSION_INDEX_PATH,
        PORTABLE_ASSET_VERSION_MANIFEST_PATH,
        PORTABLE_ASSET_VERSION_README_PATH,
        ...index.canonicalFiles.map((file) => file.archivePath),
        ...index.nativeRepresentations.flatMap((representation) => representation.files.map((file) => file.archivePath)),
        ...index.restorationPayloads.map((payload) => payload.archivePath),
    ];
    assertPortableArchivePaths(paths);
    return index;
}

function validateArchiveEntryMetadata(entries: Entry[]): void {
    if (entries.length < 3 || entries.length > MAXIMUM_ARCHIVE_FILES + 3) {
        throw archiveError("asset_export.inventory_invalid", "archive entry count is outside the supported boundary");
    }
    const comparisonKeys = new Set<string>();
    let total = 0;
    for (const entry of entries) {
        assertPortableArchivePaths([entry.filename]);
        const key = entry.filename.normalize("NFC").toLowerCase();
        if (comparisonKeys.has(key)) {
            throw archiveError("asset_export.path_collision", "archive contains duplicate or case-colliding paths");
        }
        comparisonKeys.add(key);
        const fileType = entry.unixMode === undefined ? 0 : entry.unixMode & UNIX_FILE_TYPE_MASK;
        if (
            entry.directory ||
            entry.encrypted ||
            (fileType !== 0 && fileType !== UNIX_REGULAR_FILE) ||
            !Number.isSafeInteger(entry.uncompressedSize) ||
            entry.uncompressedSize < 0
        ) {
            throw archiveError("asset_export.entry_unsupported", "archive contains an unsupported entry");
        }
        total += entry.uncompressedSize;
        if (!Number.isSafeInteger(total) || total > MAXIMUM_ARCHIVE_UNCOMPRESSED_BYTES) {
            throw archiveError("asset_export.expansion_limit", "archive uncompressed size exceeds the supported boundary");
        }
    }
}

function validateExactArchiveInventory(entries: Entry[], expected: Map<string, number>): void {
    if (entries.length !== expected.size || entries.some((entry) => expected.get(entry.filename) !== entry.uncompressedSize)) {
        throw archiveError("asset_export.inventory_mismatch", "archive inventory does not match its strict index");
    }
}

async function extractBoundedEntry(entry: FileEntry, maximumBytes: number): Promise<Uint8Array> {
    if (entry.uncompressedSize > maximumBytes) {
        throw archiveError("asset_export.entry_too_large", `archive entry exceeds its supported size: ${entry.filename}`);
    }
    const bytes = await entry.getData(new Uint8ArrayWriter(), {
        useWebWorkers: false,
        strictness: "strict",
    });
    if (bytes.byteLength > maximumBytes) {
        throw archiveError("asset_export.entry_too_large", `archive entry expanded past its limit: ${entry.filename}`);
    }
    return bytes;
}

async function extractExactPayload(entry: FileEntry, byteSize: number, contentHash: Sha256Digest): Promise<Uint8Array> {
    const bytes = await extractBoundedEntry(entry, byteSize);
    if (bytes.byteLength !== byteSize || sha256Bytes(bytes) !== contentHash) {
        throw archiveError("asset_export.body_mismatch", `archive payload differs from its descriptor: ${entry.filename}`);
    }
    return bytes;
}

function requireFileEntry(entries: Entry[], filename: string): FileEntry {
    const entry = entries.find((candidate) => candidate.filename === filename);
    if (entry === undefined || entry.directory || !("getData" in entry)) {
        throw archiveError("asset_export.inventory_mismatch", `archive is missing required file ${filename}`);
    }
    return entry;
}

function assertArchiveSizeBoundary(entries: ArchiveSourceEntry[]): void {
    if (entries.length > MAXIMUM_ARCHIVE_FILES + 3) {
        throw archiveError("asset_export.inventory_invalid", "Version contains too many files for one portable archive");
    }
    assertPortableArchivePaths(entries.map((entry) => entry.archivePath));
    let total = 0;
    for (const entry of entries) {
        total += entry.bytes.byteLength;
        if (!Number.isSafeInteger(total) || total > MAXIMUM_ARCHIVE_UNCOMPRESSED_BYTES) {
            throw archiveError("asset_export.expansion_limit", "Version material exceeds the portable archive boundary");
        }
    }
}

function assertPortableArchivePaths(paths: string[]): void {
    const comparisonKeys = new Set<string>();
    for (const archivePath of paths) {
        const segments = archivePath.split("/");
        if (
            archivePath.length === 0 ||
            archivePath.startsWith("/") ||
            archivePath.endsWith("/") ||
            archivePath.includes("\\") ||
            archivePath.includes("\0") ||
            segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
        ) {
            throw archiveError("asset_export.path_invalid", `archive path is unsafe: ${archivePath}`);
        }
        const key = archivePath.normalize("NFC").toLowerCase();
        if (comparisonKeys.has(key)) {
            throw archiveError("asset_export.path_collision", `archive paths collide: ${archivePath}`);
        }
        comparisonKeys.add(key);
    }
}

function canonicalArchivePath(logicalPath: string): string {
    return `canonical/${encodeLogicalPath(logicalPath)}`;
}

function nativeArchivePath(dialectId: string, relativePath: string): string {
    return `native/${encodeDialectId(dialectId)}/${encodeLogicalPath(relativePath)}`;
}

function restorationArchivePath(dialectId: string): string {
    return `restoration/${encodeDialectId(dialectId)}/payload.bin`;
}

function encodeLogicalPath(logicalPath: string): string {
    return logicalPath.split("/").map(encodeArchiveSegment).join("/");
}

function encodeArchiveSegment(segment: string): string {
    let encoded = "p~";
    for (const byte of new TextEncoder().encode(segment)) {
        if ((byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x5f) {
            encoded += String.fromCharCode(byte);
        } else {
            encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        }
    }
    return encoded;
}

function encodeDialectId(dialectId: string): string {
    return `d~${Buffer.from(dialectId, "utf-8").toString("hex")}`;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
        throw archiveError("asset_export.utf8_invalid", `${label} is not UTF-8: ${String(error)}`);
    }
}

function readmeText(index: PortableAssetVersionArchiveIndexV1): string {
    return [
        "Open Agent Asset Manager portable Asset Version",
        "",
        "This standard ZIP contains exactly one immutable OAAM Version.",
        "metadata/export.json maps reversible archive paths to logical Version paths.",
        "metadata/version.json contains the strict Version manifest and historical provenance.",
        "IDs and historical paths are traceability facts only; they grant no overwrite, deployment or promotion authority.",
        "Re-entry must use the ordinary OAAM import review.",
        `Asset ID: ${index.sourceAsset.assetId}`,
        `Version ID: ${index.version.versionId}`,
        `Exported at (epoch ms): ${String(index.exportedAt)}`,
        "",
    ].join("\n");
}

async function closeIncompleteZip(zip: Pick<ZipWriter<Uint8Array>, "close">): Promise<void> {
    try {
        await zip.close();
    } catch {
        // Preserve the original construction failure.
    }
}

interface PortableArchiveWriter {
    add(filename: string, reader: Uint8ArrayReader, options: { level: number; lastModDate: Date }): Promise<unknown>;
    close(): Promise<Uint8Array>;
}

async function writePortableArchiveEntries(
    entries: ArchiveSourceEntry[],
    exportedAt: number,
    createWriter: () => PortableArchiveWriter = () =>
        new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false }) as PortableArchiveWriter,
): Promise<Uint8Array> {
    const zip = createWriter();
    try {
        const options = {
            level: 6,
            lastModDate: new Date(Math.max(exportedAt, MINIMUM_ZIP_DATE)),
        };
        for (const entry of entries) {
            await zip.add(entry.archivePath, new Uint8ArrayReader(entry.bytes), options);
        }
        return await zip.close();
    } catch (error) {
        await closeIncompleteZip(zip);
        if (error instanceof PortableAssetVersionArchiveError) throw error;
        throw archiveError("asset_export.archive_failed", `portable Version archive failed: ${String(error)}`);
    }
}

function archiveError(code: string, message: string): PortableAssetVersionArchiveError {
    return new PortableAssetVersionArchiveError(code, message);
}

const text: StrictSchema = { kind: "string" };
const nonBlank: StrictSchema = { kind: "string", nonBlank: true };
const epoch: StrictSchema = { kind: "number", integer: true, min: 0 };
const byteSize: StrictSchema = {
    kind: "number",
    integer: true,
    min: 0,
    max: MAXIMUM_ARCHIVE_UNCOMPRESSED_BYTES,
};
const uuid: StrictSchema = { kind: "custom", check: isUuidV4 };
const sha: StrictSchema = { kind: "custom", check: isSha256Digest };
const posixPath: StrictSchema = { kind: "custom", check: isPosixRelativePath };
const posixPathOrEmpty: StrictSchema = {
    kind: "custom",
    check: (value) => value === "" || isPosixRelativePath(value),
};
const archiveFile = object({
    logicalPath: posixPath,
    archivePath: posixPath,
});
const nativeArchiveFile = object({
    relativePath: posixPath,
    archivePath: posixPath,
});
const archiveIndexSchema = object({
    schemaVersion: literal(1),
    archiveFormat: literal("oaam_asset_version"),
    exportedAt: epoch,
    sourceAsset: object({
        assetId: uuid,
        displayName: nonBlank,
        displayDescription: text,
        scope: oneOf("global", "project"),
        projectId: text,
        scopePath: posixPathOrEmpty,
    }),
    version: object({
        versionId: uuid,
        fingerprint: sha,
        manifestPath: literal(PORTABLE_ASSET_VERSION_MANIFEST_PATH),
    }),
    canonicalFiles: array(archiveFile, (value) => (value as { logicalPath: string }).logicalPath),
    nativeRepresentations: array(
        object({
            dialectId: nonBlank,
            files: array(nativeArchiveFile, (value) => (value as { relativePath: string }).relativePath),
        }),
        (value) => (value as { dialectId: string }).dialectId,
    ),
    restorationPayloads: array(
        object({
            dialectId: nonBlank,
            archivePath: posixPath,
            byteSize,
        }),
        (value) => (value as { dialectId: string }).dialectId,
    ),
    indexFingerprint: sha,
});

/** @internal Exact seams exposed only to hostile-archive tests. */
export const portableAssetVersionArchiveInternalsForTest = Object.freeze({
    assertArchiveSizeBoundary,
    assertPortableArchivePaths,
    closeIncompleteZip,
    decodeUtf8,
    encodeArchiveSegment,
    extractBoundedEntry,
    parseArchiveIndex,
    validateArchiveEntryMetadata,
    writePortableArchiveEntries,
});
