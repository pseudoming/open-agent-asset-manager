/** Strict OperationDiagnostic shape at the private source wire boundary; payload integrity alone is insufficient. */
import { hasExactKeys } from "../foundation/validators";
import type { OperationDiagnostic } from "../types";

export function isRestrictedSourceDiagnostics(value: unknown): value is OperationDiagnostic[] {
    return (
        Array.isArray(value) &&
        value.every((entry) => {
            if (
                !hasExactKeys(entry, [
                    "severity",
                    "code",
                    "message",
                    "path",
                    "traceId",
                    "operation",
                    "causeKind",
                    "retryable",
                    "suggestedActions",
                    "rawSummary",
                ])
            )
                return false;
            const diagnostic = entry as OperationDiagnostic;
            return (
                ["info", "warning", "error"].includes(diagnostic.severity) &&
                [diagnostic.code, diagnostic.message, diagnostic.path, diagnostic.traceId, diagnostic.rawSummary].every(
                    (field) => typeof field === "string",
                ) &&
                [
                    "project",
                    "asset",
                    "version",
                    "probe",
                    "read",
                    "render",
                    "deploy",
                    "scan",
                    "search",
                    "reindex",
                    "settings",
                    "backup",
                    "restore",
                    "reverse_accept",
                    "internal",
                ].includes(diagnostic.operation) &&
                [
                    "not_found",
                    "unavailable",
                    "permission_denied",
                    "version_incompatible",
                    "partial",
                    "invalid_schema",
                    "unsupported",
                    "conflict",
                    "verification_failed",
                    "internal_error",
                ].includes(diagnostic.causeKind) &&
                typeof diagnostic.retryable === "boolean" &&
                Array.isArray(diagnostic.suggestedActions) &&
                diagnostic.suggestedActions.every((action) =>
                    [
                        "retry",
                        "grant_permission",
                        "install_runtime",
                        "upgrade_runtime",
                        "upgrade_adapter",
                        "choose_target",
                        "rebuild_deployment",
                        "skip",
                        "contact_support",
                    ].includes(action),
                )
            );
        })
    );
}
