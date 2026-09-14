/** Deployment inspection-path, approval-replay, validation, and recovery scenarios. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { DeploymentPreWritePreviewError } from "../../src/deployment/deployment-prewrite-preview";
import { coreServiceInternalsForTest } from "../../src/orchestration/core-service";
import { deploymentInspectionInternalsForTest } from "../../src/orchestration/deployment-inspection-service";
import { deploymentLifecycleInternalsForTest } from "../../src/orchestration/deployment-lifecycle-service";
import { deploymentRenderServiceInternalsForTest } from "../../src/orchestration/deployment-render-service";
import type { CoreResult, DeploymentView } from "../../src/types";
import { ASSET_ID, PROJECT_ID, VERSION_ID, VERSION_ID_2 } from "../catalog/fixtures/version-v2";
import { DEPLOYMENT_ID, SHA_A, SHA_B, TRANSACTION_ID } from "./fixtures/deployment-lifecycle-test-fixtures";

describe("deployment payload collection and inspection byte helpers", () => {
    let root = "";

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-lifecycle-helper-"));
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("joins target paths from their physical root grammar without re-reading Deployment state", () => {
        expect(deploymentInspectionInternalsForTest.joinPhysicalTargetPath("C:\\project", "nested/a.md")).toBe(
            "C:\\project\\nested\\a.md",
        );
        expect(deploymentInspectionInternalsForTest.joinPhysicalTargetPath("/project", "nested/a.md")).toBe(
            "/project/nested/a.md",
        );
    });

    it("sorts inspection paths by canonical UTF-8 bytes", () => {
        expect(["z.md", "a.md", "ä.md"].sort(deploymentInspectionInternalsForTest.compareUtf8Bytes)).toEqual([
            "a.md",
            "z.md",
            "ä.md",
        ]);
    });

    it("rejects a snapshot or baseline change at the locked inspection boundary", () => {
        const baseline = [
            {
                relativePath: "GUIDANCE.md",
                baselineState: { rowState: "active" },
                managedDirectoryBoundaryPaths: [],
            },
        ];
        const authority = {
            snapshotFingerprint: SHA_A,
            committedTransactionId: TRANSACTION_ID,
            baseline,
        } as Parameters<typeof deploymentInspectionInternalsForTest.requireStableAppliedInspectionAuthority>[0];
        expect(() =>
            deploymentInspectionInternalsForTest.requireStableAppliedInspectionAuthority(authority, structuredClone(authority)),
        ).not.toThrow();
        expect(() =>
            deploymentInspectionInternalsForTest.requireStableAppliedInspectionAuthority(authority, {
                ...structuredClone(authority),
                snapshotFingerprint: SHA_B,
            }),
        ).toThrow(/baseline changed/);
        expect(() =>
            deploymentInspectionInternalsForTest.requireStableAppliedInspectionAuthority(authority, {
                ...structuredClone(authority),
                committedTransactionId: "44444444-4444-4444-8444-444444444444",
            }),
        ).toThrow(/baseline changed/);
        const changedBaseline = structuredClone(authority);
        changedBaseline.baseline[0]!.managedDirectoryBoundaryPaths = ["nested"];
        expect(() =>
            deploymentInspectionInternalsForTest.requireStableAppliedInspectionAuthority(authority, changedBaseline),
        ).toThrow(/baseline changed/);

        const emptyJournalScan = {
            matchingTxnIds: [],
            otherDeploymentTxnIds: [],
            corruptTxnIds: [],
        };
        expect(() =>
            deploymentInspectionInternalsForTest.requireInspectionJournalClear(emptyJournalScan, "fixture journal block"),
        ).not.toThrow();
        expect(() =>
            deploymentInspectionInternalsForTest.requireInspectionJournalClear(
                { ...emptyJournalScan, matchingTxnIds: [TRANSACTION_ID] },
                "fixture journal block",
            ),
        ).toThrow(/fixture journal block/);
        expect(() =>
            deploymentInspectionInternalsForTest.requireInspectionJournalClear(
                { ...emptyJournalScan, corruptTxnIds: [TRANSACTION_ID] },
                "fixture journal block",
            ),
        ).toThrow(/fixture journal block/);
    });

    it("requires exact current preview authority and refuses approval replay", async () => {
        const exactApply = {
            deploymentAction: "apply",
            expectedPreviewFingerprint: SHA_A,
            userActionId: "",
        } as Parameters<typeof deploymentRenderServiceInternalsForTest.requirePreviewedAction>[0];
        const readyPreview = {
            schemaVersion: 3,
            previewFingerprint: SHA_A,
            actionState: "ready_apply",
        } as Parameters<typeof deploymentRenderServiceInternalsForTest.requirePreviewMatch>[1];
        expect(() =>
            deploymentRenderServiceInternalsForTest.requirePreviewedAction({
                ...exactApply,
                expectedPreviewFingerprint: " ",
            }),
        ).toThrowError(expect.objectContaining({ code: "render.preview_fingerprint_missing" }));
        expect(() =>
            deploymentRenderServiceInternalsForTest.requirePreviewedAction({
                ...exactApply,
                deploymentAction: "replace_unmanaged",
                userActionId: " ",
            }),
        ).toThrowError(expect.objectContaining({ code: "render.unmanaged_replacement_user_action_missing" }));
        const exactReplacement = {
            ...exactApply,
            deploymentAction: "replace_unmanaged" as const,
            userActionId: "replace-confirmation",
        };
        expect(() => deploymentRenderServiceInternalsForTest.requirePreviewedAction(exactApply)).not.toThrow();
        expect(() => deploymentRenderServiceInternalsForTest.requirePreviewedAction(exactReplacement)).not.toThrow();
        expect(() =>
            deploymentRenderServiceInternalsForTest.requirePreviewMatch(
                { ...exactApply, expectedPreviewFingerprint: SHA_B },
                readyPreview,
            ),
        ).toThrowError(expect.objectContaining({ code: "render.preview_stale" }));
        expect(() =>
            deploymentRenderServiceInternalsForTest.requirePreviewMatch(exactApply, {
                ...readyPreview,
                actionState: "requires_unmanaged_replacement",
            }),
        ).not.toThrow();
        expect(() => deploymentRenderServiceInternalsForTest.requirePreviewMatch(exactReplacement, readyPreview)).not.toThrow();
        expect(() =>
            deploymentRenderServiceInternalsForTest.requirePreviewMatch(exactApply, {
                ...readyPreview,
                actionState: "blocked_managed_conflict",
            }),
        ).toThrowError(expect.objectContaining({ code: "render.preview_action_mismatch" }));
        expect(() =>
            deploymentRenderServiceInternalsForTest.requirePreviewMatch(exactApply, {
                ...readyPreview,
                schemaVersion: 2 as never,
            }),
        ).toThrowError(expect.objectContaining({ code: "render.preview_stale" }));
        expect(() => deploymentRenderServiceInternalsForTest.requirePreviewMatch(exactApply, readyPreview)).not.toThrow();
        expect(() =>
            deploymentRenderServiceInternalsForTest.requirePreviewMatch(exactReplacement, {
                ...readyPreview,
                actionState: "requires_unmanaged_replacement",
            }),
        ).not.toThrow();

        const unavailable = deploymentRenderServiceInternalsForTest.mapPreWritePreviewError(
            new DeploymentPreWritePreviewError("render.preview_target_unavailable", "unavailable"),
        );
        expect(unavailable).toMatchObject({ causeKind: "unavailable", retryable: true });
        const invalid = deploymentRenderServiceInternalsForTest.mapPreWritePreviewError(
            new DeploymentPreWritePreviewError("render.preview_target_invalid", "invalid"),
        );
        expect(invalid).toMatchObject({ causeKind: "unsupported", retryable: false });
        const unexpected = new Error("unexpected preview failure");
        expect(() => deploymentRenderServiceInternalsForTest.mapPreWritePreviewError(unexpected)).toThrow(unexpected);

        const snapshot = {
            decisions: [{ approval: { approvalState: "not_required" } }],
        } as Parameters<typeof coreServiceInternalsForTest.continueRepairAfterApprovalReplay>[0];
        let continuationCalls = 0;
        const continuationResult: CoreResult<DeploymentView> = {
            status: "complete",
            value: {} as DeploymentView,
            diagnostics: [],
        };
        const continued = await coreServiceInternalsForTest.continueRepairAfterApprovalReplay(snapshot, async () => {
            continuationCalls += 1;
            return continuationResult;
        });
        expect(continued).toBe(continuationResult);
        expect(continuationCalls).toBe(1);
        snapshot.decisions[0]!.approval = {
            approvalState: "approved",
            approvalSource: "one_time_user_approval",
            userActionEvidenceId: "fixture-approval",
            resolvedAt: 1,
            approvalFingerprint: SHA_A,
        };
        const denied = await coreServiceInternalsForTest.continueRepairAfterApprovalReplay(snapshot, async () => {
            continuationCalls += 1;
            return continuationResult;
        });
        expect(denied).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "repair.applied_approval_not_replayable" }],
        });
        expect(continuationCalls).toBe(1);
    });

    it("keeps the durable render-analysis envelope validator inside Core", () => {
        const validate = coreServiceInternalsForTest.validateStoredRenderAnalysisEnvelope;
        expect(() => validate(null)).toThrow(/must be an object/);
        expect(() =>
            validate({
                renderInputFingerprint: SHA_A,
                requiredSemantics: [],
                analyses: [],
                extra: 1,
            }),
        ).toThrow(/invalid key set/);
        expect(() => validate({ renderInputFingerprint: "bad", requiredSemantics: [], analyses: [] })).toThrow(
            /input fingerprint is invalid/,
        );
        expect(() => validate({ renderInputFingerprint: SHA_A, requiredSemantics: {}, analyses: [] })).toThrow(
            /semantics must be an array/,
        );
        expect(() => validate({ renderInputFingerprint: SHA_A, requiredSemantics: [], analyses: {} })).toThrow(
            /analyses must be an array/,
        );
        expect(() => validate({ renderInputFingerprint: SHA_A, requiredSemantics: [], analyses: [] })).not.toThrow();
    });

    it("maps recovery module results without hiding blocked or nonterminal authority", async () => {
        const configuration = {
            render: {
                transactionsRoot: path.join(root, "transactions"),
                authorityLocksRoot: path.join(root, "authority-locks"),
                assetsRoot: path.join(root, "assets"),
                deploymentsRoot: path.join(root, "deployments"),
                db: {},
                dialectRegistry: createVersionDialectRegistry([], [], [], []),
            },
            databasePath: path.join(root, "state.db"),
            renderAnalysisValidator: {
                validate(_value: unknown): asserts _value is never {},
            },
        } as Parameters<typeof deploymentLifecycleInternalsForTest.recoverDeploymentLifecycle>[0];
        const dependencies = {
            readDeploymentView: () => ({ deploymentId: DEPLOYMENT_ID }),
        } as Parameters<typeof deploymentLifecycleInternalsForTest.recoverDeploymentLifecycle>[1];
        const emptyReservations = { globalFreeze: false, activePreparations: [] };
        const defaults = deploymentLifecycleInternalsForTest.defaultRecoveryDependencies;
        const baseRecoveryDependencies = {
            ...defaults,
            scanDeploymentJournals: () => ({
                matchingTxnIds: [TRANSACTION_ID],
                otherDeploymentTxnIds: [],
                corruptTxnIds: [],
            }),
            recoverDeploymentJournal: () => ({
                outcome: "recovered_to_old" as const,
                reasonCode: "",
                journalResolved: true,
            }),
            scanReservations: () => emptyReservations,
            reconcilePreparation: () => ({
                reconcileState: "resolved" as const,
                preparationState: "cancelled" as const,
            }),
        } satisfies Parameters<typeof deploymentLifecycleInternalsForTest.recoverDeploymentLifecycle>[2];

        expect(
            await deploymentLifecycleInternalsForTest.recoverDeploymentLifecycle(
                configuration,
                dependencies,
                baseRecoveryDependencies,
                DEPLOYMENT_ID,
            ),
        ).toMatchObject({ status: "complete", value: { deploymentId: DEPLOYMENT_ID } });

        for (const recoveryResult of [
            {
                outcome: "blocked" as const,
                reasonCode: "fixture.journal_blocked",
                journalResolved: false,
            },
            { outcome: "recovered_to_new" as const, reasonCode: "", journalResolved: false },
        ]) {
            const blocked = await deploymentLifecycleInternalsForTest.recoverDeploymentLifecycle(
                configuration,
                dependencies,
                { ...baseRecoveryDependencies, recoverDeploymentJournal: () => recoveryResult },
                DEPLOYMENT_ID,
            );
            expect(blocked.status).toBe("failed");
            expect(blocked.diagnostics[0]?.code).toBe(recoveryResult.reasonCode || "recovery.deployment_blocked");
        }

        const identities = [
            { deploymentId: DEPLOYMENT_ID, preparationId: VERSION_ID },
            { deploymentId: DEPLOYMENT_ID, preparationId: VERSION_ID_2 },
            { deploymentId: PROJECT_ID, preparationId: ASSET_ID },
        ];
        const reconciled = await deploymentLifecycleInternalsForTest.recoverDeploymentLifecycle(
            configuration,
            dependencies,
            {
                ...baseRecoveryDependencies,
                scanDeploymentJournals: () => ({
                    matchingTxnIds: [],
                    otherDeploymentTxnIds: [],
                    corruptTxnIds: [],
                }),
                scanReservations: () => ({
                    globalFreeze: false,
                    activePreparations: identities,
                }),
                reconcilePreparation: (_input, preparationId) =>
                    preparationId === VERSION_ID
                        ? {
                              reconcileState: "retired" as const,
                              terminalState: "consumed" as const,
                              preparationRevision: 2,
                          }
                        : {
                              reconcileState: "resolved" as const,
                              preparationState: "cancelled" as const,
                          },
            } as Parameters<typeof deploymentLifecycleInternalsForTest.recoverDeploymentLifecycle>[2],
            DEPLOYMENT_ID,
        );
        expect(reconciled.status).toBe("complete");

        for (const reconcileState of ["pending", "busy"] as const) {
            const nonterminal = await deploymentLifecycleInternalsForTest.recoverDeploymentLifecycle(
                configuration,
                dependencies,
                {
                    ...baseRecoveryDependencies,
                    scanDeploymentJournals: () => ({
                        matchingTxnIds: [],
                        otherDeploymentTxnIds: [],
                        corruptTxnIds: [],
                    }),
                    scanReservations: () => ({
                        globalFreeze: false,
                        activePreparations: [identities[0]],
                    }),
                    reconcilePreparation: () =>
                        reconcileState === "busy"
                            ? { reconcileState, deploymentId: DEPLOYMENT_ID }
                            : { reconcileState, preparationState: "prepared" },
                } as Parameters<typeof deploymentLifecycleInternalsForTest.recoverDeploymentLifecycle>[2],
                DEPLOYMENT_ID,
            );
            expect(nonterminal.diagnostics[0]).toMatchObject({
                code: "recovery.reverse_accept_not_terminal",
                retryable: reconcileState === "busy",
            });
        }

        const unexpected = await deploymentLifecycleInternalsForTest.recoverDeploymentLifecycle(
            configuration,
            dependencies,
            {
                ...baseRecoveryDependencies,
                scanDeploymentJournals: () => {
                    throw new Error("fixture recovery dependency failure");
                },
            },
            DEPLOYMENT_ID,
        );
        expect(unexpected.diagnostics[0]).toMatchObject({
            code: "reverse_accept.lifecycle_unavailable",
            retryable: true,
        });
    });
});
