/** Internal contract shared by render materialization orchestration and its consumers. */

import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import type {
    MaterializationSemanticCoverageProof,
    RenderOutputUnit,
    RequiredRenderSemantic,
    SelectedOutputUnitRenderer,
} from "../contracts/deployment-authority";
import type {
    CanonicalRenderSemanticValue,
    MaterializedRenderFile,
    ProviderRenderDialectInputsForAsset,
    RenderDeploymentInput,
    RenderMaterializationInput,
    RenderMaterializationResult,
} from "../contracts/render";
import type { AdapterProviderSummary, CoreResult, Sha256Digest } from "../types";
import type { RenderRegistrySnapshot } from "./render-registry";

export type CanonicalSemanticValuePreimage = CanonicalRenderSemanticValue extends infer T
    ? T extends CanonicalRenderSemanticValue
        ? Omit<T, "canonicalValueFingerprint">
        : never
    : never;

export interface MaterializeRenderDeploymentConfiguration {
    registry: RenderRegistrySnapshot;
    dialectRegistry: VersionDialectRegistryV1;
    resolveDialectInputs(
        provider: AdapterProviderSummary,
        deployment: RenderDeploymentInput,
        requiredSemantics: readonly RequiredRenderSemantic[],
    ): ProviderRenderDialectInputsForAsset[];
    dispatch(adapterId: string, input: RenderMaterializationInput): Promise<CoreResult<RenderMaterializationResult>>;
}

export interface CoreMaterializedOutputUnit {
    outputUnit: RenderOutputUnit;
    renderer: SelectedOutputUnitRenderer;
    providerRenderDialectInputFingerprint: Sha256Digest;
    materializationFingerprint: Sha256Digest;
    semanticCoverageProof: MaterializationSemanticCoverageProof;
    files: CoreMaterializedRenderFile[];
}

/** Added only by Core's container resolver after validating the Provider's patch receipt. */
export interface CoreMaterializedRenderFile extends MaterializedRenderFile {
    containerPatchPreimageHash?: Sha256Digest | null;
}

export interface CoreRenderMaterializationView {
    schemaVersion: 1;
    renderInputFingerprint: Sha256Digest;
    selectionFingerprint: Sha256Digest;
    units: CoreMaterializedOutputUnit[];
}
