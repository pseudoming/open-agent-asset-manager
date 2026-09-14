import type {
    AssetKindCount,
    AssetListFilter,
    AssetSummaryPage,
    AssetVersionFilePreview,
    AssetVersionFileTreePage,
    AssetVersionPage,
    AssetVersionTextPage,
    CurrentAssetSummary,
    ListAssetVersionFileChildrenInput,
    ListAssetVersionPageInput,
    QueryAssetKindCountsInput,
    QueryAssetSummaryPageInput,
    ReadAssetVersionFilePreviewInput,
    ReadAssetVersionTextPageInput,
} from "./asset-library";
import type { AssetPurgePreparationV1, AssetPurgeResultV1, CommitAssetPurgeInputV1 } from "./asset-lifecycle";
import type { AssetVersionFileContentV2, AssetVersionManifestV2, FileReferenceV2 } from "./asset-version";
import type {
    ExportAssetVersionNativeFilesToFileInputV1,
    ExportAssetVersionNativeFilesToFileResultV1,
    ExportAssetVersionToFileInputV1,
    ExportAssetVersionToFileResultV1,
} from "./asset-version-archive";
import type {
    AssetVersionComparisonObserver,
    AssetVersionComparisonV1,
    CompareAssetVersionsInputV1,
} from "./asset-version-comparison";
import type { CatalogSearchApi } from "./catalog-search";
import type { Diagnostic, OperationDiagnostic, VersionRef } from "./common";
import type { DeploymentFileBaselineStateV1, RenderDegradationKind } from "./deployment-authority";
import type { PromotionGrantV1, RestrictedSourcePromotionFullAccessSettingV1 } from "./persistence";
import type {
    AdapterId,
    AgentRuntimeId,
    AssetKind,
    AssetScope,
    EpochMillis,
    FileRole,
    OperationStatus,
    Platform,
    PosixRelativePath,
    Sha256Digest,
    UuidV4,
    VersionStatus,
} from "./primitives";
import type {
    CommitProjectLifecycleInputV1,
    InspectProjectLifecycleInputV1,
    ProjectLifecyclePreparationV1,
} from "./project-lifecycle";
import type { DeploymentRenderAnalysisView, DeployWithRenderSelectionInput } from "./render";
import type { DeploymentRenderPreviewView, PreviewDeploymentRenderInput } from "./render-preview";
import type {
    CancelRenderedTargetAcceptInput,
    CommitRenderedTargetAcceptInput,
    PrepareRenderedTargetAcceptInput,
    RenderedTargetAcceptCommitView,
    RenderedTargetAcceptPreparationView,
    RenderedTargetInspectionResult,
} from "./reverse";
import type {
    AdapterProviderSummary,
    AdapterReadResult,
    AdapterReadTarget,
    CreatePromotionGrantRequest,
    ImportAcceptBatchRequest,
    ImportAcceptBatchResultV1,
    ImportAcceptRequest,
    ImportPreviewSnapshotV1,
    PlatformContext,
    ProbeAdaptersInput,
    ProbeAdaptersObserver,
    ProbeResult,
    RevokePromotionGrantRequest,
    RootLocatorKind,
    RootRole,
    SetRestrictedSourcePromotionFullAccessRequest,
    SourceDomain,
} from "./source-import";
import type {
    AssetTypeDataCurrent,
    GuidanceTypeDataV1,
    MemoryTypeDataV2,
    RuleTypeDataV2,
    SkillTypeDataV2,
    SubagentTypeDataV2,
    WorkflowTypeDataV2,
} from "./specs";
import type {
    CreateStateBackupInputV1,
    InspectStateBackupInputV1,
    ReplaceStateBackupPromptPolicyInputV1,
    RetireStateBackupInputV1,
    StateBackupArtifactV1,
    StateBackupExecutionObserver,
    StateBackupInventoryV1,
    StateBackupPreparationV1,
    StateBackupPromptPolicyV1,
    StateBackupRetirementV1,
} from "./state-resilience";

export interface CoreResult<T> {
    status: OperationStatus;
    value: T;
    diagnostics: OperationDiagnostic[];
}

