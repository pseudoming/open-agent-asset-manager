import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import { createCoreServiceForTest } from "../../src/orchestration/core-service";
import { closeDb } from "../../src/persistence/db";
import { readProjectManifest, writeProjectManifest } from "../../src/catalog/project-authority";
import type { CreateAssetInput, UuidV4 } from "../../src/types";
import { makeContractProvider } from "../adapters/fixtures/adapter-contract-fixtures";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001" as UuidV4;
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000002" as UuidV4;
const OTHER_PROJECT_ID = "00000000-0000-4000-8000-000000000003" as UuidV4;
const RESTORE_ASSET_ID = "00000000-0000-4000-8000-000000000004" as UuidV4;
const RESTORE_VERSION_ID = "00000000-0000-4000-8000-000000000005" as UuidV4;
const RESTORE_FILE_ID = "00000000-0000-4000-8000-000000000006" as UuidV4;
const RESTORE_TRANSACTION_ID = "00000000-0000-4000-8000-000000000007" as UuidV4;
const RESTORE_DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000008" as UuidV4;

let sandbox = "";
let oaamRoot = "";
let databasePath = "";
let workspaceRoot = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-project-lifecycle-"));
    oaamRoot = path.join(sandbox, "oaam");
    databasePath = path.join(sandbox, "state.db");
    workspaceRoot = path.join(sandbox, "workspace");
    fs.mkdirSync(workspaceRoot);
    fs.writeFileSync(path.join(workspaceRoot, "untouched.txt"), "outside Project authority\n");
    clearRegistry();
    closeDb();
});

