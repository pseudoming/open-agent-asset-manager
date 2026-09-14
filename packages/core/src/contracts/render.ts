import type { AssetVersionFileContentV2 } from "./asset-version";
import type {
    AppliedRenderApprovalEvidence,
    ActualReverseExtractPolicy,
    RenderDegradationKind,
    RenderOutcomeDetailsV1,
    RenderOutputUnit,
    RenderStrategy,
    RenderedSectionBinding,
    RequiredRenderSemantic,
    PromotionAuthorizationInspection,
    ResolvedPromotionAuthorization,
    SelectedOutputUnitRenderer,
} from "./deployment-authority";
import type {
    AdapterId,
    AgentRuntimeId,
    AssetKind,
    AssetScope,
    FileRole,
    OperationStatus,
    Platform,
    PosixRelativePath,
    Sha256Digest,
    UuidV4,
    VersionStatus,
} from "./primitives";
import type { OutputContractId } from "./source-import";
import type {
    VersionDialectRestorationPayloadRefV1,
    VersionNativeRepresentationV2,
    VersionNativeRepresentationFileV1,
    VersionNativeRepresentationV1,
} from "./persistence";
import type { AssetKindTypeDataV2 } from "./specs";
import type { OperationDiagnostic, TargetFileContent, VersionRef } from "./common";
import type { MaterializationProfileId, SourceEvidenceLevel, TargetContextSchemaId } from "./source-import";

export interface VersionedContractComponentRef {
    componentId: string;
    componentVersion: number;
    configFingerprint: Sha256Digest;
}

export interface RenderTargetFact {
    key: string;
    value: string;
    evidenceLevel: SourceEvidenceLevel;
}

export interface TargetAgentRuntimeRenderContext {
    schemaVersion: 1;
    agentRuntimeId: AgentRuntimeId;
    versionText: string;
    buildIdentity: string;
    targetContextSchemaId: TargetContextSchemaId;
    targetContextSchemaFingerprint: Sha256Digest;
    targetApplicabilityFingerprint: Sha256Digest;
    renderFacts: RenderTargetFact[];
}

export interface RenderAssetVersionProjection {
    ref: VersionRef;
    versionFingerprint: Sha256Digest;
    versionCanonicalContentFingerprint: Sha256Digest;
    status: VersionStatus;
    canonical: AssetKindTypeDataV2;
    files: AssetVersionFileContentV2[];
}

export type RenderNativeRepresentationFileInput =
    | (VersionNativeRepresentationFileV1 & { contentKind: "text"; text: string })
    | (VersionNativeRepresentationFileV1 & { contentKind: "binary"; bytes: Uint8Array });

export type RenderNativeRepresentationMetadata =
    | Omit<VersionNativeRepresentationV1, "files">
    | Omit<VersionNativeRepresentationV2, "files">;

/** Optional preservation authority nested in one reviewed canonical-materialization token. */
export interface CanonicalNativePreservationSeed {
    representation: RenderNativeRepresentationMetadata;
    files: RenderNativeRepresentationFileInput[];
}

export type ProviderRenderDialectInput =
    | {
          inputKind: "native_representation";
          inputRole: "current_exact";
          representation: RenderNativeRepresentationMetadata;
          files: RenderNativeRepresentationFileInput[];
      }
    | {
          inputKind: "native_representation";
          inputRole: "parent_rebase_seed";
          sourceVersion: VersionRef;
          representation: RenderNativeRepresentationMetadata;
          files: RenderNativeRepresentationFileInput[];
      }
    | {
          inputKind: "dialect_restoration";
          restoration: VersionDialectRestorationPayloadRefV1;
          content: TargetFileContent;
      }
    | {
          /** Core-issued operation-local authority for one declared reviewed migration. */
          inputKind: "canonical_materialization";
          nativeDialectId: string;
          materializer: VersionedContractComponentRef;
          /** Empty only for a registered assessed conversion that preserves every source semantic. */
          degradationKinds: RenderDegradationKind[];
          /** Provider-owned target AssetKind when this is an explicit substitute capability. */
          substituteAssetKind?: AssetKind;
          reasonCode: string;
          /** Root-relative directories from a uniquely mapped current immutable native v2 graph. */
          logicalDirectoryPaths?: PosixRelativePath[];
          /** Selected current Version bytes, validated under their own historical native contract. */
          nativePreservationSeed?: CanonicalNativePreservationSeed;
      };

