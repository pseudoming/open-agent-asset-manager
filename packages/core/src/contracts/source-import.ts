import type { OperationDiagnostic, VersionRef } from "./common";
import type { VersionFileInput } from "./core-service";
import type { RenderStrategy } from "./deployment-authority";
import type {
    AdapterNativeExactGraphRenderDeclarationV1,
    AdapterNativeGlobalEncodedFileRenderDeclarationV1,
    AdapterNativeProjectEncodedFileRenderDeclarationV1,
} from "./native-exact-graph";
import type { PromotionGrantTarget, SourcePromotionSafety } from "./persistence";
import type {
    AdapterId,
    AgentRuntimeId,
    AssetKind,
    AssetScope,
    EpochMillis,
    OperationStatus,
    Platform,
    PosixRelativePath,
    Sha256Digest,
    UuidV4,
    VersionStatus,
} from "./primitives";
import type { VersionedContractComponentRef } from "./render";
import type { CandidateNativeRepresentationInput } from "./source-import-native-representation";
import type {
    AgentRuntimeDescriptor,
    PlatformContext,
    ProbeObservation,
    RootLocatorKind,
    RootRole,
    SourceDomain,
    SourceEvidenceLevel,
    SourcePathMechanism,
    SourceRoot,
} from "./source-import-probe";
import type { AssetKindTypeDataV2, MemoryTypeDataV2, WorkflowTypeDataV2 } from "./specs";
import type { AdapterTargetBuildCompatibilityPolicyV1 } from "./target-build-compatibility";

export type * from "./native-exact-graph";
export type * from "./source-import-native-representation";
export type * from "./source-import-probe";

export type EntrySupportStatus = "supported" | "unsupported" | "docs_declared_unverified" | "deferred";
export type ReadPolicy = "auto_read" | "user_selected_root_only" | "report_only";

export type ReverseExtractPolicy = "can_reconcile" | "ignore_generated_wrapper" | "requires_user_choice" | "unsupported";

export type OutputContractId = string;
export type OutputContractFingerprint = Sha256Digest;
export type MaterializerCapabilityKey = string;
export type MaterializationProfileId = string;
export type TargetContextSchemaId = string;

/**
 * Pure-data target conformance owned by the adapter that knows the concrete
 * agent-runtime. Core validates and compiles it, but never supplies runtime IDs,
 * filenames, build hashes, or private profile names.
 */
