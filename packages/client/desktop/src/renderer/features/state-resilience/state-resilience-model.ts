import type { ProtocolOperationProgress, ProtocolOperationResult, ProtocolOperationTerminal } from "@oaam/app-server-protocol";
import type { StateBackupDestinationPickerResult } from "../../../bridge/desktop-bridge";
import type { DesktopMessageId } from "../../presentation";

export type BackupInventory = Extract<ProtocolOperationResult<"state_backup.list">, { readonly status: "complete" }>["value"];
export type BackupInventoryEntry = BackupInventory["entries"][number];
export type BackupPolicy = Extract<
    ProtocolOperationResult<"state_backup_prompt_policy.get">,
    { readonly status: "complete" }
>["value"];
export type BackupReview = Extract<ProtocolOperationTerminal<"state_backup.inspect">, { readonly status: "complete" }>["value"];
export type BackupArtifact = Extract<ProtocolOperationTerminal<"state_backup.create">, { readonly status: "complete" }>["value"];
export type RestoreReview = Extract<ProtocolOperationTerminal<"state_restore.inspect">, { readonly status: "complete" }>["value"];
export type RestoreActivation = Extract<
    ProtocolOperationTerminal<"state_restore.activate">,
    { readonly status: "complete" }
>["value"];
export type BackupEncryptionMode = BackupInventoryEntry["encryptionMode"];
export type BackupPromptMode = BackupPolicy["mode"];
export type BackupDestinationSelection = Extract<StateBackupDestinationPickerResult, { readonly status: "selected" }>;
export type RestoreSource =
    | { readonly sourceKind: "inventory_backup"; readonly backupId: string; readonly displayPath: string }
    | {
          readonly sourceKind: "selected_archive";
          readonly localPathSelectionToken: string;
          readonly displayPath: string;
      };
export type OperationProgress =
    | ProtocolOperationProgress<"state_backup.inspect">
    | ProtocolOperationProgress<"state_backup.create">
    | ProtocolOperationProgress<"state_restore.inspect">
    | ProtocolOperationProgress<"state_restore.activate">;

export const PROGRESS_STAGE_MESSAGES = {
    inventory: "state_resilience.stage.inventory",
    packing: "state_resilience.stage.packing",
    encryption: "state_resilience.stage.encryption",
    verification: "state_resilience.stage.verification",
    commit: "state_resilience.stage.commit",
    inspection: "state_resilience.stage.inspection",
    quiescence: "state_resilience.stage.quiescence",
    activation: "state_resilience.stage.activation",
    restart_required: "state_resilience.stage.restart_required",
} as const satisfies Readonly<Record<OperationProgress["stage"], DesktopMessageId>>;

export const OBSERVATION_MESSAGES = {
    available: "state_resilience.observation.available",
    missing: "state_resilience.observation.missing",
    replaced: "state_resilience.observation.replaced",
} as const satisfies Readonly<Record<BackupInventoryEntry["observation"], DesktopMessageId>>;

export const ENCRYPTION_SHORT_MESSAGES = {
    none: "state_resilience.encryption.short.none",
    compatible_password: "state_resilience.encryption.short.compatible_password",
    strong_password: "state_resilience.encryption.short.strong_password",
} as const satisfies Readonly<Record<BackupEncryptionMode, DesktopMessageId>>;

export function latestAvailableBackup(inventory: BackupInventory | undefined): BackupInventoryEntry | undefined {
    return inventory === undefined
        ? undefined
        : [...inventory.entries]
              .filter((entry) => entry.observation === "available")
              .sort((left, right) => right.createdAt - left.createdAt)[0];
}
