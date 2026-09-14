import type { ProtocolDiagnosticV1, ProtocolOperationName } from "@oaam/app-server-protocol";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RETAINED_PROJECT_ID = "77777777-7777-4777-8777-777777777777";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const PREVIOUS_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const FILE_ID = "66666666-6666-4666-8666-666666666666";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

export const PROJECT_ASSET_FIXTURE_OPERATIONS: readonly ProtocolOperationName[] = Object.freeze([
    "asset.get",
    "asset_version.get",
    "asset_version.list",
    "asset_version.file_children",
    "asset_version.file_preview",
    "asset_version.text_page",
    "asset_version.compare",
    "asset_version.export",
    "asset_version.export_native",
    "asset.display_update",
    "asset.copy",
    "asset.soft_delete",
    "asset.restore",
    "asset.purge.inspect",
    "asset.purge.commit",
    "state_backup_prompt_policy.replace",
]);

const ACTIVE_PROJECT = Object.freeze({
    projectId: PROJECT_ID,
    displayName: "Open Agent Asset Manager",
    rootPath: "C:\\Work\\open-agent-asset-manager",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
});

const RETAINED_PROJECT = Object.freeze({
    projectId: RETAINED_PROJECT_ID,
    displayName: "Retained workspace",
    rootPath: "C:\\Unavailable\\retained-workspace",
    deleted: true,
    createdAt: 1,
    updatedAt: 2,
});

function asset(deleted: boolean) {
    return Object.freeze({
        assetId: ASSET_ID,
        kind: "Guidance" as const,
        scope: "project" as const,
        projectId: PROJECT_ID,
        scopePath: "",
        displayName: "Project guidance",
        displayDescription: "Portable instructions for this Project",
        currentVersionId: VERSION_ID,
        currentRevision: 2,
        currentFingerprint: DIGEST_A,
        currentVersionStatus: "complete" as const,
        versionIds: Object.freeze([PREVIOUS_VERSION_ID, VERSION_ID]),
        deleted,
        createdAt: 1,
        updatedAt: deleted ? 3 : 2,
    });
}

function version(versionId: string, revision: number) {
    return Object.freeze({
        assetId: ASSET_ID,
        versionId,
        revision,
        status: "complete" as const,
        fingerprint: DIGEST_A,
        originAuthorityFingerprint: DIGEST_B,
        versionCanonicalContentFingerprint: DIGEST_A,
        changeKind: revision === 1 ? ("create" as const) : ("edit" as const),
        sourceVersionId: revision === 1 ? "" : PREVIOUS_VERSION_ID,
        sourceDeploymentId: "",
        changeNote: "",
        fileCount: 1,
        createdAt: revision,
    });
}

const CURRENT_VERSION = version(VERSION_ID, 2);
const PREVIOUS_VERSION = version(PREVIOUS_VERSION_ID, 1);

const ASSET_FILE = Object.freeze({
    fileId: FILE_ID,
    logicalPath: "AGENTS.md",
    role: "entry" as const,
    mediaType: "text/markdown",
    contentKind: "text" as const,
    contentHash: DIGEST_A,
    byteLength: 31,
    executable: false,
});

function complete<T>(value: T) {
    return Object.freeze({ status: "complete" as const, value, diagnostics: Object.freeze([]) });
}

function failed(operation: ProtocolDiagnosticV1["operation"], message: string) {
    return Object.freeze({
        status: "failed" as const,
        diagnostics: Object.freeze([
            Object.freeze({
                severity: "error" as const,
                code: "fixture.review_rejected",
                operation,
                causeKind: "internal_error" as const,
                retryable: true,
                suggestedActions: Object.freeze(["retry"]),
                message,
            }),
        ]),
    });
}

function recordFixtureAction(name: string): void {
    const key = `oaam${name}`;
    const count = Number.parseInt(document.documentElement.dataset[key] ?? "0", 10) + 1;
    document.documentElement.dataset[key] = String(count);
}

