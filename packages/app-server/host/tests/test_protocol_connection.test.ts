import { PROTOCOL_OPERATION_NAMES } from "@oaam/app-server-protocol";
import type { DeploymentRenderPreviewView, DeploymentView } from "@oaam/core";
import { describe, expect, it, vi } from "vitest";
import { HOST_H1_OPERATIONS } from "../src/dispatch-registry";
import { ProductionHostRuntime } from "../src/host-runtime";
import { createEphemeralOperationalDiagnosticsForTest, type OperationalDiagnostics } from "../src/operational-diagnostics";
import {
    ASSET_ID,
    assetSummary,
    fakeCore,
    fakeCoreWith,
    flushHost,
    host,
    initializeRequest,
    PROJECT_ID,
    recordingSink,
    testStateResilienceIntegration,
    VERSION_ID,
} from "./support/host-test-fixtures";

function recordingOperationalDiagnostics(): {
    readonly diagnostics: OperationalDiagnostics;
    readonly record: ReturnType<typeof vi.fn>;
} {
    const base = createEphemeralOperationalDiagnosticsForTest();
    const record = vi.fn((input: Parameters<OperationalDiagnostics["record"]>[0]) => base.record(input));
    return {
        record,
        diagnostics: {
            record,
            health: (state, startupDisposition) => base.health(state, startupDisposition),
            settings: () => base.settings(),
            replaceSettings: (input) => base.replaceSettings(input),
            clearOrdinaryLog: () => base.clearOrdinaryLog(),
            captureSupportLogSnapshot: (maximumBytes) => base.captureSupportLogSnapshot(maximumBytes),
        },
    };
}

