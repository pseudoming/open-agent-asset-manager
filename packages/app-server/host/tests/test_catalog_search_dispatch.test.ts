import { createProtocolRequest } from "@oaam/app-server-protocol";
import type { CatalogSearchResult } from "@oaam/core";
import { describe, expect, it, vi } from "vitest";
import { dispatchH1Immediate } from "../src/dispatch-registry";
import { ASSET_ID, PROJECT_ID, VERSION_ID, complete, fakeCoreWith } from "./support/host-test-fixtures";

describe("Host catalog search dispatch", () => {
    it("projects grouped Core results without interpreting plain-text snippets", () => {
        const result = {
            projects: {
                items: [
                    {
                        projectId: PROJECT_ID,
                        displayName: "Project",
                        rootPath: "/project",
                        deleted: false,
                        matchedField: "display_name",
                        snippet: "Project",
                    },
                ],
                totalCount: 1,
            },
            assets: {
                items: [
                    {
                        assetId: ASSET_ID,
                        kind: "Guidance",
                        scope: "global",
                        projectId: "",
                        scopePath: "",
                        displayName: "Guidance",
                        matchedField: "display_name",
                        snippet: "<script>plain text</script>",
                    },
                    {
                        assetId: VERSION_ID,
                        kind: "Skill",
                        scope: "project",
                        projectId: PROJECT_ID,
                        scopePath: "skills",
                        displayName: "Review",
                        matchedField: "text_content",
                        logicalPath: "SKILL.md",
                        snippet: "review body",
                    },
                ],
                totalCount: 2,
            },
        } as CatalogSearchResult;
        const searchCatalog = vi.fn(() => complete(result));
        const response = dispatchH1Immediate(
            fakeCoreWith({ searchCatalog }),
            createProtocolRequest("search-1", "catalog.search", { query: "review", limitPerGroup: 8 }),
        );

        expect(response).toMatchObject({
            result: {
                value: {
                    projects: { totalCount: 1 },
                    assets: {
                        items: [
                            {
                                assetId: ASSET_ID,
                                matchedField: "display_name",
                                snippet: "<script>plain text</script>",
                            },
                            {
                                assetId: VERSION_ID,
                                projectId: PROJECT_ID,
                                matchedField: "text_content",
                                logicalPath: "SKILL.md",
                            },
                        ],
                        totalCount: 2,
                    },
                },
            },
        });
        expect(searchCatalog).toHaveBeenCalledWith({ query: "review", limitPerGroup: 8 });
    });
});
