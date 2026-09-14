import * as crypto from "node:crypto";
import * as path from "node:path";
import {
    chmodIfDifferent,
    confirmDurableDirectoryNoFollow,
    confirmDurableDirectoryTreeNoFollow,
    durableCreateFile,
    durableEnsureDirectory,
    durablePublishDirectory,
    lockFile,
    readRegularFileNoFollow,
    SafeFilesystemError,
} from "@oaam/shared/filesystem";
import { completeResult } from "../foundation/core-result";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { fingerprintDomain } from "../foundation/fingerprint";
import { isUuidV4 } from "../foundation/validators";
import { closeDb, inspectStateDatabase, resolveDbPath } from "../persistence/db";
import type {
    ActivateStateRestoreInputV1,
    CoreResult,
    EpochMillis,
    InspectStateRestoreInputV1,
    StateRestoreActivationV1,
    StateRestorePreparationV1,
    UuidV4,
} from "../types";
import { readAndValidateStateRestoreArchive } from "./state-restore-archive";
import {
    buildRestoreMarker,
    failedRestoreResult,
    RESTORE_DISPLACED_NAME,
    RESTORE_MARKER_NAME,
    RESTORE_STAGED_NAME,
    StateRestoreError,
    type StateRestoreMarkerV1,
    profileSnapshotFingerprintForEntries,
    serializeRestoreMarker,
    type ValidatedStateRestoreCandidate,
    validateStateRestorePreparation,
} from "./state-restore-model";
import {
    blockingStateRestoreTransactions,
    carryForwardRestoreBackupDirectory,
    scanStateRestoreTransactions,
    type StateRestoreTransactionObservation,
    writeStateRestoreMarkerPhase,
} from "./state-restore-transactions";

const MAXIMUM_RESTORE_TREE_ENTRIES = 100_100;

export interface StateRestoreServiceConfiguration {
    oaamRoot: string;
    databasePath?: string;
    quiesceMutations(): Promise<void>;
}

/** @internal Test-only deterministic input; never exported from the package barrel. */
export interface StateRestoreServiceTestConfiguration extends StateRestoreServiceConfiguration {
    now?: () => EpochMillis;
    newUuid?: () => UuidV4;
}

export interface StateRestoreService {
    inspectStateRestore(input: InspectStateRestoreInputV1): Promise<CoreResult<StateRestorePreparationV1>>;
    activateStateRestore(input: ActivateStateRestoreInputV1): Promise<CoreResult<StateRestoreActivationV1>>;
}

interface ValidatedRestoreConfiguration {
    oaamRoot: string;
    oaamParent: string;
    oaamName: string;
    databasePath: string;
    databaseRelativePath: string;
    transactionPrefix: string;
    restoreLockPath: string;
    quiesceMutations(): Promise<void>;
    now: () => EpochMillis;
    newUuid: () => UuidV4;
}

interface StagedRestore {
    restoreId: UuidV4;
    transactionPath: string;
    stagedPath: string;
    displacedPath: string;
    markerPath: string;
    marker: StateRestoreMarkerV1;
}

export function createStateRestoreService(sourceConfiguration: StateRestoreServiceConfiguration): StateRestoreService {
    return createStateRestoreServiceCore({
        ...sourceConfiguration,
        now: Date.now,
        newUuid: cryptoRandomUuid,
    });
}

/** Test-only module-boundary seam for deterministic restore identities and timestamps. */
export function createStateRestoreServiceForTest(sourceConfiguration: StateRestoreServiceTestConfiguration): StateRestoreService {
    return createStateRestoreServiceCore({
        ...sourceConfiguration,
        now: sourceConfiguration.now ?? Date.now,
        newUuid: sourceConfiguration.newUuid ?? cryptoRandomUuid,
    });
}

