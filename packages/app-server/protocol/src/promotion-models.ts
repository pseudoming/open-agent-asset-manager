import { protocolPlatformSchema, protocolSha256Schema, protocolUuidV4Schema } from "./primitives";
import { protocolPromotionTargetSchema } from "./render-models";
import {
    protocolArray,
    protocolEnum,
    protocolLiteral,
    protocolNonBlankString,
    protocolNonNegativeInteger,
    protocolObject,
    protocolPositiveInteger,
    protocolString,
    protocolUnion,
} from "./validation";

const protocolPromotionGrantFields = {
    promotionGrantId: protocolUuidV4Schema,
    subject: protocolUnion(
        [
            protocolObject(
                {
                    subjectKind: protocolLiteral("asset_version"),
                    assetId: protocolUuidV4Schema,
                    versionId: protocolUuidV4Schema,
                },
                "asset-version promotion subject",
            ),
            protocolObject(
                {
                    subjectKind: protocolLiteral("asset_all_versions"),
                    assetId: protocolUuidV4Schema,
                    activationVersionId: protocolUuidV4Schema,
                },
                "all-versions promotion subject",
            ),
        ],
        "promotion subject",
    ),
    target: protocolPromotionTargetSchema,
    grantState: protocolEnum(["active", "revoked"] as const),
    revision: protocolPositiveInteger,
    updatedAt: protocolNonNegativeInteger,
    grantFingerprint: protocolSha256Schema,
} as const;

export const protocolPromotionGrantSchema = protocolObject(protocolPromotionGrantFields, "promotion grant");

export const protocolPromotionGrantViewSchema = protocolObject(
    {
        ...protocolPromotionGrantFields,
        targetDescription: protocolUnion(
            [
                protocolObject({ status: protocolLiteral("unavailable") }, "unavailable grant target description"),
                protocolObject(
                    {
                        status: protocolLiteral("available"),
                        targetKind: protocolLiteral("project"),
                        displayName: protocolString,
                        rootPath: protocolNonBlankString,
                    },
                    "saved Project grant target description",
                ),
                protocolObject(
                    {
                        status: protocolLiteral("available"),
                        targetKind: protocolLiteral("global_target"),
                        platform: protocolPlatformSchema,
                        platformInstanceId: protocolNonBlankString,
                        targetRootPath: protocolNonBlankString,
                        consumerAgentRuntimeIds: protocolArray(protocolNonBlankString),
                    },
                    "saved global grant target description",
                ),
            ],
            "grant target description",
        ),
    },
    "promotion grant read view",
);

const protocolRestrictedSourceDisabledSchema = protocolObject(
    {
        configVersion: protocolLiteral(1),
        settingId: protocolLiteral("restricted_source_promotion_full_access_v1"),
        state: protocolLiteral("disabled"),
        revision: protocolNonNegativeInteger,
        updatedAt: protocolNonNegativeInteger,
        settingFingerprint: protocolSha256Schema,
    },
    "disabled restricted-source full access",
);
const protocolRestrictedSourceEnabledSchema = protocolObject(
    {
        configVersion: protocolLiteral(1),
        settingId: protocolLiteral("restricted_source_promotion_full_access_v1"),
        state: protocolLiteral("enabled"),
        revision: protocolPositiveInteger,
        userActionEvidenceId: protocolNonBlankString,
        enabledAt: protocolPositiveInteger,
        settingFingerprint: protocolSha256Schema,
    },
    "enabled restricted-source full access",
);
export const protocolRestrictedSourceFullAccessSchema = protocolUnion(
    [protocolRestrictedSourceDisabledSchema, protocolRestrictedSourceEnabledSchema],
    "restricted-source full access",
);
