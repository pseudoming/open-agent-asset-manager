/** Final native-to-canonical consistency check after exact-graph materialization. */

import type { AdapterNativeGraphRenderDeclarationV1, AdapterProviderSummary } from "../contracts/source-import";
import type { MaterializedRenderFile, ProviderRenderDialectInputsForAsset, RenderDeploymentInput } from "../contracts/render";
import type {
    MaterializationSemanticCoverageProof,
    RenderOutputUnit,
    RequiredRenderSemantic,
    SelectedOutputUnitRenderer,
} from "../contracts/deployment-authority";
import type {
    VersionNativeRepresentation,
    VersionNativeRepresentationV1,
    VersionNativeRepresentationV2,
} from "../contracts/persistence";
import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import { binaryPayloadStats, bytesForPayload } from "../catalog/payload-store";
import { computeVersionNativeRepresentationFingerprint, stableStringify } from "../foundation/fingerprint";
import { inferCanonicalMediaType } from "../foundation/media-type";
import { compareUtf8Bytes } from "../foundation/text-order";
import { canonicalValueForSemantic, isMaterializationCoverageProofBound } from "./render-materialization-coverage";
import { canonicalNativePreservationSeedMatchesContract } from "./canonical-native-preservation-seed";
import { isCanonicalMaterializationLossListAllowed } from "./canonical-materialization-assessment";
import type { RenderRegistrySnapshot } from "./render-registry";

type NativeInput = Extract<ProviderRenderDialectInputsForAsset["inputs"][number], { inputKind: "native_representation" }>;

export function isExactGraphNativeConsistencySatisfied(input: {
    deployment: RenderDeploymentInput;
    provider: AdapterProviderSummary;
    semantics: readonly RequiredRenderSemantic[];
    dialectInputs: readonly ProviderRenderDialectInputsForAsset[];
    outputUnit: RenderOutputUnit;
    renderer: SelectedOutputUnitRenderer;
    files: readonly MaterializedRenderFile[];
    dialectRegistry: VersionDialectRegistryV1;
    renderRegistry?: Pick<RenderRegistrySnapshot, "assessCanonicalMaterialization">;
    /** Produced by the registered profile validator before entering this final consistency gate. */
    canonicalCoverageProof?: MaterializationSemanticCoverageProof;
}): boolean {
    const consumerIds = new Set(input.semantics.map((semantic) => semantic.consumerAgentRuntimeId));
    const declaration = input.provider.renderContractDeclarations.find(
        (candidate): candidate is AdapterNativeGraphRenderDeclarationV1 =>
            (candidate.declarationKind === "native_project_exact_graph_v1" ||
                candidate.declarationKind === "native_global_exact_graph_v1" ||
                candidate.declarationKind === "native_project_encoded_file_v1" ||
                candidate.declarationKind === "native_global_encoded_file_v1") &&
            candidate.outputContractId === input.outputUnit.outputContractId &&
            candidate.materializationProfileId === input.renderer.materializationProfileId &&
            consumerIds.has(candidate.agentRuntimeId),
    );
    if (declaration === undefined) return true;
    const [firstSemantic] = input.semantics as [RequiredRenderSemantic];
    const asset = input.deployment.assets.find(
        (candidate) =>
            candidate.version.ref.assetId === firstSemantic.subject.assetId &&
            candidate.version.ref.versionId === firstSemantic.subject.versionId,
    );
    if (asset === undefined) return false;
    const group = input.dialectInputs.find(
        (candidate) =>
            candidate.targetVersion.assetId === asset.version.ref.assetId &&
            candidate.targetVersion.versionId === asset.version.ref.versionId,
    );
    const seed = group?.inputs.find(
        (candidate): candidate is NativeInput =>
            candidate.inputKind === "native_representation" && candidate.representation.dialectId === declaration.nativeDialectId,
    );
    if (group === undefined) return false;
    if (seed === undefined) {
        const authority = group.inputs.filter((candidate) => candidate.inputKind === "canonical_materialization");
        const declared = "canonicalMaterialization" in declaration ? declaration.canonicalMaterialization : undefined;
        const token = authority[0];
        if (
            authority.length !== 1 ||
            token?.inputKind !== "canonical_materialization" ||
            declared === undefined ||
            token.nativeDialectId !== declaration.nativeDialectId ||
            stableStringify(token.materializer) !== stableStringify(declared.materializer) ||
            !isCanonicalMaterializationLossListAllowed(declared, token.degradationKinds) ||
            token.substituteAssetKind !== declared.substituteAssetKind ||
            token.reasonCode !== declared.reasonCode ||
            (token.nativePreservationSeed !== undefined &&
                (declared.preservationDialectIds?.includes(token.nativePreservationSeed.representation.dialectId) !== true ||
                    !canonicalNativePreservationSeedMatchesContract(token.nativePreservationSeed, asset, input.dialectRegistry)))
        ) {
            return false;
        }
        if (declared.assessesLoss === true) {
            const assessed = input.renderRegistry?.assessCanonicalMaterialization({
                adapterId: input.provider.adapterId,
                adapterVersion: input.provider.version,
                outputContractId: declaration.outputContractId,
                materializationProfileId: declaration.materializationProfileId,
                materializer: declared.materializer,
                asset,
                ...(token.nativePreservationSeed === undefined ? {} : { nativePreservationSeed: token.nativePreservationSeed }),
            });
            if (
                assessed === undefined ||
                assessed === null ||
                stableStringify(assessed) !== stableStringify(token.degradationKinds)
            )
                return false;
        }
        return validateCanonicalMaterializedGraph(input, asset, declaration.nativeDialectId);
    }
    const materializedByPath = new Map(input.files.map((file) => [file.relativePath, file]));
    if (materializedByPath.size !== input.files.length || seed.files.length !== input.files.length) return false;
    const descriptors = seed.files.map((seedFile) => {
        const materialized = materializedByPath.get(seedFile.relativePath);
        if (materialized === undefined || materialized.content.contentKind !== seedFile.contentKind) return null;
        const bytes = bytesForPayload(
            materialized.content.contentKind === "text" ? materialized.content.text : materialized.content.bytes,
            materialized.content.contentKind,
        );
        const stats = binaryPayloadStats(bytes);
        return {
            relativePath: seedFile.relativePath,
            contentKind: seedFile.contentKind,
            mediaType: seedFile.mediaType,
            contentHash: stats.contentHash,
            byteSize: stats.byteSize,
            executable: materialized.executable,
        };
    });
    const validDescriptors = descriptors.filter(
        (descriptor): descriptor is NonNullable<typeof descriptor> => descriptor !== null,
    );
    if (validDescriptors.length !== descriptors.length) return false;
    validDescriptors.sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
    const representationPreimage:
        | Omit<VersionNativeRepresentationV1, "representationFingerprint">
        | Omit<VersionNativeRepresentationV2, "representationFingerprint"> =
        seed.representation.schemaVersion === 2
            ? {
                  schemaVersion: 2,
                  dialectId: declaration.nativeDialectId,
                  dialectContractFingerprint: seed.representation.dialectContractFingerprint,
                  canonicalContentFingerprint: asset.version.versionCanonicalContentFingerprint,
                  directories: [...seed.representation.directories],
                  files: validDescriptors,
              }
            : {
                  schemaVersion: 1,
                  dialectId: declaration.nativeDialectId,
                  dialectContractFingerprint: seed.representation.dialectContractFingerprint,
                  canonicalContentFingerprint: asset.version.versionCanonicalContentFingerprint,
                  files: validDescriptors,
              };
    const representation: VersionNativeRepresentation = {
        ...representationPreimage,
        representationFingerprint: computeVersionNativeRepresentationFingerprint(representationPreimage),
    } as VersionNativeRepresentation;
    const nativeFiles = input.files
        .map((file) => ({
            relativePath: file.relativePath,
            bytes: bytesForPayload(
                file.content.contentKind === "text" ? file.content.text : file.content.bytes,
                file.content.contentKind,
            ),
        }))
        .sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
    const contract = input.dialectRegistry.getNative(asset.version.canonical.kind, declaration.nativeDialectId);
    return (
        contract !== null &&
        contract.contractFingerprint === representation.dialectContractFingerprint &&
        contract.validateSameContent({
            canonical: asset.version.canonical,
            canonicalFiles: asset.version.files,
            representation,
            nativeFiles,
        })
    );
}

