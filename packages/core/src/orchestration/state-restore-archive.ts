import { inspectRegularFileNoFollow, readRegularFileNoFollow, samePhysicalPathIdentity } from "@oaam/shared/filesystem";
import {
    type Entry,
    ERR_ENCRYPTED,
    ERR_INVALID_COMPRESSED_DATA,
    ERR_INVALID_PASSWORD,
    ERR_INVALID_SIGNATURE,
    ERR_INVALID_UNCOMPRESSED_SIZE,
    type FileEntry,
    Uint8ArrayReader,
    Uint8ArrayWriter,
    ZipReader,
} from "@zip.js/zip.js";
import { sha256Bytes } from "../foundation/crypto-bytes";
import {
    BACKUP_MANIFEST_PATH,
    BACKUP_README_PATH,
    type CapturedBackupEntry,
    MAXIMUM_BACKUP_FILES,
    MAXIMUM_BACKUP_LOGICAL_BYTES,
} from "./state-backup-model";
import {
    capturedRestoreSource,
    MAXIMUM_RESTORE_ARCHIVE_BYTES,
    requireCanonicalRestoreArchivePath,
    StateRestoreError,
    type ValidatedStateRestoreCandidate,
    validateBackupManifestDocument,
} from "./state-restore-model";

const MAXIMUM_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAXIMUM_README_BYTES = 1024 * 1024;
const MAXIMUM_RESTORE_UNCOMPRESSED_BYTES = MAXIMUM_BACKUP_LOGICAL_BYTES + MAXIMUM_MANIFEST_BYTES + MAXIMUM_README_BYTES;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_REGULAR_FILE = 0x8000;

export async function readAndValidateStateRestoreArchive(
    archivePathInput: unknown,
    password: string | undefined,
): Promise<ValidatedStateRestoreCandidate> {
    const archivePath = requireCanonicalRestoreArchivePath(archivePathInput);
    let archiveRead: ReturnType<typeof readRegularFileNoFollow>;
    try {
        archiveRead = readRegularFileNoFollow(archivePath, MAXIMUM_RESTORE_ARCHIVE_BYTES);
    } catch (error) {
        throw normalizeArchiveReadFailure(error, archivePath);
    }
    const archiveBytes = archiveRead.bytes;
    const archiveContentHash = sha256Bytes(archiveBytes);
    const reader = new ZipReader(new Uint8ArrayReader(archiveBytes), {
        useWebWorkers: false,
        strictness: "strict",
    });
    try {
        const entries = await reader.getEntries({ strictness: "strict" });
        validateArchiveMetadata(entries);
        const manifestFile = requireFileEntry(entries, BACKUP_MANIFEST_PATH);
        const manifestBytes = await extractEntry(manifestFile, password, MAXIMUM_MANIFEST_BYTES, archivePath);
        const manifest = validateBackupManifestDocument(parseManifestJson(manifestBytes));
        validateArchiveInventory(
            entries,
            manifest.entries.map((entry) => entry.logicalPath),
        );
        validateArchiveEncryption(entries, manifest.encryptionMode);

        const manifestByPath = new Map(manifest.entries.map((entry) => [entry.logicalPath, entry] as const));
        const captured: CapturedBackupEntry[] = [];
        for (const entry of entries) {
            const expected = manifestByPath.get(entry.filename);
            if (expected === undefined) continue;
            const bytes = await extractEntry(entry as FileEntry, password, expected.byteSize, archivePath);
            if (bytes.byteLength !== expected.byteSize || sha256Bytes(bytes) !== expected.contentHash) {
                throw archiveFailure(
                    "restore.archive_body_mismatch",
                    `restore archive body does not match manifest entry ${entry.filename}`,
                    "verification_failed",
                    false,
                    archivePath,
                );
            }
            captured.push({
                logicalPath: expected.logicalPath,
                owner: expected.owner,
                contentHash: expected.contentHash,
                byteSize: expected.byteSize,
                executable: expected.executable,
                bytes,
            });
        }
        assertArchiveIdentity(archiveRead.identity, inspectRegularFileNoFollow(archivePath), archivePath);
        const desktopPreferences = captured.find((entry) => entry.logicalPath === "desktop/desktop-preferences.json")?.bytes;
        return {
            archivePath,
            archiveByteSize: archiveBytes.byteLength,
            archiveContentHash,
            archiveIdentity: archiveRead.identity,
            manifest,
            source: capturedRestoreSource(captured, manifest),
            ...(desktopPreferences === undefined ? {} : { desktopPreferences: new Uint8Array(desktopPreferences) }),
        };
    } catch (error) {
        throw normalizeArchiveFailure(error, archivePath, password);
    } finally {
        await reader.close();
    }
}

