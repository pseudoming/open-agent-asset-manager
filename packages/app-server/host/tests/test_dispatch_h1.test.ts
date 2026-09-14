import { createProtocolRequest } from "@oaam/app-server-protocol";
import type {
    AssetKindCount,
    AssetPurgeResultV1,
    AssetSummaryPage,
    AssetVersionFilePreview,
    AssetVersionFileTreePage,
    AssetVersionPage,
    AssetVersionTextPage,
    AssetVersionComparisonV1,
    CopyAssetVersionToLocationResultV1,
    ExportAssetVersionToFileResultV1,
    RenderAnalysisView,
} from "@oaam/core";
import { describe, expect, it, vi } from "vitest";
import {
    dispatchH1Immediate,
    dispatchH1Long,
    HOST_H1_IMMEDIATE_OPERATIONS,
    HOST_H1_LONG_OPERATIONS,
    isH1LongOperation,
} from "../src/dispatch-registry";
import { HostPathSelectionStore } from "../src/path-selection-store";
import {
    ASSET_ID,
    DIGEST,
    PROJECT_ID,
    SHA,
    VERSION_ID,
    asset,
    complete,
    deployment,
    enablement,
    fakeCoreWith,
    fullAccess,
    grant,
    project,
    provider,
    purgePreparation,
    versionManifest,
    watched,
} from "./support/host-test-fixtures";

function resultOf(value: ReturnType<typeof dispatchH1Immediate>) {
    expect(value).not.toBeNull();
    return value as Exclude<typeof value, null>;
}