function createStateRestoreServiceCore(sourceConfiguration: StateRestoreServiceTestConfiguration): StateRestoreService {
    const configuration = validateConfiguration(sourceConfiguration);
    return Object.freeze({
        async inspectStateRestore(input: InspectStateRestoreInputV1): Promise<CoreResult<StateRestorePreparationV1>> {
            try {
                const candidate = await readAndValidateStateRestoreArchive(input.archivePath, input.password);
                return completeResult(buildPreparation(candidate));
            } catch (error) {
                return failedRestoreResult(error);
            }
        },
        async activateStateRestore(input: ActivateStateRestoreInputV1): Promise<CoreResult<StateRestoreActivationV1>> {
            let releaseRestoreLock: (() => void) | null = null;
            try {
                requireUserAction(input.userActionId);
                validateStateRestorePreparation(input.preparation);
                const candidate = await readAndValidateStateRestoreArchive(input.preparation.archivePath, input.password);
                assertCandidateMatchesPreparation(candidate, input.preparation);
                releaseRestoreLock = lockFile(configuration.restoreLockPath);
                if (releaseRestoreLock === null) {
                    throw restoreFailure(
                        "restore.operation_locked",
                        "another process owns the State restore lock",
                        "unavailable",
                        true,
                        configuration.restoreLockPath,
                    );
                }
                assertNoExistingRestoreTransaction(configuration);
                const staged = stageCandidate(configuration, candidate);

                await configuration.quiesceMutations();
                closeDb();
                const activated = activateStagedCandidate(configuration, staged, candidate);
                return completeResult(activated);
            } catch (error) {
                return failedRestoreResult(error);
            } finally {
                releaseRestoreLock?.();
            }
        },
    });
}

function validateConfiguration(source: StateRestoreServiceTestConfiguration): ValidatedRestoreConfiguration {
    const oaamRoot = requireCanonicalNonRootPath(source.oaamRoot, "oaamRoot");
    const databasePath = resolveDbPath(source.databasePath);
    if (databasePath === ":memory:") {
        throw restoreFailure(
            "restore.database_path_unsupported",
            "whole-unit restore requires a durable State DB path",
            "unsupported",
            false,
        );
    }
    const relative = path.relative(oaamRoot, databasePath);
    if (!isSupportedDatabaseRelativePath(relative)) {
        throw restoreFailure(
            "restore.database_path_unsupported",
            "whole-unit restore requires the State DB to reside inside the OAAM profile outside preserved folders",
            "unsupported",
            false,
            databasePath,
        );
    }
    const oaamParent = path.dirname(oaamRoot);
    const oaamName = path.basename(oaamRoot);
    const transactionPrefix = `.${oaamName}.restore-txn-`;
    return Object.freeze({
        oaamRoot,
        oaamParent,
        oaamName,
        databasePath,
        databaseRelativePath: relative,
        transactionPrefix,
        restoreLockPath: path.join(oaamParent, `.${oaamName}.restore.lock`),
        quiesceMutations: source.quiesceMutations,
        now: source.now ?? Date.now,
        newUuid: source.newUuid ?? cryptoRandomUuid,
    });
}

function buildPreparation(candidate: ValidatedStateRestoreCandidate): StateRestorePreparationV1 {
    const preimage: Omit<StateRestorePreparationV1, "preparationFingerprint"> = {
        schemaVersion: 1,
        archivePath: candidate.archivePath,
        archiveByteSize: candidate.archiveByteSize,
        archiveContentHash: candidate.archiveContentHash,
        backupId: candidate.manifest.backupId,
        backupCreatedAt: candidate.manifest.createdAt,
        encryptionMode: candidate.manifest.encryptionMode,
        sourceFileCount: candidate.manifest.sourceFileCount,
        sourceLogicalBytes: candidate.manifest.sourceLogicalBytes,
        sourceSnapshotFingerprint: candidate.manifest.sourceSnapshotFingerprint,
        manifestFingerprint: candidate.manifest.manifestFingerprint,
        includesDesktopPreferences: candidate.desktopPreferences !== undefined,
    };
    return {
        ...preimage,
        preparationFingerprint: fingerprintDomain("oaam.restore.preparation.v1", preimage),
    };
}

