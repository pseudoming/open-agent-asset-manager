import * as path from "node:path";
import type { Database } from "better-sqlite3";
import {
    SafeFilesystemError,
    confirmDurableDirectoryNoFollow,
    durableCreateFile,
    durableEnsureDirectory,
    inspectFilesystemCapacity,
    inspectRegularFileNoFollow,
    readRegularFileNoFollow,
    samePhysicalPathIdentity,
    type PhysicalPathIdentity,
} from "@oaam/shared/filesystem";
import { relatePhysicalAccessPaths } from "@oaam/shared/paths";
import type {
    CoreResult,
    CreateStateBackupInputV1,
    EpochMillis,
    InspectStateBackupInputV1,
    RetireStateBackupInputV1,
    StateBackupArtifactV1,
    StateBackupEncryptionMode,
    StateBackupExecutionObserver,
    StateBackupInventoryV1,
    StateBackupPreparationV1,
    StateBackupRetirementV1,
    UuidV4,
} from "../types";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { completeResult } from "../foundation/core-result";
import { fingerprintDomain } from "../foundation/fingerprint";
import { tryAcquireAuthorityLocks } from "../foundation/authority-locks";
import { buildAndVerifyBackupArchive } from "./state-backup-archive";
import {
    listStateBackupInventory,
    recycleStateBackupArtifact,
    registerStateBackupArtifact,
    retireMissingStateBackupArtifact,
} from "./state-backup-catalog";
import {
    ARCHIVE_FIXED_OVERHEAD,
    ARCHIVE_PER_ENTRY_OVERHEAD,
    backupOutputFileName,
    backupPreparationPreimage,
    type CapturedBackupSource,
    failedBackupResult,
    requireBackupEncryptionMode,
    StateBackupError,
    validateBackupPassword,
    validateBackupPreparation,
} from "./state-backup-model";
import { captureBackupSource } from "./state-backup-source";
import { reportStateBackupProgress } from "./state-backup-progress";

interface DestinationObservation {
    destinationKind: "oaam_default" | "custom_directory";
    directoryPath: string;
    directoryState: "ready" | "create_required";
    destinationFingerprint: `sha256:${string}`;
    availableBytes: number;
    directoryIdentity?: PhysicalPathIdentity;
}

interface StateBackupServiceConfiguration {
    db: Database;
    oaamRoot: string;
    databasePath: string;
    authorityLocksRoot: string;
    now: () => EpochMillis;
    newUuid: () => UuidV4;
    recycleFileIfIdentity?: (filePath: string, expectedIdentity: PhysicalPathIdentity) => boolean;
}

export interface StateBackupService {
    listStateBackups(observer?: StateBackupExecutionObserver): CoreResult<StateBackupInventoryV1>;
    inspectStateBackup(
        input: InspectStateBackupInputV1,
        observer?: StateBackupExecutionObserver,
    ): CoreResult<StateBackupPreparationV1>;
    createStateBackup(
        input: CreateStateBackupInputV1,
        observer?: StateBackupExecutionObserver,
    ): Promise<CoreResult<StateBackupArtifactV1>>;
    recycleStateBackup(input: RetireStateBackupInputV1): CoreResult<StateBackupRetirementV1>;
    retireMissingStateBackup(input: RetireStateBackupInputV1): CoreResult<StateBackupRetirementV1>;
}

