import type { ProtocolOperationOutcomeV1, ProtocolOperationOutcomeWithFailedValueV1 } from "@oaam/app-server-protocol";
import type { CoreResult, LookupResult, OperationDiagnostic, Sha256Digest } from "@oaam/core";

const projectedOperationalDiagnosticCodes = new WeakMap<object, string>();
const EXECUTABLE_OBSERVATION_STAGES = new Set([
    "profile",
    "binding_before",
    "host_invocation",
    "runtime_observation",
    "binding_after",
    "output_parse",
]);
const EXECUTABLE_OBSERVATION_FAILURES = new Set([
    "runtime_root_not_observed",
    "host_invocation_failed",
    "timed_out",
    "nonzero_exit",
    "output_limit_exceeded",
    "cleanup_incomplete",
    "identity_changed",
    "malformed_output",
    "other",
]);
const EXECUTABLE_OBSERVATION_OWNER_CODES = new Set([
    "binding_inspection_failed",
    "cleanup_incomplete",
    "host_invocation_exception",
    "host_invocation_failed",
    "host_output_limit",
    "host_timeout",
    "identity_changed",
    "malformed_output",
    "observer_exited_before_ready",
    "observer_exited_while_target_running",
    "observer_failed",
    "observer_output_limit",
    "observer_ready_malformed",
    "observer_ready_not_observed",
    "observer_ready_timeout",
    "observer_signal_failed",
    "observer_stderr",
    "observer_handshake_failed",
    "observer_process_tree_remains",
    "process_tree_remains",
    "process_exit_nonzero",
    "process_timeout",
    "profile_invalid",
    "runtime_cleanup_required",
    "runtime_root_not_observed",
    "runtime_observation_failed",
    "runtime_observation_identity_changed",
    "runtime_observation_output_limit",
    "runtime_observation_process_exited",
    "runtime_observation_protocol_failed",
    "runtime_observation_resource_limit",
    "runtime_observation_timed_out",
    "runtime_observation_wsl_process_transition_selected_wsl_invocation_exceeded_its_deadline",
    "selected_wsl_invocation_failed",
    "target_exited_before_observer_ready",
    "unclassified",
    "worker_protocol",
]);
const EXECUTABLE_OBSERVATION_EXIT_KINDS = new Set(["zero", "nonzero", "signal", "unavailable"]);
const EXECUTABLE_OBSERVATION_IDENTITIES = new Set(["stable", "changed", "unverified"]);
const EXECUTABLE_OBSERVATION_TIMEOUTS = new Set(["within_bound", "expired", "unverified"]);
const EXECUTABLE_OBSERVATION_CLEANUPS = new Set(["complete", "incomplete", "unverified"]);
const EXECUTABLE_OBSERVATION_V2_KEYS = [
    "cleanup",
    "exitKind",
    "failure",
    "identity",
    "ownerCode",
    "schemaVersion",
    "stage",
    "timeout",
] as const;
const EXECUTABLE_OBSERVATION_V3_KEYS = [
    ...EXECUTABLE_OBSERVATION_V2_KEYS,
    "elapsedMilliseconds",
    "stderrByteCount",
    "stderrSha256",
    "stdoutByteCount",
    "stdoutSha256",
] as const;
const SELECTED_WSL_OBSERVATION_STAGES = new Set([
    "request_parse",
    "helper_invocation",
    "receipt_validation",
    "item_observation",
    "host_projection",
]);
const SELECTED_WSL_OBSERVATION_FAILURES = new Set([
    "invalid_frame",
    "unsupported_architecture",
    "invalid_path",
    "root_open_failed",
    "target_not_found",
    "target_conflict",
    "symlink_or_magiclink",
    "wrong_entry_type",
    "permission_denied",
    "resource_limit",
    "identity_changed",
    "timeout",
    "helper_invocation_failed",
    "helper_cleanup_incomplete",
    "helper_output_limit",
    "worker_start_failed",
    "worker_protocol_failed",
    "worker_exited",
    "worker_cleanup_incomplete",
    "receipt_invalid",
    "unclassified",
]);
const SELECTED_WSL_OBSERVATION_KEYS = ["failure", "itemIndex", "schemaVersion", "stage"] as const;

export function toProtocolSha256(value: Sha256Digest): string {
    return value.slice("sha256:".length);
}

export function toCoreSha256(value: string): Sha256Digest {
    return `sha256:${value}` as Sha256Digest;
}