/** Immutable Version candidates before a target consumer has selected a dialect. */
export interface RenderVersionDialectInputs {
    targetVersion: VersionRef;
    inputs: ProviderRenderDialectInput[];
}

/** One selected authority shared only by the exact consumers listed here. */
export interface ProviderRenderDialectInputsForAsset extends RenderVersionDialectInputs {
    consumerAgentRuntimeIds: [AgentRuntimeId, ...AgentRuntimeId[]];
}

export interface RenderAssetInput {
    scope: AssetScope;
    projectId: string;
    scopePath: string;
    allowIncomplete: boolean;
    version: RenderAssetVersionProjection;
    sectionHandles: Record<string, string>;
}

/**
 * Bounded Core-owned receipt for a shared native target captured before
 * Provider analysis. Bytes remain in the Version-owned native seed; the
 * Provider receives only the live identity needed to prove that seed is still
 * the exact target value. The receipt is operation-local: it is deliberately
 * excluded from durable Deployment-intent identity because runtime edits are
 * the input to reverse inspection. Fresh analysis, preview and executor CAS
 * still re-capture and validate it at action time.
 */
export type RenderTargetFileSnapshotV1 =
    | {
          relativePath: PosixRelativePath;
          snapshotState: "missing";
      }
    | {
          relativePath: PosixRelativePath;
          snapshotState: "present";
          contentHash: Sha256Digest;
          byteSize: number;
          executable: boolean;
      };

export interface RenderDeploymentInput {
    schemaVersion: 1;
    deploymentId: UuidV4;
    consumerAgentRuntimeIds: AgentRuntimeId[];
    platform: Platform;
    platformInstanceId: string;
    targetRootPath: string;
    projectId: string;
    targetContexts: TargetAgentRuntimeRenderContext[];
    renderRegistryFingerprint: Sha256Digest;
    assets: RenderAssetInput[];
    /** Present only when an aggregate canonical asset needs a live shared-target receipt. */
    targetFileSnapshots?: RenderTargetFileSnapshotV1[];
    renderInputFingerprint: Sha256Digest;
}

export interface ProviderRenderDeploymentProjection {
    schemaVersion: 1;
    platform: Platform;
    platformInstanceId: string;
    targetContexts: TargetAgentRuntimeRenderContext[];
    assets: RenderAssetInput[];
    /** Exact owning-asset subset of the Core-captured target receipts. */
    targetFileSnapshots?: RenderTargetFileSnapshotV1[];
    renderInputFingerprint: Sha256Digest;
}

export interface RenderAnalysisInput {
    schemaVersion: 1;
    deployment: ProviderRenderDeploymentProjection;
    requiredSemantics: RequiredRenderSemantic[];
    dialectInputs: ProviderRenderDialectInputsForAsset[];
}

export type RenderApprovalConcern = "semantic_degradation" | "reverse_extract_unsupported";

export type AnalysisApprovalRequirement =
    | { approvalState: "not_required" }
    | {
          approvalState: "required";
          concerns: [RenderApprovalConcern, ...RenderApprovalConcern[]];
          approvalFingerprint: Sha256Digest;
      };

export type ResolvedRenderOutcomeV1 = { outcome: "preserved" } | { outcome: "degraded"; degradationFingerprint: Sha256Digest };

export type RenderApprovalRequest =
    | { approvalAction: "none" }
    | { approvalAction: "approve_once"; userActionId: string }
    | { approvalAction: "use_saved_policy"; policyId: string };

/** Trusted composition challenge used to attest one exact operation-local user approval. */
export interface ConfirmOneTimeRenderApprovalInput {
    userActionId: string;
    approvalFingerprint: Sha256Digest;
    deployment: RenderDeploymentInput;
    semantic: RequiredRenderSemantic;
    option: SemanticRenderOption;
}

export interface OutputContractMaterializationProfile {
    materializationProfileId: MaterializationProfileId;
    profileConstraintFingerprint: Sha256Digest;
    constraintValidator: VersionedContractComponentRef;
}

export interface OutputContractDefinitionV1 {
    schemaVersion: 1;
    outputContractId: string;
    outputContractFingerprint: Sha256Digest;
    pathAndFileGrammar: VersionedContractComponentRef;
    markerAndSectionGrammar: VersionedContractComponentRef;
    generatedWrapperGrammar: VersionedContractComponentRef;
    materializationValidator: VersionedContractComponentRef;
    reverseInspectionValidator: VersionedContractComponentRef;
    materializationProfiles: OutputContractMaterializationProfile[];
}

