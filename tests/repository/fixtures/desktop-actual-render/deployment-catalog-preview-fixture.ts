import { createDeploymentAssetSelectionFixture } from "../deployment-asset-selection-fixture";

interface DeploymentCatalogPreviewFixtureOptions {
    readonly journeyMode: boolean;
    readonly deploymentMode: boolean;
    readonly assetChoiceCount: 1 | 15;
    readonly projectId: string;
    readonly assetId: string;
    readonly versionId: string;
    readonly digest: string;
    readonly projectRootPath: string;
}

export function createDeploymentCatalogPreviewFixtureClient(
    options: DeploymentCatalogPreviewFixtureOptions,
): Readonly<Record<string, unknown>> {
    const summaries = () =>
        createDeploymentAssetSelectionFixture({
            count: options.deploymentMode ? options.assetChoiceCount : 1,
            projectId: options.projectId,
            assetId: options.assetId,
            versionId: options.versionId,
            digest: options.digest,
        });

    async function getAssetVersion(input: { readonly assetId: string; readonly versionId: string }) {
        const summary = summaries().find(
            (candidate) => candidate.assetId === input.assetId && candidate.currentVersionId === input.versionId,
        );
        if (summary === undefined) {
            return { status: "complete" as const, value: { found: false as const }, diagnostics: [] };
        }
        const logicalPath = summary.kind === "Skill" ? "SKILL.md" : "AGENTS.md";
        return {
            status: "complete" as const,
            value: {
                found: true as const,
                value: {
                    assetId: summary.assetId,
                    versionId: summary.currentVersionId,
                    revision: summary.currentRevision,
                    status: summary.currentVersionStatus,
                    versionCanonicalContentFingerprint: summary.currentFingerprint,
                    files: [
                        {
                            fileId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                            logicalPath,
                            role: "entry" as const,
                            mediaType: "text/markdown",
                            contentKind: "text" as const,
                            contentHash: options.digest,
                            byteLength: 28,
                            executable: false,
                        },
                    ],
                    ...(options.deploymentMode
                        ? {
                              importSource: {
                                  adapterId: "CLAUDECODE",
                                  sourceSnapshotFingerprint: options.digest,
                                  roots: [
                                      {
                                          sourceRootId: "actual-render-project-source",
                                          rootRole: "project_actual" as const,
                                          sourceDomain: "project_root" as const,
                                          canonicalPath: options.projectRootPath,
                                      },
                                  ],
                                  files: [
                                      {
                                          sourceRootId: "actual-render-project-source",
                                          relativePath: logicalPath,
                                          contentHash: options.digest,
                                      },
                                  ],
                              },
                          }
                        : {}),
                    createdAt: summary.updatedAt,
                },
            },
            diagnostics: [],
        };
    }

    return Object.freeze({
        async listAssets() {
            return {
                status: "complete" as const,
                value: { assets: options.journeyMode ? [] : summaries() },
                diagnostics: [],
            };
        },
        async getAsset(input: { readonly assetId: string }) {
            const summary = summaries().find((candidate) => candidate.assetId === input.assetId);
            return {
                status: "complete" as const,
                value:
                    summary === undefined
                        ? { found: false as const }
                        : { found: true as const, value: { ...summary, versionIds: [summary.currentVersionId] } },
                diagnostics: [],
            };
        },
        async listAssetVersions(input: { readonly assetId: string }) {
            const summary = summaries().find((candidate) => candidate.assetId === input.assetId);
            return {
                status: "complete" as const,
                value:
                    summary === undefined
                        ? { found: false as const }
                        : {
                              found: true as const,
                              value: {
                                  versions: [
                                      {
                                          assetId: summary.assetId,
                                          versionId: summary.currentVersionId,
                                          revision: summary.currentRevision,
                                          status: summary.currentVersionStatus,
                                          fingerprint: summary.currentFingerprint,
                                          originAuthorityFingerprint: summary.currentFingerprint,
                                          versionCanonicalContentFingerprint: summary.currentFingerprint,
                                          changeKind: "create" as const,
                                          sourceVersionId: "",
                                          sourceDeploymentId: "",
                                          changeNote: "",
                                          fileCount: 1,
                                          createdAt: summary.updatedAt,
                                      },
                                  ],
                                  totalCount: 1,
                                  hasMore: false,
                              },
                          },
                diagnostics: [],
            };
        },
        async listAssetVersionFileChildren(input: {
            readonly assetId: string;
            readonly versionId: string;
            readonly directoryPath: string;
        }) {
            const versionResult = await getAssetVersion(input);
            if (!versionResult.value.found) return versionResult;
            const files = input.directoryPath === "" ? versionResult.value.value.files : [];
            return {
                status: "complete" as const,
                value: {
                    found: true as const,
                    value: {
                        entries: files.map((file) => ({
                            entryKind: "file" as const,
                            relativeName: file.logicalPath,
                            file,
                        })),
                        totalCount: files.length,
                        hasMore: false,
                    },
                },
                diagnostics: [],
            };
        },
        getAssetVersion,
        async readAssetVersionFilePreview(input: {
            readonly assetId: string;
            readonly versionId: string;
            readonly logicalPath: string;
        }) {
            const versionResult = await getAssetVersion(input);
            if (!versionResult.value.found) return versionResult;
            const file = versionResult.value.value.files.find((candidate) => candidate.logicalPath === input.logicalPath);
            return {
                status: "complete" as const,
                value:
                    file === undefined
                        ? { found: false as const }
                        : {
                              found: true as const,
                              value: {
                                  previewKind: "text" as const,
                                  file,
                                  text: `# ${input.logicalPath}\n\nPortable guide content.`,
                                  lineCount: 3,
                              },
                          },
                diagnostics: [],
            };
        },
    });
}
