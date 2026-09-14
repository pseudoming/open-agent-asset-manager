import type {
    DeploymentActionHintV1,
    DeploymentStage,
    DeploymentStatus,
    DeploymentBlockingEvidenceV1,
    ObservationState,
    ObservedFileState,
    OperationDiagnostic,
} from "../types";

/**
 * Deployment status derivation — pure function.
 *
 * Implements the 5-stable-stage priority truth table from
 * CORE_DATA_MODEL_DRAFT.md §8.10 + CORE_API.md §7.1.
 *
 * Priority flow (CORE_DATA_MODEL_DRAFT.md:1060-1077):
 *   deleted → needs_recovery(internal) → blocked → conflict → needs_repair → in_sync
 *
 * `needs_recovery` is NOT a public DeploymentStage (types.ts:713-716). When
 * an unresolved journal exists, the caller first attempts automatic recovery;
 * if recovery fails, `deriveDeploymentStatus` returns `blocked` with a
 * recovery reason code.
 *
 * This function is PURE: it does not read the file system, does not write to
 * the DB, and does not perform recovery. It takes the current Deployment state
 * + observation inputs and returns the derived status.
 *
 * IMPORTANT: this function derives conflict/needs_repair from the RAW observed
 * fields (observedState, observedContentHash vs appliedContentHash,
 * observedExecutable vs appliedExecutable). It does NOT trust caller-provided
 * boolean flags. This prevents inconsistent inputs from bypassing the state
 * machine (audit fix Phase 14 Addition 1).
 */

// ============================================================
// Input type
// ============================================================

/** Input for deriveDeploymentStatus. All fields must be provided by the caller
 *  (core layer reads them from state DB + observation results before calling). */
export interface DeploymentDerivationInput {
    /** Deployment row fields. */
    deleted: boolean;
    observationState: ObservationState;
    blockingEvidence: Pick<DeploymentBlockingEvidenceV1, "reasonCode" | "operation" | "contextFingerprint">;
    /** Whether there is an unresolved journal (active/residual). */
    hasUnresolvedJournal: boolean;
    /** Whether automatic recovery has been attempted and failed. */
    recoveryFailed: boolean;
    /** Whether this Deployment owns a successful applied render baseline. */
    hasAppliedBaseline: boolean;
    /** Results of a complete, trusted observation of deployment files.
     *  Empty array = no file-level observation available (observationState
     *  should be "never" in that case). */
    fileObservations: FileObservationInput[];
}

/** Observation of a single deployment file relative to the success baseline.
 *
 *  The function derives conflict/needs_repair from the RAW fields below;
 *  it does NOT accept pre-computed boolean flags. This is deliberate:
 *  the state machine must not be bypassable by inconsistent caller inputs. */
export interface FileObservationInput {
    relativePath: string;
    /** The applied (success baseline) content hash. */
    appliedContentHash: string;
    /** Observed state: present | missing | never. */
    observedState: ObservedFileState;
    /** Observed content hash when present; "" when missing/never. */
    observedContentHash: string;
    /** Applied (success baseline) executable bit. */
    appliedExecutable: boolean;
    /** Executable fact observed from the selected physical filesystem backend. */
    observedExecutable: boolean;
}

// ============================================================
// Output builders
// ============================================================

function status(
    stage: DeploymentStage,
    reason: string,
    actionHints: DeploymentActionHintV1[],
    diagnostics: OperationDiagnostic[] = [],
    observationWarnings: OperationDiagnostic[] = [],
): DeploymentStatus {
    return { stage, reason, diagnostics, observationWarnings, actionHints };
}

const SUPPORT_REQUIRED_BLOCKED_REASONS = new Set([
    "blocked_by_recovery_journal_corrupt",
    "blocked_by_recovery_target_changed",
    "blocked_by_recovery_evidence_conflict",
    "blocked_needs_support",
]);

