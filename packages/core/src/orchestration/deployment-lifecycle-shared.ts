/** Deployment lifecycle result and diagnostic helpers. */

import type { CoreResult, OperationDiagnostic } from "../types";

export { compareUtf8Bytes } from "../foundation/text-order";

export function requireComplete<T>(result: CoreResult<T>): T {
    if (result.status === "complete") return result.value;
    const diagnostic = result.diagnostics[0];
    throw lifecycleFailure(
        diagnostic?.code ?? "reverse_accept.operation_incomplete",
        diagnostic?.message ?? "reverse-accept prerequisite did not complete",
        diagnostic?.causeKind ?? "unavailable",
        diagnostic?.retryable ?? false,
    );
}

export function failed<T>(error: unknown): CoreResult<T> {
    const problem =
        error instanceof DeploymentLifecycleFailure
            ? error
            : lifecycleFailure(
                  "reverse_accept.lifecycle_unavailable",
                  `reverse-accept lifecycle is unavailable: ${String(error)}`,
                  "unavailable",
                  true,
              );
    const diagnostic: OperationDiagnostic = {
        severity: "error",
        code: problem.code,
        message: problem.message,
        path: "",
        traceId: "",
        operation: "reverse_accept",
        causeKind: problem.causeKind,
        retryable: problem.retryable,
        suggestedActions: problem.retryable ? ["retry"] : [],
        rawSummary: problem.message,
    };
    return { status: "failed", value: undefined as T, diagnostics: [diagnostic] };
}

export class DeploymentLifecycleFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly causeKind: OperationDiagnostic["causeKind"],
        readonly retryable: boolean,
    ) {
        super(message);
    }
}

export function lifecycleFailure(
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"] = "invalid_schema",
    retryable = false,
): DeploymentLifecycleFailure {
    return new DeploymentLifecycleFailure(code, message, causeKind, retryable);
}