export function projectDiagnostic(diagnostic: OperationDiagnostic) {
    const projected = {
        severity: diagnostic.severity,
        code: diagnostic.code,
        operation: diagnostic.operation,
        causeKind: diagnostic.causeKind,
        retryable: diagnostic.retryable,
        suggestedActions: [...diagnostic.suggestedActions],
        message: diagnostic.message,
        ...(diagnostic.traceId === "" ? {} : { traceId: diagnostic.traceId }),
        ...(diagnostic.path === "" ? {} : { path: diagnostic.path }),
    };
    const operationalCode =
        executableObservationOperationalCode(diagnostic.rawSummary) ??
        selectedWslObservationOperationalCode(diagnostic.rawSummary);
    if (operationalCode !== null) projectedOperationalDiagnosticCodes.set(projected, operationalCode);
    return projected;
}

export function projectedOutcomeOperationalDiagnosticCodes(value: unknown): readonly string[] {
    if (!isRecord(value) || !Array.isArray(value.diagnostics)) return Object.freeze([]);
    const codes = value.diagnostics.flatMap((diagnostic) => {
        if (!isRecord(diagnostic)) return [];
        const code = projectedOperationalDiagnosticCodes.get(diagnostic);
        return code === undefined ? [] : [code];
    });
    return Object.freeze([...new Set(codes)].sort());
}

function executableObservationOperationalCode(rawSummary: string): string | null {
    if (rawSummary.length === 0 || rawSummary.length > 2_048) return null;
    let value: unknown;
    try {
        value = JSON.parse(rawSummary);
    } catch {
        return null;
    }
    if (!isRecord(value) || (value.schemaVersion !== 2 && value.schemaVersion !== 3)) return null;
    if (
        (value.schemaVersion === 2 && !hasExactKeys(value, EXECUTABLE_OBSERVATION_V2_KEYS)) ||
        (value.schemaVersion === 3 && !hasExactKeys(value, EXECUTABLE_OBSERVATION_V3_KEYS))
    ) {
        return null;
    }
    const { stage, failure, ownerCode, exitKind, identity, timeout, cleanup } = value;
    if (
        typeof stage !== "string" ||
        !EXECUTABLE_OBSERVATION_STAGES.has(stage) ||
        typeof failure !== "string" ||
        !EXECUTABLE_OBSERVATION_FAILURES.has(failure) ||
        typeof ownerCode !== "string" ||
        !EXECUTABLE_OBSERVATION_OWNER_CODES.has(ownerCode) ||
        typeof exitKind !== "string" ||
        !EXECUTABLE_OBSERVATION_EXIT_KINDS.has(exitKind) ||
        typeof identity !== "string" ||
        !EXECUTABLE_OBSERVATION_IDENTITIES.has(identity) ||
        typeof timeout !== "string" ||
        !EXECUTABLE_OBSERVATION_TIMEOUTS.has(timeout) ||
        typeof cleanup !== "string" ||
        !EXECUTABLE_OBSERVATION_CLEANUPS.has(cleanup)
    ) {
        return null;
    }
    const code = [
        `provider.executable_observation.v${String(value.schemaVersion)}`,
        `stage=${stage}`,
        `owner=${ownerCode}`,
        `failure=${failure}`,
        `exit=${exitKind}`,
        `identity=${identity}`,
        `timeout=${timeout}`,
        `cleanup=${cleanup}`,
    ];
    if (value.schemaVersion === 3) {
        if (
            !isBoundedElapsedMilliseconds(value.elapsedMilliseconds) ||
            !isBoundedOutputProjection(value.stdoutByteCount, value.stdoutSha256) ||
            !isBoundedOutputProjection(value.stderrByteCount, value.stderrSha256)
        ) {
            return null;
        }
        code.push(
            `elapsed_ms=${String(value.elapsedMilliseconds)}`,
            `stdout=${boundedOutputCode(value.stdoutByteCount, value.stdoutSha256)}`,
            `stderr=${boundedOutputCode(value.stderrByteCount, value.stderrSha256)}`,
        );
    }
    return code.join(":");
}

