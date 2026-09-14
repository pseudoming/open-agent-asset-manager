import { protocolDiagnosticSchema } from "./diagnostics";
import { protocolEnvironmentSelectorSchema, protocolSha256Schema, protocolUuidV4Schema } from "./primitives";
import { protocolRenderAnalysisSchema } from "./render-models";
import {
    protocolAssetVersionImportSourceSchema,
    protocolSourceDomainSchema,
    protocolSourceLocatorIdentitySchema,
} from "./source-models";
import {
    type InferProtocolSchema,
    optionalProtocolField,
    type ProtocolSchema,
    ProtocolValidationError,
    protocolArray,
    protocolBoolean,
    protocolEmptyArraySchema,
    protocolEnum,
    protocolLiteral,
    protocolNonBlankString,
    protocolNonEmptyArray,
    protocolNonNegativeInteger,
    protocolObject,
    protocolPositiveInteger,
    protocolString,
    protocolUnion,
} from "./validation";

export {
    protocolRenderAnalysisSchema,
    protocolRenderOptionSchema,
    protocolRenderOutputUnitSchema,
    protocolRenderSemanticSchema,
    protocolPromotionAuthorizationInspectionSchema,
    protocolPromotionTargetSchema,
} from "./render-models";
export { protocolDeploymentRenderPreviewSchema } from "./render-preview-models";
export { protocolSourceDomainSchema, protocolSourceLocatorIdentitySchema } from "./source-models";

export const protocolEmptyObjectSchema = protocolObject({}, "empty object");

export const protocolAssetKindSchema = protocolEnum(["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"] as const);
export const protocolAssetScopeSchema = protocolEnum(["global", "project"] as const);
export const protocolOperationStatusSchema = protocolEnum(["complete", "partial", "failed"] as const);
export const protocolEntrySupportStatusSchema = protocolEnum([
    "supported",
    "unsupported",
    "docs_declared_unverified",
    "deferred",
] as const);
export const protocolEvidenceLevelSchema = protocolEnum([
    "agent_runtime_verified",
    "local_artifact",
    "source_code",
    "docs_declared",
    "user_provided",
    "agent_answer",
] as const);

export function protocolOperationOutcome<T>(valueSchema: ProtocolSchema<T>): ProtocolSchema<ProtocolOperationOutcomeV1<T>> {
    return protocolUnion(
        [
            protocolObject(
                {
                    status: protocolLiteral("complete"),
                    value: valueSchema,
                    diagnostics: protocolArray(protocolDiagnosticSchema),
                },
                "complete operation outcome",
            ),
            protocolObject(
                {
                    status: protocolLiteral("partial"),
                    value: valueSchema,
                    diagnostics: protocolArray(protocolDiagnosticSchema),
                },
                "partial operation outcome",
            ),
            protocolObject(
                {
                    status: protocolLiteral("failed"),
                    diagnostics: protocolArray(protocolDiagnosticSchema),
                },
                "failed operation outcome",
            ),
        ],
        "operation outcome",
    );
}

export type ProtocolOperationOutcomeV1<T> =
    | {
          readonly status: "complete";
          readonly value: T;
          readonly diagnostics: readonly InferProtocolSchema<typeof protocolDiagnosticSchema>[];
      }
    | {
          readonly status: "partial";
          readonly value: T;
          readonly diagnostics: readonly InferProtocolSchema<typeof protocolDiagnosticSchema>[];
      }
    | { readonly status: "failed"; readonly diagnostics: readonly InferProtocolSchema<typeof protocolDiagnosticSchema>[] };

