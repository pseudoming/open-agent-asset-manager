import { SafeFilesystemError } from "@oaam/shared/filesystem";
import type {
    CoreResult,
    EpochMillis,
    OperationDiagnostic,
    Sha256Digest,
    StateBackupEncryptionMode,
    StateBackupPreparationV1,
    UuidV4,
} from "../types";
import { fingerprintDomain } from "../foundation/fingerprint";
import { isSha256Digest, isUuidV4 } from "../foundation/validators";

export const BACKUP_FORMAT = "oaam-state-backup-v1" as const;
export const BACKUP_MANIFEST_PATH = "manifest.json";
export const BACKUP_README_PATH = "README.txt";
export const MAXIMUM_BACKUP_FILES = 100_000;
export const MAXIMUM_BACKUP_LOGICAL_BYTES = 512 * 1024 * 1024;
export const ARCHIVE_FIXED_OVERHEAD = 1024 * 1024;
export const ARCHIVE_PER_ENTRY_OVERHEAD = 4096;

export type BackupOwner =
    | "state_database"
    | "asset_authority"
    | "project_authority"
    | "deployment_authority"
    | "recovery_material"
    | "settings_authority"
    | "desktop_preferences"
    | "profile_material";

export interface CapturedBackupEntry {
    logicalPath: string;
    owner: BackupOwner;
    contentHash: Sha256Digest;
    byteSize: number;
    executable: boolean;
    bytes: Uint8Array;
}

export interface BackupManifestEntryV1 {
    logicalPath: string;
    owner: BackupOwner;
    contentHash: Sha256Digest;
    byteSize: number;
    executable: boolean;
}

export interface BackupManifestV1 {
    format: typeof BACKUP_FORMAT;
    schemaVersion: 1;
    backupId: UuidV4;
    createdAt: EpochMillis;
    encryptionMode: StateBackupEncryptionMode;
    sourceFileCount: number;
    sourceLogicalBytes: number;
    sourceSnapshotFingerprint: Sha256Digest;
    entries: BackupManifestEntryV1[];
    manifestFingerprint: Sha256Digest;
}

export interface CapturedBackupSource {
    entries: CapturedBackupEntry[];
    sourceFileCount: number;
    sourceLogicalBytes: number;
    sourceSnapshotFingerprint: Sha256Digest;
}

export class StateBackupError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly causeKind: OperationDiagnostic["causeKind"],
        readonly retryable: boolean,
        readonly targetPath = "",
    ) {
        super(message);
    }
}

export function manifestEntry(entry: CapturedBackupEntry): BackupManifestEntryV1 {
    return {
        logicalPath: entry.logicalPath,
        owner: entry.owner,
        contentHash: entry.contentHash,
        byteSize: entry.byteSize,
        executable: entry.executable,
    };
}

export function buildBackupManifest(source: CapturedBackupSource, preparation: StateBackupPreparationV1): BackupManifestV1 {
    const preimage: Omit<BackupManifestV1, "manifestFingerprint"> = {
        format: BACKUP_FORMAT,
        schemaVersion: 1,
        backupId: preparation.backupId,
        createdAt: preparation.createdAt,
        encryptionMode: preparation.encryptionMode,
        sourceFileCount: source.sourceFileCount,
        sourceLogicalBytes: source.sourceLogicalBytes,
        sourceSnapshotFingerprint: source.sourceSnapshotFingerprint,
        entries: source.entries.map(manifestEntry),
    };
    return {
        ...preimage,
        manifestFingerprint: fingerprintDomain("oaam.backup.manifest.v1", preimage),
    };
}

export function backupOutputFileName(createdAt: EpochMillis, backupId: UuidV4): string {
    return `oaam-backup-${String(createdAt)}-${backupId}.zip`;
}

export function requireBackupEncryptionMode(value: unknown): StateBackupEncryptionMode {
    if (value !== "none" && value !== "compatible_password" && value !== "strong_password") {
        throw new StateBackupError(
            "backup.encryption_mode_invalid",
            "backup encryption mode is invalid",
            "invalid_schema",
            false,
        );
    }
    return value;
}

export function validateBackupPassword(mode: StateBackupEncryptionMode, password: string | undefined): void {
    if (mode === "none" && password !== undefined) {
        throw new StateBackupError(
            "backup.password_unexpected",
            "an unencrypted backup must not receive a password",
            "invalid_schema",
            false,
        );
    }
    if (mode !== "none" && (password === undefined || password.length === 0 || password.includes("\0"))) {
        throw new StateBackupError(
            "backup.password_missing",
            "the selected password backup mode requires a non-empty transient password",
            "invalid_schema",
            false,
        );
    }
}

