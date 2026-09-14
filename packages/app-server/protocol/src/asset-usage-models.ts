import { protocolAssetKindSchema, protocolDeploymentAssetSchema, protocolDeploymentSubjectSchema } from "./models";
import { protocolDiagnosticSchema } from "./diagnostics";
import { protocolUuidV4Schema } from "./primitives";
import { protocolRenderDegradationKindSchema } from "./render-models";
import {
    protocolArray,
    protocolBoolean,
    protocolEnum,
    protocolLiteral,
    protocolNonBlankString,
    protocolNonEmptyArray,
    protocolObject,
    protocolUnion,
} from "./validation";

export const protocolAssetUsageAnalyzeParamsSchema = protocolObject(
    {
        probeToken: protocolNonBlankString,
        probeResultRowId: protocolNonBlankString,
        targetRowId: protocolNonBlankString,
        subject: protocolDeploymentSubjectSchema,
        consumerAgentRuntimeIds: protocolNonEmptyArray(protocolNonBlankString),
        asset: protocolDeploymentAssetSchema,
    },
    "asset usage analyze params",
);

const protocolAssetUsageRelationshipFields = {
    agentRuntimeId: protocolNonBlankString,
    observedTargetState: protocolEnum(["already_usable", "absent", "different", "unknown"] as const),
    managedState: protocolEnum(["none", "configured", "applied"] as const),
    deploymentIds: protocolArray(protocolUuidV4Schema),
    appliedDeploymentIds: protocolArray(protocolUuidV4Schema),
    degradationKinds: protocolArray(protocolRenderDegradationKindSchema),
    reasonCodes: protocolArray(protocolNonBlankString),
    diagnostics: protocolArray(protocolDiagnosticSchema),
    requiresReview: protocolBoolean,
};

const protocolAssetUsageRelationshipSchema = protocolUnion(
    [
        protocolObject(
            {
                ...protocolAssetUsageRelationshipFields,
                capability: protocolLiteral("direct"),
                substitute: protocolLiteral(null),
            },
            "direct asset usage relationship",
        ),
        protocolObject(
            {
                ...protocolAssetUsageRelationshipFields,
                capability: protocolLiteral("transformed"),
                substitute: protocolLiteral(null),
            },
            "transformed asset usage relationship",
        ),
        protocolObject(
            {
                ...protocolAssetUsageRelationshipFields,
                capability: protocolLiteral("substitute"),
                substitute: protocolObject({ assetKind: protocolAssetKindSchema }, "asset usage substitute"),
            },
            "substitute asset usage relationship",
        ),
        protocolObject(
            {
                ...protocolAssetUsageRelationshipFields,
                capability: protocolLiteral("unavailable"),
                substitute: protocolLiteral(null),
            },
            "unavailable asset usage relationship",
        ),
    ],
    "asset usage relationship",
);

export const protocolAssetUsageProjectionSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(2),
        assetId: protocolUuidV4Schema,
        versionId: protocolUuidV4Schema,
        relationships: protocolArray(protocolAssetUsageRelationshipSchema),
    },
    "asset usage projection",
);
