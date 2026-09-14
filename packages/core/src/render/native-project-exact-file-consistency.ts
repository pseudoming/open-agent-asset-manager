/** Final native-to-canonical consistency check after exact-file materialization. */

import type { AdapterNativeProjectExactFileRenderDeclarationV1, AdapterProviderSummary } from "../contracts/source-import";
import type { MaterializedRenderFile, ProviderRenderDialectInputsForAsset, RenderDeploymentInput } from "../contracts/render";
import type { RenderOutputUnit, RequiredRenderSemantic, SelectedOutputUnitRenderer } from "../contracts/deployment-authority";
import type { VersionNativeRepresentationV1 } from "../contracts/persistence";
import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import { bytesForPayload, textPayloadStats } from "../catalog/payload-store";
import { computeVersionNativeRepresentationFingerprint } from "../foundation/fingerprint";

type NativeInput = Extract<ProviderRenderDialectInputsForAsset["inputs"][number], { inputKind: "native_representation" }>;

export function isExactFileNativeConsistencySatisfied(input: {
    deployment: RenderDeploymentInput;
    provider: AdapterProviderSummary;
    semantics: readonly RequiredRenderSemantic[];
    dialectInputs: readonly ProviderRenderDialectInputsForAsset[];
    outputUnit: RenderOutputUnit;
    renderer: SelectedOutputUnitRenderer;
    files: readonly MaterializedRenderFile[];
    dialectRegistry: VersionDialectRegistryV1;
}): boolean {
    const consumerIds = new Set(input.semantics.map((semantic) => semantic.consumerAgentRuntimeId));
    const declaration = input.provider.renderContractDeclarations.find(
        (candidate): candidate is AdapterNativeProjectExactFileRenderDeclarationV1 =>
            candidate.declarationKind === "native_project_exact_file_v1" &&
            candidate.outputContractId === input.outputUnit.outputContractId &&
            candidate.materializationProfileId === input.renderer.materializationProfileId &&
            consumerIds.has(candidate.agentRuntimeId),
    );
    if (declaration === undefined) return true;

    // The declaration-owned materialization validator runs immediately before
    // this check and proves one complete text Asset, one native seed and one
    // output file. These assertions consume that stronger validated shape;
    // this function owns only the final native-to-canonical relationship.
    const firstSemantic = input.semantics[0] as RequiredRenderSemantic;
    const asset = input.deployment.assets.find(
        (candidate) => candidate.version.ref.assetId === firstSemantic.subject.assetId,
    ) as RenderDeploymentInput["assets"][number];
    const group = input.dialectInputs.find(
        (candidate) =>
            candidate.targetVersion.assetId === asset.version.ref.assetId &&
            candidate.targetVersion.versionId === asset.version.ref.versionId,
    ) as ProviderRenderDialectInputsForAsset;
    const seed = group.inputs.find(
        (candidate): candidate is NativeInput =>
            candidate.inputKind === "native_representation" && candidate.representation.dialectId === declaration.nativeDialectId,
    ) as NativeInput;
    const seedFile = seed.files[0] as NativeInput["files"][number];
    const materializedFile = input.files[0] as MaterializedRenderFile;
    const textContent = materializedFile.content as Extract<MaterializedRenderFile["content"], { contentKind: "text" }>;
    const stats = textPayloadStats(textContent.text);
    const descriptor = {
        relativePath: seedFile.relativePath,
        contentKind: seedFile.contentKind,
        mediaType: seedFile.mediaType,
        contentHash: stats.contentHash,
        byteSize: stats.byteSize,
        executable: materializedFile.executable,
    };
    const representationPreimage: Omit<VersionNativeRepresentationV1, "representationFingerprint"> = {
        schemaVersion: 1,
        dialectId: declaration.nativeDialectId,
        dialectContractFingerprint: seed.representation.dialectContractFingerprint,
        canonicalContentFingerprint: asset.version.versionCanonicalContentFingerprint,
        files: [descriptor],
    };
    const representation: VersionNativeRepresentationV1 = {
        ...representationPreimage,
        representationFingerprint: computeVersionNativeRepresentationFingerprint(representationPreimage),
    };
    const contract = input.dialectRegistry.getNative(asset.version.canonical.kind, declaration.nativeDialectId);
    return (
        contract !== null &&
        contract.contractFingerprint === representation.dialectContractFingerprint &&
        contract.validateSameContent({
            canonical: asset.version.canonical,
            canonicalFiles: asset.version.files,
            representation,
            nativeFiles: [
                {
                    relativePath: materializedFile.relativePath,
                    bytes: bytesForPayload(textContent.text, "text"),
                },
            ],
        })
    );
}
