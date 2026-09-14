import {
    protocolAssetKindCountsParamsSchema,
    protocolAssetKindCountsResultSchema,
    protocolAssetSummaryPageParamsSchema,
    protocolAssetSummaryPageSchema,
    protocolAssetVersionCompareParamsSchema,
    protocolAssetVersionComparisonSchema,
    protocolAssetVersionExportParamsSchema,
    protocolAssetVersionExportResultSchema,
    protocolAssetVersionFileChildrenParamsSchema,
    protocolAssetVersionFilePreviewParamsSchema,
    protocolAssetVersionFilePreviewSchema,
    protocolAssetVersionFileTreePageSchema,
    protocolAssetVersionNativeExportResultSchema,
    protocolAssetVersionPageParamsSchema,
    protocolAssetVersionPageSchema,
    protocolAssetVersionTextPageParamsSchema,
    protocolAssetVersionTextPageSchema,
} from "./asset-library-models";
import {
    protocolAssetCopyParamsSchema,
    protocolAssetCopyResultSchema,
    protocolAssetDisplayUpdateParamsSchema,
    protocolAssetIdentityParamsSchema,
    protocolAssetPurgeCommitParamsSchema,
    protocolAssetPurgePreparationSchema,
    protocolAssetPurgeResultSchema,
} from "./asset-lifecycle-models";
import { protocolAssetUsageAnalyzeParamsSchema, protocolAssetUsageProjectionSchema } from "./asset-usage-models";
import { adapterProbeParamsSchema, adapterProbeProgressSchema } from "./adapter-probe-models";
import { protocolCatalogSearchParamsSchema, protocolCatalogSearchResultSchema } from "./catalog-search-models";
import { DIAGNOSTICS_ACCEPTED_LONG_DEFINITIONS, DIAGNOSTICS_OPERATION_DEFINITIONS } from "./diagnostics-operations";
import { deploymentUpdateParamsSchema } from "./deployment-input-models";
import { protocolAcceptedLongAcknowledgementSchema, protocolProgressProjectionSchema } from "./long-operation-models";
import {
    protocolAdapterEnablementSchema,
    protocolAdapterProviderProjectionSchema,
    protocolAssetKindSchema,
    protocolAssetProjectionSchema,
    protocolAssetSummarySchema,
    protocolAssetVersionProjectionSchema,
    protocolBatchImportResultSchema,
    protocolCallableBindingSubjectSchema,
    protocolDeploymentAssetSchema,
    protocolDeploymentProjectionSchema,
    protocolDeploymentRenderPreviewSchema,
    protocolDeploymentSubjectSchema,
    protocolEmptyObjectSchema,
    protocolEnvironmentProjectionSchema,
    protocolImportPreviewDetailSchema,
    protocolImportPreviewProjectionSchema,
    protocolLookup,
    protocolOperationOutcome,
    protocolOperationOutcomeWithFailedValue,
    protocolProbeReviewProjectionSchema,
    protocolProbeEnvironmentReferenceListSchema,
    protocolProjectProjectionSchema,
    protocolPromotionGrantSchema,
    protocolPromotionGrantViewSchema,
    protocolPromotionTargetSchema,
    protocolReadReviewProjectionSchema,
    protocolReindexResultSchema,
    protocolRenderAnalysisSchema,
    protocolRenderedInspectionDetailSchema,
    protocolRenderedInspectionSummarySchema,
    protocolRestrictedSourceFullAccessSchema,
    protocolReverseCommitSchema,
    protocolReversePreparationSchema,
    protocolWatchedScanIntentSchema,
    protocolWatchedSourceBindingSchema,
} from "./models";
import {
    control,
    acceptedLong as defineAcceptedLong,
    acceptedLongWithProgress as defineAcceptedLongWithProgress,
    immediate,
    type ProtocolOperationDefinition,
} from "./operation-definition";
import {
    PROTOCOL_ACCEPTED_LONG_NAMES,
    PROTOCOL_CONTROL_NAMES,
    PROTOCOL_IMMEDIATE_MUTATION_NAMES,
    PROTOCOL_IMMEDIATE_QUERY_NAMES,
    PROTOCOL_OPERATION_NAMES,
    type ProtocolAcceptedLongOperationName,
    type ProtocolDeliveryClass,
    type ProtocolOperationName,
    protocolAcceptedLongOperationNameSchema,
    protocolOperationNameSchema,
} from "./operation-names";
import {
    PROTOCOL_VERSION,
    protocolClientKindSchema,
    protocolEnvironmentSelectorSchema,
    protocolPlatformSchema,
    protocolSha256Schema,
    protocolUuidV4Schema,
} from "./primitives";
import {
    protocolProjectLifecycleCommitParamsSchema,
    protocolProjectLifecycleInspectParamsSchema,
    protocolProjectLifecycleReviewSchema,
} from "./project-lifecycle-models";
import {
    protocolStateBackupArtifactSchema,
    protocolStateBackupDestinationSchema,
    protocolStateBackupEncryptionModeSchema,
    protocolStateBackupInventorySchema,
    protocolStateBackupProgressSchema,
    protocolStateBackupPromptPolicySchema,
    protocolStateBackupReviewSchema,
    protocolStateRestoreActivationSchema,
    protocolStateRestoreProgressSchema,
    protocolStateRestoreReviewSchema,
    protocolStateRestoreSourceSchema,
} from "./state-resilience-models";
import {
    type InferProtocolSchema,
    optionalProtocolField,
    type ProtocolSchema,
    protocolArray,
    protocolBoolean,
    protocolEmptyArraySchema,
    protocolEnum,
    protocolJsonValue,
    protocolLiteral,
    protocolNonBlankString,
    protocolNonEmptyArray,
    protocolNonNegativeInteger,
    protocolObject,
    protocolPositiveInteger,
    protocolUnion,
} from "./validation";

