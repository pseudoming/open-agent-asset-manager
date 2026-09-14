import { protocolDiagnosticSchema } from "./diagnostics";
import { protocolSha256Schema, protocolUuidV4Schema } from "./primitives";
import {
    protocolArray,
    protocolBoolean,
    protocolEnum,
    protocolLiteral,
    protocolNonBlankString,
    protocolNonEmptyArray,
    protocolObject,
    protocolPositiveInteger,
    protocolUnion,
} from "./validation";

export const protocolPromotionTargetSchema = protocolUnion(
    [
        protocolObject({ targetKind: protocolLiteral("project"), projectId: protocolUuidV4Schema }, "project target"),
        protocolObject(
            { targetKind: protocolLiteral("global_target"), targetAuthorityFingerprint: protocolSha256Schema },
            "global target",
        ),
    ],
    "promotion target",
);

const protocolRenderSemanticKindSchema = protocolEnum([
    "asset.file_inventory",
    "guidance.base_context",
    "guidance.content",
    "rule.activation",
    "rule.content",
    "workflow.activation",
    "workflow.content",
    "workflow.reference",
    "skill.discovery_metadata",
    "skill.body",
    "skill.resource",
    "subagent.delegation_metadata",
    "subagent.invoked_context",
    "subagent.resource",
    "subagent.tool_boundary",
    "subagent.model_hint",
    "memory.support",
    "memory.content",
] as const);

const protocolRenderSemanticSubjectSchema = protocolUnion(
    [
        protocolObject(
            {
                subjectKind: protocolLiteral("asset"),
                assetId: protocolUuidV4Schema,
                versionId: protocolUuidV4Schema,
            },
            "asset render semantic subject",
        ),
        protocolObject(
            {
                subjectKind: protocolLiteral("file"),
                assetId: protocolUuidV4Schema,
                versionId: protocolUuidV4Schema,
                fileId: protocolUuidV4Schema,
            },
            "file render semantic subject",
        ),
        protocolObject(
            {
                subjectKind: protocolLiteral("missing_required_file_role"),
                assetId: protocolUuidV4Schema,
                versionId: protocolUuidV4Schema,
                fileRole: protocolLiteral("entry"),
            },
            "missing render semantic subject",
        ),
    ],
    "render semantic subject",
);

export const protocolRenderSemanticSchema = protocolObject(
    {
        semanticRefFingerprint: protocolSha256Schema,
        consumerAgentRuntimeId: protocolNonBlankString,
        semanticKind: protocolRenderSemanticKindSchema,
        subject: protocolRenderSemanticSubjectSchema,
    },
    "render semantic",
);

export const protocolRenderOutputUnitSchema = protocolObject(
    {
        outputUnitFingerprint: protocolSha256Schema,
        claims: protocolArray(
            protocolObject(
                {
                    relativePath: protocolNonBlankString,
                    contentKind: protocolEnum(["text", "binary"] as const),
                    executable: protocolBoolean,
                },
                "render output claim",
            ),
        ),
        managedDirectoryPaths: protocolArray(protocolNonBlankString),
    },
    "render output unit",
);

const protocolRenderOptionBase = {
    optionFingerprint: protocolSha256Schema,
    semanticRefFingerprint: protocolSha256Schema,
    renderStrategy: protocolEnum([
        "native_file",
        "native_directory",
        "native_graph",
        "native_import",
        "inline",
        "reference_with_intro",
    ] as const),
    actualReverseExtractPolicy: protocolEnum(["can_reconcile", "ignore_generated_wrapper", "unsupported"] as const),
    requiredOutputUnitFingerprints: protocolArray(protocolSha256Schema),
    reasonCode: protocolNonBlankString,
    diagnostics: protocolArray(protocolDiagnosticSchema),
} as const;

export const protocolRenderDegradationKindSchema = protocolEnum([
    "target_runtime_missing_asset_kind",
    "trigger_or_loading_level_lost",
    "workflow_trigger_lost",
    "workflow_permission_lost",
    "workflow_runtime_lost",
    "workflow_variable_lost",
    "permission_or_tool_boundary_lost",
    "folder_asset_flattened",
    "memory_semantics_lost",
    "runtime_specific_metadata_lost",
    "reverse_extract_pollution_risk",
] as const);