function isBoundedElapsedMilliseconds(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isBoundedOutputProjection(byteCount: unknown, sha256: unknown): boolean {
    if (byteCount === null || sha256 === null) return byteCount === null && sha256 === null;
    return Number.isSafeInteger(byteCount) && Number(byteCount) >= 0 && isSha256Digest(sha256);
}

function isSha256Digest(value: unknown): value is Sha256Digest {
    return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function boundedOutputCode(byteCount: unknown, sha256: unknown): string {
    return byteCount === null || sha256 === null ? "unavailable" : `${String(byteCount)}@${String(sha256)}`;
}

function selectedWslObservationOperationalCode(rawSummary: string): string | null {
    if (rawSummary.length === 0 || rawSummary.length > 2_048) return null;
    let value: unknown;
    try {
        value = JSON.parse(rawSummary);
    } catch {
        return null;
    }
    if (!isRecord(value) || !hasExactKeys(value, SELECTED_WSL_OBSERVATION_KEYS) || value.schemaVersion !== 1) return null;
    const { stage, failure, itemIndex } = value;
    if (
        typeof stage !== "string" ||
        !SELECTED_WSL_OBSERVATION_STAGES.has(stage) ||
        typeof failure !== "string" ||
        !SELECTED_WSL_OBSERVATION_FAILURES.has(failure) ||
        !(
            itemIndex === null ||
            (typeof itemIndex === "number" && Number.isSafeInteger(itemIndex) && itemIndex >= 0 && itemIndex < 256)
        )
    ) {
        return null;
    }
    return [
        "provider.selected_wsl_observation.v1",
        `stage=${stage}`,
        `failure=${failure}`,
        `item=${itemIndex === null ? "none" : String(itemIndex)}`,
    ].join(":");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function projectCoreOutcome<TCore, TProtocol>(
    result: CoreResult<TCore>,
    projectValue: (value: TCore) => TProtocol,
): ProtocolOperationOutcomeV1<TProtocol> {
    const diagnostics = result.diagnostics.map(projectDiagnostic);
    if (result.status === "failed") return { status: "failed", diagnostics };
    const value = projectValue(result.value);
    return result.status === "complete" ? { status: "complete", value, diagnostics } : { status: "partial", value, diagnostics };
}

export function projectCoreOutcomeWithFailedValue<TCore, TProtocol>(
    result: CoreResult<TCore>,
    projectValue: (value: TCore) => TProtocol,
): ProtocolOperationOutcomeWithFailedValueV1<TProtocol> {
    const diagnostics = result.diagnostics.map(projectDiagnostic);
    const value = projectValue(result.value);
    if (result.status === "complete") return { status: "complete", value, diagnostics };
    if (result.status === "partial") return { status: "partial", value, diagnostics };
    return { status: "failed", value, diagnostics };
}

export function projectLookup<TCore, TProtocol>(
    lookup: LookupResult<TCore>,
    projectValue: (value: TCore) => TProtocol,
): { readonly found: true; readonly value: TProtocol } | { readonly found: false } {
    return lookup.found && lookup.value !== undefined ? { found: true, value: projectValue(lookup.value) } : { found: false };
}

export function hostInvocationFailure<T>(): ProtocolOperationOutcomeV1<T> {
    return {
        status: "failed",
        diagnostics: [
            {
                severity: "error",
                code: "host.core_invocation_failed",
                operation: "host",
                causeKind: "internal_error",
                retryable: false,
                suggestedActions: ["contact_support"],
                message: "The Host could not produce a trustworthy Core result.",
            },
        ],
    };
}

export function hostCapacityFailure<T>(): ProtocolOperationOutcomeV1<T> {
    return {
        status: "failed",
        diagnostics: [
            {
                severity: "error",
                code: "host.operation_capacity_exceeded",
                operation: "host",
                causeKind: "unavailable",
                retryable: true,
                suggestedActions: ["retry"],
                message: "The Host cannot accept another long operation yet.",
            },
        ],
    };
}

export function hostReviewFailure<T>(failureKind: "record" | "member"): ProtocolOperationOutcomeV1<T> {
    return {
        status: "failed",
        diagnostics: [
            {
                severity: "error",
                code: failureKind === "record" ? "host.review_record_unavailable" : "host.review_record_member_unavailable",
                operation: "host",
                causeKind: failureKind === "record" ? "unavailable" : "not_found",
                retryable: failureKind === "record",
                suggestedActions: failureKind === "record" ? ["retry"] : ["choose_target"],
                message:
                    failureKind === "record"
                        ? "The retained Host review record is unavailable; refresh the review."
                        : "The selected member does not belong to the retained Host review record.",
            },
        ],
    };
}

export function hostReviewCapacityFailure<T>(): ProtocolOperationOutcomeV1<T> {
    return {
        status: "failed",
        diagnostics: [
            {
                severity: "error",
                code: "host.review_record_capacity_exceeded",
                operation: "host",
                causeKind: "unavailable",
                retryable: true,
                suggestedActions: ["retry"],
                message: "The Host cannot retain another review record within its bounded spool.",
            },
        ],
    };
}

export function hostPathSelectionFailure<T>(): ProtocolOperationOutcomeV1<T> {
    return {
        status: "failed",
        diagnostics: [
            {
                severity: "error",
                code: "host.path_selection_unavailable",
                operation: "host",
                causeKind: "unavailable",
                retryable: false,
                suggestedActions: ["choose_target"],
                message: "The one-shot trusted-launcher path selection is unavailable or has the wrong kind.",
            },
        ],
    };
}
