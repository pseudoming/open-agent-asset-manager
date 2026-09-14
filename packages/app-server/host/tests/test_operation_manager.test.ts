import { describe, expect, it } from "vitest";
import { HostOperationManager } from "../src/operation-manager";
import { flushHost } from "./support/host-test-fixtures";

function reindexSuccess(scannedAssets = 1) {
    return {
        status: "complete",
        value: {
            scannedAssets,
            indexedAssets: scannedAssets,
            skippedAssets: 0,
            diagnostics: [],
        },
        diagnostics: [],
    };
}

describe("Host accepted-long operation manager", () => {
    it("retains one terminal event, supports monotonic replay, and reports honest cancellation", async () => {
        const notifications: unknown[] = [];
        const lifecycle: string[] = [];
        const manager = new HostOperationManager({ createOperationId: () => "operation-1" });
        const reservation = manager.reserve("asset.reindex", (notification) => {
            notifications.push(notification);
            lifecycle.push("terminal");
        });
        manager.start(reservation, async (context) => {
            context.afterTerminal(() => lifecycle.push("after-terminal"));
            return reindexSuccess();
        });
        await manager.waitForIdle();

        expect(lifecycle).toEqual(["terminal", "after-terminal"]);
        expect(notifications).toEqual([
            {
                method: "operation.terminal",
                params: {
                    operationId: "operation-1",
                    sequence: 1,
                    operation: "asset.reindex",
                    outcome: reindexSuccess(),
                },
            },
        ]);
        expect(manager.observe("operation-1", 0)).toEqual({
            status: "available",
            events: [
                {
                    eventKind: "terminal",
                    operationId: "operation-1",
                    sequence: 1,
                    operation: "asset.reindex",
                    outcome: reindexSuccess(),
                },
            ],
        });
        expect(manager.observe("operation-1", 1)).toEqual({ status: "available", events: [] });
        expect(manager.observe("missing", 0)).toEqual({ status: "operation_unavailable", events: [] });
        expect(manager.requestCancellation("operation-1")).toEqual({ status: "not_cancellable" });
        expect(manager.requestCancellation("missing")).toEqual({ status: "operation_unavailable" });
        await manager.waitForIdle();
    });

    it("records cancellation only for an active cancellable comparison and exposes it to the runner", async () => {
        let release: (() => void) | undefined;
        let cancellationObserved = false;
        const manager = new HostOperationManager({ createOperationId: () => "operation-1" });
        const reservation = manager.reserve("asset_version.compare", () => undefined);
        manager.start(reservation, async (context) => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            cancellationObserved = context.isCancellationRequested();
            return {
                status: "complete",
                value: {
                    schemaVersion: 1,
                    assetId: "00000000-0000-4000-8000-000000000001",
                    left: {
                        versionId: "00000000-0000-4000-8000-000000000002",
                        versionFingerprint: "a".repeat(64),
                    },
                    right: {
                        versionId: "00000000-0000-4000-8000-000000000003",
                        versionFingerprint: "b".repeat(64),
                    },
                    files: [],
                    selectedFile: { comparisonKind: "not_requested" },
                },
                diagnostics: [],
            };
        });
        await flushHost();

        expect(manager.requestCancellation("operation-1")).toEqual({ status: "requested" });
        release?.();
        await manager.waitForIdle();

        expect(cancellationObserved).toBe(true);
        expect(manager.requestCancellation("operation-1")).toEqual({ status: "not_cancellable" });
    });

    it("turns a throwing or invalid runner into a redacted Host failure and tolerates notification loss", async () => {
        let operationNumber = 0;
        const manager = new HostOperationManager({ createOperationId: () => `operation-${++operationNumber}` });
        const throwing = manager.reserve("asset.reindex", () => {
            throw new Error("transport failed");
        });
        manager.start(throwing, async () => {
            throw new Error("secret");
        });
        await manager.waitForIdle();
        expect(JSON.stringify(manager.observe("operation-1", 0))).toContain("host.core_invocation_failed");
        expect(JSON.stringify(manager.observe("operation-1", 0))).not.toContain("secret");

        const invalid = manager.reserve("asset.reindex", () => undefined);
        manager.start(invalid, async () => ({ invalid: true }));
        await manager.waitForIdle();
        expect(JSON.stringify(manager.observe("operation-2", 0))).toContain("host.core_invocation_failed");
    });

    it("acknowledges capacity exhaustion as a bounded failed operation without calling its runner", async () => {
        let operationNumber = 0;
        let releaseFirst: (() => void) | undefined;
        const manager = new HostOperationManager({
            createOperationId: () => `operation-${++operationNumber}`,
            maximumActiveOperations: 1,
        });
        const first = manager.reserve("asset.reindex", () => undefined);
        manager.start(
            first,
            () =>
                new Promise((resolve) => {
                    releaseFirst = () => resolve(reindexSuccess());
                }),
        );
        await flushHost();

        let secondCalled = false;
        const second = manager.reserve("asset.reindex", () => undefined);
        manager.start(second, async () => {
            secondCalled = true;
            return reindexSuccess();
        });
        const abandonedAtCapacity = manager.reserve("asset.reindex", () => undefined);
        manager.abandon(abandonedAtCapacity);
        await flushHost();

        expect(secondCalled).toBe(false);
        expect(JSON.stringify(manager.observe("operation-2", 0))).toContain("host.operation_capacity_exceeded");
        let idle = false;
        void manager.waitForIdle().then(() => {
            idle = true;
        });
        await flushHost();
        expect(idle).toBe(false);
        releaseFirst?.();
        await manager.waitForIdle();
        expect(idle).toBe(true);
    });

    it("abandons unsent reservations idempotently and rejects starting an unavailable reservation", async () => {
        const manager = new HostOperationManager({ createOperationId: () => "operation-1" });
        const reservation = manager.reserve("asset.reindex", () => undefined);
        manager.abandon(reservation);
        manager.abandon(reservation);
        expect(manager.observe("operation-1", 0)).toEqual({ status: "operation_unavailable", events: [] });
        expect(() => manager.start(reservation, async () => reindexSuccess())).toThrow(/unavailable/u);
        await manager.waitForIdle();
    });

    it("waits for all active operations and evicts only the oldest completed record", async () => {
        let operationNumber = 0;
        const releases: (() => void)[] = [];
        const manager = new HostOperationManager({
            createOperationId: () => `operation-${++operationNumber}`,
            maximumActiveOperations: 2,
            maximumCompletedOperations: 1,
        });
        for (let index = 0; index < 2; index += 1) {
            const reservation = manager.reserve("asset.reindex", () => undefined);
            manager.start(
                reservation,
                () =>
                    new Promise((resolve) => {
                        releases.push(() => resolve(reindexSuccess(index + 1)));
                    }),
            );
        }
        await flushHost();
        const idle = manager.waitForIdle();
        releases[0]?.();
        await flushHost();
        expect(manager.observe("operation-1", 0).status).toBe("available");
        releases[1]?.();
        await idle;
        expect(manager.observe("operation-1", 0)).toEqual({ status: "operation_unavailable", events: [] });
        expect(manager.observe("operation-2", 0).status).toBe("available");
    });

    it("can drain every operation except the restore operation that owns the exclusive transition", async () => {
        let operationNumber = 0;
        let releaseOther: (() => void) | undefined;
        let releaseRestore: (() => void) | undefined;
        const manager = new HostOperationManager({ createOperationId: () => `operation-${++operationNumber}` });
        const restore = manager.reserve("asset.reindex", () => undefined);
        manager.start(
            restore,
            () =>
                new Promise((resolve) => {
                    releaseRestore = () => resolve(reindexSuccess());
                }),
        );
        const other = manager.reserve("asset.reindex", () => undefined);
        manager.start(
            other,
            () =>
                new Promise((resolve) => {
                    releaseOther = () => resolve(reindexSuccess());
                }),
        );
        await flushHost();

        let exclusiveDrainComplete = false;
        void manager.waitForIdleExcluding("operation-1").then(() => {
            exclusiveDrainComplete = true;
        });
        await flushHost();
        expect(exclusiveDrainComplete).toBe(false);

        releaseOther?.();
        await flushHost();
        expect(exclusiveDrainComplete).toBe(true);
        expect(manager.observe("operation-1", 0).events).toEqual([]);

        releaseRestore?.();
        await manager.waitForIdle();
    });

    it("does not let a throwing post-terminal lifecycle callback replace the retained outcome", async () => {
        const manager = new HostOperationManager({ createOperationId: () => "operation-1" });
        const reservation = manager.reserve("asset.reindex", () => undefined);
        manager.start(reservation, async (context) => {
            context.afterTerminal(() => {
                throw new Error("process replacement failed");
            });
            return reindexSuccess();
        });
        await manager.waitForIdle();
        expect(manager.observe("operation-1", 0).events).toHaveLength(1);
        expect(JSON.stringify(manager.observe("operation-1", 0))).not.toContain("process replacement failed");
    });

    it("retains validated progress and rejects a captured progress reporter after terminal completion", async () => {
        const manager = new HostOperationManager({ createOperationId: () => "operation-1" });
        const reservation = manager.reserve("state_backup.inspect", () => undefined);
        let reportAfterTerminal: ((progress: unknown) => void) | undefined;
        manager.start(reservation, async (context) => {
            reportAfterTerminal = context.reportProgress;
            context.reportProgress({ stage: "inventory", completedUnits: 1, totalUnits: 2 });
            return {
                status: "complete",
                value: {
                    backupReviewToken: "review",
                    backupId: "00000000-0000-4000-8000-000000000001",
                    createdAt: 10,
                    destinationKind: "oaam_default",
                    destinationDisplayPath: "/profile/backups",
                    destinationState: "ready",
                    outputFileName: "backup.zip",
                    encryptionMode: "none",
                    sourceFileCount: 1,
                    sourceLogicalBytes: 1,
                    requiredAvailableBytes: 2,
                    availableBytes: 3,
                    sourceSnapshotFingerprint: "a".repeat(64),
                },
                diagnostics: [],
            };
        });
        await manager.waitForIdle();

        expect(manager.observe("operation-1", 0).events).toHaveLength(2);
        expect(() => reportAfterTerminal?.({ stage: "inventory", completedUnits: 2, totalUnits: 2 })).toThrow(
            /not accepting progress/u,
        );
    });

    it("rejects impossible, regressing, or unstable progress without retaining the invalid event", async () => {
        let operationNumber = 0;
        const manager = new HostOperationManager({ createOperationId: () => `operation-${++operationNumber}` });
        const cases = [
            {
                valid: [{ stage: "inventory", completedUnits: 0, totalUnits: 2 }],
                invalid: { stage: "inventory", completedUnits: 3, totalUnits: 2 },
                message: /exceed its total/u,
            },
            {
                valid: [
                    { stage: "inventory", completedUnits: 1, totalUnits: 2 },
                    { stage: "packing", completedUnits: 0, totalUnits: 1 },
                ],
                invalid: { stage: "inventory", completedUnits: 0, totalUnits: 2 },
                message: /cannot regress/u,
            },
            {
                valid: [{ stage: "inventory", completedUnits: 1, totalUnits: 2 }],
                invalid: { stage: "inventory", completedUnits: 1, totalUnits: 3 },
                message: /total units cannot change/u,
            },
        ] as const;

        for (const testCase of cases) {
            const reservation = manager.reserve("state_backup.inspect", () => undefined);
            manager.start(reservation, async (context) => {
                for (const progress of testCase.valid) context.reportProgress(progress);
                expect(() => context.reportProgress(testCase.invalid)).toThrow(testCase.message);
                return {
                    status: "failed",
                    diagnostics: [
                        {
                            severity: "error",
                            code: "fixture.failed",
                            operation: "backup",
                            causeKind: "unavailable",
                            retryable: false,
                            suggestedActions: [],
                            message: "fixture",
                        },
                    ],
                };
            });
            await manager.waitForIdle();
            const observed = manager.observe(reservation.operationId, 0);
            expect(observed.status).toBe("available");
            if (observed.status === "available") {
                expect(observed.events.filter((event) => event.eventKind === "progress")).toHaveLength(testCase.valid.length);
                expect(observed.events.at(-1)?.eventKind).toBe("terminal");
            }
        }
    });

    it("rejects invalid bounds and operation-id exhaustion without overwriting an active operation", () => {
        expect(() => new HostOperationManager({ createOperationId: () => "id", maximumActiveOperations: 0 })).toThrow(
            /positive/u,
        );
        expect(() => new HostOperationManager({ createOperationId: () => "id", maximumCompletedOperations: 0 })).toThrow(
            /positive/u,
        );
        const blank = new HostOperationManager({ createOperationId: () => " " });
        expect(() => blank.reserve("asset.reindex", () => undefined)).toThrow(/unique operation id/u);

        const duplicate = new HostOperationManager({ createOperationId: () => "same" });
        duplicate.reserve("asset.reindex", () => undefined);
        expect(() => duplicate.reserve("asset.reindex", () => undefined)).toThrow(/unique operation id/u);
    });
});