afterEach(() => {
    closeDb();
    clearRegistry();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

function makeService(newUuid: () => UuidV4 = () => PROJECT_ID) {
    return createCoreServiceForTest(
        {
            providers: [makeContractProvider("PROJECT_LIFECYCLE_FIXTURE")],
            platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
            oaamRoot,
            databasePath,
            now: () => 2_000,
            newUuid,
        },
        {},
    );
}

function stopManagingProject(core: ReturnType<typeof makeService>, projectId: UuidV4 = PROJECT_ID) {
    const inspected = core.inspectProjectLifecycle({ action: "stop_managing", projectId });
    if (inspected.status !== "complete") throw new Error("stop-managing inspection failed in test setup");
    return core.commitProjectLifecycle({
        preparation: inspected.value,
        userActionId: "stop-managing-test",
    });
}

function projectGuidance(projectId: UuidV4): CreateAssetInput {
    return {
        kind: "Guidance",
        scope: "project",
        projectId,
        scopePath: "",
        displayName: "Project Guidance",
        displayDescription: "restore fixture",
        initialVersion: {
            typeData: { schemaVersion: 1 },
            files: [
                {
                    logicalPath: "AGENTS.md",
                    role: "entry",
                    contentKind: "text",
                    mediaType: "text/markdown; charset=utf-8",
                    text: "# Retained guidance\n",
                    executable: false,
                    references: [],
                },
            ],
            userActionEvidenceId: "create-retained-guidance",
            changeKind: "create",
        },
    };
}

describe("Project lifecycle rename", () => {
    it("changes only displayName on the reviewed Project authority", () => {
        const core = makeService();
        const registered = core.registerProject({ rootPath: workspaceRoot, displayName: "Before" });
        expect(registered.status).toBe("complete");

        const inspected = core.inspectProjectLifecycle({
            action: "rename",
            projectId: PROJECT_ID,
            nextDisplayName: "After",
        });
        expect(inspected).toMatchObject({
            status: "complete",
            value: {
                schemaVersion: 1,
                action: "rename",
                projectId: PROJECT_ID,
                rootPath: workspaceRoot,
                currentDisplayName: "Before",
                nextDisplayName: "After",
            },
        });

        const committed = core.commitProjectLifecycle({
            preparation: inspected.value,
            userActionId: "rename-project",
        });
        expect(committed).toMatchObject({
            status: "complete",
            value: {
                projectId: PROJECT_ID,
                rootPath: workspaceRoot,
                displayName: "After",
                deleted: false,
                createdAt: 2_000,
                updatedAt: 2_000,
            },
        });
        expect(fs.readFileSync(path.join(workspaceRoot, "untouched.txt"), "utf8")).toBe("outside Project authority\n");
        expect(fs.readdirSync(workspaceRoot)).toEqual(["untouched.txt"]);
    });

    it("rejects missing, deleted, unchanged, malformed, stale, and unreviewable rename attempts", () => {
        const core = makeService();
        expect(
            core.inspectProjectLifecycle({
                action: "foreign",
                projectId: PROJECT_ID,
                nextDisplayName: "Foreign",
            } as never).status,
        ).toBe("failed");
        expect(
            core.inspectProjectLifecycle({
                action: "rename",
                projectId: PROJECT_ID,
                nextDisplayName: "Missing",
            }).status,
        ).toBe("failed");

        core.registerProject({ rootPath: workspaceRoot, displayName: "Before" });
        expect(
            core.inspectProjectLifecycle({
                action: "foreign",
                projectId: PROJECT_ID,
                nextDisplayName: "Foreign",
            } as never).status,
        ).toBe("failed");
        expect(
            core.inspectProjectLifecycle({
                action: "rename",
                projectId: PROJECT_ID,
                nextDisplayName: "Before",
            }).status,
        ).toBe("failed");
        expect(
            core.inspectProjectLifecycle({
                action: "rename",
                projectId: PROJECT_ID,
                nextDisplayName: " ",
            }).status,
        ).toBe("failed");

        const inspected = core.inspectProjectLifecycle({
            action: "rename",
            projectId: PROJECT_ID,
            nextDisplayName: "Reviewed",
        });
        const projectsRoot = path.join(oaamRoot, "projects");
        const current = readProjectManifest(projectsRoot, PROJECT_ID)!;
        fs.rmSync(path.join(projectsRoot, PROJECT_ID, "project.json"));
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "missing-project",
            }).status,
        ).toBe("failed");
        writeProjectManifest(projectsRoot, current);
        writeProjectManifest(projectsRoot, { ...current, deleted: true });
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "deleted-project",
            }).status,
        ).toBe("failed");
        writeProjectManifest(projectsRoot, current);
        for (const preparation of [
            { ...inspected.value, rootPath: path.join(sandbox, "different-root") },
            { ...inspected.value, rootPath: "relative" },
            { ...inspected.value, currentDisplayName: "Different current name" },
            { ...inspected.value, nextDisplayName: "Before" },
        ]) {
            expect(
                core.commitProjectLifecycle({
                    preparation,
                    userActionId: "rename-project",
                }).status,
            ).toBe("failed");
        }
        writeProjectManifest(projectsRoot, { ...current, displayName: "Concurrent" });
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "rename-project",
            }).status,
        ).toBe("failed");
        expect(
            core.commitProjectLifecycle({
                preparation: { ...inspected.value, projectAuthorityFingerprint: "sha256:bad" },
                userActionId: "rename-project",
            }).status,
        ).toBe("failed");
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: 1 as never,
            }).status,
        ).toBe("failed");
        for (const userActionId of ["", " padded", "nul\0action"]) {
            expect(
                core.commitProjectLifecycle({
                    preparation: inspected.value,
                    userActionId,
                }).status,
            ).toBe("failed");
        }

        const deleted = readProjectManifest(path.join(oaamRoot, "projects"), PROJECT_ID)!;
        writeProjectManifest(path.join(oaamRoot, "projects"), { ...deleted, deleted: true });
        expect(
            core.inspectProjectLifecycle({
                action: "rename",
                projectId: PROJECT_ID,
                nextDisplayName: "Deleted",
            }).status,
        ).toBe("failed");
    });
});