describe("Production Host foundation Protocol route", () => {
    it("serves Host-owned diagnostics health without invoking Core", async () => {
        const listAssets = vi.fn();
        const runtime = host(fakeCore(listAssets));
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive({ id: "health", method: "diagnostics.health.get", params: {} });
        await flushHost();

        expect(sink.messages[1]).toEqual({
            id: "health",
            result: {
                status: "complete",
                value: {
                    schemaVersion: 1,
                    overallStatus: "healthy",
                    host: { lifecycleState: "ready", startupMode: "normal" },
                    ordinaryLog: {
                        state: "disabled",
                        suspensionReason: "user_disabled",
                        retainedBytes: 0,
                        maximumBytes: 52_428_800,
                        segmentCount: 0,
                    },
                },
                diagnostics: [],
            },
        });
        expect(listAssets).not.toHaveBeenCalled();
        await runtime.shutdown();
    });

    it("routes exact ordinary-log settings and confirmed clear operations without invoking Core", async () => {
        const settings = {
            schemaVersion: 1 as const,
            enabled: true,
            retentionDays: 14,
            maximumBytes: 50 * 1024 * 1024,
        };
        const record = vi.fn();
        const operationalDiagnostics: OperationalDiagnostics = {
            record,
            health: vi.fn(() => ({
                schemaVersion: 1,
                overallStatus: "healthy",
                host: { lifecycleState: "ready", startupMode: "normal" },
                ordinaryLog: {
                    state: "active",
                    suspensionReason: "none",
                    retainedBytes: 0,
                    maximumBytes: settings.maximumBytes,
                    segmentCount: 0,
                },
            })),
            settings: vi.fn(() => ({ status: "complete", value: settings, diagnostics: [] })),
            replaceSettings: vi.fn((next) => ({
                status: "complete",
                value: { schemaVersion: 1, ...next },
                diagnostics: [],
            })),
            clearOrdinaryLog: vi.fn(() => ({
                status: "complete",
                value: {
                    removedSegmentCount: 2,
                    removedBytes: 100,
                    settings,
                },
                diagnostics: [],
            })),
        };
        const listAssets = vi.fn();
        const runtime = new ProductionHostRuntime("host-diagnostics", fakeCore(listAssets), testStateResilienceIntegration(), {
            createConnectionId: () => "connection-diagnostics",
            createOperationId: () => "operation-diagnostics",
            operationalDiagnostics,
        });
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive({ id: "settings-get", method: "diagnostics.ordinary_log.settings.get", params: {} });
        connection.receive({
            id: "settings-replace",
            method: "diagnostics.ordinary_log.settings.replace",
            params: { enabled: false, retentionDays: 7, maximumBytes: 1024 * 1024 },
        });
        connection.receive({
            id: "clear-rejected",
            method: "diagnostics.ordinary_log.clear",
            params: { confirmedPermanentRemoval: false },
        });
        connection.receive({
            id: "clear-confirmed",
            method: "diagnostics.ordinary_log.clear",
            params: { confirmedPermanentRemoval: true },
        });
        await flushHost();

        expect(sink.messages.slice(1)).toEqual([
            { id: "settings-get", result: { status: "complete", value: settings, diagnostics: [] } },
            {
                id: "settings-replace",
                result: {
                    status: "complete",
                    value: {
                        schemaVersion: 1,
                        enabled: false,
                        retentionDays: 7,
                        maximumBytes: 1024 * 1024,
                    },
                    diagnostics: [],
                },
            },
            {
                id: "clear-rejected",
                error: {
                    code: "protocol.invalid_params",
                    message: expect.stringContaining("expected true"),
                },
            },
            {
                id: "clear-confirmed",
                result: {
                    status: "complete",
                    value: {
                        removedSegmentCount: 2,
                        removedBytes: 100,
                        settings,
                    },
                    diagnostics: [],
                },
            },
        ]);
        expect(operationalDiagnostics.settings).toHaveBeenCalledTimes(1);
        expect(operationalDiagnostics.replaceSettings).toHaveBeenCalledWith({
            enabled: false,
            retentionDays: 7,
            maximumBytes: 1024 * 1024,
        });
        expect(operationalDiagnostics.clearOrdinaryLog).toHaveBeenCalledTimes(1);
        expect(record.mock.calls.map(([input]) => input)).toContainEqual({
            source: "protocol",
            code: "protocol.request.terminal",
            operation: "diagnostics.ordinary_log.settings.get",
            status: "complete",
            diagnosticCodes: [],
        });
        expect(record.mock.calls.map(([input]) => input)).toContainEqual({
            source: "protocol",
            code: "protocol.request.terminal",
            operation: "diagnostics.ordinary_log.settings.replace",
            status: "complete",
            diagnosticCodes: [],
        });
        expect(record.mock.calls.map(([input]) => input)).toContainEqual({
            source: "protocol",
            code: "protocol.request.terminal",
            operation: "diagnostics.ordinary_log.clear",
            status: "complete",
            diagnosticCodes: [],
        });
        runtime.recordDesktopRendererOperationalDiagnostic({
            event: "failure",
            failureKind: "render",
            surface: "library",
            componentTrail: ["AssetVersionPanel"],
        });
        expect(record.mock.calls.map(([input]) => input)).toContainEqual({
            source: "desktop",
            code: "desktop.renderer.event",
            event: "failure",
            failureKind: "render",
            surface: "library",
            componentTrail: ["AssetVersionPanel"],
        });
        expect(listAssets).not.toHaveBeenCalled();
        await runtime.shutdown();
    });

    it("initializes once, advertises only installed dispatches, and projects a real asset list", async () => {
        const listAssets = vi.fn(() => ({
            status: "complete" as const,
            value: [
                assetSummary(),
                assetSummary({
                    assetId: PROJECT_ID as ReturnType<typeof assetSummary>["assetId"],
                    scope: "project",
                    projectId: PROJECT_ID,
                    displayName: "Project guidance",
                }),
            ],
            diagnostics: [
                {
                    severity: "warning" as const,
                    code: "asset.warning",
                    message: "warning",
                    path: "/visible",
                    traceId: "trace",
                    operation: "asset" as const,
                    causeKind: "partial" as const,
                    retryable: true,
                    suggestedActions: ["retry" as const],
                    rawSummary: "private",
                },
            ],
        }));
        const runtime = host(fakeCore(listAssets));
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);

        connection.receive(initializeRequest());
        await flushHost();
        connection.receive({ id: "request-2", method: "asset.list", params: { includeDeleted: true } });
        await flushHost();

        expect(connection.connectionId).toBe("connection-1");
        expect(sink.messages).toEqual([
            {
                id: "request-1",
                result: {
                    protocolVersion: 1,
                    hostInstanceId: "host-1",
                    availableOperations: [...PROTOCOL_OPERATION_NAMES],
                },
            },
            {
                id: "request-2",
                result: {
                    status: "complete",
                    value: {
                        assets: [
                            {
                                assetId: ASSET_ID,
                                kind: "Guidance",
                                scope: "global",
                                scopePath: "",
                                displayName: "Guidance",
                                displayDescription: "",
                                currentVersionId: VERSION_ID,
                                currentRevision: 1,
                                currentFingerprint: "a".repeat(64),
                                currentVersionStatus: "complete",
                                deleted: false,
                                createdAt: 1,
                                updatedAt: 2,
                            },
                            {
                                assetId: PROJECT_ID,
                                kind: "Guidance",
                                scope: "project",
                                projectId: PROJECT_ID,
                                scopePath: "",
                                displayName: "Project guidance",
                                displayDescription: "",
                                currentVersionId: VERSION_ID,
                                currentRevision: 1,
                                currentFingerprint: "a".repeat(64),
                                currentVersionStatus: "complete",
                                deleted: false,
                                createdAt: 1,
                                updatedAt: 2,
                            },
                        ],
                    },
                    diagnostics: [
                        {
                            severity: "warning",
                            code: "asset.warning",
                            message: "warning",
                            path: "/visible",
                            traceId: "trace",
                            operation: "asset",
                            causeKind: "partial",
                            retryable: true,
                            suggestedActions: ["retry"],
                        },
                    ],
                },
            },
        ]);
        expect(listAssets).toHaveBeenCalledWith({ includeDeleted: true });
    });

    it("preserves partial and failed Core outcomes without inventing a value", async () => {
        const outcomes = [
            {
                status: "partial" as const,
                value: [assetSummary()],
                diagnostics: [],
            },
            {
                status: "failed" as const,
                value: [] as ReturnType<typeof assetSummary>[],
                diagnostics: [
                    {
                        severity: "error" as const,
                        code: "asset.failed",
                        message: "failed",
                        path: "",
                        traceId: "",
                        operation: "asset" as const,
                        causeKind: "unavailable" as const,
                        retryable: false,
                        suggestedActions: [],
                        rawSummary: "private",
                    },
                ],
            },
        ];
        const runtime = host(fakeCore(() => outcomes.shift() as (typeof outcomes)[number]));
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive({ id: "request-2", method: "asset.list", params: {} });
        connection.receive({ id: "request-3", method: "asset.list", params: {} });
        await flushHost();

        expect(sink.messages.slice(1)).toEqual([
            {
                id: "request-2",
                result: {
                    status: "partial",
                    value: {
                        assets: [
                            {
                                assetId: ASSET_ID,
                                kind: "Guidance",
                                scope: "global",
                                scopePath: "",
                                displayName: "Guidance",
                                displayDescription: "",
                                currentVersionId: VERSION_ID,
                                currentRevision: 1,
                                currentFingerprint: "a".repeat(64),
                                currentVersionStatus: "complete",
                                deleted: false,
                                createdAt: 1,
                                updatedAt: 2,
                            },
                        ],
                    },
                    diagnostics: [],
                },
            },
            {
                id: "request-3",
                result: {
                    status: "failed",
                    diagnostics: [
                        {
                            severity: "error",
                            code: "asset.failed",
                            message: "failed",
                            operation: "asset",
                            causeKind: "unavailable",
                            retryable: false,
                            suggestedActions: [],
                        },
                    ],
                },
            },
        ]);
    });

    it("converts an unexpected Core throw to a trustworthy Host-owned failed outcome", async () => {
        const runtime = host(
            fakeCore(() => {
                throw new Error("secret stack");
            }),
        );
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive({ id: "request-2", method: "asset.list", params: {} });
        await flushHost();

        expect(sink.messages[1]).toEqual({
            id: "request-2",
            result: {
                status: "failed",
                diagnostics: [
                    {
                        severity: "error",
                        code: "host.core_invocation_failed",
                        operation: "host",
                        causeKind: "internal_error",
                        retryable: false,
                        suggestedActions: ["contact_support"],
                        message: "The Host could not produce a trustworthy Core result.",
                    },
                ],
            },
        });
        expect(JSON.stringify(sink.messages)).not.toContain("secret stack");
    });

    it.each([
        {
            name: "invalid envelope with a trusted id",
            request: { id: "bad-1", method: "initialize", params: {}, extra: true },
            code: "protocol.invalid_envelope",
        },
        {
            name: "unknown method",
            request: { id: "bad-2", method: "unknown.method", params: {} },
            code: "protocol.unknown_method",
        },
        {
            name: "non-string method",
            request: { id: "bad-2b", method: 2, params: {} },
            code: "protocol.unknown_method",
        },
        {
            name: "request before initialization",
            request: { id: "bad-3", method: "asset.list", params: {} },
            code: "protocol.not_initialized",
        },
        {
            name: "incompatible initialization",
            request: {
                id: "bad-4",
                method: "initialize",
                params: { protocolVersion: 2, clientKind: "headless", clientVersion: "1" },
            },
            code: "protocol.incompatible_version",
        },
        {
            name: "initialization without an object parameter",
            request: { id: "bad-4b", method: "initialize", params: null },
            code: "protocol.incompatible_version",
        },
        {
            name: "invalid strict parameters",
            request: {
                id: "bad-5",
                method: "initialize",
                params: { protocolVersion: 1, clientKind: "headless", clientVersion: "1", extra: true },
            },
            code: "protocol.invalid_params",
        },
    ])("rejects $name before calling Core", async ({ request, code }) => {
        const listAssets = vi.fn(() => ({ status: "complete" as const, value: [], diagnostics: [] }));
        const runtime = host(fakeCore(listAssets));
        const sink = recordingSink();
        runtime.openConnection(sink).receive(request);
        await flushHost();

        expect(sink.messages).toHaveLength(1);
        expect(sink.messages[0]).toMatchObject({ id: request.id, error: { code } });
        expect(listAssets).not.toHaveBeenCalled();
    });

    it("closes without a fabricated response when no trustworthy request id exists", async () => {
        const nullSink = recordingSink();
        const nullConnection = host().openConnection(nullSink);
        nullConnection.receive(null);
        await flushHost();

        expect(nullSink.messages).toEqual([]);
        expect(nullSink.closeReasons).toEqual(["Protocol request has no trustworthy id"]);
        nullConnection.receive(initializeRequest());
        nullConnection.close();
        expect(nullSink.closeReasons).toHaveLength(1);

        const numericSink = recordingSink();
        host().openConnection(numericSink).receive({ id: 1, method: "initialize", params: {} });
        await flushHost();
        expect(numericSink.messages).toEqual([]);
        expect(numericSink.closeReasons).toEqual(["Protocol request has no trustworthy id"]);
    });

    it("does not process a queued request after the connection is closed locally", async () => {
        const sink = recordingSink();
        const connection = host().openConnection(sink);
        connection.receive(initializeRequest());
        connection.close();
        await flushHost();

        expect(sink.messages).toEqual([]);
        expect(sink.closeReasons).toEqual(["Host connection closed locally"]);
    });

    it("closes when request inspection throws before a trustworthy strict result exists", async () => {
        const sink = recordingSink();
        const connection = host().openConnection(sink);
        const hostileMessage = new Proxy(
            { id: "hostile", method: "initialize", params: {} },
            {
                ownKeys() {
                    throw new Error("hostile object");
                },
            },
        );

        connection.receive(hostileMessage);
        await flushHost();

        expect(sink.messages).toEqual([]);
        expect(sink.closeReasons).toEqual(["Host connection failed"]);
    });

    it("closes when a non-JSON parameter object throws during strict parsing", async () => {
        const sink = recordingSink();
        const connection = host().openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive({
            id: "request-2",
            method: "asset.list",
            params: new Proxy(
                {},
                {
                    ownKeys() {
                        throw new Error("hostile parameter");
                    },
                },
            ),
        });
        await flushHost();

        expect(sink.messages).toHaveLength(1);
        expect(sink.closeReasons).toEqual(["Host connection failed"]);
    });

    it("rejects a repeated initialize and a known but unavailable operation", async () => {
        const sink = recordingSink();
        const runtime = new ProductionHostRuntime(
            "host-1",
            fakeCore(),
            testStateResilienceIntegration(),
            { createConnectionId: () => "connection-1" },
            HOST_H1_OPERATIONS,
        );
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive(initializeRequest("request-2"));
        connection.receive({
            id: "request-3",
            method: "project.register",
            params: { localPathSelectionToken: "selection" },
        });
        await flushHost();

        expect(sink.messages.slice(1)).toEqual([
            {
                id: "request-2",
                error: {
                    code: "protocol.invalid_params",
                    message: "This connection is already initialized.",
                },
            },
            {
                id: "request-3",
                error: {
                    code: "protocol.unknown_method",
                    message: "Operation is not installed by this Host.",
                },
            },
        ]);
    });

    it("routes an advertised H2 operation and reports a missing path token as an operation outcome", async () => {
        const runtime = new ProductionHostRuntime(
            "host-1",
            fakeCore(),
            testStateResilienceIntegration(),
            { createConnectionId: () => "connection-1" },
            ["initialize", "project.register"],
        );
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive({
            id: "request-2",
            method: "project.register",
            params: { localPathSelectionToken: "selection" },
        });
        await flushHost();

        expect(sink.messages[1]).toEqual({
            id: "request-2",
            result: {
                status: "failed",
                diagnostics: [
                    {
                        severity: "error",
                        code: "host.path_selection_unavailable",
                        operation: "host",
                        causeKind: "unavailable",
                        retryable: false,
                        suggestedActions: ["choose_target"],
                        message: "The one-shot trusted-launcher path selection is unavailable or has the wrong kind.",
                    },
                ],
            },
        });
        connection.close();
        expect(() => connection.registerLocalPathSelection("source_root", "/source")).toThrow(/closed/u);
    });

    it("rejects duplicate request ids and then closes the ambiguous connection", async () => {
        const sink = recordingSink();
        const connection = host().openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive({ id: "request-1", method: "asset.list", params: {} });
        await flushHost();

        expect(sink.messages[1]).toMatchObject({
            id: "request-1",
            error: { code: "protocol.duplicate_id" },
        });
        expect(sink.closeReasons).toEqual(["Protocol request id was duplicated"]);
    });

    it("closes on outbound transport failure and tolerates a throwing close callback", async () => {
        const sink = recordingSink({ throwSend: true, throwClose: true });
        const connection = host().openConnection(sink);
        connection.receive(initializeRequest());
        await flushHost();

        expect(sink.messages).toEqual([]);
        expect(sink.closeReasons).toEqual(["Host response transport failed"]);
        connection.receive(initializeRequest("ignored"));
        connection.close();
    });

    it("acknowledges a long operation before its terminal event and replays the retained event", async () => {
        const reindexAssets = vi.fn(() => ({
            status: "complete" as const,
            value: { scannedAssets: 1, indexedAssets: 1, skippedAssets: 0, diagnostics: [] },
            diagnostics: [],
        }));
        const operational = recordingOperationalDiagnostics();
        const runtime = new ProductionHostRuntime(
            "host-long-operation",
            fakeCoreWith({ reindexAssets }),
            testStateResilienceIntegration(),
            {
                createConnectionId: () => "connection-long-operation",
                createOperationId: () => "operation-1",
                operationalDiagnostics: operational.diagnostics,
            },
        );
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive({ id: "request-2", method: "asset.reindex", params: {} });
        await flushHost();
        await flushHost();

        expect(sink.messages.slice(1, 3)).toEqual([
            { id: "request-2", result: { operationId: "operation-1" } },
            {
                method: "operation.terminal",
                params: {
                    operationId: "operation-1",
                    sequence: 1,
                    operation: "asset.reindex",
                    outcome: {
                        status: "complete",
                        value: {
                            scannedAssets: 1,
                            indexedAssets: 1,
                            skippedAssets: 0,
                            diagnostics: [],
                        },
                        diagnostics: [],
                    },
                },
            },
        ]);
        connection.receive({
            id: "request-3",
            method: "operation.observe",
            params: { operationId: "operation-1", afterSequence: 0 },
        });
        connection.receive({
            id: "request-4",
            method: "operation.cancel",
            params: { operationId: "operation-1" },
        });
        connection.receive({
            id: "request-5",
            method: "operation.cancel",
            params: { operationId: "missing" },
        });
        await flushHost();
        expect(sink.messages[3]).toMatchObject({
            id: "request-3",
            result: {
                status: "available",
                events: [{ eventKind: "terminal", operationId: "operation-1", sequence: 1 }],
            },
        });
        expect(sink.messages[4]).toEqual({ id: "request-4", result: { status: "not_cancellable" } });
        expect(sink.messages[5]).toEqual({ id: "request-5", result: { status: "operation_unavailable" } });
        expect(reindexAssets).toHaveBeenCalledTimes(1);
        expect(operational.record.mock.calls.map(([input]) => input)).toContainEqual({
            source: "protocol",
            code: "protocol.request.terminal",
            operation: "asset.reindex",
            status: "complete",
            diagnosticCodes: [],
            operationId: "operation-1",
        });
        await runtime.shutdown();
    });

    it("preserves the Core Windows runtime-target block as a blocked deployment terminal outcome", async () => {
        const blockedDeployment = {
            deploymentId: VERSION_ID,
            projectId: PROJECT_ID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            platform: "win32",
            platformInstanceId: "desktop-local",
            targetRootPath: "C:\\oaam-project",
            observationState: "complete",
            observationAttemptedAt: 2,
            lastCompleteObservationAt: 2,
            deleted: false,
            derivedStatus: {
                stage: "blocked",
                reason: "blocked_by_deploy_target_unavailable",
                actionHints: ["review_deployment"],
            },
            assets: [],
            createdAt: 1,
            updatedAt: 2,
        } as DeploymentView;
        const deployDeployment = vi.fn(async () => ({
            status: "complete" as const,
            value: blockedDeployment,
            diagnostics: [],
        }));
        const previewDeploymentRender = vi.fn(async () => ({
            status: "complete" as const,
            value: {
                schemaVersion: 3,
                deploymentId: VERSION_ID,
                renderInputFingerprint: `sha256:${"a".repeat(64)}`,
                selectionFingerprint: `sha256:${"b".repeat(64)}`,
                compilationFingerprint: `sha256:${"c".repeat(64)}`,
                previewFingerprint: `sha256:${"d".repeat(64)}`,
                replacementScope: { filePaths: [], directoryPaths: [] },
                actionState: "ready_apply",
                files: [],
                directories: [],
            } as DeploymentRenderPreviewView,
            diagnostics: [],
        }));
        const sink = recordingSink();
        const connection = host(fakeCoreWith({ deployDeployment, previewDeploymentRender })).openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive({
            id: "request-2",
            method: "deployment.render_preview",
            params: {
                deploymentId: VERSION_ID,
                selection: {
                    schemaVersion: 1,
                    renderInputFingerprint: "a".repeat(64),
                    semanticOptions: [],
                },
            },
        });
        await flushHost();
        await flushHost();
        const previewTerminal = sink.messages.find(
            (message) =>
                "method" in message &&
                message.method === "operation.terminal" &&
                message.params.operation === "deployment.render_preview",
        );
        expect(previewTerminal).toBeDefined();
        const previewToken = (
            previewTerminal as {
                params: { outcome: { status: "complete"; value: { previewToken: string } } };
            }
        ).params.outcome.value.previewToken;
        connection.receive({
            id: "request-3",
            method: "deployment.deploy",
            params: { previewToken, deploymentAction: "apply" },
        });
        await flushHost();
        await flushHost();

        expect(sink.messages).toContainEqual({ id: "request-3", result: { operationId: "operation-2" } });
        expect(sink.messages).toContainEqual({
            method: "operation.terminal",
            params: {
                operationId: "operation-2",
                sequence: 1,
                operation: "deployment.deploy",
                outcome: {
                    status: "complete",
                    value: {
                        deploymentId: VERSION_ID,
                        subject: { subjectKind: "project", projectId: PROJECT_ID },
                        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
                        environment: { platform: "win32", platformInstanceId: "desktop-local" },
                        targetRootPath: "C:\\oaam-project",
                        stage: "blocked",
                        reason: "blocked_by_deploy_target_unavailable",
                        actionHints: ["review_deployment"],
                        freshness: { state: "complete", attemptedAt: 2, lastCompleteAt: 2 },
                        deleted: false,
                        assets: [],
                        createdAt: 1,
                        updatedAt: 2,
                    },
                    diagnostics: [],
                },
            },
        });
        expect(previewDeploymentRender).toHaveBeenCalledWith({
            deploymentId: VERSION_ID,
            selectionRequest: {
                schemaVersion: 1,
                renderInputFingerprint: `sha256:${"a".repeat(64)}`,
                semanticOptions: [],
            },
        });
        expect(deployDeployment).toHaveBeenCalledWith({
            deploymentId: VERSION_ID,
            selectionRequest: {
                schemaVersion: 1,
                renderInputFingerprint: `sha256:${"a".repeat(64)}`,
                semanticOptions: [],
            },
            deploymentAction: "apply",
            expectedPreviewFingerprint: `sha256:${"d".repeat(64)}`,
        });
    });

    it("does not start accepted-long Core work when the acknowledgement cannot be delivered", async () => {
        const reindexAssets = vi.fn(() => ({
            status: "complete" as const,
            value: { scannedAssets: 0, indexedAssets: 0, skippedAssets: 0, diagnostics: [] },
            diagnostics: [],
        }));
        const messages: unknown[] = [];
        let sends = 0;
        const sink = {
            send(message: Parameters<ReturnType<typeof recordingSink>["send"]>[0]) {
                sends += 1;
                if (sends === 2) throw new Error("ack failed");
                messages.push(message);
            },
            close() {
                // Observed through the absent Core call.
            },
        };
        const connection = host(fakeCoreWith({ reindexAssets })).openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive({ id: "request-2", method: "asset.reindex", params: {} });
        await flushHost();
        await flushHost();

        expect(messages).toHaveLength(1);
        expect(reindexAssets).not.toHaveBeenCalled();
    });

    it("retains a long result after its originating connection closes without writing to the closed sink", async () => {
        let release: (() => void) | undefined;
        const scanDeployment = vi.fn(
            () =>
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
                        } as never);
                }),
        );
        const sink = recordingSink();
        const connection = host(fakeCoreWith({ scanDeployment: scanDeployment as never })).openConnection(sink);
        connection.receive(initializeRequest());
        connection.receive({
            id: "request-2",
            method: "deployment.scan",
            params: { deploymentId: VERSION_ID },
        });
        await flushHost();
        expect(sink.messages).toHaveLength(2);
        connection.close();
        release?.();
        await flushHost();
        expect(sink.messages).toHaveLength(2);
    });
});