export interface LookupResult<T> {
    found: boolean;
    value?: T;
}

export interface AssetManifestV1 {
    schemaVersion: 1;
    assetId: UuidV4;
    kind: AssetKind;
    scope: AssetScope;
    projectId: string;
    scopePath: string;
    displayName: string;
    displayDescription: string;
    versionIds: UuidV4[];
    deleted: boolean;
    createdAt: EpochMillis;
    updatedAt: EpochMillis;
}

export interface ProjectManifestV1 {
    schemaVersion: 1;
    projectId: UuidV4;
    rootPath: string;
    displayName: string;
    deleted: boolean;
    createdAt: EpochMillis;
    updatedAt: EpochMillis;
}

export interface RegisterProjectInput {
    rootPath: string;
    displayName?: string;
}
export interface ProjectFilter {
    includeDeleted?: boolean;
}

export interface ProjectApi {
    registerProject(input: RegisterProjectInput): CoreResult<ProjectManifestV1>;
    getProject(projectId: UuidV4): CoreResult<LookupResult<ProjectManifestV1>>;
    listProjects(filter?: ProjectFilter): CoreResult<ProjectManifestV1[]>;
}

export interface ProjectLifecycleApi {
    inspectProjectLifecycle(input: InspectProjectLifecycleInputV1): CoreResult<ProjectLifecyclePreparationV1>;
    commitProjectLifecycle(input: CommitProjectLifecycleInputV1): CoreResult<ProjectManifestV1>;
}

export interface AssetRef {
    assetId: UuidV4;
}

export interface AssetVersionBundle {
    manifest: AssetVersionManifestV2;
    files: AssetVersionFileContentV2[];
}

export type AssetVersionFileContent = AssetVersionFileContentV2;

export interface AssetApiRead {
    getAsset(assetId: UuidV4): CoreResult<LookupResult<AssetManifestV1>>;
    listAssets(filter?: AssetListFilter): CoreResult<CurrentAssetSummary[]>;
    getCurrentVersion(assetId: UuidV4): CoreResult<LookupResult<AssetVersionBundle>>;
    getVersion(ref: VersionRef): CoreResult<LookupResult<AssetVersionBundle>>;
    listVersions(assetId: UuidV4): CoreResult<AssetVersionManifestV2[]>;
}

export interface AssetLibraryApi {
    listAssetKindCounts(input: QueryAssetKindCountsInput): CoreResult<AssetKindCount[]>;
    queryAssetSummaryPage(input: QueryAssetSummaryPageInput): CoreResult<AssetSummaryPage>;
    getVersionManifest(ref: VersionRef): CoreResult<LookupResult<AssetVersionManifestV2>>;
    listAssetVersionPage(input: ListAssetVersionPageInput): CoreResult<LookupResult<AssetVersionPage>>;
    listAssetVersionFileChildren(input: ListAssetVersionFileChildrenInput): CoreResult<LookupResult<AssetVersionFileTreePage>>;
    readAssetVersionFilePreview(input: ReadAssetVersionFilePreviewInput): CoreResult<LookupResult<AssetVersionFilePreview>>;
    readAssetVersionTextPage(input: ReadAssetVersionTextPageInput): CoreResult<LookupResult<AssetVersionTextPage>>;
    compareAssetVersions(
        input: CompareAssetVersionsInputV1,
        observer?: AssetVersionComparisonObserver,
    ): Promise<CoreResult<AssetVersionComparisonV1>>;
    exportAssetVersionToFile(input: ExportAssetVersionToFileInputV1): Promise<CoreResult<ExportAssetVersionToFileResultV1>>;
    exportAssetVersionNativeFilesToFile(
        input: ExportAssetVersionNativeFilesToFileInputV1,
    ): Promise<CoreResult<ExportAssetVersionNativeFilesToFileResultV1>>;
}

export interface CreateAssetInputBase {
    scope: AssetScope;
    projectId: string;
    scopePath: string;
    displayName: string;
    displayDescription?: string;
}

