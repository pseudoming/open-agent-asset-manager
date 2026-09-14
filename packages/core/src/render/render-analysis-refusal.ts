/** A fully classified semantic refusal carries no render or write authority. */
import type { AdapterRenderAnalysisResult } from "../contracts/render";
import type { OperationDiagnostic } from "../types";

export function isExplicitUnsupportedAnalysis(result: AdapterRenderAnalysisResult): boolean {
    return (
        result.status === "failed" &&
        result.outputUnits.length === 0 &&
        result.semanticOptions.length === 0 &&
        result.blockedSemanticRefs.length > 0 &&
        unsupported(result.diagnostics) &&
        result.blockedSemanticRefs.every((ref) => unsupported(ref.diagnostics))
    );
}

function unsupported(diagnostics: readonly OperationDiagnostic[]): boolean {
    return (
        diagnostics.length > 0 &&
        diagnostics.every((diagnostic) => diagnostic.causeKind === "unsupported" && diagnostic.retryable === false)
    );
}
