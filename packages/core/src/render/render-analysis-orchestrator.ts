/** Render-analysis provider dispatch and aggregate view orchestration. */

import type { RequiredRenderSemantic } from "../contracts/deployment-authority";
import type { AdapterProviderSummary } from "../contracts/source-import";
import type {
    AdapterRenderAnalysisResult,
    ProviderRenderDialectInputsForAsset,
    RenderAnalysisInput,
    RenderAnalysisResult,
    RenderAnalysisView,
    RenderDeploymentInput,
} from "../contracts/render";
import type { CoreResult, OperationDiagnostic } from "../types";
import type { RenderRegistrySnapshot } from "./render-registry";
import { deriveRequiredRenderSemanticsV1, validateRenderDeploymentInput } from "./render-semantics";
import {
    validateAdapterRenderAnalysisResult,
    validateAnalysisView,
    buildProviderAnalysisInput,
    groupSemanticsByOwner,
} from "./render-analysis-validator";
import { RenderAnalysisFailure, failedResult, compareUtf8Bytes } from "./render-analysis-shared";
import { isExplicitUnsupportedAnalysis } from "./render-analysis-refusal";

export interface AnalyzeRenderDeploymentConfiguration {
    registry: RenderRegistrySnapshot;
    resolveDialectInputs(
        provider: AdapterProviderSummary,
        deployment: RenderDeploymentInput,
        requiredSemantics: readonly RequiredRenderSemantic[],
    ): ProviderRenderDialectInputsForAsset[];
    dispatch(adapterId: string, input: RenderAnalysisInput): Promise<CoreResult<AdapterRenderAnalysisResult>>;
}

export async function analyzeRenderDeployment(
    sourceDeployment: RenderDeploymentInput,
    configuration: AnalyzeRenderDeploymentConfiguration,
): Promise<CoreResult<RenderAnalysisView>> {
    try {
        const deployment = structuredClone(sourceDeployment);
        configuration = Object.freeze({ ...configuration });
        validateRenderDeploymentInput(deployment, configuration.registry);
        const requiredSemantics = deriveRequiredRenderSemanticsV1(deployment);
        const groups = groupSemanticsByOwner(requiredSemantics, configuration.registry);
        const analyses: RenderAnalysisResult[] = [];
        const diagnostics: OperationDiagnostic[] = [];
        let partial = false;

        for (const [provider, semantics] of groups) {
            if (!provider.enabled) {
                throw new RenderAnalysisFailure(
                    "render.consumer_owner_disabled",
                    `consumer owner is disabled: ${provider.adapterId}`,
                    "unavailable",
                );
            }
            const input = buildProviderAnalysisInput(
                deployment,
                provider,
                semantics,
                structuredClone(
                    configuration.resolveDialectInputs(provider, structuredClone(deployment), structuredClone(semantics)),
                ),
            );
            const dispatched = await configuration.dispatch(provider.adapterId, structuredClone(input));
            diagnostics.push(...dispatched.diagnostics);
            const explicitRefusal =
                dispatched.status === "failed" &&
                dispatched.value !== undefined &&
                isExplicitUnsupportedAnalysis(dispatched.value) &&
                validateAdapterRenderAnalysisResult(provider, input, dispatched.value).length === 0;
            if (dispatched.status === "failed" && !explicitRefusal) {
                const failure = failedResult<RenderAnalysisView>(
                    new RenderAnalysisFailure(
                        "render.provider_analysis_failed",
                        `consumer owner analysis failed: ${provider.adapterId}`,
                        "unavailable",
                        true,
                    ),
                );
                return { ...failure, diagnostics: [...diagnostics, ...failure.diagnostics] };
            }
            const providerResult = structuredClone(dispatched.value);
            const validation = explicitRefusal ? [] : validateAdapterRenderAnalysisResult(provider, input, providerResult);
            if (validation.length > 0) {
                const first = validation[0] as OperationDiagnostic;
                throw new RenderAnalysisFailure(first.code, first.message, first.causeKind, first.retryable);
            }
            if (dispatched.status === "partial" || explicitRefusal) partial = true;
            analyses.push({
                ...providerResult,
                adapterId: provider.adapterId,
                adapterVersion: provider.version,
            });
        }

        const view: RenderAnalysisView = {
            renderInputFingerprint: deployment.renderInputFingerprint,
            requiredSemantics,
            analyses: analyses.sort((left, right) => compareUtf8Bytes(left.adapterId, right.adapterId)),
        };
        validateAnalysisView(view, deployment, configuration.registry);
        return { status: partial ? "partial" : "complete", value: view, diagnostics };
    } catch (error) {
        return failedResult(error);
    }
}