export interface CreateVersionInput<TTypeData extends AssetTypeDataCurrent = AssetTypeDataCurrent> {
    typeData: TTypeData;
    files: VersionFileInput[];
    status?: VersionStatus;
    diagnostics?: Diagnostic[];
    userActionEvidenceId: string;
    changeKind: "extract" | "edit" | "sync" | "rollback" | "merge";
    sourceVersionId: UuidV4;
    sourceDeploymentId?: UuidV4;
    changeNote?: string;
}

export type CreateInitialVersionInput<TTypeData extends AssetTypeDataCurrent = AssetTypeDataCurrent> = Omit<
    CreateVersionInput<TTypeData>,
    "sourceVersionId" | "changeKind"
> & {
    changeKind: "create";
};

export type CreateAssetInput = CreateAssetInputBase &
    (
        | { kind: "Guidance"; initialVersion: CreateInitialVersionInput<GuidanceTypeDataV1> }
        | { kind: "Rule"; initialVersion: CreateInitialVersionInput<RuleTypeDataV2> }
        | { kind: "Workflow"; initialVersion: CreateInitialVersionInput<WorkflowTypeDataV2> }
        | { kind: "Skill"; initialVersion: CreateInitialVersionInput<SkillTypeDataV2> }
        | { kind: "Subagent"; initialVersion: CreateInitialVersionInput<SubagentTypeDataV2> }
        | { kind: "Memory"; initialVersion: CreateInitialVersionInput<MemoryTypeDataV2> }
    );

export type VersionFileInput =
    | {
          logicalPath: PosixRelativePath;
          role: FileRole;
          contentKind: "text";
          mediaType: string;
          text: string;
          executable: boolean;
          references?: FileReferenceV2[];
      }
    | {
          logicalPath: PosixRelativePath;
          role: FileRole;
          contentKind: "binary";
          mediaType: string;
          bytes: Uint8Array;
          executable: boolean;
          references?: FileReferenceV2[];
      };

export interface UpdateAssetDisplayInput {
    displayName?: string;
    displayDescription?: string;
}

export interface CopyAssetVersionToLocationInputV1 {
    source: {
        assetId: UuidV4;
        versionId: UuidV4;
        versionFingerprint: Sha256Digest;
        originAuthorityFingerprint: Sha256Digest;
    };
    destination: {
        scope: AssetScope;
        projectId: string;
        scopePath: string;
    };
    displayName: string;
    displayDescription: string;
    userActionEvidenceId: string;
}

export interface CopyAssetVersionToLocationResultV1 {
    source: VersionRef;
    asset: AssetManifestV1;
    version: AssetVersionManifestV2;
}

export interface AssetApiWrite {
    createAsset(input: CreateAssetInput): CoreResult<AssetManifestV1>;
    createVersion(assetId: UuidV4, input: CreateVersionInput): CoreResult<AssetVersionManifestV2>;
    copyAssetVersionToLocation(input: CopyAssetVersionToLocationInputV1): CoreResult<CopyAssetVersionToLocationResultV1>;
    updateAssetDisplay(assetId: UuidV4, input: UpdateAssetDisplayInput): CoreResult<AssetManifestV1>;
    setCurrentVersion(ref: VersionRef): CoreResult<AssetManifestV1>;
    softDeleteAsset(assetId: UuidV4): CoreResult<AssetManifestV1>;
    restoreAsset(assetId: UuidV4): CoreResult<AssetManifestV1>;
    inspectAssetPurge(assetId: UuidV4): CoreResult<AssetPurgePreparationV1>;
    purgeAsset(input: CommitAssetPurgeInputV1): CoreResult<AssetPurgeResultV1>;
}

export type AdapterEnablementSettingV1 =
    | {
          configVersion: 1;
          settingId: "adapter_enablement_v1";
          revision: 0;
          enabledAdapterIds: [];
          updatedAt: 0;
          settingFingerprint: Sha256Digest;
      }
    | {
          configVersion: 1;
          settingId: "adapter_enablement_v1";
          revision: number;
          enabledAdapterIds: AdapterId[];
          userActionEvidenceId: string;
          updatedAt: EpochMillis;
          settingFingerprint: Sha256Digest;
      };