describe("Project lifecycle rebind", () => {
    it("changes only the current Project root and leaves both directories and Deployment targets untouched", () => {
        const identities = [PROJECT_ID, DEPLOYMENT_ID, OTHER_PROJECT_ID];
        const core = makeService(() => identities.shift()!);
        const nextRoot = path.join(sandbox, "next-workspace");
        fs.mkdirSync(nextRoot);
        fs.writeFileSync(path.join(nextRoot, "next.txt"), "new directory stays untouched\n");
        core.registerProject({ rootPath: workspaceRoot, displayName: "Workspace" });
        const deployment = core.createDeployment({
            projectId: PROJECT_ID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local",
            targetRootPath: workspaceRoot,
            assets: [],
        });
        expect(deployment.status).toBe("complete");

        const inspected = core.inspectProjectLifecycle({
            action: "rebind",
            projectId: PROJECT_ID,
            nextRootPath: nextRoot,
        });
        expect(inspected).toMatchObject({
            status: "complete",
            value: {
                schemaVersion: 1,
                action: "rebind",
                projectId: PROJECT_ID,
                displayName: "Workspace",
                currentRootPath: workspaceRoot,
                nextRootPath: nextRoot,
            },
        });
        const committed = core.commitProjectLifecycle({
            preparation: inspected.value,
            userActionId: "rebind-project",
        });
        expect(committed).toMatchObject({
            status: "complete",
            value: {
                projectId: PROJECT_ID,
                rootPath: nextRoot,
                displayName: "Workspace",
                deleted: false,
            },
        });
        expect(core.getDeployment(DEPLOYMENT_ID).value.value?.targetRootPath).toBe(workspaceRoot);
        expect(fs.readFileSync(path.join(workspaceRoot, "untouched.txt"), "utf8")).toBe("outside Project authority\n");
        expect(fs.readFileSync(path.join(nextRoot, "next.txt"), "utf8")).toBe("new directory stays untouched\n");
        expect(core.registerProject({ rootPath: workspaceRoot }).value.projectId).toBe(OTHER_PROJECT_ID);
    });

    it("rejects inaccessible, duplicate, stale, malformed, and changed rebind authority", () => {
        const identities = [PROJECT_ID, OTHER_PROJECT_ID];
        const core = makeService(() => identities.shift()!);
        const nextRoot = path.join(sandbox, "next-workspace");
        const occupiedRoot = path.join(sandbox, "occupied-workspace");
        fs.mkdirSync(nextRoot);
        fs.mkdirSync(occupiedRoot);
        core.registerProject({ rootPath: workspaceRoot, displayName: "Workspace" });
        expect(
            core.inspectProjectLifecycle({
                action: "rebind",
                projectId: PROJECT_ID,
                nextRootPath: workspaceRoot,
            }).status,
        ).toBe("failed");
        expect(
            core.inspectProjectLifecycle({
                action: "rebind",
                projectId: PROJECT_ID,
                nextRootPath: path.join(sandbox, "missing"),
            }).status,
        ).toBe("failed");

        const inspected = core.inspectProjectLifecycle({
            action: "rebind",
            projectId: PROJECT_ID,
            nextRootPath: nextRoot,
        });
        expect(inspected.status).toBe("complete");
        const projectsRoot = path.join(oaamRoot, "projects");
        const current = readProjectManifest(projectsRoot, PROJECT_ID)!;
        fs.rmSync(path.join(projectsRoot, PROJECT_ID, "project.json"));
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "missing-project",
            }).status,
        ).toBe("failed");
        writeProjectManifest(projectsRoot, current);
        writeProjectManifest(projectsRoot, { ...current, deleted: true });
        expect(
            core.inspectProjectLifecycle({
                action: "rebind",
                projectId: PROJECT_ID,
                nextRootPath: nextRoot,
            }).status,
        ).toBe("failed");
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "deleted-project",
            }).status,
        ).toBe("failed");
        writeProjectManifest(projectsRoot, current);

        fs.rmdirSync(nextRoot);
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "missing-destination",
            }).status,
        ).toBe("failed");
        fs.mkdirSync(nextRoot);

        writeProjectManifest(projectsRoot, { ...current, displayName: "Concurrent" });
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "authority-changed-after-review",
            }).status,
        ).toBe("failed");
        writeProjectManifest(projectsRoot, current);

        core.registerProject({ rootPath: occupiedRoot, displayName: "Other" });
        expect(
            core.inspectProjectLifecycle({
                action: "rebind",
                projectId: PROJECT_ID,
                nextRootPath: occupiedRoot,
            }).status,
        ).toBe("failed");
        writeProjectManifest(projectsRoot, {
            ...readProjectManifest(projectsRoot, OTHER_PROJECT_ID)!,
            rootPath: nextRoot,
        });
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "destination-became-owned",
            }).status,
        ).toBe("failed");

        for (const preparation of [
            { ...inspected.value, currentRootPath: occupiedRoot },
            { ...inspected.value, displayName: "Different" },
            { ...inspected.value, nextRootPath: workspaceRoot },
            { ...inspected.value, nextRootPath: "relative" },
        ]) {
            expect(
                core.commitProjectLifecycle({
                    preparation,
                    userActionId: "invalid-rebind",
                }).status,
            ).toBe("failed");
        }
        expect(
            core.commitProjectLifecycle({
                preparation: { ...inspected.value, action: "foreign" } as never,
                userActionId: "foreign-rebind",
            }).status,
        ).toBe("failed");
    });
});

