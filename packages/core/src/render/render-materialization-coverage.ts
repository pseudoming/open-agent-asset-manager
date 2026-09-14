/** Recompute materialization coverage against current Core-owned semantics and output. */

import type {
    MaterializationSemanticCoverageProof,
    RenderOutputUnit,
    RequiredRenderSemantic,
} from "../contracts/deployment-authority";
import type { CanonicalRenderSemanticValue, MaterializedRenderFile, RenderDeploymentInput } from "../contracts/render";
import type { Sha256Digest } from "../contracts/primitives";
import {
    computeCanonicalRenderSemanticValueFingerprint,
    computeRenderOutputUnitFingerprint,
    computeSemanticCoverageFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isSha256Digest } from "../foundation/validators";
import type { CanonicalSemanticValuePreimage } from "./render-materialization-contract";

export function canonicalValueForSemantic(
    deployment: RenderDeploymentInput,
    semantic: RequiredRenderSemantic,
): CanonicalRenderSemanticValue {
    const asset = deployment.assets.find(
        (item) =>
            item.version.ref.assetId === semantic.subject.assetId && item.version.ref.versionId === semantic.subject.versionId,
    );
    if (asset === undefined) throw new Error("canonical semantic Asset is missing");
    let value: CanonicalSemanticValuePreimage;
    if (semantic.semanticKind === "asset.file_inventory") {
        value = {
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            valueKind: "file_inventory",
            value: asset.version.files.map((file) => ({
                fileId: file.file.fileId,
                logicalPath: file.file.logicalPath,
                role: file.file.role,
                contentKind: file.file.contentKind,
                contentHash: file.file.contentHash,
                executable: file.file.executable,
            })),
        };
    } else if (semantic.subject.subjectKind === "file") {
        const fileId = semantic.subject.fileId;
        const file = asset.version.files.find((item) => item.file.fileId === fileId);
        if (file === undefined) throw new Error("canonical semantic file is missing");
        value = {
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            valueKind: "file_content",
            value:
                file.contentKind === "text"
                    ? { contentKind: "text", text: file.text }
                    : { contentKind: "binary", bytes: file.bytes },
        };
    } else {
        value = {
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            valueKind: "asset_type_data",
            value: asset.version.canonical,
        };
    }
    return {
        ...value,
        canonicalValueFingerprint: computeCanonicalRenderSemanticValueFingerprint({
            semantic,
            assetKind: asset.version.canonical.kind,
            value,
        }),
    } as CanonicalRenderSemanticValue;
}

export interface MaterializationCoverageBinding {
    contractFingerprint: Sha256Digest;
    profileFingerprint: Sha256Digest;
    outputUnit: RenderOutputUnit;
    expectedRefs: readonly Sha256Digest[];
    canonicalValues: readonly CanonicalRenderSemanticValue[];
    files: readonly MaterializedRenderFile[];
}

/** A registered validator's proof is usable only for the exact current graph and semantic closure. */
export function isMaterializationCoverageProofBound(
    proof: MaterializationSemanticCoverageProof,
    input: MaterializationCoverageBinding,
): boolean {
    const refs = proof.coveredSemanticRefFingerprints;
    return (
        refs.every(isSha256Digest) &&
        new Set(refs).size === refs.length &&
        new Set(input.expectedRefs).size === input.expectedRefs.length &&
        stableStringify(refs) === stableStringify([...refs].sort(compareUtf8Bytes)) &&
        stableStringify(refs) === stableStringify([...input.expectedRefs].sort(compareUtf8Bytes)) &&
        input.outputUnit.outputUnitFingerprint === computeRenderOutputUnitFingerprint(input.outputUnit) &&
        proof.outputUnitFingerprint === input.outputUnit.outputUnitFingerprint &&
        isSha256Digest(proof.coverageFingerprint) &&
        proof.coverageFingerprint ===
            computeSemanticCoverageFingerprint({
                outputContractFingerprint: input.contractFingerprint,
                profileConstraintFingerprint: input.profileFingerprint,
                outputUnitFingerprint: input.outputUnit.outputUnitFingerprint,
                canonicalValues: [...input.canonicalValues],
                files: [...input.files],
                coveredSemanticRefFingerprints: refs,
            })
    );
}
