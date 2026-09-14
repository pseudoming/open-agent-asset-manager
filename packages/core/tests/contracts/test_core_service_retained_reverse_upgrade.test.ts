/** Existing Applied output survives a Provider upgrade while current intent and writes stay authoritative. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readVersionAuthority } from "../../src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import { getDb } from "../../src/persistence/db";
import {
    getDeployment,
    getDeploymentAsset,
    getDeploymentRenderSnapshot,
    upsertDeploymentAsset,
} from "../../src/persistence/state-db";
import { parseAppliedRenderSnapshotRef } from "../../src/render/deployment-render-authority";
import { ASSET_ID, VERSION_ID } from "../catalog/fixtures/version-v2";
import {
    analyzeAndSelect,
    CLAUDE_CODE_FIXTURE,
    databasePath,
    DEPLOYMENT_ID,
    oaamRoot,
    previewedApply,
    provider,
    REVERSE_VERSION_ID,
    reverseUuidSequence,
    seedAuthority,
    selectionRequest,
    service,
    targetRoot,
} from "./fixtures/core-service-render-test-fixtures";

async function appliedThenUpgraded() {
    seedAuthority();
    const old = provider();
    const oldCore = service(old);
    const selection = await analyzeAndSelect(oldCore);
    expect((await oldCore.deployDeployment(await previewedApply(oldCore, selection))).status).toBe("complete");
    const before = getDeployment(getDb(databasePath), DEPLOYMENT_ID)!;
    const oldRef = parseAppliedRenderSnapshotRef(before.appliedRenderSnapshotRef);
    if (oldRef.snapshotState !== "applied") throw new Error("old renderer did not Apply");
    const oldSnapshot = getDeploymentRenderSnapshot(getDb(databasePath), DEPLOYMENT_ID, oldRef.snapshotFingerprint)!;
    const fixture = {
        ...CLAUDE_CODE_FIXTURE,
        outputContractId: CLAUDE_CODE_FIXTURE.outputContractId.replace("_V1", "_CURRENT_V1"),
        materializationProfileId: CLAUDE_CODE_FIXTURE.materializationProfileId + "-current",
    };
    const current = provider({ adapterVersion: "1.1.0" }, fixture);
    current.retainedInspectionBindings = [
        {
            schemaVersion: 1,
            rendererVersion: old.version,
            agentRuntimes: old.agentRuntimes,
            targetContextSchemas: old.targetContextSchemas,
            assetTargetCapabilities: old.assetTargetCapabilities,
            materializerCapabilities: old.materializerCapabilities,
            renderContractDeclarations: old.renderContractDeclarations,
            inspectRenderedTarget: old.inspectRenderedTarget,
        },
    ];
    expect(current.version).not.toBe(old.version);
    clearRegistry();
    let upgradedTime = 1000;
    const core = service(
        current,
        Number.POSITIVE_INFINITY,
        {},
        { newUuid: reverseUuidSequence(), now: () => ++upgradedTime },
        fixture,
    );
    const target = path.join(targetRoot, "CLAUDE.md");
    fs.writeFileSync(target, "# User edit after upgrading OAAM\n");
    const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
    expect(inspected.status, JSON.stringify(inspected.diagnostics)).toBe("complete");
    expect(inspected.value.changes).toHaveLength(1);
    return { core, current, target, inspected, oldSnapshot, oldRef };
}

describe("retained Applied reverse after renderer upgrade", () => {
    it("accepts a real old-renderer edit through current analysis and commits without rewriting the target", async () => {
        const { core, current, target, inspected, oldSnapshot, oldRef } = await appliedThenUpgraded();
        const parent = readVersionAuthority(
            path.join(oaamRoot, "assets"),
            ASSET_ID,
            VERSION_ID,
            createVersionDialectRegistry([], [], [], []),
        );
        const bytes = fs.readFileSync(target),
            stat = fs.statSync(target);
        const prepared = await core.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_ID,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        expect(prepared.status, JSON.stringify(prepared.diagnostics)).toBe("complete");
        expect(prepared.value.preparationState, JSON.stringify(prepared)).toBe("prepared");
        if (prepared.value.preparationState !== "prepared") throw new Error("upgrade reverse not prepared");
        const committed = await core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-user-edit-after-upgrade",
            newVersionPromotion: { promotionAction: "use_existing_authority" },
            renderSelectionRequest: selectionRequest(prepared.value.renderAnalysis),
        });
        expect(committed.status, JSON.stringify(committed.diagnostics)).toBe("complete");
        expect(committed.value).toEqual({
            commitState: "committed",
            version: { assetId: ASSET_ID, versionId: REVERSE_VERSION_ID },
        });
        expect(fs.readFileSync(target)).toEqual(bytes);
        expect(fs.statSync(target).mtimeMs).toBe(stat.mtimeMs);
        expect(getDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, ASSET_ID)?.versionId).toBe(REVERSE_VERSION_ID);
        expect(
            readVersionAuthority(
                path.join(oaamRoot, "assets"),
                ASSET_ID,
                VERSION_ID,
                createVersionDialectRegistry([], [], [], []),
            ),
        ).toEqual(parent);
        expect(getDeploymentRenderSnapshot(getDb(databasePath), DEPLOYMENT_ID, oldRef.snapshotFingerprint)).toEqual(oldSnapshot);
        const updated = getDeployment(getDb(databasePath), DEPLOYMENT_ID)!;
        const ref = parseAppliedRenderSnapshotRef(updated.appliedRenderSnapshotRef);
        if (ref.snapshotState !== "applied") throw new Error("new snapshot missing");
        const snapshot = JSON.parse(
            getDeploymentRenderSnapshot(getDb(databasePath), DEPLOYMENT_ID, ref.snapshotFingerprint)!.snapshotJson,
        );
        expect(snapshot.outputUnitRenderers).toEqual([expect.objectContaining({ rendererAdapterVersion: current.version })]);
        expect((await core.scanDeployment(DEPLOYMENT_ID)).value.derivedStatus.stage).toBe("in_sync");
    });

    it("still rejects an actual input change made after old-renderer inspection", async () => {
        const { core, target, inspected } = await appliedThenUpgraded();
        const db = getDb(databasePath);
        const binding = getDeploymentAsset(db, DEPLOYMENT_ID, ASSET_ID)!;
        upsertDeploymentAsset(db, DEPLOYMENT_ID, ASSET_ID, binding.versionId, binding.sortOrder, 1, 99);
        const before = fs.readFileSync(target);
        const prepared = await core.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_ID,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        expect(prepared.status).toBe("failed");
        expect(prepared.diagnostics[0]?.code).toBe("scan.applied_render_stale");
        expect((await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID)).diagnostics[0]?.code).toBe(
            "scan.applied_render_stale",
        );
        expect(fs.readFileSync(target)).toEqual(before);
        expect(getDeploymentAsset(db, DEPLOYMENT_ID, ASSET_ID)?.versionId).toBe(VERSION_ID);
    });
});
