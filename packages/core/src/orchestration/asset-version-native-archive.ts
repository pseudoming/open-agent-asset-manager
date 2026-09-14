import { Uint8ArrayReader, Uint8ArrayWriter, type Entry, type FileEntry, ZipReader, ZipWriter } from "@zip.js/zip.js";
import type { NativePayloadClosureV1 } from "../catalog/version-authority";
import type { VersionNativeRepresentation } from "../contracts/persistence";
import type { Sha256Digest } from "../contracts/primitives";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isPosixRelativePath } from "../foundation/validators";

const MAXIMUM_NATIVE_ARCHIVE_FILES = 100_000;
const MAXIMUM_NATIVE_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024;
const MINIMUM_ZIP_DATE = Date.UTC(1980, 0, 1);
const REGULAR_FILE_MODE = 0o100644;
const EXECUTABLE_FILE_MODE = 0o100755;
const DIRECTORY_MODE = 0o40755;
const WINDOWS_FORBIDDEN_PUNCTUATION = /[<>:"|?*]/u;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

interface NativeArchiveSourceEntry {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
    readonly contentHash: Sha256Digest;
    readonly executable: boolean;
}

interface NativeArchiveWriter {
    add(
        filename: string,
        reader: Uint8ArrayReader | undefined,
        options: {
            readonly level: number;
            readonly lastModDate: Date;
            readonly unixMode: number;
            readonly directory?: boolean;
        },
    ): Promise<unknown>;
    close(): Promise<Uint8Array>;
}

interface NativeArchiveReader {
    getEntries(options: { readonly strictness: "strict" }): Promise<readonly Entry[]>;
    close(): Promise<unknown>;
}

export interface VerifiedNativeAssetVersionArchiveV1 {
    readonly bytes: Uint8Array;
    readonly dialectId: string;
    readonly representationFingerprint: Sha256Digest;
    readonly fileCount: number;
}

export class NativeAssetVersionArchiveError extends Error {
    public constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "NativeAssetVersionArchiveError";
    }
}

export async function buildAndVerifyNativeAssetVersionArchive(input: {
    readonly representation: VersionNativeRepresentation;
    readonly payload: NativePayloadClosureV1;
    readonly exportedAt: number;
}): Promise<VerifiedNativeAssetVersionArchiveV1> {
    if (!Number.isSafeInteger(input.exportedAt) || input.exportedAt < 0) {
        throw nativeArchiveError("asset_native_export.exported_at_invalid", "exportedAt must be a non-negative epoch-ms integer");
    }
    if (input.representation.dialectId !== input.payload.dialectId) {
        throw nativeArchiveError("asset_native_export.dialect_mismatch", "native representation and payload dialects differ");
    }
    const payloadByPath = new Map(input.payload.files.map((file) => [file.relativePath, file] as const));
    const entries = input.representation.files.map((file): NativeArchiveSourceEntry => {
        const payload = payloadByPath.get(file.relativePath);
        if (
            payload === undefined ||
            payload.bytes.byteLength !== file.byteSize ||
            sha256Bytes(payload.bytes) !== file.contentHash
        ) {
            throw nativeArchiveError(
                "asset_native_export.payload_mismatch",
                `native payload differs from its descriptor: ${file.relativePath}`,
            );
        }
        return {
            relativePath: file.relativePath,
            bytes: new Uint8Array(payload.bytes),
            contentHash: file.contentHash,
            executable: file.executable,
        };
    });
    if (payloadByPath.size !== entries.length) {
        throw nativeArchiveError("asset_native_export.payload_mismatch", "native payload inventory differs from its descriptor");
    }
    validateNativeArchiveEntries(entries);
    const orderedEntries = [...entries].sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
    const directoryPaths = input.representation.schemaVersion === 2 ? [...input.representation.directories] : [];
    validateNativeArchiveDirectories(directoryPaths, orderedEntries);
    const bytes = await writeNativeArchive(orderedEntries, input.exportedAt, undefined, directoryPaths);
    await verifyNativeArchive(bytes, orderedEntries, undefined, directoryPaths);
    return Object.freeze({
        bytes,
        dialectId: input.representation.dialectId,
        representationFingerprint: input.representation.representationFingerprint,
        fileCount: orderedEntries.length,
    });
}

