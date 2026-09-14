import type { AgentRuntimeId, AssetKind, Platform, PosixRelativePath, Sha256Digest } from "./primitives";
import type { RenderDegradationKind } from "./deployment-authority";
import type { VersionedContractComponentRef } from "./render";
import type { MaterializationProfileId, OutputContractId, TargetContextSchemaId } from "./source-import";
import type { AdapterTargetBuildCompatibilityPolicyV1 } from "./target-build-compatibility";

export type NativeExactGraphAssetKind = "Rule" | "Workflow" | "Skill" | "Subagent";

/** Compatibility name retained for the existing project-scoped v1 contract. */
export type NativeProjectExactGraphAssetKind = NativeExactGraphAssetKind;

/**
 * Shared pure-data fields for one scope-bound native file graph. Core owns
 * complete claim/inventory and reverse-publication; the Provider owns only
 * runtime path projection and dialect transforms.
 */
interface AdapterNativeExactGraphRenderDeclarationBaseV1 {
    schemaVersion: 1;
    outputContractId: OutputContractId;
    materializationProfileId: MaterializationProfileId;
    agentRuntimeId: AgentRuntimeId;
    assetKind: NativeExactGraphAssetKind;
    nativeDialectId: string;
    reverseParser: VersionedContractComponentRef;
    rebaseMaterializer: VersionedContractComponentRef | null;
    /**
     * Optional reviewed canonical-to-native migration for a target dialect
     * that the Version does not already own. Absence preserves the original
     * current-exact/immediate-parent-only contract byte-for-byte.
     */
    canonicalMaterialization?: {
        materializer: VersionedContractComponentRef;
        degradationKinds: [RenderDegradationKind, ...RenderDegradationKind[]];
        /** Explicit substitute kind when the target runtime lacks the source AssetKind. */
        substituteAssetKind?: AssetKind;
        reasonCode: string;
        /** Exact immutable source dialects accepted for preservation during this reviewed conversion. */
        preservationDialectIds?: string[];
        /** The allowed loss list is refined by the existing registered canonical validator. */
        assessesLoss?: true;
        /** Requires every current native source to be covered by the selected immutable preservation seed. */
        requiresNativeSourceAssessment?: true;
    };
    restorationDialectIds: string[];
    /**
     * One bounded native graph member is a top-level JSONC value rather than a
     * complete target file. Core applies it to the live container under the
     * ordinary preview/CAS/journal boundary; the Version never owns unrelated
     * container bytes.
     */
    jsoncTopLevelPropertyPatch?: {
        propertyName: string;
        allowedContainerRelativePaths: PosixRelativePath[];
    };
    target: {
        targetContextSchemaId: TargetContextSchemaId;
        requiredFacts: Record<string, string>;
    };
    /** Optional Provider-owned per-cell routing from a current build to one verified evidence anchor. */
    buildCompatibility?: AdapterTargetBuildCompatibilityPolicyV1;
    verifiedBuilds: {
        agentRuntimeId: AgentRuntimeId;
        versionText: string;
        buildIdentity: Sha256Digest;
        platform: Platform;
        materializationProfileId: MaterializationProfileId;
        fixtureSetFingerprint: Sha256Digest;
    }[];
}

/** Project-scoped exact graph; the Deployment must carry real Project authority. */
export interface AdapterNativeProjectExactGraphRenderDeclarationV1 extends AdapterNativeExactGraphRenderDeclarationBaseV1 {
    declarationKind: "native_project_exact_graph_v1";
    projectGraphValidator: VersionedContractComponentRef;
}

/**
 * Pure-data declaration for one agent-runtime-global native file graph. The
 * target root is an exact global Deployment authority, never a synthetic
 * Project. Core retains the same inventory and reverse-publication boundary.
 */
export interface AdapterNativeGlobalExactGraphRenderDeclarationV1 extends AdapterNativeExactGraphRenderDeclarationBaseV1 {
    declarationKind: "native_global_exact_graph_v1";
    globalGraphValidator: VersionedContractComponentRef;
}

/**
 * Project-scoped canonical graph encoded by one native text file. This is
 * intentionally narrower than a general graph codec: v1 accepts a Subagent
 * entry plus at most one resource and binds each canonical file to a durable
 * render section handle for reverse attribution.
 */
export interface AdapterNativeProjectEncodedFileRenderDeclarationV1 extends AdapterNativeExactGraphRenderDeclarationBaseV1 {
    declarationKind: "native_project_encoded_file_v1";
    assetKind: "Subagent";
    projectPathValidator: VersionedContractComponentRef;
    rebaseMaterializer: VersionedContractComponentRef;
}

/** Global canonical graph encoded by one native text file. */
export interface AdapterNativeGlobalEncodedFileRenderDeclarationV1 extends AdapterNativeExactGraphRenderDeclarationBaseV1 {
    declarationKind: "native_global_encoded_file_v1";
    assetKind: "Subagent";
    globalPathValidator: VersionedContractComponentRef;
    rebaseMaterializer: VersionedContractComponentRef;
}

export type AdapterNativeEncodedFileRenderDeclarationV1 =
    | AdapterNativeProjectEncodedFileRenderDeclarationV1
    | AdapterNativeGlobalEncodedFileRenderDeclarationV1;

export type AdapterNativeExactGraphRenderDeclarationV1 =
    | AdapterNativeProjectExactGraphRenderDeclarationV1
    | AdapterNativeGlobalExactGraphRenderDeclarationV1;

/** Exact graph lifecycle declarations, including a one-native-file encoding. */
export type AdapterNativeGraphRenderDeclarationV1 =
    | AdapterNativeExactGraphRenderDeclarationV1
    | AdapterNativeEncodedFileRenderDeclarationV1;