export interface ReplaceAdapterEnablementRequestV1 {
    expectedRevision: number;
    expectedSettingFingerprint: Sha256Digest;
    enabledAdapterIds: AdapterId[];
    userActionId: string;
}

export interface AdapterProviderQueryApi {
    listAdapterProviders(): CoreResult<AdapterProviderSummary[]>;
}

export interface AdapterEnablementApi {
    getAdapterEnablement(): CoreResult<AdapterEnablementSettingV1>;
    replaceAdapterEnablement(input: ReplaceAdapterEnablementRequestV1): CoreResult<AdapterEnablementSettingV1>;
}

export interface WatchedEnvironmentSelectorV1 {
    platform: Platform;
    platformInstanceId: string;
}

export interface WatchedSourceIdentityV1 {
    adapterId: AdapterId;
    rootRole: RootRole;
    sourceDomain: SourceDomain;
    canonicalPath: string;
    locatorIdentities: {
        locatorKind: RootLocatorKind;
        locatorKey: string;
    }[];
}

export type WatchedSourceSelectorV1 =
    | {
          disposition: "excluded";
          source: WatchedSourceIdentityV1;
          agentRuntimeIds: AgentRuntimeId[];
          selectorFingerprint: Sha256Digest;
      }
    | {
          disposition: "included";
          source: WatchedSourceIdentityV1;
          agentRuntimeIds: AgentRuntimeId[];
          binding: { assetScope: "global" } | { assetScope: "project"; projectId: UuidV4 };
          selectorFingerprint: Sha256Digest;
      };

export interface WatchedEnvironmentIntentV1 {
    environment: WatchedEnvironmentSelectorV1;
    sourceSelectors: WatchedSourceSelectorV1[];
}

export type WatchedScanIntentV1 =
    | {
          configVersion: 1;
          settingId: "watched_scan_intent_v1";
          revision: 0;
          environments: [];
          updatedAt: 0;
          settingFingerprint: Sha256Digest;
      }
    | {
          configVersion: 1;
          settingId: "watched_scan_intent_v1";
          revision: number;
          environments: WatchedEnvironmentIntentV1[];
          userActionEvidenceId: string;
          updatedAt: EpochMillis;
          settingFingerprint: Sha256Digest;
      };

export interface WatchedProbeSourceRefV1 {
    adapterId: AdapterId;
    platformContext: PlatformContext;
    sourceRootId: string;
}

export type WatchedScanSourceDecisionV1 =
    | {
          action: "retain_existing";
          selectorFingerprint: Sha256Digest;
      }
    | {
          action: "include_observed";
          sourceRef: WatchedProbeSourceRefV1;
          agentRuntimeIds: AgentRuntimeId[];
          binding: { assetScope: "global" } | { assetScope: "project"; projectId: UuidV4 };
      }
    | {
          action: "exclude_observed";
          sourceRef: WatchedProbeSourceRefV1;
          agentRuntimeIds: AgentRuntimeId[];
      }
    | {
          action: "include_user_selected_root";
          environment: WatchedEnvironmentSelectorV1;
          adapterId: AdapterId;
          agentRuntimeIds: AgentRuntimeId[];
          directoryRootPath: string;
          binding: { assetScope: "global" } | { assetScope: "project"; projectId: UuidV4 };
      };

export interface ReplaceWatchedScanIntentRequestV1 {
    expectedRevision: number;
    expectedSettingFingerprint: Sha256Digest;
    userActionId: string;
    currentProbeResults: ProbeResult[];
    decisions: WatchedScanSourceDecisionV1[];
}

export interface ResetWatchedScanIntentRequestV1 {
    expectedRevision: number;
    expectedSettingFingerprint: Sha256Digest;
    userActionId: string;
}

export interface WatchedScanIntentApi {
    getWatchedScanIntent(): CoreResult<WatchedScanIntentV1>;
    replaceWatchedScanIntent(input: ReplaceWatchedScanIntentRequestV1): CoreResult<WatchedScanIntentV1>;
    resetWatchedScanIntent(input: ResetWatchedScanIntentRequestV1): CoreResult<WatchedScanIntentV1>;
}

