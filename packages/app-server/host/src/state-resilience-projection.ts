import type {
    StateBackupArtifactV1,
    StateBackupInventoryV1,
    StateBackupPreparationV1,
    StateBackupPromptPolicyV1,
    StateRestoreActivationV1,
    StateRestorePreparationV1,
} from "@oaam/core";
import { toProtocolSha256 } from "./core-outcome";

export function projectStateBackupInventory(inventory: StateBackupInventoryV1) {
    return {
        schemaVersion: 1 as const,
        entries: inventory.entries.map((entry) => ({
            schemaVersion: 1 as const,
            backupId: entry.backupId,
            createdAt: entry.createdAt,
            archiveDisplayPath: entry.archivePath,
            archiveByteSize: entry.archiveByteSize,
            archiveContentHash: toProtocolSha256(entry.archiveContentHash),
            manifestFingerprint: toProtocolSha256(entry.manifestFingerprint),
            sourceSnapshotFingerprint: toProtocolSha256(entry.sourceSnapshotFingerprint),
            encryptionMode: entry.encryptionMode,
            destinationKind: entry.destinationKind,
            observation: entry.observation,
        })),
        totalKnownArchiveBytes: inventory.totalKnownArchiveBytes,
        totalAvailableArchiveBytes: inventory.totalAvailableArchiveBytes,
    };
}

export function projectStateBackupPreparation(backupReviewToken: string, preparation: StateBackupPreparationV1) {
    return {
        backupReviewToken,
        backupId: preparation.backupId,
        createdAt: preparation.createdAt,
        destinationKind: preparation.destination.destinationKind,
        destinationDisplayPath: preparation.destination.directoryPath,
        destinationState: preparation.destination.directoryState === "ready" ? ("ready" as const) : ("create_required" as const),
        outputFileName: preparation.outputFileName,
        encryptionMode: preparation.encryptionMode,
        sourceFileCount: preparation.sourceFileCount,
        sourceLogicalBytes: preparation.sourceLogicalBytes,
        requiredAvailableBytes: preparation.requiredAvailableBytes,
        availableBytes: preparation.availableBytes,
        sourceSnapshotFingerprint: toProtocolSha256(preparation.sourceSnapshotFingerprint),
    };
}

export function projectStateBackupArtifact(artifact: StateBackupArtifactV1) {
    return {
        schemaVersion: 1 as const,
        backupId: artifact.backupId,
        createdAt: artifact.createdAt,
        archiveDisplayPath: artifact.archivePath,
        archiveByteSize: artifact.archiveByteSize,
        archiveContentHash: toProtocolSha256(artifact.archiveContentHash),
        manifestFingerprint: toProtocolSha256(artifact.manifestFingerprint),
        sourceSnapshotFingerprint: toProtocolSha256(artifact.sourceSnapshotFingerprint),
        encryptionMode: artifact.encryptionMode,
    };
}

export function projectStateBackupPromptPolicy(policy: StateBackupPromptPolicyV1) {
    return !("userActionEvidenceId" in policy)
        ? {
              configVersion: 1 as const,
              settingId: "state_backup_prompt_policy_v1" as const,
              revision: 0 as const,
              mode: "ask_every_time" as const,
              updatedAt: 0 as const,
              settingFingerprint: toProtocolSha256(policy.settingFingerprint),
          }
        : {
              configVersion: 1 as const,
              settingId: "state_backup_prompt_policy_v1" as const,
              revision: policy.revision,
              mode: policy.mode,
              userActionEvidenceId: policy.userActionEvidenceId,
              updatedAt: policy.updatedAt,
              settingFingerprint: toProtocolSha256(policy.settingFingerprint),
          };
}

export function projectStateRestorePreparation(restoreReviewToken: string, preparation: StateRestorePreparationV1) {
    return {
        restoreReviewToken,
        backupId: preparation.backupId,
        backupCreatedAt: preparation.backupCreatedAt,
        archiveDisplayPath: preparation.archivePath,
        archiveByteSize: preparation.archiveByteSize,
        archiveContentHash: toProtocolSha256(preparation.archiveContentHash),
        encryptionMode: preparation.encryptionMode,
        sourceFileCount: preparation.sourceFileCount,
        sourceLogicalBytes: preparation.sourceLogicalBytes,
        sourceSnapshotFingerprint: toProtocolSha256(preparation.sourceSnapshotFingerprint),
        manifestFingerprint: toProtocolSha256(preparation.manifestFingerprint),
        includesDesktopPreferences: preparation.includesDesktopPreferences,
    };
}

export function projectStateRestoreActivation(activation: StateRestoreActivationV1, restoredDesktopPreferences: boolean) {
    return {
        schemaVersion: 1 as const,
        restoreId: activation.restoreId,
        backupId: activation.backupId,
        activatedAt: activation.activatedAt,
        restoredSourceSnapshotFingerprint: toProtocolSha256(activation.restoredSourceSnapshotFingerprint),
        displacedState:
            activation.displacedState.state === "none"
                ? ({ state: "none" } as const)
                : ({ state: "preserved", displayPath: activation.displacedState.path } as const),
        requiresRestart: true as const,
        restoredDesktopPreferences,
    };
}