describe("Project lifecycle stop managing", () => {
    it("soft-deletes only Project authority while retaining history, Deployment targets, and external bytes", () => {
        const identities = [
            PROJECT_ID,
            RESTORE_ASSET_ID,
            RESTORE_VERSION_ID,
            RESTORE_FILE_ID,
            RESTORE_TRANSACTION_ID,
            RESTORE_DEPLOYMENT_ID,
        ];
        const core = makeService(() => identities.shift()!);
        expect(core.registerProject({ rootPath: workspaceRoot, displayName: "Workspace" }).status).toBe("complete");
        const asset = core.createAsset(projectGuidance(PROJECT_ID));
        expect(asset.status).toBe("complete");
        const deployment = core.createDeployment({
            projectId: PROJECT_ID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local",
            targetRootPath: workspaceRoot,
            assets: [
                {
                    assetId: RESTORE_ASSET_ID,
                    versionId: RESTORE_VERSION_ID,
                    allowIncomplete: false,
                },
            ],
        });
        expect(deployment.status).toBe("complete");

        const inspected = core.inspectProjectLifecycle({ action: "stop_managing", projectId: PROJECT_ID });
        expect(inspected).toMatchObject({
            status: "complete",
            value: {
                schemaVersion: 1,
                action: "stop_managing",
                projectId: PROJECT_ID,
                displayName: "Workspace",
                rootPath: workspaceRoot,
            },
        });
        const committed = core.commitProjectLifecycle({
            preparation: inspected.value,
            userActionId: "stop-managing-project",
        });
        expect(committed).toMatchObject({
            status: "complete",
            value: {
                projectId: PROJECT_ID,
                displayName: "Workspace",
                rootPath: workspaceRoot,
                deleted: true,
            },
        });

        expect(core.getCurrentVersion(RESTORE_ASSET_ID).value.value?.manifest.versionId).toBe(RESTORE_VERSION_ID);
        expect(core.getDeployment(RESTORE_DEPLOYMENT_ID).value.value).toMatchObject({
            deploymentId: RESTORE_DEPLOYMENT_ID,
            projectId: PROJECT_ID,
            targetRootPath: workspaceRoot,
            deleted: false,
            assets: [{ assetId: RESTORE_ASSET_ID, versionId: RESTORE_VERSION_ID }],
        });
        expect(fs.readFileSync(path.join(workspaceRoot, "untouched.txt"), "utf8")).toBe("outside Project authority\n");
        expect(fs.readdirSync(workspaceRoot)).toEqual(["untouched.txt"]);
        expect(core.inspectProjectLifecycle({ action: "stop_managing", projectId: PROJECT_ID }).status).toBe("failed");
    });

    it("does not require, recreate, or inspect an unavailable external root", () => {
        const core = makeService();
        expect(core.registerProject({ rootPath: workspaceRoot, displayName: "Unavailable" }).status).toBe("complete");
        fs.rmSync(workspaceRoot, { recursive: true });

        const inspected = core.inspectProjectLifecycle({ action: "stop_managing", projectId: PROJECT_ID });
        expect(inspected).toMatchObject({
            status: "complete",
            value: {
                action: "stop_managing",
                projectId: PROJECT_ID,
                rootPath: workspaceRoot,
            },
        });
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "stop-unavailable-project",
            }).status,
        ).toBe("complete");
        expect(fs.existsSync(workspaceRoot)).toBe(false);
    });

    it("rejects missing, stale, deleted, malformed, and unsupported stop-managing authority", () => {
        const core = makeService();
        expect(core.inspectProjectLifecycle({ action: "stop_managing", projectId: PROJECT_ID }).status).toBe("failed");
        expect(core.registerProject({ rootPath: workspaceRoot, displayName: "Project" }).status).toBe("complete");
        const inspected = core.inspectProjectLifecycle({ action: "stop_managing", projectId: PROJECT_ID });
        const projectsRoot = path.join(oaamRoot, "projects");
        const current = readProjectManifest(projectsRoot, PROJECT_ID)!;

        fs.rmSync(path.join(projectsRoot, PROJECT_ID, "project.json"));
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "missing-stop-authority",
            }).status,
        ).toBe("failed");
        writeProjectManifest(projectsRoot, current);
        writeProjectManifest(projectsRoot, { ...current, deleted: true });
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "deleted-stop-authority",
            }).status,
        ).toBe("failed");
        writeProjectManifest(projectsRoot, current);
        writeProjectManifest(projectsRoot, { ...current, displayName: "Concurrent", updatedAt: current.updatedAt + 1 });
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "stale-stop-review",
            }).status,
        ).toBe("failed");
        writeProjectManifest(projectsRoot, current);

        for (const preparation of [
            { ...inspected.value, displayName: "Different" },
            { ...inspected.value, rootPath: "relative" },
            { ...inspected.value, projectAuthorityFingerprint: "bad" },
        ]) {
            expect(
                core.commitProjectLifecycle({
                    preparation: preparation as typeof inspected.value,
                    userActionId: "invalid-stop-review",
                }).status,
            ).toBe("failed");
        }
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "",
            }).status,
        ).toBe("failed");
        expect(
            core.commitProjectLifecycle({
                preparation: { ...inspected.value, action: "foreign" } as never,
                userActionId: "foreign-stop-review",
            }).status,
        ).toBe("failed");

        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "stop-project",
            }).status,
        ).toBe("complete");
        expect(core.inspectProjectLifecycle({ action: "stop_managing", projectId: PROJECT_ID }).status).toBe("failed");
    });
});

