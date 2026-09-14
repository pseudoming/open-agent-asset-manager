interface DeploymentAssetSelectionFixtureInput {
    readonly count: 1 | 15;
    readonly projectId: string;
    readonly assetId: string;
    readonly versionId: string;
    readonly digest: string;
}

export function createDeploymentAssetSelectionFixture(input: DeploymentAssetSelectionFixtureInput) {
    if (input.count === 1) {
        return [
            {
                assetId: input.assetId,
                kind: "Guidance" as const,
                scope: "project" as const,
                projectId: input.projectId,
                scopePath: "",
                displayName: "Guide map",
                displayDescription: "Portable guide content",
                currentVersionId: input.versionId,
                currentRevision: 1,
                currentFingerprint: input.digest,
                currentVersionStatus: "complete" as const,
                deleted: false,
                createdAt: 1,
                updatedAt: 2,
            },
        ];
    }
    return Array.from({ length: input.count }, (_, index) => {
        const suffix = String(index + 1).padStart(12, "0");
        return {
            assetId: index === 0 ? input.assetId : `cccccccc-cccc-4ccc-8ccc-${suffix}`,
            kind: index % 2 === 0 ? ("Guidance" as const) : ("Skill" as const),
            scope: index % 3 === 0 ? ("project" as const) : ("global" as const),
            ...(index % 3 === 0 ? { projectId: input.projectId } : {}),
            scopePath: "",
            displayName: index === 4 || index === 5 ? "Repeated display name" : `Guide map ${String(index + 1)}`,
            displayDescription: "Portable guide content",
            currentVersionId: index === 0 ? input.versionId : `dddddddd-dddd-4ddd-8ddd-${suffix}`,
            currentRevision: 1,
            currentFingerprint: input.digest,
            currentVersionStatus: "complete" as const,
            deleted: false,
            createdAt: index + 1,
            updatedAt: index + 2,
        };
    });
}
