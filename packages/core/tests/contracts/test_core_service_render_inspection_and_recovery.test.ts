import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as deploymentJournal from "../../src/deployment/deployment-journal";
import * as publicationIo from "../../src/deployment/deployment-publication-io";
import { executeDeployment as executeDeploymentProduction } from "../../src/deployment/deployment-executor";
import { tryAcquireAuthorityLocks } from "../../src/foundation/authority-locks";
import { computeAppliedRenderSnapshotFingerprint } from "../../src/foundation/fingerprint";
import {
    acquireAllLocks,
    computeDeploymentOperationKey,
    computePhysicalClosureKeys,
} from "../../src/foundation/physical-path-locks";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import { deploymentInspectionInternalsForTest } from "../../src/orchestration/deployment-inspection-service";
import * as renderService from "../../src/orchestration/deployment-render-service";
import { getDb } from "../../src/persistence/db";
import {
    getDeployment,
    insertDeploymentRenderSnapshot,
    softDeleteDeployment,
    softDeleteDeploymentFile,
    updateDeployment,
    upsertDeploymentAsset,
} from "../../src/persistence/state-db";
import { serializeAppliedRenderSnapshot, serializeAppliedRenderSnapshotRef } from "../../src/render/deployment-render-authority";
import type { UuidV4 } from "../../src/types";
import {
    analyzeAndSelect,
    CLAUDE_CODE_FIXTURE,
    databasePath,
    DEPLOYMENT_ID,
    diagnostic,
    materializeCalls,
    MISSING_DEPLOYMENT_ID,
    multiRuntimeService,
    oaamRoot,
    probeCalls,
    previewedApply,
    previewRender,
    provider,
    resolveObservedTarget,
    reverseUuidSequence,
    sandbox,
    seedAuthority,
    seedGlobalAuthority,
    service,
    targetRoot,
} from "./fixtures/core-service-render-test-fixtures";
import { ASSET_ID, VERSION_ID } from "../catalog/fixtures/version-v2";

afterEach(() => vi.restoreAllMocks());