interface AdapterNativeGuidanceRenderDeclarationBaseV1 {
    schemaVersion: 1;
    outputContractId: OutputContractId;
    materializationProfileId: MaterializationProfileId;
    agentRuntimeId: AgentRuntimeId;
    target: {
        relativePath: PosixRelativePath;
        targetContextSchemaId: TargetContextSchemaId;
        requiredFacts: Record<string, string>;
    };
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

export interface AdapterNativeProjectGuidanceRenderDeclarationV1 extends AdapterNativeGuidanceRenderDeclarationBaseV1 {
    declarationKind: "native_project_guidance_v1";
}

export interface AdapterNativeGlobalGuidanceRenderDeclarationV1 extends AdapterNativeGuidanceRenderDeclarationBaseV1 {
    declarationKind: "native_global_guidance_v1";
}

export type AdapterNativeGuidanceRenderDeclarationV1 =
    | AdapterNativeProjectGuidanceRenderDeclarationV1
    | AdapterNativeGlobalGuidanceRenderDeclarationV1;

/**
 * Pure-data declaration for one native project Rule file. The owning Provider
 * supplies the runtime directory, suffix, target schema and exact-build
 * evidence; Core only compiles the portable unconditional-Rule subset.
 */
interface AdapterNativeRuleRenderDeclarationBaseV1 {
    schemaVersion: 1;
    outputContractId: OutputContractId;
    materializationProfileId: MaterializationProfileId;
    agentRuntimeId: AgentRuntimeId;
    target: {
        relativeDirectory: PosixRelativePath;
        fileNameSuffix: string;
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

export interface AdapterNativeProjectRuleRenderDeclarationV1 extends AdapterNativeRuleRenderDeclarationBaseV1 {
    declarationKind: "native_project_rule_v1";
}

export interface AdapterNativeGlobalRuleRenderDeclarationV1 extends AdapterNativeRuleRenderDeclarationBaseV1 {
    declarationKind: "native_global_rule_v1";
}

export type AdapterNativeRuleRenderDeclarationV1 =
    | AdapterNativeProjectRuleRenderDeclarationV1
    | AdapterNativeGlobalRuleRenderDeclarationV1;

export type NativeProjectExactFileAssetKind = "Rule" | "Workflow" | "Skill" | "Subagent" | "Memory";

/**
 * Pure-data declaration for one project-scoped native file. A current native
 * representation may be restored exactly; an immediate-parent representation
 * may be rebased only when the immutable dialect contract names a matching
 * rebase materializer. Core owns lineage, projection and publication.
 */
export interface AdapterNativeProjectExactFileRenderDeclarationV1 {
    schemaVersion: 1;
    declarationKind: "native_project_exact_file_v1";
    outputContractId: OutputContractId;
    materializationProfileId: MaterializationProfileId;
    agentRuntimeId: AgentRuntimeId;
    assetKind: NativeProjectExactFileAssetKind;
    nativeDialectId: string;
    projectPathValidator: VersionedContractComponentRef;
    reverseParser: VersionedContractComponentRef;
    rebaseMaterializer: VersionedContractComponentRef | null;
    restorationDialectIds: string[];
    target: {
        targetContextSchemaId: TargetContextSchemaId;
        requiredFacts: Record<string, string>;
    };
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

export type AdapterRenderContractDeclarationV1 =
    | AdapterNativeGuidanceRenderDeclarationV1
    | AdapterNativeRuleRenderDeclarationV1
    | AdapterNativeProjectExactFileRenderDeclarationV1
    | AdapterNativeProjectEncodedFileRenderDeclarationV1
    | AdapterNativeGlobalEncodedFileRenderDeclarationV1
    | AdapterNativeExactGraphRenderDeclarationV1;

export interface TargetContextFactRule {
    key: string;
    valueKind: "canonical_string";
    normalization: VersionedContractComponentRef;
}

export interface AdapterTargetContextSchemaDeclaration {
    targetContextSchemaId: TargetContextSchemaId;
    schemaFingerprint: Sha256Digest;
    agentRuntimeId: AgentRuntimeId;
    factRules: TargetContextFactRule[];
    diagnostics: OperationDiagnostic[];
}

export interface AdapterAssetSourceCapability {
    sourceCapabilityFingerprint: Sha256Digest;
    agentRuntimeId: AgentRuntimeId;
    entrySupportStatus: EntrySupportStatus;
    rootLocatorKind: RootLocatorKind;
    rootRole: RootRole;
    sourceDomain: SourceDomain;
    assetKind: AssetKind;
    sourcePathMechanism: SourcePathMechanism;
    evidenceLevel: SourceEvidenceLevel;
    readPolicy: ReadPolicy;
    diagnostics: OperationDiagnostic[];
}

export interface AdapterAssetTargetCapabilityAvailable {
    agentRuntimeId: AgentRuntimeId;
    entrySupportStatus: "supported" | "docs_declared_unverified";
    assetKind: AssetKind;
    renderStrategy: RenderStrategy;
    outputContractId: OutputContractId;
    outputContractFingerprint: OutputContractFingerprint;
    targetContextSchemaId: TargetContextSchemaId;
    targetContextSchemaFingerprint: Sha256Digest;
    reverseExtractPolicy: ReverseExtractPolicy;
    diagnostics: OperationDiagnostic[];
}

export interface AdapterMaterializerCapability {
    materializerCapabilityKey: MaterializerCapabilityKey;
    outputContractId: OutputContractId;
    outputContractFingerprint: OutputContractFingerprint;
    materializationProfileIds: MaterializationProfileId[];
    diagnostics: OperationDiagnostic[];
}

export interface AdapterAssetTargetCapabilityUnavailable {
    agentRuntimeId: AgentRuntimeId;
    entrySupportStatus: "unsupported" | "deferred";
    assetKind: AssetKind;
    diagnostics: OperationDiagnostic[];
}

export type AdapterAssetTargetCapability = AdapterAssetTargetCapabilityAvailable | AdapterAssetTargetCapabilityUnavailable;

export interface AdapterProviderSummary {
    adapterId: AdapterId;
    displayName: string;
    version: string;
    enabled: boolean;
    agentRuntimes: AgentRuntimeDescriptor[];
    targetContextSchemas: AdapterTargetContextSchemaDeclaration[];
    assetSourceCapabilities: AdapterAssetSourceCapability[];
    assetTargetCapabilities: AdapterAssetTargetCapability[];
    materializerCapabilities: AdapterMaterializerCapability[];
    renderContractDeclarations: AdapterRenderContractDeclarationV1[];
}

export type AssetCandidateStatus = "importable" | "incomplete";

export type SourceEvidence =
    | {
          evidenceOrigin: "observed_read";
          observedReadEntryId: string;
          kind: "path" | "document" | "database" | "frontmatter" | "import" | "summary" | "other";
          value: string;
          evidenceLevel: SourceEvidenceLevel;
      }
    | { evidenceOrigin: "external_attestation"; externalAttestationReceiptId: string };

export type ExternalAttestationSubject =
    | {
          subjectKind: "source_root_entry";
          sourceRootId: string;
          relativePath: PosixRelativePath | "";
      }
    | { subjectKind: "agent_runtime"; agentRuntimeId: AgentRuntimeId };

export interface ExternalAttestationRequest {
    verifier: VersionedContractComponentRef;
    subject: ExternalAttestationSubject;
}

export interface ExternalAttestationReceipt {
    externalAttestationReceiptId: string;
    verifier: VersionedContractComponentRef;
    subject: ExternalAttestationSubject;
    subjectFingerprint: Sha256Digest;
    verifierInputFingerprint: Sha256Digest;
    attestedKind: "environment" | "document" | "summary" | "other";
    attestedValue: string;
    evidenceLevel: SourceEvidenceLevel;
    verifierResultFingerprint: Sha256Digest;
    attestationReceiptFingerprint: Sha256Digest;
}

export type ExternalAttestationResult =
    | { state: "succeeded"; receipt: ExternalAttestationReceipt }
    | {
          state: "failed";
          failureStatus: "unsupported_verifier" | "invalid_subject" | "verification_failed" | "io_error";
          diagnostics: OperationDiagnostic[];
      };

export interface CandidateFileSourceOrigin {
    logicalPath: PosixRelativePath;
    observedReadEntryIds: string[];
}

export interface CandidateMetadataSourceOrigin {
    metadataSubject: "display_name" | "display_description" | "type_data";
    observedReadEntryId: string;
}

export type CandidateDialectRestorationTransitionInput =
    | { action: "inherit" }
    | { action: "replace"; bytes: Uint8Array }
    | { action: "clear" };

export interface ExtractedAssetCandidateBase {
    candidateId: string;
    sourceRootIds: string[];
    scope: AssetScope;
    projectRootPath: string;
    scopePath: string;
    displayName: string;
    displayDescription: string;
    files: VersionFileInput[];
    nativeRepresentation: CandidateNativeRepresentationInput;
    dialectRestorationTransition: CandidateDialectRestorationTransitionInput;
    status: VersionStatus;
    assetCandidateStatus: AssetCandidateStatus;
    promotionSafety: SourcePromotionSafety;
    sourceFileOrigins: CandidateFileSourceOrigin[];
    sourceContainerEntryIds: string[];
    metadataSourceOrigins: CandidateMetadataSourceOrigin[];
    sourceEvidence: SourceEvidence[];
    diagnostics: OperationDiagnostic[];
}

/**
 * Exact parser classification for a Workflow's top-level agent selector.
 * This operation-local input is not copied into a published AssetVersion.
 */
export type WorkflowExecutionAgentBindingInputV1 =
    | { bindingInputKind: "none" }
    | { bindingInputKind: "raw_selector"; rawTarget: string; required: boolean };

/**
 * Operation-local source identity for one ordered Memory Catalog member.
 * The raw runtime locator is resolved to an immutable Unit Version during
 * import and is never persisted as canonical membership authority.
 */
export interface MemoryCatalogMemberBindingInputV1 {
    rawTarget: PosixRelativePath;
    routingTitle: string;
    routingHint: string;
}

export type AdapterExtractedAssetCandidate = ExtractedAssetCandidateBase &
    (
        | Exclude<AssetKindTypeDataV2, { kind: "Workflow" | "Memory" }>
        | {
              kind: "Workflow";
              typeData: WorkflowTypeDataV2;
              workflowExecutionAgentBindingInput: WorkflowExecutionAgentBindingInputV1;
          }
        | {
              kind: "Memory";
              typeData: MemoryTypeDataV2;
              /** Required for complete source Catalogs; absent on Units and legacy incomplete Catalog reports. */
              memoryCatalogMemberBindingInputs?: MemoryCatalogMemberBindingInputV1[];
          }
    );
export type ExtractedAssetCandidate = AdapterExtractedAssetCandidate & { adapterId: AdapterId };

export type SourceReadStatus =
    | "scanned"
    | "not_found"
    | "empty"
    | "partial"
    | "blocked"
    | "skipped_ignored_source"
    | "deferred"
    | "unsupported"
    | "permission_denied"
    | "malformed_source"
    | "unknown_schema";

export type ProviderSourceParseStatus =
    | "parsed"
    | "empty"
    | "skipped_ignored_source"
    | "deferred"
    | "unsupported"
    | "malformed_source"
    | "unknown_schema";

export interface SourceReadObligation {
    sourceReadObligationId: string;
    sourceRootId: string;
    sourceCapabilityFingerprint: Sha256Digest;
}

export type ProviderReadEntryDisposition =
    | {
          readEntryDispositionId: string;
          sourceReadObligationId: string;
          readEntryHandleId: string;
          disposition: "traversed";
          listDirectoryOutcomeId: string;
          observedDirectoryEntryId: string;
          candidateIds: string[];
      }
    | {
          readEntryDispositionId: string;
          sourceReadObligationId: string;
          readEntryHandleId: string;
          disposition: "parsed";
          readAccessOutcomeId: string;
          observedReadEntryIds: string[];
          candidateIds: string[];
      }
    | {
          readEntryDispositionId: string;
          sourceReadObligationId: string;
          readEntryHandleId: string;
          disposition: "ignored";
          reasonCode: string;
      };

export interface ProviderSourceParseReport {
    sourceRootId: string;
    sourceReadObligationIds: string[];
    status: ProviderSourceParseStatus;
    observedReadEntryIds: string[];
    readEntryDispositions: ProviderReadEntryDisposition[];
    diagnostics: OperationDiagnostic[];
}

export interface SourceReadReport {
    sourceRootId: string;
    status: SourceReadStatus;
    diagnostics: OperationDiagnostic[];
}

export interface AdapterProviderReadResult {
    candidates: AdapterExtractedAssetCandidate[];
    sourceParseReports: ProviderSourceParseReport[];
    diagnostics: OperationDiagnostic[];
}

export interface AdapterReadResult {
    status: OperationStatus;
    /** Exact Core-owned request needed to replay freshness without hidden session state. */
    readTarget: AdapterReadTarget;
    readAuthorityFingerprint: Sha256Digest;
    readSnapshotFingerprint: Sha256Digest;
    sourceRoots: SourceRoot[];
    sourceReadObligations: SourceReadObligation[];
    readAccessOutcomes: ReadAccessOutcome[];
    observedReadEntries: ObservedReadEntry[];
    externalAttestationReceipts: ExternalAttestationReceipt[];
    sourceParseReports: ProviderSourceParseReport[];
    candidates: ExtractedAssetCandidate[];
    sourceReports: SourceReadReport[];
    diagnostics: OperationDiagnostic[];
}

export type AdapterReadSourceSelector =
    | {
          selectorKind: "probe_roots";
          observation: ProbeObservation;
          sourceRootIds: string[];
      }
    | {
          selectorKind: "user_selected_root";
          platformContext: PlatformContext;
          binding: ResolvedUserSelectedRootBinding;
      };

export interface UserSelectedRootRequest {
    rootPath: string;
    assetScope: "global" | "project";
    projectRootPath: string;
}

export interface ResolvedUserSelectedRootBinding {
    sourceRoot: SourceRoot;
    assetScope: "global" | "project";
    projectRootPath: string;
}

export interface AdapterReadTarget {
    adapterId: AdapterId;
    sourceSelector: AdapterReadSourceSelector;
    /** Optional explicit interpretation subset; omission retains all observed/root-owning entries. */
    agentRuntimeIds?: AgentRuntimeId[];
    allowedKinds?: AssetKind[];
}

export type AdapterProviderReadTarget = Omit<AdapterReadTarget, "adapterId" | "allowedKinds" | "agentRuntimeIds">;

export type ManagedTargetReadGuard =
    | {
          sourceRootId: string;
          matchKind: "entire_root";
          managementState: "active_managed" | "residual_managed";
          deploymentId: UuidV4;
          outputUnitFingerprint: Sha256Digest;
      }
    | {
          sourceRootId: string;
          relativePath: PosixRelativePath;
          matchKind: "exact_file";
          managementState: "active_managed" | "residual_managed";
          deploymentId: UuidV4;
          appliedContentHash: Sha256Digest;
      }
    | {
          sourceRootId: string;
          relativePath: PosixRelativePath;
          matchKind: "directory_prefix";
          managementState: "active_managed" | "residual_managed";
          deploymentId: UuidV4;
          outputUnitFingerprint: Sha256Digest;
      }
    | {
          sourceRootId: string;
          matchKind: "entire_root";
          managementState: "in_flight_managed";
          deploymentId: UuidV4;
          reservationIdentityFingerprint: Sha256Digest;
      }
    | {
          sourceRootId: string;
          relativePath: PosixRelativePath;
          matchKind: "exact_file" | "directory_prefix";
          managementState: "in_flight_managed";
          deploymentId: UuidV4;
          reservationIdentityFingerprint: Sha256Digest;
      };

export type ObservedReadEntry =
    | {
          observedReadEntryId: string;
          sourceRootId: string;
          relativePath: PosixRelativePath | "";
          entryKind: "file";
          contentHash: Sha256Digest;
          executable: boolean;
          physicalIdentityFingerprint: Sha256Digest;
      }
    | {
          observedReadEntryId: string;
          sourceRootId: string;
          relativePath: PosixRelativePath | "";
          entryKind: "directory";
          physicalIdentityFingerprint: Sha256Digest;
          directoryInventoryFingerprint: Sha256Digest;
      };

export interface ReadEntryHandle {
    readEntryHandleId: string;
    sourceReadObligationId: string;
    sourceRootId: string;
    relativePath: PosixRelativePath | "";
    entryKind: "file" | "directory";
}

export type ReadAccessOutcomeStatus =
    | "succeeded"
    | "not_found"
    | "permission_denied"
    | "blocked_managed_target"
    | "blocked_symlink_or_reparse"
    | "resource_limit_exceeded"
    | "busy"
    | "stale"
    | "io_error";

export interface ReadAccessOutcomeBase {
    readAccessOutcomeId: string;
    sourceReadObligationId: string;
    sourceRootId: string;
    relativePath: PosixRelativePath | "";
    status: ReadAccessOutcomeStatus;
    observedReadEntryIds: string[];
    diagnostics: OperationDiagnostic[];
}

export type ReadAccessOutcome =
    | (ReadAccessOutcomeBase & {
          operation: "resolve_root" | "resolve_entry";
          producedReadEntryHandleIds: string[];
      })
    | (ReadAccessOutcomeBase & {
          operation: "list_directory";
          subjectReadEntryHandleId: string;
          producedReadEntryHandleIds: string[];
      })
    | (ReadAccessOutcomeBase & {
          operation: "read_file" | "final_validate";
          subjectReadEntryHandleId: string;
          producedReadEntryHandleIds: [];
      });

export type ReadAccessResult<T> =
    | { state: "succeeded"; readAccessOutcomeId: string; value: T }
    | {
          state: "failed";
          readAccessOutcomeId: string;
          failureStatus: Exclude<ReadAccessOutcomeStatus, "succeeded">;
          diagnostics: OperationDiagnostic[];
      };

export interface AdapterReadAccess {
    resolveRootEntry(sourceReadObligationId: string, sourceRootId: string): Promise<ReadAccessResult<ReadEntryHandle>>;
    resolveEntry(
        sourceReadObligationId: string,
        sourceRootId: string,
        relativePath: PosixRelativePath,
    ): Promise<ReadAccessResult<ReadEntryHandle>>;
    listDirectory(readEntryHandleId: string): Promise<
        ReadAccessResult<{
            directory: Extract<ObservedReadEntry, { entryKind: "directory" }>;
            children: ReadEntryHandle[];
        }>
    >;
    readFile(readEntryHandleId: string): Promise<
        ReadAccessResult<{
            entry: Extract<ObservedReadEntry, { entryKind: "file" }>;
            bytes: Uint8Array;
        }>
    >;
    verifyExternalAttestation(request: ExternalAttestationRequest): Promise<ExternalAttestationResult>;
}

export interface AdapterProviderReadInput {
    target: AdapterProviderReadTarget;
    sourceReadObligations: SourceReadObligation[];
    managedTargetGuards: ManagedTargetReadGuard[];
    readAuthorityFingerprint: Sha256Digest;
    readAccess: AdapterReadAccess;
}

export type CallableBindingSubjectV1 =
    | { subjectKind: "workflow_execution_agent" }
    | { subjectKind: "file_reference"; logicalPath: PosixRelativePath; referenceIndex: number }
    | { subjectKind: "memory_catalog_member"; memberIndex: number };

export interface CallableBindingRequestV1 {
    subject: CallableBindingSubjectV1;
    rawTarget: string;
    required: boolean;
}

export interface ResolvedCallableBindingV1 {
    subject: CallableBindingSubjectV1;
    targetAssetVersionId: UuidV4;
}

export interface ImportPreviewItemBase {
    candidateId: string;
    freshness: "fresh" | "stale" | "unknown" | "requires_refresh";
    callableBindingRequests: CallableBindingRequestV1[];
    diagnostics: OperationDiagnostic[];
}

export type ImportPreviewItem = ImportPreviewItemBase &
    (
        | { action: "create_asset" }
        | { action: "duplicate"; assetId: UuidV4; versionId: UuidV4 }
        | { action: "incomplete" }
        | { action: "blocked" }
    );

export interface ImportPreviewSnapshotV1 {
    schemaVersion: 1;
    previewedAt: EpochMillis;
    readResults: AdapterReadResult[];
    items: ImportPreviewItem[];
    snapshotFingerprint: Sha256Digest;
}

export type ImportFreshnessDisposition =
    | { freshnessAction: "require_current_source" }
    | { freshnessAction: "accept_preview_snapshot"; userActionId: string };

export type ImportPromotionDisposition =
    | { promotionAction: "import_only"; userActionId: string }
    | {
          promotionAction: "grant_current_version_current_target";
          target: PromotionGrantTarget;
          userActionId: string;
      }
    | {
          promotionAction: "grant_asset_all_versions_current_target";
          target: PromotionGrantTarget;
          userActionId: string;
      };

export interface ImportCreateDecisionBase {
    candidateId: string;
    freshness: ImportFreshnessDisposition;
    promotion: ImportPromotionDisposition;
    callableBindings: ResolvedCallableBindingV1[];
}

export type ImportCreateDecision =
    | (ImportCreateDecisionBase & { action: "create_asset" })
    | (ImportCreateDecisionBase & {
          action: "create_version";
          assetId: UuidV4;
          parentVersionId: UuidV4;
      });

export interface ImportAcceptRequest {
    previewSnapshot: ImportPreviewSnapshotV1;
    decision: ImportCreateDecision;
}

export type ImportAcceptBatchCallableBindingV1 =
    | ResolvedCallableBindingV1
    | {
          subject: CallableBindingSubjectV1;
          targetCandidateId: string;
      };

export interface ImportAcceptBatchDecisionBase {
    candidateId: string;
    freshness: ImportFreshnessDisposition;
    promotion: ImportPromotionDisposition;
    callableBindings: ImportAcceptBatchCallableBindingV1[];
}

export type ImportAcceptBatchDecision =
    | (ImportAcceptBatchDecisionBase & { action: "create_asset" })
    | (ImportAcceptBatchDecisionBase & {
          action: "create_version";
          assetId: UuidV4;
          parentVersionId: UuidV4;
      });

export interface ImportAcceptBatchRequest {
    previewSnapshot: ImportPreviewSnapshotV1;
    decisions: ImportAcceptBatchDecision[];
}

export type ImportAcceptBatchItemResultV1 =
    | {
          status: "complete";
          candidateId: string;
          version: VersionRef;
          diagnostics: OperationDiagnostic[];
      }
    | {
          status: "failed";
          candidateId: string;
          diagnostics: OperationDiagnostic[];
      }
    | {
          status: "dependency_failed";
          candidateId: string;
          failedDependencyCandidateIds: string[];
          diagnostics: OperationDiagnostic[];
      };

export interface ImportAcceptBatchResultV1 {
    schemaVersion: 1;
    items: ImportAcceptBatchItemResultV1[];
}

export type CreatePromotionGrantRequest =
    | {
          promotionAction: "grant_current_version_current_target";
          assetId: UuidV4;
          versionId: UuidV4;
          target: PromotionGrantTarget;
          userActionId: string;
      }
    | {
          promotionAction: "grant_asset_all_versions_current_target";
          assetId: UuidV4;
          target: PromotionGrantTarget;
          userActionId: string;
      };

export interface RevokePromotionGrantRequest {
    promotionGrantId: UuidV4;
    expectedRevision: number;
    expectedGrantFingerprint: Sha256Digest;
    userActionId: string;
}

export interface SetRestrictedSourcePromotionFullAccessRequest {
    settingId: "restricted_source_promotion_full_access_v1";
    expectedRevision: number;
    expectedSettingFingerprint: Sha256Digest;
    nextState: "enabled" | "disabled";
    userActionId: string;
}
