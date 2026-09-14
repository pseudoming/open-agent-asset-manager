import type { AdapterId } from "./primitives";
import type { AdapterDialectContractSetV1 } from "./dialect";
import type {
    AdapterAssetSourceCapability,
    AdapterAssetTargetCapability,
    AdapterMaterializerCapability,
    AdapterProbeContext,
    AdapterProbeResult,
    AdapterProviderReadInput,
    AdapterProviderReadResult,
    AdapterRenderContractDeclarationV1,
    AdapterTargetContextSchemaDeclaration,
    AgentRuntimeDescriptor,
} from "./source-import";
import type {
    AdapterCanonicalMaterializationValidatorV1,
    AdapterRenderAnalysisResult,
    RenderAnalysisInput,
    RenderMaterializationInput,
    RenderMaterializationResult,
} from "./render";
import type { AdapterRenderedTargetInspectionResult, RenderedTargetInspectionInput } from "./reverse";

/**
 * Adapter family SPI. Static rows are registry facts; dynamic methods are
 * input-pure and never write OAAM or agent-runtime state.
 */
export interface AdapterProviderStaticDeclarations {
    adapterId: AdapterId;
    displayName: string;
    version: string;
    agentRuntimes: AgentRuntimeDescriptor[];
    targetContextSchemas: AdapterTargetContextSchemaDeclaration[];
    assetSourceCapabilities: AdapterAssetSourceCapability[];
    assetTargetCapabilities: AdapterAssetTargetCapability[];
    materializerCapabilities: AdapterMaterializerCapability[];
    /** Immutable target conformance data owned by this adapter family. */
    renderContractDeclarations: AdapterRenderContractDeclarationV1[];
    /** Immutable Version-format validators owned by this adapter family. */
    dialectContracts: AdapterDialectContractSetV1;
    /** Required for every declared canonical conversion; absent when this Provider has none. */
    canonicalMaterializationValidators?: readonly AdapterCanonicalMaterializationValidatorV1[];
}

/** Exact historical metadata/callback; it cannot probe, read, analyze or materialize new output. */
export interface AdapterRetainedInspectionBindingV1 {
    readonly schemaVersion: 1;
    readonly rendererVersion: string;
    readonly agentRuntimes: AgentRuntimeDescriptor[];
    readonly targetContextSchemas: AdapterTargetContextSchemaDeclaration[];
    readonly assetTargetCapabilities: AdapterAssetTargetCapability[];
    readonly materializerCapabilities: AdapterMaterializerCapability[];
    readonly renderContractDeclarations: AdapterRenderContractDeclarationV1[];
    readonly canonicalMaterializationValidators?: readonly AdapterCanonicalMaterializationValidatorV1[];
    inspectRenderedTarget(input: RenderedTargetInspectionInput): Promise<AdapterRenderedTargetInspectionResult>;
}

export interface AdapterProvider extends AdapterProviderStaticDeclarations {
    readonly retainedInspectionBindings?: readonly AdapterRetainedInspectionBindingV1[];
    probe(context: AdapterProbeContext): Promise<AdapterProbeResult>;
    read(input: AdapterProviderReadInput): Promise<AdapterProviderReadResult>;
    analyzeRender(input: RenderAnalysisInput): Promise<AdapterRenderAnalysisResult>;
    materializeRender(input: RenderMaterializationInput): Promise<RenderMaterializationResult>;
    inspectRenderedTarget(input: RenderedTargetInspectionInput): Promise<AdapterRenderedTargetInspectionResult>;
}