export function protocolOperationOutcomeWithFailedValue<T>(
    valueSchema: ProtocolSchema<T>,
): ProtocolSchema<ProtocolOperationOutcomeWithFailedValueV1<T>> {
    return protocolUnion(
        [
            protocolObject(
                {
                    status: protocolLiteral("complete"),
                    value: valueSchema,
                    diagnostics: protocolArray(protocolDiagnosticSchema),
                },
                "complete value-bearing operation outcome",
            ),
            protocolObject(
                {
                    status: protocolLiteral("partial"),
                    value: valueSchema,
                    diagnostics: protocolArray(protocolDiagnosticSchema),
                },
                "partial value-bearing operation outcome",
            ),
            protocolObject(
                {
                    status: protocolLiteral("failed"),
                    value: valueSchema,
                    diagnostics: protocolArray(protocolDiagnosticSchema),
                },
                "failed operation outcome with a semantic value",
            ),
            protocolObject(
                {
                    status: protocolLiteral("failed"),
                    diagnostics: protocolArray(protocolDiagnosticSchema),
                },
                "failed operation outcome without a semantic value",
            ),
        ],
        "value-bearing operation outcome",
    );
}

export type ProtocolOperationOutcomeWithFailedValueV1<T> =
    | {
          readonly status: "complete" | "partial";
          readonly value: T;
          readonly diagnostics: readonly InferProtocolSchema<typeof protocolDiagnosticSchema>[];
      }
    | {
          readonly status: "failed";
          readonly value: T;
          readonly diagnostics: readonly InferProtocolSchema<typeof protocolDiagnosticSchema>[];
      }
    | { readonly status: "failed"; readonly diagnostics: readonly InferProtocolSchema<typeof protocolDiagnosticSchema>[] };

export function protocolLookup<T>(valueSchema: ProtocolSchema<T>): ProtocolSchema<ProtocolLookupV1<T>> {
    return protocolUnion(
        [
            protocolObject({ found: protocolLiteral(true), value: valueSchema }, "found lookup"),
            protocolObject({ found: protocolLiteral(false) }, "not-found lookup"),
        ],
        "lookup",
    );
}

export type ProtocolLookupV1<T> = { readonly found: true; readonly value: T } | { readonly found: false };

export const protocolEnvironmentProjectionSchema = protocolObject(
    {
        environment: protocolEnvironmentSelectorSchema,
        displayName: protocolNonBlankString,
    },
    "environment projection",
);

export const protocolAgentRuntimeProjectionSchema = protocolObject(
    {
        agentRuntimeId: protocolNonBlankString,
        displayName: protocolNonBlankString,
        entryClass: protocolEnum(["cli", "app", "ide"] as const),
    },
    "agent runtime projection",
);

export const protocolSourceCapabilityProjectionSchema = protocolObject(
    {
        sourceCapabilityFingerprint: protocolSha256Schema,
        agentRuntimeId: protocolNonBlankString,
        assetKind: protocolAssetKindSchema,
        entrySupportStatus: protocolEntrySupportStatusSchema,
        rootLocatorKind: protocolEnum([
            "runtime_known_rule",
            "runtime_declared_path",
            "project_registry_entry",
            "user_provided_path",
            "unknown",
        ] as const),
        rootRole: protocolEnum(["config", "source", "project_actual", "unknown"] as const),
        sourceDomain: protocolSourceDomainSchema,
        sourcePathMechanism: protocolEnum([
            "fixed_file",
            "directory_entry",
            "recursive_entry",
            "manifest_declared",
            "unknown",
        ] as const),
        evidenceLevel: protocolEvidenceLevelSchema,
        readPolicy: protocolEnum(["auto_read", "user_selected_root_only", "report_only"] as const),
        diagnostics: protocolArray(protocolDiagnosticSchema),
    },
    "source capability projection",
);

const protocolAvailableTargetCapabilityProjectionSchema = protocolObject(
    {
        agentRuntimeId: protocolNonBlankString,
        assetKind: protocolAssetKindSchema,
        entrySupportStatus: protocolEnum(["supported", "docs_declared_unverified"] as const),
        renderStrategy: protocolEnum([
            "native_file",
            "native_directory",
            "native_graph",
            "native_import",
            "inline",
            "reference_with_intro",
        ] as const),
        reverseExtractPolicy: protocolEnum([
            "can_reconcile",
            "ignore_generated_wrapper",
            "requires_user_choice",
            "unsupported",
        ] as const),
        diagnostics: protocolArray(protocolDiagnosticSchema),
    },
    "available target capability projection",
);
const protocolUnavailableTargetCapabilityProjectionSchema = protocolObject(
    {
        agentRuntimeId: protocolNonBlankString,
        assetKind: protocolAssetKindSchema,
        entrySupportStatus: protocolEnum(["unsupported", "deferred"] as const),
        diagnostics: protocolArray(protocolDiagnosticSchema),
    },
    "unavailable target capability projection",
);
export const protocolTargetCapabilityProjectionSchema = protocolUnion(
    [protocolAvailableTargetCapabilityProjectionSchema, protocolUnavailableTargetCapabilityProjectionSchema],
    "target capability projection",
);

