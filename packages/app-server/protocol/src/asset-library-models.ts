import {
    protocolAssetKindSchema,
    protocolAssetSummarySchema,
    protocolLookup,
    protocolVersionFileProjectionSchema,
} from "./models";
import { protocolSha256Schema, protocolUuidV4Schema } from "./primitives";
import {
    optionalProtocolField,
    protocolArray,
    protocolBoolean,
    protocolEnum,
    protocolLiteral,
    protocolNonBlankString,
    protocolNonNegativeInteger,
    protocolObject,
    protocolPositiveInteger,
    protocolString,
    protocolUnion,
} from "./validation";

export const protocolAssetLibrarySubjectSchema = protocolUnion(
    [
        protocolObject({ scope: protocolLiteral("global") }, "Global Asset library subject"),
        protocolObject({ scope: protocolLiteral("project"), projectId: protocolUuidV4Schema }, "Project Asset library subject"),
    ],
    "Asset library subject",
);

const assetLibraryFilterFields = {
    subject: protocolAssetLibrarySubjectSchema,
    keywords: protocolString,
    includeDeleted: optionalProtocolField(protocolBoolean),
} as const;

export const protocolAssetKindCountsParamsSchema = protocolObject(assetLibraryFilterFields, "Asset kind counts params");
export const protocolAssetKindCountsResultSchema = protocolObject(
    {
        counts: protocolArray(
            protocolObject({ kind: protocolAssetKindSchema, count: protocolNonNegativeInteger }, "Asset kind count"),
        ),
    },
    "Asset kind counts result",
);

export const protocolAssetSummaryPageParamsSchema = protocolObject(
    {
        ...assetLibraryFilterFields,
        kind: protocolAssetKindSchema,
        pageSize: optionalProtocolField(protocolPositiveInteger),
        cursor: optionalProtocolField(protocolNonBlankString),
    },
    "Asset summary page params",
);

export const protocolAssetSummaryPageSchema = protocolUnion(
    [
        protocolObject(
            {
                assets: protocolArray(protocolAssetSummarySchema),
                totalCount: protocolNonNegativeInteger,
                hasMore: protocolLiteral(false),
            },
            "final Asset summary page",
        ),
        protocolObject(
            {
                assets: protocolArray(protocolAssetSummarySchema),
                totalCount: protocolNonNegativeInteger,
                hasMore: protocolLiteral(true),
                nextCursor: protocolNonBlankString,
            },
            "continued Asset summary page",
        ),
    ],
    "Asset summary page",
);

export const protocolAssetVersionSummarySchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
        versionId: protocolUuidV4Schema,
        revision: protocolPositiveInteger,
        status: protocolEnum(["complete", "incomplete"] as const),
        fingerprint: protocolSha256Schema,
        originAuthorityFingerprint: protocolSha256Schema,
        versionCanonicalContentFingerprint: protocolSha256Schema,
        changeKind: protocolEnum(["create", "extract", "edit", "sync", "rollback", "merge"] as const),
        sourceVersionId: protocolString,
        sourceDeploymentId: protocolString,
        changeNote: protocolString,
        fileCount: protocolNonNegativeInteger,
        createdAt: protocolNonNegativeInteger,
    },
    "Asset Version summary",
);

export const protocolAssetVersionPageParamsSchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
        pageSize: optionalProtocolField(protocolPositiveInteger),
        cursor: optionalProtocolField(protocolNonBlankString),
    },
    "Asset Version page params",
);

export const protocolAssetVersionPageSchema = protocolLookup(
    protocolUnion(
        [
            protocolObject(
                {
                    versions: protocolArray(protocolAssetVersionSummarySchema),
                    totalCount: protocolNonNegativeInteger,
                    hasMore: protocolLiteral(false),
                },
                "final Asset Version page",
            ),
            protocolObject(
                {
                    versions: protocolArray(protocolAssetVersionSummarySchema),
                    totalCount: protocolNonNegativeInteger,
                    hasMore: protocolLiteral(true),
                    nextCursor: protocolNonBlankString,
                },
                "continued Asset Version page",
            ),
        ],
        "Asset Version page",
    ),
);

export const protocolAssetVersionFileChildrenParamsSchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
        versionId: protocolUuidV4Schema,
        directoryPath: protocolString,
        pageSize: optionalProtocolField(protocolPositiveInteger),
        cursor: optionalProtocolField(protocolNonBlankString),
    },
    "Asset Version file children params",
);