describe("Project lifecycle restore", () => {
    it("reactivates the same UUID and retains Project Assets, Deployments, and external files", () => {
        const identities = [
            PROJECT_ID,
            RESTORE_ASSET_ID,
            RESTORE_VERSION_ID,
            RESTORE_FILE_ID,
            RESTORE_TRANSACTION_ID,
            RESTORE_DEPLOYMENT_ID,
        ];
        const core = makeService(() => identities.shift()!);
        expect(core.registerProject({ rootPath: workspaceRoot, displayName: "Workspace" }).status).toBe("complete");
        const asset = core.createAsset(projectGuidance(PROJECT_ID));
        expect(asset.status).toBe("complete");
        const deployment = core.createDeployment({
            projectId: PROJECT_ID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local",
            targetRootPath: workspaceRoot,
            assets: [],
        });
        expect(deployment.status).toBe("complete");
        expect(stopManagingProject(core).value.deleted).toBe(true);

        const inspected = core.inspectProjectLifecycle({ action: "restore", projectId: PROJECT_ID });
        expect(inspected).toMatchObject({
            status: "complete",
            value: {
                schemaVersion: 1,
                action: "restore",
                projectId: PROJECT_ID,
                displayName: "Workspace",
                rootPath: workspaceRoot,
                rootAccessState: "available",
            },
        });
        const committed = core.commitProjectLifecycle({
            preparation: inspected.value,
            userActionId: "restore-project",
        });
        expect(committed).toMatchObject({
            status: "complete",
            value: {
                projectId: PROJECT_ID,
                rootPath: workspaceRoot,
                displayName: "Workspace",
                deleted: false,
            },
        });
        expect(core.getCurrentVersion(RESTORE_ASSET_ID).value.value?.manifest.versionId).toBe(RESTORE_VERSION_ID);
        expect(core.getDeployment(RESTORE_DEPLOYMENT_ID).value.value).toMatchObject({
            deploymentId: RESTORE_DEPLOYMENT_ID,
            projectId: PROJECT_ID,
            targetRootPath: workspaceRoot,
            deleted: false,
            assets: [],
        });
        expect(fs.readFileSync(path.join(workspaceRoot, "untouched.txt"), "utf8")).toBe("outside Project authority\n");
        expect(fs.readdirSync(workspaceRoot)).toEqual(["untouched.txt"]);
    });

    it("restores an unavailable root without importing bytes and rejects a changed access review", () => {
        const core = makeService();
        core.registerProject({ rootPath: workspaceRoot, displayName: "Unavailable" });
        stopManagingProject(core);
        fs.rmSync(workspaceRoot, { recursive: true });

        const unavailable = core.inspectProjectLifecycle({ action: "restore", projectId: PROJECT_ID });
        expect(unavailable).toMatchObject({
            status: "complete",
            value: {
                action: "restore",
                projectId: PROJECT_ID,
                rootPath: workspaceRoot,
                rootAccessState: "unavailable",
            },
        });
        fs.mkdirSync(workspaceRoot);
        fs.writeFileSync(path.join(workspaceRoot, "appeared.txt"), "new external bytes\n");
        expect(
            core.commitProjectLifecycle({
                preparation: unavailable.value,
                userActionId: "stale-unavailable-review",
            }).status,
        ).toBe("failed");

        const available = core.inspectProjectLifecycle({ action: "restore", projectId: PROJECT_ID });
        expect(available.value.rootAccessState).toBe("available");
        expect(
            core.commitProjectLifecycle({
                preparation: available.value,
                userActionId: "restore-current-review",
            }).status,
        ).toBe("complete");
        expect(fs.readFileSync(path.join(workspaceRoot, "appeared.txt"), "utf8")).toBe("new external bytes\n");
    });

    it("rejects active, missing, duplicate-root, stale, and malformed restore authority", () => {
        const identities = [PROJECT_ID, OTHER_PROJECT_ID];
        const core = makeService(() => identities.shift()!);
        const otherRoot = path.join(sandbox, "other-workspace");
        fs.mkdirSync(otherRoot);
        core.registerProject({ rootPath: workspaceRoot, displayName: "Deleted" });
        expect(core.inspectProjectLifecycle({ action: "restore", projectId: PROJECT_ID }).status).toBe("failed");
        expect(core.inspectProjectLifecycle({ action: "restore", projectId: OTHER_PROJECT_ID }).status).toBe("failed");
        stopManagingProject(core);
        const inspected = core.inspectProjectLifecycle({ action: "restore", projectId: PROJECT_ID });
        const projectsRoot = path.join(oaamRoot, "projects");
        const deleted = readProjectManifest(projectsRoot, PROJECT_ID)!;

        fs.rmSync(path.join(projectsRoot, PROJECT_ID, "project.json"));
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "missing-project",
            }).status,
        ).toBe("failed");
        writeProjectManifest(projectsRoot, deleted);
        writeProjectManifest(projectsRoot, { ...deleted, deleted: false });
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "already-active",
            }).status,
        ).toBe("failed");
        writeProjectManifest(projectsRoot, deleted);
        writeProjectManifest(projectsRoot, { ...deleted, displayName: "Concurrent" });
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "changed-project",
            }).status,
        ).toBe("failed");
        writeProjectManifest(projectsRoot, deleted);

        core.registerProject({ rootPath: otherRoot, displayName: "Other" });
        const otherRebind = core.inspectProjectLifecycle({
            action: "rebind",
            projectId: OTHER_PROJECT_ID,
            nextRootPath: workspaceRoot,
        });
        expect(
            core.commitProjectLifecycle({
                preparation: otherRebind.value,
                userActionId: "occupy-deleted-root",
            }).status,
        ).toBe("complete");
        expect(
            core.commitProjectLifecycle({
                preparation: inspected.value,
                userActionId: "duplicate-root",
            }).status,
        ).toBe("failed");

        for (const preparation of [
            { ...inspected.value, displayName: "Different" },
            { ...inspected.value, rootPath: "relative" },
            { ...inspected.value, rootAccessState: "unknown" },
        ]) {
            expect(
                core.commitProjectLifecycle({
                    preparation: preparation as typeof inspected.value,
                    userActionId: "invalid-restore",
                }).status,
            ).toBe("failed");
        }
        expect(
            core.commitProjectLifecycle({
                preparation: { ...inspected.value, action: "foreign" } as never,
                userActionId: "foreign-restore",
            }).status,
        ).toBe("failed");
    });
});