function assertCandidateMatchesPreparation(
    candidate: ValidatedStateRestoreCandidate,
    preparation: StateRestorePreparationV1,
): void {
    const current = buildPreparation(candidate);
    if (
        current.archivePath !== preparation.archivePath ||
        current.archiveByteSize !== preparation.archiveByteSize ||
        current.archiveContentHash !== preparation.archiveContentHash ||
        current.backupId !== preparation.backupId ||
        current.backupCreatedAt !== preparation.backupCreatedAt ||
        current.encryptionMode !== preparation.encryptionMode ||
        current.sourceFileCount !== preparation.sourceFileCount ||
        current.sourceLogicalBytes !== preparation.sourceLogicalBytes ||
        current.sourceSnapshotFingerprint !== preparation.sourceSnapshotFingerprint ||
        current.manifestFingerprint !== preparation.manifestFingerprint ||
        current.includesDesktopPreferences !== preparation.includesDesktopPreferences ||
        current.preparationFingerprint !== preparation.preparationFingerprint
    ) {
        throw restoreFailure(
            "restore.archive_changed",
            "selected backup no longer matches the reviewed restore preparation",
            "conflict",
            true,
            preparation.archivePath,
        );
    }
}

function assertNoExistingRestoreTransaction(configuration: ValidatedRestoreConfiguration): void {
    let existing: StateRestoreTransactionObservation | undefined;
    try {
        existing = blockingStateRestoreTransactions(
            scanStateRestoreTransactions({
                oaamRoot: configuration.oaamRoot,
                databasePath: configuration.databasePath,
            }),
        )[0];
    } catch (error) {
        throw restoreFailure(
            "restore.reconciliation_required",
            `an earlier State restore transaction is invalid and requires reconciliation: ${String(error)}`,
            "conflict",
            false,
            error instanceof StateRestoreError ? error.targetPath : configuration.oaamParent,
        );
    }
    if (existing !== undefined) {
        throw restoreFailure(
            "restore.reconciliation_required",
            "an earlier State restore transaction must be reconciled before another restore",
            "conflict",
            false,
            existing.transactionPath,
        );
    }
}

function stageCandidate(configuration: ValidatedRestoreConfiguration, candidate: ValidatedStateRestoreCandidate): StagedRestore {
    const restoreId = requireRestoreId(configuration.newUuid());
    const transactionName = `${configuration.transactionPrefix}${restoreId}`;
    const transactionPath = path.join(configuration.oaamParent, transactionName);
    ensureNewDirectory(
        configuration.oaamParent,
        transactionName,
        "restore.transaction_exists",
        "the unique restore transaction path already exists",
    );
    const stagedPath = path.join(transactionPath, RESTORE_STAGED_NAME);
    ensureNewDirectory(
        transactionPath,
        RESTORE_STAGED_NAME,
        "restore.staging_exists",
        "restore staging directory unexpectedly exists",
    );
    const displacedPath = path.join(transactionPath, RESTORE_DISPLACED_NAME);
    const markerPath = path.join(transactionPath, RESTORE_MARKER_NAME);
    let marker = buildRestoreMarker({
        restoreId,
        backupId: candidate.manifest.backupId,
        archiveContentHash: candidate.archiveContentHash,
        sourceSnapshotFingerprint: candidate.manifest.sourceSnapshotFingerprint,
        profileSnapshotFingerprint: profileSnapshotFingerprintForEntries(candidate.source.entries),
        oaamRoot: configuration.oaamRoot,
        databasePath: configuration.databasePath,
        transactionPath,
        stagedPath,
        displacedPath,
        phase: "staging",
    });
    durableCreateFile(markerPath, serializeRestoreMarker(marker));
    populateStagedProfile(configuration, candidate, stagedPath);
    confirmDurableDirectoryTreeNoFollow(transactionPath, MAXIMUM_RESTORE_TREE_ENTRIES);
    const stagedDatabasePath = path.join(stagedPath, configuration.databaseRelativePath);
    requireCurrentStateDatabase(
        stagedDatabasePath,
        "restore.state_database_invalid",
        "restore candidate State DB is not current, canonical and internally consistent",
        "invalid_schema",
    );
    marker = writeMarkerPhase(markerPath, marker, "candidate_ready");
    return {
        restoreId,
        transactionPath,
        stagedPath,
        displacedPath,
        markerPath,
        marker,
    };
}