const initializeParamsSchema = protocolObject(
    {
        protocolVersion: protocolLiteral(PROTOCOL_VERSION),
        clientKind: protocolClientKindSchema,
        clientVersion: protocolNonBlankString,
    },
    "initialize params",
);
const initializeResultSchema = protocolObject(
    {
        protocolVersion: protocolLiteral(PROTOCOL_VERSION),
        hostInstanceId: protocolNonBlankString,
        availableOperations: protocolArray(protocolOperationNameSchema),
    },
    "initialize result",
);

const observeParamsSchema = protocolObject(
    { operationId: protocolNonBlankString, afterSequence: protocolNonNegativeInteger },
    "operation observe params",
);
const protocolOperationEventSchemaProxy: ProtocolSchema<unknown> = Object.freeze({
    description: "operation event",
    parse(value: unknown, path?: string): unknown {
        return protocolOperationEventSchema.parse(value, path);
    },
});
const observeResultSchema = protocolUnion(
    [
        protocolObject(
            {
                status: protocolLiteral("available"),
                events: protocolArray(protocolOperationEventSchemaProxy),
            },
            "available operation observation",
        ),
        protocolObject(
            { status: protocolLiteral("operation_unavailable"), events: protocolEmptyArraySchema },
            "unavailable operation observation",
        ),
    ],
    "operation observation",
);
const cancelResultSchema = protocolObject(
    { status: protocolEnum(["requested", "not_cancellable", "operation_unavailable"] as const) },
    "operation cancellation result",
);

const environmentListParamsSchema = protocolObject(
    { platforms: protocolArray(protocolPlatformSchema) },
    "environment list params",
);
const providerListResultSchema = protocolObject(
    { providers: protocolArray(protocolAdapterProviderProjectionSchema) },
    "provider list result",
);
const environmentListResultSchema = protocolObject(
    { environments: protocolArray(protocolEnvironmentProjectionSchema) },
    "environment list result",
);
const probeEnvironmentReferenceListParamsSchema = protocolObject(
    { probeToken: protocolNonBlankString },
    "probe environment reference list params",
);
const projectListParamsSchema = protocolObject({ includeDeleted: optionalProtocolField(protocolBoolean) }, "project list params");
const projectGetParamsSchema = protocolObject({ projectId: protocolUuidV4Schema }, "project get params");
const projectRegisterParamsSchema = protocolObject(
    {
        localPathSelectionToken: protocolNonBlankString,
        displayName: optionalProtocolField(protocolNonBlankString),
    },
    "project register params",
);

const assetFilterFields = {
    kind: optionalProtocolField(protocolEnum(["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"] as const)),
    scope: optionalProtocolField(protocolEnum(["global", "project"] as const)),
    projectId: optionalProtocolField(protocolUuidV4Schema),
    includeDeleted: optionalProtocolField(protocolBoolean),
} as const;
const assetListParamsSchema = protocolObject(assetFilterFields, "asset list params");
const assetGetParamsSchema = protocolObject({ assetId: protocolUuidV4Schema }, "asset get params");
const assetVersionGetParamsSchema = protocolObject(
    { assetId: protocolUuidV4Schema, versionId: protocolUuidV4Schema },
    "asset version get params",
);

const deploymentListParamsSchema = protocolObject(
    {
        subject: optionalProtocolField(protocolDeploymentSubjectSchema),
        includeDeleted: optionalProtocolField(protocolBoolean),
        stage: optionalProtocolField(protocolEnum(["deleted", "blocked", "conflict", "needs_repair", "in_sync"] as const)),
    },
    "deployment list params",
);
const deploymentGetParamsSchema = protocolObject({ deploymentId: protocolUuidV4Schema }, "deployment get params");
const deploymentCreateParamsSchema = protocolObject(
    {
        probeToken: protocolNonBlankString,
        probeResultRowId: protocolNonBlankString,
        targetRowId: protocolNonBlankString,
        subject: protocolDeploymentSubjectSchema,
        consumerAgentRuntimeIds: protocolNonEmptyArray(protocolNonBlankString),
        assets: protocolNonEmptyArray(protocolDeploymentAssetSchema),
    },
    "deployment create params",
);
const promotionGrantListParamsSchema = protocolObject({ assetId: protocolUuidV4Schema }, "promotion grant list params");
const promotionGrantCreateParamsSchema = protocolUnion(
    [
        protocolObject(
            {
                promotionAction: protocolLiteral("grant_current_version_current_target"),
                assetId: protocolUuidV4Schema,
                versionId: protocolUuidV4Schema,
                target: protocolPromotionTargetSchema,
                userActionId: protocolNonBlankString,
            },
            "current-version promotion grant",
        ),
        protocolObject(
            {
                promotionAction: protocolLiteral("grant_asset_all_versions_current_target"),
                assetId: protocolUuidV4Schema,
                target: protocolPromotionTargetSchema,
                userActionId: protocolNonBlankString,
            },
            "all-version promotion grant",
        ),
    ],
    "promotion grant create params",
);
const promotionGrantRevokeParamsSchema = protocolObject(
    {
        promotionGrantId: protocolUuidV4Schema,
        expectedRevision: protocolPositiveInteger,
        expectedGrantFingerprint: protocolSha256Schema,
        userActionId: protocolNonBlankString,
    },
    "promotion grant revoke params",
);
const fullAccessSetParamsSchema = protocolObject(
    {
        expectedRevision: protocolNonNegativeInteger,
        expectedSettingFingerprint: protocolSha256Schema,
        nextState: protocolEnum(["enabled", "disabled"] as const),
        userActionId: protocolNonBlankString,
    },
    "restricted-source full access set params",
);

