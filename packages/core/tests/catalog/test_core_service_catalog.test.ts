/** CoreService catalog happy-path composition through the single public root. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import { acquireAllLocks, computeDeploymentOperationKey } from "../../src/foundation/physical-path-locks";
import { createCoreServiceForTest } from "../../src/orchestration/core-service";
import { closeDb } from "../../src/persistence/db";
import { tryAcquireAuthorityLocks } from "../../src/foundation/authority-locks";
import type { CreateAssetInput, CreateVersionInput, UuidV4 } from "../../src/types";
import { makeContractProvider } from "../adapters/fixtures/adapter-contract-fixtures";

let sandbox = "";
let oaamRoot = "";
let databasePath = "";
let workspaceRoot = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-core-catalog-"));
    oaamRoot = path.join(sandbox, "oaam");
    databasePath = path.join(sandbox, "state.db");
    workspaceRoot = path.join(sandbox, "workspace");
    fs.mkdirSync(workspaceRoot);
    clearRegistry();
    closeDb();
});

afterEach(() => {
    closeDb();
    clearRegistry();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

function identityFactory(start = 1): () => UuidV4 {
    let next = start;
    return () => {
        const suffix = String(next).padStart(12, "0");
        next += 1;
        return `00000000-0000-4000-8000-${suffix}`;
    };
}

function makeService(newUuid: (() => UuidV4) | null = identityFactory()) {
    return createCoreServiceForTest(
        {
            providers: [makeContractProvider("CATALOG_FIXTURE")],
            platformContexts: [
                {
                    platform: "linux",
                    platformInstanceId: "local",
                    accessRootPath: "/",
                },
            ],
            oaamRoot,
            databasePath,
            now: () => 1_000,
            ...(newUuid === null ? {} : { newUuid }),
        },
        {},
    );
}

function stopManagingProject(core: ReturnType<typeof makeService>, projectId: UuidV4) {
    const inspected = core.inspectProjectLifecycle({ action: "stop_managing", projectId });
    if (inspected.status !== "complete") throw new Error("stop-managing inspection failed in test setup");
    return core.commitProjectLifecycle({
        preparation: inspected.value,
        userActionId: "stop-managing-test",
    });
}

function guidanceAsset(scope: "global" | "project", projectId: string, text = "# Guidance\r\n"): CreateAssetInput {
    return {
        kind: "Guidance",
        scope,
        projectId,
        scopePath: "",
        displayName: scope === "global" ? "Global Guidance" : "Project Guidance",
        displayDescription: "fixture",
        initialVersion: {
            typeData: { schemaVersion: 1 },
            files: [
                {
                    logicalPath: "GUIDANCE.md",
                    role: "entry",
                    contentKind: "text",
                    mediaType: "text/markdown; charset=utf-8",
                    text,
                    executable: false,
                    references: [],
                },
            ],
            userActionEvidenceId: "create-guidance",
            changeKind: "create",
        },
    };
}

describe("complete CoreService catalog composition", () => {
    it("owns Project, Asset, Version, Deployment, Index, and Settings through one object", () => {
        const core = makeService();
        const project = core.registerProject({ rootPath: workspaceRoot, displayName: "Workspace" });
        expect(project.status).toBe("complete");
        expect(core.registerProject({ rootPath: workspaceRoot }).value.projectId).toBe(project.value.projectId);
        expect(core.getProject(project.value.projectId).value).toEqual({
            found: true,
            value: project.value,
        });
        expect(core.listProjects().value).toEqual([project.value]);

        const globalAsset = core.createAsset(guidanceAsset("global", ""));
        const projectInput = guidanceAsset("project", project.value.projectId, "# Project\n");
        projectInput.scopePath = "docs/child";
        const projectAsset = core.createAsset(projectInput);
        const noDescriptionInput = guidanceAsset("global", "", "# Peer\n");
        noDescriptionInput.displayDescription = undefined;
        noDescriptionInput.displayName = "Project Guidance";
        const peerAsset = core.createAsset(noDescriptionInput);
        const boundedLibraryPage = core.queryAssetSummaryPage({
            subject: { scope: "global" },
            kind: "Guidance",
            keywords: "",
            pageSize: 1,
        });
        if (!boundedLibraryPage.value.hasMore) throw new Error("fixture expected a bounded Asset-library cursor");
        expect(
            core.updateAssetDisplay(projectAsset.value.assetId, {
                displayName: "Project Guidance",
            }).status,
        ).toBe("complete");
        expect(
            core.queryAssetSummaryPage({
                subject: { scope: "global" },
                kind: "Guidance",
                keywords: "",
                pageSize: 1,
                cursor: boundedLibraryPage.value.nextCursor,
            }).status,
        ).toBe("failed");
        expect(core.listAssetKindCounts({ subject: { scope: "global" }, keywords: "" }).value).toContainEqual({
            kind: "Guidance",
            count: 2,
        });
        const projectParent = core.getCurrentVersion(projectAsset.value.assetId).value.value!;
        expect(
            core.createVersion(projectAsset.value.assetId, {
                typeData: { schemaVersion: 1 },
                files: [
                    {
                        logicalPath: "GUIDANCE.md",
                        role: "entry",
                        contentKind: "text",
                        mediaType: "text/markdown; charset=utf-8",
                        text: "# Project\n",
                        executable: false,
                        references: [],
                    },
                ],
                userActionEvidenceId: "project-edit",
                changeKind: "edit",
                sourceVersionId: projectParent.manifest.versionId,
            }).status,
        ).toBe("complete");
        expect(globalAsset.status).toBe("complete");
        expect(projectAsset.status).toBe("complete");
        const firstVersion = core.getCurrentVersion(globalAsset.value.assetId);
        expect(firstVersion.value.value?.files[0]).toMatchObject({
            contentKind: "text",
            text: "# Guidance\n",
        });

        const nextInput: CreateVersionInput = {
            typeData: { schemaVersion: 1 },
            files: [
                {
                    logicalPath: "blob.bin",
                    role: "resource",
                    contentKind: "binary",
                    mediaType: "application/octet-stream",
                    bytes: new Uint8Array([0, 1, 2]),
                    executable: false,
                    references: [],
                },
            ],
            status: "incomplete",
            diagnostics: [
                {
                    severity: "warning",
                    code: "fixture.incomplete",
                    message: "binary fixture",
                    path: "blob.bin",
                    traceId: "",
                },
            ],
            userActionEvidenceId: "edit-guidance",
            changeKind: "edit",
            sourceVersionId: firstVersion.value.value!.manifest.versionId,
            changeNote: "fixture edit",
        };
        const secondVersion = core.createVersion(globalAsset.value.assetId, nextInput);
        expect(secondVersion.status).toBe("complete");
        expect(core.listAssets({ currentVersionStatus: "incomplete" }).value).toEqual([
            expect.objectContaining({ assetId: globalAsset.value.assetId }),
        ]);
        expect(core.listVersions(globalAsset.value.assetId).value).toHaveLength(2);
        expect(
            core.getVersion({
                assetId: globalAsset.value.assetId,
                versionId: secondVersion.value.versionId,
            }).value.value?.files[0],
        ).toMatchObject({ contentKind: "binary" });
        expect(
            core
                .setCurrentVersion({
                    assetId: globalAsset.value.assetId,
                    versionId: firstVersion.value.value!.manifest.versionId,
                })
                .value.versionIds.at(-1),
        ).toBe(firstVersion.value.value!.manifest.versionId);
        expect(
            core.updateAssetDisplay(globalAsset.value.assetId, {
                displayName: "Renamed",
                displayDescription: "Updated",
            }).value,
        ).toMatchObject({ displayName: "Renamed", displayDescription: "Updated" });

        expect(core.listAssets({ scope: "project", projectId: project.value.projectId }).value).toEqual([
            expect.objectContaining({ assetId: projectAsset.value.assetId }),
        ]);
        expect(core.listAssets({ scopePathPrefix: "docs" }).value).toEqual([
            expect.objectContaining({ assetId: projectAsset.value.assetId }),
        ]);
        expect(core.listAssets({ scopePathPrefix: "docs/child" }).value).toEqual([
            expect.objectContaining({ assetId: projectAsset.value.assetId }),
        ]);
        expect(core.getAsset(peerAsset.value.assetId).value.value?.displayDescription).toBe("");
        expect(core.listAssets({ kind: "Memory" }).value).toEqual([]);
        expect(core.listAssets({ currentVersionStatus: "incomplete" }).value).toEqual([]);
        expect(core.listAssets({ scopePathPrefix: "nested" }).value).toEqual([]);
        expect(core.listAssets().value).toHaveLength(3);
        expect(core.queryAssets({ keywords: "Renamed", limit: 10, offset: 0 }).value).toMatchObject({ totalCount: 1 });
        expect(core.queryAssets({ keywords: "" }).value.totalCount).toBe(3);
        expect(core.reindexAssets({ includeDeleted: true }).value.indexedAssets).toBe(3);
        expect(core.reindexAssets({ assetIds: [globalAsset.value.assetId] }).value.scannedAssets).toBe(1);

        const deployment = core.createDeployment({
            projectId: project.value.projectId,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local",
            targetRootPath: workspaceRoot,
            assets: [
                {
                    assetId: projectAsset.value.assetId,
                    versionId: core.getCurrentVersion(projectAsset.value.assetId).value.value!.manifest.versionId,
                    allowIncomplete: false,
                },
                {
                    assetId: globalAsset.value.assetId,
                    versionId: firstVersion.value.value!.manifest.versionId,
                    allowIncomplete: false,
                },
            ],
        });
        expect(deployment.status).toBe("complete");
        expect(core.getDeployment(deployment.value.deploymentId).value).toMatchObject({
            found: true,
            value: { platform: "linux", platformInstanceId: "local", targetRootPath: workspaceRoot },
        });
        expect(core.listDeployments({ projectId: project.value.projectId }).value).toHaveLength(1);
        expect(
            core.updateDeploymentInputs(deployment.value.deploymentId, {
                consumerAgentRuntimeIds: ["ANTIGRAVITY_CLI", "CLAUDE_CODE_CLI"],
            }).value.consumerAgentRuntimeIds,
        ).toEqual(["ANTIGRAVITY_CLI", "CLAUDE_CODE_CLI"]);
        expect(
            core.updateDeploymentInputs(deployment.value.deploymentId, {
                assets: deployment.value.assets,
            }).status,
        ).toBe("complete");
        expect(core.updateDeploymentInputs(deployment.value.deploymentId, {}).status).toBe("complete");
        expect(core.listDeployments({ stage: "blocked" }).value).toEqual([]);

        expect(core.getSetting("client.ui").value).toEqual({ found: false });
        expect(core.setSetting("client.ui", { configVersion: 1, theme: "dark" }).status).toBe("complete");
        expect(core.getSetting<{ configVersion: number; theme: string }>("client.ui").value).toEqual({
            found: true,
            value: { configVersion: 1, theme: "dark" },
        });
        expect(core.listSettings().value).toMatchObject({
            "client.ui": { configVersion: 1, theme: "dark" },
        });
        expect(core.unsetSetting("client.ui").status).toBe("complete");

        const deploymentLock = acquireAllLocks(path.join(oaamRoot, "transactions"), [
            computeDeploymentOperationKey(deployment.value.deploymentId),
        ])!;
        expect(stopManagingProject(core, project.value.projectId).status).toBe("failed");
        const releasedProjectAssetLock = tryAcquireAuthorityLocks(
            path.join(oaamRoot, "transactions", "authority-locks"),
            "assets",
            [projectAsset.value.assetId],
        );
        expect(releasedProjectAssetLock).not.toBeNull();
        releasedProjectAssetLock?.();
        deploymentLock.release();
        const projectAssetLock = tryAcquireAuthorityLocks(path.join(oaamRoot, "transactions", "authority-locks"), "assets", [
            projectAsset.value.assetId,
        ])!;
        expect(stopManagingProject(core, project.value.projectId).status).toBe("failed");
        projectAssetLock();
        const referencedGlobalAssetLock = tryAcquireAuthorityLocks(
            path.join(oaamRoot, "transactions", "authority-locks"),
            "assets",
            [globalAsset.value.assetId],
        )!;
        expect(stopManagingProject(core, project.value.projectId).status).toBe("failed");
        referencedGlobalAssetLock();
        expect(stopManagingProject(core, project.value.projectId).value.deleted).toBe(true);
        expect(
            core.inspectProjectLifecycle({
                action: "stop_managing",
                projectId: project.value.projectId,
            }).status,
        ).toBe("failed");
        expect(core.updateAssetDisplay(projectAsset.value.assetId, { displayName: "Blocked" }).status).toBe("failed");
        expect(
            core.createVersion(projectAsset.value.assetId, {
                ...nextInput,
                sourceVersionId: core.getCurrentVersion(projectAsset.value.assetId).value.value!.manifest.versionId,
            }).status,
        ).toBe("failed");
        expect(core.softDeleteDeployment(deployment.value.deploymentId).value.deleted).toBe(true);
        expect(core.softDeleteDeployment(deployment.value.deploymentId).value.deleted).toBe(true);
        expect(core.softDeleteAsset(projectAsset.value.assetId).value.deleted).toBe(true);
        expect(core.softDeleteAsset(projectAsset.value.assetId).value.deleted).toBe(true);
        expect(core.softDeleteAsset(globalAsset.value.assetId).value.deleted).toBe(true);
        expect(core.updateAssetDisplay(globalAsset.value.assetId, { displayName: "Blocked" }).status).toBe("failed");
        expect(
            core.setCurrentVersion({
                assetId: globalAsset.value.assetId,
                versionId: firstVersion.value.value!.manifest.versionId,
            }).status,
        ).toBe("failed");
        expect(
            core.createVersion(globalAsset.value.assetId, {
                ...nextInput,
                sourceVersionId: firstVersion.value.value!.manifest.versionId,
            }).status,
        ).toBe("failed");
        expect(core.listProjects({ includeDeleted: true }).value[0]?.deleted).toBe(true);
        expect(core.listAssets({ includeDeleted: true }).value).toEqual(
            expect.arrayContaining([expect.objectContaining({ assetId: projectAsset.value.assetId, deleted: true })]),
        );
    });
});