export function createProjectAssetFixtureClient(enabled: boolean): Readonly<Record<string, unknown>> {
    if (!enabled) return Object.freeze({});
    let deleted = false;

    return Object.freeze({
        async listProjects() {
            return complete({ projects: Object.freeze([ACTIVE_PROJECT, RETAINED_PROJECT]) });
        },
        async listAssets() {
            return complete({ assets: Object.freeze([asset(deleted)]) });
        },
        async listAssetKindCounts(input: {
            readonly subject: { readonly scope: "global" } | { readonly scope: "project"; readonly projectId: string };
            readonly includeDeleted?: boolean;
        }) {
            const visible =
                input.subject.scope === "project" &&
                input.subject.projectId === PROJECT_ID &&
                (input.includeDeleted === true || !deleted);
            return complete({
                counts: Object.freeze(
                    ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"].map((kind) =>
                        Object.freeze({ kind, count: kind === "Guidance" && visible ? 1 : 0 }),
                    ),
                ),
            });
        },
        async queryAssetLibrary(input: {
            readonly subject: { readonly scope: "global" } | { readonly scope: "project"; readonly projectId: string };
            readonly includeDeleted?: boolean;
        }) {
            const visible =
                input.subject.scope === "project" &&
                input.subject.projectId === PROJECT_ID &&
                (input.includeDeleted === true || !deleted);
            return complete({
                assets: Object.freeze(visible ? [asset(deleted)] : []),
                totalCount: visible ? 1 : 0,
                hasMore: false,
            });
        },
        async inspectProjectLifecycle(input: { readonly action: string }) {
            recordFixtureAction("ProjectInspectionCount");
            document.documentElement.dataset.oaamLastProjectInspectionAction = input.action;
            if (input.action === "restore") {
                return complete({
                    schemaVersion: 1,
                    action: "restore" as const,
                    projectLifecycleReviewToken: "actual-render-project-restore-review",
                    projectId: RETAINED_PROJECT_ID,
                    projectAuthorityFingerprint: DIGEST_A,
                    displayName: RETAINED_PROJECT.displayName,
                    rootPath: RETAINED_PROJECT.rootPath,
                    rootAccessState: "unavailable" as const,
                });
            }
            if (input.action === "rename") {
                return failed("project", "fixture raw Project inspection failure");
            }
            return complete({
                schemaVersion: 1,
                action: "stop_managing" as const,
                projectLifecycleReviewToken: "actual-render-project-stop-review",
                projectId: PROJECT_ID,
                projectAuthorityFingerprint: DIGEST_A,
                displayName: ACTIVE_PROJECT.displayName,
                rootPath: ACTIVE_PROJECT.rootPath,
            });
        },
        async commitProjectLifecycle() {
            return complete(ACTIVE_PROJECT);
        },
        async getAsset() {
            return complete({ found: true, value: asset(deleted) });
        },
        async getAssetVersion(input: { readonly assetId: string; readonly versionId: string }) {
            if (input.assetId !== ASSET_ID || ![VERSION_ID, PREVIOUS_VERSION_ID].includes(input.versionId)) {
                return complete({ found: false as const });
            }
            const selectedVersion = input.versionId === VERSION_ID ? CURRENT_VERSION : PREVIOUS_VERSION;
            return complete({
                found: true as const,
                value: Object.freeze({ ...selectedVersion, files: Object.freeze([ASSET_FILE]) }),
            });
        },
        async listAssetVersions() {
            return complete({
                found: true,
                value: {
                    versions: Object.freeze([CURRENT_VERSION, PREVIOUS_VERSION]),
                    totalCount: 2,
                    hasMore: false,
                },
            });
        },
        async listAssetVersionFileChildren() {
            return complete({
                found: true,
                value: {
                    entries: Object.freeze([
                        Object.freeze({ entryKind: "file" as const, relativeName: "AGENTS.md", file: ASSET_FILE }),
                    ]),
                    totalCount: 1,
                    hasMore: false,
                },
            });
        },
        async readAssetVersionFilePreview() {
            return complete({
                found: true,
                value: {
                    previewKind: "text" as const,
                    file: ASSET_FILE,
                    text: "# Project guidance\n\nKeep facts.",
                    lineCount: 3,
                },
            });
        },
        async readAssetVersionTextPage() {
            return complete({ found: false });
        },
        async compareAssetVersions(_input: unknown, listener?: (update: Readonly<Record<string, unknown>>) => void) {
            recordFixtureAction("AssetComparisonCount");
            listener?.(
                Object.freeze({
                    status: "accepted",
                    operationId: "actual-render-asset-comparison",
                }),
            );
            listener?.(
                Object.freeze({
                    status: "progress",
                    operationId: "actual-render-asset-comparison",
                    sequence: 1,
                    progress: Object.freeze({ stage: "diffing", completedUnits: 1, totalUnits: 1 }),
                }),
            );
            return complete({
                schemaVersion: 1,
                assetId: ASSET_ID,
                left: { versionId: PREVIOUS_VERSION_ID, versionFingerprint: DIGEST_A },
                right: { versionId: VERSION_ID, versionFingerprint: DIGEST_A },
                files: Object.freeze([
                    Object.freeze({
                        logicalPath: ASSET_FILE.logicalPath,
                        changeKind: "modified" as const,
                        left: Object.freeze({ state: "present" as const, file: ASSET_FILE }),
                        right: Object.freeze({ state: "present" as const, file: ASSET_FILE }),
                    }),
                ]),
                selectedFile: Object.freeze({
                    comparisonKind: "text" as const,
                    logicalPath: ASSET_FILE.logicalPath,
                    left: Object.freeze({ state: "present" as const, file: ASSET_FILE }),
                    right: Object.freeze({ state: "present" as const, file: ASSET_FILE }),
                    algorithm: "myers" as const,
                    leftLineCount: 1,
                    rightLineCount: 1,
                    hunks: Object.freeze([
                        Object.freeze({
                            leftStart: 1,
                            leftLineCount: 1,
                            rightStart: 1,
                            rightLineCount: 1,
                            lines: Object.freeze([
                                Object.freeze({ lineKind: "remove" as const, text: "old", leftLine: 1 }),
                                Object.freeze({ lineKind: "add" as const, text: "new", rightLine: 1 }),
                            ]),
                        }),
                    ]),
                }),
            });
        },
        async cancelOperation() {
            return complete({ status: "requested" as const });
        },
        async exportAssetVersion() {
            return complete({
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                versionFingerprint: DIGEST_A,
                archiveIndexFingerprint: DIGEST_B,
                archiveByteLength: 1_024,
            });
        },
        async exportAssetVersionNative() {
            return complete({
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                versionFingerprint: DIGEST_A,
                dialectId: "fixture-native-v1",
                representationFingerprint: DIGEST_B,
                fileCount: 1,
                archiveByteLength: 512,
            });
        },
        async updateAssetDisplay(input: { readonly displayName: string; readonly displayDescription: string }) {
            return complete({ ...asset(deleted), ...input });
        },
        async copyAsset() {
            return complete({ asset: asset(deleted), version: CURRENT_VERSION });
        },
        async softDeleteAsset() {
            recordFixtureAction("AssetDeleteCount");
            deleted = true;
            return complete(asset(true));
        },
        async restoreAsset() {
            deleted = false;
            return complete(asset(false));
        },
        async inspectAssetPurge() {
            recordFixtureAction("AssetPurgeInspectionCount");
            return complete({
                schemaVersion: 1,
                action: "purge" as const,
                assetId: ASSET_ID,
                assetManifestFingerprint: DIGEST_A,
                assetDirectoryIdentityFingerprint: DIGEST_B,
                kind: "Guidance" as const,
                scope: "project" as const,
                projectId: PROJECT_ID,
                scopePath: "",
                displayName: "Project guidance",
                versionCount: 2,
                promotionGrantCount: 1,
            });
        },
        async replaceStateBackupPromptPolicy(input: { readonly mode: string }) {
            return complete({
                configVersion: 1,
                settingId: "state_backup_prompt_policy_v1",
                revision: 1,
                mode: input.mode,
                updatedAt: 2,
                settingFingerprint: DIGEST_B,
            });
        },
        async commitAssetPurge() {
            recordFixtureAction("AssetPurgeCommitCount");
            return failed("asset", "fixture raw Asset purge failure");
        },
    });
}