export const protocolAdapterProviderProjectionSchema = protocolObject(
    {
        adapterId: protocolNonBlankString,
        displayName: protocolNonBlankString,
        version: protocolNonBlankString,
        enabled: protocolBoolean,
        agentRuntimes: protocolArray(protocolAgentRuntimeProjectionSchema),
        sourceCapabilities: protocolArray(protocolSourceCapabilityProjectionSchema),
        targetCapabilities: protocolArray(protocolTargetCapabilityProjectionSchema),
    },
    "adapter provider projection",
);

const protocolVirginAdapterEnablementSchema = protocolObject(
    {
        configVersion: protocolLiteral(1),
        settingId: protocolLiteral("adapter_enablement_v1"),
        revision: protocolLiteral(0),
        enabledAdapterIds: protocolEmptyArraySchema,
        updatedAt: protocolLiteral(0),
        settingFingerprint: protocolSha256Schema,
    },
    "virgin adapter enablement",
);
const protocolConfiguredAdapterEnablementSchema = protocolObject(
    {
        configVersion: protocolLiteral(1),
        settingId: protocolLiteral("adapter_enablement_v1"),
        revision: protocolPositiveInteger,
        enabledAdapterIds: protocolArray(protocolNonBlankString),
        userActionEvidenceId: protocolNonBlankString,
        updatedAt: protocolPositiveInteger,
        settingFingerprint: protocolSha256Schema,
    },
    "configured adapter enablement",
);
export const protocolAdapterEnablementSchema = protocolUnion(
    [protocolVirginAdapterEnablementSchema, protocolConfiguredAdapterEnablementSchema],
    "adapter enablement",
);

export const protocolWatchedSourceIdentitySchema = protocolObject(
    {
        adapterId: protocolNonBlankString,
        rootRole: protocolEnum(["config", "source", "project_actual", "unknown"] as const),
        sourceDomain: protocolSourceDomainSchema,
        canonicalPath: protocolString,
        locatorIdentities: protocolNonEmptyArray(protocolSourceLocatorIdentitySchema),
    },
    "watched source identity",
);

export const protocolWatchedSourceBindingSchema = protocolUnion(
    [
        protocolObject({ assetScope: protocolLiteral("global") }, "global watched source binding"),
        protocolObject(
            { assetScope: protocolLiteral("project"), projectId: protocolUuidV4Schema },
            "project watched source binding",
        ),
    ],
    "watched source binding",
);

export const protocolWatchedSourceSelectorSchema = protocolUnion(
    [
        protocolObject(
            {
                disposition: protocolLiteral("excluded"),
                source: protocolWatchedSourceIdentitySchema,
                agentRuntimeIds: protocolNonEmptyArray(protocolNonBlankString),
                selectorFingerprint: protocolSha256Schema,
            },
            "excluded watched source selector",
        ),
        protocolObject(
            {
                disposition: protocolLiteral("included"),
                source: protocolWatchedSourceIdentitySchema,
                agentRuntimeIds: protocolNonEmptyArray(protocolNonBlankString),
                binding: protocolWatchedSourceBindingSchema,
                selectorFingerprint: protocolSha256Schema,
            },
            "included watched source selector",
        ),
    ],
    "watched source selector",
);

export const protocolWatchedEnvironmentIntentSchema = protocolObject(
    {
        environment: protocolEnvironmentSelectorSchema,
        sourceSelectors: protocolNonEmptyArray(protocolWatchedSourceSelectorSchema),
    },
    "watched environment intent",
);

