/** Immutable native-representation validation for render analysis inputs. */

import type { ProviderRenderDialectInputsForAsset } from "../contracts/render";
import type { Sha256Digest } from "../contracts/primitives";
import { binaryPayloadStats, canonicalMediaType, normalizeText, textPayloadStats } from "../catalog/payload-store";
import { computeVersionNativeRepresentationFingerprint } from "../foundation/fingerprint";
import { isCompleteNativeDirectoryGraph } from "../foundation/native-directory-graph";
import { isCanonicalRelativePath, isSha256Digest } from "../foundation/validators";
import { RenderAnalysisFailure } from "./render-analysis-shared";
import { requireSortedUnique } from "./render-semantics";

export function validateNativeRepresentationInput(
    input: Extract<ProviderRenderDialectInputsForAsset["inputs"][number], { inputKind: "native_representation" }>,
    canonicalContentFingerprint: Sha256Digest,
): void {
    const representation = input.representation;
    if (
        (representation.schemaVersion !== 1 && representation.schemaVersion !== 2) ||
        representation.dialectId.trim().length === 0 ||
        !isSha256Digest(representation.dialectContractFingerprint) ||
        (input.inputRole === "current_exact" && representation.canonicalContentFingerprint !== canonicalContentFingerprint)
    ) {
        throw new RenderAnalysisFailure(
            "render.native_representation_invalid",
            "native representation metadata does not match its operation-local role",
        );
    }
    if (
        representation.schemaVersion === 2 &&
        !isCompleteNativeDirectoryGraph(
            representation.directories,
            input.files.map((file) => file.relativePath),
        )
    ) {
        throw new RenderAnalysisFailure(
            "render.native_directory_graph_invalid",
            "native representation directory graph is incomplete or non-canonical",
        );
    }
    requireSortedUnique(
        input.files.map((file) => file.relativePath),
        "native representation paths",
    );
    for (const file of input.files) {
        if (!isCanonicalRelativePath(file.relativePath) || canonicalMediaType(file.mediaType) !== file.mediaType) {
            throw new RenderAnalysisFailure(
                "render.native_file_invalid",
                "native representation file path/media type is invalid",
            );
        }
        const stats = file.contentKind === "text" ? textPayloadStats(file.text) : binaryPayloadStats(file.bytes);
        if (
            stats.contentHash !== file.contentHash ||
            stats.byteSize !== file.byteSize ||
            (file.contentKind === "text" && normalizeText(file.text).normalized !== file.text)
        ) {
            throw new RenderAnalysisFailure(
                "render.native_file_payload_mismatch",
                "native representation bytes contradict their descriptor",
            );
        }
    }
    const expected = computeVersionNativeRepresentationFingerprint({
        ...representation,
        files: input.files.map((file) => ({
            relativePath: file.relativePath,
            contentKind: file.contentKind,
            mediaType: file.mediaType,
            contentHash: file.contentHash,
            byteSize: file.byteSize,
            executable: file.executable,
        })),
    });
    if (representation.representationFingerprint !== expected) {
        throw new RenderAnalysisFailure(
            "render.native_representation_fingerprint_mismatch",
            "native representation fingerprint does not bind its actual file graph",
        );
    }
}
