import * as path from "node:path";
import {
    durableEnsureDirectory,
    durableRecycleRegularFileIfIdentity,
    durableReplaceFile,
    readRegularFileNoFollow,
    SafeFilesystemError,
    samePhysicalPathIdentity,
    type PhysicalPathIdentity,
} from "@oaam/shared/filesystem";
import type {
    StateBackupArtifactV1,
    StateBackupInventoryEntryV1,
    StateBackupInventoryV1,
    StateBackupExecutionObserver,
    StateBackupPreparationV1,
    StateBackupRetirementV1,
    UuidV4,
} from "../types";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { fingerprintDomain, stableStringify } from "../foundation/fingerprint";
import { compareCodeUnitText } from "../foundation/fingerprint-base";
import { hasExactKeys, isSha256Digest, isStrictObject, isUuidV4 } from "../foundation/validators";
import { backupOutputFileName } from "./state-backup-model";
import { reportStateBackupProgress } from "./state-backup-progress";

interface StateBackupCatalogEntryV1 extends StateBackupArtifactV1 {
    physicalIdentity: PhysicalPathIdentity;
}

interface StateBackupCatalogV1 {
    format: "oaam-state-backup-catalog-v1";
    schemaVersion: 1;
    entries: StateBackupCatalogEntryV1[];
    catalogFingerprint: `sha256:${string}`;
}

const CATALOG_FILE_NAME = "catalog.json";
const MAXIMUM_CATALOG_BYTES = 16 * 1024 * 1024;

export function listStateBackupInventory(oaamRoot: string, observer?: StateBackupExecutionObserver): StateBackupInventoryV1 {
    const catalog = readCatalog(oaamRoot);
    reportStateBackupProgress(observer, "inventory", 0, catalog.entries.length);
    const entries = catalog.entries
        .map((entry, index) => {
            const observed = observeEntry(oaamRoot, entry);
            reportStateBackupProgress(observer, "inventory", index + 1, catalog.entries.length);
            return observed;
        })
        .sort((left, right) => right.createdAt - left.createdAt || compareCodeUnitText(left.backupId, right.backupId));
    return {
        schemaVersion: 1,
        entries,
        totalKnownArchiveBytes: entries.reduce((total, entry) => total + entry.archiveByteSize, 0),
        totalAvailableArchiveBytes: entries.reduce(
            (total, entry) => total + (entry.observation === "available" ? entry.archiveByteSize : 0),
            0,
        ),
    };
}

export function registerStateBackupArtifact(
    oaamRoot: string,
    preparation: StateBackupPreparationV1,
    artifact: StateBackupArtifactV1,
): void {
    const expectedPath = path.join(preparation.destination.directoryPath, preparation.outputFileName);
    if (
        artifact.backupId !== preparation.backupId ||
        artifact.createdAt !== preparation.createdAt ||
        artifact.archivePath !== expectedPath ||
        artifact.encryptionMode !== preparation.encryptionMode ||
        artifact.sourceSnapshotFingerprint !== preparation.sourceSnapshotFingerprint
    ) {
        throw new Error("committed State backup does not match its retained preparation");
    }
    const committed = readRegularFileNoFollow(artifact.archivePath, artifact.archiveByteSize);
    if (committed.bytes.byteLength !== artifact.archiveByteSize || sha256Bytes(committed.bytes) !== artifact.archiveContentHash) {
        throw new Error("committed State backup changed before inventory registration");
    }
    const catalog = readCatalog(oaamRoot);
    if (catalog.entries.some((entry) => entry.backupId === artifact.backupId)) {
        throw new Error("State backup inventory already contains this backup identity");
    }
    writeCatalog(oaamRoot, [
        ...catalog.entries,
        {
            ...structuredClone(artifact),
            physicalIdentity: committed.identity,
        },
    ]);
}

