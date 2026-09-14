import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StateBackupInventoryV1 } from "@oaam/core";
import { describe, expect, it, vi } from "vitest";
import { ProductionHostRuntime } from "../src/host-runtime";
import { createEphemeralOperationalDiagnosticsForTest } from "../src/operational-diagnostics";
import { createHostForCoreForTest, createProductionHost, createStateRecoveryHost } from "../src/production-host";
import { createHostRenderApprovalAuthority } from "../src/render-approval-authority";
import { H2_DIGEST, H2_SOURCE_ROOT_ID, h2PreviewSnapshot, h2ProbeResult, h2ReadResult } from "./support/h2-review-fixtures";
import {
    complete,
    fakeCore,
    fakeCoreWith,
    flushHost,
    initializeRequest,
    PROJECT_ID,
    project,
    recordingSink,
    required,
    testStateResilienceIntegration,
    VERSION_ID,
} from "./support/host-test-fixtures";

describe("Production Host lifecycle with injected Core", () => {
    it("joins concurrent shutdown callers and waits for owned process cleanup before stopped", async () => {
        let release: () => void = () => undefined;
        const cleanup = new Promise<void>((resolve) => {
            release = resolve;
        });
        const releaseOwnedCore = vi.fn(() => cleanup);
        const runtime = createProductionHost(
            fakeCore(),
            testStateResilienceIntegration(),
            releaseOwnedCore,
            createEphemeralOperationalDiagnosticsForTest(),
        );
        const first = runtime.shutdown();
        const second = runtime.shutdown();
        expect(first).toBe(second);
        await flushHost();
        expect(runtime.state).toBe("draining");
        expect(releaseOwnedCore).toHaveBeenCalledTimes(1);
        expect(() => runtime.openConnection(recordingSink())).toThrow();
        release();
        await Promise.all([first, second]);
        expect(runtime.state).toBe("stopped");
        await runtime.shutdown();
        expect(releaseOwnedCore).toHaveBeenCalledTimes(1);
    });

    it("keeps failed asynchronous cleanup visible and never reports stopped or retries release", async () => {
        const releaseOwnedCore = vi.fn(async () => {
            throw new Error("owned process remains");
        });
        const runtime = createProductionHost(
            fakeCore(),
            testStateResilienceIntegration(),
            releaseOwnedCore,
            createEphemeralOperationalDiagnosticsForTest(),
        );
        await expect(runtime.shutdown()).rejects.toThrow("owned process remains");
        expect(runtime.state).toBe("draining");
        await expect(runtime.shutdown()).rejects.toThrow("owned process remains");
        expect(releaseOwnedCore).toHaveBeenCalledTimes(1);
    });

    it("uses production defaults for review tokens, member rows, path tokens, and the private spool root", async () => {
        const releaseOwnedCore = vi.fn();
        const runtime = createProductionHost(
            fakeCoreWith({ getProject: () => complete({ found: true, value: project }) }),
            testStateResilienceIntegration(),
            releaseOwnedCore,
            createEphemeralOperationalDiagnosticsForTest(),
        );
        runtime.recordDesktopOperationalDiagnostic("desktop.host.ready");
        expect(runtime.operationalHealth()).toMatchObject({
            overallStatus: "healthy",
            ordinaryLog: { state: "disabled" },
        });
        expect(runtime.hostInstanceId).toMatch(/^[0-9a-f-]{36}$/u);
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        expect(connection.connectionId).toMatch(/^[0-9a-f-]{36}$/u);
        expect(connection.registerLocalPathSelection("source_root", "/source")).toMatch(/^[0-9a-f-]{36}$/u);
        connection.receive(initializeRequest());
        connection.receive({ id: "reindex", method: "asset.reindex", params: {} });
        await flushHost();
        expect(sink.messages[1]).toMatchObject({ id: "reindex", result: { operationId: expect.any(String) } });
        const review = runtime.reviewRecords().recordProbe(connection.connectionId, [h2ProbeResult()]);
        expect(review.probeToken).toMatch(/^[0-9a-f-]{36}$/u);
        const resultRow = required(review.results[0], "probe result row");
        const projectRow = required(resultRow.projects[0], "project row");
        const sourceRow = required(resultRow.sources[0], "source row");
        expect(resultRow.rowId).toMatch(/^[0-9a-f-]{36}$/u);
        const observedReference = {
            probeToken: review.probeToken,
            probeResultRowId: resultRow.rowId,
            projectRowId: projectRow.rowId,
            sourceRootRowId: sourceRow.rowId,
        };
        expect(connection.resolveObservedProjectRoot(observedReference)).toBe("/project/.claude");
        expect(connection.authorizeObservedProjectRootRegistration(observedReference)).toEqual({
            rootPath: "/project/.claude",
            localPathSelectionToken: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        });
        expect(connection.resolveRegisteredProjectRoot(PROJECT_ID)).toBe("/project");
        expect(connection.authorizeRegisteredProjectRootProbe(PROJECT_ID)).toEqual({
            rootPath: "/project",
            localPathSelectionToken: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        });
        const read = h2ReadResult();
        read.observedReadEntries = [
            {
                observedReadEntryId: "observed-agents-file",
                sourceRootId: H2_SOURCE_ROOT_ID,
                relativePath: "AGENTS.md",
                entryKind: "file",
                contentHash: H2_DIGEST,
                executable: false,
                physicalIdentityFingerprint: H2_DIGEST,
            },
        ];
        required(read.candidates[0], "candidate").sourceFileOrigins = [
            { logicalPath: "AGENTS.md", observedReadEntryIds: ["observed-agents-file"] },
        ];
        const readReview = runtime.reviewRecords().recordRead(connection.connectionId, review.probeToken, [read]);
        const preview = runtime
            .reviewRecords()
            .recordPreview(connection.connectionId, readReview.readToken, h2PreviewSnapshot(read));
        const importPreviewReference = {
            previewToken: preview.previewToken,
            candidateId: "candidate-1",
            logicalPath: "AGENTS.md",
        };
        expect(connection.resolveImportPreviewFileDirectory(importPreviewReference)).toBe("/project/.claude");
        await runtime.shutdown();
        await runtime.shutdown();
        expect(() => connection.resolveObservedProjectRoot(observedReference)).toThrow(/connection is closed/u);
        expect(() => connection.resolveRegisteredProjectRoot(PROJECT_ID)).toThrow(/connection is closed/u);
        expect(() => connection.resolveImportPreviewFileDirectory(importPreviewReference)).toThrow(/connection is closed/u);
        expect(releaseOwnedCore).toHaveBeenCalledTimes(1);

        const runtimeWithApprovalAuthority = createProductionHost(
            fakeCore(),
            testStateResilienceIntegration(),
            () => undefined,
            createEphemeralOperationalDiagnosticsForTest(),
            createHostRenderApprovalAuthority(() => 1),
        );
        await runtimeWithApprovalAuthority.shutdown();
    });

    it("shares injected time across path and review bounds and invalidates only the owning connection", async () => {
        const spoolRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-host-runtime-review-"));
        let connectionNumber = 0;
        let reviewNumber = 0;
        let memberNumber = 0;
        const runtime = new ProductionHostRuntime("host", fakeCore(), testStateResilienceIntegration(), {
            createConnectionId: () => `connection-${++connectionNumber}`,
            createPathSelectionToken: () => "path",
            createReviewSpoolRoot: () => spoolRoot,
            createReviewToken: () => `review-${++reviewNumber}`,
            createReviewMemberId: () => `member-${++memberNumber}`,
            now: () => 1,
        });
        const firstSink = recordingSink();
        const secondSink = recordingSink();
        const first = runtime.openConnection(firstSink);
        const second = runtime.openConnection(secondSink);
        first.receive(initializeRequest("first"));
        second.receive(initializeRequest("second"));
        runtime.reviewRecords().recordProbe(first.connectionId, [h2ProbeResult()]);
        runtime.reviewRecords().recordProbe(first.connectionId, [h2ProbeResult()]);
        expect(firstSink.messages.some((message) => "method" in message && message.method === "resource.invalidated")).toBe(true);
        expect(secondSink.messages.some((message) => "method" in message && message.method === "resource.invalidated")).toBe(
            false,
        );
        await runtime.shutdown();
    });

    it("fails closed before authorizing a missing or stopped registered Project", async () => {
        for (const value of [{ found: false as const }, { found: true as const, value: { ...project, deleted: true } }]) {
            const runtime = createProductionHost(
                fakeCoreWith({ getProject: () => complete(value) }),
                testStateResilienceIntegration(),
                () => undefined,
                createEphemeralOperationalDiagnosticsForTest(),
            );
            const connection = runtime.openConnection(recordingSink());
            expect(() => connection.resolveRegisteredProjectRoot(PROJECT_ID)).toThrow(/Project is unavailable/u);
            expect(() => connection.authorizeRegisteredProjectRootProbe(PROJECT_ID)).toThrow(/Project is unavailable/u);
            await runtime.shutdown();
        }
    });

    it("rejects malformed or concurrently duplicated connection identifiers", async () => {
        const defaults = new ProductionHostRuntime("host-defaults", fakeCore(), testStateResilienceIntegration());
        expect(defaults.operationalHealth().ordinaryLog.state).toBe("disabled");
        await defaults.shutdown();

        const malformed = new ProductionHostRuntime("host-malformed", fakeCore(), testStateResilienceIntegration(), {
            createConnectionId: () => " connection ",
        });
        expect(() => malformed.openConnection(recordingSink())).toThrow(/unique connection id/u);
        await malformed.shutdown();

        const duplicate = new ProductionHostRuntime("host-duplicate", fakeCore(), testStateResilienceIntegration(), {
            createConnectionId: () => "connection",
        });
        const first = duplicate.openConnection(recordingSink());
        expect(() => duplicate.openConnection(recordingSink())).toThrow(/unique connection id/u);
        first.close();
        const replacement = duplicate.openConnection(recordingSink());
        expect(replacement.connectionId).toBe("connection");
        replacement.close();
        duplicate.removeConnection(replacement);
        await duplicate.shutdown();
    });

    it("drains accepted work, rejects new work, closes connections, and shuts down idempotently", async () => {
        let connectionNumber = 0;
        const runtime = new ProductionHostRuntime("host", fakeCore(), testStateResilienceIntegration(), {
            createConnectionId: () => `connection-${++connectionNumber}`,
        });
        const firstSink = recordingSink();
        const first = runtime.openConnection(firstSink);
        first.receive(initializeRequest());

        const draining = runtime.drain();
        expect(runtime.state).toBe("draining");
        expect(() => runtime.openConnection(recordingSink())).toThrow(/not accepting/u);
        const secondSink = recordingSink();
        const secondRuntime = createHostForCoreForTest(
            "second-host",
            fakeCore(),
            testStateResilienceIntegration(),
            () => "second",
        );
        const second = secondRuntime.openConnection(secondSink);
        second.receive(initializeRequest());
        second.receive({ id: "reindex", method: "asset.reindex", params: {} });
        await flushHost();
        expect(secondSink.messages[1]).toMatchObject({ id: "reindex", result: { operationId: expect.any(String) } });
        second.close();
        expect(secondSink.closeReasons).toEqual(["Host connection closed locally"]);
        first.receive({ id: "after-drain", method: "asset.list", params: {} });
        await draining;
        await flushHost();
        expect(firstSink.closeReasons).toEqual(["Host is not accepting new work"]);

        await runtime.shutdown();
        expect(runtime.state).toBe("stopped");
        await runtime.drain();
        await runtime.shutdown();
    });

    it("waits for active requests and makes request completion release idempotent", async () => {
        const runtime = new ProductionHostRuntime("host", fakeCore(), testStateResilienceIntegration(), {
            createConnectionId: () => "connection",
        });
        expect(runtime.canAcceptRequest()).toBe(true);
        const finish = runtime.beginRequest();
        expect(finish).not.toBeNull();
        const draining = runtime.drain();
        let drained = false;
        void draining.then(() => {
            drained = true;
        });
        await flushHost();
        expect(drained).toBe(false);
        finish?.();
        finish?.();
        await draining;
        expect(runtime.canAcceptRequest()).toBe(false);
        expect(runtime.beginRequest()).toBeNull();
        await runtime.shutdown();
    });

    it("drain waits for accepted long Core work after its request acknowledgement has finished", async () => {
        let release: (() => void) | undefined;
        const scanDeployment = () =>
            new Promise((resolve) => {
                release = () =>
                    resolve({
                        status: "complete",
                        value: {
                            deploymentId: VERSION_ID,
                            projectId: PROJECT_ID,
                            consumerAgentRuntimeIds: [],
                            platform: "linux",
                            targetRootPath: "/target",
                            observationState: "complete",
                            observationAttemptedAt: 2,
                            lastCompleteObservationAt: 2,
                            deleted: false,
                            derivedStatus: { stage: "in_sync", reason: "ok", actionHints: ["check_now"] },
                            assets: [],
                            createdAt: 1,
                            updatedAt: 2,
                        },
                        diagnostics: [],
                    });
            });
        const runtime = new ProductionHostRuntime(
            "host",
            fakeCoreWith({ scanDeployment: scanDeployment as never }),
            testStateResilienceIntegration(),
            {
                createConnectionId: () => "connection",
                maximumActiveOperations: 2,
                maximumCompletedOperations: 2,
            },
        );
        const connection = runtime.openConnection(recordingSink());
        connection.receive(initializeRequest());
        connection.receive({
            id: "request-2",
            method: "deployment.scan",
            params: { deploymentId: VERSION_ID },
        });
        await flushHost();
        const draining = runtime.drain();
        let drained = false;
        void draining.then(() => {
            drained = true;
        });
        await flushHost();
        expect(drained).toBe(false);
        release?.();
        await draining;
        expect(drained).toBe(true);
        await runtime.shutdown();
    });

    it("resolves only a live registered backup while the Host is ready", async () => {
        const backupId = "00000000-0000-4000-8000-000000000001";
        const inventory = (observation: "available" | "missing"): StateBackupInventoryV1 => ({
            schemaVersion: 1,
            entries: [
                {
                    schemaVersion: 1,
                    backupId,
                    createdAt: 1,
                    archivePath: "/profile/backups/backup.zip",
                    archiveByteSize: 10,
                    archiveContentHash: `sha256:${"a".repeat(64)}`,
                    manifestFingerprint: `sha256:${"b".repeat(64)}`,
                    sourceSnapshotFingerprint: `sha256:${"c".repeat(64)}`,
                    encryptionMode: "none",
                    destinationKind: "oaam_default",
                    observation,
                },
            ],
            totalKnownArchiveBytes: 10,
            totalAvailableArchiveBytes: observation === "available" ? 10 : 0,
        });
        const available = new ProductionHostRuntime(
            "available",
            fakeCoreWith({ listStateBackups: () => ({ status: "complete", value: inventory("available"), diagnostics: [] }) }),
            testStateResilienceIntegration(),
            { createConnectionId: () => "connection" },
        );
        expect(available.resolveStateBackupFileAction(backupId)).toBe("/profile/backups/backup.zip");
        await available.beginExclusiveRestore("operation");
        await available.beginExclusiveRestore("operation");
        expect(() => available.resolveStateBackupFileAction(backupId)).toThrow(/not ready/u);
        await available.shutdown();
        await expect(available.beginExclusiveRestore("operation")).rejects.toThrow(/stopped/u);

        const missing = new ProductionHostRuntime(
            "missing",
            fakeCoreWith({ listStateBackups: () => ({ status: "complete", value: inventory("missing"), diagnostics: [] }) }),
            testStateResilienceIntegration(),
            { createConnectionId: () => "connection" },
        );
        expect(() => missing.resolveStateBackupFileAction(backupId)).toThrow(/missing, replaced/u);
        await missing.shutdown();

        const failed = new ProductionHostRuntime(
            "failed",
            fakeCoreWith({ listStateBackups: () => ({ status: "failed", diagnostics: [] }) }),
            testStateResilienceIntegration(),
            { createConnectionId: () => "connection" },
        );
        expect(() => failed.resolveStateBackupFileAction(backupId)).toThrow(/inventory is unavailable/u);
        await failed.shutdown();
    });

    it("delegates identity-bound backup retirement only while the Host is ready", async () => {
        const backupId = "00000000-0000-4000-8000-000000000001";
        const recycled: unknown[] = [];
        const retired: unknown[] = [];
        const runtime = new ProductionHostRuntime(
            "mutations",
            fakeCoreWith({
                recycleStateBackup: (input) => {
                    recycled.push(input);
                    return { status: "complete", value: { schemaVersion: 1, backupId }, diagnostics: [] };
                },
                retireMissingStateBackup: (input) => {
                    retired.push(input);
                    return { status: "complete", value: { schemaVersion: 1, backupId }, diagnostics: [] };
                },
            }),
            testStateResilienceIntegration(),
            { createConnectionId: () => "connection" },
        );
        runtime.recycleStateBackupFileAction(backupId, "user-action-trash");
        runtime.retireMissingStateBackupFileAction(backupId, "user-action-retire");
        expect(recycled).toEqual([{ backupId, userActionId: "user-action-trash" }]);
        expect(retired).toEqual([{ backupId, userActionId: "user-action-retire" }]);
        await runtime.beginExclusiveRestore("operation");
        expect(() => runtime.recycleStateBackupFileAction(backupId, "user-action-late")).toThrow(/not ready/u);
        await runtime.shutdown();

        const rejected = new ProductionHostRuntime(
            "rejected",
            fakeCoreWith({
                recycleStateBackup: () => ({ status: "failed", diagnostics: [] }),
                retireMissingStateBackup: () => ({ status: "failed", diagnostics: [] }),
            }),
            testStateResilienceIntegration(),
            { createConnectionId: () => "connection" },
        );
        expect(() => rejected.recycleStateBackupFileAction(backupId, "user-action-trash")).toThrow(/could not be recycled/u);
        expect(() => rejected.retireMissingStateBackupFileAction(backupId, "user-action-retire")).toThrow(
            /could not be retired/u,
        );
        await rejected.shutdown();
    });

    it("fails closed if an internal caller asks a recovery-only Host for ordinary Core authority", async () => {
        const recovery = createStateRecoveryHost(
            testStateResilienceIntegration(),
            "missing_database",
            createEphemeralOperationalDiagnosticsForTest(),
        );
        expect(() => recovery.resolveStateBackupFileAction("00000000-0000-4000-8000-000000000001")).toThrow(
            /no ordinary Core authority/u,
        );
        await recovery.shutdown();

        const malformed = new ProductionHostRuntime(
            "malformed-recovery",
            undefined,
            testStateResilienceIntegration(),
            {
                createConnectionId: () => "connection",
                createOperationId: () => "operation",
            },
            ["initialize", "asset.reindex"],
            { mode: "state_recovery", reason: "missing_database" },
        );
        const sink = recordingSink();
        const connection = malformed.openConnection(sink);
        expect(() => connection.resolveRegisteredProjectRoot(PROJECT_ID)).toThrow(/Registered Project authority is unavailable/u);
        connection.receive(initializeRequest());
        connection.receive({ id: "reindex", method: "asset.reindex", params: {} });
        await flushHost();
        await flushHost();
        expect(sink.messages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: "operation.terminal",
                    params: expect.objectContaining({
                        operation: "asset.reindex",
                        outcome: expect.objectContaining({
                            status: "failed",
                            diagnostics: [expect.objectContaining({ code: "host.core_invocation_failed" })],
                        }),
                    }),
                }),
            ]),
        );
        await malformed.shutdown();
    });
});