export const protocolAssetVersionFileTreeEntrySchema = protocolUnion(
    [
        protocolObject(
            {
                entryKind: protocolLiteral("directory"),
                relativeName: protocolNonBlankString,
                logicalPath: protocolNonBlankString,
                descendantFileCount: protocolPositiveInteger,
            },
            "Asset Version directory entry",
        ),
        protocolObject(
            {
                entryKind: protocolLiteral("file"),
                relativeName: protocolNonBlankString,
                file: protocolVersionFileProjectionSchema,
            },
            "Asset Version file entry",
        ),
    ],
    "Asset Version file-tree entry",
);

export const protocolAssetVersionFileTreePageSchema = protocolLookup(
    protocolUnion(
        [
            protocolObject(
                {
                    entries: protocolArray(protocolAssetVersionFileTreeEntrySchema),
                    totalCount: protocolNonNegativeInteger,
                    hasMore: protocolLiteral(false),
                },
                "final Asset Version file-tree page",
            ),
            protocolObject(
                {
                    entries: protocolArray(protocolAssetVersionFileTreeEntrySchema),
                    totalCount: protocolNonNegativeInteger,
                    hasMore: protocolLiteral(true),
                    nextCursor: protocolNonBlankString,
                },
                "continued Asset Version file-tree page",
            ),
        ],
        "Asset Version file-tree page",
    ),
);

export const protocolAssetVersionFilePreviewParamsSchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
        versionId: protocolUuidV4Schema,
        logicalPath: protocolNonBlankString,
    },
    "Asset Version file preview params",
);

export const protocolAssetVersionFilePreviewSchema = protocolLookup(
    protocolUnion(
        [
            protocolObject(
                {
                    previewKind: protocolLiteral("text"),
                    file: protocolVersionFileProjectionSchema,
                    text: protocolString,
                    lineCount: protocolPositiveInteger,
                },
                "bounded text preview",
            ),
            protocolObject(
                {
                    previewKind: protocolLiteral("large_text"),
                    file: protocolVersionFileProjectionSchema,
                    limitReason: protocolLiteral("byte_limit"),
                },
                "byte-limited text preview",
            ),
            protocolObject(
                {
                    previewKind: protocolLiteral("large_text"),
                    file: protocolVersionFileProjectionSchema,
                    limitReason: protocolLiteral("line_limit"),
                    observedLineCount: protocolPositiveInteger,
                },
                "line-limited text preview",
            ),
            protocolObject(
                {
                    previewKind: protocolLiteral("binary"),
                    file: protocolVersionFileProjectionSchema,
                },
                "binary preview metadata",
            ),
        ],
        "Asset Version file preview",
    ),
);

export const protocolAssetVersionTextPageParamsSchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
        versionId: protocolUuidV4Schema,
        logicalPath: protocolNonBlankString,
        cursor: optionalProtocolField(protocolNonBlankString),
    },
    "Asset Version text page params",
);

const assetVersionTextPageFields = {
    file: protocolVersionFileProjectionSchema,
    text: protocolString,
    loadedByteStart: protocolNonNegativeInteger,
    loadedByteEnd: protocolNonNegativeInteger,
    totalBytes: protocolNonNegativeInteger,
    firstLine: protocolPositiveInteger,
    lastLine: protocolPositiveInteger,
    totalLines: protocolPositiveInteger,
} as const;

export const protocolAssetVersionTextPageSchema = protocolLookup(
    protocolUnion(
        [
            protocolObject({ ...assetVersionTextPageFields, hasMore: protocolLiteral(false) }, "final Asset Version text page"),
            protocolObject(
                {
                    ...assetVersionTextPageFields,
                    hasMore: protocolLiteral(true),
                    nextCursor: protocolNonBlankString,
                },
                "continued Asset Version text page",
            ),
        ],
        "Asset Version text page",
    ),
);

const protocolAssetVersionFileSideSchema = protocolUnion(
    [
        protocolObject({ state: protocolLiteral("missing") }, "missing Version file side"),
        protocolObject(
            { state: protocolLiteral("present"), file: protocolVersionFileProjectionSchema },
            "present Version file side",
        ),
    ],
    "Version file side",
);

