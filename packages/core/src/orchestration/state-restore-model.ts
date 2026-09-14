import * as path from "node:path";
import { type PhysicalPathIdentity, SafeFilesystemError } from "@oaam/shared/filesystem";
import { fingerprintDomain } from "../foundation/fingerprint";
import { hasExactKeys, isNonNegativeInteger, isSha256Digest, isStrictObject, isUuidV4 } from "../foundation/validators";
import type { CoreResult, OperationDiagnostic, Sha256Digest, StateRestorePreparationV1, UuidV4 } from "../types";
import {
    BACKUP_FORMAT,
    type BackupManifestEntryV1,
    type BackupManifestV1,
    type BackupOwner,
    type CapturedBackupEntry,
    type CapturedBackupSource,
    MAXIMUM_BACKUP_FILES,
    MAXIMUM_BACKUP_LOGICAL_BYTES,
    manifestEntry,
    requireBackupEncryptionMode,
} from "./state-backup-model";

export const MAXIMUM_RESTORE_ARCHIVE_BYTES = 768 * 1024 * 1024;
export const RESTORE_TRANSACTION_FORMAT = "oaam-state-restore-transaction-v1" as const;
export const RESTORE_MARKER_NAME = "restore.json";
export const RESTORE_STAGED_NAME = "staged";
export const RESTORE_DISPLACED_NAME = "displaced";

export type StateRestoreMarkerPhase =
    | "staging"
    | "candidate_ready"
    | "live_displaced"
    | "activated"
    | "reprojecting"
    | "aborted"
    | "reconciled";

export interface StateRestoreMarkerV1 {
    format: typeof RESTORE_TRANSACTION_FORMAT;
    schemaVersion: 1;
    restoreId: UuidV4;
    backupId: UuidV4;
    archiveContentHash: Sha256Digest;
    sourceSnapshotFingerprint: Sha256Digest;
    profileSnapshotFingerprint: Sha256Digest;
    oaamRoot: string;
    databasePath: string;
    transactionPath: string;
    stagedPath: string;
    displacedPath: string;
    phase: StateRestoreMarkerPhase;
    markerFingerprint: Sha256Digest;
}

export interface ValidatedStateRestoreCandidate {
    archivePath: string;
    archiveByteSize: number;
    archiveContentHash: Sha256Digest;
    archiveIdentity: PhysicalPathIdentity;
    manifest: BackupManifestV1;
    source: CapturedBackupSource;
    desktopPreferences?: Uint8Array;
}

export class StateRestoreError extends Error {
    public constructor(
        readonly code: string,
        message: string,
        readonly causeKind: OperationDiagnostic["causeKind"],
        readonly retryable: boolean,
        readonly targetPath = "",
    ) {
        super(message);
    }
}

export function requireCanonicalRestoreArchivePath(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.includes("\0") ||
        !path.isAbsolute(value) ||
        path.normalize(value) !== value ||
        value === path.parse(value).root ||
        value.endsWith(path.sep)
    ) {
        throw new StateRestoreError(
            "restore.archive_path_invalid",
            "restore archive path must be a canonical non-root absolute file path",
            "invalid_schema",
            false,
            typeof value === "string" ? value : "",
        );
    }
    return value;
}

export function validateStateRestorePreparation(preparation: StateRestorePreparationV1): void {
    if (
        preparation.schemaVersion !== 1 ||
        !isNonNegativeSafeInteger(preparation.archiveByteSize) ||
        preparation.archiveByteSize > MAXIMUM_RESTORE_ARCHIVE_BYTES ||
        !isSha256Digest(preparation.archiveContentHash) ||
        !isUuidV4(preparation.backupId) ||
        !isNonNegativeSafeInteger(preparation.backupCreatedAt) ||
        !isNonNegativeSafeInteger(preparation.sourceFileCount) ||
        preparation.sourceFileCount > MAXIMUM_BACKUP_FILES ||
        !isNonNegativeSafeInteger(preparation.sourceLogicalBytes) ||
        preparation.sourceLogicalBytes > MAXIMUM_BACKUP_LOGICAL_BYTES ||
        !isSha256Digest(preparation.sourceSnapshotFingerprint) ||
        !isSha256Digest(preparation.manifestFingerprint) ||
        typeof preparation.includesDesktopPreferences !== "boolean" ||
        !isSha256Digest(preparation.preparationFingerprint)
    ) {
        throw invalidPreparation("restore preparation has an invalid authority shape");
    }
    requireCanonicalRestoreArchivePath(preparation.archivePath);
    requireBackupEncryptionMode(preparation.encryptionMode);
    if (
        fingerprintDomain("oaam.restore.preparation.v1", restorePreparationPreimage(preparation)) !==
        preparation.preparationFingerprint
    ) {
        throw new StateRestoreError(
            "restore.preparation_modified",
            "restore preparation no longer matches its Core fingerprint",
            "conflict",
            true,
            preparation.archivePath,
        );
    }
}