export interface EnvironmentApi {
    getAvailablePlatformContexts(targetPlatforms: Platform[]): CoreResult<PlatformContext[]>;
    probeAdapters(input: ProbeAdaptersInput, observer?: ProbeAdaptersObserver): Promise<CoreResult<ProbeResult[]>>;
    readAssetsFromAdapter(input: AdapterReadTarget): Promise<CoreResult<AdapterReadResult>>;
}

export interface ImportApi {
    previewImport(readResults: AdapterReadResult[]): CoreResult<ImportPreviewSnapshotV1>;
    acceptImport(input: ImportAcceptRequest): Promise<CoreResult<VersionRef>>;
    acceptImportBatch(input: ImportAcceptBatchRequest): Promise<CoreResult<ImportAcceptBatchResultV1>>;
}

export interface PromotionApi {
    listPromotionGrants(assetId: UuidV4): CoreResult<PromotionGrantV1[]>;
    createPromotionGrant(input: CreatePromotionGrantRequest): CoreResult<PromotionGrantV1>;
    revokePromotionGrant(input: RevokePromotionGrantRequest): CoreResult<PromotionGrantV1>;
    getRestrictedSourcePromotionFullAccess(): CoreResult<RestrictedSourcePromotionFullAccessSettingV1>;
    setRestrictedSourcePromotionFullAccess(
        input: SetRestrictedSourcePromotionFullAccessRequest,
    ): CoreResult<RestrictedSourcePromotionFullAccessSettingV1>;
}

/** Read-only labels from saved metadata; never an authorization input. */
export type PromotionGrantTargetDescriptionV1 =
    | { status: "unavailable" }
    | { status: "available"; targetKind: "project"; displayName: string; rootPath: string }
    | {
          status: "available";
          targetKind: "global_target";
          platform: Platform;
          platformInstanceId: string;
          targetRootPath: string;
          consumerAgentRuntimeIds: AgentRuntimeId[];
      };

export interface PromotionGrantViewV1 extends PromotionGrantV1 {
    targetDescription: PromotionGrantTargetDescriptionV1;
}

export interface PromotionGrantQueryApi {
    listPromotionGrantViews(assetId: UuidV4): CoreResult<PromotionGrantViewV1[]>;
}

export type DeploymentStage = "deleted" | "blocked" | "conflict" | "needs_repair" | "in_sync";
export type ObservationState = "never" | "in_progress" | "complete" | "partial" | "failed";

/** Presentation-level next steps derived by Core. These are hints, not mutation
 * authorization: every write still requires its operation-specific review and
 * action-time guard. */
export type DeploymentActionHintV1 =
    | "review_deployment"
    | "check_now"
    | "review_external_changes"
    | "review_repair"
    | "recover"
    | "contact_support";

export interface DeploymentStatus {
    stage: DeploymentStage;
    reason: string;
    diagnostics: OperationDiagnostic[];
    observationWarnings: OperationDiagnostic[];
    actionHints: DeploymentActionHintV1[];
}

/** Durable explanation for a currently blocked deployment. */
export interface DeploymentBlockingEvidenceV1 {
    schemaVersion: 1;
    reasonCode: string;
    operation: "" | "first_deploy" | "deploy" | "repair" | "recover" | "inspect" | "resolve_conflict";
    contextFingerprint: string;
    occurredAt: EpochMillis;
    diagnostics: OperationDiagnostic[];
    suggestedActions: string[];
    retryable: boolean;
}

export interface AppliedAssetInputSnapshot {
    assetId: UuidV4;
    versionId: UuidV4;
    allowIncomplete: boolean;
}

export interface AppliedInputsSnapshotV1 {
    schemaVersion: 1;
    deploymentId: UuidV4;
    consumerAgentRuntimeIds: AgentRuntimeId[];
    assets: AppliedAssetInputSnapshot[];
}

export interface DeploymentAssetView {
    assetId: UuidV4;
    versionId: UuidV4;
    allowIncomplete: boolean;
}

export type ObservedFileState = "present" | "missing";

export type DeploymentFileView = {
    relativePath: PosixRelativePath;
    baselineState: DeploymentFileBaselineStateV1;
} & (
    | {
          observedState: "present";
          observedContentHash: Sha256Digest;
          observedExecutable: boolean;
          observedAt: EpochMillis;
      }
    | { observedState: "missing"; observedAt: EpochMillis }
);