export function recycleStateBackupArtifact(
    oaamRoot: string,
    backupId: UuidV4,
    recycleFileIfIdentity: (
        filePath: string,
        expectedIdentity: PhysicalPathIdentity,
    ) => boolean = durableRecycleRegularFileIfIdentity,
): StateBackupRetirementV1 {
    const catalog = readCatalog(oaamRoot);
    const entry = catalog.entries.find((candidate) => candidate.backupId === backupId);
    if (entry === undefined) throw new Error("State backup inventory does not contain this backup identity");
    const observed = readRegularFileNoFollow(entry.archivePath, entry.archiveByteSize);
    if (
        observed.bytes.byteLength !== entry.archiveByteSize ||
        sha256Bytes(observed.bytes) !== entry.archiveContentHash ||
        !samePhysicalPathIdentity(observed.identity, entry.physicalIdentity)
    ) {
        throw new Error("State backup changed before identity-bound recycle");
    }
    if (!recycleFileIfIdentity(entry.archivePath, entry.physicalIdentity)) {
        throw new Error("State backup disappeared before identity-bound recycle");
    }
    writeCatalog(
        oaamRoot,
        catalog.entries.filter((candidate) => candidate.backupId !== backupId),
    );
    return { schemaVersion: 1, backupId };
}

export function retireMissingStateBackupArtifact(oaamRoot: string, backupId: UuidV4): StateBackupRetirementV1 {
    const catalog = readCatalog(oaamRoot);
    const entry = catalog.entries.find((candidate) => candidate.backupId === backupId);
    if (entry === undefined) throw new Error("State backup inventory does not contain this backup identity");
    try {
        readRegularFileNoFollow(entry.archivePath, entry.archiveByteSize);
        throw new Error("State backup remains present after the external Trash action");
    } catch (error) {
        if (!(error instanceof SafeFilesystemError && error.failureKind === "not_found")) throw error;
    }
    writeCatalog(
        oaamRoot,
        catalog.entries.filter((candidate) => candidate.backupId !== backupId),
    );
    return { schemaVersion: 1, backupId };
}

function observeEntry(oaamRoot: string, entry: StateBackupCatalogEntryV1): StateBackupInventoryEntryV1 {
    let observation: StateBackupInventoryEntryV1["observation"];
    try {
        const observed = readRegularFileNoFollow(entry.archivePath, entry.archiveByteSize);
        observation =
            observed.bytes.byteLength === entry.archiveByteSize &&
            sha256Bytes(observed.bytes) === entry.archiveContentHash &&
            samePhysicalPathIdentity(observed.identity, entry.physicalIdentity)
                ? "available"
                : "replaced";
    } catch (error) {
        observation = error instanceof SafeFilesystemError && error.failureKind === "not_found" ? "missing" : "replaced";
    }
    return {
        schemaVersion: 1,
        backupId: entry.backupId,
        createdAt: entry.createdAt,
        archivePath: entry.archivePath,
        archiveByteSize: entry.archiveByteSize,
        archiveContentHash: entry.archiveContentHash,
        manifestFingerprint: entry.manifestFingerprint,
        sourceSnapshotFingerprint: entry.sourceSnapshotFingerprint,
        encryptionMode: entry.encryptionMode,
        destinationKind: path.dirname(entry.archivePath) === path.join(oaamRoot, "backups") ? "oaam_default" : "custom_directory",
        observation,
    };
}

function readCatalog(oaamRoot: string): StateBackupCatalogV1 {
    const filePath = catalogPath(oaamRoot);
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(readRegularFileNoFollow(filePath, MAXIMUM_CATALOG_BYTES).bytes).toString("utf-8"));
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return emptyCatalog();
        throw error;
    }
    validateCatalog(parsed);
    return parsed;
}

function writeCatalog(oaamRoot: string, entries: readonly StateBackupCatalogEntryV1[]): void {
    const canonicalEntries = [...entries].sort(
        (left, right) => left.createdAt - right.createdAt || compareCodeUnitText(left.backupId, right.backupId),
    );
    const catalog = buildCatalog(canonicalEntries);
    validateCatalog(catalog);
    durableEnsureDirectory(oaamRoot, "backups");
    durableReplaceFile(catalogPath(oaamRoot), `${JSON.stringify(JSON.parse(stableStringify(catalog)), null, 2)}\n`);
}

function emptyCatalog(): StateBackupCatalogV1 {
    return buildCatalog([]);
}