const adapterEnablementReplaceParamsSchema = protocolObject(
    {
        expectedRevision: protocolNonNegativeInteger,
        expectedSettingFingerprint: protocolSha256Schema,
        enabledAdapterIds: protocolArray(protocolNonBlankString),
        userActionId: protocolNonBlankString,
    },
    "adapter enablement replace params",
);
const watchedScanDecisionSchema = protocolUnion(
    [
        protocolObject(
            {
                action: protocolLiteral("retain_existing"),
                selectorFingerprint: protocolSha256Schema,
            },
            "retain existing watched source decision",
        ),
        protocolObject(
            {
                action: protocolLiteral("include_observed"),
                probeToken: protocolNonBlankString,
                probeResultRowId: protocolNonBlankString,
                sourceRootRowId: protocolNonBlankString,
                agentRuntimeIds: protocolNonEmptyArray(protocolNonBlankString),
                binding: protocolWatchedSourceBindingSchema,
            },
            "include observed watched source decision",
        ),
        protocolObject(
            {
                action: protocolLiteral("exclude_observed"),
                probeToken: protocolNonBlankString,
                probeResultRowId: protocolNonBlankString,
                sourceRootRowId: protocolNonBlankString,
                agentRuntimeIds: protocolNonEmptyArray(protocolNonBlankString),
            },
            "exclude observed watched source decision",
        ),
        protocolObject(
            {
                action: protocolLiteral("include_user_selected_root"),
                localPathSelectionToken: protocolNonBlankString,
                environment: protocolEnvironmentSelectorSchema,
                adapterId: protocolNonBlankString,
                agentRuntimeIds: protocolNonEmptyArray(protocolNonBlankString),
                binding: protocolWatchedSourceBindingSchema,
            },
            "include user-selected watched source decision",
        ),
    ],
    "watched scan decision",
);
const watchedScanReplaceParamsSchema = protocolObject(
    {
        expectedRevision: protocolNonNegativeInteger,
        expectedSettingFingerprint: protocolSha256Schema,
        decisions: protocolArray(watchedScanDecisionSchema),
        userActionId: protocolNonBlankString,
    },
    "watched scan intent replace params",
);
const watchedScanResetParamsSchema = protocolObject(
    {
        expectedRevision: protocolNonNegativeInteger,
        expectedSettingFingerprint: protocolSha256Schema,
        userActionId: protocolNonBlankString,
    },
    "watched scan intent reset params",
);

const importPreviewDetailParamsSchema = protocolObject(
    {
        previewToken: protocolNonBlankString,
        candidateId: protocolNonBlankString,
        logicalPath: optionalProtocolField(protocolNonBlankString),
    },
    "import preview detail params",
);
const renderedInspectionDetailParamsSchema = protocolObject(
    { inspectionToken: protocolNonBlankString, selector: protocolNonBlankString },
    "rendered inspection detail params",
);
const importPreviewCancelParamsSchema = protocolObject({ previewToken: protocolNonBlankString }, "import preview cancel params");

const adapterReadParamsSchema = protocolObject(
    {
        probeToken: protocolNonBlankString,
        selections: protocolNonEmptyArray(
            protocolObject(
                {
                    probeResultRowId: protocolNonBlankString,
                    sourceRootRowIds: protocolNonEmptyArray(protocolNonBlankString),
                    allowedKinds: optionalProtocolField(protocolNonEmptyArray(protocolAssetKindSchema)),
                    agentRuntimeIds: optionalProtocolField(protocolNonEmptyArray(protocolNonBlankString)),
                },
                "probe source selection",
            ),
        ),
    },
    "adapter read params",
);
const importPreviewParamsSchema = protocolObject({ readToken: protocolNonBlankString }, "import preview params");

