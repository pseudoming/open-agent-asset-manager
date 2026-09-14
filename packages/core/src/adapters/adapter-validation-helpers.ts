/** Shared strict primitives for static and observed adapter validation. */
import type { OperationDiagnostic } from "../types";

export const SOURCE_DOMAINS = new Set([
    "family_shared",
    "agent_runtime_private",
    "project_root",
    "project_keyed",
    "external_managed",
    "unknown",
]);

export const ROOT_LOCATOR_KINDS = new Set([
    "runtime_known_rule",
    "runtime_declared_path",
    "project_registry_entry",
    "user_provided_path",
    "unknown",
]);

export const ROOT_ROLES = new Set(["config", "source", "project_actual", "unknown"]);

export const SOURCE_EVIDENCE_LEVELS = new Set([
    "agent_runtime_verified",
    "local_artifact",
    "source_code",
    "docs_declared",
    "user_provided",
    "agent_answer",
]);

export function requireAllowed(
    value: unknown,
    allowed: ReadonlySet<unknown>,
    code: string,
    message: string,
    issues: OperationDiagnostic[],
): void {
    if (!allowed.has(value)) issues.push(issue(code, message));
}

export function requireNonBlank(value: string, label: string, issues: OperationDiagnostic[]): void {
    if (value.length === 0 || value.trim() !== value)
        issues.push(issue("adapter.noncanonical_text", `${label} must be non-blank and trimmed`));
}

export { compareCodeUnitText } from "../foundation/text-order";

export function issue(code: string, message: string): OperationDiagnostic {
    return {
        severity: "error",
        code,
        message,
        path: "",
        traceId: "",
        operation: "internal",
        causeKind: "invalid_schema",
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}
