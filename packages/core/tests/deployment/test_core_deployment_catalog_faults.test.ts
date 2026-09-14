/** Deployment catalog transaction, readback, and action-time fault guards. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    createCoreDeploymentCatalogService,
    createCoreDeploymentCatalogServiceForTest,
} from "../../src/orchestration/core-deployment-service";
import {
    EMPTY_VERSION_DIALECT_REGISTRY,
    publishAssetVersion,
    publishInitialAssetVersion,
} from "../../src/catalog/version-authority";
import { readDeploymentView } from "../../src/deployment/deployment-view";
import { closeDb, getDb } from "../../src/persistence/db";
import { listDeploymentAssets } from "../../src/persistence/state-db";
import { makeAsset, makeVersionClosure } from "../catalog/fixtures/version-v2";
import type { UuidV4 } from "../../src/types";

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

describe("Deployment catalog fault boundaries", () => {
    it("preserves another member's Version changed after the client's read, then accepts a freshly reviewed selection", () => {
        const firstAsset = "00000000-0000-4000-8000-000000000071" as UuidV4;
        const otherAsset = "00000000-0000-4000-8000-000000000072" as UuidV4;
        const oldVersion = "00000000-0000-4000-8000-000000000081" as UuidV4;
        const newerVersion = "00000000-0000-4000-8000-000000000082" as UuidV4;
        const otherOld = "00000000-0000-4000-8000-000000000083" as UuidV4;
        const otherNew = "00000000-0000-4000-8000-000000000084" as UuidV4;
        for (const [assetId, first, second] of [
            [firstAsset, oldVersion, newerVersion],
            [otherAsset, otherOld, otherNew],
        ]) {
            publishInitialAssetVersion({
                assetsRoot,
                transactionId: `create-${assetId}`,
                asset: makeAsset([first!], { assetId: assetId! }),
                version: makeVersionClosure({ assetId, versionId: first }),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            });
            publishAssetVersion({
                assetsRoot,
                transactionId: `append-${assetId}`,
                version: makeVersionClosure({
                    assetId,
                    versionId: second,
                    revision: 2,
                    sourceVersionId: first,
                    changeKind: "edit",
                }),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            });
        }
        const { service, deploymentId } = deploymentServiceWithActionTimeFault((db, id) => {
            db.prepare("UPDATE deployment_assets SET version_id = ? WHERE deployment_id = ? AND asset_id = ?").run(
                otherNew,
                id,
                otherAsset,
            );
        });
        const db = getDb(databasePath);
        expect(
            service.updateDeploymentInputs(deploymentId, {
                assets: [
                    { assetId: firstAsset, versionId: oldVersion, allowIncomplete: false },
                    { assetId: otherAsset, versionId: otherOld, allowIncomplete: false },
                ],
            }).status,
        ).toBe("complete");
        const selected = service.getDeployment(deploymentId);
        expect(selected.status).toBe("complete");
        const observed = selected.value.value!;
        const result = service.updateDeploymentInputs(deploymentId, {
            assets: observed.assets.map((asset) =>
                asset.assetId === firstAsset ? { ...asset, versionId: newerVersion } : asset,
            ),
            expectedInputs: { consumerAgentRuntimeIds: observed.consumerAgentRuntimeIds, assets: observed.assets },
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics).toMatchObject([{ code: "deploy.inputs_changed", causeKind: "conflict", retryable: true }]);
        expect(listDeploymentAssets(db, deploymentId, false).map((asset) => [asset.assetId, asset.versionId])).toEqual([
            [firstAsset, oldVersion],
            [otherAsset, otherNew],
        ]);
        const refreshed = service.getDeployment(deploymentId).value.value!;
        const desired = refreshed.assets.map((asset) =>
            asset.assetId === firstAsset ? { ...asset, versionId: newerVersion } : asset,
        );
        for (const expectedAssets of [
            [...refreshed.assets].reverse(),
            refreshed.assets.map((asset) => ({ ...asset, allowIncomplete: true })),
        ]) {
            const rejected = service.updateDeploymentInputs(deploymentId, {
                assets: desired,
                expectedInputs: { consumerAgentRuntimeIds: refreshed.consumerAgentRuntimeIds, assets: expectedAssets },
            });
            expect(rejected.diagnostics).toMatchObject([{ code: "deploy.inputs_changed" }]);
            expect(service.getDeployment(deploymentId).value.value?.assets).toEqual(refreshed.assets);
        }
        const accepted = service.updateDeploymentInputs(deploymentId, {
            assets: desired,
            expectedInputs: { consumerAgentRuntimeIds: refreshed.consumerAgentRuntimeIds, assets: refreshed.assets },
        });
        expect(accepted.status).toBe("complete");
        expect(accepted.value.assets).toEqual(desired);
        expect(fs.readdirSync(workspaceRoot)).toEqual([]);
    });

    it("rejects changed consumers and accepts an exact expectation after canonicalizing their set order", () => {
        const { service, deploymentId } = deploymentServiceWithActionTimeFault(() => undefined);
        const expectedInputs = { consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"], assets: [] };
        const mismatch = service.updateDeploymentInputs(deploymentId, {
            consumerAgentRuntimeIds: ["CODEX_CLI"],
            expectedInputs: { ...expectedInputs, consumerAgentRuntimeIds: ["OPENCODE_CLI"] },
        });
        expect(mismatch.status).toBe("failed");
        expect(service.getDeployment(deploymentId).value.value?.consumerAgentRuntimeIds).toEqual(["CLAUDE_CODE_CLI"]);
        const accepted = service.updateDeploymentInputs(deploymentId, {
            consumerAgentRuntimeIds: ["CODEX_CLI", "CLAUDE_CODE_CLI"],
            expectedInputs,
        });
        expect(accepted.status).toBe("complete");
        expect(
            service.updateDeploymentInputs(deploymentId, {
                expectedInputs: { consumerAgentRuntimeIds: ["CODEX_CLI", "CLAUDE_CODE_CLI"], assets: [] },
            }).status,
        ).toBe("complete");
        expect(fs.readdirSync(workspaceRoot)).toEqual([]);
    });

    function deploymentServiceWithActionTimeFault(mutate: (db: ReturnType<typeof getDb>, deploymentId: UuidV4) => void) {
        const db = getDb(databasePath);
        let inject = false;
        const service = createCoreDeploymentCatalogServiceForTest(
            {
                db,
                assetsRoot,
                projectsRoot,
                authorityLocksRoot: locksRoot,
                transactionsRoot,
                readDeploymentView,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                assertMutationScope: () => undefined,
                now: () => 10,
                newUuid: identityFactory(470),
            },
            {
                afterOperationLockAcquired(deploymentId) {
                    if (inject) mutate(db, deploymentId);
                },
            },
        );
        const created = service.createDeployment({
            projectId: "",
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local-linux",
            targetRootPath: workspaceRoot,
            assets: [],
        });
        expect(created.status, JSON.stringify(created)).toBe("complete");
        inject = true;
        return { service, deploymentId: created.value.deploymentId };
    }

    function deploymentServiceWithMutationReadbackFault() {
        const db = getDb(databasePath);
        let inject = false;
        const service = createCoreDeploymentCatalogServiceForTest(
            {
                db,
                assetsRoot,
                projectsRoot,
                authorityLocksRoot: locksRoot,
                transactionsRoot,
                readDeploymentView,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                assertMutationScope: () => undefined,
                now: () => 10,
                newUuid: identityFactory(480),
            },
            {
                beforeMutationReadback(deploymentId) {
                    if (inject) {
                        db.prepare("DELETE FROM deployments WHERE deployment_id = ?").run(deploymentId);
                    }
                },
            },
        );
        const created = service.createDeployment({
            projectId: "",
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local-linux",
            targetRootPath: workspaceRoot,
            assets: [],
        });
        expect(created.status, JSON.stringify(created)).toBe("complete");
        inject = true;
        return { db, service, deploymentId: created.value.deploymentId };
    }

    it("fault injection: rolls back Deployment creation when authoritative readback fails", () => {
        const db = getDb(databasePath);
        const service = createCoreDeploymentCatalogServiceForTest(
            {
                db,
                assetsRoot,
                projectsRoot,
                authorityLocksRoot: locksRoot,
                transactionsRoot,
                readDeploymentView,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                assertMutationScope: () => undefined,
                now: () => 10,
                newUuid: identityFactory(450),
            },
            {
                beforeMutationReadback(deploymentId) {
                    db.prepare("DELETE FROM deployments WHERE deployment_id = ?").run(deploymentId);
                },
            },
        );
        const result = service.createDeployment({
            projectId: "",
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local-linux",
            targetRootPath: workspaceRoot,
            assets: [],
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("Deployment disappeared after mutation");
        expect(db.prepare("SELECT COUNT(*) AS count FROM deployments").get()).toEqual({ count: 0 });
    });

    it("fault injection: rolls back Deployment input updates when authoritative readback fails", () => {
        const fixture = deploymentServiceWithMutationReadbackFault();
        const result = fixture.service.updateDeploymentInputs(fixture.deploymentId, {
            consumerAgentRuntimeIds: ["ANTIGRAVITY_CLI"],
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("Deployment disappeared after mutation");
        expect(
            fixture.db
                .prepare("SELECT consumer_agent_runtime_ids AS consumers, deleted FROM deployments WHERE deployment_id = ?")
                .get(fixture.deploymentId),
        ).toEqual({ consumers: '["CLAUDE_CODE_CLI"]', deleted: 0 });
    });

    it("fault injection: rolls back Deployment deletion when authoritative readback fails", () => {
        const fixture = deploymentServiceWithMutationReadbackFault();
        const result = fixture.service.softDeleteDeployment(fixture.deploymentId);
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("Deployment disappeared after mutation");
        expect(fixture.db.prepare("SELECT deleted FROM deployments WHERE deployment_id = ?").get(fixture.deploymentId)).toEqual({
            deleted: 0,
        });
    });

    it("preserves non-Error Deployment mutation failures", () => {
        const service = createCoreDeploymentCatalogService({
            db: getDb(databasePath),
            assetsRoot,
            projectsRoot,
            authorityLocksRoot: locksRoot,
            transactionsRoot,
            readDeploymentView,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            assertMutationScope: () => {
                throw "deployment-scope-string";
            },
            now: () => 10,
            newUuid: identityFactory(460),
        });
        const result = service.createDeployment({
            projectId: "",
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "linux",
            platformInstanceId: "local-linux",
            targetRootPath: workspaceRoot,
            assets: [],
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("deployment-scope-string");
    });

    it("fault injection: rejects a Deployment removed after its operation lock is acquired", () => {
        const fixture = deploymentServiceWithActionTimeFault((db, deploymentId) => {
            db.prepare("DELETE FROM deployments WHERE deployment_id = ?").run(deploymentId);
        });
        const result = fixture.service.updateDeploymentInputs(fixture.deploymentId, {});
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("Deployment not found");
    });

    it("fault injection: rejects a Deployment whose Project changes after locking", () => {
        const fixture = deploymentServiceWithActionTimeFault((db, deploymentId) => {
            db.prepare("UPDATE deployments SET project_id = ? WHERE deployment_id = ?").run(
                "00000000-0000-4000-8000-000000000499",
                deploymentId,
            );
        });
        const result = fixture.service.updateDeploymentInputs(fixture.deploymentId, {});
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("Deployment Project changed during lock acquisition");
    });

    it("fault injection: rejects an update when the Deployment is deleted after locking", () => {
        const fixture = deploymentServiceWithActionTimeFault((db, deploymentId) => {
            db.prepare("UPDATE deployments SET deleted = 1 WHERE deployment_id = ?").run(deploymentId);
        });
        const result = fixture.service.updateDeploymentInputs(fixture.deploymentId, {});
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("active Deployment not found");
    });

    it("fault injection: treats action-time deletion as an idempotent soft delete", () => {
        const fixture = deploymentServiceWithActionTimeFault((db, deploymentId) => {
            db.prepare("UPDATE deployments SET deleted = 1 WHERE deployment_id = ?").run(deploymentId);
        });
        const result = fixture.service.softDeleteDeployment(fixture.deploymentId);
        expect(result.status, JSON.stringify(result)).toBe("complete");
        expect(result.value.deleted).toBe(true);
    });

    it("fault injection: rejects Asset membership added after locking", () => {
        const fixture = deploymentServiceWithActionTimeFault((db, deploymentId) => {
            db.prepare(
                `INSERT INTO deployment_assets (
                    deployment_asset_id, deployment_id, asset_id, version_id,
                    sort_order, allow_incomplete, deleted, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 0, 0, 0, 10, 10)`,
            ).run(
                "00000000-0000-4000-8000-000000000498",
                deploymentId,
                "00000000-0000-4000-8000-000000000497",
                "00000000-0000-4000-8000-000000000496",
            );
        });
        const result = fixture.service.updateDeploymentInputs(fixture.deploymentId, {});
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.message).toBe("Deployment Asset membership changed during lock acquisition; retry");
    });
});