export function createStateBackupService(configuration: StateBackupServiceConfiguration): StateBackupService {
    return Object.freeze({
        listStateBackups(observer?: StateBackupExecutionObserver): CoreResult<StateBackupInventoryV1> {
            try {
                return completeResult(listStateBackupInventory(configuration.oaamRoot, observer));
            } catch (error) {
                return failedBackupResult(error);
            }
        },
        inspectStateBackup(
            input: InspectStateBackupInputV1,
            observer?: StateBackupExecutionObserver,
        ): CoreResult<StateBackupPreparationV1> {
            try {
                const source = capture(configuration, input.desktopPreferences);
                reportStateBackupProgress(observer, "inventory", source.entries.length, source.entries.length);
                const backupId = configuration.newUuid();
                const createdAt = configuration.now();
                const outputFileName = backupOutputFileName(createdAt, backupId);
                const destination = observeDestination(configuration.oaamRoot, input.destination, outputFileName);
                return completeResult(
                    buildPreparation({
                        backupId,
                        createdAt,
                        encryptionMode: requireBackupEncryptionMode(input.encryptionMode),
                        source,
                        destination,
                        outputFileName,
                    }),
                );
            } catch (error) {
                return failedBackupResult(error);
            }
        },
        async createStateBackup(
            input: CreateStateBackupInputV1,
            observer?: StateBackupExecutionObserver,
        ): Promise<CoreResult<StateBackupArtifactV1>> {
            let releaseCatalog: (() => void) | null = null;
            try {
                requireUserAction(input.userActionId);
                validateBackupPreparation(input.preparation);
                validateBackupPassword(input.preparation.encryptionMode, input.password);
                durableEnsureDirectory(configuration.oaamRoot, "transactions");
                releaseCatalog = tryAcquireAuthorityLocks(configuration.authorityLocksRoot, "state_backup", ["catalog"]);
                if (releaseCatalog === null) throw new Error("State backup catalog is busy");

                const source = capture(configuration, input.desktopPreferences);
                reportStateBackupProgress(observer, "inventory", source.entries.length, source.entries.length);
                assertSourceMatchesPreparation(source, input.preparation);
                const destination = observeDestination(
                    configuration.oaamRoot,
                    destinationChoice(input.preparation),
                    input.preparation.outputFileName,
                );
                assertDestinationMatchesPreparation(destination, input.preparation);
                const destinationIdentity = ensurePreparedDestination(configuration.oaamRoot, destination);
                const archivePath = path.join(destination.directoryPath, input.preparation.outputFileName);

                const archive = await buildAndVerifyBackupArchive(source, input.preparation, input.password, observer);
                const refreshedSource = capture(configuration, input.desktopPreferences);
                assertSourceStableDuringArchive(source, refreshedSource);
                revalidateDestination(destination.directoryPath, destinationIdentity, archivePath, archive.bytes.byteLength);
                reportStateBackupProgress(observer, "commit", 0, 2);
                durableCreateFile(archivePath, archive.bytes);
                const committed = readRegularFileNoFollow(archivePath, archive.bytes.byteLength);
                assertCommittedArchiveBytes(archive.bytes, committed.bytes, archivePath);
                const finalDirectoryIdentity = confirmDurableDirectoryNoFollow(destination.directoryPath);
                assertDestinationIdentity(
                    destinationIdentity,
                    finalDirectoryIdentity,
                    "backup destination identity changed during commit",
                    destination.directoryPath,
                    false,
                );
                reportStateBackupProgress(observer, "commit", 1, 2);
                const artifact: StateBackupArtifactV1 = {
                    schemaVersion: 1,
                    backupId: input.preparation.backupId,
                    createdAt: input.preparation.createdAt,
                    archivePath,
                    archiveByteSize: archive.bytes.byteLength,
                    archiveContentHash: sha256Bytes(archive.bytes),
                    manifestFingerprint: archive.manifestFingerprint,
                    sourceSnapshotFingerprint: source.sourceSnapshotFingerprint,
                    encryptionMode: input.preparation.encryptionMode,
                };
                registerStateBackupArtifact(configuration.oaamRoot, input.preparation, artifact);
                reportStateBackupProgress(observer, "commit", 2, 2);
                return completeResult(artifact);
            } catch (error) {
                return failedBackupResult(error);
            } finally {
                releaseCatalog?.();
            }
        },
        recycleStateBackup(input: RetireStateBackupInputV1): CoreResult<StateBackupRetirementV1> {
            return retireBackup(configuration, input, (oaamRoot, backupId) =>
                recycleStateBackupArtifact(oaamRoot, backupId, configuration.recycleFileIfIdentity),
            );
        },
        retireMissingStateBackup(input: RetireStateBackupInputV1): CoreResult<StateBackupRetirementV1> {
            return retireBackup(configuration, input, retireMissingStateBackupArtifact);
        },
    });
}