function blockedActions(reason: string): DeploymentActionHintV1[] {
    if (SUPPORT_REQUIRED_BLOCKED_REASONS.has(reason)) {
        return ["contact_support"];
    }
    if (reason.startsWith("blocked_by_recovery_")) return ["recover"];
    return ["review_deployment"];
}

function opDiag(
    code: string,
    message: string,
    severity: "info" | "warning" | "error" = "warning",
    path = "",
    operation: OperationDiagnostic["operation"] = "scan",
): OperationDiagnostic {
    return {
        severity,
        code,
        message,
        path,
        traceId: "",
        operation,
        causeKind: "partial",
        retryable: false,
        suggestedActions: [],
        rawSummary: message,
    };
}

// ============================================================
// Observation warnings
// ============================================================

function observationWarnings(state: string): OperationDiagnostic[] {
    const warnings: OperationDiagnostic[] = [];
    if (state === "never") {
        warnings.push(opDiag("observation.never", "No observation has been performed yet"));
    }
    if (state === "partial") {
        warnings.push(opDiag("observation.partial", "Last observation was incomplete; results may be stale"));
    }
    if (state === "failed") {
        warnings.push(opDiag("observation.failed", "Last observation failed; results may be stale"));
    }
    if (state === "in_progress") {
        warnings.push(opDiag("observation.in_progress", "Observation is currently in progress"));
    }
    return warnings;
}

// ============================================================
// File-level derivation (from RAW fields, not caller booleans)
// ============================================================

/** A file is a conflict candidate when present and content hash differs from applied. */
function isFileRuntimeChanged(f: FileObservationInput): boolean {
    return f.observedState === "present" && f.observedContentHash !== f.appliedContentHash;
}

/** A file is a repair candidate when:
 *  - confirmed missing (observedState === "missing"), OR
 *  - present with same content hash but executable bit differs (CORE_DATA_MODEL_DRAFT.md:1668-1680) */
function isFileNeedsRepair(f: FileObservationInput): boolean {
    if (f.observedState === "missing") return true;
    // Execute bit drift on a present file with matching content → needs_repair
    if (f.observedState === "present" && f.observedContentHash === f.appliedContentHash) {
        return f.appliedExecutable !== f.observedExecutable;
    }
    return false;
}

// ============================================================
// Blocked reason validation
// ============================================================

const RECOVERY_REASON_CODES = [
    "blocked_by_recovery_journal_corrupt",
    "blocked_by_recovery_target_changed",
    "blocked_by_recovery_permission_denied",
    "blocked_by_recovery_target_unavailable",
    "blocked_by_recovery_state_unavailable",
    "blocked_by_recovery_evidence_conflict",
] as const;

/** Check if blockingEvidence has a VALID reason code that applies in the
 *  current context.
 *
 *  - Empty reasonCode → not blocked (falls through).
 *  - Unknown reasonCode (not in BLOCKED_REASON_CODES) → mapped to
 *    blocked_needs_support (public reason contract stability, audit fix).
 *  - Recovery reason codes → only valid when recoveryFailed is true.
 *  - Known non-recovery reason codes → always valid. */
function resolveBlockedReason(reasonCode: string, recoveryFailed: boolean): string | null {
    if (reasonCode === "") return null;

    // Check if it's a known code
    if (!isValidBlockedReasonCode(reasonCode)) {
        // Unknown reason → fall back to blocked_needs_support (audit fix #1)
        return "blocked_needs_support";
    }

    // Recovery reason codes require recoveryFailed
    if ((RECOVERY_REASON_CODES as readonly string[]).includes(reasonCode)) {
        return recoveryFailed ? reasonCode : null;
    }

    return reasonCode;
}

// ============================================================
// Main derivation function
// ============================================================