export interface DeploymentView {
    deploymentId: UuidV4;
    projectId: string;
    consumerAgentRuntimeIds: AgentRuntimeId[];
    platform: Platform;
    platformInstanceId: string;
    targetRootPath: string;
    appliedInputsSnapshot: AppliedInputsSnapshotV1;
    observationState: ObservationState;
    /** Terminal time of the most recent target-observation attempt; 0 means never. */
    observationAttemptedAt: EpochMillis;
    /** Terminal time of the most recent complete target observation; 0 means never. */
    lastCompleteObservationAt: EpochMillis;
    blockingEvidence: DeploymentBlockingEvidenceV1;
    deleted: boolean;
    createdAt: EpochMillis;
    updatedAt: EpochMillis;
    derivedStatus: DeploymentStatus;
    assets: DeploymentAssetView[];
    files: DeploymentFileView[];
}

export interface CreateDeploymentInput {
    projectId: string;
    consumerAgentRuntimeIds: AgentRuntimeId[];
    platform: Platform;
    platformInstanceId: string;
    targetRootPath: string;
    assets: DeploymentAssetInput[];
}

export interface DeploymentAssetInput {
    assetId: UuidV4;
    versionId: UuidV4;
    allowIncomplete: boolean;
}

export interface UpdateDeploymentInputs {
    consumerAgentRuntimeIds?: AgentRuntimeId[];
    assets?: DeploymentAssetInput[];
    expectedInputs?: {
        consumerAgentRuntimeIds: AgentRuntimeId[];
        assets: DeploymentAssetInput[];
    };
}

export interface RepairDeploymentInput {
    deploymentId: UuidV4;
    expectedInspectionResultFingerprint: Sha256Digest;
    userActionId: string;
}

export interface DeploymentApi {
    createDeployment(input: CreateDeploymentInput): CoreResult<DeploymentView>;
    getDeployment(deploymentId: UuidV4): CoreResult<LookupResult<DeploymentView>>;
    listDeployments(filter?: DeploymentFilter): CoreResult<DeploymentView[]>;
    updateDeploymentInputs(deploymentId: UuidV4, input: UpdateDeploymentInputs): CoreResult<DeploymentView>;
    softDeleteDeployment(deploymentId: UuidV4): CoreResult<DeploymentView>;
    analyzeDeploymentRender(deploymentId: UuidV4): Promise<CoreResult<DeploymentRenderAnalysisView>>;
    previewDeploymentRender(input: PreviewDeploymentRenderInput): Promise<CoreResult<DeploymentRenderPreviewView>>;
    deployDeployment(input: DeployWithRenderSelectionInput): Promise<CoreResult<DeploymentView>>;
    scanDeployment(deploymentId: UuidV4): Promise<CoreResult<DeploymentView>>;
    inspectDeploymentRenderedTarget(deploymentId: UuidV4): Promise<CoreResult<RenderedTargetInspectionResult>>;
    prepareRenderedTargetAccept(
        input: PrepareRenderedTargetAcceptInput,
    ): Promise<CoreResult<RenderedTargetAcceptPreparationView>>;
    commitRenderedTargetAccept(input: CommitRenderedTargetAcceptInput): Promise<CoreResult<RenderedTargetAcceptCommitView>>;
    cancelRenderedTargetAccept(input: CancelRenderedTargetAcceptInput): Promise<CoreResult<void>>;
    repairDeployment(input: RepairDeploymentInput): Promise<CoreResult<DeploymentView>>;
    recoverDeployment(deploymentId: UuidV4): Promise<CoreResult<DeploymentView>>;
}

export type AssetUsageCapability = "direct" | "transformed" | "substitute" | "unavailable";
export type AssetUsageObservedTargetState = "already_usable" | "absent" | "different" | "unknown";
export type AssetUsageManagedState = "none" | "configured" | "applied";

