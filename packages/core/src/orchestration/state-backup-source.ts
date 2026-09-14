import * as path from "node:path";
import type { Database } from "better-sqlite3";
import {
    inspectRegularFileNoFollow,
    inventoryDirectoryNoFollow,
    readRegularFileNoFollow,
    samePhysicalPathIdentity,
    type PhysicalPathIdentity,
} from "@oaam/shared/filesystem";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { fingerprintDomain } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import {
    assertPortableBackupPaths,
    type BackupOwner,
    type CapturedBackupEntry,
    type CapturedBackupSource,
    manifestEntry,
    MAXIMUM_BACKUP_FILES,
    MAXIMUM_BACKUP_LOGICAL_BYTES,
    StateBackupError,
} from "./state-backup-model";

export function captureBackupSource(input: {
    db: Database;
    oaamRoot: string;
    databasePath: string;
    desktopPreferences?: Uint8Array;
}): CapturedBackupSource {
    const entries: CapturedBackupEntry[] = [];
    const logicalBytes = { value: 0 };
    appendCapturedEntry(
        entries,
        logicalBytes,
        "state/oaam.sqlite",
        "state_database",
        new Uint8Array(input.db.serialize()),
        false,
    );
    collectProfileEntries(input.oaamRoot, input.databasePath, entries, logicalBytes);
    if (input.desktopPreferences !== undefined) {
        appendCapturedEntry(
            entries,
            logicalBytes,
            "desktop/desktop-preferences.json",
            "desktop_preferences",
            input.desktopPreferences,
            false,
        );
    }
    entries.sort((left, right) => compareUtf8Bytes(left.logicalPath, right.logicalPath));
    assertPortableBackupPaths(entries.map((entry) => entry.logicalPath));
    const manifestEntries = entries.map(manifestEntry);
    return {
        entries,
        sourceFileCount: entries.length,
        sourceLogicalBytes: logicalBytes.value,
        sourceSnapshotFingerprint: fingerprintDomain("oaam.backup.source-snapshot.v1", manifestEntries),
    };
}

/**
 * Reconstruct the exact restorable profile closure before the restored SQLite
 * database is opened writable. This is used only by restart reconciliation:
 * normal backup creation must continue to use Database.serialize() so a live
 * WAL-backed connection is captured as one committed snapshot.
 */
export function captureRestoredProfileSource(input: { oaamRoot: string; databasePath: string }): CapturedBackupSource {
    const databaseRead = readRegularFileNoFollow(input.databasePath, MAXIMUM_BACKUP_LOGICAL_BYTES);
    const source = captureBackupSourceFromDatabaseBytes({
        oaamRoot: input.oaamRoot,
        databasePath: input.databasePath,
        databaseBytes: databaseRead.bytes,
    });
    assertCapturedIdentity(
        inspectRegularFileNoFollow(input.databasePath),
        databaseRead.identity,
        "restored State DB identity changed during profile verification",
        input.databasePath,
    );
    return source;
}

function captureBackupSourceFromDatabaseBytes(input: {
    oaamRoot: string;
    databasePath: string;
    databaseBytes: Uint8Array;
}): CapturedBackupSource {
    const entries: CapturedBackupEntry[] = [];
    const logicalBytes = { value: 0 };
    appendCapturedEntry(entries, logicalBytes, "state/oaam.sqlite", "state_database", input.databaseBytes, false);
    collectProfileEntries(input.oaamRoot, input.databasePath, entries, logicalBytes);
    entries.sort((left, right) => compareUtf8Bytes(left.logicalPath, right.logicalPath));
    assertPortableBackupPaths(entries.map((entry) => entry.logicalPath));
    const manifestEntries = entries.map(manifestEntry);
    return {
        entries,
        sourceFileCount: entries.length,
        sourceLogicalBytes: logicalBytes.value,
        sourceSnapshotFingerprint: fingerprintDomain("oaam.backup.source-snapshot.v1", manifestEntries),
    };
}

