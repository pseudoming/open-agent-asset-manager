/** Core-selected preservation bytes from one current immutable Version representation. */
import type { VersionDialectRegistryV1 } from "../catalog/version-dialect-registry";
import type { CanonicalNativePreservationSeed, RenderAssetInput, RenderVersionDialectInputs } from "../contracts/render";
import { validateNativeRepresentationInput } from "./render-native-representation-validation";

export function validateCanonicalNativePreservationSeed(
    seed: CanonicalNativePreservationSeed,
    canonicalContentFingerprint: RenderAssetInput["version"]["versionCanonicalContentFingerprint"],
): void {
    if (seed === null || typeof seed !== "object" || Object.keys(seed).sort().join("\0") !== "files\0representation")
        throw new Error("canonical native preservation seed must contain only immutable representation and files");
    validateNativeRepresentationInput(
        { inputKind: "native_representation", inputRole: "current_exact", ...seed },
        canonicalContentFingerprint,
    );
}

export function canonicalNativePreservationSeedMatchesContract(
    seed: CanonicalNativePreservationSeed,
    asset: RenderAssetInput,
    registry: VersionDialectRegistryV1 | undefined,
): boolean {
    try {
        validateCanonicalNativePreservationSeed(seed, asset.version.versionCanonicalContentFingerprint);
        const contract = registry?.getNative(asset.version.canonical.kind, seed.representation.dialectId);
        return (
            contract != null &&
            contract.contractFingerprint === seed.representation.dialectContractFingerprint &&
            contract.validateSameContent({
                canonical: structuredClone(asset.version.canonical),
                canonicalFiles: structuredClone(asset.version.files),
                representation: {
                    ...structuredClone(seed.representation),
                    files: seed.files.map(({ relativePath, contentKind, mediaType, contentHash, byteSize, executable }) => ({
                        relativePath,
                        contentKind,
                        mediaType,
                        contentHash,
                        byteSize,
                        executable,
                    })),
                },
                nativeFiles: seed.files.map((file) => ({
                    relativePath: file.relativePath,
                    bytes: file.contentKind === "text" ? new TextEncoder().encode(file.text) : new Uint8Array(file.bytes),
                })),
            })
        );
    } catch {
        return false;
    }
}

/** null rejects ambiguity/invalid authority; absence means this declaration has no matching current seed. */
export function projectCanonicalNativePreservationSeed(
    asset: RenderAssetInput,
    available: RenderVersionDialectInputs,
    acceptedDialectIds: readonly string[] | undefined,
    registry: VersionDialectRegistryV1 | undefined,
): { nativePreservationSeed?: CanonicalNativePreservationSeed } | null {
    if (acceptedDialectIds === undefined) return {};
    if (
        available.targetVersion.assetId !== asset.version.ref.assetId ||
        available.targetVersion.versionId !== asset.version.ref.versionId
    )
        return null;
    const candidates = available.inputs.filter(
        (item) =>
            item.inputKind === "native_representation" &&
            item.inputRole === "current_exact" &&
            acceptedDialectIds.includes(item.representation.dialectId),
    );
    if (candidates.length === 0) return {};
    const candidate = candidates[0];
    if (candidates.length !== 1 || candidate?.inputKind !== "native_representation") return null;
    const seed = { representation: structuredClone(candidate.representation), files: structuredClone(candidate.files) };
    return canonicalNativePreservationSeedMatchesContract(seed, asset, registry) ? { nativePreservationSeed: seed } : null;
}