function validateArchiveMetadata(entries: Entry[]): void {
    if (entries.length < 3 || entries.length > MAXIMUM_BACKUP_FILES + 2) {
        throw archiveFailure(
            "restore.archive_inventory_invalid",
            "restore archive entry count is outside the supported complete-backup boundary",
            "invalid_schema",
            false,
        );
    }
    let totalUncompressedBytes = 0;
    const comparisonKeys = new Set<string>();
    for (const entry of entries) {
        requireSafeArchiveFilename(entry.filename);
        const comparisonKey = entry.filename.normalize("NFC").toLowerCase();
        if (comparisonKeys.has(comparisonKey)) {
            throw archiveFailure(
                "restore.archive_path_collision",
                "restore archive contains duplicate or case-colliding paths",
                "invalid_schema",
                false,
            );
        }
        comparisonKeys.add(comparisonKey);
        if (
            entry.directory ||
            !Number.isSafeInteger(entry.uncompressedSize) ||
            entry.uncompressedSize < 0 ||
            entry.uncompressedSize > MAXIMUM_RESTORE_UNCOMPRESSED_BYTES ||
            unsupportedUnixFileType(entry)
        ) {
            throw archiveFailure(
                "restore.archive_entry_unsupported",
                "restore archive contains a directory, link, device or invalid-size entry",
                "invalid_schema",
                false,
            );
        }
        totalUncompressedBytes += entry.uncompressedSize;
        if (!Number.isSafeInteger(totalUncompressedBytes) || totalUncompressedBytes > MAXIMUM_RESTORE_UNCOMPRESSED_BYTES) {
            throw archiveFailure(
                "restore.archive_expansion_limit",
                "restore archive exceeds the bounded uncompressed size",
                "unavailable",
                false,
            );
        }
    }
}

function validateArchiveInventory(entries: Entry[], manifestPaths: string[]): void {
    const expected = new Set([...manifestPaths, BACKUP_MANIFEST_PATH, BACKUP_README_PATH]);
    if (
        entries.length !== expected.size ||
        entries.some((entry) => !expected.has(entry.filename)) ||
        new Set(entries.map((entry) => entry.filename)).size !== entries.length
    ) {
        throw archiveFailure(
            "restore.archive_inventory_mismatch",
            "restore archive inventory does not exactly match the strict manifest",
            "verification_failed",
            false,
        );
    }
}

function validateArchiveEncryption(entries: Entry[], mode: "none" | "compatible_password" | "strong_password"): void {
    for (const entry of entries) {
        const matches =
            mode === "none"
                ? !entry.encrypted && !entry.zipCrypto
                : mode === "compatible_password"
                  ? entry.encrypted && entry.zipCrypto
                  : entry.encrypted && !entry.zipCrypto;
        if (!matches) {
            throw archiveFailure(
                "restore.archive_encryption_mismatch",
                "restore archive entry encryption does not match the strict manifest mode",
                "verification_failed",
                false,
            );
        }
    }
}

async function extractEntry(
    entry: FileEntry,
    password: string | undefined,
    maximumBytes: number,
    archivePath: string,
): Promise<Uint8Array> {
    if (entry.uncompressedSize > maximumBytes) {
        throw archiveFailure(
            "restore.archive_entry_too_large",
            `restore archive entry exceeds its bounded size: ${entry.filename}`,
            "unavailable",
            false,
        );
    }
    let bytes: Uint8Array;
    try {
        bytes = await entry.getData(new Uint8ArrayWriter(), {
            password,
            useWebWorkers: false,
            strictness: "strict",
        });
    } catch (error) {
        throw normalizeArchiveFailure(error, archivePath, password, entry.encrypted);
    }
    if (bytes.byteLength > maximumBytes) {
        throw archiveFailure(
            "restore.archive_entry_too_large",
            `restore archive entry expanded beyond its bounded size: ${entry.filename}`,
            "unavailable",
            false,
        );
    }
    return bytes;
}