const protocolVirginWatchedScanIntentSchema = protocolObject(
    {
        configVersion: protocolLiteral(1),
        settingId: protocolLiteral("watched_scan_intent_v1"),
        revision: protocolLiteral(0),
        environments: protocolEmptyArraySchema,
        updatedAt: protocolLiteral(0),
        settingFingerprint: protocolSha256Schema,
    },
    "virgin watched scan intent",
);
const protocolConfiguredWatchedScanIntentSchema = protocolObject(
    {
        configVersion: protocolLiteral(1),
        settingId: protocolLiteral("watched_scan_intent_v1"),
        revision: protocolPositiveInteger,
        environments: protocolArray(protocolWatchedEnvironmentIntentSchema),
        userActionEvidenceId: protocolNonBlankString,
        updatedAt: protocolPositiveInteger,
        settingFingerprint: protocolSha256Schema,
    },
    "configured watched scan intent",
);
export const protocolWatchedScanIntentSchema = protocolUnion(
    [protocolVirginWatchedScanIntentSchema, protocolConfiguredWatchedScanIntentSchema],
    "watched scan intent",
);

export const protocolProjectProjectionSchema = protocolObject(
    {
        projectId: protocolUuidV4Schema,
        displayName: protocolString,
        rootPath: protocolNonBlankString,
        deleted: protocolBoolean,
        createdAt: protocolNonNegativeInteger,
        updatedAt: protocolNonNegativeInteger,
    },
    "project projection",
);

export const protocolAssetSummarySchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
        kind: protocolAssetKindSchema,
        scope: protocolAssetScopeSchema,
        projectId: optionalProtocolField(protocolUuidV4Schema),
        scopePath: protocolString,
        displayName: protocolNonBlankString,
        displayDescription: protocolString,
        currentVersionId: protocolUuidV4Schema,
        currentRevision: protocolPositiveInteger,
        currentFingerprint: protocolSha256Schema,
        currentVersionStatus: protocolEnum(["complete", "incomplete"] as const),
        deleted: protocolBoolean,
        createdAt: protocolNonNegativeInteger,
        updatedAt: protocolNonNegativeInteger,
    },
    "asset summary",
);

export const protocolAssetProjectionSchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
        kind: protocolAssetKindSchema,
        scope: protocolAssetScopeSchema,
        projectId: optionalProtocolField(protocolUuidV4Schema),
        scopePath: protocolString,
        displayName: protocolNonBlankString,
        displayDescription: protocolString,
        versionIds: protocolArray(protocolUuidV4Schema),
        deleted: protocolBoolean,
        createdAt: protocolNonNegativeInteger,
        updatedAt: protocolNonNegativeInteger,
    },
    "asset projection",
);

export const protocolVersionFileProjectionSchema = protocolObject(
    {
        fileId: protocolUuidV4Schema,
        logicalPath: protocolNonBlankString,
        role: protocolNonBlankString,
        mediaType: protocolNonBlankString,
        contentKind: protocolEnum(["text", "binary"] as const),
        contentHash: protocolSha256Schema,
        byteLength: protocolNonNegativeInteger,
        executable: protocolBoolean,
    },
    "asset version file projection",
);

export const protocolAssetVersionProjectionSchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
        versionId: protocolUuidV4Schema,
        revision: protocolPositiveInteger,
        status: protocolEnum(["complete", "incomplete"] as const),
        versionCanonicalContentFingerprint: protocolSha256Schema,
        files: protocolArray(protocolVersionFileProjectionSchema),
        importSource: optionalProtocolField(protocolAssetVersionImportSourceSchema),
        createdAt: protocolNonNegativeInteger,
    },
    "asset version projection",
);

export const protocolDeploymentAssetSchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
        versionId: protocolUuidV4Schema,
        allowIncomplete: protocolBoolean,
    },
    "deployment asset",
);

const protocolDeploymentFreshnessShapeSchema = protocolObject(
    {
        state: protocolEnum(["never", "in_progress", "complete", "partial", "failed"] as const),
        attemptedAt: protocolNonNegativeInteger,
        lastCompleteAt: protocolNonNegativeInteger,
    },
    "deployment freshness",
);

