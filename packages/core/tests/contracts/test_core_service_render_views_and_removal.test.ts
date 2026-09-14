import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readDeploymentView } from "../../src/deployment/deployment-view";
import { getDb } from "../../src/persistence/db";
import {
    getDeploymentFile,
    softDeleteDeploymentAsset,
    upsertDeploymentAsset,
    upsertDeploymentFile,
} from "../../src/persistence/state-db";
import {
    analyzeAndSelect,
    databasePath,
    DEPLOYMENT_ID,
    MISSING_DEPLOYMENT_ID,
    MISSING_VERSION_ID,
    oaamRoot,
    previewedApply,
    SECOND_ASSET_ID,
    seedAuthority,
    service,
    targetRoot,
} from "./fixtures/core-service-render-test-fixtures";
import { ASSET_ID } from "../catalog/fixtures/version-v2";

describe("CoreService render views and removal", () => {
    it("returns null for a missing Deployment view and sorts durable Asset intent by sort order", () => {
        expect(
            readDeploymentView({
                db: getDb(databasePath),
                transactionsRoot: path.join(oaamRoot, "transactions"),
                deploymentId: MISSING_DEPLOYMENT_ID,
            }),
        ).toBeNull();

        seedAuthority();
        upsertDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, SECOND_ASSET_ID, MISSING_VERSION_ID, 0, 0, 3);
        const view = readDeploymentView({
            db: getDb(databasePath),
            transactionsRoot: path.join(oaamRoot, "transactions"),
            deploymentId: DEPLOYMENT_ID,
        });
        expect(view?.assets.map((asset) => asset.assetId)).toEqual([SECOND_ASSET_ID, ASSET_ID]);
    });

    it("projects an active baseline with a missing observation without inventing content", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        const deployed = await core.deployDeployment(await previewedApply(core, request));
        expect(deployed.status).toBe("complete");
        const row = getDeploymentFile(getDb(databasePath), DEPLOYMENT_ID, "CLAUDE.md");
        if (row === null) throw new Error("committed DeploymentFile fixture missing");
        upsertDeploymentFile(getDb(databasePath), DEPLOYMENT_ID, "CLAUDE.md", row.baselineState, "missing", "", 0, 50, 50);
        const view = readDeploymentView({
            db: getDb(databasePath),
            transactionsRoot: path.join(oaamRoot, "transactions"),
            deploymentId: DEPLOYMENT_ID,
        });
        expect(view?.files).toEqual([
            expect.objectContaining({
                relativePath: "CLAUDE.md",
                baselineState: expect.objectContaining({ rowState: "active" }),
                observedState: "missing",
            }),
        ]);
    });

    it("redeploys an empty desired set as a verified managed-file removal", async () => {
        seedAuthority();
        const core = service();
        const initialRequest = await analyzeAndSelect(core);
        const initial = await core.deployDeployment(await previewedApply(core, initialRequest));
        expect(initial.status).toBe("complete");
        softDeleteDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, ASSET_ID, 60);

        const removalRequest = await analyzeAndSelect(core);
        const removed = await core.deployDeployment(await previewedApply(core, removalRequest));
        expect(removed.status, JSON.stringify(removed.diagnostics)).toBe("complete");
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
        expect(removed.value.files).toEqual([
            expect.objectContaining({
                relativePath: "CLAUDE.md",
                baselineState: expect.objectContaining({ rowState: "removed" }),
                observedState: "missing",
            }),
        ]);
    });
});
