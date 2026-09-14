/** Bounded target-read failures; raw paths and operating-system error text never cross the usage channel. */
import { normalizeReadFailure, readDiagnostic } from "../adapters/adapter-read-diagnostics";
import type { OperationDiagnostic, ReadAccessOutcomeStatus } from "../types";
import type { AssetUsageTargetObservation } from "./asset-usage-target-observation";

export type AssetUsageTargetFailureStatus = Exclude<ReadAccessOutcomeStatus, "succeeded" | "not_found">;

const TARGET_FAILURE_MESSAGES: Record<AssetUsageTargetFailureStatus, string> = {
    permission_denied: "The target file could not be read because access was denied.",
    blocked_managed_target: "The target belongs to managed content that cannot be read for this operation.",
    blocked_symlink_or_reparse: "The target path contains a symbolic link or reparse point.",
    resource_limit_exceeded: "The target exceeds the bounded file or directory inspection limit.",
    busy: "The target is busy. Retry the check after the other operation finishes.",
    stale: "The target changed while it was being checked. Run a fresh check.",
    io_error: "The target could not be read. Check its availability and retry.",
};

export function isAssetUsageTargetFailureStatus(value: unknown): value is AssetUsageTargetFailureStatus {
    return typeof value === "string" && Object.hasOwn(TARGET_FAILURE_MESSAGES, value);
}

export function assetUsageTargetFailureObservation(error: unknown): AssetUsageTargetObservation {
    const status = normalizeReadFailure(error).status;
    // Ordinary missing files/root directories are classified as absent by their immediate read owner.
    // Missing an entry already inventoried, or losing it during the final stability check, is stale.
    return {
        observedTargetState: "unknown",
        physicalRelation: "distinct_or_not_imported",
        failureStatus: status === "not_found" ? "stale" : status,
    };
}

export function assetUsageTargetFailureDiagnostic(status: AssetUsageTargetFailureStatus): OperationDiagnostic {
    return {
        ...readDiagnostic(`render.target_observation_${status}`, TARGET_FAILURE_MESSAGES[status], status),
        operation: "render",
    };
}
