/** Exact loss assessment through the existing versioned canonical validator contribution. */
import type { AdapterNativeExactGraphRenderDeclarationV1, AdapterProviderSummary } from "../contracts/source-import";
import type { RenderDegradationKind } from "../contracts/deployment-authority";
import type {
    AdapterCanonicalMaterializationValidatorV1,
    CanonicalMaterializationAssessmentInput,
    CanonicalNativePreservationSeed,
    RenderAssetInput,
    VersionedContractComponentRef,
} from "../contracts/render";
import type { AdapterId, MaterializationProfileId, OutputContractId } from "../types";
import { stableStringify } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import {
    findCanonicalMaterializationValidator,
    type CanonicalMaterializationValidatorsByAdapter,
} from "./canonical-materialization-validation";

type Declaration = NonNullable<AdapterNativeExactGraphRenderDeclarationV1["canonicalMaterialization"]>;

export interface CanonicalMaterializationAssessmentRequest {
    adapterId: AdapterId;
    adapterVersion: string;
    outputContractId: OutputContractId;
    materializationProfileId: MaterializationProfileId;
    materializer: VersionedContractComponentRef;
    asset: RenderAssetInput;
    nativePreservationSeed?: CanonicalNativePreservationSeed;
}

export function canonicalMaterializationAssessmentInput(
    asset: RenderAssetInput,
    nativeDialectId: string,
    targetScope: "project" | "global",
    nativePreservationSeed?: CanonicalNativePreservationSeed,
): CanonicalMaterializationAssessmentInput | null {
    const entries = asset.version.files.filter((file) => file.file.role === "entry");
    const entry = entries[0];
    if (entries.length !== 1 || entry === undefined) return null;
    return structuredClone({
        canonical: asset.version.canonical,
        canonicalEntry:
            entry.contentKind === "text"
                ? { contentKind: "text" as const, text: entry.text }
                : { contentKind: "binary" as const, bytes: entry.bytes },
        targetVersion: asset.version.ref,
        targetScope,
        nativeDialectId,
        ...(nativePreservationSeed === undefined ? {} : { nativePreservationSeed }),
    });
}

export function assessCanonicalMaterializationLosses(
    declaration: Declaration,
    implementation: Pick<AdapterCanonicalMaterializationValidatorV1, "assessLoss"> | null | undefined,
    input: CanonicalMaterializationAssessmentInput | null,
): RenderDegradationKind[] | null {
    if (declaration.assessesLoss !== true) return [...declaration.degradationKinds];
    if (typeof implementation?.assessLoss !== "function" || input === null) return null;
    try {
        const result = implementation.assessLoss(structuredClone(input));
        if (!isCanonicalMaterializationLossListAllowed(declaration, result)) return null;
        return [...result];
    } catch {
        return null;
    }
}

export function isCanonicalMaterializationLossListAllowed(
    declaration: Declaration,
    kinds: unknown,
): kinds is RenderDegradationKind[] {
    if (!Array.isArray(kinds)) return false;
    if (declaration.assessesLoss !== true) return stableStringify(kinds) === stableStringify(declaration.degradationKinds);
    return (
        kinds.every(
            (kind, index) =>
                declaration.degradationKinds.includes(kind) && (index === 0 || compareUtf8Bytes(kinds[index - 1], kind) < 0),
        ) &&
        (declaration.substituteAssetKind === undefined || kinds.includes("target_runtime_missing_asset_kind"))
    );
}

export function assessRegisteredCanonicalMaterialization(
    provider: AdapterProviderSummary | undefined,
    contributions: CanonicalMaterializationValidatorsByAdapter,
    request: CanonicalMaterializationAssessmentRequest,
): RenderDegradationKind[] | null {
    if (provider === undefined || provider.version !== request.adapterVersion) return null;
    const declarations = provider.renderContractDeclarations.filter(
        (declaration): declaration is AdapterNativeExactGraphRenderDeclarationV1 =>
            (declaration.declarationKind === "native_project_exact_graph_v1" ||
                declaration.declarationKind === "native_global_exact_graph_v1") &&
            declaration.assetKind === request.asset.version.canonical.kind &&
            declaration.outputContractId === request.outputContractId &&
            declaration.materializationProfileId === request.materializationProfileId &&
            declaration.canonicalMaterialization !== undefined &&
            stableStringify(declaration.canonicalMaterialization.materializer) === stableStringify(request.materializer),
    );
    const declaration = declarations[0];
    if (declarations.length !== 1 || declaration?.canonicalMaterialization === undefined) return null;
    return assessCanonicalMaterializationLosses(
        declaration.canonicalMaterialization,
        findCanonicalMaterializationValidator(contributions, request.adapterId, request),
        canonicalMaterializationAssessmentInput(
            request.asset,
            declaration.nativeDialectId,
            declaration.declarationKind === "native_project_exact_graph_v1" ? "project" : "global",
            request.nativePreservationSeed,
        ),
    );
}