const batchCallableBindingSchema = protocolUnion(
    [
        protocolObject(
            { subject: protocolCallableBindingSubjectSchema, targetAssetVersionId: protocolUuidV4Schema },
            "existing-version callable binding",
        ),
        protocolObject(
            { subject: protocolCallableBindingSubjectSchema, targetCandidateId: protocolNonBlankString },
            "same-batch callable binding",
        ),
    ],
    "batch callable binding",
);
const freshnessSchema = protocolUnion(
    [
        protocolObject({ freshnessAction: protocolLiteral("require_current_source") }, "current-source freshness"),
        protocolObject(
            { freshnessAction: protocolLiteral("accept_preview_snapshot"), userActionId: protocolNonBlankString },
            "accepted-preview freshness",
        ),
    ],
    "import freshness",
);
const promotionDispositionSchema = protocolUnion(
    [
        protocolObject(
            { promotionAction: protocolLiteral("import_only"), userActionId: protocolNonBlankString },
            "import-only promotion",
        ),
        protocolObject(
            {
                promotionAction: protocolLiteral("grant_current_version_current_target"),
                target: protocolPromotionTargetSchema,
                userActionId: protocolNonBlankString,
            },
            "current-version import promotion",
        ),
        protocolObject(
            {
                promotionAction: protocolLiteral("grant_asset_all_versions_current_target"),
                target: protocolPromotionTargetSchema,
                userActionId: protocolNonBlankString,
            },
            "all-version import promotion",
        ),
    ],
    "import promotion disposition",
);
const importBatchDecisionBase = {
    candidateId: protocolNonBlankString,
    freshness: freshnessSchema,
    promotion: promotionDispositionSchema,
    callableBindings: protocolArray(batchCallableBindingSchema),
} as const;
const importBatchDecisionSchema = protocolUnion(
    [
        protocolObject({ ...importBatchDecisionBase, action: protocolLiteral("create_asset") }, "create-asset decision"),
        protocolObject(
            {
                ...importBatchDecisionBase,
                action: protocolLiteral("create_version"),
                assetId: protocolUuidV4Schema,
                parentVersionId: protocolUuidV4Schema,
            },
            "create-version decision",
        ),
    ],
    "batch import decision",
);
const importAcceptBatchParamsSchema = protocolObject(
    {
        previewToken: protocolNonBlankString,
        expectedSnapshotFingerprint: protocolSha256Schema,
        decisions: protocolNonEmptyArray(importBatchDecisionSchema),
    },
    "batch import accept params",
);

const deploymentIdParamsSchema = protocolObject({ deploymentId: protocolUuidV4Schema }, "deployment id params");
const requestedSemanticOptionSchema = protocolObject(
    {
        optionFingerprint: protocolSha256Schema,
        approval: protocolUnion(
            [
                protocolObject({ action: protocolLiteral("none") }, "no approval"),
                protocolObject(
                    { action: protocolLiteral("approve_once"), userActionId: protocolNonBlankString },
                    "one-time approval",
                ),
                protocolObject(
                    { action: protocolLiteral("use_saved_policy"), policyId: protocolNonBlankString },
                    "saved-policy approval",
                ),
            ],
            "render approval",
        ),
    },
    "requested semantic option",
);
const renderSelectionSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        renderInputFingerprint: protocolSha256Schema,
        semanticOptions: protocolArray(requestedSemanticOptionSchema),
    },
    "render selection",
);
const deploymentRenderPreviewParamsSchema = protocolObject(
    {
        deploymentId: protocolUuidV4Schema,
        selection: renderSelectionSchema,
    },
    "deployment render preview params",
);
const deploymentDeployParamsSchema = protocolUnion(
    [
        protocolObject(
            {
                previewToken: protocolNonBlankString,
                deploymentAction: protocolLiteral("apply"),
            },
            "apply previewed deployment",
        ),
        protocolObject(
            {
                previewToken: protocolNonBlankString,
                deploymentAction: protocolLiteral("replace_unmanaged"),
                userActionId: protocolNonBlankString,
            },
            "replace previewed unmanaged target",
        ),
        protocolObject(
            {
                previewToken: protocolNonBlankString,
                deploymentAction: protocolLiteral("overwrite_runtime"),
                userActionId: protocolNonBlankString,
            },
            "overwrite deployment",
        ),
    ],
    "deployment deploy params",
);
const deploymentRepairParamsSchema = protocolObject(
    {
        deploymentId: protocolUuidV4Schema,
        inspectionToken: protocolNonBlankString,
        expectedInspectionResultFingerprint: protocolSha256Schema,
        userActionId: protocolNonBlankString,
    },
    "deployment repair params",
);
const reversePrepareParamsSchema = protocolObject(
    {
        deploymentId: protocolUuidV4Schema,
        inspectionToken: protocolNonBlankString,
        inspectionResultFingerprint: protocolSha256Schema,
    },
    "reverse-accept prepare params",
);
const reverseCommitParamsSchema = protocolObject(
    {
        preparationId: protocolUuidV4Schema,
        expectedPreparationRevision: protocolPositiveInteger,
        userActionId: protocolNonBlankString,
        newVersionPromotion: protocolEnum(["use_existing_authority", "grant_staged_version_current_target"] as const),
        renderSelection: renderSelectionSchema,
    },
    "reverse-accept commit params",
);
const reverseCancelParamsSchema = protocolObject(
    { preparationId: protocolUuidV4Schema, expectedPreparationRevision: protocolPositiveInteger },
    "reverse-accept cancel params",
);
const reindexParamsSchema = protocolObject(
    {
        assetIds: optionalProtocolField(protocolArray(protocolUuidV4Schema)),
        includeDeleted: optionalProtocolField(protocolBoolean),
    },
    "asset reindex params",
);