function collectProfileEntries(
    oaamRoot: string,
    databasePath: string,
    output: CapturedBackupEntry[],
    logicalBytes: { value: number },
): void {
    const databaseExclusions = databasePathsWithinRoot(oaamRoot, databasePath);
    const visit = (directoryPath: string, segments: string[], expectedIdentity?: PhysicalPathIdentity): void => {
        const inventory = inventoryDirectoryNoFollow(directoryPath, MAXIMUM_BACKUP_FILES - output.length);
        if (expectedIdentity !== undefined) {
            assertCapturedIdentity(
                inventory.identity,
                expectedIdentity,
                "OAAM profile directory identity changed during backup inventory",
                directoryPath,
            );
        }
        for (const entry of inventory.entries) {
            const childSegments = [...segments, entry.relativeName];
            if (skipProfilePath(childSegments, databaseExclusions)) continue;
            const absolutePath = path.join(directoryPath, entry.relativeName);
            if (entry.identity.entryKind === "directory") {
                visit(absolutePath, childSegments, entry.identity);
                continue;
            }
            const read = readRegularFileNoFollow(absolutePath, MAXIMUM_BACKUP_LOGICAL_BYTES - logicalBytes.value);
            assertCapturedIdentity(
                read.identity,
                entry.identity,
                "OAAM profile file identity changed during backup inventory",
                absolutePath,
            );
            appendCapturedEntry(
                output,
                logicalBytes,
                `oaam/${childSegments.join("/")}`,
                ownerForProfilePath(childSegments),
                read.bytes,
                read.executable,
            );
        }
    };
    visit(oaamRoot, []);
}

function databasePathsWithinRoot(oaamRoot: string, databasePath: string): Set<string> {
    if (databasePath === ":memory:") return new Set();
    const relativePath = path.relative(oaamRoot, databasePath);
    if (
        relativePath === "" ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
    ) {
        return new Set();
    }
    const logical = relativePath.split(path.sep).join("/");
    return new Set([logical, `${logical}-wal`, `${logical}-shm`]);
}

function skipProfilePath(segments: string[], databaseExclusions: ReadonlySet<string>): boolean {
    const logical = segments.join("/");
    if (databaseExclusions.has(logical)) return true;
    if (segments.length === 1 && ["backups", "cache", "logs"].includes(segments[0] as string)) return true;
    if (segments[0] === "assets" && segments[1] === ".staging") return true;
    if (segments[0] === "deployments" && segments[2] === ".staging") return true;
    return segments[0] === "transactions" && (segments[1] === "locks" || segments[1] === "authority-locks");
}

function ownerForProfilePath(segments: string[]): BackupOwner {
    if (segments[0] === "assets") return "asset_authority";
    if (segments[0] === "projects") return "project_authority";
    if (segments[0] === "deployments") return "deployment_authority";
    if (segments[0] === "transactions") return "recovery_material";
    if (segments.length === 1 && segments[0] === "settings.json") return "settings_authority";
    return "profile_material";
}

function appendCapturedEntry(
    output: CapturedBackupEntry[],
    logicalBytes: { value: number },
    logicalPath: string,
    owner: BackupOwner,
    sourceBytes: Uint8Array,
    executable: boolean,
): void {
    if (output.length >= MAXIMUM_BACKUP_FILES || sourceBytes.byteLength > MAXIMUM_BACKUP_LOGICAL_BYTES - logicalBytes.value) {
        throw new StateBackupError(
            "backup.source_too_large",
            `backup source exceeds the bounded ${String(MAXIMUM_BACKUP_FILES)} file / ${String(
                MAXIMUM_BACKUP_LOGICAL_BYTES,
            )} byte creation limit`,
            "unavailable",
            false,
        );
    }
    const bytes = new Uint8Array(sourceBytes);
    logicalBytes.value += bytes.byteLength;
    output.push({
        logicalPath,
        owner,
        contentHash: sha256Bytes(bytes),
        byteSize: bytes.byteLength,
        executable,
        bytes,
    });
}

function assertCapturedIdentity(
    actual: PhysicalPathIdentity,
    expected: PhysicalPathIdentity,
    message: string,
    targetPath: string,
): void {
    if (!samePhysicalPathIdentity(actual, expected)) {
        throw new StateBackupError("backup.source_changed", message, "conflict", true, targetPath);
    }
}

/** @internal Exact source-closure mechanics exposed only to fault tests. */
export const stateBackupSourceInternalsForTest = Object.freeze({
    appendCapturedEntry,
    assertCapturedIdentity,
    captureBackupSourceFromDatabaseBytes,
    databasePathsWithinRoot,
    ownerForProfilePath,
    skipProfilePath,
});