/**
 * Derive the Deployment status from current state + observation inputs.
 *
 * Priority order (CORE_DATA_MODEL_DRAFT.md:1109-1118):
 * 1. deleted → stage "deleted"
 * 2. needs_recovery (internal) → if recovery failed → blocked + recovery reason
 * 3. blocked → blockingEvidence valid
 * 4. conflict → runtime-changed files exist
 * 5. needs_repair → missing files or executable drift, no runtime-changed
 * 6. in_sync → everything matches
 *
 * observationState warnings are appended when != complete and no higher
 * priority state preempts (CORE_DATA_MODEL_DRAFT.md:1033-1037).
 */
export function deriveDeploymentStatus(input: DeploymentDerivationInput): DeploymentStatus {
    // 1. deleted
    if (input.deleted) {
        return status("deleted", "", []);
    }

    // 2. needs_recovery (internal)
    //    If unresolved journal exists, core should attempt recovery BEFORE
    //    calling this function. If recoveryFailed is true, we return blocked
    //    with a recovery reason. If recoveryFailed is false but journal exists,
    //    we also return blocked (recovery not yet attempted or not applicable).
    if (input.hasUnresolvedJournal) {
        if (input.recoveryFailed) {
            const reason = resolveBlockedReason(input.blockingEvidence.reasonCode, true) || "blocked_by_recovery_journal_corrupt";
            return status("blocked", reason, blockedActions(reason));
        }
        // Journal exists but recovery not failed — still blocked, waiting for recovery
        return status("blocked", "blocked_by_recovery_state_unavailable", ["recover"]);
    }

    // 3. blocked (blockingEvidence valid — unknown reasons → blocked_needs_support)
    const blockedReason = resolveBlockedReason(input.blockingEvidence.reasonCode, input.recoveryFailed);
    if (blockedReason !== null) {
        return status("blocked", blockedReason, blockedActions(blockedReason));
    }

    // 4-5. Check file observations for conflict / needs_repair
    //    Derive from RAW fields — do not trust caller-provided booleans (audit fix #2)
    const obsWarnings = observationWarnings(input.observationState);
    const hasRuntimeChanged = input.fileObservations.some(isFileRuntimeChanged);
    const hasNeedsRepair = input.fileObservations.some(isFileNeedsRepair);

    // 4. conflict (priority over needs_repair)
    if (hasRuntimeChanged) {
        return status("conflict", "", ["review_external_changes", "check_now"], [], obsWarnings);
    }

    // 5. needs_repair
    if (hasNeedsRepair) {
        return status("needs_repair", "", ["review_repair", "check_now"], [], obsWarnings);
    }

    // 6. in_sync
    return status("in_sync", "", [input.hasAppliedBaseline ? "check_now" : "review_deployment"], [], obsWarnings);
}

// ============================================================
// All valid blocked reason codes (for testing / documentation)
// ============================================================

export const BLOCKED_REASON_CODES = [
    "blocked_by_deleted_dependency",
    "blocked_by_unavailable_adapter",
    "blocked_by_unavailable_consumer",
    "blocked_by_unsupported_asset_type",
    "blocked_by_unsupported_asset_combination",
    "blocked_by_missing_required_input",
    "blocked_by_unrenderable_asset",
    "blocked_by_adapter_plan_error",
    "blocked_by_deploy_target_unavailable",
    "blocked_by_deploy_permission_denied",
    "blocked_by_deploy_insufficient_space",
    "blocked_by_deploy_target_locked",
    "blocked_by_deploy_verification_failed",
    "blocked_by_recovery_journal_corrupt",
    "blocked_by_recovery_target_changed",
    "blocked_by_recovery_permission_denied",
    "blocked_by_recovery_target_unavailable",
    "blocked_by_recovery_state_unavailable",
    "blocked_by_recovery_evidence_conflict",
    "blocked_needs_support",
] as const;

/** Verify that a reason code is one of the 20 approved codes. */
export function isValidBlockedReasonCode(code: string): boolean {
    return (BLOCKED_REASON_CODES as readonly string[]).includes(code);
}
