import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as deploymentJournal from "../../src/deployment/deployment-journal";
import { readAssetManifest } from "../../src/catalog/asset-manifest";
import { readVersionAuthority } from "../../src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import { coreServiceInternalsForTest } from "../../src/orchestration/core-service";
import { getDb } from "../../src/persistence/db";
import { getDeploymentAsset, updateDeployment } from "../../src/persistence/state-db";
import { ASSET_ID, VERSION_ID } from "../catalog/fixtures/version-v2";
import {
    ANTIGRAVITY_FIXTURE,
    analyzeAndSelect,
    DEPLOYMENT_ID,
    databasePath,
    diagnostic,
    materializeCalls,
    multiRuntimeService,
    oaamRoot,
    PREPARATION_ID,
    PREPARATION_ID_2,
    previewedApply,
    previewRender,
    probeCalls,
    provider,
    REVERSE_TRANSACTION_ID,
    REVERSE_TRANSACTION_ID_2,
    REVERSE_VERSION_ID,
    REVERSE_VERSION_ID_2,
    resolverCalls,
    reverseUuidSequence,
    seedAuthority,
    selectionRequest,
    service,
    targetRoot,
} from "./fixtures/core-service-render-test-fixtures";

afterEach(() => vi.restoreAllMocks());

describe("CoreService render execution and reverse", () => {
    it.each(["getter", "uncloneable"])("returns the original failed outcome for %s commit input", async (failure) => {
        const input =
            failure === "getter"
                ? {
                      get preparationId() {
                          throw new TypeError("invalid getter");
                      },
                  }
                : { preparationId: PREPARATION_ID, invalid: () => undefined };
        const result = await service().commitRenderedTargetAccept(input as never);
        expect(result).toMatchObject({ status: "failed", value: { commitState: "outcome_unavailable" } });
        expect(result.diagnostics).not.toEqual([]);
    });

    it("writes project Guidance only through the real executor and returns a strict DeploymentView", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        const deployed = await core.deployDeployment(await previewedApply(core, request));
        expect(deployed.status, JSON.stringify(deployed.diagnostics)).toBe("complete");
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf-8")).toBe("# Project guidance\n");
        expect(deployed.value).toMatchObject({
            deploymentId: DEPLOYMENT_ID,
            observationState: "complete",
            derivedStatus: { stage: "in_sync" },
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID }],
            files: [{ relativePath: "CLAUDE.md", observedState: "present" }],
        });
        expect(Object.keys(deployed.value)).not.toContain("targetPlan");
        expect(materializeCalls).toBe(2);
        expect(probeCalls).toBe(3);
        expect(resolverCalls).toBe(3);
    });

    it("returns one copy of an action-time probe diagnostic after a successful deploy", async () => {
        seedAuthority();
        const warning = diagnostic("fixture_probe_warning", "warning");
        const core = service(provider({ probeDiagnostics: [warning] }));
        const analysis = await core.analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(analysis.status).toBe("partial");
        const request = selectionRequest(analysis.value);
        const preview = await core.previewDeploymentRender({ deploymentId: DEPLOYMENT_ID, selectionRequest: request });
        expect(preview.status).toBe("partial");
        const deployed = await core.deployDeployment({
            deploymentId: DEPLOYMENT_ID,
            selectionRequest: request,
            expectedPreviewFingerprint: preview.value.previewFingerprint,
            deploymentAction: "apply",
        });
        expect(deployed.status, JSON.stringify(deployed.diagnostics)).toBe("complete");
        expect(deployed.diagnostics.filter((entry) => entry.code === warning.code)).toEqual([warning]);
    });

    it("inspects an unchanged executor baseline without creating an Asset Version", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");

        const before = readAssetManifest(path.join(oaamRoot, "assets"), ASSET_ID);
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        const after = readAssetManifest(path.join(oaamRoot, "assets"), ASSET_ID);

        expect(inspected.status, JSON.stringify(inspected.diagnostics)).toBe("complete");
        expect(inspected.value).toMatchObject({ status: "complete", changes: [], files: [] });
        expect(after).toEqual(before);
    });

    it("scans a whole-file Guidance edit into observation state without advancing Version authority", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# Runtime edit\n");
        const before = readAssetManifest(path.join(oaamRoot, "assets"), ASSET_ID);

        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(inspected.status, JSON.stringify(inspected.diagnostics)).toBe("complete");
        expect(inspected.value.changes).toEqual([
            expect.objectContaining({
                changeKind: "file_content_replacement",
                replacementContent: { contentKind: "text", text: "# Runtime edit\n" },
            }),
        ]);
        expect(inspected.value.files).toEqual([expect.objectContaining({ attributionState: "uniquely_attributable" })]);

        const scanned = await core.scanDeployment(DEPLOYMENT_ID);
        expect(scanned.status, JSON.stringify(scanned.diagnostics)).toBe("complete");
        expect(scanned.value.derivedStatus.stage).toBe("conflict");
        expect(scanned.value.files).toEqual([
            expect.objectContaining({
                relativePath: "CLAUDE.md",
                observedState: "present",
                observedContentHash: sha256Bytes(new Uint8Array(Buffer.from("# Runtime edit\n"))),
            }),
        ]);
        expect(readAssetManifest(path.join(oaamRoot, "assets"), ASSET_ID)).toEqual(before);
    });

    it("accepts one exact runtime Guidance edit as a durable Version without rewriting the target", async () => {
        seedAuthority();
        const core = service(
            provider(),
            Number.POSITIVE_INFINITY,
            {},
            {
                newUuid: reverseUuidSequence(),
            },
        );
        expect(core.reindexAssets({ assetIds: [ASSET_ID], includeDeleted: true }).status).toBe("complete");
        expect(core.listAssets().value[0]?.currentVersionId).toBe(VERSION_ID);
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        const runtimePath = path.join(targetRoot, "CLAUDE.md");
        fs.writeFileSync(runtimePath, "# Runtime accepted\n");
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(inspected.status, JSON.stringify(inspected.diagnostics)).toBe("complete");

        const prepared = await core.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_ID,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        expect(prepared.status, JSON.stringify(prepared.diagnostics)).toBe("complete");
        expect(prepared.value).toMatchObject({
            preparationState: "prepared",
            preparationId: PREPARATION_ID,
            promotionState: "already_authorized",
        });
        if (prepared.value.preparationState !== "prepared") {
            throw new Error("reverse preparation fixture was not prepared");
        }
        const committed = await core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-runtime-guidance",
            newVersionPromotion: { promotionAction: "use_existing_authority" },
            renderSelectionRequest: selectionRequest(prepared.value.renderAnalysis),
        });
        expect(committed.status, JSON.stringify(committed.diagnostics)).toBe("complete");
        expect(committed.value).toEqual({
            commitState: "committed",
            version: { assetId: ASSET_ID, versionId: REVERSE_VERSION_ID },
        });
        expect(fs.readFileSync(runtimePath, "utf8")).toBe("# Runtime accepted\n");
        expect(getDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, ASSET_ID)?.versionId).toBe(REVERSE_VERSION_ID);
        const closure = readVersionAuthority(
            path.join(oaamRoot, "assets"),
            ASSET_ID,
            REVERSE_VERSION_ID,
            createVersionDialectRegistry([], [], [], []),
        );
        expect(closure?.files[0]).toMatchObject({
            contentKind: "text",
            text: "# Runtime accepted\n",
        });
        expect(committed.diagnostics).toEqual([]);
        const marker = JSON.parse(
            fs.readFileSync(path.join(oaamRoot, "transactions", "reverse-accept", PREPARATION_ID, "marker.json"), "utf8"),
        );
        expect(marker).toMatchObject({
            preparationState: "retired",
            retiredTerminalProof: { terminalState: "consumed" },
            intent: { stagedAssetId: ASSET_ID, stagedVersionId: REVERSE_VERSION_ID },
        });
        const current = core.getDeployment(DEPLOYMENT_ID);
        expect(current).toMatchObject({
            status: "complete",
            value: {
                found: true,
                value: { derivedStatus: { stage: "in_sync" }, assets: [{ assetId: ASSET_ID, versionId: REVERSE_VERSION_ID }] },
            },
        });
        if (!current.value.found) throw new Error("committed Deployment disappeared");
        expect(current.value.value?.derivedStatus.actionHints).not.toContain("recover");
        expect(core.listAssets().value[0]?.currentVersionId).toBe(REVERSE_VERSION_ID);
        const reinspection = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(reinspection.status, JSON.stringify(reinspection.diagnostics)).toBe("complete");
        expect(reinspection.value).toMatchObject({ changes: [], files: [] });
        // An explicit later recovery is still idempotent, but is not required to finish acceptance.
        const recovered = await core.recoverDeployment(DEPLOYMENT_ID);
        expect(recovered.status, JSON.stringify(recovered.diagnostics)).toBe("complete");
        expect(recovered.value.assets).toEqual([expect.objectContaining({ assetId: ASSET_ID, versionId: REVERSE_VERSION_ID })]);
    });

    it.each([
        "commit",
        "recovery",
    ])("keeps committed reverse authority when the post-%s Asset index refresh fails", async (failureStage) => {
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
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# Runtime accepted\n");
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        const prepared = await core.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_ID,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        if (prepared.value.preparationState !== "prepared") {
            throw new Error("reverse preparation fixture was not prepared");
        }
        if (failureStage === "commit") getDb(databasePath).exec("DROP TABLE current_asset_index");
        const committed = await core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-runtime-guidance",
            newVersionPromotion: { promotionAction: "use_existing_authority" },
            renderSelectionRequest: selectionRequest(prepared.value.renderAnalysis),
        });
        expect(committed.status).toBe("complete");
        expect(committed.value).toEqual({
            commitState: "committed",
            version: { assetId: ASSET_ID, versionId: REVERSE_VERSION_ID },
        });
        if (failureStage === "commit") {
            expect(committed.diagnostics).toEqual(
                expect.arrayContaining([expect.objectContaining({ code: "reindex.operation_failed" })]),
            );
            expect(committed.diagnostics).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ code: "reverse_accept.index_refresh_pending", retryable: true }),
                ]),
            );
        } else {
            getDb(databasePath).exec("DROP TABLE current_asset_index");
        }

        const recovered = await core.recoverDeployment(DEPLOYMENT_ID);

        expect(recovered.status).toBe("partial");
        expect(recovered.diagnostics[0]).toMatchObject({
            code: "recovery.asset_index_projection_failed",
            retryable: true,
        });
        expect(readAssetManifest(path.join(oaamRoot, "assets"), ASSET_ID)?.versionIds).toEqual([VERSION_ID, REVERSE_VERSION_ID]);
        expect(getDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, ASSET_ID)?.versionId).toBe(REVERSE_VERSION_ID);
    });

    it("keeps the recovered Deployment view partial when the Asset index reports a skipped authority", async () => {
        seedAuthority();
        const recovered = await service().recoverDeployment(DEPLOYMENT_ID);
        expect(recovered.status).toBe("complete");
        const projected = coreServiceInternalsForTest.completeRecoveredAssetProjection(recovered, () => ({
            status: "complete",
            value: { diagnostics: [diagnostic("reindex.asset_skipped")] },
            diagnostics: [],
        }));

        expect(projected).toEqual({
            status: "partial",
            value: recovered.value,
            diagnostics: [diagnostic("reindex.asset_skipped")],
        });
    });

    it.each([
        "runtime_bytes",
        "provider_availability",
    ] as const)("keeps a prepared reverse Version unpublished when %s changes before commit", async (change) => {
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
        const runtimePath = path.join(targetRoot, "CLAUDE.md");
        fs.writeFileSync(runtimePath, "# First edit\n");
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        const prepared = await core.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_ID,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        if (prepared.value.preparationState !== "prepared") {
            throw new Error("reverse preparation fixture was not prepared");
        }
        const manifestBeforeCommit = readAssetManifest(path.join(oaamRoot, "assets"), ASSET_ID);
        if (change === "runtime_bytes") {
            fs.writeFileSync(runtimePath, "# Changed after preview\n");
        } else {
            const enablement = core.getAdapterEnablement();
            expect(enablement.status).toBe("complete");
            expect(
                core.replaceAdapterEnablement({
                    expectedRevision: enablement.value.revision,
                    expectedSettingFingerprint: enablement.value.settingFingerprint,
                    enabledAdapterIds: [],
                    userActionId: "disable-provider-after-review",
                }).status,
            ).toBe("complete");
        }
        const committed = await core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "stale-reverse-action",
            newVersionPromotion: { promotionAction: "use_existing_authority" },
            renderSelectionRequest: selectionRequest(prepared.value.renderAnalysis),
        });
        expect(committed.status).toBe("failed");
        expect(committed.diagnostics[0]?.code).toBe(
            change === "runtime_bytes" ? "reverse_accept.inspection_stale" : "scan.inspection_unavailable",
        );
        expect(readAssetManifest(path.join(oaamRoot, "assets"), ASSET_ID)).toEqual(manifestBeforeCommit);
        expect(getDeploymentAsset(getDb(databasePath), DEPLOYMENT_ID, ASSET_ID)?.versionId).toBe(VERSION_ID);
        expect(fs.readFileSync(runtimePath, "utf8")).toBe(
            change === "runtime_bytes" ? "# Changed after preview\n" : "# First edit\n",
        );
        expect(
            readVersionAuthority(
                path.join(oaamRoot, "assets"),
                ASSET_ID,
                REVERSE_VERSION_ID,
                createVersionDialectRegistry([], [], [], []),
            ),
        ).toBeNull();
        expect(
            await core.cancelRenderedTargetAccept({
                preparationId: prepared.value.preparationId,
                expectedPreparationRevision: prepared.value.preparationRevision,
            }),
        ).toEqual({ status: "complete", value: undefined, diagnostics: [] });
    });

    it("leaves a valid prepared reverse reservation pending until explicit cancel or commit", async () => {
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
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# Pending edit\n");
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        const prepared = await core.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_ID,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        expect(prepared.status).toBe("complete");
        if (prepared.value.preparationState !== "prepared") {
            throw new Error("pending reverse fixture was not prepared");
        }
        const pendingRecovery = await core.recoverDeployment(DEPLOYMENT_ID);
        expect(pendingRecovery.status, JSON.stringify(pendingRecovery)).toBe("complete");
        expect(pendingRecovery.diagnostics).toEqual([]);
        expect(
            (
                await core.cancelRenderedTargetAccept({
                    preparationId: prepared.value.preparationId,
                    expectedPreparationRevision: prepared.value.preparationRevision,
                })
            ).status,
        ).toBe("complete");
        expect((await core.recoverDeployment(DEPLOYMENT_ID)).status).toBe("complete");
    });

    it("round-trips frozen exact-build project Guidance profiles through public APIs", async () => {
        seedAuthority();
        const core = multiRuntimeService(
            reverseUuidSequence([
                PREPARATION_ID,
                REVERSE_TRANSACTION_ID,
                REVERSE_VERSION_ID,
                PREPARATION_ID_2,
                REVERSE_TRANSACTION_ID_2,
                REVERSE_VERSION_ID_2,
            ]),
        );
        let request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        fs.writeFileSync(path.join(targetRoot, "CLAUDE.md"), "# Claude-origin edit\n");
        let inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        let prepared = await core.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_ID,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        if (prepared.value.preparationState !== "prepared") {
            throw new Error("Claude reverse preparation was not prepared");
        }
        let accepted = await core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-claude-edit",
            newVersionPromotion: { promotionAction: "use_existing_authority" },
            renderSelectionRequest: selectionRequest(prepared.value.renderAnalysis),
        });
        expect(accepted.status, JSON.stringify(accepted.diagnostics)).toBe("complete");
        expect((await core.recoverDeployment(DEPLOYMENT_ID)).status).toBe("complete");

        expect(
            core.updateDeploymentInputs(DEPLOYMENT_ID, {
                consumerAgentRuntimeIds: ["ANTIGRAVITY_CLI"],
            }).status,
        ).toBe("complete");
        request = await analyzeAndSelect(core);
        const deployedToAntigravity = await core.deployDeployment(await previewedApply(core, request));
        expect(deployedToAntigravity.status, JSON.stringify(deployedToAntigravity.diagnostics)).toBe("complete");
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
        expect(fs.readFileSync(path.join(targetRoot, "AGENTS.md"), "utf8")).toBe("# Claude-origin edit\n");

        fs.writeFileSync(path.join(targetRoot, "AGENTS.md"), "# Antigravity-origin edit\n");
        inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        prepared = await core.prepareRenderedTargetAccept({
            deploymentId: DEPLOYMENT_ID,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        if (prepared.value.preparationState !== "prepared") {
            throw new Error("Antigravity reverse preparation was not prepared");
        }
        accepted = await core.commitRenderedTargetAccept({
            preparationId: prepared.value.preparationId,
            expectedPreparationRevision: prepared.value.preparationRevision,
            userActionId: "accept-antigravity-edit",
            newVersionPromotion: { promotionAction: "use_existing_authority" },
            renderSelectionRequest: selectionRequest(prepared.value.renderAnalysis),
        });
        expect(accepted.status, JSON.stringify(accepted.diagnostics)).toBe("complete");
        expect(accepted.value).toMatchObject({
            commitState: "committed",
            version: { assetId: ASSET_ID, versionId: REVERSE_VERSION_ID_2 },
        });
        expect((await core.recoverDeployment(DEPLOYMENT_ID)).status).toBe("complete");

        expect(
            core.updateDeploymentInputs(DEPLOYMENT_ID, {
                consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            }).status,
        ).toBe("complete");
        request = await analyzeAndSelect(core);
        const deployedBackToClaude = await core.deployDeployment(await previewedApply(core, request));
        expect(deployedBackToClaude.status, JSON.stringify(deployedBackToClaude.diagnostics)).toBe("complete");
        expect(fs.existsSync(path.join(targetRoot, "AGENTS.md"))).toBe(false);
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# Antigravity-origin edit\n");
    });

    it.each([
        {
            label: "deletion",
            mutate(target: string) {
                fs.rmSync(target);
            },
            expectedObservedState: "missing",
        },
        {
            label: "executable-bit drift",
            mutate(target: string) {
                fs.chmodSync(target, 0o755);
            },
            expectedObservedState: "present",
        },
    ])("reports $label as a reverse conflict instead of adopting it", async (testCase) => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        testCase.mutate(path.join(targetRoot, "CLAUDE.md"));

        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(inspected.status, JSON.stringify(inspected.diagnostics)).toBe("complete");
        expect(inspected.value.changes).toEqual([]);
        expect(inspected.value.files).toEqual([
            expect.objectContaining({
                attributionState: "conflict",
                reasonCode: "project_guidance_whole_file_change_not_reconcilable",
            }),
        ]);

        const scanned = await core.scanDeployment(DEPLOYMENT_ID);
        expect(scanned.status, JSON.stringify(scanned.diagnostics)).toBe("complete");
        expect(scanned.value.files[0]?.observedState).toBe(testCase.expectedObservedState);
    });

    it.each([
        {
            label: "a missing managed file",
            mutate(target: string) {
                fs.rmSync(target);
            },
        },
        {
            label: "executable-bit drift",
            mutate(target: string) {
                fs.chmodSync(target, 0o755);
            },
        },
    ])("repairs $label through protected V4 publication from its exact inspected baseline", async (testCase) => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        const target = path.join(targetRoot, "CLAUDE.md");
        testCase.mutate(target);
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(inspected.status).toBe("complete");

        const published = vi.spyOn(deploymentJournal, "publishJournal");
        const repaired = await core.repairDeployment({
            deploymentId: DEPLOYMENT_ID,
            expectedInspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
            userActionId: "repair-confirmation",
        });

        expect(repaired.status, JSON.stringify(repaired.diagnostics)).toBe("complete");
        expect(published).toHaveBeenCalledOnce();
        expect(published.mock.calls[0]![1]).toMatchObject({
            schemaVersion: 4,
            publications: [{ kind: "file", relativePath: "CLAUDE.md", completeReplacement: false }],
        });
        expect(fs.readFileSync(target, "utf8")).toBe("# Project guidance\n");
        expect(fs.statSync(target).mode & 0o100).toBe(0);
    });

    it("refuses to call content replacement a repair", async () => {
        seedAuthority();
        const core = service();
        const request = await analyzeAndSelect(core);
        expect((await core.deployDeployment(await previewedApply(core, request))).status).toBe("complete");
        const target = path.join(targetRoot, "CLAUDE.md");
        fs.writeFileSync(target, "# Runtime third value\n");
        const inspected = await core.inspectDeploymentRenderedTarget(DEPLOYMENT_ID);
        expect(inspected.status).toBe("complete");

        const repaired = await core.repairDeployment({
            deploymentId: DEPLOYMENT_ID,
            expectedInspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
            userActionId: "repair-confirmation",
        });

        expect(repaired.status).toBe("failed");
        expect(repaired.diagnostics[0]?.code).toBe("repair.runtime_third_value");
        expect(fs.readFileSync(target, "utf8")).toBe("# Runtime third value\n");
    });

    it("writes the exact Antigravity project Guidance target through the same executor chain", async () => {
        seedAuthority();
        updateDeployment(
            getDb(databasePath),
            DEPLOYMENT_ID,
            { consumerAgentRuntimeIds: JSON.stringify([ANTIGRAVITY_FIXTURE.agentRuntimeId]) },
            3,
        );
        const core = service(provider({}, ANTIGRAVITY_FIXTURE), Number.POSITIVE_INFINITY, {}, {}, ANTIGRAVITY_FIXTURE);
        const request = await analyzeAndSelect(core);
        const deployed = await core.deployDeployment(await previewedApply(core, request));
        expect(deployed.status, JSON.stringify(deployed.diagnostics)).toBe("complete");
        expect(fs.readFileSync(path.join(targetRoot, "AGENTS.md"), "utf-8")).toBe("# Project guidance\n");
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
        expect(deployed.value).toMatchObject({
            consumerAgentRuntimeIds: [ANTIGRAVITY_FIXTURE.agentRuntimeId],
            derivedStatus: { stage: "in_sync" },
            files: [{ relativePath: "AGENTS.md", observedState: "present" }],
        });
    });

    it("rejects a stale observed target between UI analysis and deploy with zero runtime writes", async () => {
        seedAuthority();
        const core = service(provider(), 1);
        const request = await analyzeAndSelect(core);
        const preview = await previewRender(core, request);
        expect(preview.status).toBe("failed");
        expect(preview.diagnostics[0]?.code).toBe("fixture_observed_context_changed");
        expect(materializeCalls).toBe(0);
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
    });

    it("rechecks observed context once at action time and blocks before materialization or executor", async () => {
        seedAuthority();
        const core = service(provider(), 2);
        const request = await analyzeAndSelect(core);
        const input = await previewedApply(core, request);
        const deployed = await core.deployDeployment(input);
        expect(deployed.status).toBe("failed");
        expect(deployed.diagnostics[0]?.code).toBe("fixture_observed_context_changed");
        expect(materializeCalls).toBe(1);
        expect(fs.existsSync(path.join(targetRoot, "CLAUDE.md"))).toBe(false);
        expect(fs.existsSync(path.join(oaamRoot, "transactions"))).toBe(true);
    });
});