export const protocolDeploymentFreshnessSchema: ProtocolSchema<
    InferProtocolSchema<typeof protocolDeploymentFreshnessShapeSchema>
> = Object.freeze({
    description: "truthful deployment freshness",
    parse(value: unknown, path = "$") {
        const parsed = protocolDeploymentFreshnessShapeSchema.parse(value, path);
        if (parsed.lastCompleteAt > parsed.attemptedAt) {
            throw new ProtocolValidationError(`${path}.lastCompleteAt`, "cannot be newer than attemptedAt");
        }
        if (parsed.state === "never" && (parsed.attemptedAt !== 0 || parsed.lastCompleteAt !== 0)) {
            throw new ProtocolValidationError(path, "never freshness must use zero timestamps");
        }
        if (parsed.state !== "never" && parsed.state !== "in_progress" && parsed.attemptedAt === 0) {
            throw new ProtocolValidationError(`${path}.attemptedAt`, "terminal freshness requires an attempt time");
        }
        if (parsed.state === "complete" && parsed.lastCompleteAt !== parsed.attemptedAt) {
            throw new ProtocolValidationError(path, "complete freshness timestamps must match");
        }
        return parsed;
    },
});

export const protocolDeploymentSubjectSchema = protocolUnion(
    [
        protocolObject({ subjectKind: protocolLiteral("global") }, "global deployment subject"),
        protocolObject(
            { subjectKind: protocolLiteral("project"), projectId: protocolUuidV4Schema },
            "project deployment subject",
        ),
    ],
    "deployment subject",
);

export const protocolDeploymentProjectionSchema = protocolObject(
    {
        deploymentId: protocolUuidV4Schema,
        subject: protocolDeploymentSubjectSchema,
        consumerAgentRuntimeIds: protocolArray(protocolNonBlankString),
        environment: protocolEnvironmentSelectorSchema,
        targetRootPath: protocolNonBlankString,
        stage: protocolEnum(["deleted", "blocked", "conflict", "needs_repair", "in_sync"] as const),
        reason: protocolString,
        actionHints: protocolArray(
            protocolEnum([
                "review_deployment",
                "check_now",
                "review_external_changes",
                "review_repair",
                "recover",
                "contact_support",
            ] as const),
        ),
        freshness: protocolDeploymentFreshnessSchema,
        deleted: protocolBoolean,
        assets: protocolArray(protocolDeploymentAssetSchema),
        createdAt: protocolNonNegativeInteger,
        updatedAt: protocolNonNegativeInteger,
    },
    "deployment projection",
);

export {
    protocolPromotionGrantSchema,
    protocolPromotionGrantViewSchema,
    protocolRestrictedSourceFullAccessSchema,
} from "./promotion-models";

export const protocolProbeRuntimeRowSchema = protocolObject(
    {
        rowId: protocolNonBlankString,
        agentRuntimeId: protocolNonBlankString,
        versionText: protocolString,
        installationStatus: protocolEnum([
            "available",
            "not_found",
            "needs_permission",
            "version_incompatible",
            "unknown",
        ] as const),
        projectDiscoveryStatus: protocolEnum(["complete", "partial", "not_found", "needs_permission", "unknown"] as const),
        sourceRootRowIds: protocolArray(protocolNonBlankString),
        diagnostics: protocolArray(protocolDiagnosticSchema),
    },
    "probe runtime row",
);

export const protocolProbeSourceRowSchema = protocolObject(
    {
        rowId: protocolNonBlankString,
        sourceRootId: protocolNonBlankString,
        rootRole: protocolEnum(["config", "source", "project_actual", "unknown"] as const),
        sourceDomain: protocolSourceDomainSchema,
        displayPath: protocolNonBlankString,
        accessStatus: protocolEnum(["available", "not_found", "needs_permission", "unknown"] as const),
        locatorIdentities: protocolNonEmptyArray(protocolSourceLocatorIdentitySchema),
        diagnostics: protocolArray(protocolDiagnosticSchema),
    },
    "probe source row",
);