export function restorePreparationPreimage(
    preparation: StateRestorePreparationV1,
): Omit<StateRestorePreparationV1, "preparationFingerprint"> {
    return {
        schemaVersion: preparation.schemaVersion,
        archivePath: preparation.archivePath,
        archiveByteSize: preparation.archiveByteSize,
        archiveContentHash: preparation.archiveContentHash,
        backupId: preparation.backupId,
        backupCreatedAt: preparation.backupCreatedAt,
        encryptionMode: preparation.encryptionMode,
        sourceFileCount: preparation.sourceFileCount,
        sourceLogicalBytes: preparation.sourceLogicalBytes,
        sourceSnapshotFingerprint: preparation.sourceSnapshotFingerprint,
        manifestFingerprint: preparation.manifestFingerprint,
        includesDesktopPreferences: preparation.includesDesktopPreferences,
    };
}

export function validateBackupManifestDocument(value: unknown): BackupManifestV1 {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "format",
            "schemaVersion",
            "backupId",
            "createdAt",
            "encryptionMode",
            "sourceFileCount",
            "sourceLogicalBytes",
            "sourceSnapshotFingerprint",
            "entries",
            "manifestFingerprint",
        ]) ||
        value.format !== BACKUP_FORMAT ||
        value.schemaVersion !== 1 ||
        !isUuidV4(value.backupId) ||
        !isNonNegativeSafeInteger(value.createdAt) ||
        !isNonNegativeSafeInteger(value.sourceFileCount) ||
        value.sourceFileCount > MAXIMUM_BACKUP_FILES ||
        !isNonNegativeSafeInteger(value.sourceLogicalBytes) ||
        value.sourceLogicalBytes > MAXIMUM_BACKUP_LOGICAL_BYTES ||
        !isSha256Digest(value.sourceSnapshotFingerprint) ||
        !Array.isArray(value.entries) ||
        !isSha256Digest(value.manifestFingerprint)
    ) {
        throw malformedManifest("backup manifest has an invalid strict top-level shape");
    }
    const encryptionMode = requireBackupEncryptionMode(value.encryptionMode);
    const entries = value.entries.map(validateManifestEntry);
    if (entries.length !== value.sourceFileCount) {
        throw malformedManifest("backup manifest file count does not match its entry inventory");
    }
    const sourceLogicalBytes = entries.reduce((sum, entry) => sum + entry.byteSize, 0);
    if (!Number.isSafeInteger(sourceLogicalBytes) || sourceLogicalBytes !== value.sourceLogicalBytes) {
        throw malformedManifest("backup manifest logical byte count does not match its entry inventory");
    }
    assertManifestEntryOrderAndOwnership(entries);
    const sourceSnapshotFingerprint = fingerprintDomain("oaam.backup.source-snapshot.v1", entries);
    if (sourceSnapshotFingerprint !== value.sourceSnapshotFingerprint) {
        throw malformedManifest("backup manifest source snapshot fingerprint does not match its entry inventory");
    }
    const preimage: Omit<BackupManifestV1, "manifestFingerprint"> = {
        format: BACKUP_FORMAT,
        schemaVersion: 1,
        backupId: value.backupId,
        createdAt: value.createdAt,
        encryptionMode,
        sourceFileCount: value.sourceFileCount,
        sourceLogicalBytes: value.sourceLogicalBytes,
        sourceSnapshotFingerprint: value.sourceSnapshotFingerprint,
        entries,
    };
    if (fingerprintDomain("oaam.backup.manifest.v1", preimage) !== value.manifestFingerprint) {
        throw malformedManifest("backup manifest fingerprint does not match its strict body");
    }
    return { ...preimage, manifestFingerprint: value.manifestFingerprint };
}

export function buildRestoreMarker(
    input: Omit<StateRestoreMarkerV1, "format" | "schemaVersion" | "markerFingerprint">,
): StateRestoreMarkerV1 {
    const preimage: Omit<StateRestoreMarkerV1, "markerFingerprint"> = {
        format: RESTORE_TRANSACTION_FORMAT,
        schemaVersion: 1,
        ...input,
    };
    return {
        ...preimage,
        markerFingerprint: fingerprintDomain("oaam.restore.transaction-marker.v1", preimage),
    };
}