describe("H1 closed immediate dispatch", () => {
    it("routes every H1 query to the exact Core method and projects its result", () => {
        const getAvailablePlatformContexts = vi.fn(() =>
            complete([{ platform: "linux" as const, platformInstanceId: "local", accessRootPath: "/" }]),
        );
        const listAdapterProviders = vi.fn(() => complete([provider]));
        const getAdapterEnablement = vi.fn(() => complete(enablement));
        const getWatchedScanIntent = vi.fn(() => complete(watched));
        const listProjects = vi.fn(() => complete([project]));
        const getProject = vi.fn(() => complete({ found: true, value: project }));
        const listAssets = vi.fn(() => complete([]));
        const getAsset = vi.fn(() => complete({ found: true, value: asset }));
        const getVersion = vi.fn(() => {
            throw new Error("payload-heavy compatibility read must not serve the Asset library");
        });
        const getVersionManifest = vi.fn(() => complete({ found: true, value: versionManifest }));
        const listAssetKindCounts = vi.fn(() =>
            complete<AssetKindCount[]>([
                { kind: "Guidance", count: 1 },
                { kind: "Rule", count: 0 },
                { kind: "Workflow", count: 0 },
                { kind: "Skill", count: 0 },
                { kind: "Subagent", count: 0 },
                { kind: "Memory", count: 0 },
            ]),
        );
        const queryAssetSummaryPage = vi.fn(() =>
            complete<AssetSummaryPage>({
                items: [],
                totalCount: 0,
                hasMore: true,
                nextCursor: "asset-cursor",
            }),
        );
        const listAssetVersionPage = vi.fn(() =>
            complete({
                found: true as const,
                value: {
                    items: [
                        {
                            assetId: ASSET_ID,
                            versionId: VERSION_ID,
                            revision: 1,
                            status: "complete",
                            fingerprint: DIGEST,
                            originAuthorityFingerprint: DIGEST,
                            versionCanonicalContentFingerprint: DIGEST,
                            changeKind: "create",
                            sourceVersionId: "",
                            sourceDeploymentId: "",
                            changeNote: "",
                            fileCount: 0,
                            createdAt: 1,
                        },
                    ],
                    totalCount: 1,
                    hasMore: false as const,
                } satisfies AssetVersionPage,
            }),
        );
        const listAssetVersionFileChildren = vi.fn(() =>
            complete({
                found: true as const,
                value: {
                    entries: [],
                    totalCount: 0,
                    hasMore: false as const,
                } satisfies AssetVersionFileTreePage,
            }),
        );
        const readAssetVersionFilePreview = vi.fn(() =>
            complete({
                found: true as const,
                value: {
                    previewKind: "binary",
                    file: {
                        fileId: PROJECT_ID,
                        logicalPath: "artifact.bin",
                        role: "resource",
                        contentHash: DIGEST,
                        contentKind: "binary",
                        mediaType: "application/octet-stream",
                        byteSize: 4,
                        executable: false,
                        references: [],
                    },
                } satisfies AssetVersionFilePreview,
            }),
        );
        const readAssetVersionTextPage = vi.fn(() =>
            complete({
                found: true as const,
                value: {
                    file: {
                        fileId: PROJECT_ID,
                        logicalPath: "guide.md",
                        role: "entry",
                        contentHash: DIGEST,
                        contentKind: "text",
                        mediaType: "text/markdown",
                        byteSize: 7,
                        executable: false,
                        references: [],
                    },
                    text: "guide\n",
                    loadedByteStart: 0,
                    loadedByteEnd: 6,
                    totalBytes: 6,
                    firstLine: 1,
                    lastLine: 2,
                    totalLines: 2,
                    hasMore: false as const,
                } satisfies AssetVersionTextPage,
            }),
        );
        const inspectAssetPurge = vi.fn(() => complete(purgePreparation));
        const listDeployments = vi.fn(() => complete([deployment]));
        const getDeployment = vi.fn(() => complete({ found: true, value: deployment }));
        const listPromotionGrantViews = vi.fn(() =>
            complete([{ ...grant, targetDescription: { status: "unavailable" as const } }]),
        );
        const getRestrictedSourcePromotionFullAccess = vi.fn(() => complete(fullAccess));
        const core = fakeCoreWith({
            getAvailablePlatformContexts,
            listAdapterProviders,
            getAdapterEnablement,
            getWatchedScanIntent,
            listProjects,
            getProject,
            listAssets,
            getAsset,
            getVersion,
            getVersionManifest,
            listAssetKindCounts,
            queryAssetSummaryPage,
            listAssetVersionPage,
            listAssetVersionFileChildren,
            readAssetVersionFilePreview,
            readAssetVersionTextPage,
            inspectAssetPurge,
            listDeployments,
            getDeployment,
            listPromotionGrantViews,
            getRestrictedSourcePromotionFullAccess,
        });

        expect(
            resultOf(dispatchH1Immediate(core, createProtocolRequest("1", "environment.list", { platforms: ["linux"] }))),
        ).toMatchObject({ result: { value: { environments: [{ displayName: "linux:local" }] } } });
        expect(resultOf(dispatchH1Immediate(core, createProtocolRequest("2", "adapter_provider.list", {})))).toMatchObject({
            result: { value: { providers: [{ adapterId: "CLAUDECODE" }] } },
        });
        expect(resultOf(dispatchH1Immediate(core, createProtocolRequest("3", "adapter_enablement.get", {})))).toMatchObject({
            result: { value: { revision: 0 } },
        });
        expect(resultOf(dispatchH1Immediate(core, createProtocolRequest("4", "watched_scan_intent.get", {})))).toMatchObject({
            result: { value: { revision: 0 } },
        });
        expect(
            resultOf(dispatchH1Immediate(core, createProtocolRequest("5", "project.list", { includeDeleted: true }))),
        ).toMatchObject({ result: { value: { projects: [{ projectId: PROJECT_ID }] } } });
        expect(
            resultOf(dispatchH1Immediate(core, createProtocolRequest("6", "project.get", { projectId: PROJECT_ID }))),
        ).toMatchObject({ result: { value: { found: true, value: { projectId: PROJECT_ID } } } });
        expect(
            resultOf(dispatchH1Immediate(core, createProtocolRequest("7", "asset.list", { includeDeleted: true }))),
        ).toMatchObject({ result: { value: { assets: [] } } });
        expect(resultOf(dispatchH1Immediate(core, createProtocolRequest("8", "asset.get", { assetId: ASSET_ID })))).toMatchObject(
            { result: { value: { found: true, value: { assetId: ASSET_ID } } } },
        );
        expect(
            resultOf(
                dispatchH1Immediate(
                    core,
                    createProtocolRequest("9", "asset_version.get", { assetId: ASSET_ID, versionId: VERSION_ID }),
                ),
            ),
        ).toMatchObject({ result: { value: { found: true, value: { versionId: VERSION_ID } } } });
        expect(
            resultOf(
                dispatchH1Immediate(
                    core,
                    createProtocolRequest("9a", "asset_library.kind_counts", {
                        subject: { scope: "global" },
                        keywords: "",
                    }),
                ),
            ),
        ).toMatchObject({
            result: { value: { counts: expect.arrayContaining([{ kind: "Guidance", count: 1 }]) } },
        });
        expect(
            resultOf(
                dispatchH1Immediate(
                    core,
                    createProtocolRequest("9b", "asset_library.page", {
                        subject: { scope: "project", projectId: PROJECT_ID },
                        kind: "Guidance",
                        keywords: "guide",
                        includeDeleted: true,
                        pageSize: 5,
                        cursor: "previous",
                    }),
                ),
            ),
        ).toMatchObject({ result: { value: { hasMore: true, nextCursor: "asset-cursor" } } });
        expect(
            resultOf(
                dispatchH1Immediate(
                    core,
                    createProtocolRequest("9c", "asset_version.list", {
                        assetId: ASSET_ID,
                        pageSize: 5,
                        cursor: "version-cursor",
                    }),
                ),
            ),
        ).toMatchObject({ result: { value: { found: true, value: { totalCount: 1 } } } });
        expect(
            resultOf(
                dispatchH1Immediate(
                    core,
                    createProtocolRequest("9d", "asset_version.file_children", {
                        assetId: ASSET_ID,
                        versionId: VERSION_ID,
                        directoryPath: "",
                        pageSize: 5,
                        cursor: "file-cursor",
                    }),
                ),
            ),
        ).toMatchObject({ result: { value: { found: true, value: { totalCount: 0 } } } });
        expect(
            resultOf(
                dispatchH1Immediate(
                    core,
                    createProtocolRequest("9e", "asset_version.file_preview", {
                        assetId: ASSET_ID,
                        versionId: VERSION_ID,
                        logicalPath: "artifact.bin",
                    }),
                ),
            ),
        ).toMatchObject({ result: { value: { found: true, value: { previewKind: "binary" } } } });
        expect(
            resultOf(
                dispatchH1Immediate(
                    core,
                    createProtocolRequest("9e2", "asset_version.text_page", {
                        assetId: ASSET_ID,
                        versionId: VERSION_ID,
                        logicalPath: "guide.md",
                    }),
                ),
            ),
        ).toMatchObject({ result: { value: { found: true, value: { text: "guide\n", hasMore: false } } } });
        resultOf(
            dispatchH1Immediate(
                core,
                createProtocolRequest("9e2b", "asset_version.text_page", {
                    assetId: ASSET_ID,
                    versionId: VERSION_ID,
                    logicalPath: "guide.md",
                    cursor: "next-text",
                }),
            ),
        );
        expect(
            resultOf(dispatchH1Immediate(core, createProtocolRequest("9e3", "asset.purge.inspect", { assetId: ASSET_ID }))),
        ).toMatchObject({
            result: {
                value: {
                    assetId: ASSET_ID,
                    assetManifestFingerprint: "a".repeat(64),
                    assetDirectoryIdentityFingerprint: "a".repeat(64),
                },
            },
        });
        resultOf(
            dispatchH1Immediate(
                core,
                createProtocolRequest("9f", "asset_library.kind_counts", {
                    subject: { scope: "project", projectId: PROJECT_ID },
                    keywords: "",
                    includeDeleted: false,
                }),
            ),
        );
        resultOf(
            dispatchH1Immediate(
                core,
                createProtocolRequest("9g", "asset_library.page", {
                    subject: { scope: "global" },
                    kind: "Guidance",
                    keywords: "",
                }),
            ),
        );
        resultOf(dispatchH1Immediate(core, createProtocolRequest("9h", "asset_version.list", { assetId: ASSET_ID })));
        resultOf(
            dispatchH1Immediate(
                core,
                createProtocolRequest("9i", "asset_version.file_children", {
                    assetId: ASSET_ID,
                    versionId: VERSION_ID,
                    directoryPath: "",
                }),
            ),
        );
        expect(
            resultOf(
                dispatchH1Immediate(
                    core,
                    createProtocolRequest("10", "deployment.list", {
                        subject: { subjectKind: "project", projectId: PROJECT_ID },
                        includeDeleted: true,
                        stage: "in_sync",
                    }),
                ),
            ),
        ).toMatchObject({ result: { value: { deployments: [{ deploymentId: VERSION_ID }] } } });
        resultOf(
            dispatchH1Immediate(core, createProtocolRequest("10g", "deployment.list", { subject: { subjectKind: "global" } })),
        );
        resultOf(dispatchH1Immediate(core, createProtocolRequest("10b", "deployment.list", {})));
        expect(
            resultOf(dispatchH1Immediate(core, createProtocolRequest("11", "deployment.get", { deploymentId: VERSION_ID }))),
        ).toMatchObject({ result: { value: { found: true, value: { deploymentId: VERSION_ID } } } });
        expect(
            resultOf(dispatchH1Immediate(core, createProtocolRequest("12", "promotion_grant.list", { assetId: ASSET_ID }))),
        ).toMatchObject({ result: { value: { grants: [{ promotionGrantId: PROJECT_ID }] } } });
        expect(
            resultOf(dispatchH1Immediate(core, createProtocolRequest("13", "restricted_source_full_access.get", {}))),
        ).toMatchObject({ result: { value: { state: "disabled" } } });

        expect(getAvailablePlatformContexts).toHaveBeenCalledWith(["linux"]);
        expect(listProjects).toHaveBeenCalledWith({ includeDeleted: true });
        expect(getProject).toHaveBeenCalledWith(PROJECT_ID);
        expect(listAssets).toHaveBeenCalledWith({ includeDeleted: true });
        expect(getVersion).not.toHaveBeenCalled();
        expect(getVersionManifest).toHaveBeenCalledWith({ assetId: ASSET_ID, versionId: VERSION_ID });
        expect(listAssetKindCounts).toHaveBeenCalledWith({ subject: { scope: "global" }, keywords: "" });
        expect(listAssetKindCounts).toHaveBeenCalledWith({
            subject: { scope: "project", projectId: PROJECT_ID },
            keywords: "",
            includeDeleted: false,
        });
        expect(queryAssetSummaryPage).toHaveBeenCalledWith({
            subject: { scope: "project", projectId: PROJECT_ID },
            kind: "Guidance",
            keywords: "guide",
            includeDeleted: true,
            pageSize: 5,
            cursor: "previous",
        });
        expect(listAssetVersionPage).toHaveBeenCalledWith({
            assetId: ASSET_ID,
            pageSize: 5,
            cursor: "version-cursor",
        });
        expect(listAssetVersionFileChildren).toHaveBeenCalledWith({
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            directoryPath: "",
            pageSize: 5,
            cursor: "file-cursor",
        });
        expect(queryAssetSummaryPage).toHaveBeenCalledWith({
            subject: { scope: "global" },
            kind: "Guidance",
            keywords: "",
        });
        expect(listAssetVersionPage).toHaveBeenCalledWith({ assetId: ASSET_ID });
        expect(listAssetVersionFileChildren).toHaveBeenCalledWith({
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            directoryPath: "",
        });
        expect(readAssetVersionFilePreview).toHaveBeenCalledWith({
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            logicalPath: "artifact.bin",
        });
        expect(inspectAssetPurge).toHaveBeenCalledWith(ASSET_ID);
        expect(listDeployments).toHaveBeenCalledWith({
            projectId: PROJECT_ID,
            includeDeleted: true,
            stage: "in_sync",
        });
        expect(listDeployments).toHaveBeenNthCalledWith(2, { projectId: "" });
        expect(listDeployments).toHaveBeenLastCalledWith({});
    });

    it("routes every H1 mutation and preserves Core CAS/user-action inputs", () => {
        const replaceAdapterEnablement = vi.fn(() => complete(enablement));
        const resetWatchedScanIntent = vi.fn(() => complete(watched));
        const updateDeploymentInputs = vi.fn(() => complete(deployment));
        const softDeleteDeployment = vi.fn(() => complete(deployment));
        const createPromotionGrant = vi.fn(() => complete(grant));
        const revokePromotionGrant = vi.fn(() => complete(grant));
        const setRestrictedSourcePromotionFullAccess = vi.fn(() => complete(fullAccess));
        const updateAssetDisplay = vi.fn(() => complete({ ...asset, displayName: "Renamed Guidance" }));
        const copiedAsset = {
            ...asset,
            assetId: PROJECT_ID,
            displayName: "Copied Guidance",
        } as AssetManifestV1;
        const copiedVersion = {
            ...versionManifest,
            assetId: PROJECT_ID,
        } as AssetVersionManifestV2;
        const copyAssetVersionToLocation = vi.fn(() =>
            complete<CopyAssetVersionToLocationResultV1>({
                source: { assetId: ASSET_ID, versionId: VERSION_ID },
                asset: copiedAsset,
                version: copiedVersion,
            }),
        );
        const softDeleteAsset = vi.fn(() => complete({ ...asset, deleted: true }));
        const restoreAsset = vi.fn(() => complete(asset));
        const core = fakeCoreWith({
            replaceAdapterEnablement,
            resetWatchedScanIntent,
            updateDeploymentInputs,
            softDeleteDeployment,
            createPromotionGrant,
            revokePromotionGrant,
            setRestrictedSourcePromotionFullAccess,
            updateAssetDisplay,
            copyAssetVersionToLocation,
            softDeleteAsset,
            restoreAsset,
        });

        resultOf(
            dispatchH1Immediate(
                core,
                createProtocolRequest("1", "adapter_enablement.replace", {
                    expectedRevision: 0,
                    expectedSettingFingerprint: "a".repeat(64),
                    enabledAdapterIds: ["CLAUDECODE"],
                    userActionId: "user",
                }),
            ),
        );
        resultOf(
            dispatchH1Immediate(
                core,
                createProtocolRequest("10", "asset.display.update", {
                    assetId: ASSET_ID,
                    displayName: "Renamed Guidance",
                    displayDescription: "Updated",
                }),
            ),
        );
        resultOf(
            dispatchH1Immediate(
                core,
                createProtocolRequest("11", "asset.copy", {
                    source: {
                        assetId: ASSET_ID,
                        versionId: VERSION_ID,
                        versionFingerprint: "a".repeat(64),
                        originAuthorityFingerprint: "b".repeat(64),
                    },
                    destination: { scope: "global", scopePath: "shared" },
                    displayName: "Copied Guidance",
                    displayDescription: "Reusable copy",
                    userActionId: "copy-review",
                }),
            ),
        );
        resultOf(
            dispatchH1Immediate(
                core,
                createProtocolRequest("11b", "asset.copy", {
                    source: {
                        assetId: ASSET_ID,
                        versionId: VERSION_ID,
                        versionFingerprint: "a".repeat(64),
                        originAuthorityFingerprint: "b".repeat(64),
                    },
                    destination: { scope: "project", projectId: PROJECT_ID, scopePath: "project-copy" },
                    displayName: "Project Copy",
                    displayDescription: "Project placement",
                    userActionId: "copy-project-review",
                }),
            ),
        );
        resultOf(dispatchH1Immediate(core, createProtocolRequest("12", "asset.soft_delete", { assetId: ASSET_ID })));
        resultOf(dispatchH1Immediate(core, createProtocolRequest("13", "asset.restore", { assetId: ASSET_ID })));
        resultOf(
            dispatchH1Immediate(
                core,
                createProtocolRequest("2", "watched_scan_intent.reset", {
                    expectedRevision: 0,
                    expectedSettingFingerprint: "a".repeat(64),
                    userActionId: "user",
                }),
            ),
        );
        resultOf(
            dispatchH1Immediate(
                core,
                createProtocolRequest("3", "deployment.update_inputs", {
                    deploymentId: VERSION_ID,
                    consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                    assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: true }],
                }),
            ),
        );
        resultOf(dispatchH1Immediate(core, createProtocolRequest("4", "deployment.update_inputs", { deploymentId: VERSION_ID })));
        resultOf(dispatchH1Immediate(core, createProtocolRequest("5", "deployment.soft_delete", { deploymentId: VERSION_ID })));
        resultOf(
            dispatchH1Immediate(
                core,
                createProtocolRequest("6", "promotion_grant.create", {
                    promotionAction: "grant_current_version_current_target",
                    assetId: ASSET_ID,
                    versionId: VERSION_ID,
                    target: { targetKind: "project", projectId: PROJECT_ID },
                    userActionId: "user",
                }),
            ),
        );
        resultOf(
            dispatchH1Immediate(
                core,
                createProtocolRequest("7", "promotion_grant.create", {
                    promotionAction: "grant_asset_all_versions_current_target",
                    assetId: ASSET_ID,
                    target: {
                        targetKind: "global_target",
                        targetAuthorityFingerprint: "b".repeat(64),
                    },
                    userActionId: "user",
                }),
            ),
        );
        resultOf(
            dispatchH1Immediate(
                core,
                createProtocolRequest("8", "promotion_grant.revoke", {
                    promotionGrantId: PROJECT_ID,
                    expectedRevision: 1,
                    expectedGrantFingerprint: "c".repeat(64),
                    userActionId: "user",
                }),
            ),
        );
        resultOf(
            dispatchH1Immediate(
                core,
                createProtocolRequest("9", "restricted_source_full_access.set", {
                    expectedRevision: 0,
                    expectedSettingFingerprint: "d".repeat(64),
                    nextState: "enabled",
                    userActionId: "user",
                }),
            ),
        );

        expect(replaceAdapterEnablement).toHaveBeenCalledWith({
            expectedRevision: 0,
            expectedSettingFingerprint: `sha256:${"a".repeat(64)}`,
            enabledAdapterIds: ["CLAUDECODE"],
            userActionId: "user",
        });
        expect(resetWatchedScanIntent).toHaveBeenCalledWith({
            expectedRevision: 0,
            expectedSettingFingerprint: `sha256:${"a".repeat(64)}`,
            userActionId: "user",
        });
        expect(updateDeploymentInputs).toHaveBeenNthCalledWith(1, VERSION_ID, {
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: true }],
        });
        expect(updateDeploymentInputs).toHaveBeenNthCalledWith(2, VERSION_ID, {});
        expect(createPromotionGrant).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                promotionAction: "grant_current_version_current_target",
                versionId: VERSION_ID,
                target: { targetKind: "project", projectId: PROJECT_ID },
            }),
        );
        expect(createPromotionGrant).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                promotionAction: "grant_asset_all_versions_current_target",
                target: {
                    targetKind: "global_target",
                    targetAuthorityFingerprint: `sha256:${"b".repeat(64)}`,
                },
            }),
        );
        expect(revokePromotionGrant).toHaveBeenCalledWith({
            promotionGrantId: PROJECT_ID,
            expectedRevision: 1,
            expectedGrantFingerprint: `sha256:${"c".repeat(64)}`,
            userActionId: "user",
        });
        expect(setRestrictedSourcePromotionFullAccess).toHaveBeenCalledWith({
            settingId: "restricted_source_promotion_full_access_v1",
            expectedRevision: 0,
            expectedSettingFingerprint: `sha256:${"d".repeat(64)}`,
            nextState: "enabled",
            userActionId: "user",
        });
        expect(updateAssetDisplay).toHaveBeenCalledWith(ASSET_ID, {
            displayName: "Renamed Guidance",
            displayDescription: "Updated",
        });
        expect(copyAssetVersionToLocation).toHaveBeenCalledWith({
            source: {
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                versionFingerprint: DIGEST,
                originAuthorityFingerprint: `sha256:${"b".repeat(64)}`,
            },
            destination: { scope: "global", projectId: "", scopePath: "shared" },
            displayName: "Copied Guidance",
            displayDescription: "Reusable copy",
            userActionEvidenceId: "copy-review",
        });
        expect(copyAssetVersionToLocation).toHaveBeenCalledWith({
            source: {
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                versionFingerprint: DIGEST,
                originAuthorityFingerprint: `sha256:${"b".repeat(64)}`,
            },
            destination: { scope: "project", projectId: PROJECT_ID, scopePath: "project-copy" },
            displayName: "Project Copy",
            displayDescription: "Project placement",
            userActionEvidenceId: "copy-project-review",
        });
        expect(softDeleteAsset).toHaveBeenCalledWith(ASSET_ID);
        expect(restoreAsset).toHaveBeenCalledWith(ASSET_ID);
    });

    it("returns null for H2 operations and redacts a throwing H1 Core call", () => {
        expect(
            dispatchH1Immediate(
                fakeCoreWith({}),
                createProtocolRequest("1", "project.register", { localPathSelectionToken: "path" }),
            ),
        ).toBeNull();
        const response = dispatchH1Immediate(
            fakeCoreWith({
                listProjects() {
                    throw new Error("secret");
                },
            }),
            createProtocolRequest("2", "project.list", {}),
        );
        expect(JSON.stringify(response)).toContain("host.core_invocation_failed");
        expect(JSON.stringify(response)).not.toContain("secret");
        expect(HOST_H1_IMMEDIATE_OPERATIONS).toHaveLength(32);
    });
});

