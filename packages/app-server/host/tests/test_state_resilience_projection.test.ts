import type {
    Sha256Digest,
    StateBackupArtifactV1,
    StateBackupInventoryV1,
    StateBackupPreparationV1,
    StateBackupPromptPolicyV1,
    StateRestoreActivationV1,
    StateRestorePreparationV1,
    UuidV4,
} from "@oaam/core";
import { describe, expect, it } from "vitest";
import {
    projectStateBackupArtifact,
    projectStateBackupInventory,
    projectStateBackupPreparation,
    projectStateBackupPromptPolicy,
    projectStateRestoreActivation,
    projectStateRestorePreparation,
} from "../src/state-resilience-projection";

const BACKUP_ID = "00000000-0000-4000-8000-000000000001" as UuidV4;
const RESTORE_ID = "00000000-0000-4000-8000-000000000002" as UuidV4;
const DIGEST = `sha256:${"a".repeat(64)}` as Sha256Digest;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}` as Sha256Digest;

function backupPreparation(
    directoryState: StateBackupPreparationV1["destination"]["directoryState"] = "ready",
): StateBackupPreparationV1 {
    return {
        schemaVersion: 1,
        backupId: BACKUP_ID,
        createdAt: 10,
        destination: {
            destinationKind: "oaam_default",
            directoryPath: "/profile/backups",
            directoryState,
        },
        outputFileName: "oaam-backup.zip",
        encryptionMode: "none",
        sourceFileCount: 3,
        sourceLogicalBytes: 2_048,
        requiredAvailableBytes: 4_096,
        availableBytes: 8_192,
        sourceSnapshotFingerprint: DIGEST,
        destinationFingerprint: OTHER_DIGEST,
        preparationFingerprint: DIGEST,
    };
}

function backupArtifact(): StateBackupArtifactV1 {
    return {
        schemaVersion: 1,
        backupId: BACKUP_ID,
        createdAt: 10,
        archivePath: "/profile/backups/oaam-backup.zip",
        archiveByteSize: 1_024,
        archiveContentHash: DIGEST,
        manifestFingerprint: OTHER_DIGEST,
        sourceSnapshotFingerprint: DIGEST,
        encryptionMode: "none",
    };
}

function backupInventory(): StateBackupInventoryV1 {
    return {
        schemaVersion: 1,
        entries: [{ ...backupArtifact(), destinationKind: "oaam_default", observation: "available" }],
        totalKnownArchiveBytes: 1_024,
        totalAvailableArchiveBytes: 1_024,
    };
}

function restorePreparation(): StateRestorePreparationV1 {
    return {
        schemaVersion: 1,
        archivePath: "/profile/backups/oaam-backup.zip",
        archiveByteSize: 1_024,
        archiveContentHash: DIGEST,
        backupId: BACKUP_ID,
        backupCreatedAt: 10,
        encryptionMode: "none",
        sourceFileCount: 3,
        sourceLogicalBytes: 2_048,
        sourceSnapshotFingerprint: DIGEST,
        manifestFingerprint: OTHER_DIGEST,
        includesDesktopPreferences: true,
        preparationFingerprint: DIGEST,
    };
}

function restoreActivation(
    displacedState: StateRestoreActivationV1["displacedState"] = {
        state: "preserved",
        path: "/profile.displaced",
    },
): StateRestoreActivationV1 {
    return {
        schemaVersion: 1,
        restoreId: RESTORE_ID,
        backupId: BACKUP_ID,
        activatedAt: 20,
        restoredSourceSnapshotFingerprint: DIGEST,
        displacedState,
        restoreTransactionPath: "/profile.restore",
        requiresRestart: true,
        desktopPreferences: new Uint8Array([1, 2, 3]),
    };
}

describe("State resilience Host projections", () => {
    it("projects backup inventory, preparation, artifact, and both policy branches", () => {
        expect(projectStateBackupInventory(backupInventory())).toMatchObject({
            entries: [{ archiveContentHash: "a".repeat(64), manifestFingerprint: "b".repeat(64) }],
            totalAvailableArchiveBytes: 1_024,
        });
        expect(projectStateBackupPreparation("review", backupPreparation())).toMatchObject({
            backupReviewToken: "review",
            destinationState: "ready",
            sourceSnapshotFingerprint: "a".repeat(64),
        });
        expect(projectStateBackupPreparation("review", backupPreparation("create_required"))).toMatchObject({
            destinationState: "create_required",
        });
        expect(projectStateBackupArtifact(backupArtifact())).toMatchObject({
            archiveContentHash: "a".repeat(64),
            manifestFingerprint: "b".repeat(64),
        });

        const initialPolicy: StateBackupPromptPolicyV1 = {
            configVersion: 1,
            settingId: "state_backup_prompt_policy_v1",
            revision: 0,
            mode: "ask_every_time",
            updatedAt: 0,
            settingFingerprint: DIGEST,
        };
        expect(projectStateBackupPromptPolicy(initialPolicy)).toMatchObject({
            revision: 0,
            mode: "ask_every_time",
            settingFingerprint: "a".repeat(64),
        });
        expect(
            projectStateBackupPromptPolicy({
                ...initialPolicy,
                revision: 2,
                mode: "back_up_first",
                userActionEvidenceId: "user-action",
                updatedAt: 20,
            }),
        ).toMatchObject({ revision: 2, mode: "back_up_first", userActionEvidenceId: "user-action" });
    });

    it("projects restore preparation and both displaced-state branches", () => {
        expect(projectStateRestorePreparation("review", restorePreparation())).toMatchObject({
            restoreReviewToken: "review",
            archiveContentHash: "a".repeat(64),
            manifestFingerprint: "b".repeat(64),
            includesDesktopPreferences: true,
        });
        expect(projectStateRestoreActivation(restoreActivation(), true)).toMatchObject({
            displacedState: { state: "preserved", displayPath: "/profile.displaced" },
            requiresRestart: true,
            restoredDesktopPreferences: true,
        });
        expect(projectStateRestoreActivation(restoreActivation({ state: "none" }), false)).toMatchObject({
            displacedState: { state: "none" },
            restoredDesktopPreferences: false,
        });
    });
});