const stateBackupInspectParamsSchema = protocolObject(
    {
        destination: protocolStateBackupDestinationSchema,
        encryptionMode: protocolStateBackupEncryptionModeSchema,
    },
    "State backup inspect params",
);
const stateBackupCreateParamsSchema = protocolObject(
    {
        backupReviewToken: protocolNonBlankString,
        password: optionalProtocolField(protocolNonBlankString),
        userActionId: protocolNonBlankString,
    },
    "State backup create params",
);
const stateBackupPromptPolicyReplaceParamsSchema = protocolObject(
    {
        expectedRevision: protocolNonNegativeInteger,
        expectedSettingFingerprint: protocolSha256Schema,
        mode: protocolEnum(["ask_every_time", "back_up_first", "continue_without_prompt"] as const),
        userActionId: protocolNonBlankString,
    },
    "State backup prompt policy replace params",
);
const stateRestoreInspectParamsSchema = protocolObject(
    {
        source: protocolStateRestoreSourceSchema,
        password: optionalProtocolField(protocolNonBlankString),
    },
    "State restore inspect params",
);
const stateRestoreActivateParamsSchema = protocolObject(
    {
        restoreReviewToken: protocolNonBlankString,
        password: optionalProtocolField(protocolNonBlankString),
        userActionId: protocolNonBlankString,
    },
    "State restore activate params",
);

const cancelledResultSchema = protocolObject({ cancelled: protocolLiteral(true) }, "cancelled result");
const voidResultSchema = protocolObject({}, "void result");

function acceptedLong<TParams, TTerminalValue>(
    paramsSchema: ProtocolSchema<TParams>,
    terminalValueSchema: ProtocolSchema<TTerminalValue>,
) {
    return defineAcceptedLong(
        paramsSchema,
        protocolAcceptedLongAcknowledgementSchema,
        protocolOperationOutcome(terminalValueSchema),
        protocolProgressProjectionSchema,
    );
}

function acceptedLongWithProgress<TParams, TTerminalValue, TProgress>(
    paramsSchema: ProtocolSchema<TParams>,
    terminalValueSchema: ProtocolSchema<TTerminalValue>,
    progressSchema: ProtocolSchema<TProgress>,
) {
    return defineAcceptedLongWithProgress(
        paramsSchema,
        protocolAcceptedLongAcknowledgementSchema,
        protocolOperationOutcome(terminalValueSchema),
        progressSchema,
    );
}

function acceptedLongWithFailedValue<TParams, TTerminalValue>(
    paramsSchema: ProtocolSchema<TParams>,
    terminalValueSchema: ProtocolSchema<TTerminalValue>,
) {
    return defineAcceptedLong(
        paramsSchema,
        protocolAcceptedLongAcknowledgementSchema,
        protocolOperationOutcomeWithFailedValue(terminalValueSchema),
        protocolProgressProjectionSchema,
    );
}