export function validateBackupPreparation(preparation: StateBackupPreparationV1): void {
    const numbers = [
        preparation.createdAt,
        preparation.sourceFileCount,
        preparation.sourceLogicalBytes,
        preparation.requiredAvailableBytes,
        preparation.availableBytes,
    ];
    const destinationKind = preparation.destination.destinationKind;
    const destinationState = preparation.destination.directoryState;
    if (
        preparation.schemaVersion !== 1 ||
        !isUuidV4(preparation.backupId) ||
        numbers.some((value) => !Number.isSafeInteger(value) || value < 0) ||
        preparation.sourceFileCount > MAXIMUM_BACKUP_FILES ||
        preparation.sourceLogicalBytes > MAXIMUM_BACKUP_LOGICAL_BYTES ||
        preparation.requiredAvailableBytes < preparation.sourceLogicalBytes ||
        preparation.outputFileName !== backupOutputFileName(preparation.createdAt, preparation.backupId) ||
        (destinationKind !== "oaam_default" && destinationKind !== "custom_directory") ||
        (destinationState !== "ready" && destinationState !== "create_required") ||
        (destinationKind === "custom_directory" && destinationState !== "ready") ||
        preparation.destination.directoryPath.length === 0 ||
        preparation.destination.directoryPath.includes("\0") ||
        !isSha256Digest(preparation.sourceSnapshotFingerprint) ||
        !isSha256Digest(preparation.destinationFingerprint) ||
        !isSha256Digest(preparation.preparationFingerprint)
    ) {
        throw new StateBackupError(
            "backup.preparation_invalid",
            "backup preparation has an invalid authority shape",
            "invalid_schema",
            false,
        );
    }
    requireBackupEncryptionMode(preparation.encryptionMode);
    const preimage = backupPreparationPreimage(preparation);
    if (fingerprintDomain("oaam.backup.preparation.v1", preimage) !== preparation.preparationFingerprint) {
        throw new StateBackupError(
            "backup.preparation_modified",
            "backup preparation no longer matches its Core fingerprint",
            "conflict",
            true,
        );
    }
}

export function backupPreparationPreimage(
    preparation: StateBackupPreparationV1,
): Omit<StateBackupPreparationV1, "preparationFingerprint"> {
    return {
        schemaVersion: preparation.schemaVersion,
        backupId: preparation.backupId,
        createdAt: preparation.createdAt,
        destination: {
            destinationKind: preparation.destination.destinationKind,
            directoryPath: preparation.destination.directoryPath,
            directoryState: preparation.destination.directoryState,
        },
        outputFileName: preparation.outputFileName,
        encryptionMode: preparation.encryptionMode,
        sourceFileCount: preparation.sourceFileCount,
        sourceLogicalBytes: preparation.sourceLogicalBytes,
        requiredAvailableBytes: preparation.requiredAvailableBytes,
        availableBytes: preparation.availableBytes,
        sourceSnapshotFingerprint: preparation.sourceSnapshotFingerprint,
        destinationFingerprint: preparation.destinationFingerprint,
    };
}

export function assertPortableBackupPaths(paths: string[]): void {
    const comparisonKeys = new Set<string>();
    for (const logicalPath of [...paths, BACKUP_MANIFEST_PATH, BACKUP_README_PATH]) {
        const segments = logicalPath.split("/");
        if (
            logicalPath.length === 0 ||
            logicalPath.startsWith("/") ||
            logicalPath.endsWith("/") ||
            logicalPath.includes("\\") ||
            logicalPath.includes("\0") ||
            segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
        ) {
            throw new StateBackupError(
                "backup.archive_path_invalid",
                `backup source path is not portable in a standard ZIP: ${logicalPath}`,
                "invalid_schema",
                false,
            );
        }
        const comparisonKey = logicalPath.normalize("NFC").toLowerCase();
        if (comparisonKeys.has(comparisonKey)) {
            throw new StateBackupError(
                "backup.archive_path_collision",
                `backup source paths collide on a case-insensitive extraction target: ${logicalPath}`,
                "conflict",
                false,
            );
        }
        comparisonKeys.add(comparisonKey);
    }
}

export function failedBackupResult<T>(error: unknown): CoreResult<T> {
    const normalized = normalizeBackupError(error);
    return {
        status: "failed",
        value: undefined as T,
        diagnostics: [
            {
                severity: "error",
                code: normalized.code,
                message: normalized.message,
                path: normalized.targetPath,
                traceId: "",
                operation: "backup",
                causeKind: normalized.causeKind,
                retryable: normalized.retryable,
                suggestedActions: normalized.retryable ? ["retry"] : [],
                rawSummary: normalized.message,
            },
        ],
    };
}

function normalizeBackupError(error: unknown): StateBackupError {
    if (error instanceof StateBackupError) return error;
    if (error instanceof SafeFilesystemError) {
        const causeKind: OperationDiagnostic["causeKind"] =
            error.failureKind === "not_found"
                ? "not_found"
                : error.failureKind === "permission_denied"
                  ? "permission_denied"
                  : error.failureKind === "stale"
                    ? "conflict"
                    : error.failureKind === "resource_limit"
                      ? "unavailable"
                      : "internal_error";
        return new StateBackupError(
            `backup.filesystem_${error.failureKind}`,
            error.message,
            causeKind,
            error.failureKind === "stale" || error.failureKind === "io_error",
            error.targetPath,
        );
    }
    return new StateBackupError("backup.internal_failure", `backup operation failed: ${String(error)}`, "internal_error", false);
}
