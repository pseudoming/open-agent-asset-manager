import type { CatalogSearchResult } from "@oaam/core";

export function projectCatalogSearchResult(result: CatalogSearchResult) {
    return {
        projects: {
            items: result.projects.items.map((item) => ({ ...item })),
            totalCount: result.projects.totalCount,
        },
        assets: {
            items: result.assets.items.map((item) => {
                const base = {
                    assetId: item.assetId,
                    kind: item.kind,
                    scope: item.scope,
                    ...(item.projectId === "" ? {} : { projectId: item.projectId }),
                    scopePath: item.scopePath,
                    displayName: item.displayName,
                };
                return item.matchedField === "logical_path" || item.matchedField === "text_content"
                    ? {
                          ...base,
                          matchedField: item.matchedField,
                          logicalPath: item.logicalPath,
                          snippet: item.snippet,
                      }
                    : {
                          ...base,
                          matchedField: item.matchedField,
                          snippet: item.snippet,
                      };
            }),
            totalCount: result.assets.totalCount,
        },
    };
}
