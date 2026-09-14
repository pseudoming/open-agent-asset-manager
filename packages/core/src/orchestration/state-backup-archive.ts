import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import type { Sha256Digest, StateBackupEncryptionMode, StateBackupExecutionObserver, StateBackupPreparationV1 } from "../types";
import { stableStringify } from "../foundation/fingerprint";
import {
    BACKUP_MANIFEST_PATH,
    BACKUP_README_PATH,
    buildBackupManifest,
    type CapturedBackupSource,
    StateBackupError,
} from "./state-backup-model";
import { reportStateBackupProgress } from "./state-backup-progress";

const MINIMUM_ZIP_DATE = Date.UTC(1980, 0, 1);

export interface VerifiedBackupArchive {
    bytes: Uint8Array;
    manifestFingerprint: Sha256Digest;
}

export async function buildAndVerifyBackupArchive(
    source: CapturedBackupSource,
    preparation: StateBackupPreparationV1,
    password: string | undefined,
    observer?: StateBackupExecutionObserver,
): Promise<VerifiedBackupArchive> {
    const manifest = buildBackupManifest(source, preparation);
    const manifestBytes = new TextEncoder().encode(`${stableStringify(manifest)}\n`);
    const readmeBytes = new TextEncoder().encode(readmeText(preparation));
    const writer = new Uint8ArrayWriter();
    const zip = new ZipWriter(writer, { useWebWorkers: false });
    const options = zipEntryOptions(preparation, password);
    const packedEntryCount = source.entries.length + 2;
    reportStateBackupProgress(observer, "packing", 0, packedEntryCount);
    let closed = false;
    try {
        for (const [index, entry] of source.entries.entries()) {
            await zip.add(entry.logicalPath, new Uint8ArrayReader(entry.bytes), options);
            reportStateBackupProgress(observer, "packing", index + 1, packedEntryCount);
        }
        await zip.add(BACKUP_MANIFEST_PATH, new Uint8ArrayReader(manifestBytes), options);
        reportStateBackupProgress(observer, "packing", source.entries.length + 1, packedEntryCount);
        await zip.add(BACKUP_README_PATH, new Uint8ArrayReader(readmeBytes), options);
        reportStateBackupProgress(observer, "packing", packedEntryCount, packedEntryCount);
        const archive = await zip.close();
        closed = true;
        if (preparation.encryptionMode !== "none") {
            reportStateBackupProgress(observer, "encryption", 1, 1);
        }
        await verifyBackupArchive(archive, source, manifestBytes, readmeBytes, preparation.encryptionMode, password, observer);
        return { bytes: archive, manifestFingerprint: manifest.manifestFingerprint };
    } catch (error) {
        await cleanupIncompleteArchive(closed, zip);
        return rethrowArchiveFailure(error);
    }
}

function rethrowArchiveFailure(error: unknown): never {
    if (error instanceof StateBackupError) throw error;
    throw new StateBackupError(
        "backup.archive_failed",
        `backup archive creation or verification failed: ${String(error)}`,
        "verification_failed",
        false,
    );
}

async function cleanupIncompleteArchive(closed: boolean, zip: Pick<ZipWriter<Uint8Array>, "close">): Promise<void> {
    if (!closed) await closeIncompleteZip(zip);
}

async function closeIncompleteZip(zip: Pick<ZipWriter<Uint8Array>, "close">): Promise<void> {
    try {
        await zip.close();
    } catch {
        // Preserve the original archive-construction failure.
    }
}

function zipEntryOptions(
    preparation: StateBackupPreparationV1,
    password: string | undefined,
): {
    level: number;
    lastModDate: Date;
    password?: string;
    zipCrypto?: boolean;
    encryptionStrength?: 3;
} {
    const base = {
        level: 6,
        lastModDate: new Date(Math.max(preparation.createdAt, MINIMUM_ZIP_DATE)),
    };
    if (preparation.encryptionMode === "none") return base;
    if (preparation.encryptionMode === "compatible_password") return { ...base, password, zipCrypto: true };
    return { ...base, password, encryptionStrength: 3 };
}

async function verifyBackupArchive(
    archive: Uint8Array,
    source: CapturedBackupSource,
    manifestBytes: Uint8Array,
    readmeBytes: Uint8Array,
    encryptionMode: StateBackupEncryptionMode,
    password: string | undefined,
    observer?: StateBackupExecutionObserver,
): Promise<void> {
    const reader = new ZipReader(new Uint8ArrayReader(archive));
    try {
        const entries = await reader.getEntries();
        const expected = new Map<string, Uint8Array>([
            ...source.entries.map((entry) => [entry.logicalPath, entry.bytes] as const),
            [BACKUP_MANIFEST_PATH, manifestBytes],
            [BACKUP_README_PATH, readmeBytes],
        ]);
        reportStateBackupProgress(observer, "verification", 0, expected.size);
        if (
            entries.length !== expected.size ||
            entries.some((entry) => !expected.has(entry.filename)) ||
            new Set(entries.map((entry) => entry.filename)).size !== entries.length
        ) {
            throw new StateBackupError(
                "backup.archive_inventory_mismatch",
                "verified ZIP inventory does not match the prepared backup closure",
                "verification_failed",
                false,
            );
        }
        for (const [index, entry] of entries.entries()) {
            if (entry.directory || !("getData" in entry)) {
                throw new StateBackupError(
                    "backup.archive_inventory_mismatch",
                    "verified ZIP contains an unexpected directory entry",
                    "verification_failed",
                    false,
                );
            }
            const expectedBytes = expected.get(entry.filename) as Uint8Array;
            const actual = await entry.getData(new Uint8ArrayWriter(), { password });
            if (!Buffer.from(actual).equals(Buffer.from(expectedBytes))) {
                throw new StateBackupError(
                    "backup.archive_body_mismatch",
                    `verified ZIP entry does not match its prepared bytes: ${entry.filename}`,
                    "verification_failed",
                    false,
                );
            }
            if ((encryptionMode === "none") === entry.encrypted) {
                throw new StateBackupError(
                    "backup.archive_encryption_mismatch",
                    "verified ZIP encryption state does not match the selected mode",
                    "verification_failed",
                    false,
                );
            }
            reportStateBackupProgress(observer, "verification", index + 1, expected.size);
        }
    } finally {
        await reader.close();
    }
}

function readmeText(preparation: StateBackupPreparationV1): string {
    return [
        "Open Agent Asset Manager state backup",
        "",
        "This standard ZIP contains a complete OAAM state snapshot.",
        "Asset files are available below oaam/assets/.",
        "manifest.json records exact SHA-256 hashes and ownership roles.",
        `Backup ID: ${preparation.backupId}`,
        `Created at (epoch ms): ${String(preparation.createdAt)}`,
        "",
    ].join("\n");
}

/** @internal Exact archive codec seams exposed only to hostile-archive tests. */
export const stateBackupArchiveInternalsForTest = Object.freeze({
    cleanupIncompleteArchive,
    closeIncompleteZip,
    rethrowArchiveFailure,
    verifyBackupArchive,
    zipEntryOptions,
});