describe("CoreService render inspection and recovery", () => {
    it("returns a typed unavailable result without a journal when durable staging cannot be established", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        const input = await previewedApply(core, request);
        vi.spyOn(publicationIo, "publicationStagingRoot").mockImplementation(() => {
            throw new Error("no persistent same-filesystem owner outside the loader boundary");
        });
        const published = vi.spyOn(deploymentJournal, "publishJournal");
        const result = await core.deployDeployment(input);
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("blocked_by_deploy_target_unavailable");
        expect(published).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
    });

    it("blocks an exact preview on a real provider materialization failure without publishing a journal", async () => {
        seedAuthority();
        const core = service(provider({ materializationFailure: true }));
        const request = await analyzeAndSelect(core);
        const preview = await previewRender(core, request);
        expect(preview.status).toBe("failed");
        expect(preview.diagnostics[0]?.code).toBe("render.materialization_blocked");
        expect(materializeCalls).toBe(1);
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
        expect(fs.readdirSync(path.join(oaamRoot, "transactions")).filter((entry) => entry !== "authority-locks")).toEqual([]);
    });

    it("maps an unreadable exact target to a retryable preview failure before any journal exists", async () => {
        seedAuthority();
        fs.mkdirSync(path.join(targetRoot, "CLAUDE.md"));
        const core = service();
        const request = await analyzeAndSelect(core);
        const preview = await previewRender(core, request);
        expect(preview.status).toBe("failed");
        expect(preview.diagnostics[0]).toMatchObject({
            code: "render.preview_target_unavailable",
            causeKind: "unavailable",
            retryable: true,
        });
        expect(fs.readdirSync(path.join(oaamRoot, "transactions")).filter((entry) => entry !== "authority-locks")).toEqual([]);
    });

    it("returns a repair preview failure instead of continuing to runtime mutation", async () => {
        seedAuthority();
        const core = service(provider({ materializationFailureOnCall: 3 }));
        const request = await analyzeAndSelect(core);
        const deployed = await core.deployDeployment(await previewedApply(core, request));
        expect(deployed.status, JSON.stringify(deployed.diagnostics)).toBe("complete");
        const target = path.join(targetRoot, "CLAUDE.md");
        fs.rmSync(target);
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(inspected.status).toBe("complete");

        const repaired = await core.repairDeployment({
            deploymentId: DEPLOYMENT_ID,
            expectedInspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
            userActionId: "repair-after-preview-failure",
        });
        expect(repaired.status).toBe("failed");
        expect(repaired.diagnostics[0]?.code).toBe("render.materialization_blocked");
        expect(materializeCalls).toBe(3);
        expect(fs.existsSync(target)).toBe(false);
    });

    it("publishes V4 overwrite after a real later edit within the confirmed complete-file scope", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# User runtime value\n");
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(inspected.status).toBe("complete");
        const preview = await previewRender(core, request);
        expect(preview.status).toBe("complete");
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# Later runtime edit\n");
        const published = vi.spyOn(deploymentJournal, "publishJournal");
        const deployed = await core.deployDeployment({
            deploymentId: DEPLOYMENT_ID,
            selectionRequest: request,
            expectedPreviewFingerprint: preview.value.previewFingerprint,
            deploymentAction: "overwrite_runtime",
            userActionId: "overwrite",
        });
        expect(deployed.status, JSON.stringify(deployed.diagnostics)).toBe("complete");
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# Project guidance\n");
        expect(published).toHaveBeenCalledOnce();
        expect(published.mock.calls[0]![1]).toMatchObject({
            schemaVersion: 4,
            publications: [{ kind: "file", relativePath: "CLAUDE.md", completeReplacement: true }],
        });
    });

    it("overwrites one inspected runtime value through confirmed publication", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# User runtime value\n");
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(inspected.status).toBe("complete");
        const preview = await previewRender(core, request);
        expect(preview.status).toBe("complete");

        const deployed = await core.deployDeployment({
            deploymentId: DEPLOYMENT_ID,
            selectionRequest: request,
            expectedPreviewFingerprint: preview.value.previewFingerprint,
            deploymentAction: "overwrite_runtime",
            userActionId: "overwrite-confirmation",
        });

        expect(deployed.status, JSON.stringify(deployed.diagnostics)).toBe("complete");
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# Project guidance\n");
    });

    it("public repair refuses a new external file appearing after its fresh inspection and preview", async () => {
        seedAuthority();
        let injectLaterEdit = false;
        let executions = 0;
        const target = path.join(targetRoot, "CLAUDE.md");
        const core = service(provider(), Number.POSITIVE_INFINITY, {
            executeDeployment(...args) {
                executions += 1;
                if (injectLaterEdit) fs.writeFileSync(target, "# External file created during repair\n");
                return executeDeploymentProduction(...args);
            },
        });
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        fs.rmSync(target);
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(inspected.status).toBe("complete");
        injectLaterEdit = true;
        const published = vi.spyOn(deploymentJournal, "publishJournal");
        const repaired = await core.repairDeployment({
            deploymentId: DEPLOYMENT_ID,
            expectedInspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
            userActionId: "repair-missing-file",
        });
        expect(executions).toBe(2);
        expect(repaired.status).toBe("failed");
        expect(published).not.toHaveBeenCalled();
        expect(fs.readFileSync(target, "utf8")).toBe("# External file created during repair\n");
    });

    it.each([
        false,
        true,
    ])("public overwrite protects the old output when switching layouts; later edit=%s", async (laterEdit) => {
        seedAuthority();
        const original = service();
        const initial = await analyzeAndSelect(original);
        expect((await original.deployDeployment(await previewedApply(original, initial))).status).toBe("complete");
        clearRegistry();
        const layout = { ...CLAUDE_CODE_FIXTURE, relativePath: "AGENTS.md" as const };
        const core = service(provider({}, layout), Number.POSITIVE_INFINITY, {}, { now: () => 1000 }, layout);
        const selection = await analyzeAndSelect(core);
        const preview = await previewRender(core, selection);
        expect(preview.status, JSON.stringify(preview.diagnostics)).toBe("complete");
        expect(preview.value.replacementScope).toEqual({ filePaths: ["AGENTS.md"], directoryPaths: [] });
        if (laterEdit) fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# External edit to the previous output\n");
        const published = vi.spyOn(deploymentJournal, "publishJournal");
        const result = await core.deployDeployment({
            deploymentId: DEPLOYMENT_ID,
            selectionRequest: selection,
            expectedPreviewFingerprint: preview.value.previewFingerprint,
            deploymentAction: "overwrite_runtime",
            userActionId: "confirm-new-layout",
        });
        if (laterEdit) {
            expect(result.status).toBe("failed");
            expect(result.diagnostics[0]?.code).toBe("render.preview_stale");
            expect(published).not.toHaveBeenCalled();
            expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# External edit to the previous output\n");
            expect(fs.existsSync(path.join(targetRoot, "AGENTS.md"))).toBe(false);
        } else {
            expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
            expect(published.mock.calls[0]![1]).toMatchObject({ schemaVersion: 4 });
            expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
            expect(fs.readFileSync(path.join(targetRoot, "AGENTS.md"), "utf8")).toBe("# Project guidance\n");
        }
    });

    it("rejects overwrite_runtime without user-action evidence before inspection", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        const deployed = await core.deployDeployment({
            deploymentId: DEPLOYMENT_ID,
            selectionRequest: request,
            expectedPreviewFingerprint: `sha256:${"b".repeat(64)}`,
            deploymentAction: "overwrite_runtime",
            userActionId: " ",
        });
        expect(deployed.status).toBe("failed");
        expect(deployed.diagnostics[0]?.code).toBe("render.overwrite_user_action_missing");
        expect(probeCalls).toBe(1);
    });

    it("rejects stale overwrite selection and unavailable repair inspection without writing runtime", async () => {
        seedAuthority();
        const core = service();
        const target = path.join(targetRoot, "CLAUDE.md");
        const overwrite = await core.deployDeployment({
            deploymentId: DEPLOYMENT_ID,
            selectionRequest: {
                schemaVersion: 1,
                renderInputFingerprint: `sha256:${"a".repeat(64)}`,
                semanticOptions: [],
            },
            expectedPreviewFingerprint: `sha256:${"c".repeat(64)}`,
            deploymentAction: "overwrite_runtime",
            userActionId: "overwrite-before-first-deploy",
        });
        const repair = await core.repairDeployment({
            deploymentId: DEPLOYMENT_ID,
            expectedInspectionResultFingerprint: `sha256:${"b".repeat(64)}`,
            userActionId: "repair-before-first-deploy",
        });
        expect(overwrite.diagnostics[0]?.code).toBe("render.selection_request_stale");
        expect(repair.diagnostics[0]?.code).toBe("scan.never_deployed");
        expect(fs.existsSync(target)).toBe(false);
    });

    it("rejects repair without user action and with a stale inspected result", async () => {
        seedAuthority();
        const core = service();
        expect(
            (
                await core.repairDeployment({
                    deploymentId: DEPLOYMENT_ID,
                    expectedInspectionResultFingerprint: `sha256:${"a".repeat(64)}`,
                    userActionId: " ",
                })
            ).diagnostics[0]?.code,
        ).toBe("repair.user_action_missing");
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        const target = path.join(targetRoot, "CLAUDE.md");
        fs.rmSync(target);
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        fs.writeFileSync(target, "# changed after repair preview\n");
        const repaired = await core.repairDeployment({
            deploymentId: DEPLOYMENT_ID,
            expectedInspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
            userActionId: "stale-repair",
        });
        expect(repaired.diagnostics[0]?.code).toBe("repair.inspection_stale");
        expect(fs.readFileSync(target, "utf8")).toBe("# changed after repair preview\n");
    });

    it("fails inspection while another operation owns the Deployment mutex", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        const lock = acquireAllLocks(path.join(oaamRoot, "transactions"), [computeDeploymentOperationKey(DEPLOYMENT_ID)]);
        if (lock === null) throw new Error("could not acquire fixture Deployment mutex");
        try {
            const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
            expect(inspected.diagnostics[0]?.code).toBe("scan.deployment_locked");
            const repaired = await core.repairDeployment({
                deploymentId: DEPLOYMENT_ID,
                expectedInspectionResultFingerprint: `sha256:${"a".repeat(64)}`,
                userActionId: "repair-with-locked-deployment",
            });
            expect(repaired.diagnostics[0]?.code).toBe("scan.deployment_locked");
            expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# Project guidance\n");
        } finally {
            lock.release();
        }
    });

    it("records a failed scan attempt without replacing the last complete observation while an Asset is locked", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        const target = path.join(targetRoot, "CLAUDE.md");
        const stateBefore = getDeployment(getDb(databasePath), DEPLOYMENT_ID);
        const runtimeBefore = fs.readFileSync(target);
        const releaseAsset = tryAcquireAuthorityLocks(path.join(oaamRoot, "transactions", "authority-locks"), "assets", [
            ASSET_ID,
        ]);
        if (releaseAsset === null) throw new Error("could not acquire fixture Asset lock");
        try {
            const scanned = await core.scanDeployment(DEPLOYMENT_ID);
            expect(scanned.status).toBe("failed");
            expect(scanned.diagnostics[0]?.code).toBe("scan.asset_locked");
            const repaired = await core.repairDeployment({
                deploymentId: DEPLOYMENT_ID,
                expectedInspectionResultFingerprint: `sha256:${"a".repeat(64)}`,
                userActionId: "repair-with-locked-asset",
            });
            expect(repaired.diagnostics[0]?.code).toBe("scan.asset_locked");
            const stateAfter = getDeployment(getDb(databasePath), DEPLOYMENT_ID);
            expect(stateAfter).toEqual(
                expect.objectContaining({
                    observationState: "failed",
                    observationAttemptedAt: expect.any(Number),
                    lastCompleteObservationAt: stateBefore?.lastCompleteObservationAt,
                }),
            );
            expect(stateAfter!.observationAttemptedAt).toBeGreaterThan(stateBefore!.observationAttemptedAt);
            expect(fs.readFileSync(target)).toEqual(runtimeBefore);
        } finally {
            releaseAsset();
        }
    });

    it("records a partial provider scan attempt without replacing the last complete observation", async () => {
        seedAuthority();
        const initial = service();
        const request = await analyzeAndSelect(initial);
        expect((await initial.deployDeployment(await previewedApply(initial, request))).status).toBe("complete");
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# changed before partial inspection\n");
        const stateBefore = getDeployment(getDb(databasePath), DEPLOYMENT_ID);

        clearRegistry();
        const partialProvider = provider();
        partialProvider.inspectRenderedTarget = async () => ({
            status: "partial",
            changes: [],
            files: [],
            diagnostics: [diagnostic("fixture_partial_inspection", "warning")],
        });
        const partial = service(partialProvider, Number.POSITIVE_INFINITY, {}, { now: () => 100 });
        const scanned = await partial.scanDeployment(DEPLOYMENT_ID);

        expect(scanned.status).toBe("partial");
        expect(scanned.diagnostics[0]?.code).toBe("fixture_partial_inspection");
        const stateAfter = getDeployment(getDb(databasePath), DEPLOYMENT_ID);
        expect(stateAfter).toEqual(
            expect.objectContaining({
                observationState: "partial",
                lastCompleteObservationAt: stateBefore?.lastCompleteObservationAt,
            }),
        );
        expect(stateAfter!.observationAttemptedAt).toBeGreaterThan(stateBefore!.observationAttemptedAt);
        const repaired = await partial.repairDeployment({
            deploymentId: DEPLOYMENT_ID,
            expectedInspectionResultFingerprint: `sha256:${"a".repeat(64)}`,
            userActionId: "repair-after-partial-inspection",
        });
        expect(repaired.status).toBe("failed");
        expect(repaired.diagnostics[0]?.code).toBe("fixture_partial_inspection");
        expect(getDeployment(getDb(databasePath), DEPLOYMENT_ID)).toEqual(stateAfter);
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# changed before partial inspection\n");
    });

    it("fails inspection on provider error and scan when the committed Deployment view vanishes", async () => {
        seedAuthority();
        const initial = service();
        const request = await analyzeAndSelect(initial);
        expect((await initial.deployDeployment(await previewedApply(initial, request))).status).toBe("complete");
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# changed for provider failure\n");

        clearRegistry();
        const brokenProvider = provider();
        brokenProvider.inspectRenderedTarget = async () => {
            throw new Error("fixture inspection failure");
        };
        const broken = service(brokenProvider);
        expect((await broken.inspectDeploymentRenderedTarget(DEPLOYMENT_ID)).status).toBe("failed");

        clearRegistry();
        const missingView = service(
            provider(),
            Number.POSITIVE_INFINITY,
            {
                readDeploymentView: () => null,
            },
            { now: () => 100 },
        );
        const scanned = await missingView.scanDeployment(DEPLOYMENT_ID);
        expect(scanned.diagnostics[0]?.code).toBe("scan.deployment_missing_after_observation");
    });

    it("detects render authority drift before repair can consume the inspected target", async () => {
        seedAuthority();
        const initial = service();
        const request = await analyzeAndSelect(initial);
        expect((await initial.deployDeployment(await previewedApply(initial, request))).status).toBe("complete");
        clearRegistry();
        let calls = 0;
        const drifting = service(provider(), Number.POSITIVE_INFINITY, {
            resolveObservedTargetContext(input) {
                calls += 1;
                const result = resolveObservedTarget(input);
                if (calls === 2 && result.status === "complete") {
                    result.targetContext.renderFacts.push({
                        key: "fixture.inspection-drift",
                        value: "changed",
                        evidenceLevel: "agent_runtime_verified",
                    });
                }
                return result;
            },
        });
        const result = await drifting.repairDeployment({
            deploymentId: DEPLOYMENT_ID,
            expectedInspectionResultFingerprint: `sha256:${"a".repeat(64)}`,
            userActionId: "repair-authority-drift",
        });
        expect(result.diagnostics[0]?.code).toBe("scan.render_authority_changed");
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# Project guidance\n");
    });

    it("rejects an allow-incomplete change between the initial and locked managed-inspection reads", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        const target = path.join(targetRoot, "CLAUDE.md");
        const before = getDeployment(getDb(databasePath), DEPLOYMENT_ID);
        const readAuthority = renderService.loadRenderBaseAuthority;
        let reads = 0;
        const seam = vi.spyOn(renderService, "loadRenderBaseAuthority").mockImplementation((...args) => {
            reads += 1;
            if (reads === 2) upsertDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, ASSET_ID, VERSION_ID, 1, 1, 100);
            return readAuthority(...args);
        });
        try {
            const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
            expect(inspected.status).toBe("failed");
            expect(inspected.diagnostics[0]?.code).toBe("scan.render_authority_changed");
            expect(reads).toBe(2);
            expect(getDeployment(getDb(databasePath), DEPLOYMENT_ID)).toEqual(before);
            expect(fs.readFileSync(target, "utf8")).toBe("# Project guidance\n");
        } finally {
            seam.mockRestore();
        }
        const releaseAsset = tryAcquireAuthorityLocks(path.join(oaamRoot, "transactions", "authority-locks"), "assets", [
            ASSET_ID,
        ]);
        if (releaseAsset === null) throw new Error("inspection left its Asset lock behind");
        releaseAsset();
        const operationLock = acquireAllLocks(path.join(oaamRoot, "transactions"), [
            computeDeploymentOperationKey(DEPLOYMENT_ID),
        ]);
        if (operationLock === null) throw new Error("inspection left its Deployment lock behind");
        operationLock.release();
    });

    it("scans and explains fresh managed changes when the runtime can no longer be probed", async () => {
        seedAuthority();
        const selected = provider();
        const originalProbe = selected.probe;
        let unavailable = false;
        let unavailableProbeCalls = 0;
        selected.probe = async (...args) => {
            if (unavailable) {
                unavailableProbeCalls += 1;
                throw new Error("the previously used runtime is no longer installed");
            }
            return originalProbe(...args);
        };
        const core = service(selected);
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        const before = getDeployment(getDb(databasePath), DEPLOYMENT_ID);
        unavailable = true;
        const target = path.join(targetRoot, "CLAUDE.md");
        fs.writeFileSync(target, "# First external change\n");
        expect((await core.scanDeployment(DEPLOYMENT_ID)).status).toBe("complete");
        const first = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(first.status).toBe("complete");
        expect(first.value.changes.length).toBeGreaterThan(0);
        fs.writeFileSync(target, "# Second external change\n");
        const second = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(second.status).toBe("complete");
        expect(second.value.inspectionResultFingerprint).not.toBe(first.value.inspectionResultFingerprint);
        expect(unavailableProbeCalls).toBe(0);
        expect(getDeployment(getDb(databasePath), DEPLOYMENT_ID)?.appliedRenderSnapshotRef).toBe(
            before?.appliedRenderSnapshotRef,
        );
        expect(fs.readFileSync(target, "utf8")).toBe("# Second external change\n");

        expect((await core.previewDeploymentRender({ deploymentId: DEPLOYMENT_ID, selectionRequest: request })).status).toBe(
            "failed",
        );
        expect(unavailableProbeCalls).toBe(1);
        expect(fs.readFileSync(target, "utf8")).toBe("# Second external change\n");
    });

    it("rejects a current intent that no longer matches the applied snapshot", async () => {
        seedAuthority();
        const core = multiRuntimeService(reverseUuidSequence());
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# External edit before intent changes\n");
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(inspected.status).toBe("complete");
        updateDeployment(
            getDb(databasePath),
            DEPLOYMENT_ID,
            { consumerAgentRuntimeIds: JSON.stringify(["ANTIGRAVITY_CLI"]) },
            99,
        );
        expect((await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID)).diagnostics[0]?.code).toBe(
            "scan.applied_render_stale",
        );
        const prepared = await core.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_ID,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        expect(prepared.status).toBe("failed");
        expect(prepared.diagnostics[0]?.code).toBe("scan.applied_render_stale");
    });

    it("propagates a missing Deployment through scan without creating state", async () => {
        const core = service();
        const scanned = await core.scanDeployment(MISSING_DEPLOYMENT_ID);
        expect(scanned.status).toBe("failed");
        expect(scanned.diagnostics[0]?.code).toBe("scan.inspection_unavailable");
        expect(getDeployment(getDb(databasePath), MISSING_DEPLOYMENT_ID)).toBeNull();
    });

    it("blocks inspection on an unresolved journal and on the exact physical target lock", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");

        const corruptTxn = "16161616-1616-4616-8616-161616161616";
        const corruptRoot = path.join(oaamRoot, "transactions", corruptTxn);
        fs.mkdirSync(corruptRoot, { recursive: true });
        fs.writeFileSync(path.join(corruptRoot, "journal.json"), "{");
        expect((await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID)).diagnostics[0]?.code).toBe("scan.recovery_required");
        fs.rmSync(corruptRoot, { recursive: true });

        const physicalKeys = computePhysicalClosureKeys("wsl", targetRoot, [
            {
                relativePath: "CLAUDE.md",
                entryKind: "file",
                containingDirectoryBoundaries: [],
            },
        ]);
        const lock = acquireAllLocks(path.join(oaamRoot, "transactions"), physicalKeys);
        if (lock === null) throw new Error("could not acquire fixture physical target lock");
        try {
            expect((await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID)).diagnostics[0]?.code).toBe("scan.target_locked");
            const repaired = await core.repairDeployment({
                deploymentId: DEPLOYMENT_ID,
                expectedInspectionResultFingerprint: `sha256:${"a".repeat(64)}`,
                userActionId: "repair-with-locked-target",
            });
            expect(repaired.diagnostics[0]?.code).toBe("scan.target_locked");
            expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# Project guidance\n");
        } finally {
            lock.release();
        }
    });

    it("rejects deleted authority after repair preparation and missing authority at the loader", async () => {
        expect(() =>
            deploymentInspectionInternalsForTest.loadAppliedInspectionAuthority(
                { db: getDb(databasePath) } as never,
                MISSING_DEPLOYMENT_ID,
            ),
        ).toThrow(/missing or deleted/);

        seedAuthority();
        const initial = service();
        const request = await analyzeAndSelect(initial);
        expect((await initial.deployDeployment(await previewedApply(initial, request))).status).toBe("complete");
        clearRegistry();
        let calls = 0;
        const deleting = service(provider(), Number.POSITIVE_INFINITY, {
            resolveObservedTargetContext(input) {
                calls += 1;
                const result = resolveObservedTarget(input);
                if (calls === 2) softDeleteDeployment(getDb(databasePath), DEPLOYMENT_ID, 100);
                return result;
            },
        });
        const inspected = await deleting.repairDeployment({
            deploymentId: DEPLOYMENT_ID,
            expectedInspectionResultFingerprint: `sha256:${"a".repeat(64)}`,
            userActionId: "repair-deleted-authority",
        });
        expect(inspected.diagnostics[0]?.code).toBe("scan.deployment_missing");
    });

    it.each(["missing", "deleted"] as const)("fails inspection when the applied snapshot row is %s", async (rowState) => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        const deployment = getDeployment(getDb(databasePath), DEPLOYMENT_ID);
        if (deployment === null) throw new Error("fixture Deployment disappeared");
        const ref = JSON.parse(deployment.appliedRenderSnapshotRef) as {
            snapshotFingerprint: string;
        };
        if (rowState === "missing") {
            getDb(databasePath)
                .prepare("DELETE FROM deployment_render_snapshots WHERE deployment_id = ? AND snapshot_fingerprint = ?")
                .run(DEPLOYMENT_ID, ref.snapshotFingerprint);
        } else {
            getDb(databasePath)
                .prepare(
                    "UPDATE deployment_render_snapshots SET deleted = 1 WHERE deployment_id = ? AND snapshot_fingerprint = ?",
                )
                .run(DEPLOYMENT_ID, ref.snapshotFingerprint);
        }
        expect(() =>
            deploymentInspectionInternalsForTest.loadAppliedInspectionAuthority(
                { db: getDb(databasePath) } as never,
                DEPLOYMENT_ID,
            ),
        ).toThrow(/snapshot is unavailable/);
    });

    it("rejects an applied reference that resolves to a valid never snapshot", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        const neverSnapshot = { schemaVersion: 1 as const, snapshotState: "never" as const };
        const fingerprint = computeAppliedRenderSnapshotFingerprint(neverSnapshot);
        insertDeploymentRenderSnapshot(getDb(databasePath), {
            snapshotFingerprint: fingerprint,
            deploymentId: DEPLOYMENT_ID,
            snapshotJson: serializeAppliedRenderSnapshot(neverSnapshot),
            deleted: 0,
            createdAt: 100,
            updatedAt: 100,
        });
        updateDeployment(
            getDb(databasePath),
            DEPLOYMENT_ID,
            {
                appliedRenderSnapshotRef: serializeAppliedRenderSnapshotRef({
                    snapshotState: "applied",
                    snapshotFingerprint: fingerprint,
                }),
            },
            101,
        );
        expect(() =>
            deploymentInspectionInternalsForTest.loadAppliedInspectionAuthority(
                { db: getDb(databasePath) } as never,
                DEPLOYMENT_ID,
            ),
        ).toThrow(/snapshot is not applied/);
    });

    it("rejects a baseline outside the exact T5 closure and unsafe target entries", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        softDeleteDeploymentFile(getDb(databasePath), DEPLOYMENT_ID, "CLAUDE.md", 100);
        expect((await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID)).diagnostics[0]?.code).toBe(
            "scan.target_profile_outside_t5",
        );

        getDb(databasePath)
            .prepare("UPDATE deployment_files SET deleted = 0, updated_at = 101 WHERE deployment_id = ? AND relative_path = ?")
            .run(DEPLOYMENT_ID, "CLAUDE.md");
        const target = path.join(targetRoot, "CLAUDE.md");
        const outside = path.join(sandbox, "outside.md");
        fs.writeFileSync(outside, "outside");
        fs.rmSync(target);
        fs.symlinkSync(outside, target);
        const unsafe = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(unsafe.diagnostics[0]?.code).toBe("scan.inspection_unavailable");
        expect(JSON.parse(unsafe.diagnostics[0]!.rawSummary)).toMatchObject({
            failureKind: "symlink_or_reparse",
            operation: "read_regular_file",
            targetPath: target,
            systemCode: expect.any(String),
        });
        expect(fs.readFileSync(outside, "utf8")).toBe("outside");
    });

    it("blocks reverse preparation on an unresolved deployment journal", async () => {
        seedAuthority();
        const core = service(
            provider(),
            Number.POSITIVE_INFINITY,
            {},
            {
                newUuid: reverseUuidSequence(),
            },
        );
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# Reverse edit\n");
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        const corruptTxn = "17171717-1717-4717-8717-171717171717";
        const corruptRoot = path.join(oaamRoot, "transactions", corruptTxn);
        fs.mkdirSync(corruptRoot, { recursive: true });
        fs.writeFileSync(path.join(corruptRoot, "journal.json"), "{");
        const journalBlocked = await core.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_ID,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        expect(journalBlocked.diagnostics[0]?.code).toBe("scan.recovery_required");
        fs.rmSync(corruptRoot, { recursive: true });
    });

    it("fails recovery for invalid, missing, corrupt-journal, and corrupt-reservation authority", async () => {
        seedAuthority();
        const core = service();
        expect((await core.recoverDeployment("not-a-uuid" as UuidV4)).diagnostics[0]?.code).toBe(
            "recovery.deployment_id_invalid",
        );
        expect((await core.recoverDeployment(MISSING_DEPLOYMENT_ID)).diagnostics[0]?.code).toBe("recovery.deployment_missing");

        const corruptTxn = "15151515-1515-4515-8515-151515151515";
        fs.mkdirSync(path.join(oaamRoot, "transactions", corruptTxn), { recursive: true });
        fs.writeFileSync(path.join(oaamRoot, "transactions", corruptTxn, "journal.json"), "{");
        expect((await core.recoverDeployment(DEPLOYMENT_ID)).diagnostics[0]?.code).toBe("blocked_by_recovery_journal_corrupt");
        fs.rmSync(path.join(oaamRoot, "transactions", corruptTxn), { recursive: true });

        const reverseRoot = path.join(oaamRoot, "transactions", "reverse-accept");
        fs.mkdirSync(reverseRoot, { recursive: true });
        fs.writeFileSync(path.join(reverseRoot, "not-a-preparation"), "invalid");
        expect((await core.recoverDeployment(DEPLOYMENT_ID)).diagnostics[0]?.code).toBe("recovery.reverse_global_freeze");
    });

    it("rejects a malformed Deployment ID before consulting provider or filesystem authority", async () => {
        const analyzed = await service().analyzeDeploymentRender("not-a-uuid" as UuidV4);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("render.deployment_id_invalid");
        expect(probeCalls).toBe(0);
    });

    it("reports a missing Deployment without creating a phantom row", async () => {
        const analyzed = await service().analyzeDeploymentRender(MISSING_DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("render.deployment_unavailable");
        expect(getDb(databasePath).prepare("SELECT COUNT(*) AS n FROM deployments").get()).toEqual({
            n: 0,
        });
    });

    it("gives a soft-deleted Deployment no render rights", async () => {
        seedAuthority();
        softDeleteDeployment(getDb(databasePath), DEPLOYMENT_ID, 3);
        const analyzed = await service().analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("render.deployment_unavailable");
        expect(probeCalls).toBe(0);
    });

    it("rejects a Deployment with no consumer agent runtime", async () => {
        seedAuthority();
        updateDeployment(getDb(databasePath), DEPLOYMENT_ID, { consumerAgentRuntimeIds: "[]" }, 3);
        const analyzed = await service().analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("render.consumer_missing");
        expect(probeCalls).toBe(0);
    });

    it("passes a Global Deployment through global probe authority without manufacturing a Project", async () => {
        seedGlobalAuthority();
        const analyzed = await service().analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("partial");
        expect(analyzed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
            "claude_code_project_guidance_target_blocked",
        ]);
        expect(probeCalls).toBe(1);
    });

    it("keeps a real provider analysis exception failed and merges probe diagnostics without writes", async () => {
        seedAuthority();
        const warning = diagnostic("fixture_probe_warning", "warning");
        const selected = provider({ probeDiagnostics: [warning] });
        const analyze = vi.fn(async () => {
            throw new Error("fixture analysis process unavailable");
        });
        selected.analyzeRender = analyze;
        const published = vi.spyOn(deploymentJournal, "publishJournal");
        const analyzed = await service(selected).analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.value).toBeUndefined();
        expect(analyzed.diagnostics).toContainEqual(warning);
        expect(analyzed.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: "render_analysis_error",
                    message: expect.stringContaining("fixture analysis process unavailable"),
                }),
                expect.objectContaining({ code: "render.provider_analysis_failed", retryable: true }),
            ]),
        );
        expect(probeCalls).toBe(1);
        expect(analyze).toHaveBeenCalledTimes(1);
        expect(materializeCalls).toBe(0);
        expect(published).not.toHaveBeenCalled();
        expect(fs.readdirSync(targetRoot)).toEqual([]);
        expect(fs.readdirSync(path.join(oaamRoot, "transactions")).filter((entry) => entry !== "authority-locks")).toEqual([]);
        expect(getDb(databasePath).prepare("SELECT COUNT(*) AS n FROM deployment_files").get()).toEqual({ n: 0 });
    });

    it("rejects a Project Asset relabeled as a Global Deployment before probing", async () => {
        seedAuthority();
        updateDeployment(getDb(databasePath), DEPLOYMENT_ID, { projectId: "" }, 3);
        const analyzed = await service().analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analyzed.status).toBe("failed");
        expect(analyzed.diagnostics[0]?.code).toBe("render.version_authority_stale");
        expect(probeCalls).toBe(0);
    });
});
