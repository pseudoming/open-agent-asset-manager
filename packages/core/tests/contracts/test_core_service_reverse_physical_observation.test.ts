import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readAssetManifest } from "../../src/catalog/asset-manifest";
import { readVersionAuthority } from "../../src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { acquireAllLocks, computePhysicalClosureKeys } from "../../src/foundation/physical-path-locks";
import { getDb } from "../../src/persistence/db";
import { getDeploymentAsset } from "../../src/persistence/state-db";
import { ASSET_ID, VERSION_ID } from "../catalog/fixtures/version-v2";
import {
    analyzeAndSelect,
    databasePath,
    DEPLOYMENT_ID,
    oaamRoot,
    PREPARATION_ID,
    previewedApply,
    probeCalls,
    provider,
    resolveObservedTarget,
    REVERSE_VERSION_ID,
    reverseUuidSequence,
    seedAuthority,
    selectionRequest,
    service,
    targetRoot,
} from "./fixtures/core-service-render-test-fixtures";

describe("CoreService reverse draft physical observations", () => {
    it.each([false, true])("observes once per commit draft across physical locks (target drift: %s)", async (drift) => {
        seedAuthority();
        let committing = false;
        let observations = 0;
        const commitLockStates: boolean[] = [];
        const runtimePath = path.join(targetRoot, "CLAUDE.md");
        const physicalKeys = computePhysicalClosureKeys("wsl", targetRoot, [
            { relativePath: "CLAUDE.md", entryKind: "file", containingDirectoryBoundaries: [] },
        ]);
        const core = service(
            provider(),
            Number.POSITIVE_INFINITY,
            {
                resolveObservedTargetContext(input) {
                    observations += 1;
                    if (committing) {
                        const available = acquireAllLocks(path.join(oaamRoot, "transactions"), physicalKeys);
                        commitLockStates.push(available === null);
                        available?.release();
                        if (drift && commitLockStates.length === 2) {
                            fs.writeFileSync(runtimePath, "# Changed across physical locks\n");
                        }
                    }
                    return resolveObservedTarget(input);
                },
            },
            { newUuid: reverseUuidSequence() },
        );
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        fs.writeFileSync(runtimePath, "# Reviewed runtime content\n");
        const before = readAssetManifest(path.join(oaamRoot, "assets"), ASSET_ID);
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(inspected.status).toBe("complete");
        const beforePrepare = { probes: probeCalls, observations };
        const prepared = await core.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_ID,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        expect(prepared.status, JSON.stringify(prepared.diagnostics)).toBe("complete");
        // Review retains both fresh inspection observations, then projects its staged
        // content using that same target context. Commit still observes independently.
        expect(probeCalls - beforePrepare.probes).toBe(2);
        expect(observations - beforePrepare.observations).toBe(2);
        if (prepared.value.preparationState !== "prepared") throw new Error("reverse fixture was not prepared");

        const beforeCommit = { probes: probeCalls, observations };
        committing = true;
        const committed = await core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-reviewed-runtime-content",
            newVersionPromotion: { promotionAction: "use_existing_authority" },
            renderSelectionRequest: selectionRequest(prepared.value.renderAnalysis),
        });
        committing = false;
        expect(commitLockStates).toEqual([false, true]);
        expect(probeCalls - beforeCommit.probes).toBe(2);
        expect(observations - beforeCommit.observations).toBe(2);
        const version = readVersionAuthority(
            path.join(oaamRoot, "assets"),
            ASSET_ID,
            REVERSE_VERSION_ID,
            createVersionDialectRegistry([], [], [], []),
        );
        const marker = JSON.parse(
            fs.readFileSync(path.join(oaamRoot, "transactions", "reverse-accept", PREPARATION_ID, "marker.json"), "utf8"),
        );
        if (drift) {
            expect(committed.status).toBe("failed");
            expect(committed.diagnostics[0]?.code).toBe("reverse_accept.inspection_stale");
            expect(version).toBeNull();
            expect(readAssetManifest(path.join(oaamRoot, "assets"), ASSET_ID)).toEqual(before);
            expect(getDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, ASSET_ID)?.versionId).toBe(VERSION_ID);
            expect(marker.preparationState).toBe("prepared");
            expect(fs.readFileSync(runtimePath, "utf8")).toBe("# Changed across physical locks\n");
        } else {
            expect(committed.status, JSON.stringify(committed.diagnostics)).toBe("complete");
            expect(committed.value).toEqual({
                commitState: "committed",
                version: { assetId: ASSET_ID, versionId: REVERSE_VERSION_ID },
            });
            expect(version?.files).toEqual([
                expect.objectContaining({ contentKind: "text", text: "# Reviewed runtime content\n" }),
            ]);
            expect(getDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, ASSET_ID)?.versionId).toBe(REVERSE_VERSION_ID);
            expect(marker).toMatchObject({ preparationState: "retired", retiredTerminalProof: { terminalState: "consumed" } });
            expect(fs.readFileSync(runtimePath, "utf8")).toBe("# Reviewed runtime content\n");
        }
        const released = acquireAllLocks(path.join(oaamRoot, "transactions"), physicalKeys);
        expect(released).not.toBeNull();
        released?.release();
    });
});
