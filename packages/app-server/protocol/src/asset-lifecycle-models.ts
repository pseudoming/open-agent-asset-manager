import {
    protocolAssetKindSchema,
    protocolAssetProjectionSchema,
    protocolAssetScopeSchema,
    protocolAssetVersionProjectionSchema,
} from "./models";
import { protocolSha256Schema, protocolUuidV4Schema } from "./primitives";
import {
    protocolLiteral,
    protocolNonBlankString,
    protocolNonNegativeInteger,
    protocolObject,
    protocolString,
    protocolUnion,
} from "./validation";

export const protocolAssetDisplayUpdateParamsSchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
        displayName: protocolNonBlankString,
        displayDescription: protocolString,
    },
    "Asset display-metadata update params",
);

const protocolAssetCopyDestinationSchema = protocolUnion(
    [
        protocolObject(
            {
                scope: protocolLiteral("global"),
                scopePath: protocolString,
            },
            "Global Asset copy destination",
        ),
        protocolObject(
            {
                scope: protocolLiteral("project"),
                projectId: protocolUuidV4Schema,
                scopePath: protocolString,
            },
            "Project Asset copy destination",
        ),
    ],
    "Asset copy destination",
);

export const protocolAssetCopyParamsSchema = protocolObject(
    {
        source: protocolObject(
            {
                assetId: protocolUuidV4Schema,
                versionId: protocolUuidV4Schema,
                versionFingerprint: protocolSha256Schema,
                originAuthorityFingerprint: protocolSha256Schema,
            },
            "Asset copy source",
        ),
        destination: protocolAssetCopyDestinationSchema,
        displayName: protocolNonBlankString,
        displayDescription: protocolString,
        userActionId: protocolNonBlankString,
    },
    "Asset copy params",
);

export const protocolAssetCopyResultSchema = protocolObject(
    {
        source: protocolObject(
            {
                assetId: protocolUuidV4Schema,
                versionId: protocolUuidV4Schema,
            },
            "copied Version source",
        ),
        asset: protocolAssetProjectionSchema,
        version: protocolAssetVersionProjectionSchema,
    },
    "Asset copy result",
);

export const protocolAssetIdentityParamsSchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
    },
    "Asset identity params",
);

export const protocolAssetPurgePreparationSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        action: protocolLiteral("purge"),
        assetId: protocolUuidV4Schema,
        assetManifestFingerprint: protocolSha256Schema,
        assetDirectoryIdentityFingerprint: protocolSha256Schema,
        kind: protocolAssetKindSchema,
        scope: protocolAssetScopeSchema,
        projectId: protocolString,
        scopePath: protocolString,
        displayName: protocolNonBlankString,
        versionCount: protocolNonNegativeInteger,
        promotionGrantCount: protocolNonNegativeInteger,
    },
    "Asset purge preparation",
);

export const protocolAssetPurgeCommitParamsSchema = protocolObject(
    {
        preparation: protocolAssetPurgePreparationSchema,
        userActionId: protocolNonBlankString,
    },
    "Asset purge commit params",
);

export const protocolAssetPurgeResultSchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
        recycled: protocolLiteral(true),
    },
    "Asset purge result",
);