function validateNativeArchiveDirectories(directories: readonly string[], files: readonly NativeArchiveSourceEntry[]): void {
    const keys = new Set(files.map((file) => file.relativePath.normalize("NFC").toLowerCase()));
    for (const relativePath of directories) {
        validatePortableNativePath(relativePath, "directory");
        const key = relativePath.normalize("NFC").toLowerCase();
        if (keys.has(key)) {
            throw nativeArchiveError("asset_native_export.path_collision", `native archive paths collide: ${relativePath}`);
        }
        keys.add(key);
    }
}

function validateNativeArchiveEntries(entries: readonly NativeArchiveSourceEntry[]): void {
    if (entries.length === 0 || entries.length > MAXIMUM_NATIVE_ARCHIVE_FILES) {
        throw nativeArchiveError("asset_native_export.inventory_invalid", "native file count is outside the supported boundary");
    }
    const pathKeys = new Set<string>();
    let totalBytes = 0;
    for (const entry of entries) {
        validatePortableNativePath(entry.relativePath, "file");
        const pathKey = entry.relativePath.normalize("NFC").toLowerCase();
        if (pathKeys.has(pathKey)) {
            throw nativeArchiveError("asset_native_export.path_collision", `native file paths collide: ${entry.relativePath}`);
        }
        pathKeys.add(pathKey);
        totalBytes += entry.bytes.byteLength;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAXIMUM_NATIVE_ARCHIVE_BYTES) {
            throw nativeArchiveError("asset_native_export.expansion_limit", "native files exceed the export boundary");
        }
    }
    for (const pathKey of pathKeys) {
        let separator = pathKey.indexOf("/");
        while (separator >= 0) {
            if (pathKeys.has(pathKey.slice(0, separator))) {
                throw nativeArchiveError("asset_native_export.path_collision", "native file and directory paths collide");
            }
            separator = pathKey.indexOf("/", separator + 1);
        }
    }
}

function validatePortableNativePath(relativePath: string, entryKind: "file" | "directory"): void {
    if (!isPosixRelativePath(relativePath)) {
        throw nativeArchiveError("asset_native_export.path_invalid", `native ${entryKind} path is unsafe: ${relativePath}`);
    }
    for (const segment of relativePath.split("/")) {
        if (
            segment.length === 0 ||
            segment === "." ||
            segment === ".." ||
            segment.endsWith(".") ||
            segment.endsWith(" ") ||
            hasWindowsForbiddenCharacter(segment) ||
            WINDOWS_RESERVED_BASENAME.test(segment)
        ) {
            throw nativeArchiveError(
                "asset_native_export.path_not_portable",
                `native ${entryKind} path cannot be exported unchanged as a portable ZIP member: ${relativePath}`,
            );
        }
    }
}

function hasWindowsForbiddenCharacter(value: string): boolean {
    if (WINDOWS_FORBIDDEN_PUNCTUATION.test(value)) return true;
    for (let index = 0; index < value.length; index += 1) {
        if (value.charCodeAt(index) <= 0x1f) return true;
    }
    return false;
}

