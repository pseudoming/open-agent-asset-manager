/**
 * Compile-time exact-union guards.
 *
 * These consts assert that each stable union is EXACTLY equal to an approved
 * literal set — not just that known bad literals are rejected. If a future edit
 * silently adds or removes a member (e.g. needs_recovery leaks into
 * DeploymentStage, or a 7th AssetKind appears, or ObservationState gains a 6th
 * value), the corresponding `IsExact<...> = true` assignment fails to compile
 * under the core typecheck (which covers all of src via tsconfig).
 *
 * Coverage: this file is in coverage.exclude — it contains only compile-time
 * boolean consts (`= true`), no testable runtime behavior.
 *
 * The runtime values (`true`) are re-asserted by tests/test_types.test.ts via
 * import, as a second layer.
 */

/** Resolves to `true` iff T and U are mutually assignable (set-equal unions). */
type IsExact<T, U> =
    (<G>() => G extends T ? 1 : 2) extends <G>() => G extends U ? 1 : 2
        ? (<G>() => G extends U ? 1 : 2) extends <G>() => G extends T ? 1 : 2
            ? true
            : never
        : never;

import type { DurableMutationState, SafeFilesystemFailureKind } from "@oaam/shared/filesystem";
import type { AssetVersionManifestV2, FileReferenceV2 } from "./contracts/asset-version";
import type {
    AssetKindTypeDataV2,
    GuidanceTypeDataV1,
    MemoryTypeDataV2,
    RuleTypeDataV2,
    SkillTypeDataV2,
    SubagentTypeDataV2,
    WorkflowTypeDataV2,
} from "./contracts/specs";
import type { CoreServiceConfiguration } from "./orchestration/core-service";
import type { StateRestoreStartupConfiguration } from "./orchestration/state-restore-reconciliation";
import type { StateRestoreServiceConfiguration } from "./orchestration/state-restore-service";
import type { ReverseAcceptPreparationMarkerV1 } from "./reverse/reverse-accept-marker";
import type {
    AdapterEnablementApi,
    AdapterEnablementSettingV1,
    AdapterProvider,
    AdapterRetainedInspectionBindingV1,
    AdapterProviderQueryApi,
    AdapterProviderSummary,
    AgentRuntimeDescriptor,
    AgentRuntimeEntryClass,
    AppliedAssetInputSnapshot,
    AssetApiRead,
    AssetLibraryApi,
    AssetApiWrite,
    AssetKind,
    AssetVersionBundle,
    CatalogSearchApi,
    CancelRenderedTargetAcceptInput,
    CommitRenderedTargetAcceptInput,
    CoreService,
    CreateAssetInput,
    CreateVersionInput,
    DeploymentApi,
    DeploymentStage,
    EnvironmentApi,
    ImportApi,
    IndexApi,
    ObservationState,
    ObservedFileState,
    OperationDiagnostic,
    OperationStatus,
    PrepareRenderedTargetAcceptInput,
    ProjectApi,
    ProjectLifecycleApi,
    PromotionApi,
    ReplaceAdapterEnablementRequestV1,
    SettingsApi,
    StateBackupApi,
    VersionFileInput,
    WatchedScanIntentApi,
    WatchedScanIntentV1,
    WatchedScanSourceDecisionV1,
} from "./types";

// AssetKind must be exactly the 6 approved literals (AgentRule retired).
export const _exactAssetKind: IsExact<AssetKind, "Guidance" | "Rule" | "Workflow" | "Skill" | "Subagent" | "Memory"> = true;

export const _exactAssetKindTypeDataV2Kinds: IsExact<AssetKindTypeDataV2["kind"], AssetKind> = true;

export const _exactGuidanceTypeDataPairV2: IsExact<
    Extract<AssetKindTypeDataV2, { kind: "Guidance" }>["typeData"],
    GuidanceTypeDataV1
> = true;
export const _exactRuleTypeDataPairV2: IsExact<Extract<AssetKindTypeDataV2, { kind: "Rule" }>["typeData"], RuleTypeDataV2> = true;
export const _exactWorkflowTypeDataPairV2: IsExact<
    Extract<AssetKindTypeDataV2, { kind: "Workflow" }>["typeData"],
    WorkflowTypeDataV2
> = true;
export const _exactSkillTypeDataPairV2: IsExact<Extract<AssetKindTypeDataV2, { kind: "Skill" }>["typeData"], SkillTypeDataV2> =
    true;