export const protocolProbeProjectRowSchema = protocolObject(
    {
        rowId: protocolNonBlankString,
        observedProjectId: protocolNonBlankString,
        displayName: protocolString,
        workspaceSourceRowIds: protocolNonEmptyArray(protocolNonBlankString),
        containedSourceRootRowIds: protocolNonEmptyArray(protocolNonBlankString),
        diagnostics: protocolArray(protocolDiagnosticSchema),
    },
    "probe project row",
);

export const protocolProbeTargetApplicabilitySchema = protocolObject(
    {
        agentRuntimeId: protocolNonBlankString,
        status: protocolEnum(["ready_for_plan", "invalid", "unknown"] as const),
        diagnostics: protocolArray(protocolDiagnosticSchema),
    },
    "probe target applicability",
);

export const protocolProbeTargetRowSchema = protocolObject(
    {
        rowId: protocolNonBlankString,
        targetCandidateId: protocolNonBlankString,
        targetKind: protocolEnum(["global", "project", "directory", "unknown"] as const),
        displayName: protocolString,
        displayPath: protocolNonBlankString,
        entryApplicabilities: protocolNonEmptyArray(protocolProbeTargetApplicabilitySchema),
        diagnostics: protocolArray(protocolDiagnosticSchema),
    },
    "probe target row",
);

export const protocolProbeResultRowSchema = protocolObject(
    {
        rowId: protocolNonBlankString,
        adapterId: protocolNonBlankString,
        environment: protocolEnvironmentSelectorSchema,
        status: protocolOperationStatusSchema,
        runtimes: protocolArray(protocolProbeRuntimeRowSchema),
        sources: protocolArray(protocolProbeSourceRowSchema),
        projects: protocolArray(protocolProbeProjectRowSchema),
        targets: protocolArray(protocolProbeTargetRowSchema),
        diagnostics: protocolArray(protocolDiagnosticSchema),
    },
    "probe result row",
);

export const protocolProbeReviewProjectionSchema = protocolObject(
    {
        probeToken: protocolNonBlankString,
        results: protocolArray(protocolProbeResultRowSchema),
    },
    "probe review projection",
);

export const protocolProbeEnvironmentReferenceSchema = protocolObject(
    {
        adapterId: protocolNonBlankString,
        agentRuntimeId: protocolNonBlankString,
        originEnvironment: protocolEnvironmentSelectorSchema,
        referencedEnvironment: protocolObject(
            {
                platform: protocolLiteral("wsl"),
                platformInstanceId: protocolNonBlankString,
            },
            "referenced WSL environment",
        ),
        referenceKind: protocolLiteral("project"),
        validationState: protocolLiteral("not_checked"),
    },
    "probe environment reference",
);

export const protocolProbeEnvironmentReferenceListSchema = protocolObject(
    { references: protocolArray(protocolProbeEnvironmentReferenceSchema) },
    "probe environment reference list",
);

export const protocolReadReportSchema = protocolObject(
    {
        adapterId: protocolNonBlankString,
        agentRuntimeId: protocolNonBlankString,
        sourceRootId: protocolNonBlankString,
        status: protocolEnum(["complete", "partial", "failed", "not_found"] as const),
        candidateCount: protocolNonNegativeInteger,
        diagnostics: protocolArray(protocolDiagnosticSchema),
    },
    "read report",
);

export const protocolReadReviewProjectionSchema = protocolObject(
    {
        readToken: protocolNonBlankString,
        reports: protocolArray(protocolReadReportSchema),
        candidateCount: protocolNonNegativeInteger,
    },
    "read review projection",
);

export const protocolCallableBindingSubjectSchema = protocolUnion(
    [
        protocolObject({ subjectKind: protocolLiteral("workflow_execution_agent") }, "workflow agent binding subject"),
        protocolObject(
            {
                subjectKind: protocolLiteral("file_reference"),
                logicalPath: protocolNonBlankString,
                referenceIndex: protocolNonNegativeInteger,
            },
            "file reference binding subject",
        ),
        protocolObject(
            {
                subjectKind: protocolLiteral("memory_catalog_member"),
                memberIndex: protocolNonNegativeInteger,
            },
            "Memory Catalog member binding subject",
        ),
    ],
    "callable binding subject",
);

