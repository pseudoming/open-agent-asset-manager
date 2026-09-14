/** Durable reverse reservations must remain actionable after renderer/process restart. */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { readDeploymentView } from "../../src/deployment/deployment-view";
import { closeDb } from "../../src/persistence/db";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import { createCoreServiceForTest } from "../../src/orchestration/core-service";
import {
    createDeploymentRecoveryViewReader,
    projectDeploymentReverseRecovery,
} from "../../src/orchestration/deployment-recovery-projection";
import {
    createReverseAcceptMarkerStore,
    scanReverseAcceptReservations,
    type ReverseAcceptMarkerStore,
    type ReverseAcceptReservationScanResult,
} from "../../src/reverse/reverse-accept-marker";
import { createReverseAcceptService } from "../../src/reverse/reverse-accept-service";
import type { DeploymentView, UuidV4 } from "../../src/types";
import {
    DEPLOYMENT_UUID,
    exactAnalysisValidator,
    harness,
    leaveClaimedAfterCommit,
    prepare,
} from "./fixtures/reverse-accept-commit-test-fixtures";

const OTHER_DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222" as UuidV4;

describe("Deployment reverse-recovery projection", () => {
    it("projects a fresh-process Recover action from the exact durable terminal reservation", async () => {
        await leaveClaimedAfterCommit(harness);
        const restartedStore = reopenedStore();
        const base = readBaseView();
        expect(base.derivedStatus.actionHints).not.toContain("recover");

        const restarted = readProjected(restartedStore);
        expect(restarted.derivedStatus).toEqual({
            stage: "blocked",
            reason: "blocked_by_recovery_state_unavailable",
            diagnostics: [],
            observationWarnings: [],
            actionHints: ["recover"],
        });

        const actualScan = scanReverseAcceptReservations(harness.transactionsRoot, restartedStore);
        const unrelated = projectDeploymentReverseRecovery(base, {
            ...actualScan,
            activePreparations: actualScan.activePreparations.map((identity) => ({
                ...identity,
                deploymentId: OTHER_DEPLOYMENT_ID,
            })),
        });
        expect(unrelated).toBe(base);
    });

    it("wires get/list/recover through a restarted Core and retires the terminal marker", async () => {
        await leaveClaimedAfterCommit(harness);
        closeDb();
        clearRegistry();
        const core = createCoreServiceForTest(
            {
                providers: [],
                platformContexts: [
                    {
                        platform: "linux",
                        platformInstanceId: "local-linux",
                        accessRootPath: harness.root,
                    },
                ],
                oaamRoot: harness.root,
                databasePath: harness.databasePath,
            },
            {},
        );
        try {
            const current = core.getDeployment(DEPLOYMENT_UUID);
            expect(current.status).toBe("complete");
            expect(current.value).toMatchObject({
                found: true,
                value: {
                    derivedStatus: {
                        stage: "blocked",
                        actionHints: ["recover"],
                    },
                },
            });
            const listed = core.listDeployments();
            expect(listed.status).toBe("complete");
            expect(listed.value).toHaveLength(1);
            expect(listed.value[0]?.derivedStatus.actionHints).toEqual(["recover"]);

            const recovered = await core.recoverDeployment(DEPLOYMENT_UUID);
            expect(recovered.status).toBe("complete");
            expect(recovered.value.derivedStatus.actionHints).not.toContain("recover");
            expect(scanReverseAcceptReservations(harness.transactionsRoot, reopenedStore()).activePreparations).toEqual([]);

            const reopened = core.getDeployment(DEPLOYMENT_UUID);
            expect(reopened.status).toBe("complete");
            expect(reopened.value.value?.derivedStatus.actionHints).not.toContain("recover");
        } finally {
            closeDb();
            clearRegistry();
        }
    });

    it("does not turn a session-local prepared marker into a recovery action", async () => {
        const prepared = await prepare(createReverseAcceptService(harness.configuration()));
        expect(prepared.status).toBe("complete");

        const view = readProjected(reopenedStore());
        expect(view.derivedStatus.actionHints).not.toContain("recover");
        expect(view.derivedStatus.actionHints).not.toContain("contact_support");
    });

    it("fails closed to Contact support when the reservation inventory is globally unavailable", () => {
        fs.mkdirSync(path.join(harness.transactionsRoot, "reverse-accept", "not-a-preparation-id"), {
            recursive: true,
        });
        expect(readProjected(reopenedStore()).derivedStatus).toEqual({
            stage: "blocked",
            reason: "blocked_needs_support",
            diagnostics: [],
            observationWarnings: [],
            actionHints: ["contact_support"],
        });

        const scannerFailure = readProjected(reopenedStore(), () => {
            throw new Error("reservation inventory unavailable");
        });
        expect(scannerFailure.derivedStatus.actionHints).toEqual(["contact_support"]);
    });

    it("preserves deleted and stronger support states and rejects a foreign transactions root", () => {
        const base = readBaseView();
        const globalFreeze: ReverseAcceptReservationScanResult = {
            globalFreeze: true,
            activePreparations: [],
        };
        const deleted = { ...base, deleted: true } satisfies DeploymentView;
        expect(projectDeploymentReverseRecovery(deleted, globalFreeze)).toBe(deleted);

        const support = {
            ...base,
            derivedStatus: {
                stage: "blocked" as const,
                reason: "blocked_needs_support",
                diagnostics: [],
                observationWarnings: [],
                actionHints: ["contact_support" as const],
            },
        };
        const exactReservation = {
            globalFreeze: false,
            activePreparations: [
                {
                    schemaVersion: 1 as const,
                    preparationId: "33333333-3333-4333-8333-333333333333" as UuidV4,
                    deploymentId: DEPLOYMENT_UUID,
                    commitTransactionId: "44444444-4444-4444-8444-444444444444" as UuidV4,
                    assetIds: [],
                    preparationIdentityFingerprint: `sha256:${"a".repeat(64)}` as const,
                },
            ],
        };
        expect(projectDeploymentReverseRecovery(support, exactReservation)).toBe(support);

        const db = new Database(harness.databasePath);
        try {
            expect(() =>
                createReader(reopenedStore())({
                    db,
                    transactionsRoot: path.join(harness.root, "foreign-transactions"),
                    deploymentId: DEPLOYMENT_UUID,
                }),
            ).toThrow("foreign transactions root");
        } finally {
            db.close();
        }
    });

    it("preserves a missing base Deployment without scanning reverse reservations", () => {
        let scans = 0;
        const reader = createDeploymentRecoveryViewReader({
            transactionsRoot: harness.transactionsRoot,
            markerStore: reopenedStore(),
            readBaseView: () => null,
            scanReservations: () => {
                scans += 1;
                return { globalFreeze: false, activePreparations: [] };
            },
        });
        const db = new Database(harness.databasePath);
        try {
            expect(
                reader({
                    db,
                    transactionsRoot: harness.transactionsRoot,
                    deploymentId: OTHER_DEPLOYMENT_ID,
                }),
            ).toBeNull();
        } finally {
            db.close();
        }
        expect(scans).toBe(0);
    });
});