function populateStagedProfile(
    configuration: ValidatedRestoreConfiguration,
    candidate: ValidatedStateRestoreCandidate,
    stagedPath: string,
): void {
    const targetPaths = new Set<string>();
    for (const entry of candidate.source.entries) {
        const targetPath = stagedTargetPath(configuration, stagedPath, entry.logicalPath);
        if (targetPath === null) continue;
        const targetKey = targetPath.normalize("NFC").toLowerCase();
        if (targetPaths.has(targetKey)) {
            throw restoreFailure(
                "restore.target_path_collision",
                "restore archive maps multiple entries to the same profile path",
                "invalid_schema",
                false,
                targetPath,
            );
        }
        targetPaths.add(targetKey);
        ensureRelativeParentDirectories(stagedPath, path.relative(stagedPath, targetPath));
        durableCreateFile(targetPath, entry.bytes);
        chmodIfDifferent(targetPath, entry.executable);
        assertStagedEntry(
            readRegularFileNoFollow(targetPath, entry.byteSize).bytes,
            entry.byteSize,
            entry.contentHash,
            targetPath,
        );
    }
}

function stagedTargetPath(configuration: ValidatedRestoreConfiguration, stagedPath: string, logicalPath: string): string | null {
    if (logicalPath === "state/oaam.sqlite") {
        return path.join(stagedPath, configuration.databaseRelativePath);
    }
    if (logicalPath === "desktop/desktop-preferences.json") return null;
    if (!logicalPath.startsWith("oaam/")) {
        throw restoreFailure(
            "restore.logical_path_unsupported",
            `restore entry has no profile mapping: ${logicalPath}`,
            "invalid_schema",
            false,
        );
    }
    const segments = logicalPath.slice("oaam/".length).split("/");
    return path.join(stagedPath, ...segments);
}

function ensureRelativeParentDirectories(stagedPath: string, relativeFilePath: string): void {
    const segments = relativeFilePath.split(path.sep);
    let current = stagedPath;
    for (const segment of segments.slice(0, -1)) {
        const ensured = durableEnsureDirectory(current, segment);
        current = path.join(current, segment);
        if (!ensured.created) confirmDurableDirectoryNoFollow(current);
    }
}

function activateStagedCandidate(
    configuration: ValidatedRestoreConfiguration,
    staged: StagedRestore,
    candidate: ValidatedStateRestoreCandidate,
): StateRestoreActivationV1 {
    let marker = staged.marker;
    const liveExists = durableDirectoryExists(configuration.oaamRoot);
    if (liveExists) {
        durablePublishDirectory(configuration.oaamRoot, staged.transactionPath, RESTORE_DISPLACED_NAME);
        marker = writeMarkerPhase(staged.markerPath, marker, "live_displaced");
        carryForwardRestoreBackupDirectory(staged.displacedPath, staged.stagedPath);
    }
    assertDirectoryAbsent(configuration.oaamRoot);
    durablePublishDirectory(staged.stagedPath, configuration.oaamParent, configuration.oaamName);
    marker = writeMarkerPhase(staged.markerPath, marker, "activated");
    confirmDurableDirectoryTreeNoFollow(configuration.oaamRoot, MAXIMUM_RESTORE_TREE_ENTRIES);
    requireCurrentStateDatabase(
        configuration.databasePath,
        "restore.activation_verification_failed",
        "activated State DB did not reopen as current canonical authority",
        "verification_failed",
    );
    return {
        schemaVersion: 1,
        restoreId: staged.restoreId,
        backupId: candidate.manifest.backupId,
        activatedAt: requireRestoreTime(configuration.now()),
        restoredSourceSnapshotFingerprint: candidate.manifest.sourceSnapshotFingerprint,
        displacedState: liveExists ? { state: "preserved", path: staged.displacedPath } : { state: "none" },
        restoreTransactionPath: staged.transactionPath,
        requiresRestart: true,
        ...(candidate.desktopPreferences === undefined
            ? {}
            : { desktopPreferences: new Uint8Array(candidate.desktopPreferences) }),
    };
}

function writeMarkerPhase(
    markerPath: string,
    marker: StateRestoreMarkerV1,
    phase: StateRestoreMarkerV1["phase"],
): StateRestoreMarkerV1 {
    const observation: StateRestoreTransactionObservation = {
        transactionName: path.basename(marker.transactionPath),
        transactionPath: marker.transactionPath,
        markerPath,
        marker,
    };
    return writeStateRestoreMarkerPhase(observation, phase).marker;
}