async function writeNativeArchive(
    entries: readonly NativeArchiveSourceEntry[],
    exportedAt: number,
    createWriter: (() => NativeArchiveWriter) | undefined = undefined,
    directoryPaths: readonly string[] = [],
): Promise<Uint8Array> {
    const writer = (
        createWriter ?? (() => new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false }) as NativeArchiveWriter)
    )();
    try {
        for (const relativePath of directoryPaths) {
            await writer.add(`${relativePath}/`, undefined, {
                directory: true,
                level: 0,
                lastModDate: new Date(Math.max(exportedAt, MINIMUM_ZIP_DATE)),
                unixMode: DIRECTORY_MODE,
            });
        }
        for (const entry of entries) {
            await writer.add(entry.relativePath, new Uint8ArrayReader(entry.bytes), {
                level: 6,
                lastModDate: new Date(Math.max(exportedAt, MINIMUM_ZIP_DATE)),
                unixMode: entry.executable ? EXECUTABLE_FILE_MODE : REGULAR_FILE_MODE,
            });
        }
        return await writer.close();
    } catch (error) {
        await closeIncompleteNativeZip(writer);
        if (error instanceof NativeAssetVersionArchiveError) throw error;
        throw nativeArchiveError("asset_native_export.archive_failed", `native-file archive failed: ${String(error)}`);
    }
}

async function closeIncompleteNativeZip(writer: Pick<NativeArchiveWriter, "close">): Promise<void> {
    try {
        await writer.close();
    } catch {
        // Preserve the original archive-construction failure.
    }
}

async function verifyNativeArchive(
    bytes: Uint8Array,
    expectedEntries: readonly NativeArchiveSourceEntry[],
    createReader: ((bytes: Uint8Array) => NativeArchiveReader) | undefined = undefined,
    directoryPaths: readonly string[] = [],
): Promise<void> {
    const reader = (
        createReader ??
        ((archiveBytes) =>
            new ZipReader(new Uint8ArrayReader(archiveBytes), {
                useWebWorkers: false,
                strictness: "strict",
            }) as NativeArchiveReader)
    )(bytes);
    try {
        const entries = await reader.getEntries({ strictness: "strict" });
        if (entries.length !== directoryPaths.length + expectedEntries.length) {
            throw nativeArchiveError("asset_native_export.inventory_mismatch", "native-file archive inventory changed");
        }
        for (let index = 0; index < directoryPaths.length; index += 1) {
            const entry = entries[index] as Entry | undefined;
            if (
                entry === undefined ||
                entry.filename !== `${directoryPaths[index]}/` ||
                !entry.directory ||
                entry.encrypted ||
                entry.uncompressedSize !== 0 ||
                entry.unixMode !== DIRECTORY_MODE
            ) {
                throw nativeArchiveError("asset_native_export.inventory_mismatch", "native directory archive metadata changed");
            }
        }
        for (let index = 0; index < expectedEntries.length; index += 1) {
            const expected = expectedEntries[index] as NativeArchiveSourceEntry;
            const entry = entries[directoryPaths.length + index] as Entry | undefined;
            if (
                entry === undefined ||
                entry.filename !== expected.relativePath ||
                entry.directory ||
                entry.encrypted ||
                entry.uncompressedSize !== expected.bytes.byteLength ||
                entry.unixMode !== (expected.executable ? EXECUTABLE_FILE_MODE : REGULAR_FILE_MODE) ||
                !("getData" in entry)
            ) {
                throw nativeArchiveError("asset_native_export.inventory_mismatch", "native-file archive metadata changed");
            }
            const reopened = await (entry as FileEntry).getData(new Uint8ArrayWriter(), {
                useWebWorkers: false,
                strictness: "strict",
            });
            if (reopened.byteLength !== expected.bytes.byteLength || sha256Bytes(reopened) !== expected.contentHash) {
                throw nativeArchiveError("asset_native_export.body_mismatch", `native file changed: ${entry.filename}`);
            }
        }
    } finally {
        await reader.close();
    }
}

function nativeArchiveError(code: string, message: string): NativeAssetVersionArchiveError {
    return new NativeAssetVersionArchiveError(code, message);
}

/** @internal Exact seams exposed only to hostile original-file archive tests. */
export const nativeAssetVersionArchiveInternalsForTest = Object.freeze({
    closeIncompleteNativeZip,
    validateNativeArchiveDirectories,
    validateNativeArchiveEntries,
    verifyNativeArchive,
    writeNativeArchive,
});
