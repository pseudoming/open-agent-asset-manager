import { protocolAssetKindSchema, protocolAssetScopeSchema } from "./models";
import { protocolUuidV4Schema } from "./primitives";
import {
    optionalProtocolField,
    protocolArray,
    protocolBoolean,
    protocolEnum,
    protocolNonBlankString,
    protocolNonNegativeInteger,
    protocolObject,
    protocolPositiveInteger,
    protocolString,
    protocolUnion,
    ProtocolValidationError,
    type ProtocolSchema,
} from "./validation";

export const PROTOCOL_CATALOG_SEARCH_MAXIMUM_QUERY_CODE_POINTS = 128;
export const PROTOCOL_CATALOG_SEARCH_MAXIMUM_GROUP_LIMIT = 20;
export const PROTOCOL_CATALOG_SEARCH_MAXIMUM_SNIPPET_CODE_POINTS = 160;

function boundedString(description: string, maximumCodePoints: number, nonBlank = false): ProtocolSchema<string> {
    return Object.freeze({
        description,
        parse(value: unknown, path = "$"): string {
            const parsed = (nonBlank ? protocolNonBlankString : protocolString).parse(value, path);
            if ([...parsed].length > maximumCodePoints) {
                throw new ProtocolValidationError(path, `must not exceed ${maximumCodePoints} code points`);
            }
            return parsed;
        },
    });
}

function boundedArray<T>(itemSchema: ProtocolSchema<T>, maximumItems: number, description: string): ProtocolSchema<readonly T[]> {
    return Object.freeze({
        description,
        parse(value: unknown, path = "$"): readonly T[] {
            const parsed = protocolArray(itemSchema).parse(value, path);
            if (parsed.length > maximumItems) {
                throw new ProtocolValidationError(path, `must not contain more than ${maximumItems} items`);
            }
            return parsed;
        },
    });
}

export const protocolCatalogSearchQuerySchema: ProtocolSchema<string> = Object.freeze({
    description: "bounded catalog search query",
    parse(value: unknown, path = "$"): string {
        const parsed = boundedString(
            "bounded catalog search query",
            PROTOCOL_CATALOG_SEARCH_MAXIMUM_QUERY_CODE_POINTS,
            true,
        ).parse(value, path);
        if ([...parsed].some(isSearchControlCharacter)) {
            throw new ProtocolValidationError(path, "must not contain control characters");
        }
        return parsed.normalize("NFC");
    },
});

function isSearchControlCharacter(character: string): boolean {
    const codeUnit = character.charCodeAt(0);
    return codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f);
}

export const protocolCatalogSearchGroupLimitSchema: ProtocolSchema<number> = Object.freeze({
    description: "catalog search group limit",
    parse(value: unknown, path = "$"): number {
        const parsed = protocolPositiveInteger.parse(value, path);
        if (parsed > PROTOCOL_CATALOG_SEARCH_MAXIMUM_GROUP_LIMIT) {
            throw new ProtocolValidationError(path, `must not exceed ${PROTOCOL_CATALOG_SEARCH_MAXIMUM_GROUP_LIMIT}`);
        }
        return parsed;
    },
});

export const protocolCatalogSearchSnippetSchema = boundedString(
    "catalog search snippet",
    PROTOCOL_CATALOG_SEARCH_MAXIMUM_SNIPPET_CODE_POINTS + 2,
);

export const protocolCatalogSearchParamsSchema = protocolObject(
    {
        query: protocolCatalogSearchQuerySchema,
        limitPerGroup: optionalProtocolField(protocolCatalogSearchGroupLimitSchema),
    },
    "catalog search params",
);

export const protocolCatalogSearchProjectMatchSchema = protocolObject(
    {
        projectId: protocolUuidV4Schema,
        displayName: protocolString,
        rootPath: protocolNonBlankString,
        deleted: protocolBoolean,
        matchedField: protocolEnum(["display_name", "root_path"] as const),
        snippet: protocolCatalogSearchSnippetSchema,
    },
    "catalog search Project match",
);

const assetMatchBase = {
    assetId: protocolUuidV4Schema,
    kind: protocolAssetKindSchema,
    scope: protocolAssetScopeSchema,
    projectId: optionalProtocolField(protocolUuidV4Schema),
    scopePath: protocolString,
    displayName: protocolString,
} as const;

export const protocolCatalogSearchAssetMatchSchema = protocolUnion(
    [
        protocolObject(
            {
                ...assetMatchBase,
                matchedField: protocolEnum([
                    "display_name",
                    "display_description",
                    "kind",
                    "scope_path",
                    "type_metadata",
                ] as const),
                snippet: protocolCatalogSearchSnippetSchema,
            },
            "catalog search Asset metadata match",
        ),
        protocolObject(
            {
                ...assetMatchBase,
                matchedField: protocolEnum(["logical_path", "text_content"] as const),
                logicalPath: protocolNonBlankString,
                snippet: protocolCatalogSearchSnippetSchema,
            },
            "catalog search Asset file match",
        ),
    ],
    "catalog search Asset match",
);

export const protocolCatalogSearchProjectMatchesSchema = boundedArray(
    protocolCatalogSearchProjectMatchSchema,
    PROTOCOL_CATALOG_SEARCH_MAXIMUM_GROUP_LIMIT,
    "bounded catalog search Project matches",
);

export const protocolCatalogSearchAssetMatchesSchema = boundedArray(
    protocolCatalogSearchAssetMatchSchema,
    PROTOCOL_CATALOG_SEARCH_MAXIMUM_GROUP_LIMIT,
    "bounded catalog search Asset matches",
);

export const protocolCatalogSearchResultSchema = protocolObject(
    {
        projects: protocolObject(
            {
                items: protocolCatalogSearchProjectMatchesSchema,
                totalCount: protocolNonNegativeInteger,
            },
            "catalog search Project group",
        ),
        assets: protocolObject(
            {
                items: protocolCatalogSearchAssetMatchesSchema,
                totalCount: protocolNonNegativeInteger,
            },
            "catalog search Asset group",
        ),
    },
    "catalog search result",
);