describe("H1 accepted-long Core dispatch", () => {
    it("routes render analysis, scan, recover, reverse and reindex with exact Core inputs", async () => {
        const analysis = {
            renderInputFingerprint: DIGEST,
            requiredSemantics: [],
            analyses: [],
        } as RenderAnalysisView;
        const analyzeDeploymentRender = vi.fn(async () => complete(analysis));
        const scanDeployment = vi.fn(async () => complete(deployment));
        const recoverDeployment = vi.fn(async () => complete(deployment));
        const commitRenderedTargetAccept = vi.fn(async () =>
            complete({ commitState: "committed" as const, version: { assetId: ASSET_ID, versionId: VERSION_ID } }),
        );
        const cancelRenderedTargetAccept = vi.fn(async () => complete(undefined));
        const reindexAssets = vi.fn(() => complete({ scannedAssets: 1, indexedAssets: 1, skippedAssets: 0, diagnostics: [] }));
        const comparison: AssetVersionComparisonV1 = {
            schemaVersion: 1,
            assetId: ASSET_ID,
            left: { versionId: VERSION_ID, versionFingerprint: DIGEST },
            right: { versionId: PROJECT_ID, versionFingerprint: DIGEST },
            files: [],
            selectedFile: { comparisonKind: "not_requested" },
        };
        const compareAssetVersions = vi.fn(async (_input, observer) => {
            observer?.report({ stage: "inventory", completedUnits: 1, totalUnits: 1 });
            expect(observer?.isCancellationRequested()).toBe(false);
            return complete(comparison);
        });
        const exportResult: ExportAssetVersionToFileResultV1 = {
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            versionFingerprint: DIGEST,
            archiveIndexFingerprint: DIGEST,
            archiveByteLength: 4096,
        };
        const exportAssetVersionToFile = vi.fn(async () => complete(exportResult));
        const purgeResult: AssetPurgeResultV1 = { assetId: ASSET_ID, recycled: true };
        const purgeAsset = vi.fn(async () => complete(purgeResult));
        const operationContext = {
            operationId: "compare-operation",
            reportProgress: vi.fn(),
            afterTerminal: vi.fn(),
            isCancellationRequested: vi.fn(() => false),
        };
        const core = fakeCoreWith({
            analyzeDeploymentRender,
            scanDeployment,
            recoverDeployment,
            commitRenderedTargetAccept,
            cancelRenderedTargetAccept,
            reindexAssets,
            compareAssetVersions,
            exportAssetVersionToFile,
            purgeAsset,
        });
        let pathToken = 0;
        const pathSelections = new HostPathSelectionStore({
            createToken: () => `asset-export-token-${pathToken++}`,
        });
        const assetExportToken = pathSelections.register("asset_export_file", "/tmp/guidance.zip");
        const selection = {
            schemaVersion: 1 as const,
            renderInputFingerprint: "a".repeat(64),
            semanticOptions: [],
        };

        await dispatchH1Long(
            core,
            createProtocolRequest("0", "asset_version.compare", {
                assetId: ASSET_ID,
                left: { versionId: VERSION_ID, versionFingerprint: "a".repeat(64) },
                right: { versionId: PROJECT_ID, versionFingerprint: "a".repeat(64) },
            }),
            operationContext,
        );
        await dispatchH1Long(
            core,
            createProtocolRequest("0a", "asset_version.export", {
                source: {
                    assetId: ASSET_ID,
                    versionId: VERSION_ID,
                    versionFingerprint: "a".repeat(64),
                    originAuthorityFingerprint: "b".repeat(64),
                },
                localPathSelectionToken: assetExportToken,
                userActionId: "export-review",
            }),
            operationContext,
            pathSelections,
        );
        await dispatchH1Long(
            core,
            createProtocolRequest("0a2", "asset_version.compare", {
                assetId: ASSET_ID,
                left: { versionId: VERSION_ID, versionFingerprint: "a".repeat(64) },
                right: { versionId: PROJECT_ID, versionFingerprint: "a".repeat(64) },
                logicalPath: "guide.md",
            }),
        );
        await dispatchH1Long(
            core,
            createProtocolRequest("0a3", "asset_version.export", {
                source: {
                    assetId: ASSET_ID,
                    versionId: VERSION_ID,
                    versionFingerprint: "a".repeat(64),
                    originAuthorityFingerprint: "b".repeat(64),
                },
                localPathSelectionToken: assetExportToken,
                userActionId: "reused-export-review",
            }),
            operationContext,
            pathSelections,
        );
        await dispatchH1Long(
            core,
            createProtocolRequest("0a4", "asset_version.export", {
                source: {
                    assetId: ASSET_ID,
                    versionId: VERSION_ID,
                    versionFingerprint: "a".repeat(64),
                    originAuthorityFingerprint: "b".repeat(64),
                },
                localPathSelectionToken: "missing-export-token",
                userActionId: "missing-export-review",
            }),
            operationContext,
        );
        await dispatchH1Long(
            core,
            createProtocolRequest("0b", "asset.purge.commit", {
                preparation: {
                    ...purgePreparation,
                    assetManifestFingerprint: "a".repeat(64),
                    assetDirectoryIdentityFingerprint: "b".repeat(64),
                },
                userActionId: "purge-review",
            }),
            operationContext,
        );
        await dispatchH1Long(core, createProtocolRequest("1", "deployment.render_analyze", { deploymentId: VERSION_ID }));
        await dispatchH1Long(core, createProtocolRequest("4", "deployment.scan", { deploymentId: VERSION_ID }));
        await dispatchH1Long(core, createProtocolRequest("5", "deployment.recover", { deploymentId: VERSION_ID }));
        await dispatchH1Long(
            core,
            createProtocolRequest("6", "reverse_accept.commit", {
                preparationId: PROJECT_ID,
                expectedPreparationRevision: 1,
                userActionId: "user",
                newVersionPromotion: "use_existing_authority",
                renderSelection: selection,
            }),
        );
        await dispatchH1Long(
            core,
            createProtocolRequest("7", "reverse_accept.cancel", {
                preparationId: PROJECT_ID,
                expectedPreparationRevision: 1,
            }),
        );
        await dispatchH1Long(core, createProtocolRequest("8", "asset.reindex", { assetIds: [ASSET_ID], includeDeleted: true }));
        await dispatchH1Long(core, createProtocolRequest("9", "asset.reindex", {}));

        expect(analyzeDeploymentRender).toHaveBeenCalledWith(VERSION_ID);
        expect(compareAssetVersions).toHaveBeenCalledWith(
            {
                assetId: ASSET_ID,
                left: { versionId: VERSION_ID, versionFingerprint: DIGEST },
                right: { versionId: PROJECT_ID, versionFingerprint: DIGEST },
            },
            expect.any(Object),
        );
        expect(operationContext.reportProgress).toHaveBeenCalledWith({
            stage: "inventory",
            completedUnits: 1,
            totalUnits: 1,
        });
        expect(exportAssetVersionToFile).toHaveBeenCalledWith({
            source: {
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                versionFingerprint: DIGEST,
                originAuthorityFingerprint: `sha256:${"b".repeat(64)}`,
            },
            destinationPath: "/tmp/guidance.zip",
            userActionEvidenceId: "export-review",
        });
        expect(purgeAsset).toHaveBeenCalledWith({
            preparation: {
                ...purgePreparation,
                assetManifestFingerprint: DIGEST,
                assetDirectoryIdentityFingerprint: `sha256:${"b".repeat(64)}`,
            },
            userActionEvidenceId: "purge-review",
        });
        expect(commitRenderedTargetAccept).toHaveBeenCalledWith({
            preparationId: PROJECT_ID,
            expectedPreparationRevision: 1,
            userActionId: "user",
            newVersionPromotion: { promotionAction: "use_existing_authority" },
            renderSelectionRequest: {
                schemaVersion: 1,
                renderInputFingerprint: SHA,
                semanticOptions: [],
            },
        });
        expect(reindexAssets).toHaveBeenNthCalledWith(1, { assetIds: [ASSET_ID], includeDeleted: true });
        expect(reindexAssets).toHaveBeenNthCalledWith(2, {});
        expect(HOST_H1_LONG_OPERATIONS).toHaveLength(10);
        expect(isH1LongOperation("asset.reindex")).toBe(true);
        expect(isH1LongOperation("adapter.probe")).toBe(false);
        await expect(
            dispatchH1Long(
                core,
                createProtocolRequest("10", "adapter.probe", {
                    adapterIds: ["CLAUDECODE"],
                    environments: [{ platform: "linux", platformInstanceId: "local" }],
                    authorization: { scope: "global" },
                }),
            ),
        ).resolves.toBeNull();
    });

    it("preserves a definitive failed reverse commit value for the Client", async () => {
        const value = { commitState: "not_committed", versionPublicationState: "not_published" } as const;
        const result = await dispatchH1Long(
            fakeCoreWith({
                commitRenderedTargetAccept: async () => ({ status: "failed", value, diagnostics: [] }),
            }),
            createProtocolRequest("failed-commit", "reverse_accept.commit", {
                preparationId: PROJECT_ID,
                expectedPreparationRevision: 1,
                userActionId: "user",
                newVersionPromotion: "use_existing_authority",
                renderSelection: {
                    schemaVersion: 1,
                    renderInputFingerprint: "a".repeat(64),
                    semanticOptions: [],
                },
            }),
        );

        expect(result).toEqual({ status: "failed", value, diagnostics: [] });
    });
});
