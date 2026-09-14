import { UUID_A, UUID_B } from "./protocol-fixture-primitives";

export const CATALOG_SEARCH_RESULT = Object.freeze({
    projects: {
        items: [
            {
                projectId: UUID_A,
                displayName: "Project",
                rootPath: "/workspace/project",
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
                assetId: UUID_A,
                kind: "Guidance",
                scope: "project",
                projectId: UUID_B,
                scopePath: "",
                displayName: "Guidance",
                matchedField: "text_content",
                logicalPath: "AGENTS.md",
                snippet: "Project guidance",
            },
        ],
        totalCount: 1,
    },
});