export interface ConsumerOutputContractConformanceV1 {
    conformanceFingerprint: Sha256Digest;
    outputContractId: string;
    outputContractFingerprint: Sha256Digest;
    materializationProfileId: MaterializationProfileId;
    agentRuntimeId: AgentRuntimeId;
    buildIdentity: string;
    targetContextSchemaFingerprint: Sha256Digest;
    targetApplicabilityPredicate: VersionedContractComponentRef;
    assetKind: AssetKind;
    renderStrategy: RenderStrategy;
    fixtureSetFingerprint: Sha256Digest;
    evidenceLevel: "agent_runtime_verified";
    status: "passed";
}

export interface SemanticRenderOptionBase {
    optionFingerprint: Sha256Digest;
    semanticRefFingerprint: Sha256Digest;
    renderStrategy: RenderStrategy;
    actualReverseExtractPolicy: ActualReverseExtractPolicy;
    approvalRequirement: AnalysisApprovalRequirement;
    requiredOutputUnitFingerprints: Sha256Digest[];
    /** Structured Provider-owned substitute semantics; never inferred from reasonCode. */
    substituteAssetKind?: AssetKind;
    reasonCode: string;
    diagnostics: OperationDiagnostic[];
}

export type SemanticRenderOption = SemanticRenderOptionBase & RenderOutcomeDetailsV1;

export type CanonicalRenderSemanticValue =
    | {
          semanticRefFingerprint: Sha256Digest;
          canonicalValueFingerprint: Sha256Digest;
          valueKind: "asset_type_data";
          value: AssetKindTypeDataV2;
      }
    | {
          semanticRefFingerprint: Sha256Digest;
          canonicalValueFingerprint: Sha256Digest;
          valueKind: "file_inventory";
          value: {
              fileId: UuidV4;
              logicalPath: PosixRelativePath;
              role: FileRole;
              contentKind: "text" | "binary";
              contentHash: Sha256Digest;
              executable: boolean;
          }[];
      }
    | {
          semanticRefFingerprint: Sha256Digest;
          canonicalValueFingerprint: Sha256Digest;
          valueKind: "file_content";
          value: TargetFileContent;
      };

/** Target-format validation of a reviewed conversion; immutable native Version validation is separate. */
export interface CanonicalRenderEntryValidationInput {
    readonly canonical: AssetKindTypeDataV2;
    readonly canonicalEntry: TargetFileContent;
    readonly nativeEntry: {
        readonly relativePath: PosixRelativePath;
        readonly content: TargetFileContent;
    };
    readonly targetVersion: VersionRef;
    readonly targetScope: "project" | "global";
    readonly nativeDialectId: string;
    readonly nativePreservationSeed?: CanonicalNativePreservationSeed;
}

/** Pure assessment of one immutable source; final entry validation separately checks generated content. */
export type CanonicalMaterializationAssessmentInput = Omit<CanonicalRenderEntryValidationInput, "nativeEntry">;

/** Bound to an existing declared canonical-materializer component, never a saved Version contract. */
export interface AdapterCanonicalMaterializationValidatorV1 {
    readonly outputContractId: OutputContractId;
    readonly materializationProfileId: MaterializationProfileId;
    readonly materializer: VersionedContractComponentRef;
    validateEntry(input: CanonicalRenderEntryValidationInput): boolean;
    /** Required exactly when the corresponding declaration opts into precise loss assessment. */
    assessLoss?(input: CanonicalMaterializationAssessmentInput): RenderDegradationKind[] | null;
}

export interface AdapterRenderAnalysisResult {
    status: OperationStatus;
    outputUnits: RenderOutputUnit[];
    semanticOptions: SemanticRenderOption[];
    blockedSemanticRefs: {
        semanticRefFingerprint: Sha256Digest;
        reasonCode: string;
        diagnostics: OperationDiagnostic[];
    }[];
    diagnostics: OperationDiagnostic[];
}

export type RenderAnalysisResult = AdapterRenderAnalysisResult & {
    adapterId: AdapterId;
    adapterVersion: string;
};

export interface RenderAnalysisView {
    renderInputFingerprint: Sha256Digest;
    requiredSemantics: RequiredRenderSemantic[];
    analyses: RenderAnalysisResult[];
}