const protocolAssetVersionDiffLineSchema = protocolUnion(
    [
        protocolObject(
            {
                lineKind: protocolLiteral("context"),
                text: protocolString,
                leftLine: protocolPositiveInteger,
                rightLine: protocolPositiveInteger,
            },
            "context diff line",
        ),
        protocolObject(
            {
                lineKind: protocolLiteral("remove"),
                text: protocolString,
                leftLine: protocolPositiveInteger,
            },
            "removed diff line",
        ),
        protocolObject(
            {
                lineKind: protocolLiteral("add"),
                text: protocolString,
                rightLine: protocolPositiveInteger,
            },
            "added diff line",
        ),
    ],
    "Version diff line",
);

const protocolAssetVersionDiffHunkSchema = protocolObject(
    {
        leftStart: protocolPositiveInteger,
        leftLineCount: protocolNonNegativeInteger,
        rightStart: protocolPositiveInteger,
        rightLineCount: protocolNonNegativeInteger,
        lines: protocolArray(protocolAssetVersionDiffLineSchema),
    },
    "Version diff hunk",
);

const protocolSelectedAssetVersionFileComparisonSchema = protocolUnion(
    [
        protocolObject({ comparisonKind: protocolLiteral("not_requested") }, "unrequested file comparison"),
        protocolObject(
            {
                comparisonKind: protocolLiteral("metadata"),
                logicalPath: protocolNonBlankString,
                left: protocolAssetVersionFileSideSchema,
                right: protocolAssetVersionFileSideSchema,
            },
            "metadata file comparison",
        ),
        protocolObject(
            {
                comparisonKind: protocolLiteral("text"),
                logicalPath: protocolNonBlankString,
                left: protocolAssetVersionFileSideSchema,
                right: protocolAssetVersionFileSideSchema,
                algorithm: protocolEnum(["myers", "coarse_complete"] as const),
                leftLineCount: protocolNonNegativeInteger,
                rightLineCount: protocolNonNegativeInteger,
                hunks: protocolArray(protocolAssetVersionDiffHunkSchema),
            },
            "text file comparison",
        ),
    ],
    "selected Version file comparison",
);

export const protocolAssetVersionCompareParamsSchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
        left: protocolObject(
            {
                versionId: protocolUuidV4Schema,
                versionFingerprint: protocolSha256Schema,
            },
            "left Version identity",
        ),
        right: protocolObject(
            {
                versionId: protocolUuidV4Schema,
                versionFingerprint: protocolSha256Schema,
            },
            "right Version identity",
        ),
        logicalPath: optionalProtocolField(protocolNonBlankString),
    },
    "Asset Version compare params",
);

export const protocolAssetVersionComparisonSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        assetId: protocolUuidV4Schema,
        left: protocolObject(
            {
                versionId: protocolUuidV4Schema,
                versionFingerprint: protocolSha256Schema,
            },
            "left compared Version",
        ),
        right: protocolObject(
            {
                versionId: protocolUuidV4Schema,
                versionFingerprint: protocolSha256Schema,
            },
            "right compared Version",
        ),
        files: protocolArray(
            protocolObject(
                {
                    logicalPath: protocolNonBlankString,
                    changeKind: protocolEnum(["added", "removed", "modified", "unchanged"] as const),
                    left: protocolAssetVersionFileSideSchema,
                    right: protocolAssetVersionFileSideSchema,
                },
                "Version file graph change",
            ),
        ),
        selectedFile: protocolSelectedAssetVersionFileComparisonSchema,
    },
    "Asset Version comparison",
);

export const protocolAssetVersionExportParamsSchema = protocolObject(
    {
        source: protocolObject(
            {
                assetId: protocolUuidV4Schema,
                versionId: protocolUuidV4Schema,
                versionFingerprint: protocolSha256Schema,
                originAuthorityFingerprint: protocolSha256Schema,
            },
            "exported Version identity",
        ),
        localPathSelectionToken: protocolNonBlankString,
        userActionId: protocolNonBlankString,
    },
    "Asset Version export params",
);

export const protocolAssetVersionExportResultSchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
        versionId: protocolUuidV4Schema,
        versionFingerprint: protocolSha256Schema,
        archiveIndexFingerprint: protocolSha256Schema,
        archiveByteLength: protocolPositiveInteger,
    },
    "Asset Version export result",
);

export const protocolAssetVersionNativeExportResultSchema = protocolObject(
    {
        assetId: protocolUuidV4Schema,
        versionId: protocolUuidV4Schema,
        versionFingerprint: protocolSha256Schema,
        dialectId: protocolNonBlankString,
        representationFingerprint: protocolSha256Schema,
        fileCount: protocolPositiveInteger,
        archiveByteLength: protocolPositiveInteger,
    },
    "Asset Version native-file export result",
);
