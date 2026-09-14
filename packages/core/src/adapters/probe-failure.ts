import type { AdapterId, OperationDiagnostic, PlatformContext, ProbeResult } from "../types";

export function failedProbeResult(
    adapterId: AdapterId,
    platformContext: PlatformContext,
    diagnostics: OperationDiagnostic[],
): ProbeResult {
    return {
        status: "failed",
        observation: {
            adapterId,
            platformContext: structuredClone(platformContext),
            observedAgentRuntimes: [],
            sourceRoots: [],
            agentRuntimeResources: [],
            observedProjects: [],
            targetCandidates: [],
        },
        diagnostics,
    };
}

export function probeExceptionDiagnostic(adapterId: AdapterId, error: unknown): OperationDiagnostic {
    let detail: string;
    try {
        detail = String(error).slice(0, 2_048);
    } catch {
        detail = "unprintable Provider failure";
    }
    return {
        severity: "error",
        code: "probe_error",
        message: `adapter "${adapterId}" probe threw: ${detail}`,
        operation: "probe",
        causeKind: "unavailable",
        path: "",
        traceId: "",
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}