/** Core-owned read-only authority projection layered over Provider analysis. */
export interface DeploymentRenderAnalysisView extends RenderAnalysisView {
    promotionAuthorizationInspections: PromotionAuthorizationInspection[];
}

export interface RequestedSemanticOption {
    optionFingerprint: Sha256Digest;
    approvalRequest: RenderApprovalRequest;
}

export interface RenderSelectionRequest {
    schemaVersion: 1;
    renderInputFingerprint: Sha256Digest;
    semanticOptions: RequestedSemanticOption[];
}

export interface ResolvedSelectedSemanticOptionBase {
    consumerOwnerAdapterId: AdapterId;
    consumerOwnerAdapterVersion: string;
    optionFingerprint: Sha256Digest;
    semanticRefFingerprint: Sha256Digest;
    renderStrategy: RenderStrategy;
    actualReverseExtractPolicy: ActualReverseExtractPolicy;
    requiredOutputUnitFingerprints: Sha256Digest[];
    approval: AppliedRenderApprovalEvidence | { approvalState: "not_required" };
}

export type ResolvedSelectedSemanticOption = ResolvedSelectedSemanticOptionBase & ResolvedRenderOutcomeV1;

export interface ResolvedCoreRenderSelection {
    schemaVersion: 1;
    compilerPolicyVersion: "core_render_policy_v1";
    renderInputFingerprint: Sha256Digest;
    semanticOptions: ResolvedSelectedSemanticOption[];
    outputUnits: RenderOutputUnit[];
    outputUnitRenderers: SelectedOutputUnitRenderer[];
    promotionAuthorizations: ResolvedPromotionAuthorization[];
    selectionFingerprint: Sha256Digest;
}

export interface MaterializationSafeSelectedSemanticOptionBase {
    optionFingerprint: Sha256Digest;
    semanticRefFingerprint: Sha256Digest;
    renderStrategy: RenderStrategy;
    actualReverseExtractPolicy: ActualReverseExtractPolicy;
    requiredOutputUnitFingerprints: Sha256Digest[];
}

export type MaterializationSafeSelectedSemanticOption = MaterializationSafeSelectedSemanticOptionBase & ResolvedRenderOutcomeV1;

export interface MaterializationSafeRenderSelection {
    schemaVersion: 1;
    semanticOptions: MaterializationSafeSelectedSemanticOption[];
    outputUnits: RenderOutputUnit[];
    outputUnitRenderers: SelectedOutputUnitRenderer[];
}

export interface RenderMaterializationInput {
    schemaVersion: 1;
    deployment: ProviderRenderDeploymentProjection;
    requiredSemantics: RequiredRenderSemantic[];
    dialectInputs: ProviderRenderDialectInputsForAsset[];
    selection: MaterializationSafeRenderSelection;
}

export interface MaterializedRenderFile {
    relativePath: PosixRelativePath;
    content: TargetFileContent;
    executable: boolean;
    semanticRefFingerprints: Sha256Digest[];
    sectionBindings: RenderedSectionBinding[];
    /** Optional reviewed interpretation of `content` as a bounded live-container patch. */
    containerPatch?: {
        patchKind: "jsonc_top_level_property_value";
        propertyName: string;
    };
}

export interface MaterializedOutputUnitReceipt {
    outputUnitFingerprint: Sha256Digest;
    files: MaterializedRenderFile[];
}

export type RenderMaterializationResult =
    | {
          status: OperationStatus;
          materializationState: "materialized";
          materializedUnits: MaterializedOutputUnitReceipt[];
          diagnostics: OperationDiagnostic[];
      }
    | {
          status: OperationStatus;
          materializationState: "blocked";
          reasonCode: string;
          diagnostics: OperationDiagnostic[];
      };

export interface DeployWithRenderSelectionBase {
    deploymentId: UuidV4;
    selectionRequest: RenderSelectionRequest;
}

export type DeployWithRenderSelectionInput = DeployWithRenderSelectionBase &
    (
        | { deploymentAction: "apply"; expectedPreviewFingerprint: Sha256Digest }
        | {
              deploymentAction: "replace_unmanaged";
              expectedPreviewFingerprint: Sha256Digest;
              userActionId: string;
          }
        | {
              deploymentAction: "overwrite_runtime";
              expectedPreviewFingerprint: Sha256Digest;
              userActionId: string;
          }
    );