export function validateStateRestoreMarkerDocument(value: unknown): StateRestoreMarkerV1 {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "format",
            "schemaVersion",
            "restoreId",
            "backupId",
            "archiveContentHash",
            "sourceSnapshotFingerprint",
            "profileSnapshotFingerprint",
            "oaamRoot",
            "databasePath",
            "transactionPath",
            "stagedPath",
            "displacedPath",
            "phase",
            "markerFingerprint",
        ]) ||
        value.format !== RESTORE_TRANSACTION_FORMAT ||
        value.schemaVersion !== 1 ||
        !isUuidV4(value.restoreId) ||
        !isUuidV4(value.backupId) ||
        !isSha256Digest(value.archiveContentHash) ||
        !isSha256Digest(value.sourceSnapshotFingerprint) ||
        !isSha256Digest(value.profileSnapshotFingerprint) ||
        !isCanonicalNonRootAbsolutePath(value.oaamRoot) ||
        !isCanonicalNonRootAbsolutePath(value.databasePath) ||
        !isCanonicalNonRootAbsolutePath(value.transactionPath) ||
        !isCanonicalNonRootAbsolutePath(value.stagedPath) ||
        !isCanonicalNonRootAbsolutePath(value.displacedPath) ||
        !isStateRestoreMarkerPhase(value.phase) ||
        !isSha256Digest(value.markerFingerprint)
    ) {
        throw new StateRestoreError(
            "restore.marker_invalid",
            "State restore transaction marker has an invalid strict shape",
            "invalid_schema",
            false,
        );
    }
    const marker = value as unknown as StateRestoreMarkerV1;
    const preimage: Omit<StateRestoreMarkerV1, "markerFingerprint"> = {
        format: marker.format,
        schemaVersion: marker.schemaVersion,
        restoreId: marker.restoreId,
        backupId: marker.backupId,
        archiveContentHash: marker.archiveContentHash,
        sourceSnapshotFingerprint: marker.sourceSnapshotFingerprint,
        profileSnapshotFingerprint: marker.profileSnapshotFingerprint,
        oaamRoot: marker.oaamRoot,
        databasePath: marker.databasePath,
        transactionPath: marker.transactionPath,
        stagedPath: marker.stagedPath,
        displacedPath: marker.displacedPath,
        phase: marker.phase,
    };
    if (fingerprintDomain("oaam.restore.transaction-marker.v1", preimage) !== marker.markerFingerprint) {
        throw new StateRestoreError(
            "restore.marker_fingerprint_mismatch",
            "State restore transaction marker fingerprint does not match its strict body",
            "verification_failed",
            false,
            marker.transactionPath,
        );
    }
    return marker;
}

export function profileSnapshotFingerprintForEntries(entries: readonly CapturedBackupEntry[]): Sha256Digest {
    return fingerprintDomain(
        "oaam.backup.source-snapshot.v1",
        entries.filter((entry) => entry.owner !== "desktop_preferences").map(manifestEntry),
    );
}

export function isTerminalStateRestoreMarkerPhase(phase: StateRestoreMarkerPhase): boolean {
    return phase === "aborted" || phase === "reconciled";
}

export function serializeRestoreMarker(marker: StateRestoreMarkerV1): string {
    return `${JSON.stringify(marker, null, 2)}\n`;
}

export function failedRestoreResult<T>(error: unknown): CoreResult<T> {
    const normalized = normalizeRestoreError(error);
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
                operation: "restore",
                causeKind: normalized.causeKind,
                retryable: normalized.retryable,
                suggestedActions: normalized.retryable ? ["retry"] : [],
                rawSummary: normalized.message,
            },
        ],
    };
}

export function capturedRestoreSource(entries: CapturedBackupEntry[], manifest: BackupManifestV1): CapturedBackupSource {
    return {
        entries,
        sourceFileCount: manifest.sourceFileCount,
        sourceLogicalBytes: manifest.sourceLogicalBytes,
        sourceSnapshotFingerprint: manifest.sourceSnapshotFingerprint,
    };
}

function validateManifestEntry(value: unknown): BackupManifestEntryV1 {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, ["logicalPath", "owner", "contentHash", "byteSize", "executable"]) ||
        typeof value.logicalPath !== "string" ||
        !isBackupOwner(value.owner) ||
        !isSha256Digest(value.contentHash) ||
        !isNonNegativeSafeInteger(value.byteSize) ||
        value.byteSize > MAXIMUM_BACKUP_LOGICAL_BYTES ||
        typeof value.executable !== "boolean"
    ) {
        throw malformedManifest("backup manifest contains an invalid entry");
    }
    return {
        logicalPath: value.logicalPath,
        owner: value.owner,
        contentHash: value.contentHash as Sha256Digest,
        byteSize: value.byteSize,
        executable: value.executable,
    };
}