export const protocolCallableBindingRequestSchema = protocolObject(
    {
        subject: protocolCallableBindingSubjectSchema,
        rawTarget: protocolNonBlankString,
        required: protocolBoolean,
    },
    "callable binding request",
);

export const protocolImportCandidateSummarySchema = protocolObject(
    {
        candidateId: protocolNonBlankString,
        kind: protocolAssetKindSchema,
        memoryEntityRole: optionalProtocolField(protocolEnum(["catalog", "unit"] as const)),
        scope: protocolAssetScopeSchema,
        displayName: protocolNonBlankString,
        displayDescription: protocolString,
        status: protocolEnum(["importable", "incomplete", "blocked", "duplicate"] as const),
        freshness: protocolEnum(["fresh", "stale", "unknown", "requires_refresh"] as const),
        fileCount: protocolNonNegativeInteger,
        logicalPaths: protocolArray(protocolNonBlankString),
        logicalPathsTruncated: protocolBoolean,
        diagnosticCodes: optionalProtocolField(protocolArray(protocolNonBlankString)),
        callableBindingRequestCount: protocolNonNegativeInteger,
        callableBindingRequests: protocolArray(protocolCallableBindingRequestSchema),
        callableBindingRequestsTruncated: protocolBoolean,
    },
    "import candidate summary",
);

export const protocolImportPreviewProjectionSchema = protocolObject(
    {
        previewToken: protocolNonBlankString,
        snapshotFingerprint: protocolSha256Schema,
        candidates: protocolArray(protocolImportCandidateSummarySchema),
    },
    "import preview projection",
);

export const protocolBoundedTextSchema = protocolObject(
    {
        text: protocolString,
        byteLength: protocolNonNegativeInteger,
        truncated: protocolBoolean,
    },
    "bounded text",
);

export const protocolImportPreviewDetailSchema = protocolObject(
    {
        candidateId: protocolNonBlankString,
        logicalPath: optionalProtocolField(protocolNonBlankString),
        mediaType: protocolNonBlankString,
        contentKind: protocolEnum(["text", "binary"] as const),
        text: optionalProtocolField(protocolBoundedTextSchema),
        byteLength: protocolNonNegativeInteger,
        contentHash: protocolSha256Schema,
    },
    "import preview detail",
);

export const protocolRenderedInspectionSummarySchema = protocolObject(
    {
        inspectionToken: protocolNonBlankString,
        deploymentId: protocolUuidV4Schema,
        inspectionResultFingerprint: protocolSha256Schema,
        changeCount: protocolNonNegativeInteger,
        conflictCount: protocolNonNegativeInteger,
        details: protocolArray(
            protocolObject(
                {
                    selector: protocolNonBlankString,
                    detailKind: protocolEnum(["semantic_change", "file_attribution"] as const),
                    displayName: protocolNonBlankString,
                },
                "rendered inspection detail selector",
            ),
        ),
        detailsTruncated: protocolBoolean,
    },
    "rendered inspection summary",
);

const protocolRenderedInspectionContentSchema = protocolUnion(
    [
        protocolObject(
            {
                contentKind: protocolLiteral("text"),
                mediaType: protocolNonBlankString,
                text: protocolBoundedTextSchema,
                contentHash: protocolSha256Schema,
            },
            "rendered inspection text content",
        ),
        protocolObject(
            {
                contentKind: protocolLiteral("binary"),
                mediaType: protocolNonBlankString,
                byteLength: protocolNonNegativeInteger,
                contentHash: protocolSha256Schema,
            },
            "rendered inspection binary content",
        ),
    ],
    "rendered inspection content",
);

