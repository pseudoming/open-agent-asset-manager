import type { EpochMillis, Sha256Digest, UuidV4 } from "./primitives";

export type StateBackupEncryptionMode = "none" | "compatible_password" | "strong_password";

export type StateBackupDestinationChoiceV1 =
    | { destinationKind: "oaam_default" }
    | { destinationKind: "custom_directory"; directoryPath: string };

export interface InspectStateBackupInputV1 {
    destination: StateBackupDestinationChoiceV1;
    encryptionMode: StateBackupEncryptionMode;
    desktopPreferences?: Uint8Array;
}

export interface StateBackupPreparationV1 {
    schemaVersion: 1;
    backupId: UuidV4;
    createdAt: EpochMillis;
    destination: {
        destinationKind: "oaam_default" | "custom_directory";
        directoryPath: string;
        directoryState: "ready" | "create_required";
    };
    outputFileName: string;
    encryptionMode: StateBackupEncryptionMode;
    sourceFileCount: number;
    sourceLogicalBytes: number;
    requiredAvailableBytes: number;
    availableBytes: number;
    sourceSnapshotFingerprint: Sha256Digest;
    destinationFingerprint: Sha256Digest;
    preparationFingerprint: Sha256Digest;
}

export interface CreateStateBackupInputV1 {
    preparation: StateBackupPreparationV1;
    desktopPreferences?: Uint8Array;
    password?: string;
    userActionId: string;
}

export interface StateBackupArtifactV1 {
    schemaVersion: 1;
    backupId: UuidV4;
    createdAt: EpochMillis;
    archivePath: string;
    archiveByteSize: number;
    archiveContentHash: Sha256Digest;
    manifestFingerprint: Sha256Digest;
    sourceSnapshotFingerprint: Sha256Digest;
    encryptionMode: StateBackupEncryptionMode;
}

export type StateBackupInventoryObservation = "available" | "missing" | "replaced";

export interface StateBackupInventoryEntryV1 extends StateBackupArtifactV1 {
    destinationKind: "oaam_default" | "custom_directory";
    observation: StateBackupInventoryObservation;
}

export interface StateBackupInventoryV1 {
    schemaVersion: 1;
    entries: StateBackupInventoryEntryV1[];
    totalKnownArchiveBytes: number;
    totalAvailableArchiveBytes: number;
}

export interface RetireStateBackupInputV1 {
    backupId: UuidV4;
    userActionId: string;
}

export interface StateBackupRetirementV1 {
    schemaVersion: 1;
    backupId: UuidV4;
}

export type StateBackupExecutionStage = "inventory" | "packing" | "encryption" | "verification" | "commit";

export interface StateBackupExecutionProgressV1 {
    stage: StateBackupExecutionStage;
    completedUnits: number;
    totalUnits: number;
}

export interface StateBackupExecutionObserver {
    report(progress: StateBackupExecutionProgressV1): void;
}

export type StateBackupPromptMode = "ask_every_time" | "back_up_first" | "continue_without_prompt";

export type StateBackupPromptPolicyV1 =
    | {
          configVersion: 1;
          settingId: "state_backup_prompt_policy_v1";
          revision: 0;
          mode: "ask_every_time";
          updatedAt: 0;
          settingFingerprint: Sha256Digest;
      }
    | {
          configVersion: 1;
          settingId: "state_backup_prompt_policy_v1";
          revision: number;
          mode: StateBackupPromptMode;
          userActionEvidenceId: string;
          updatedAt: EpochMillis;
          settingFingerprint: Sha256Digest;
      };

export interface ReplaceStateBackupPromptPolicyInputV1 {
    expectedRevision: number;
    expectedSettingFingerprint: Sha256Digest;
    mode: StateBackupPromptMode;
    userActionId: string;
}

export interface InspectStateRestoreInputV1 {
    archivePath: string;
    password?: string;
}

export interface StateRestorePreparationV1 {
    schemaVersion: 1;
    archivePath: string;
    archiveByteSize: number;
    archiveContentHash: Sha256Digest;
    backupId: UuidV4;
    backupCreatedAt: EpochMillis;
    encryptionMode: StateBackupEncryptionMode;
    sourceFileCount: number;
    sourceLogicalBytes: number;
    sourceSnapshotFingerprint: Sha256Digest;
    manifestFingerprint: Sha256Digest;
    includesDesktopPreferences: boolean;
    preparationFingerprint: Sha256Digest;
}

export interface ActivateStateRestoreInputV1 {
    preparation: StateRestorePreparationV1;
    password?: string;
    userActionId: string;
}

export interface StateRestoreActivationV1 {
    schemaVersion: 1;
    restoreId: UuidV4;
    backupId: UuidV4;
    activatedAt: EpochMillis;
    restoredSourceSnapshotFingerprint: Sha256Digest;
    displacedState: { state: "preserved"; path: string } | { state: "none" };
    restoreTransactionPath: string;
    requiresRestart: true;
    desktopPreferences?: Uint8Array;
}

export type StateRestoreOrphanEvidenceKind = "deployment_payload" | "deployment_journal" | "corrupt_deployment_journal";

export interface StateRestoreOrphanEvidenceV1 {
    evidenceKind: StateRestoreOrphanEvidenceKind;
    path: string;
}

export interface StateRestoreReopenIssueV1 {
    code: string;
    message: string;
    path: string;
}

export type StateRestoreProjectionRebuildV1 =
    | { state: "not_run" }
    | {
          state: "complete" | "partial";
          scannedAssets: number;
          indexedAssets: number;
          skippedAssets: number;
          scannedProjects: number;
          indexedProjects: number;
          skippedProjects: number;
      };

export interface StateRestoreReopenReportV1 {
    format: "oaam-state-restore-reopen-report-v1";
    schemaVersion: 1;
    restoreId: UuidV4;
    backupId: UuidV4;
    outcome: "restored" | "retained_current";
    completedAt: EpochMillis;
    projection: StateRestoreProjectionRebuildV1;
    orphanEvidence: StateRestoreOrphanEvidenceV1[];
    issues: StateRestoreReopenIssueV1[];
    reportFingerprint: Sha256Digest;
}