function retireBackup(
    configuration: StateBackupServiceConfiguration,
    input: RetireStateBackupInputV1,
    retire: (oaamRoot: string, backupId: UuidV4) => StateBackupRetirementV1,
): CoreResult<StateBackupRetirementV1> {
    let releaseCatalog: (() => void) | null = null;
    try {
        requireUserAction(input.userActionId);
        releaseCatalog = tryAcquireAuthorityLocks(configuration.authorityLocksRoot, "state_backup", ["catalog"]);
        if (releaseCatalog === null) throw new Error("State backup catalog is busy");
        return completeResult(retire(configuration.oaamRoot, input.backupId));
    } catch (error) {
        return failedBackupResult(error);
    } finally {
        releaseCatalog?.();
    }
}

function capture(configuration: StateBackupServiceConfiguration, desktopPreferences?: Uint8Array): CapturedBackupSource {
    return captureBackupSource({
        db: configuration.db,
        oaamRoot: configuration.oaamRoot,
        databasePath: configuration.databasePath,
        desktopPreferences,
    });
}

function destinationChoice(preparation: StateBackupPreparationV1): InspectStateBackupInputV1["destination"] {
    return preparation.destination.destinationKind === "oaam_default"
        ? { destinationKind: "oaam_default" }
        : {
              destinationKind: "custom_directory",
              directoryPath: preparation.destination.directoryPath,
          };
}

function observeDestination(
    oaamRoot: string,
    choice: InspectStateBackupInputV1["destination"],
    outputFileName: string,
): DestinationObservation {
    if (choice.destinationKind === "oaam_default") {
        const directoryPath = path.join(oaamRoot, "backups");
        try {
            return readyDestination(
                choice.destinationKind,
                directoryPath,
                confirmDurableDirectoryNoFollow(directoryPath),
                outputFileName,
            );
        } catch (error) {
            if (!(error instanceof SafeFilesystemError && error.failureKind === "not_found")) throw error;
            const parentIdentity = confirmDurableDirectoryNoFollow(oaamRoot);
            return {
                destinationKind: choice.destinationKind,
                directoryPath,
                directoryState: "create_required",
                destinationFingerprint: fingerprintDomain("oaam.backup.destination.v1", {
                    destinationKind: choice.destinationKind,
                    directoryPath,
                    directoryState: "create_required",
                    parentIdentity,
                    childName: "backups",
                    outputFileName,
                    outputState: "absent",
                }),
                availableBytes: inspectFilesystemCapacity(oaamRoot).availableBytes,
            };
        }
    }
    requireCustomDestination(choice.directoryPath, oaamRoot);
    return readyDestination(
        choice.destinationKind,
        choice.directoryPath,
        confirmDurableDirectoryNoFollow(choice.directoryPath),
        outputFileName,
    );
}

function readyDestination(
    destinationKind: DestinationObservation["destinationKind"],
    directoryPath: string,
    identity: PhysicalPathIdentity,
    outputFileName: string,
): DestinationObservation {
    assertBackupOutputAbsent(path.join(directoryPath, outputFileName));
    return {
        destinationKind,
        directoryPath,
        directoryState: "ready",
        destinationFingerprint: fingerprintDomain("oaam.backup.destination.v1", {
            destinationKind,
            directoryPath,
            directoryState: "ready",
            identity,
            outputFileName,
            outputState: "absent",
        }),
        availableBytes: inspectFilesystemCapacity(directoryPath).availableBytes,
        directoryIdentity: identity,
    };
}

