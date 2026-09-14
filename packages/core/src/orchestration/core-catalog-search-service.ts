/** Cross-authority read coordinator for bounded workbench search. */

import type { Database } from "better-sqlite3";
import type {
    CatalogSearchApi,
    CatalogSearchInput,
    CatalogSearchResult,
    CoreResult,
    OperationDiagnostic,
    ProjectApi,
} from "../types";
import { normalizeCatalogSearchInput, projectCatalogProjectMatches, queryCatalogAssetMatches } from "../catalog/catalog-search";
import { failedOperationResult } from "./asset-service-shared";

export function createCoreCatalogSearchService(configuration: {
    db: Database;
    listProjects: ProjectApi["listProjects"];
}): CatalogSearchApi {
    return Object.freeze({
        searchCatalog(input: CatalogSearchInput): CoreResult<CatalogSearchResult> {
            let normalized: ReturnType<typeof normalizeCatalogSearchInput>;
            try {
                normalized = normalizeCatalogSearchInput(structuredClone(input));
            } catch (error) {
                return failedOperationResult(error, "search");
            }

            const projectResult = configuration.listProjects({ includeDeleted: true });
            let assetOutcome:
                | { status: "complete"; value: CatalogSearchResult["assets"] }
                | { status: "failed"; diagnostic: OperationDiagnostic };
            try {
                assetOutcome = {
                    status: "complete",
                    value: queryCatalogAssetMatches(configuration.db, normalized.query, normalized.limitPerGroup),
                };
            } catch (error) {
                assetOutcome = {
                    status: "failed",
                    diagnostic: failedOperationResult<CatalogSearchResult>(error, "search").diagnostics[0] as OperationDiagnostic,
                };
            }

            if (projectResult.status === "failed" && assetOutcome.status === "failed") {
                return {
                    status: "failed",
                    value: undefined as unknown as CatalogSearchResult,
                    diagnostics: [...projectResult.diagnostics, assetOutcome.diagnostic],
                };
            }
            const projects =
                projectResult.status === "failed"
                    ? { items: [], totalCount: 0 }
                    : projectCatalogProjectMatches(projectResult.value, normalized.query, normalized.limitPerGroup);
            const value = {
                projects,
                assets: assetOutcome.status === "complete" ? assetOutcome.value : { items: [], totalCount: 0 },
            };
            const diagnostics = [
                ...projectResult.diagnostics,
                ...(assetOutcome.status === "failed" ? [assetOutcome.diagnostic] : []),
            ];
            return diagnostics.length === 0
                ? { status: "complete", value, diagnostics }
                : { status: "partial", value, diagnostics };
        },
    });
}
