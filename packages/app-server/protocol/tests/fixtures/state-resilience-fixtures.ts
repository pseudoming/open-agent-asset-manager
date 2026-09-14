import { SHA_A, SHA_B, UUID_A, UUID_B } from "./protocol-fixture-primitives";

export const STATE_BACKUP_INVENTORY = Object.freeze({
    schemaVersion: 1,
    entries: [
        {
            schemaVersion: 1,
            backupId: UUID_A,
            createdAt: 10,
            archiveDisplayPath: "/home/user/.oaam/backups/oaam-backup.zip",
            archiveByteSize: 1024,
            archiveContentHash: SHA_A,
            manifestFingerprint: SHA_B,
            sourceSnapshotFingerprint: SHA_A,
            encryptionMode: "none",
            destinationKind: "oaam_default",
            observation: "available",
        },
    ],
    totalKnownArchiveBytes: 1024,
    totalAvailableArchiveBytes: 1024,
});

export const STATE_BACKUP_PROMPT_POLICY = Object.freeze({
    configVersion: 1,
    settingId: "state_backup_prompt_policy_v1",
    revision: 0,
    mode: "ask_every_time",
    updatedAt: 0,
    settingFingerprint: SHA_A,
});

export const STATE_BACKUP_REVIEW = Object.freeze({
    backupReviewToken: "backup-review-token",
    backupId: UUID_A,
    createdAt: 10,
    destinationKind: "oaam_default",
    destinationDisplayPath: "/home/user/.oaam/backups",
    destinationState: "ready",
    outputFileName: "oaam-backup.zip",
    encryptionMode: "none",
    sourceFileCount: 3,
    sourceLogicalBytes: 2048,
    requiredAvailableBytes: 4096,
    availableBytes: 8192,
    sourceSnapshotFingerprint: SHA_A,
});

export const STATE_BACKUP_ARTIFACT = Object.freeze({
    schemaVersion: 1,
    backupId: UUID_A,
    createdAt: 10,
    archiveDisplayPath: "/home/user/.oaam/backups/oaam-backup.zip",
    archiveByteSize: 1024,
    archiveContentHash: SHA_A,
    manifestFingerprint: SHA_B,
    sourceSnapshotFingerprint: SHA_A,
    encryptionMode: "none",
});

export const STATE_RESTORE_REVIEW = Object.freeze({
    restoreReviewToken: "restore-review-token",
    backupId: UUID_A,
    backupCreatedAt: 10,
    archiveDisplayPath: "/home/user/.oaam/backups/oaam-backup.zip",
    archiveByteSize: 1024,
    archiveContentHash: SHA_A,
    encryptionMode: "none",
    sourceFileCount: 3,
    sourceLogicalBytes: 2048,
    sourceSnapshotFingerprint: SHA_A,
    manifestFingerprint: SHA_B,
    includesDesktopPreferences: true,
});

export const STATE_RESTORE_ACTIVATION = Object.freeze({
    schemaVersion: 1,
    restoreId: UUID_B,
    backupId: UUID_A,
    activatedAt: 20,
    restoredSourceSnapshotFingerprint: SHA_A,
    displacedState: { state: "preserved", displayPath: "/home/user/.oaam.displaced" },
    requiresRestart: true,
    restoredDesktopPreferences: true,
});
