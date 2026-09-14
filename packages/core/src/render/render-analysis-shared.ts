/** Render-analysis typed failures and deterministic diagnostics. */

import type { CoreResult, OperationDiagnostic } from "../types";

export { compareUtf8Bytes } from "../foundation/text-order";

export class RenderAnalysisFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly causeKind: OperationDiagnostic["causeKind"] = "invalid_schema",
        readonly retryable = false,
    ) {
        super(message);
    }
}

export function failedResult<T>(error: unknown): CoreResult<T> {
    return { status: "failed", value: undefined as T, diagnostics: [diagnosticFromError(error)] };
}

export function diagnosticFromError(error: unknown): OperationDiagnostic {
    const known = error instanceof RenderAnalysisFailure;
    const message = error instanceof Error ? error.message : String(error);
    return {
        severity: "error",
        code: known ? error.code : "render.internal_error",
        message,
        path: "",
        traceId: "",
        operation: "render",
        causeKind: known ? error.causeKind : "internal_error",
        retryable: known ? error.retryable : false,
        suggestedActions: known && error.retryable ? ["retry"] : [],
        rawSummary: message,
    };
}
