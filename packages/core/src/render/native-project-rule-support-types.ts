/** Provider-facing support bundles for scope-bound native Rule targets. */

import type {
    AdapterAssetTargetCapabilityAvailable,
    AdapterMaterializerCapability,
    AdapterNativeGlobalRuleRenderDeclarationV1,
    AdapterNativeProjectRuleRenderDeclarationV1,
    AdapterTargetContextSchemaDeclaration,
} from "../contracts/source-import";
import type {
    AdapterRenderAnalysisResult,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderMaterializationResult,
} from "../contracts/render";
import type { AdapterRenderedTargetInspectionResult, RenderedTargetInspectionInput } from "../contracts/reverse";

export interface NativeProjectRuleProviderSupport {
    targetContextSchema: AdapterTargetContextSchemaDeclaration;
    targetCapability: AdapterAssetTargetCapabilityAvailable;
    materializerCapability: AdapterMaterializerCapability;
    renderContractDeclaration: AdapterNativeProjectRuleRenderDeclarationV1;
    analyze(input: RenderAnalysisInput): AdapterRenderAnalysisResult;
    materialize(input: RenderMaterializationInput): RenderMaterializationResult;
    inspect(input: RenderedTargetInspectionInput): AdapterRenderedTargetInspectionResult;
}

export interface NativeGlobalRuleProviderSupport {
    targetContextSchema: AdapterTargetContextSchemaDeclaration;
    targetCapability: AdapterAssetTargetCapabilityAvailable;
    materializerCapability: AdapterMaterializerCapability;
    renderContractDeclaration: AdapterNativeGlobalRuleRenderDeclarationV1;
    analyze(input: RenderAnalysisInput): AdapterRenderAnalysisResult;
    materialize(input: RenderMaterializationInput): RenderMaterializationResult;
    inspect(input: RenderedTargetInspectionInput): AdapterRenderedTargetInspectionResult;
}