function requireCustomDestination(directoryPath: string, oaamRoot: string): void {
    if (
        directoryPath.length === 0 ||
        directoryPath.includes("\0") ||
        !path.isAbsolute(directoryPath) ||
        path.normalize(directoryPath) !== directoryPath ||
        directoryPath === path.parse(directoryPath).root ||
        directoryPath.endsWith(path.sep)
    ) {
        throw new StateBackupError(
            "backup.destination_invalid",
            "custom backup destination must be a canonical non-root absolute directory path",
            "invalid_schema",
            false,
            directoryPath,
        );
    }
    const relation = relatePhysicalAccessPaths(oaamRoot, directoryPath);
    if (relation.kind === "equal" || relation.kind === "root_contains_candidate") {
        throw new StateBackupError(
            "backup.destination_inside_profile",
            "custom backup destination cannot be inside the live OAAM profile",
            "invalid_schema",
            false,
            directoryPath,
        );
    }
}

function buildPreparation(input: {
    backupId: UuidV4;
    createdAt: EpochMillis;
    encryptionMode: StateBackupEncryptionMode;
    source: CapturedBackupSource;
    destination: DestinationObservation;
    outputFileName: string;
}): StateBackupPreparationV1 {
    const requiredAvailableBytes =
        input.source.sourceLogicalBytes +
        ARCHIVE_FIXED_OVERHEAD +
        (input.source.sourceFileCount + 2) * ARCHIVE_PER_ENTRY_OVERHEAD;
    if (!Number.isSafeInteger(requiredAvailableBytes) || requiredAvailableBytes > input.destination.availableBytes) {
        throw new StateBackupError(
            "backup.destination_capacity_insufficient",
            "backup destination does not have enough currently available capacity",
            "unavailable",
            true,
            input.destination.directoryPath,
        );
    }
    const preimage: Omit<StateBackupPreparationV1, "preparationFingerprint"> = {
        schemaVersion: 1,
        backupId: input.backupId,
        createdAt: input.createdAt,
        destination: {
            destinationKind: input.destination.destinationKind,
            directoryPath: input.destination.directoryPath,
            directoryState: input.destination.directoryState,
        },
        outputFileName: input.outputFileName,
        encryptionMode: input.encryptionMode,
        sourceFileCount: input.source.sourceFileCount,
        sourceLogicalBytes: input.source.sourceLogicalBytes,
        requiredAvailableBytes,
        availableBytes: input.destination.availableBytes,
        sourceSnapshotFingerprint: input.source.sourceSnapshotFingerprint,
        destinationFingerprint: input.destination.destinationFingerprint,
    };
    return {
        ...preimage,
        preparationFingerprint: fingerprintDomain("oaam.backup.preparation.v1", preimage),
    };
}

function assertSourceMatchesPreparation(source: CapturedBackupSource, preparation: StateBackupPreparationV1): void {
    if (
        source.sourceSnapshotFingerprint !== preparation.sourceSnapshotFingerprint ||
        source.sourceFileCount !== preparation.sourceFileCount ||
        source.sourceLogicalBytes !== preparation.sourceLogicalBytes
    ) {
        throw new StateBackupError(
            "backup.source_changed",
            "OAAM authority changed after backup review; refresh the backup preparation",
            "conflict",
            true,
        );
    }
}

function assertSourceStableDuringArchive(before: CapturedBackupSource, after: CapturedBackupSource): void {
    if (after.sourceSnapshotFingerprint !== before.sourceSnapshotFingerprint) {
        throw new StateBackupError(
            "backup.source_changed",
            "OAAM authority changed while the backup archive was being built",
            "conflict",
            true,
        );
    }
}

function assertDestinationMatchesPreparation(destination: DestinationObservation, preparation: StateBackupPreparationV1): void {
    if (
        destination.destinationKind !== preparation.destination.destinationKind ||
        destination.directoryPath !== preparation.destination.directoryPath ||
        destination.directoryState !== preparation.destination.directoryState ||
        destination.destinationFingerprint !== preparation.destinationFingerprint ||
        backupPreparationPreimage(preparation).destinationFingerprint !== destination.destinationFingerprint
    ) {
        throw new StateBackupError(
            "backup.destination_changed",
            "backup destination changed after review; choose or refresh the destination",
            "conflict",
            true,
            destination.directoryPath,
        );
    }
    if (destination.availableBytes < preparation.requiredAvailableBytes) {
        throw new StateBackupError(
            "backup.destination_capacity_insufficient",
            "backup destination no longer has enough available capacity",
            "unavailable",
            true,
            destination.directoryPath,
        );
    }
}