export interface AssetUsageRelationshipView {
    agentRuntimeId: AgentRuntimeId;
    capability: AssetUsageCapability;
    observedTargetState: AssetUsageObservedTargetState;
    managedState: AssetUsageManagedState;
    substitute: { assetKind: AssetKind } | null;
    deploymentIds: UuidV4[];
    appliedDeploymentIds: UuidV4[];
    degradationKinds: RenderDegradationKind[];
    reasonCodes: string[];
    /** Diagnostics from this exact consumer's analysis and target observation. */
    diagnostics: OperationDiagnostic[];
    requiresReview: boolean;
}

export interface AssetUsageProjectionView {
    schemaVersion: 2;
    assetId: UuidV4;
    versionId: UuidV4;
    relationships: AssetUsageRelationshipView[];
}

export interface AnalyzeAssetUsageInput {
    projectId: string; // "" for global
    consumerAgentRuntimeIds: AgentRuntimeId[];
    platform: Platform;
    platformInstanceId: string;
    targetRootPath: string;
    asset: DeploymentAssetInput;
    /** Validated immutable probe input captured by the same read-only Host operation. */
    currentProbeResults: ProbeResult[];
}

/** Read-only exact-target projection. It never creates a Deployment or grants runtime-write authority. */
export interface AssetUsageApi {
    analyzeAssetUsage(input: AnalyzeAssetUsageInput): Promise<CoreResult<AssetUsageProjectionView>>;
}

export interface DeploymentFilter {
    projectId?: string;
    includeDeleted?: boolean;
    stage?: DeploymentStage;
}

export interface QueryAssetsInput {
    keywords: string;
    filter?: AssetListFilter;
    limit?: number;
    offset?: number;
}
export interface QueryAssetsResult {
    items: CurrentAssetSummary[];
    totalCount: number;
}
export interface ReindexInput {
    assetIds?: UuidV4[];
    includeDeleted?: boolean;
}
export interface ReindexReport {
    scannedAssets: number;
    indexedAssets: number;
    skippedAssets: number;
    diagnostics: OperationDiagnostic[];
}
export interface IndexApi {
    queryAssets(input: QueryAssetsInput): CoreResult<QueryAssetsResult>;
    reindexAssets(input?: ReindexInput): CoreResult<ReindexReport>;
}

export interface SettingValue {
    configVersion: number;
    [key: string]: unknown;
}
export interface SettingsApi {
    getSetting<T extends SettingValue>(key: string): CoreResult<LookupResult<T>>;
    setSetting<T extends SettingValue>(key: string, value: T): CoreResult<void>;
    unsetSetting(key: string): CoreResult<void>;
    listSettings(): CoreResult<Record<string, SettingValue>>;
}

export interface StateBackupApi {
    listStateBackups(observer?: StateBackupExecutionObserver): CoreResult<StateBackupInventoryV1>;
    inspectStateBackup(
        input: InspectStateBackupInputV1,
        observer?: StateBackupExecutionObserver,
    ): CoreResult<StateBackupPreparationV1>;
    createStateBackup(
        input: CreateStateBackupInputV1,
        observer?: StateBackupExecutionObserver,
    ): Promise<CoreResult<StateBackupArtifactV1>>;
    recycleStateBackup(input: RetireStateBackupInputV1): CoreResult<StateBackupRetirementV1>;
    retireMissingStateBackup(input: RetireStateBackupInputV1): CoreResult<StateBackupRetirementV1>;
    getStateBackupPromptPolicy(): CoreResult<StateBackupPromptPolicyV1>;
    replaceStateBackupPromptPolicy(input: ReplaceStateBackupPromptPolicyInputV1): CoreResult<StateBackupPromptPolicyV1>;
}

export interface CoreService
    extends ProjectApi,
        ProjectLifecycleApi,
        AssetApiRead,
        AssetLibraryApi,
        AssetApiWrite,
        AdapterProviderQueryApi,
        AdapterEnablementApi,
        WatchedScanIntentApi,
        EnvironmentApi,
        ImportApi,
        PromotionApi,
        PromotionGrantQueryApi,
        AssetUsageApi,
        DeploymentApi,
        CatalogSearchApi,
        IndexApi,
        SettingsApi,
        StateBackupApi {}