function buildCatalog(entries: readonly StateBackupCatalogEntryV1[]): StateBackupCatalogV1 {
    const canonicalEntries = entries.map((entry) => structuredClone(entry));
    return {
        format: "oaam-state-backup-catalog-v1",
        schemaVersion: 1,
        entries: canonicalEntries,
        catalogFingerprint: fingerprintDomain("oaam.state-backup.catalog.v1", {
            format: "oaam-state-backup-catalog-v1",
            schemaVersion: 1,
            entries: canonicalEntries,
        }),
    };
}

function validateCatalog(value: unknown): asserts value is StateBackupCatalogV1 {
    if (!isStrictObject(value) || !hasExactKeys(value, ["format", "schemaVersion", "entries", "catalogFingerprint"])) {
        throw new Error("State backup catalog must be one strict object");
    }
    if (
        value.format !== "oaam-state-backup-catalog-v1" ||
        value.schemaVersion !== 1 ||
        !Array.isArray(value.entries) ||
        !isSha256Digest(value.catalogFingerprint)
    ) {
        throw new Error("State backup catalog header is invalid");
    }
    const identities = new Set<string>();
    let previousSortKey = "";
    for (const entry of value.entries) {
        validateEntry(entry);
        const sortKey = `${String(entry.createdAt).padStart(16, "0")}:${entry.backupId}`;
        if (sortKey <= previousSortKey) throw new Error("State backup catalog entries must be canonical and unique");
        previousSortKey = sortKey;
        if (identities.has(entry.backupId)) {
            throw new Error("State backup catalog backup identities must be unique");
        }
        identities.add(entry.backupId);
    }
    const expected = buildCatalog(value.entries).catalogFingerprint;
    if (expected !== value.catalogFingerprint) throw new Error("State backup catalog fingerprint mismatch");
}

function validateEntry(value: unknown): asserts value is StateBackupCatalogEntryV1 {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, [
            "schemaVersion",
            "backupId",
            "createdAt",
            "archivePath",
            "archiveByteSize",
            "archiveContentHash",
            "manifestFingerprint",
            "sourceSnapshotFingerprint",
            "encryptionMode",
            "physicalIdentity",
        ])
    ) {
        throw new Error("State backup catalog entry must be strict");
    }
    if (
        value.schemaVersion !== 1 ||
        !isUuidV4(value.backupId) ||
        !Number.isSafeInteger(value.createdAt) ||
        (value.createdAt as number) <= 0 ||
        typeof value.archivePath !== "string" ||
        !path.isAbsolute(value.archivePath) ||
        path.normalize(value.archivePath) !== value.archivePath ||
        value.archivePath !==
            path.join(
                path.dirname(value.archivePath),
                backupOutputFileName(value.createdAt as number, value.backupId as string),
            ) ||
        !Number.isSafeInteger(value.archiveByteSize) ||
        (value.archiveByteSize as number) <= 0 ||
        !isSha256Digest(value.archiveContentHash) ||
        !isSha256Digest(value.manifestFingerprint) ||
        !isSha256Digest(value.sourceSnapshotFingerprint) ||
        !["none", "compatible_password", "strong_password"].includes(String(value.encryptionMode))
    ) {
        throw new Error("State backup catalog entry fields are invalid");
    }
    validatePhysicalIdentity(value.physicalIdentity);
}

function validatePhysicalIdentity(value: unknown): asserts value is PhysicalPathIdentity {
    if (
        !isStrictObject(value) ||
        !hasExactKeys(value, ["deviceId", "fileId", "entryKind"]) ||
        typeof value.deviceId !== "string" ||
        value.deviceId.length === 0 ||
        typeof value.fileId !== "string" ||
        value.fileId.length === 0 ||
        value.entryKind !== "file"
    ) {
        throw new Error("State backup catalog physical identity is invalid");
    }
}

function catalogPath(oaamRoot: string): string {
    return path.join(oaamRoot, "backups", CATALOG_FILE_NAME);
}

/** @internal Exact catalog codec seams exposed only to hostile-authority tests. */
export const stateBackupCatalogInternalsForTest = Object.freeze({
    buildCatalog,
    readCatalog,
    validateCatalog,
    validateEntry,
    validatePhysicalIdentity,
    writeCatalog,
});
