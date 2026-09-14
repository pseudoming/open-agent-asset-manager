/** Stable render-analysis facade. */

export type { AnalyzeRenderDeploymentConfiguration } from "./render-analysis-orchestrator";
export { analyzeRenderDeployment } from "./render-analysis-orchestrator";
export { deriveRequiredRenderSemanticsV1, validateRenderDeploymentInput } from "./render-semantics";
export {
    validateAdapterRenderAnalysisResult,
    validateAnalysisView,
    validateDialectInputProjection,
} from "./render-analysis-validator";
export { RenderAnalysisFailure } from "./render-analysis-shared";
