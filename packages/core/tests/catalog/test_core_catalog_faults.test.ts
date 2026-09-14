/** Project, Asset, and Settings fault/action-time catalog guards. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreAssetService, createCoreAssetServiceForTest } from "../../src/orchestration/core-asset-service";
import { createCoreProjectService, createCoreProjectServiceForTest } from "../../src/orchestration/core-project-service";
import { createCoreSettingsService } from "../../src/orchestration/core-settings-service";
import { reindexProjects } from "../../src/catalog/reindex-projects";
import { closeDb, getDb } from "../../src/persistence/db";
import { writeProjectManifest } from "../../src/catalog/project-authority";
import { EMPTY_VERSION_DIALECT_REGISTRY } from "../../src/catalog/version-authority";
import type { CreateAssetInput, ProjectManifestV1, UuidV4 } from "../../src/types";

const PROJECT_ID = "00000000-0000-4000-8000-000000000401" as UuidV4;

let sandbox = "";
let oaamRoot = "";
let projectsRoot = "";
let assetsRoot = "";
let locksRoot = "";
let transactionsRoot = "";
let databasePath = "";
let workspaceRoot = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-core-catalog-faults-"));
    oaamRoot = path.join(sandbox, "oaam");
    projectsRoot = path.join(oaamRoot, "projects");
    assetsRoot = path.join(oaamRoot, "assets");
    locksRoot = path.join(oaamRoot, "transactions", "authority-locks");
    transactionsRoot = path.join(oaamRoot, "transactions");
    databasePath = path.join(sandbox, "state.db");
    workspaceRoot = path.join(sandbox, "workspace");
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(transactionsRoot, { recursive: true });
    closeDb();
});

afterEach(() => {
    closeDb();
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

function initialGuidance(): CreateAssetInput {
    return {
        kind: "Guidance",
        scope: "global",
        projectId: "",
        scopePath: "",
        displayName: "Guidance",
        initialVersion: {
            typeData: { schemaVersion: 1 },
            files: [
                {
                    logicalPath: "GUIDANCE.md",
                    role: "entry",
                    contentKind: "text",
                    mediaType: "text/markdown",
                    text: "# Guidance\r\n",
                    executable: false,
                },
            ],
            userActionEvidenceId: "create-guidance",
            changeKind: "create",
        },
    };
}

function projectManifest(overrides: Partial<ProjectManifestV1> = {}): ProjectManifestV1 {
    return {
        schemaVersion: 1,
        projectId: PROJECT_ID,
        rootPath: workspaceRoot,
        displayName: "Workspace",
        deleted: false,
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

function stopManagingProject(service: ReturnType<typeof createCoreProjectService>, projectId: UuidV4 = PROJECT_ID) {
    const inspected = service.inspectProjectLifecycle({ action: "stop_managing", projectId });
    if (inspected.status !== "complete") throw new Error("stop-managing inspection failed in test setup");
    return service.commitProjectLifecycle({
        preparation: inspected.value,
        userActionId: "stop-managing-test",
    });
}

describe("Project catalog failure boundaries", () => {
    it("rechecks an existing Project after acquiring its authority lock", () => {
        const configuration = {
            projectsRoot,
            assetsRoot,
            authorityLocksRoot: locksRoot,
            transactionsRoot,
            db: getDb(databasePath),
            assertMutationScope: () => undefined,
            now: () => 2,
            newUuid: () => PROJECT_ID,
        };
        const initial = createCoreProjectService(configuration);
        const registered = initial.registerProject({ rootPath: workspaceRoot });
        expect(registered.status).toBe("complete");

        const racing = createCoreProjectServiceForTest(configuration, {
            afterExistingProjectLockAcquired() {
                writeProjectManifest(projectsRoot, projectManifest({ deleted: true }));
            },
        });
        const result = racing.registerProject({ rootPath: workspaceRoot });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toMatch(/registered Project is deleted/);
        expect(configuration.db.prepare("SELECT deleted FROM project_index WHERE project_id = ?").get(PROJECT_ID)).toEqual({
            deleted: 0,
        });

        writeProjectManifest(projectsRoot, registered.value);
        const recovered = stopManagingProject(initial);
        expect(recovered.status).toBe("complete");
        expect(configuration.db.prepare("SELECT deleted FROM project_index WHERE project_id = ?").get(PROJECT_ID)).toEqual({
            deleted: 1,
        });
    });

    it("rejects an existing Project whose root authority changes after lock acquisition", () => {
        const configuration = {
            projectsRoot,
            assetsRoot,
            authorityLocksRoot: locksRoot,
            transactionsRoot,
            db: getDb(databasePath),
            assertMutationScope: () => undefined,
            now: () => 2,
            newUuid: () => PROJECT_ID,
        };
        const initial = createCoreProjectService(configuration);
        expect(initial.registerProject({ rootPath: workspaceRoot }).status).toBe("complete");
        const replacementRoot = path.join(sandbox, "replacement-workspace");
        fs.mkdirSync(replacementRoot);

        const racing = createCoreProjectServiceForTest(configuration, {
            afterExistingProjectLockAcquired() {
                writeProjectManifest(projectsRoot, projectManifest({ rootPath: replacementRoot, updatedAt: 3 }));
            },
        });
        const result = racing.registerProject({ rootPath: workspaceRoot });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("Project authority changed during registration");
        expect(initial.getProject(PROJECT_ID).value.value?.rootPath).toBe(replacementRoot);
    });

    it("rechecks Project authority after all stop-managing locks are acquired", () => {
        let actionTimeMutation = false;
        const service = createCoreProjectService({
            projectsRoot,
            assetsRoot,
            authorityLocksRoot: locksRoot,
            transactionsRoot,
            db: getDb(databasePath),
            assertMutationScope: () => {
                if (actionTimeMutation) {
                    writeProjectManifest(projectsRoot, projectManifest({ deleted: true }));
                }
            },
            now: () => 2,
            newUuid: () => PROJECT_ID,
        });
        const registered = service.registerProject({ rootPath: workspaceRoot });
        expect(registered.status).toBe("complete");
        actionTimeMutation = true;
        const result = stopManagingProject(service);
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toMatch(/changed during stop managing/);
        expect(service.registerProject({ rootPath: workspaceRoot }).status).toBe("failed");
    });

    it("keeps committed Project authority when its disposable index projection fails", () => {
        const configuration = (db: ReturnType<typeof getDb>) => ({
            projectsRoot,
            assetsRoot,
            authorityLocksRoot: locksRoot,
            transactionsRoot,
            db,
            assertMutationScope: () => undefined,
            now: () => 2,
            newUuid: () => PROJECT_ID,
        });
        const service = createCoreProjectService(configuration(getDb(databasePath)));
        closeDb();
        const result = service.registerProject({ rootPath: workspaceRoot });
        expect(result.status, JSON.stringify(result)).toBe("partial");
        expect(result.value).toEqual(projectManifest({ displayName: "", createdAt: 2, updatedAt: 2 }));
        expect(result.diagnostics[0]?.code).toBe("project.index_projection_failed");
        expect(fs.existsSync(path.join(projectsRoot, PROJECT_ID, "project.json"))).toBe(true);

        const reopenedDb = getDb(databasePath);
        const reopened = createCoreProjectService(configuration(reopenedDb));
        expect(reopened.registerProject({ rootPath: workspaceRoot }).status).toBe("complete");
        expect(reopenedDb.prepare("SELECT project_id, deleted FROM project_index WHERE project_id = ?").get(PROJECT_ID)).toEqual({
            project_id: PROJECT_ID,
            deleted: 0,
        });

        reopenedDb.exec(`
            CREATE TRIGGER fail_project_index_update
            BEFORE UPDATE ON project_index
            BEGIN
                SELECT RAISE(ABORT, 'injected project projection failure');
            END
        `);
        const deleted = stopManagingProject(reopened);
        expect(deleted.status).toBe("partial");
        expect(deleted.value.deleted).toBe(true);

        reopenedDb.exec("DROP TRIGGER fail_project_index_update");
        closeDb();
        const finalDb = getDb(databasePath);
        expect(reindexProjects(projectsRoot, finalDb)).toEqual({
            scannedProjects: 1,
            indexedProjects: 1,
            skippedProjects: 0,
            diagnostics: [],
        });
        expect(finalDb.prepare("SELECT project_id, deleted FROM project_index WHERE project_id = ?").get(PROJECT_ID)).toEqual({
            project_id: PROJECT_ID,
            deleted: 1,
        });
    });

    it("reports corrupt inventory entries and inventory access failures", () => {
        const service = createCoreProjectService({
            projectsRoot,
            assetsRoot,
            authorityLocksRoot: locksRoot,
            transactionsRoot,
            db: getDb(databasePath),
            assertMutationScope: () => undefined,
            now: () => 2,
            newUuid: identityFactory(410),
        });
        const corruptId = "00000000-0000-4000-8000-000000000411" as UuidV4;
        const corruptRoot = path.join(projectsRoot, corruptId);
        fs.mkdirSync(corruptRoot, { recursive: true });
        fs.writeFileSync(path.join(corruptRoot, "project.json"), "{bad");
        expect(service.listProjects().status).toBe("partial");
        expect(service.registerProject({ rootPath: workspaceRoot }).status).toBe("failed");

        fs.rmSync(path.join(corruptRoot, "project.json"));
        expect(service.listProjects().status).toBe("complete");
        expect(service.registerProject({ rootPath: workspaceRoot }).status).toBe("failed");
        fs.rmSync(corruptRoot, { recursive: true, force: true });
        fs.mkdirSync(path.join(projectsRoot, "not-a-uuid"));
        expect(service.registerProject({ rootPath: workspaceRoot }).status).toBe("failed");

        fs.rmSync(projectsRoot, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(projectsRoot), { recursive: true });
        fs.writeFileSync(projectsRoot, "not-a-directory");
        expect(service.listProjects().status).toBe("failed");
    });

    it("preserves non-Error mutation failures in a typed diagnostic", () => {
        const service = createCoreProjectService({
            projectsRoot,
            assetsRoot,
            authorityLocksRoot: locksRoot,
            transactionsRoot,
            db: getDb(databasePath),
            assertMutationScope: () => {
                throw "project-scope-string";
            },
            now: () => 2,
            newUuid: () => PROJECT_ID,
        });
        const result = service.registerProject({ rootPath: workspaceRoot, displayName: " " });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("displayName may be empty but not blank");
        const scopeFailure = service.registerProject({ rootPath: workspaceRoot });
        expect(scopeFailure.status).toBe("failed");
        expect(scopeFailure.diagnostics[0]?.message).toBe("project-scope-string");

        const invalidIdentity = createCoreProjectService({
            projectsRoot,
            assetsRoot,
            authorityLocksRoot: locksRoot,
            transactionsRoot,
            db: getDb(databasePath),
            assertMutationScope: () => undefined,
            now: () => 2,
            newUuid: () => "bad" as UuidV4,
        });
        expect(invalidIdentity.registerProject({ rootPath: workspaceRoot }).status).toBe("failed");
        expect(invalidIdentity.getProject("bad" as UuidV4).status).toBe("failed");
    });

    it("fails closed when stop managing cannot inventory Asset authority", () => {
        writeProjectManifest(projectsRoot, projectManifest());
        fs.mkdirSync(oaamRoot, { recursive: true });
        fs.writeFileSync(assetsRoot, "not-a-directory");
        const service = createCoreProjectService({
            projectsRoot,
            assetsRoot,
            authorityLocksRoot: locksRoot,
            transactionsRoot,
            db: getDb(databasePath),
            assertMutationScope: () => undefined,
            now: () => 2,
            newUuid: identityFactory(),
        });
        expect(stopManagingProject(service).status).toBe("failed");
    });

    it("fails closed on unexpected Asset authority entries during stop managing", () => {
        writeProjectManifest(projectsRoot, projectManifest());
        fs.mkdirSync(assetsRoot, { recursive: true });
        fs.writeFileSync(path.join(assetsRoot, "unexpected-owner"), "not authority");
        const service = createCoreProjectService({
            projectsRoot,
            assetsRoot,
            authorityLocksRoot: locksRoot,
            transactionsRoot,
            db: getDb(databasePath),
            assertMutationScope: () => undefined,
            now: () => 2,
            newUuid: identityFactory(),
        });
        const result = stopManagingProject(service);
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toMatch(/unexpected entry/);
        expect(service.getProject(PROJECT_ID).value).toEqual({
            found: true,
            value: projectManifest(),
        });
    });

    it("fails closed when Asset staging authority is not a directory", () => {
        writeProjectManifest(projectsRoot, projectManifest());
        fs.mkdirSync(assetsRoot, { recursive: true });
        fs.writeFileSync(path.join(assetsRoot, ".staging"), "not a directory");
        const service = createCoreProjectService({
            projectsRoot,
            assetsRoot,
            authorityLocksRoot: locksRoot,
            transactionsRoot,
            db: getDb(databasePath),
            assertMutationScope: () => undefined,
            now: () => 2,
            newUuid: identityFactory(),
        });
        const result = stopManagingProject(service);
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("Asset staging authority must be a directory");
        expect(service.getProject(PROJECT_ID).value.value?.deleted).toBe(false);
    });

    it("fails closed when an Asset authority directory has no asset.json", () => {
        writeProjectManifest(projectsRoot, projectManifest());
        const assetId = "00000000-0000-4000-8000-000000000412";
        fs.mkdirSync(path.join(assetsRoot, assetId), { recursive: true });
        const service = createCoreProjectService({
            projectsRoot,
            assetsRoot,
            authorityLocksRoot: locksRoot,
            transactionsRoot,
            db: getDb(databasePath),
            assertMutationScope: () => undefined,
            now: () => 2,
            newUuid: identityFactory(),
        });
        const result = stopManagingProject(service);
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe(`Asset authority is missing: ${assetId}`);
        expect(service.getProject(PROJECT_ID).value.value?.deleted).toBe(false);
    });
});

describe("Asset and Settings catalog failure boundaries", () => {
    it("rechecks Asset mutation scope after acquiring the exact authority lock", () => {
        let checks = 0;
        const service = createCoreAssetService({
            assetsRoot,
            projectsRoot,
            authorityLocksRoot: locksRoot,
            db: getDb(databasePath),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            assertMutationScope: () => {
                checks += 1;
                if (checks === 2) throw new Error("action-time Asset freeze");
            },
            now: () => 10,
            newUuid: identityFactory(),
        });
        const result = service.createAsset(initialGuidance());
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("action-time Asset freeze");
        expect(fs.existsSync(assetsRoot)).toBe(false);
    });

    it("publishes a Version even when index projection fails after durable authority commit", () => {
        fs.mkdirSync(path.join(assetsRoot, "00000000-0000-4000-8000-000000000499"), { recursive: true });
        const service = createCoreAssetService({
            assetsRoot,
            projectsRoot,
            authorityLocksRoot: locksRoot,
            db: getDb(databasePath),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            assertMutationScope: () => undefined,
            now: () => 10,
            newUuid: identityFactory(),
        });
        const created = service.createAsset(initialGuidance());
        expect(created.status, JSON.stringify(created)).toBe("complete");
        const parentVersionId = created.value.versionIds[0] as UuidV4;
        closeDb();
        const next = service.createVersion(created.value.assetId, {
            typeData: { schemaVersion: 1 },
            files: [],
            userActionEvidenceId: "remove-guidance",
            changeKind: "edit",
            sourceVersionId: parentVersionId,
        });
        expect(next.status, JSON.stringify(next)).toBe("partial");
        expect(next.value.status).toBe("incomplete");
        expect(next.diagnostics[0]?.code).toBe("asset.index_projection_failed");
    });

    it("rejects unreadable Asset inventory and preserves non-Error scope failures", () => {
        fs.mkdirSync(oaamRoot, { recursive: true });
        fs.writeFileSync(assetsRoot, "not-a-directory");
        const service = createCoreAssetService({
            assetsRoot,
            projectsRoot,
            authorityLocksRoot: locksRoot,
            db: getDb(databasePath),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            assertMutationScope: () => undefined,
            now: () => 10,
            newUuid: identityFactory(),
        });
        expect(service.reindexAssets().status).toBe("failed");

        const stringFailure = createCoreAssetService({
            assetsRoot: path.join(oaamRoot, "other-assets"),
            projectsRoot,
            authorityLocksRoot: locksRoot,
            db: getDb(databasePath),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            assertMutationScope: () => {
                throw "asset-scope-string";
            },
            now: () => 10,
            newUuid: identityFactory(),
        });
        const failed = stringFailure.createAsset(initialGuidance());
        expect(failed.status).toBe("failed");
        expect(failed.diagnostics[0]?.message).toBe("asset-scope-string");
    });

    it("fault injection: rejects an Asset removed after its authority lock is acquired", () => {
        let removeAfterLock = false;
        const service = createCoreAssetServiceForTest(
            {
                assetsRoot,
                projectsRoot,
                authorityLocksRoot: locksRoot,
                db: getDb(databasePath),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                assertMutationScope: () => undefined,
                now: () => 10,
                newUuid: identityFactory(),
            },
            {
                afterExistingAssetLock() {
                    if (removeAfterLock) {
                        fs.rmSync(assetsRoot, { recursive: true, force: true });
                    }
                },
            },
        );
        const created = service.createAsset(initialGuidance());
        expect(created.status).toBe("complete");
        removeAfterLock = true;
        const result = service.updateAssetDisplay(created.value.assetId, {
            displayName: "must-not-publish",
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("Asset not found");
    });

    it("fault injection: reports a post-publish Version disappearance as partial projection", () => {
        let removeVersionBeforeProjection = false;
        let currentVersionId = "";
        const service = createCoreAssetServiceForTest(
            {
                assetsRoot,
                projectsRoot,
                authorityLocksRoot: locksRoot,
                db: getDb(databasePath),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                assertMutationScope: () => undefined,
                now: () => 10,
                newUuid: identityFactory(),
            },
            {
                beforeIndexProjection(asset) {
                    if (removeVersionBeforeProjection) {
                        fs.rmSync(path.join(assetsRoot, asset.assetId, "versions", currentVersionId, "version.json"));
                    }
                },
            },
        );
        const created = service.createAsset(initialGuidance());
        currentVersionId = created.value.versionIds[0] ?? "";
        removeVersionBeforeProjection = true;
        const result = service.updateAssetDisplay(created.value.assetId, {
            displayDescription: "authority survives projection race",
        });
        expect(result.status).toBe("partial");
        expect(result.diagnostics[0]?.code).toBe("reindex.version_missing");
    });

    it("preserves non-Error Settings mutation failures", () => {
        const service = createCoreSettingsService({
            oaamRoot,
            authorityLocksRoot: locksRoot,
            assertMutationScope: () => {
                throw "settings-scope-string";
            },
        });
        const result = service.setSetting("client.ui", { configVersion: 1 });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("settings-scope-string");
    });

    it("rechecks Settings mutation scope while holding the settings authority lock", () => {
        let checks = 0;
        const service = createCoreSettingsService({
            oaamRoot,
            authorityLocksRoot: locksRoot,
            assertMutationScope: () => {
                checks += 1;
                if (checks === 2) throw new Error("action-time Settings freeze");
            },
        });
        const result = service.setSetting("client.ui", { configVersion: 1 });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("action-time Settings freeze");
        expect(service.getSetting("client.ui").value).toEqual({ found: false });
    });
});