export const _exactSubagentTypeDataPairV2: IsExact<
    Extract<AssetKindTypeDataV2, { kind: "Subagent" }>["typeData"],
    SubagentTypeDataV2
> = true;
export const _exactMemoryTypeDataPairV2: IsExact<Extract<AssetKindTypeDataV2, { kind: "Memory" }>["typeData"], MemoryTypeDataV2> =
    true;

export const _exactSafeFilesystemFailureKind: IsExact<
    SafeFilesystemFailureKind,
    | "invalid_path"
    | "not_found"
    | "permission_denied"
    | "symlink_or_reparse"
    | "wrong_entry_type"
    | "resource_limit"
    | "stale"
    | "unsupported_platform"
    | "io_error"
> = true;

export const _exactDurableMutationState: IsExact<DurableMutationState, "not_applied" | "may_have_applied"> = true;

export const _assetVersionBundleUsesV2: IsExact<AssetVersionBundle["manifest"], AssetVersionManifestV2> = true;

export const _versionFileInputUsesV2References: IsExact<NonNullable<VersionFileInput["references"]>[number], FileReferenceV2> =
    true;

export const _createAssetDiscriminatesGuidanceTypeData: IsExact<
    Extract<CreateAssetInput, { kind: "Guidance" }>["initialVersion"]["typeData"],
    GuidanceTypeDataV1
> = true;

export const _laterVersionChangeKindExcludesCreate: IsExact<
    CreateVersionInput["changeKind"],
    "extract" | "edit" | "sync" | "rollback" | "merge"
> = true;

export const _exactAppliedAssetInputSnapshotKeys: IsExact<
    keyof AppliedAssetInputSnapshot,
    "assetId" | "versionId" | "allowIncomplete"
> = true;

// DeploymentStage must be exactly the 5 approved stable stages.
// needs_recovery / unknown / pending_deploy / not_initialized must NOT appear
// (CORE_DATA_MODEL §8.10 + CORE_API §7.1 + implement_steps_plan.md Step 7).
export const _exactDeploymentStage: IsExact<DeploymentStage, "deleted" | "blocked" | "conflict" | "needs_repair" | "in_sync"> =
    true;

// ObservationState must be exactly the 5 approved values.
export const _exactObservationState: IsExact<ObservationState, "never" | "in_progress" | "complete" | "partial" | "failed"> =
    true;

// OperationStatus must be exactly the 3 approved values.
export const _exactOperationStatus: IsExact<OperationStatus, "complete" | "partial" | "failed"> = true;

export const _exactAgentRuntimeEntryClass: IsExact<AgentRuntimeEntryClass, "cli" | "app" | "ide"> = true;

export const _exactObservedFileState: IsExact<ObservedFileState, "present" | "missing"> = true;

export const _exactReverseAcceptPreparationMarkerV1States: IsExact<
    ReverseAcceptPreparationMarkerV1["preparationState"],
    "prepared" | "cancelled" | "expired" | "claimed" | "consumed" | "failed" | "recovery_required" | "retired"
> = true;

export const _exactCoreServiceConfigurationKeys: IsExact<
    keyof CoreServiceConfiguration,
    | "providers"
    | "platformContexts"
    | "oaamRoot"
    | "databasePath"
    | "confirmOneTimeRenderApproval"
    | "selectedWslProbeExecution"
    | "selectedWslTargetExecution"
    | "selectedWslSourceExecution"
> = true;

export const _exactStateRestoreServiceConfigurationKeys: IsExact<
    keyof StateRestoreServiceConfiguration,
    "oaamRoot" | "databasePath" | "quiesceMutations"
> = true;

export const _exactStateRestoreStartupConfigurationKeys: IsExact<
    keyof StateRestoreStartupConfiguration,
    "oaamRoot" | "databasePath"
> = true;

export const _exactReplaceAdapterEnablementRequestV1Keys: IsExact<
    keyof ReplaceAdapterEnablementRequestV1,
    "expectedRevision" | "expectedSettingFingerprint" | "enabledAdapterIds" | "userActionId"
> = true;

export const _exactAdapterEnablementSettingV1Discriminant: IsExact<
    AdapterEnablementSettingV1["settingId"],
    "adapter_enablement_v1"
> = true;

export const _exactWatchedScanIntentV1Discriminant: IsExact<WatchedScanIntentV1["settingId"], "watched_scan_intent_v1"> = true;