function ensurePreparedDestination(oaamRoot: string, destination: DestinationObservation): PhysicalPathIdentity {
    if (destination.directoryState === "ready") {
        const current = confirmDurableDirectoryNoFollow(destination.directoryPath);
        if (destination.directoryIdentity === undefined) {
            throw new StateBackupError(
                "backup.destination_changed",
                "backup destination identity is missing after review",
                "conflict",
                true,
                destination.directoryPath,
            );
        }
        assertDestinationIdentity(
            destination.directoryIdentity,
            current,
            "backup destination identity changed after review",
            destination.directoryPath,
            true,
        );
        return current;
    }
    const ensured = durableEnsureDirectory(oaamRoot, "backups");
    if (!ensured.created) {
        throw new StateBackupError(
            "backup.destination_changed",
            "default backup directory appeared after review",
            "conflict",
            true,
            destination.directoryPath,
        );
    }
    return ensured.identity;
}

function revalidateDestination(
    directoryPath: string,
    expectedIdentity: PhysicalPathIdentity,
    archivePath: string,
    archiveByteLength: number,
): void {
    const currentIdentity = confirmDurableDirectoryNoFollow(directoryPath);
    assertDestinationIdentity(
        expectedIdentity,
        currentIdentity,
        "backup destination identity changed while the archive was being built",
        directoryPath,
        true,
    );
    assertBackupOutputAbsent(archivePath);
    if (inspectFilesystemCapacity(directoryPath).availableBytes < archiveByteLength) {
        throw new StateBackupError(
            "backup.destination_capacity_insufficient",
            "backup destination no longer has enough capacity for the verified archive",
            "unavailable",
            true,
            directoryPath,
        );
    }
}

function assertBackupOutputAbsent(archivePath: string): void {
    try {
        inspectRegularFileNoFollow(archivePath);
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return;
        throw error;
    }
    throw new StateBackupError(
        "backup.output_exists",
        "the exact immutable backup output already exists",
        "conflict",
        false,
        archivePath,
    );
}

function requireUserAction(value: string): void {
    if (value.trim().length === 0 || value.includes("\0")) {
        throw new StateBackupError(
            "backup.user_action_missing",
            "backup creation requires a non-empty user action identity",
            "invalid_schema",
            false,
        );
    }
}

function assertDestinationIdentity(
    expected: PhysicalPathIdentity,
    actual: PhysicalPathIdentity,
    message: string,
    targetPath: string,
    retryable: boolean,
): void {
    if (!samePhysicalPathIdentity(expected, actual)) {
        throw new StateBackupError("backup.destination_changed", message, "conflict", retryable, targetPath);
    }
}

function assertCommittedArchiveBytes(expected: Uint8Array, actual: Uint8Array, archivePath: string): void {
    if (!Buffer.from(actual).equals(Buffer.from(expected))) {
        throw new StateBackupError(
            "backup.commit_verification_failed",
            "committed backup bytes do not match the verified archive",
            "verification_failed",
            false,
            archivePath,
        );
    }
}

/** @internal Exact pure validators for fault tests. */
export const stateBackupInternalsForTest = Object.freeze({
    assertBackupOutputAbsent,
    assertCommittedArchiveBytes,
    assertDestinationIdentity,
    assertDestinationMatchesPreparation,
    assertSourceMatchesPreparation,
    assertSourceStableDuringArchive,
    buildPreparation,
    ensurePreparedDestination,
    revalidateDestination,
    requireCustomDestination,
    validateBackupPassword,
    validateBackupPreparation,
});