export const PROTOCOL_OPERATION_REGISTRY = Object.freeze({
    "environment.list": immediate("immediate_query", environmentListParamsSchema, environmentListResultSchema),
    "adapter_provider.list": immediate("immediate_query", protocolEmptyObjectSchema, providerListResultSchema),
    "adapter_enablement.get": immediate("immediate_query", protocolEmptyObjectSchema, protocolAdapterEnablementSchema),
    "watched_scan_intent.get": immediate("immediate_query", protocolEmptyObjectSchema, protocolWatchedScanIntentSchema),
    "probe_environment_reference.list": immediate(
        "immediate_query",
        probeEnvironmentReferenceListParamsSchema,
        protocolProbeEnvironmentReferenceListSchema,
    ),
    "project.list": immediate(
        "immediate_query",
        projectListParamsSchema,
        protocolObject({ projects: protocolArray(protocolProjectProjectionSchema) }, "project list result"),
    ),
    "project.get": immediate("immediate_query", projectGetParamsSchema, protocolLookup(protocolProjectProjectionSchema)),
    "catalog.search": immediate("immediate_query", protocolCatalogSearchParamsSchema, protocolCatalogSearchResultSchema),
    "asset.list": immediate(
        "immediate_query",
        assetListParamsSchema,
        protocolObject({ assets: protocolArray(protocolAssetSummarySchema) }, "asset list result"),
    ),
    "asset.get": immediate("immediate_query", assetGetParamsSchema, protocolLookup(protocolAssetProjectionSchema)),
    "asset_version.get": immediate(
        "immediate_query",
        assetVersionGetParamsSchema,
        protocolLookup(protocolAssetVersionProjectionSchema),
    ),
    "asset_library.kind_counts": immediate(
        "immediate_query",
        protocolAssetKindCountsParamsSchema,
        protocolAssetKindCountsResultSchema,
    ),
    "asset_library.page": immediate("immediate_query", protocolAssetSummaryPageParamsSchema, protocolAssetSummaryPageSchema),
    "asset_version.list": immediate("immediate_query", protocolAssetVersionPageParamsSchema, protocolAssetVersionPageSchema),
    "asset_version.file_children": immediate(
        "immediate_query",
        protocolAssetVersionFileChildrenParamsSchema,
        protocolAssetVersionFileTreePageSchema,
    ),
    "asset_version.file_preview": immediate(
        "immediate_query",
        protocolAssetVersionFilePreviewParamsSchema,
        protocolAssetVersionFilePreviewSchema,
    ),
    "asset_version.text_page": immediate(
        "immediate_query",
        protocolAssetVersionTextPageParamsSchema,
        protocolAssetVersionTextPageSchema,
    ),
    "asset_version.compare": acceptedLong(protocolAssetVersionCompareParamsSchema, protocolAssetVersionComparisonSchema),
    "asset_version.export": acceptedLong(protocolAssetVersionExportParamsSchema, protocolAssetVersionExportResultSchema),
    "asset_version.export_native": acceptedLong(
        protocolAssetVersionExportParamsSchema,
        protocolAssetVersionNativeExportResultSchema,
    ),
    "asset.purge.inspect": immediate("immediate_query", protocolAssetIdentityParamsSchema, protocolAssetPurgePreparationSchema),
    "deployment.list": immediate(
        "immediate_query",
        deploymentListParamsSchema,
        protocolObject({ deployments: protocolArray(protocolDeploymentProjectionSchema) }, "deployment list result"),
    ),
    "deployment.get": immediate("immediate_query", deploymentGetParamsSchema, protocolLookup(protocolDeploymentProjectionSchema)),
    "promotion_grant.list": immediate(
        "immediate_query",
        promotionGrantListParamsSchema,
        protocolObject({ grants: protocolArray(protocolPromotionGrantViewSchema) }, "promotion grant list result"),
    ),
    "restricted_source_full_access.get": immediate(
        "immediate_query",
        protocolEmptyObjectSchema,
        protocolRestrictedSourceFullAccessSchema,
    ),
    "state_backup.list": immediate("immediate_query", protocolEmptyObjectSchema, protocolStateBackupInventorySchema),
    "state_backup_prompt_policy.get": immediate(
        "immediate_query",
        protocolEmptyObjectSchema,
        protocolStateBackupPromptPolicySchema,
    ),
    ...DIAGNOSTICS_OPERATION_DEFINITIONS,
    "import_preview.detail": immediate("immediate_query", importPreviewDetailParamsSchema, protocolImportPreviewDetailSchema),
    "rendered_inspection.detail": immediate(
        "immediate_query",
        renderedInspectionDetailParamsSchema,
        protocolRenderedInspectionDetailSchema,
    ),
    "adapter_enablement.replace": immediate(
        "immediate_mutation",
        adapterEnablementReplaceParamsSchema,
        protocolAdapterEnablementSchema,
    ),
    "watched_scan_intent.replace": immediate(
        "immediate_mutation",
        watchedScanReplaceParamsSchema,
        protocolWatchedScanIntentSchema,
    ),
    "watched_scan_intent.reset": immediate("immediate_mutation", watchedScanResetParamsSchema, protocolWatchedScanIntentSchema),
    "project.register": immediate("immediate_mutation", projectRegisterParamsSchema, protocolProjectProjectionSchema),
    "asset.display.update": immediate(
        "immediate_mutation",
        protocolAssetDisplayUpdateParamsSchema,
        protocolAssetProjectionSchema,
    ),
    "asset.copy": immediate("immediate_mutation", protocolAssetCopyParamsSchema, protocolAssetCopyResultSchema),
    "asset.soft_delete": immediate("immediate_mutation", protocolAssetIdentityParamsSchema, protocolAssetProjectionSchema),
    "asset.restore": immediate("immediate_mutation", protocolAssetIdentityParamsSchema, protocolAssetProjectionSchema),
    "deployment.create": immediate("immediate_mutation", deploymentCreateParamsSchema, protocolDeploymentProjectionSchema),
    "deployment.update_inputs": immediate("immediate_mutation", deploymentUpdateParamsSchema, protocolDeploymentProjectionSchema),
    "deployment.soft_delete": immediate("immediate_mutation", deploymentGetParamsSchema, protocolDeploymentProjectionSchema),
    "promotion_grant.create": immediate("immediate_mutation", promotionGrantCreateParamsSchema, protocolPromotionGrantSchema),
    "promotion_grant.revoke": immediate("immediate_mutation", promotionGrantRevokeParamsSchema, protocolPromotionGrantSchema),
    "restricted_source_full_access.set": immediate(
        "immediate_mutation",
        fullAccessSetParamsSchema,
        protocolRestrictedSourceFullAccessSchema,
    ),
    "state_backup_prompt_policy.replace": immediate(
        "immediate_mutation",
        stateBackupPromptPolicyReplaceParamsSchema,
        protocolStateBackupPromptPolicySchema,
    ),
    "import_preview.cancel": immediate("immediate_mutation", importPreviewCancelParamsSchema, cancelledResultSchema),
    "adapter.probe": acceptedLongWithProgress(
        adapterProbeParamsSchema,
        protocolProbeReviewProjectionSchema,
        adapterProbeProgressSchema,
    ),
    "adapter.read": acceptedLong(adapterReadParamsSchema, protocolReadReviewProjectionSchema),
    "import.preview": acceptedLong(importPreviewParamsSchema, protocolImportPreviewProjectionSchema),
    "import.accept_batch": acceptedLong(importAcceptBatchParamsSchema, protocolBatchImportResultSchema),
    "project_lifecycle.inspect": acceptedLong(protocolProjectLifecycleInspectParamsSchema, protocolProjectLifecycleReviewSchema),
    "project_lifecycle.commit": acceptedLong(protocolProjectLifecycleCommitParamsSchema, protocolProjectProjectionSchema),
    "asset_usage.analyze": acceptedLong(protocolAssetUsageAnalyzeParamsSchema, protocolAssetUsageProjectionSchema),
    "asset.purge.commit": acceptedLong(protocolAssetPurgeCommitParamsSchema, protocolAssetPurgeResultSchema),
    "deployment.render_analyze": acceptedLong(deploymentIdParamsSchema, protocolRenderAnalysisSchema),
    "deployment.render_preview": acceptedLong(deploymentRenderPreviewParamsSchema, protocolDeploymentRenderPreviewSchema),
    "deployment.deploy": acceptedLong(deploymentDeployParamsSchema, protocolDeploymentProjectionSchema),
    "deployment.scan": acceptedLong(deploymentIdParamsSchema, protocolDeploymentProjectionSchema),
    "deployment.inspect_rendered_target": acceptedLong(deploymentIdParamsSchema, protocolRenderedInspectionSummarySchema),
    "deployment.repair": acceptedLong(deploymentRepairParamsSchema, protocolDeploymentProjectionSchema),
    "deployment.recover": acceptedLong(deploymentIdParamsSchema, protocolDeploymentProjectionSchema),
    "reverse_accept.prepare": acceptedLongWithFailedValue(reversePrepareParamsSchema, protocolReversePreparationSchema),
    "reverse_accept.commit": acceptedLongWithFailedValue(reverseCommitParamsSchema, protocolReverseCommitSchema),
    "reverse_accept.cancel": acceptedLong(reverseCancelParamsSchema, voidResultSchema),
    "asset.reindex": acceptedLong(reindexParamsSchema, protocolReindexResultSchema),
    "state_backup.inspect": acceptedLongWithProgress(
        stateBackupInspectParamsSchema,
        protocolStateBackupReviewSchema,
        protocolStateBackupProgressSchema,
    ),
    "state_backup.create": acceptedLongWithProgress(
        stateBackupCreateParamsSchema,
        protocolStateBackupArtifactSchema,
        protocolStateBackupProgressSchema,
    ),
    "state_restore.inspect": acceptedLongWithProgress(
        stateRestoreInspectParamsSchema,
        protocolStateRestoreReviewSchema,
        protocolStateRestoreProgressSchema,
    ),
    "state_restore.activate": acceptedLongWithProgress(
        stateRestoreActivateParamsSchema,
        protocolStateRestoreActivationSchema,
        protocolStateRestoreProgressSchema,
    ),
    ...DIAGNOSTICS_ACCEPTED_LONG_DEFINITIONS,
    initialize: control(initializeParamsSchema, initializeResultSchema),
    "operation.observe": control(observeParamsSchema, observeResultSchema),
    "operation.cancel": control(
        protocolObject({ operationId: protocolNonBlankString }, "operation cancellation params"),
        cancelResultSchema,
    ),
} as const satisfies Readonly<Record<ProtocolOperationName, ProtocolOperationDefinition>>);

