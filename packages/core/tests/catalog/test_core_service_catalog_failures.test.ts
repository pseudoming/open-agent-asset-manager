/** CoreService catalog fail-closed, collision, and corrupt-authority scenarios. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as sharedFilesystem from "@oaam/shared/filesystem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireProjectAuthorityLocks, writeProjectManifest } from "../../src/catalog/project-authority";
import { tryAcquireAuthorityLocks } from "../../src/foundation/authority-locks";
import { acquireAllLocks, computeDeploymentOperationKey } from "../../src/foundation/physical-path-locks";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import { createCoreServiceForTest } from "../../src/orchestration/core-service";
import { closeDb, getDb } from "../../src/persistence/db";
import type { CreateAssetInput, UuidV4 } from "../../src/types";
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

function sequenceFactory(values: readonly UuidV4[]): () => UuidV4 {
    let index = 0;
    return () => {
        const value = values[index];
        if (value === undefined) throw new Error("UUID fixture exhausted");
        index += 1;
        return value;
    };
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
    it("binds only the exact Project root and does not reject a legitimate child link", () => {
        if (process.platform === "win32") return;
        const linkedTarget = path.join(sandbox, "shared-test-data");
        const childLink = path.join(workspaceRoot, "test-data");
        const linkedRoot = path.join(sandbox, "workspace-link");
        fs.mkdirSync(linkedTarget);
        fs.symlinkSync(linkedTarget, childLink, "dir");

        const core = makeService();
        const registered = core.registerProject({ rootPath: workspaceRoot, displayName: "Workspace" });
        expect(registered.status).toBe("complete");

        fs.symlinkSync(workspaceRoot, linkedRoot, "dir");
        const rejected = core.registerProject({ rootPath: linkedRoot, displayName: "Linked root" });
        expect(rejected.status).toBe("failed");
        expect(rejected.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "project.root_is_link",
                causeKind: "invalid_schema",
                path: linkedRoot,
            }),
        );
    });

    it("preserves every typed exact-root inspection failure as a Project diagnostic", () => {
        const core = makeService();
        const inspect = vi.spyOn(sharedFilesystem, "inspectDirectoryNoFollow");
        const cases = [
            ["permission_denied", "project.root_permission_denied", "permission_denied"],
            ["wrong_entry_type", "project.root_not_directory", "invalid_schema"],
            ["stale", "project.root_changed", "verification_failed"],
            ["invalid_path", "project.root_invalid", "invalid_schema"],
            ["resource_limit", "project.root_unavailable", "unavailable"],
            ["unsupported_platform", "project.root_unavailable", "unavailable"],
            ["io_error", "project.root_unavailable", "unavailable"],
        ] as const;

        for (const [failureKind, diagnosticCode, causeKind] of cases) {
            inspect.mockImplementationOnce(() => {
                throw new sharedFilesystem.SafeFilesystemError({
                    failureKind,
                    operation: "inspect_directory",
                    targetPath: workspaceRoot,
                    message: failureKind,
                });
            });
            expect(core.registerProject({ rootPath: workspaceRoot })).toMatchObject({
                status: "failed",
                diagnostics: [expect.objectContaining({ code: diagnosticCode, causeKind, path: workspaceRoot })],
            });
        }

        inspect.mockImplementationOnce(() => {
            throw new Error("unexpected exact-root inspection fault");
        });
        expect(core.registerProject({ rootPath: workspaceRoot })).toMatchObject({
            status: "failed",
            diagnostics: [expect.objectContaining({ code: "project.operation_failed" })],
        });
        inspect.mockRestore();
    });

    it("fails closed on invalid identities, scope, authorization, locks, and reserved settings", () => {
        const core = makeService();
        const missing = "00000000-0000-4000-8000-000000000999" as UuidV4;
        expect(core.getProject(missing).value).toEqual({ found: false });
        expect(core.getAsset(missing).value).toEqual({ found: false });
        expect(core.getCurrentVersion(missing).value).toEqual({ found: false });
        expect(core.getVersion({ assetId: missing, versionId: missing }).value).toEqual({
            found: false,
        });
        expect(core.listVersions(missing).value).toEqual([]);
        expect(core.getDeployment(missing).value).toEqual({ found: false });
        expect(core.getAsset("bad" as UuidV4).status).toBe("failed");
        expect(core.getCurrentVersion("bad" as UuidV4).status).toBe("failed");
        expect(core.listVersions("bad" as UuidV4).status).toBe("failed");
        expect(core.getDeployment("bad" as UuidV4).status).toBe("failed");
        expect(core.inspectProjectLifecycle({ action: "stop_managing", projectId: missing }).status).toBe("failed");

        expect(core.registerProject({ rootPath: "relative" })).toMatchObject({
            status: "failed",
            diagnostics: [expect.objectContaining({ code: "project.root_invalid", path: "relative" })],
        });
        expect(
            core.createAsset({
                ...guidanceAsset("global", ""),
                projectId: missing,
            }).status,
        ).toBe("failed");
        expect(core.createAsset(guidanceAsset("project", missing)).status).toBe("failed");
        expect(
            core.createAsset({
                ...guidanceAsset("global", ""),
                scopePath: "nested",
            }).status,
        ).toBe("failed");
        expect(core.queryAssets({ keywords: "", limit: 0 }).status).toBe("failed");
        expect(core.queryAssets({ keywords: "", offset: -1 }).status).toBe("failed");
        expect(core.setSetting("", { configVersion: 1 }).status).toBe("failed");
        expect(
            core.setSetting("core.restricted_source_promotion_full_access", {
                configVersion: 1,
            }).status,
        ).toBe("failed");
        expect(core.setSetting("bad", { configVersion: 0 }).status).toBe("failed");
        expect(core.unsetSetting("missing").status).toBe("complete");
        const settingsRelease = tryAcquireAuthorityLocks(path.join(oaamRoot, "transactions", "authority-locks"), "settings", [
            "settings",
        ])!;
        expect(core.setSetting("client.ui", { configVersion: 1 }).status).toBe("failed");
        settingsRelease();

        const project = core.registerProject({ rootPath: workspaceRoot });
        const projectLock = acquireProjectAuthorityLocks(path.join(oaamRoot, "transactions", "authority-locks"), [
            project.value.projectId,
        ]);
        expect(stopManagingProject(core, project.value.projectId).status).toBe("failed");
        projectLock();

        const asset = core.createAsset(guidanceAsset("global", ""));
        const versionId = core.getCurrentVersion(asset.value.assetId).value.value!.manifest.versionId;
        const incomplete = core.createVersion(asset.value.assetId, {
            typeData: { schemaVersion: 1 },
            files: [],
            userActionEvidenceId: "remove-entry",
            changeKind: "edit",
            sourceVersionId: versionId,
        });
        expect(incomplete.value.status).toBe("incomplete");
        const forcedComplete = core.createVersion(asset.value.assetId, {
            typeData: { schemaVersion: 1 },
            files: [],
            status: "complete",
            userActionEvidenceId: "force-invalid-complete",
            changeKind: "edit",
            sourceVersionId: versionId,
        });
        expect(forcedComplete.status).toBe("failed");
        expect(forcedComplete.diagnostics[0]?.message).toBe("objectively incomplete Version cannot be forced to complete");
        expect(
            core.createVersion(asset.value.assetId, {
                typeData: { schemaVersion: 1 },
                files: [],
                userActionEvidenceId: " ",
                changeKind: "edit",
                sourceVersionId: versionId,
            }).status,
        ).toBe("failed");
        expect(
            core.createVersion(missing, {
                typeData: { schemaVersion: 1 },
                files: [],
                userActionEvidenceId: "missing",
                changeKind: "edit",
                sourceVersionId: missing,
            }).status,
        ).toBe("failed");
        expect(
            core.createVersion(asset.value.assetId, {
                typeData: { schemaVersion: 1 },
                files: [],
                userActionEvidenceId: "bad-parent",
                changeKind: "edit",
                sourceVersionId: missing,
            }).status,
        ).toBe("failed");
        expect(core.updateAssetDisplay(asset.value.assetId, {}).status).toBe("failed");
        expect(core.updateAssetDisplay(missing, { displayName: "x" }).status).toBe("failed");
        expect(core.updateAssetDisplay(asset.value.assetId, { displayName: "Only Name" }).status).toBe("complete");
        expect(core.updateAssetDisplay(asset.value.assetId, { displayDescription: "Only Desc" }).status).toBe("complete");
        expect(core.setCurrentVersion({ assetId: asset.value.assetId, versionId: missing }).status).toBe("failed");
        expect(core.setCurrentVersion({ assetId: "bad" as UuidV4, versionId: missing }).status).toBe("failed");
        expect(
            core.setCurrentVersion({
                assetId: asset.value.assetId,
                versionId: "bad" as UuidV4,
            }).status,
        ).toBe("failed");
        expect(core.reindexAssets({ assetIds: ["bad" as UuidV4] }).status).toBe("failed");

        const releaseAsset = tryAcquireAuthorityLocks(path.join(oaamRoot, "transactions", "authority-locks"), "assets", [
            asset.value.assetId,
        ])!;
        expect(core.softDeleteAsset(asset.value.assetId).status).toBe("failed");
        releaseAsset();

        expect(
            core.createDeployment({
                projectId: "",
                consumerAgentRuntimeIds: [],
                platform: "linux",
                platformInstanceId: "local",
                targetRootPath: workspaceRoot,
                assets: [],
            }).status,
        ).toBe("failed");
        expect(
            core.createDeployment({
                projectId: "",
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                platform: "linux",
                platformInstanceId: "local",
                targetRootPath: workspaceRoot,
                assets: [
                    {
                        assetId: asset.value.assetId,
                        versionId: incomplete.value.versionId,
                        allowIncomplete: false,
                    },
                ],
            }).status,
        ).toBe("failed");
        expect(
            core.createDeployment({
                projectId: "",
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                platform: "linux",
                platformInstanceId: "local",
                targetRootPath: workspaceRoot,
                assets: [
                    {
                        assetId: asset.value.assetId,
                        versionId: incomplete.value.versionId,
                        allowIncomplete: true,
                    },
                ],
            }).status,
        ).toBe("complete");
        expect(
            core.createDeployment({
                projectId: "",
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                platform: "linux",
                platformInstanceId: "local",
                targetRootPath: workspaceRoot,
                assets: [
                    {
                        assetId: asset.value.assetId,
                        versionId,
                        allowIncomplete: "no" as unknown as boolean,
                    },
                ],
            }).status,
        ).toBe("failed");

        const projectAsset = core.createAsset(guidanceAsset("project", project.value.projectId));
        const secondProjectRoot = path.join(sandbox, "second-project");
        fs.mkdirSync(secondProjectRoot);
        const secondProject = core.registerProject({ rootPath: secondProjectRoot });
        expect(
            core.createDeployment({
                projectId: secondProject.value.projectId,
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                platform: "linux",
                platformInstanceId: "local",
                targetRootPath: secondProjectRoot,
                assets: [
                    {
                        assetId: projectAsset.value.assetId,
                        versionId: core.getCurrentVersion(projectAsset.value.assetId).value.value!.manifest.versionId,
                        allowIncomplete: false,
                    },
                ],
            }).status,
        ).toBe("failed");
        expect(stopManagingProject(core, secondProject.value.projectId).status).toBe("complete");
        expect(
            core.createDeployment({
                projectId: secondProject.value.projectId,
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                platform: "linux",
                platformInstanceId: "local",
                targetRootPath: secondProjectRoot,
                assets: [],
            }).status,
        ).toBe("failed");
        expect(
            core.createDeployment({
                projectId: missing,
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                platform: "linux",
                platformInstanceId: "local",
                targetRootPath: workspaceRoot,
                assets: [],
            }).status,
        ).toBe("failed");

        const heldAsset = tryAcquireAuthorityLocks(path.join(oaamRoot, "transactions", "authority-locks"), "assets", [
            asset.value.assetId,
        ])!;
        expect(
            core.createDeployment({
                projectId: "",
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                platform: "linux",
                platformInstanceId: "local",
                targetRootPath: workspaceRoot,
                assets: [{ assetId: asset.value.assetId, versionId, allowIncomplete: false }],
            }).status,
        ).toBe("failed");
        heldAsset();
        const invalidDeployments = [["claude_code_cli"], ["CLAUDE_CODE_CLI", "CLAUDE_CODE_CLI"]];
        for (const consumerAgentRuntimeIds of invalidDeployments) {
            expect(
                core.createDeployment({
                    projectId: "",
                    consumerAgentRuntimeIds,
                    platform: "linux",
                    platformInstanceId: "local",
                    targetRootPath: workspaceRoot,
                    assets: [],
                }).status,
            ).toBe("failed");
        }
        expect(
            core.createDeployment({
                projectId: "",
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                platform: "bad" as never,
                platformInstanceId: "local",
                targetRootPath: workspaceRoot,
                assets: [],
            }).status,
        ).toBe("failed");
        expect(
            core.createDeployment({
                projectId: "",
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                platform: "linux",
                platformInstanceId: "local",
                targetRootPath: "relative",
                assets: [],
            }).status,
        ).toBe("failed");
        for (const platformInstanceId of ["", "local\0other"]) {
            expect(
                core.createDeployment({
                    projectId: "",
                    consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                    platform: "linux",
                    platformInstanceId,
                    targetRootPath: workspaceRoot,
                    assets: [],
                }).status,
            ).toBe("failed");
        }
        const deployment = core.createDeployment({
            projectId: "",
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local",
            targetRootPath: workspaceRoot,
            assets: [{ assetId: asset.value.assetId, versionId, allowIncomplete: false }],
        });
        expect(deployment.status).toBe("complete");
        expect(
            core.createDeployment({
                projectId: "",
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                platform: "linux",
                platformInstanceId: "local",
                targetRootPath: workspaceRoot,
                assets: [
                    { assetId: asset.value.assetId, versionId, allowIncomplete: false },
                    { assetId: asset.value.assetId, versionId, allowIncomplete: false },
                ],
            }).status,
        ).toBe("failed");
        expect(
            core.createDeployment({
                projectId: "",
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                platform: "linux",
                platformInstanceId: "local",
                targetRootPath: workspaceRoot,
                assets: [{ assetId: missing, versionId: missing, allowIncomplete: false }],
            }).status,
        ).toBe("failed");
        expect(
            core.createDeployment({
                projectId: "",
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                platform: "linux",
                platformInstanceId: "local",
                targetRootPath: workspaceRoot,
                assets: [{ assetId: asset.value.assetId, versionId: missing, allowIncomplete: false }],
            }).status,
        ).toBe("failed");
        const operationLock = acquireAllLocks(path.join(oaamRoot, "transactions"), [
            computeDeploymentOperationKey(deployment.value.deploymentId),
        ])!;
        expect(core.updateDeploymentInputs(deployment.value.deploymentId, {}).status).toBe("failed");
        const releasedDeploymentAssetLock = tryAcquireAuthorityLocks(
            path.join(oaamRoot, "transactions", "authority-locks"),
            "assets",
            [asset.value.assetId],
        );
        expect(releasedDeploymentAssetLock).not.toBeNull();
        releasedDeploymentAssetLock?.();
        operationLock.release();
        expect(core.updateDeploymentInputs(missing, {}).status).toBe("failed");
        expect(core.updateDeploymentInputs(deployment.value.deploymentId, { assets: [] }).value.assets).toEqual([]);
        getDb(databasePath)
            .prepare("UPDATE deployments SET consumer_agent_runtime_ids = '{}' WHERE deployment_id = ?")
            .run(deployment.value.deploymentId);
        expect(core.updateDeploymentInputs(deployment.value.deploymentId, {}).status).toBe("failed");
        getDb(databasePath)
            .prepare(
                `UPDATE deployments
                 SET consumer_agent_runtime_ids = '["CLAUDE_CODE_CLI"]'
                 WHERE deployment_id = ?`,
            )
            .run(deployment.value.deploymentId);
        expect(core.listDeployments().value.length).toBeGreaterThan(1);
        expect(core.softDeleteDeployment(deployment.value.deploymentId).status).toBe("complete");
        expect(core.updateDeploymentInputs(deployment.value.deploymentId, {}).status).toBe("failed");
        expect(core.softDeleteAsset(asset.value.assetId).status).toBe("complete");
        expect(
            core.createDeployment({
                projectId: "",
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                platform: "linux",
                platformInstanceId: "local",
                targetRootPath: workspaceRoot,
                assets: [{ assetId: asset.value.assetId, versionId, allowIncomplete: false }],
            }).status,
        ).toBe("failed");
    });

    it("rejects corrupt Project inventories instead of silently resolving ambiguous roots", () => {
        const core = makeService(identityFactory(100));
        fs.mkdirSync(oaamRoot, { recursive: true });
        const projectsRoot = path.join(oaamRoot, "projects");
        const first = "00000000-0000-4000-8000-000000000201" as UuidV4;
        const second = "00000000-0000-4000-8000-000000000202" as UuidV4;
        for (const projectId of [first, second]) {
            writeProjectManifest(projectsRoot, {
                schemaVersion: 1,
                projectId,
                rootPath: workspaceRoot,
                displayName: "Duplicate",
                deleted: false,
                createdAt: 1,
                updatedAt: 1,
            });
        }
        expect(core.registerProject({ rootPath: workspaceRoot }).status).toBe("failed");
        fs.mkdirSync(path.join(projectsRoot, "not-a-uuid"));
        expect(core.listProjects().status).toBe("partial");
    });

    it("uses production UUID allocation and rejects generated identity collisions", () => {
        const production = makeService(null);
        const project = production.registerProject({ rootPath: workspaceRoot });
        expect(project.value.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        const asset = production.createAsset(guidanceAsset("global", ""));
        expect(asset.value.assetId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        const deployment = production.createDeployment({
            projectId: project.value.projectId,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local",
            targetRootPath: workspaceRoot,
            assets: [],
        });
        expect(deployment.value.deploymentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("fails closed when generated Project, Asset, or Deployment IDs collide", () => {
        const duplicateProjectId = "00000000-0000-4000-8000-000000000301" as UuidV4;
        const projectCore = makeService(() => duplicateProjectId);
        const firstProject = projectCore.registerProject({ rootPath: workspaceRoot });
        expect(firstProject.status).toBe("complete");
        const secondRoot = path.join(sandbox, "workspace-two");
        fs.mkdirSync(secondRoot);
        expect(projectCore.registerProject({ rootPath: secondRoot }).status).toBe("failed");

        closeDb();
        clearRegistry();
        fs.rmSync(oaamRoot, { recursive: true, force: true });
        const assetIds = [
            "00000000-0000-4000-8000-000000000311",
            "00000000-0000-4000-8000-000000000312",
            "00000000-0000-4000-8000-000000000313",
            "00000000-0000-4000-8000-000000000314",
            "00000000-0000-4000-8000-000000000311",
            "00000000-0000-4000-8000-000000000315",
            "00000000-0000-4000-8000-000000000316",
        ] as const satisfies readonly UuidV4[];
        const assetCore = makeService(sequenceFactory(assetIds));
        expect(assetCore.createAsset(guidanceAsset("global", "")).status).toBe("complete");
        expect(assetCore.createAsset(guidanceAsset("global", "")).status).toBe("failed");

        closeDb();
        clearRegistry();
        fs.rmSync(oaamRoot, { recursive: true, force: true });
        const duplicateDeploymentId = "00000000-0000-4000-8000-000000000321" as UuidV4;
        const deploymentCore = makeService(() => duplicateDeploymentId);
        const input = {
            projectId: "",
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux" as const,
            platformInstanceId: "local",
            targetRootPath: workspaceRoot,
            assets: [],
        };
        expect(deploymentCore.createDeployment(input).status).toBe("complete");
        expect(deploymentCore.createDeployment(input).status).toBe("failed");
    });

    it("fails before catalog mutation when the generated Deployment operation key is busy", () => {
        const deploymentId = "00000000-0000-4000-8000-000000000331" as UuidV4;
        const core = makeService(() => deploymentId);
        const release = acquireAllLocks(path.join(oaamRoot, "transactions"), [computeDeploymentOperationKey(deploymentId)])!;
        const result = core.createDeployment({
            projectId: "",
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local",
            targetRootPath: workspaceRoot,
            assets: [],
        });
        expect(result.status).toBe("failed");
        expect(core.getDeployment(deploymentId).value).toEqual({ found: false });
        release.release();
    });

    it("reports malformed settings authority instead of treating it as an empty store", () => {
        const core = makeService();
        fs.mkdirSync(oaamRoot, { recursive: true });
        fs.writeFileSync(path.join(oaamRoot, "settings.json"), "{not-json");
        expect(core.getSetting("client.ui").status).toBe("failed");
        expect(core.listSettings().status).toBe("failed");
    });

    it("blocks project Asset mutation when its Project authority disappears", () => {
        const core = makeService();
        const project = core.registerProject({ rootPath: workspaceRoot });
        const asset = core.createAsset(guidanceAsset("project", project.value.projectId));
        const versionId = core.getCurrentVersion(asset.value.assetId).value.value!.manifest.versionId;
        fs.rmSync(path.join(oaamRoot, "projects", project.value.projectId), {
            recursive: true,
            force: true,
        });
        expect(core.updateAssetDisplay(asset.value.assetId, { displayName: "Blocked" }).status).toBe("failed");
        expect(
            core.createVersion(asset.value.assetId, {
                typeData: { schemaVersion: 1 },
                files: [],
                userActionEvidenceId: "blocked-project",
                changeKind: "edit",
                sourceVersionId: versionId,
            }).status,
        ).toBe("failed");
    });

    it("rejects invalid generated Asset identity before touching authority state", () => {
        const core = makeService(() => "not-a-uuid" as UuidV4);
        expect(core.createAsset(guidanceAsset("global", "")).status).toBe("failed");
        expect(fs.existsSync(path.join(oaamRoot, "assets"))).toBe(false);
        expect(getDb(databasePath).prepare("SELECT COUNT(*) AS count FROM assets_fts").get()).toEqual({ count: 0 });
    });
});