function validateCanonicalMaterializedGraph(
    input: Parameters<typeof isExactGraphNativeConsistencySatisfied>[0],
    asset: Parameters<typeof isExactGraphNativeConsistencySatisfied>[0]["deployment"]["assets"][number],
    nativeDialectId: string,
): boolean {
    if (input.files.length !== asset.version.files.length || input.canonicalCoverageProof === undefined) return false;
    const canonicalById = new Map(asset.version.files.map((file) => [file.file.fileId, file]));
    const representedCanonicalIds = new Set<string>();
    const descriptors = input.files.map((file) => {
        const representedIds = new Set(
            file.semanticRefFingerprints.flatMap((fingerprint) => {
                const semantic = input.semantics.find((candidate) => candidate.semanticRefFingerprint === fingerprint);
                return semantic?.subject.subjectKind === "file" ? [semantic.subject.fileId] : [];
            }),
        );
        const canonical = representedIds.size === 1 ? canonicalById.get([...representedIds][0] as string) : undefined;
        if (
            canonical === undefined ||
            canonical.contentKind !== file.content.contentKind ||
            canonical.file.executable !== file.executable ||
            representedCanonicalIds.has(canonical.file.fileId)
        )
            return null;
        representedCanonicalIds.add(canonical.file.fileId);
        const bytes = bytesForPayload(
            file.content.contentKind === "text" ? file.content.text : file.content.bytes,
            file.content.contentKind,
        );
        const stats = binaryPayloadStats(bytes);
        if (canonical.file.role !== "entry" && stats.contentHash !== canonical.file.contentHash) return null;
        return {
            relativePath: file.relativePath,
            contentKind: file.content.contentKind,
            mediaType: inferCanonicalMediaType(file.relativePath, file.content.contentKind),
            contentHash: stats.contentHash,
            byteSize: stats.byteSize,
            executable: file.executable,
        };
    });
    const validDescriptors = descriptors.filter(
        (descriptor): descriptor is NonNullable<typeof descriptor> => descriptor !== null,
    );
    if (validDescriptors.length !== descriptors.length) return false;
    validDescriptors.sort((left, right) => compareUtf8Bytes(left.relativePath, right.relativePath));
    const contract = input.dialectRegistry.getNative(asset.version.canonical.kind, nativeDialectId);
    if (contract === null) return false;
    // Reviewed foreign content was independently parsed by its registered target-entry checker.
    // Rebind that coverage to the current Version and graph; same-content native checks above
    // continue to validate current-exact and parent-rebased native representations.
    try {
        return isMaterializationCoverageProofBound(input.canonicalCoverageProof, {
            contractFingerprint: input.outputUnit.outputContractFingerprint,
            profileFingerprint: input.renderer.profileConstraintFingerprint,
            outputUnit: input.outputUnit,
            expectedRefs: input.semantics.map((semantic) => semantic.semanticRefFingerprint),
            canonicalValues: input.semantics.map((semantic) => canonicalValueForSemantic(input.deployment, semantic)),
            files: input.files,
        });
    } catch {
        return false;
    }
}