export type ProtocolOperationParams<TName extends ProtocolOperationName> = InferProtocolSchema<
    (typeof PROTOCOL_OPERATION_REGISTRY)[TName]["paramsSchema"]
>;
export type ProtocolOperationResult<TName extends ProtocolOperationName> = InferProtocolSchema<
    (typeof PROTOCOL_OPERATION_REGISTRY)[TName]["resultSchema"]
>;
export type ProtocolOperationProgress<TName extends ProtocolAcceptedLongOperationName> = InferProtocolSchema<
    (typeof PROTOCOL_OPERATION_REGISTRY)[TName]["progressSchema"]
>;
export type ProtocolOperationTerminal<TName extends ProtocolAcceptedLongOperationName> = InferProtocolSchema<
    (typeof PROTOCOL_OPERATION_REGISTRY)[TName]["terminalSchema"]
>;

const progressEventBaseSchema = protocolObject(
    {
        eventKind: protocolLiteral("progress"),
        operationId: protocolNonBlankString,
        sequence: protocolPositiveInteger,
        operation: protocolAcceptedLongOperationNameSchema,
        progress: protocolJsonValue,
    },
    "operation progress event",
);
const terminalEventBaseSchema = protocolObject(
    {
        eventKind: protocolLiteral("terminal"),
        operationId: protocolNonBlankString,
        sequence: protocolPositiveInteger,
        operation: protocolAcceptedLongOperationNameSchema,
        outcome: protocolJsonValue,
    },
    "operation terminal event",
);

