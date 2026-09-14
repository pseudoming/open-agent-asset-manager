/**
 * Core-owned failure normalization and diagnostics for adapter reads.
 */

import { SafeFilesystemError } from "@oaam/shared/filesystem";
import type { OperationDiagnostic, ReadAccessOutcomeStatus } from "../types";
import { stableStringify } from "../foundation/fingerprint";
import { ReadAccessFailure } from "./adapter-read-budget";

export function normalizeReadFailure(error: unknown): ReadAccessFailure {
    if (error instanceof ReadAccessFailure) {
        return error;
    }
    if (error instanceof SafeFilesystemError) {
        const statuses: Record<SafeFilesystemError["failureKind"], Exclude<ReadAccessOutcomeStatus, "succeeded">> = {
            invalid_path: "io_error",
            not_found: "not_found",
            permission_denied: "permission_denied",
            symlink_or_reparse: "blocked_symlink_or_reparse",
            wrong_entry_type: "io_error",
            resource_limit: "resource_limit_exceeded",
            stale: "stale",
            unsupported_platform: "io_error",
            io_error: "io_error",
        };
        return new ReadAccessFailure(statuses[error.failureKind], error.message);
    }
    return new ReadAccessFailure("io_error", String(error));
}

export function readDiagnostic(
    code: string,
    message: string,
    status: Exclude<ReadAccessOutcomeStatus, "succeeded">,
): OperationDiagnostic {
    return {
        severity: "error",
        code,
        message,
        path: "",
        traceId: "",
        operation: "read",
        causeKind:
            status === "not_found"
                ? "not_found"
                : status === "permission_denied"
                  ? "permission_denied"
                  : status === "blocked_symlink_or_reparse" || status === "stale"
                    ? "verification_failed"
                    : "unavailable",
        retryable: status === "busy" || status === "stale" || status === "io_error",
        suggestedActions: status === "permission_denied" ? ["grant_permission"] : [],
        rawSummary: stableStringify({ status, message }),
    };
}

export function readFailureDiagnostic(failure: ReadAccessFailure): OperationDiagnostic {
    return readDiagnostic(
        failure.status === "resource_limit_exceeded" ? "read.resource_limit_exceeded" : "read_access_failed",
        failure.message,
        failure.status,
    );
}