function assertManifestEntryOrderAndOwnership(entries: BackupManifestEntryV1[]): void {
    let previous = "";
    let stateDatabaseCount = 0;
    const comparisonKeys = new Set<string>();
    for (const entry of entries) {
        const key = portableLogicalPathKey(entry.logicalPath);
        if (comparisonKeys.has(key)) throw malformedManifest("backup manifest contains colliding logical paths");
        comparisonKeys.add(key);
        if (previous !== "" && Buffer.compare(Buffer.from(previous), Buffer.from(entry.logicalPath)) >= 0) {
            throw malformedManifest("backup manifest entries are not in canonical UTF-8 byte order");
        }
        previous = entry.logicalPath;
        if (entry.owner !== requiredOwnerForLogicalPath(entry.logicalPath)) {
            throw malformedManifest(`backup manifest owner does not match logical path ${entry.logicalPath}`);
        }
        if (entry.logicalPath === "state/oaam.sqlite") stateDatabaseCount += 1;
    }
    if (stateDatabaseCount !== 1) throw malformedManifest("backup manifest must contain exactly one State DB");
}

function requiredOwnerForLogicalPath(logicalPath: string): BackupOwner {
    portableLogicalPathKey(logicalPath);
    const segments = logicalPath.split("/");
    if (logicalPath === "state/oaam.sqlite") return "state_database";
    if (logicalPath === "desktop/desktop-preferences.json") return "desktop_preferences";
    if (segments[0] !== "oaam" || segments.length < 2) {
        throw malformedManifest(`backup manifest contains an unsupported logical path ${logicalPath}`);
    }
    if (["backups", "cache", "logs"].includes(segments[1] as string)) {
        throw malformedManifest(`backup manifest contains excluded profile material ${logicalPath}`);
    }
    if (segments[1] === "assets") return "asset_authority";
    if (segments[1] === "projects") return "project_authority";
    if (segments[1] === "deployments") return "deployment_authority";
    if (segments[1] === "transactions") {
        if (segments[2] === "locks" || segments[2] === "authority-locks") {
            throw malformedManifest(`backup manifest contains excluded lock material ${logicalPath}`);
        }
        return "recovery_material";
    }
    if (segments.length === 2 && segments[1] === "settings.json") return "settings_authority";
    return "profile_material";
}

function portableLogicalPathKey(logicalPath: string): string {
    const segments = logicalPath.split("/");
    if (
        logicalPath.length === 0 ||
        logicalPath.startsWith("/") ||
        logicalPath.endsWith("/") ||
        logicalPath.includes("\\") ||
        logicalPath.includes("\0") ||
        segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
        throw malformedManifest(`backup manifest path is not portable: ${logicalPath}`);
    }
    return logicalPath.normalize("NFC").toLowerCase();
}

function isBackupOwner(value: unknown): value is BackupOwner {
    return (
        value === "state_database" ||
        value === "asset_authority" ||
        value === "project_authority" ||
        value === "deployment_authority" ||
        value === "recovery_material" ||
        value === "settings_authority" ||
        value === "desktop_preferences" ||
        value === "profile_material"
    );
}

function isStateRestoreMarkerPhase(value: unknown): value is StateRestoreMarkerPhase {
    return (
        value === "staging" ||
        value === "candidate_ready" ||
        value === "live_displaced" ||
        value === "activated" ||
        value === "reprojecting" ||
        value === "aborted" ||
        value === "reconciled"
    );
}

function isCanonicalNonRootAbsolutePath(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        !value.includes("\0") &&
        path.isAbsolute(value) &&
        path.normalize(value) === value &&
        value !== path.parse(value).root &&
        !value.endsWith(path.sep)
    );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return isNonNegativeInteger(value) && Number.isSafeInteger(value);
}

function invalidPreparation(message: string): StateRestoreError {
    return new StateRestoreError("restore.preparation_invalid", message, "invalid_schema", false);
}

function malformedManifest(message: string): StateRestoreError {
    return new StateRestoreError("restore.manifest_invalid", message, "invalid_schema", false);
}

function normalizeRestoreError(error: unknown): StateRestoreError {
    if (error instanceof StateRestoreError) return error;
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
        return new StateRestoreError(
            `restore.filesystem_${error.failureKind}`,
            error.message,
            causeKind,
            error.failureKind === "stale" || error.failureKind === "io_error",
            error.targetPath,
        );
    }
    return new StateRestoreError(
        "restore.internal_failure",
        `restore operation failed: ${String(error)}`,
        "internal_error",
        false,
    );
}

/** @internal Exact pure validators for hostile restore tests. */
export const stateRestoreModelInternalsForTest = Object.freeze({
    assertManifestEntryOrderAndOwnership,
    buildRestoreMarker,
    capturedRestoreSource,
    failedRestoreResult,
    portableLogicalPathKey,
    requiredOwnerForLogicalPath,
    restorePreparationPreimage,
    normalizeRestoreError,
    profileSnapshotFingerprintForEntries,
    validateBackupManifestDocument,
    validateStateRestoreMarkerDocument,
    validateStateRestorePreparation,
});