export const protocolOperationEventSchema: ProtocolSchema<ProtocolOperationEventV1> = Object.freeze({
    description: "operation event",
    parse(value: unknown, path = "$"): ProtocolOperationEventV1 {
        if (
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            (value as { eventKind?: unknown }).eventKind === "progress"
        ) {
            const parsed = progressEventBaseSchema.parse(value, path);
            const progressSchema = PROTOCOL_OPERATION_REGISTRY[parsed.operation].progressSchema as ProtocolSchema<unknown>;
            return Object.freeze({
                ...parsed,
                progress: progressSchema.parse(parsed.progress, `${path}.progress`),
            }) as ProtocolOperationEventV1;
        }
        const parsed = terminalEventBaseSchema.parse(value, path);
        return Object.freeze({
            ...parsed,
            outcome: parseProtocolTerminalOutcome(parsed.operation, parsed.outcome),
        }) as ProtocolOperationEventV1;
    },
});

export type ProtocolOperationEventV1 = {
    readonly [TName in ProtocolAcceptedLongOperationName]:
        | {
              readonly eventKind: "progress";
              readonly operationId: string;
              readonly sequence: number;
              readonly operation: TName;
              readonly progress: ProtocolOperationProgress<TName>;
          }
        | {
              readonly eventKind: "terminal";
              readonly operationId: string;
              readonly sequence: number;
              readonly operation: TName;
              readonly outcome: ProtocolOperationTerminal<TName>;
          };
}[ProtocolAcceptedLongOperationName];

const DELIVERY_BY_NAME = new Map<ProtocolOperationName, ProtocolDeliveryClass>([
    ...PROTOCOL_IMMEDIATE_QUERY_NAMES.map((name) => [name, "immediate_query"] as const),
    ...PROTOCOL_IMMEDIATE_MUTATION_NAMES.map((name) => [name, "immediate_mutation"] as const),
    ...PROTOCOL_ACCEPTED_LONG_NAMES.map((name) => [name, "accepted_long"] as const),
    ...PROTOCOL_CONTROL_NAMES.map((name) => [name, "control"] as const),
]);

export function validateProtocolOperationRegistry(
    registry: Readonly<Record<string, ProtocolOperationDefinition>>,
    names: readonly string[],
): readonly string[] {
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const name of names) {
        if (seen.has(name)) errors.push(`duplicate operation name ${name}`);
        seen.add(name);
    }
    for (const name of Object.keys(registry)) {
        if (!seen.has(name)) errors.push(`foreign registry operation ${name}`);
    }
    for (const name of names) {
        const definition = registry[name];
        if (definition === undefined) {
            errors.push(`missing registry operation ${name}`);
            continue;
        }
        const expectedDelivery = DELIVERY_BY_NAME.get(name as ProtocolOperationName);
        if (expectedDelivery === undefined) {
            errors.push(`operation ${name} has no delivery authority`);
        } else if (definition.delivery !== expectedDelivery) {
            errors.push(`operation ${name} must use ${expectedDelivery}, received ${definition.delivery}`);
        }
        if (definition.delivery === "accepted_long") {
            if (definition.terminalSchema === undefined) errors.push(`accepted-long operation ${name} has no terminal schema`);
            if (definition.progressSchema === undefined) errors.push(`accepted-long operation ${name} has no progress schema`);
        } else if (definition.terminalSchema !== undefined || definition.progressSchema !== undefined) {
            errors.push(`non-long operation ${name} declares long-operation schemas`);
        }
    }
    return Object.freeze(errors);
}

export function assertProtocolOperationRegistry(
    registry: Readonly<Record<string, ProtocolOperationDefinition>> = PROTOCOL_OPERATION_REGISTRY,
    names: readonly string[] = PROTOCOL_OPERATION_NAMES,
): void {
    const errors = validateProtocolOperationRegistry(registry, names);
    if (errors.length > 0) throw new Error(`invalid Protocol operation registry:\n${errors.join("\n")}`);
}

assertProtocolOperationRegistry();

export function parseProtocolOperationParams<TName extends ProtocolOperationName>(
    name: TName,
    value: unknown,
): ProtocolOperationParams<TName> {
    return PROTOCOL_OPERATION_REGISTRY[name].paramsSchema.parse(value, `params(${name})`) as ProtocolOperationParams<TName>;
}

export function parseProtocolOperationResult<TName extends ProtocolOperationName>(
    name: TName,
    value: unknown,
): ProtocolOperationResult<TName> {
    return PROTOCOL_OPERATION_REGISTRY[name].resultSchema.parse(value, `result(${name})`) as ProtocolOperationResult<TName>;
}

export function parseProtocolTerminalOutcome<TName extends ProtocolAcceptedLongOperationName>(
    name: TName,
    value: unknown,
): ProtocolOperationTerminal<TName> {
    const schema = PROTOCOL_OPERATION_REGISTRY[name].terminalSchema as ProtocolSchema<unknown>;
    return schema.parse(value, `terminal(${name})`) as ProtocolOperationTerminal<TName>;
}

export function parseProtocolOperationProgress<TName extends ProtocolAcceptedLongOperationName>(
    name: TName,
    value: unknown,
): ProtocolOperationProgress<TName> {
    const schema = PROTOCOL_OPERATION_REGISTRY[name].progressSchema as ProtocolSchema<unknown>;
    return schema.parse(value, `progress(${name})`) as ProtocolOperationProgress<TName>;
}