const protocolRenderApprovalConcernSchema = protocolEnum(["semantic_degradation", "reverse_extract_unsupported"] as const);

export const protocolRenderOptionSchema = protocolUnion(
    [
        protocolObject(
            {
                ...protocolRenderOptionBase,
                outcome: protocolLiteral("preserved"),
                approvalState: protocolLiteral("not_required"),
            },
            "preserved render option without approval",
        ),
        protocolObject(
            {
                ...protocolRenderOptionBase,
                outcome: protocolLiteral("preserved"),
                approvalState: protocolLiteral("required"),
                approvalConcerns: protocolNonEmptyArray(protocolRenderApprovalConcernSchema),
                approvalFingerprint: protocolSha256Schema,
            },
            "preserved render option requiring approval",
        ),
        protocolObject(
            {
                ...protocolRenderOptionBase,
                outcome: protocolLiteral("degraded"),
                degradationKinds: protocolNonEmptyArray(protocolRenderDegradationKindSchema),
                approvalState: protocolLiteral("not_required"),
            },
            "degraded render option without approval",
        ),
        protocolObject(
            {
                ...protocolRenderOptionBase,
                outcome: protocolLiteral("degraded"),
                degradationKinds: protocolNonEmptyArray(protocolRenderDegradationKindSchema),
                approvalState: protocolLiteral("required"),
                approvalConcerns: protocolNonEmptyArray(protocolRenderApprovalConcernSchema),
                approvalFingerprint: protocolSha256Schema,
            },
            "degraded render option requiring approval",
        ),
    ],
    "render option",
);

const protocolPromotionAuthorizationInspectionBase = {
    assetId: protocolUuidV4Schema,
    versionId: protocolUuidV4Schema,
    target: protocolPromotionTargetSchema,
} as const;

export const protocolPromotionAuthorizationInspectionSchema = protocolUnion(
    [
        protocolObject(
            {
                ...protocolPromotionAuthorizationInspectionBase,
                promotionAuthorizationState: protocolLiteral("not_required"),
                versionOriginAuthorityFingerprint: protocolSha256Schema,
            },
            "promotion authorization not required",
        ),
        protocolObject(
            {
                ...protocolPromotionAuthorizationInspectionBase,
                promotionAuthorizationState: protocolLiteral("required"),
                versionOriginAuthorityFingerprint: protocolSha256Schema,
            },
            "promotion authorization required",
        ),
        protocolObject(
            {
                ...protocolPromotionAuthorizationInspectionBase,
                promotionAuthorizationState: protocolLiteral("authorized"),
                versionOriginAuthorityFingerprint: protocolSha256Schema,
                authorizationSource: protocolEnum([
                    "version_target_grant",
                    "asset_all_versions_target_grant",
                    "restricted_source_full_access",
                ] as const),
                authorityId: protocolNonBlankString,
                authorityRevision: protocolPositiveInteger,
                authorityFingerprint: protocolSha256Schema,
            },
            "promotion authorization granted",
        ),
        protocolObject(
            {
                ...protocolPromotionAuthorizationInspectionBase,
                promotionAuthorizationState: protocolLiteral("unavailable"),
                diagnosticCode: protocolNonBlankString,
            },
            "promotion authorization unavailable",
        ),
    ],
    "promotion authorization inspection",
);

export const protocolRenderAnalysisSchema = protocolObject(
    {
        deploymentId: protocolUuidV4Schema,
        renderInputFingerprint: protocolSha256Schema,
        semantics: protocolArray(protocolRenderSemanticSchema),
        outputUnits: protocolArray(protocolRenderOutputUnitSchema),
        options: protocolArray(protocolRenderOptionSchema),
        promotionAuthorizationInspections: protocolArray(protocolPromotionAuthorizationInspectionSchema),
        blockedSemantics: protocolArray(
            protocolObject(
                {
                    semanticRefFingerprint: protocolSha256Schema,
                    reasonCode: protocolNonBlankString,
                    diagnostics: protocolArray(protocolDiagnosticSchema),
                },
                "blocked render semantic",
            ),
        ),
        diagnostics: protocolArray(protocolDiagnosticSchema),
    },
    "render analysis",
);