function ensureNewDirectory(parentPath: string, name: string, code: string, message: string): string {
    const directoryPath = path.join(parentPath, name);
    if (durableEnsureDirectory(parentPath, name).created) return directoryPath;
    throw restoreFailure(code, message, "conflict", false, directoryPath);
}

function isSupportedDatabaseRelativePath(relativePath: string): boolean {
    const segments = relativePath.split(path.sep);
    return (
        relativePath.length > 0 &&
        !path.isAbsolute(relativePath) &&
        relativePath !== ".." &&
        !relativePath.startsWith(`..${path.sep}`) &&
        segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
        !["backups", "cache", "logs"].includes(segments[0] as string)
    );
}

function assertStagedEntry(
    bytes: Uint8Array,
    expectedByteSize: number,
    expectedContentHash: `sha256:${string}`,
    targetPath: string,
): void {
    if (bytes.byteLength === expectedByteSize && sha256Bytes(bytes) === expectedContentHash) return;
    throw restoreFailure(
        "restore.staging_verification_failed",
        "staged restore body does not match the backup manifest",
        "verification_failed",
        false,
        targetPath,
    );
}

function requireCurrentStateDatabase(
    databasePath: string,
    code: string,
    message: string,
    causeKind: StateRestoreError["causeKind"],
): void {
    if (inspectStateDatabase(databasePath).state === "current") return;
    throw restoreFailure(code, message, causeKind, false, databasePath);
}

function durableDirectoryExists(directoryPath: string): boolean {
    try {
        confirmDurableDirectoryNoFollow(directoryPath);
        return true;
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return false;
        throw error;
    }
}

function assertDirectoryAbsent(directoryPath: string): void {
    if (!durableDirectoryExists(directoryPath)) return;
    throw restoreFailure(
        "restore.live_path_occupied",
        "live OAAM profile path is still occupied before candidate activation",
        "conflict",
        false,
        directoryPath,
    );
}

function requireCanonicalNonRootPath(value: unknown, label: string): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.includes("\0") ||
        !path.isAbsolute(value) ||
        path.normalize(value) !== value ||
        value === path.parse(value).root ||
        value.endsWith(path.sep)
    ) {
        throw restoreFailure(
            "restore.configuration_invalid",
            `${label} must be a canonical non-root absolute path`,
            "invalid_schema",
            false,
            typeof value === "string" ? value : "",
        );
    }
    return value;
}

function requireUserAction(value: string): void {
    if (value.trim().length === 0 || value.includes("\0")) {
        throw restoreFailure(
            "restore.user_action_missing",
            "State restore requires a non-empty user action identity",
            "invalid_schema",
            false,
        );
    }
}

function cryptoRandomUuid(): UuidV4 {
    return crypto.randomUUID() as UuidV4;
}

function requireRestoreId(value: UuidV4): UuidV4 {
    if (isUuidV4(value)) return value;
    throw restoreFailure(
        "restore.identity_invalid",
        "Core restore identity allocator returned an invalid UUID v4",
        "internal_error",
        false,
    );
}

function requireRestoreTime(value: EpochMillis): EpochMillis {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw restoreFailure(
        "restore.clock_invalid",
        "Core restore clock returned an invalid activation time",
        "internal_error",
        false,
    );
}

function restoreFailure(
    code: string,
    message: string,
    causeKind: StateRestoreError["causeKind"],
    retryable: boolean,
    targetPath = "",
): StateRestoreError {
    return new StateRestoreError(code, message, causeKind, retryable, targetPath);
}

/** @internal Exact activation mechanics exposed only to fault tests. */
export const stateRestoreServiceInternalsForTest = Object.freeze({
    activateStagedCandidate,
    assertCandidateMatchesPreparation,
    assertDirectoryAbsent,
    assertNoExistingRestoreTransaction,
    buildPreparation,
    carryForwardBackupDirectory: carryForwardRestoreBackupDirectory,
    durableDirectoryExists,
    ensureNewDirectory,
    ensureRelativeParentDirectories,
    isSupportedDatabaseRelativePath,
    populateStagedProfile,
    requireCanonicalNonRootPath,
    requireCurrentStateDatabase,
    requireRestoreId,
    requireRestoreTime,
    assertStagedEntry,
    stageCandidate,
    stagedTargetPath,
    validateConfiguration,
    writeMarkerPhase,
});