function reopenedStore(): ReverseAcceptMarkerStore {
    return createReverseAcceptMarkerStore(harness.transactionsRoot, exactAnalysisValidator(harness.analysis));
}

function createReader(
    markerStore: ReverseAcceptMarkerStore,
    scanner = scanReverseAcceptReservations,
): ReturnType<typeof createDeploymentRecoveryViewReader> {
    return createDeploymentRecoveryViewReader({
        transactionsRoot: harness.transactionsRoot,
        markerStore,
        readBaseView: readDeploymentView,
        scanReservations: scanner,
    });
}

function readProjected(markerStore: ReverseAcceptMarkerStore, scanner = scanReverseAcceptReservations): DeploymentView {
    const db = new Database(harness.databasePath);
    try {
        const view = createReader(
            markerStore,
            scanner,
        )({
            db,
            transactionsRoot: harness.transactionsRoot,
            deploymentId: DEPLOYMENT_UUID,
        });
        if (view === null) throw new Error("Deployment fixture is missing");
        return view;
    } finally {
        db.close();
    }
}

function readBaseView(): DeploymentView {
    const db = new Database(harness.databasePath);
    try {
        const view = readDeploymentView({
            db,
            transactionsRoot: harness.transactionsRoot,
            deploymentId: DEPLOYMENT_UUID,
        });
        if (view === null) throw new Error("Deployment fixture is missing");
        return view;
    } finally {
        db.close();
    }
}