export const _exactWatchedScanDecisionActions: IsExact<
    WatchedScanSourceDecisionV1["action"],
    "retain_existing" | "include_observed" | "exclude_observed" | "include_user_selected_root"
> = true;

export const _exactPrepareRenderedTargetAcceptInputKeys: IsExact<
    keyof PrepareRenderedTargetAcceptInput,
    "deploymentId" | "inspectionResultFingerprint"
> = true;

export const _exactCommitRenderedTargetAcceptInputKeys: IsExact<
    keyof CommitRenderedTargetAcceptInput,
    "preparationId" | "expectedPreparationRevision" | "userActionId" | "newVersionPromotion" | "renderSelectionRequest"
> = true;

export const _exactCancelRenderedTargetAcceptInputKeys: IsExact<
    keyof CancelRenderedTargetAcceptInput,
    "preparationId" | "expectedPreparationRevision"
> = true;

export const _exactDeploymentApiKeys: IsExact<
    keyof DeploymentApi,
    | "createDeployment"
    | "getDeployment"
    | "listDeployments"
    | "updateDeploymentInputs"
    | "softDeleteDeployment"
    | "analyzeDeploymentRender"
    | "previewDeploymentRender"
    | "deployDeployment"
    | "scanDeployment"
    | "inspectDeploymentRenderedTarget"
    | "prepareRenderedTargetAccept"
    | "commitRenderedTargetAccept"
    | "cancelRenderedTargetAccept"
    | "repairDeployment"
    | "recoverDeployment"
> = true;

export const _exactAgentRuntimeDescriptorKeys: IsExact<
    keyof AgentRuntimeDescriptor,
    "agentRuntimeId" | "displayName" | "entryClass"
> = true;

export const _exactRetainedInspectionBindingKeys: IsExact<
    keyof AdapterRetainedInspectionBindingV1,
    | "schemaVersion"
    | "rendererVersion"
    | "agentRuntimes"
    | "targetContextSchemas"
    | "assetTargetCapabilities"
    | "materializerCapabilities"
    | "renderContractDeclarations"
    | "canonicalMaterializationValidators"
    | "inspectRenderedTarget"
> = true;

export const _exactAdapterProviderKeys: IsExact<
    keyof AdapterProvider,
    | "adapterId"
    | "displayName"
    | "version"
    | "agentRuntimes"
    | "canonicalMaterializationValidators"
    | "retainedInspectionBindings"
    | "targetContextSchemas"
    | "assetSourceCapabilities"
    | "assetTargetCapabilities"
    | "materializerCapabilities"
    | "renderContractDeclarations"
    | "dialectContracts"
    | "probe"
    | "read"
    | "analyzeRender"
    | "materializeRender"
    | "inspectRenderedTarget"
> = true;

export const _exactAdapterProviderSummaryKeys: IsExact<
    keyof AdapterProviderSummary,
    | "adapterId"
    | "displayName"
    | "version"
    | "enabled"
    | "agentRuntimes"
    | "targetContextSchemas"
    | "assetSourceCapabilities"
    | "assetTargetCapabilities"
    | "materializerCapabilities"
    | "renderContractDeclarations"
> = true;

export const _exactOperationDiagnosticOperations: IsExact<
    OperationDiagnostic["operation"],
    | "project"
    | "asset"
    | "version"
    | "probe"
    | "read"
    | "render"
    | "reverse_accept"
    | "deploy"
    | "scan"
    | "search"
    | "reindex"
    | "settings"
    | "backup"
    | "restore"
    | "internal"
> = true;

// CoreService must extend every public API group. If a group is removed or renamed,
// this assignment fails to compile under the core typecheck (which covers
// all of src via tsconfig). Previously this check lived only in tests/ which
// is excluded from core typecheck — now it lives here and is re-asserted by
// tests/test_types.test.ts via import (audit sweep fix).
export const _coreServiceExtendsAllGroups: CoreService extends ProjectApi &
    ProjectLifecycleApi &
    AssetApiRead &
    AssetLibraryApi &
    AssetApiWrite &
    AdapterProviderQueryApi &
    AdapterEnablementApi &
    WatchedScanIntentApi &
    EnvironmentApi &
    ImportApi &
    PromotionApi &
    DeploymentApi &
    CatalogSearchApi &
    IndexApi &
    SettingsApi &
    StateBackupApi
    ? true
    : never = true;