function assertArchiveIdentity(
    expected: ReturnType<typeof inspectRegularFileNoFollow>,
    actual: ReturnType<typeof inspectRegularFileNoFollow>,
    archivePath: string,
): void {
    if (samePhysicalPathIdentity(expected, actual)) return;
    throw archiveFailure(
        "restore.archive_changed",
        "restore archive identity changed during candidate validation",
        "conflict",
        true,
        archivePath,
    );
}

function requireFileEntry(entries: Entry[], filename: string): FileEntry {
    const entry = entries.find((candidate) => candidate.filename === filename);
    if (entry === undefined || entry.directory) {
        throw archiveFailure(
            "restore.archive_inventory_mismatch",
            `restore archive is missing required file ${filename}`,
            "invalid_schema",
            false,
        );
    }
    return entry;
}

function requireSafeArchiveFilename(filename: string): void {
    const segments = filename.split("/");
    if (
        filename.length === 0 ||
        filename.startsWith("/") ||
        filename.endsWith("/") ||
        filename.includes("\\") ||
        filename.includes("\0") ||
        segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
        throw archiveFailure(
            "restore.archive_path_invalid",
            `restore archive contains an unsafe path: ${filename}`,
            "invalid_schema",
            false,
        );
    }
}

function unsupportedUnixFileType(entry: Entry): boolean {
    const unixMode = entry.unixMode;
    if (unixMode === undefined) return false;
    const fileType = unixMode & UNIX_FILE_TYPE_MASK;
    return fileType !== 0 && fileType !== UNIX_REGULAR_FILE;
}

function parseManifestJson(bytes: Uint8Array): unknown {
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (error) {
        throw archiveFailure(
            "restore.manifest_invalid",
            `backup manifest is not strict UTF-8 JSON: ${String(error)}`,
            "invalid_schema",
            false,
        );
    }
}

function normalizeArchiveFailure(
    error: unknown,
    archivePath: string,
    password: string | undefined,
    encryptedEntry = false,
): StateRestoreError {
    if (error instanceof StateRestoreError) return error;
    const message = error instanceof Error ? error.message : String(error);
    // ZipCrypto authenticates only one header byte, so a wrong password can rarely reach payload integrity checks.
    const encryptedIntegrityFailure =
        encryptedEntry &&
        password !== undefined &&
        [ERR_INVALID_SIGNATURE, ERR_INVALID_COMPRESSED_DATA, ERR_INVALID_UNCOMPRESSED_SIZE].includes(message);
    if (
        message === ERR_INVALID_PASSWORD ||
        message === ERR_ENCRYPTED ||
        encryptedIntegrityFailure ||
        (password === undefined && /password/iu.test(message))
    ) {
        return archiveFailure(
            "restore.archive_password_invalid",
            "restore archive password is missing or invalid, or encrypted entry integrity validation failed",
            "permission_denied",
            true,
            archivePath,
        );
    }
    return archiveFailure(
        "restore.archive_invalid",
        `restore archive could not be validated: ${message}`,
        "invalid_schema",
        false,
        archivePath,
    );
}

function normalizeArchiveReadFailure(error: unknown, archivePath: string): StateRestoreError {
    if (error instanceof StateRestoreError) return error;
    if (error instanceof Error && "failureKind" in error) {
        return new StateRestoreError(
            `restore.archive_${String(error.failureKind)}`,
            error.message,
            error.failureKind === "not_found"
                ? "not_found"
                : error.failureKind === "permission_denied"
                  ? "permission_denied"
                  : error.failureKind === "resource_limit"
                    ? "unavailable"
                    : "internal_error",
            error.failureKind === "stale" || error.failureKind === "io_error",
            archivePath,
        );
    }
    return archiveFailure(
        "restore.archive_unreadable",
        `restore archive could not be read: ${String(error)}`,
        "unavailable",
        true,
        archivePath,
    );
}

function archiveFailure(
    code: string,
    message: string,
    causeKind: StateRestoreError["causeKind"],
    retryable: boolean,
    targetPath = "",
): StateRestoreError {
    return new StateRestoreError(code, message, causeKind, retryable, targetPath);
}

/** @internal Exact hostile-archive mechanics exposed only to fault tests. */
export const stateRestoreArchiveInternalsForTest = Object.freeze({
    assertArchiveIdentity,
    extractEntry,
    normalizeArchiveFailure,
    normalizeArchiveReadFailure,
    parseManifestJson,
    requireFileEntry,
    requireSafeArchiveFilename,
    unsupportedUnixFileType,
    validateArchiveEncryption,
    validateArchiveInventory,
    validateArchiveMetadata,
});
