import type { AssetKind, AssetScope, PosixRelativePath, UuidV4 } from "./primitives";

export interface CatalogSearchInput {
    query: string;
    limitPerGroup?: number;
}

export interface CatalogSearchProjectMatch {
    projectId: UuidV4;
    displayName: string;
    rootPath: string;
    deleted: boolean;
    matchedField: "display_name" | "root_path";
    snippet: string;
}

interface CatalogSearchAssetMatchBase {
    assetId: UuidV4;
    kind: AssetKind;
    scope: AssetScope;
    projectId: string;
    scopePath: string;
    displayName: string;
}

export type CatalogSearchAssetMatch = CatalogSearchAssetMatchBase &
    (
        | {
              matchedField: "display_name" | "display_description" | "kind" | "scope_path" | "type_metadata";
              snippet: string;
          }
        | {
              matchedField: "logical_path" | "text_content";
              logicalPath: PosixRelativePath;
              snippet: string;
          }
    );

export interface CatalogSearchResult {
    projects: {
        items: CatalogSearchProjectMatch[];
        totalCount: number;
    };
    assets: {
        items: CatalogSearchAssetMatch[];
        totalCount: number;
    };
}

export interface CatalogSearchApi {
    searchCatalog(input: CatalogSearchInput): import("./core-service").CoreResult<CatalogSearchResult>;
}
