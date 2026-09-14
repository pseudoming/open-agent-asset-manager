import { protocolSha256Schema, protocolUuidV4Schema } from "./primitives";
import {
    protocolArray,
    protocolBoolean,
    protocolEnum,
    protocolLiteral,
    protocolNonBlankString,
    protocolNonNegativeInteger,
    protocolObject,
    protocolPositiveInteger,
    protocolUnion,
} from "./validation";

export const protocolStateBackupEncryptionModeSchema = protocolEnum(["none", "compatible_password", "strong_password"] as const);

export const protocolStateBackupInventoryEntrySchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        backupId: protocolUuidV4Schema,
        createdAt: protocolNonNegativeInteger,
        archiveDisplayPath: protocolNonBlankString,
        archiveByteSize: protocolNonNegativeInteger,
        archiveContentHash: protocolSha256Schema,
        manifestFingerprint: protocolSha256Schema,
        sourceSnapshotFingerprint: protocolSha256Schema,
        encryptionMode: protocolStateBackupEncryptionModeSchema,
        destinationKind: protocolEnum(["oaam_default", "custom_directory"] as const),
        observation: protocolEnum(["available", "missing", "replaced"] as const),
    },
    "State backup inventory entry",
);

export const protocolStateBackupInventorySchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        entries: protocolArray(protocolStateBackupInventoryEntrySchema),
        totalKnownArchiveBytes: protocolNonNegativeInteger,
        totalAvailableArchiveBytes: protocolNonNegativeInteger,
    },
    "State backup inventory",
);

export const protocolStateBackupReviewSchema = protocolObject(
    {
        backupReviewToken: protocolNonBlankString,
        backupId: protocolUuidV4Schema,
        createdAt: protocolNonNegativeInteger,
        destinationKind: protocolEnum(["oaam_default", "custom_directory"] as const),
        destinationDisplayPath: protocolNonBlankString,
        destinationState: protocolEnum(["ready", "create_required"] as const),
        outputFileName: protocolNonBlankString,
        encryptionMode: protocolStateBackupEncryptionModeSchema,
        sourceFileCount: protocolNonNegativeInteger,
        sourceLogicalBytes: protocolNonNegativeInteger,
        requiredAvailableBytes: protocolNonNegativeInteger,
        availableBytes: protocolNonNegativeInteger,
        sourceSnapshotFingerprint: protocolSha256Schema,
    },
    "State backup review",
);

export const protocolStateBackupArtifactSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        backupId: protocolUuidV4Schema,
        createdAt: protocolNonNegativeInteger,
        archiveDisplayPath: protocolNonBlankString,
        archiveByteSize: protocolNonNegativeInteger,
        archiveContentHash: protocolSha256Schema,
        manifestFingerprint: protocolSha256Schema,
        sourceSnapshotFingerprint: protocolSha256Schema,
        encryptionMode: protocolStateBackupEncryptionModeSchema,
    },
    "State backup artifact",
);

export const protocolStateBackupPromptPolicySchema = protocolUnion(
    [
        protocolObject(
            {
                configVersion: protocolLiteral(1),
                settingId: protocolLiteral("state_backup_prompt_policy_v1"),
                revision: protocolLiteral(0),
                mode: protocolLiteral("ask_every_time"),
                updatedAt: protocolLiteral(0),
                settingFingerprint: protocolSha256Schema,
            },
            "virgin State backup prompt policy",
        ),
        protocolObject(
            {
                configVersion: protocolLiteral(1),
                settingId: protocolLiteral("state_backup_prompt_policy_v1"),
                revision: protocolPositiveInteger,
                mode: protocolEnum(["ask_every_time", "back_up_first", "continue_without_prompt"] as const),
                userActionEvidenceId: protocolNonBlankString,
                updatedAt: protocolPositiveInteger,
                settingFingerprint: protocolSha256Schema,
            },
            "configured State backup prompt policy",
        ),
    ],
    "State backup prompt policy",
);

export const protocolStateRestoreReviewSchema = protocolObject(
    {
        restoreReviewToken: protocolNonBlankString,
        backupId: protocolUuidV4Schema,
        backupCreatedAt: protocolNonNegativeInteger,
        archiveDisplayPath: protocolNonBlankString,
        archiveByteSize: protocolNonNegativeInteger,
        archiveContentHash: protocolSha256Schema,
        encryptionMode: protocolStateBackupEncryptionModeSchema,
        sourceFileCount: protocolNonNegativeInteger,
        sourceLogicalBytes: protocolNonNegativeInteger,
        sourceSnapshotFingerprint: protocolSha256Schema,
        manifestFingerprint: protocolSha256Schema,
        includesDesktopPreferences: protocolBoolean,
    },
    "State restore review",
);

export const protocolStateRestoreActivationSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        restoreId: protocolUuidV4Schema,
        backupId: protocolUuidV4Schema,
        activatedAt: protocolNonNegativeInteger,
        restoredSourceSnapshotFingerprint: protocolSha256Schema,
        displacedState: protocolUnion(
            [
                protocolObject(
                    { state: protocolLiteral("preserved"), displayPath: protocolNonBlankString },
                    "preserved displaced State",
                ),
                protocolObject({ state: protocolLiteral("none") }, "no displaced State"),
            ],
            "displaced State",
        ),
        requiresRestart: protocolLiteral(true),
        restoredDesktopPreferences: protocolBoolean,
    },
    "State restore activation",
);

export const protocolStateBackupProgressSchema = protocolObject(
    {
        stage: protocolEnum(["inventory", "packing", "encryption", "verification", "commit"] as const),
        completedUnits: protocolNonNegativeInteger,
        totalUnits: protocolNonNegativeInteger,
    },
    "State backup progress",
);

export const protocolStateRestoreProgressSchema = protocolObject(
    {
        stage: protocolEnum(["inspection", "quiescence", "activation", "restart_required"] as const),
        completedUnits: protocolNonNegativeInteger,
        totalUnits: protocolNonNegativeInteger,
    },
    "State restore progress",
);

export const protocolStateBackupDestinationSchema = protocolUnion(
    [
        protocolObject({ destinationKind: protocolLiteral("oaam_default") }, "OAAM default backup destination"),
        protocolObject(
            {
                destinationKind: protocolLiteral("custom_directory"),
                localPathSelectionToken: protocolNonBlankString,
            },
            "selected custom backup destination",
        ),
    ],
    "State backup destination",
);

export const protocolStateRestoreSourceSchema = protocolUnion(
    [
        protocolObject(
            { sourceKind: protocolLiteral("inventory_backup"), backupId: protocolUuidV4Schema },
            "inventory State backup source",
        ),
        protocolObject(
            {
                sourceKind: protocolLiteral("selected_archive"),
                localPathSelectionToken: protocolNonBlankString,
            },
            "selected State backup archive",
        ),
    ],
    "State restore source",
);