export const protocolRenderedInspectionDetailSchema = protocolUnion(
    [
        protocolObject(
            {
                inspectionToken: protocolNonBlankString,
                selector: protocolNonBlankString,
                detailKind: protocolLiteral("semantic_change"),
                changeKind: protocolEnum([
                    "asset_type_data_replacement",
                    "file_content_replacement",
                    "file_deletion",
                    "file_executable_replacement",
                    "file_addition",
                ] as const),
                changeFingerprint: protocolSha256Schema,
                content: optionalProtocolField(protocolRenderedInspectionContentSchema),
            },
            "rendered semantic change detail",
        ),
        protocolObject(
            {
                inspectionToken: protocolNonBlankString,
                selector: protocolNonBlankString,
                detailKind: protocolLiteral("file_attribution"),
                relativePath: protocolNonBlankString,
                attributionState: protocolEnum(["uniquely_attributable", "whole_file_adoption_required", "conflict"] as const),
                reasonCode: optionalProtocolField(protocolNonBlankString),
                diagnostics: protocolArray(protocolDiagnosticSchema),
            },
            "rendered file attribution detail",
        ),
    ],
    "rendered inspection detail",
);

export const protocolReversePreparationSchema = protocolUnion(
    [
        protocolObject(
            {
                preparationState: protocolLiteral("prepared"),
                preparationId: protocolUuidV4Schema,
                preparationRevision: protocolPositiveInteger,
                expiresAt: protocolPositiveInteger,
                promotionState: protocolEnum(["already_authorized", "user_confirmation_required"] as const),
                renderAnalysis: protocolRenderAnalysisSchema,
            },
            "prepared reverse accept",
        ),
        protocolObject({ preparationState: protocolLiteral("not_prepared") }, "not-prepared reverse accept"),
    ],
    "reverse-accept preparation",
);

export const protocolVersionRefSchema = protocolObject(
    { assetId: protocolUuidV4Schema, versionId: protocolUuidV4Schema },
    "version reference",
);

export const protocolReverseCommitSchema = protocolUnion(
    [
        protocolObject({ commitState: protocolLiteral("committed"), version: protocolVersionRefSchema }),
        protocolObject(
            { commitState: protocolLiteral("not_committed"), versionPublicationState: protocolLiteral("not_published") },
            "not-published reverse commit",
        ),
        protocolObject(
            {
                commitState: protocolLiteral("not_committed"),
                versionPublicationState: protocolLiteral("published_not_selected"),
                version: protocolVersionRefSchema,
            },
            "published-not-selected reverse commit",
        ),
        protocolObject(
            {
                commitState: protocolLiteral("recovery_required"),
                reasonCode: protocolEnum([
                    "receipt_contradiction",
                    "database_postcondition_partial",
                    "asset_filesystem_mismatch",
                    "durability_unconfirmed",
                ] as const),
            },
            "recovery-required reverse commit",
        ),
        protocolObject({ commitState: protocolLiteral("outcome_unavailable") }, "unavailable reverse commit"),
    ],
    "reverse-accept commit",
);

export const protocolBatchImportItemSchema = protocolUnion(
    [
        protocolObject(
            {
                status: protocolLiteral("complete"),
                candidateId: protocolNonBlankString,
                version: protocolVersionRefSchema,
                diagnostics: protocolArray(protocolDiagnosticSchema),
            },
            "complete batch import item",
        ),
        protocolObject(
            {
                status: protocolLiteral("failed"),
                candidateId: protocolNonBlankString,
                diagnostics: protocolArray(protocolDiagnosticSchema),
            },
            "failed batch import item",
        ),
        protocolObject(
            {
                status: protocolLiteral("dependency_failed"),
                candidateId: protocolNonBlankString,
                failedDependencyCandidateIds: protocolArray(protocolNonBlankString),
                diagnostics: protocolArray(protocolDiagnosticSchema),
            },
            "dependency-failed batch import item",
        ),
    ],
    "batch import item",
);

export const protocolBatchImportResultSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        items: protocolArray(protocolBatchImportItemSchema),
    },
    "batch import result",
);

export const protocolReindexResultSchema = protocolObject(
    {
        scannedAssets: protocolNonNegativeInteger,
        indexedAssets: protocolNonNegativeInteger,
        skippedAssets: protocolNonNegativeInteger,
        diagnostics: protocolArray(protocolDiagnosticSchema),
    },
    "reindex result",
);
