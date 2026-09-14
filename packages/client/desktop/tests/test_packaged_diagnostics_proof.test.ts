import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { ClientConnectionApi, createClientConnection } from "@oaam/client-framework";
import { describe, expect, it, vi } from "vitest";
import { PACKAGED_DIAGNOSTICS_PROOF_PORT_SIGNAL } from "../src/bridge/desktop-bridge";
import {
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
    type DesktopPreferencesV4,
} from "../src/presentation/presentation-preferences";
import type { DesktopApplicationClientApi } from "../src/renderer/client/desktop-application-client";
import { type BrowserProtocolPort, MessagePortClientTransport } from "../src/renderer/client/message-port-transport";
import {
    installPackagedDiagnosticsProofListener,
    provePackagedDiagnostics,
    runPackagedDiagnosticsProof,
} from "../src/renderer/client/packaged-diagnostics-proof";

const PROJECT_ID = "12345678-1234-4123-8123-123456789abc";
const DIGEST = "a".repeat(64);
const AVAILABLE_OPERATIONS = Object.freeze([
    "diagnostics.health.get",
    "diagnostics.ordinary_log.settings.get",
    "diagnostics.ordinary_log.settings.replace",
    "diagnostics.ordinary_log.clear",
    "diagnostics.support_bundle.inspect",
    "diagnostics.support_bundle.export",
] as const satisfies readonly ProtocolOperationName[]);
const SETTINGS = Object.freeze({
    schemaVersion: 1 as const,
    enabled: true,
    retentionDays: 3,
    maximumBytes: 2 * 1024 * 1024,
});
const HEALTH = Object.freeze({
    schemaVersion: 1 as const,
    overallStatus: "healthy" as const,
    host: { lifecycleState: "ready" as const, startupMode: "normal" as const },
    ordinaryLog: {
        state: "active" as const,
        suspensionReason: "none" as const,
        retainedBytes: 512,
        maximumBytes: SETTINGS.maximumBytes,
        segmentCount: 1,
    },
});
const STANDARD_REVIEW = Object.freeze({
    schemaVersion: 1 as const,
    supportBundleReviewToken: "standard-review",
    mode: "standard" as const,
    createdAt: 10,
    archiveByteLength: 2048,
    archiveContentHash: DIGEST,
    entries: [
        { archivePath: "README.txt", category: "documentation" as const, byteLength: 10 },
        { archivePath: "diagnostics/adapters.json", category: "adapter_capabilities" as const, byteLength: 10 },
        { archivePath: "diagnostics/health.json", category: "health" as const, byteLength: 10 },
        { archivePath: "diagnostics/ordinary-log.jsonl", category: "ordinary_log" as const, byteLength: 10 },
        { archivePath: "diagnostics/product.json", category: "product" as const, byteLength: 10 },
        { archivePath: "manifest.json", category: "manifest" as const, byteLength: 10 },
    ],
    ordinaryLog: {
        retainedSegmentCount: 1,
        includedSegmentCount: 1,
        retainedBytes: 10,
        includedBytes: 10,
        truncated: false,
    },
});
const EXTENDED_REVIEW = Object.freeze({
    ...STANDARD_REVIEW,
    supportBundleReviewToken: "extended-review",
    mode: "extended" as const,
    entries: Object.freeze([
        ...STANDARD_REVIEW.entries,
        { archivePath: "diagnostics/locations.json", category: "local_paths" as const, byteLength: 10 },
    ]),
});
const COMPLETE_EXPORT = Object.freeze({
    status: "complete" as const,
    value: {
        schemaVersion: 1 as const,
        mode: "standard" as const,
        createdAt: 10,
        archiveByteLength: 2048,
        archiveContentHash: DIGEST,
        entryCount: 6,
    },
    diagnostics: [],
});

type FailurePoint =
    | "health"
    | "log_settings_get"
    | "log_settings_replace"
    | "support_standard_review"
    | "support_standard_export"
    | "support_extended_review"
    | "support_existing_destination"
    | "log_clear"
    | "maintenance"
    | "interface_cache"
    | "interface_configure"
    | "interface_reset"
    | "performance_start"
    | "performance_stop"
    | "performance_discard"
    | "final_health";

function complete<T>(value: T) {
    return { status: "complete" as const, value, diagnostics: [] };
}

function failed(code: string) {
    return {
        status: "failed" as const,
        diagnostics: [{ severity: "error" as const, code, message: code }],
    };
}

function fixture(failAt?: FailurePoint) {
    let healthCalls = 0;
    let inspectCalls = 0;
    let exportCalls = 0;
    const getDiagnosticsHealth = vi.fn(async () => {
        healthCalls += 1;
        if (failAt === "health" && healthCalls === 1) return complete({ ...HEALTH, overallStatus: "degraded" as const });
        if (failAt === "final_health" && healthCalls === 2) {
            return complete({ ...HEALTH, ordinaryLog: { ...HEALTH.ordinaryLog, maximumBytes: 1 } });
        }
        return complete(HEALTH);
    });
    const getOrdinaryLogSettings = vi.fn(async () =>
        failAt === "log_settings_get" ? failed("diagnostics.settings_failed") : complete(SETTINGS),
    );
    const replaceOrdinaryLogSettings = vi.fn(async () =>
        failAt === "log_settings_replace" ? complete({ ...SETTINGS, retentionDays: 4 }) : complete(SETTINGS),
    );
    const inspectSupportBundle = vi.fn(async () => {
        inspectCalls += 1;
        if (inspectCalls === 1) {
            return failAt === "support_standard_review"
                ? complete({ ...STANDARD_REVIEW, mode: "extended" as const })
                : complete(STANDARD_REVIEW);
        }
        return failAt === "support_extended_review"
            ? complete({ ...EXTENDED_REVIEW, entries: STANDARD_REVIEW.entries })
            : complete(EXTENDED_REVIEW);
    });
    const exportSupportBundle = vi.fn(async () => {
        exportCalls += 1;
        if (exportCalls === 1) {
            return failAt === "support_standard_export" ? failed("support.export_failed") : COMPLETE_EXPORT;
        }
        return failAt === "support_existing_destination" ? COMPLETE_EXPORT : failed("host.core_invocation_failed");
    });
    const clearOrdinaryLog = vi.fn(async () =>
        failAt === "log_clear"
            ? complete({ removedSegmentCount: 0, removedBytes: 0, settings: SETTINGS })
            : complete({ removedSegmentCount: 1, removedBytes: 512, settings: SETTINGS }),
    );
    const client = {
        availableOperations: AVAILABLE_OPERATIONS,
        supportsOperation: (operation: ProtocolOperationName) => AVAILABLE_OPERATIONS.includes(operation as never),
        getDiagnosticsHealth,
        getOrdinaryLogSettings,
        replaceOrdinaryLogSettings,
        inspectSupportBundle,
        exportSupportBundle,
        clearOrdinaryLog,
    } as unknown as DesktopApplicationClientApi;

    let preferences: DesktopPreferencesV4 = {
        ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
        onboardingCompleted: false,
    };
    const listeners = new Set<(snapshot: { readonly preferences: typeof preferences }) => void>();
    const snapshot = () => ({ preferences: { ...preferences } });
    const bridge = {
        getDesktopMaintenance: vi.fn(async () => ({
            interfaceCache: { status: "available" as const, byteSize: 1024 },
            dataLocations: Array.from({ length: failAt === "maintenance" ? 4 : 5 }, (_, index) => ({
                locationId: `location-${String(index)}`,
                status: "available" as const,
                displayPath: `C:\\proof\\${String(index)}`,
            })),
        })),
        clearDesktopInterfaceCache: vi.fn(async () =>
            failAt === "interface_cache"
                ? { status: "failed" as const, code: "clear_failed" as const, interfaceCache: { status: "unavailable" as const } }
                : { status: "complete" as const, interfaceCache: { status: "available" as const, byteSize: 0 } },
        ),
        completeOnboarding: vi.fn(async () => {
            preferences = { ...preferences, onboardingCompleted: true };
            return snapshot();
        }),
        replacePresentationPreferences: vi.fn(async (input) => {
            preferences = { ...preferences, ...input };
            return snapshot();
        }),
        replaceAssetLayout: vi.fn(async (assetLayout) => {
            preferences = { ...preferences, assetLayout };
            return snapshot();
        }),
        rememberLastProject: vi.fn(async () => {
            preferences =
                failAt === "interface_configure"
                    ? { ...preferences }
                    : {
                          ...preferences,
                          lastSelectedProjectId: PROJECT_ID,
                      };
            return snapshot();
        }),
        subscribePresentation: vi.fn((listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }),
        restoreDesktopInterfaceDefaults: vi.fn(async () => {
            preferences = {
                ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
                onboardingCompleted: true,
                lastSelectedProjectId: PROJECT_ID,
            };
            for (const listener of listeners) listener(snapshot());
            return failAt === "interface_reset"
                ? { status: "partial" as const, presentation: "complete" as const, windowState: "failed" as const }
                : { status: "complete" as const, presentation: "complete" as const, windowState: "complete" as const };
        }),
        startDesktopPerformanceRecording: vi.fn(async () =>
            failAt === "performance_start"
                ? { state: "idle" as const }
                : {
                      state: "recording" as const,
                      startedAt: 1,
                      deadlineAt: 2,
                      maximumBufferBytes: (100 * 1024 * 1024) as 104857600,
                  },
        ),
        stopDesktopPerformanceRecording: vi.fn(async () =>
            failAt === "performance_stop"
                ? { state: "idle" as const }
                : { state: "ready" as const, stoppedAt: 2, expiresAt: 3, byteSize: 512 },
        ),
        discardDesktopPerformanceRecording: vi.fn(async () =>
            failAt === "performance_discard"
                ? { state: "failed" as const, code: "cleanup_failed" as const, mayStillBeRecording: false }
                : { state: "idle" as const },
        ),
    } as unknown as Parameters<typeof provePackagedDiagnostics>[1];
    return { client, bridge };
}

function operation(terminal: unknown) {
    return {
        operationId: "operation",
        operation: "fixture",
        terminal: Promise.resolve(terminal),
        terminalSequence: null,
        subscribeProgress: () => () => undefined,
    };
}

function connectionFrom(client: DesktopApplicationClientApi, protocolVersion = 1): ClientConnectionApi {
    const request = vi.fn(async (method: string, params: unknown) => {
        const names: Record<string, keyof DesktopApplicationClientApi> = {
            "diagnostics.health.get": "getDiagnosticsHealth",
            "diagnostics.ordinary_log.settings.get": "getOrdinaryLogSettings",
            "diagnostics.ordinary_log.settings.replace": "replaceOrdinaryLogSettings",
            "diagnostics.ordinary_log.clear": "clearOrdinaryLog",
        };
        const member = client[names[method] as keyof DesktopApplicationClientApi] as (input?: unknown) => unknown;
        return member.call(client, params);
    });
    const start = vi.fn(async (method: string, params: unknown) => {
        const names: Record<string, keyof DesktopApplicationClientApi> = {
            "diagnostics.support_bundle.inspect": "inspectSupportBundle",
            "diagnostics.support_bundle.export": "exportSupportBundle",
        };
        const member = client[names[method] as keyof DesktopApplicationClientApi] as (input: unknown) => unknown;
        return operation(await member.call(client, params));
    });
    return {
        availableOperations: AVAILABLE_OPERATIONS,
        initialize: vi.fn(async () => ({ protocolVersion, availableOperations: AVAILABLE_OPERATIONS })),
        request,
        start,
        close: vi.fn(),
    } as unknown as ClientConnectionApi;
}

function browserPort(
    existingSupportBundleToken = "existing-token",
    controlFailure?: "malformed_reply" | "closed_before_reply" | "post_failed",
): BrowserProtocolPort {
    const listeners = new Map<string, Set<(event: Event | MessageEvent<unknown>) => void>>();
    const postMessage = vi.fn((message: unknown) => {
        if (
            message !== null &&
            typeof message === "object" &&
            "control" in message &&
            message.control === "request_existing_support_bundle_token"
        ) {
            if (controlFailure === "post_failed") throw new Error("control post failed");
            const eventName = controlFailure === "closed_before_reply" ? "close" : "message";
            const event =
                controlFailure === "malformed_reply"
                    ? ({ data: { control: "unexpected" } } as MessageEvent<unknown>)
                    : controlFailure === "closed_before_reply"
                      ? new Event("close")
                      : ({
                            data: {
                                control: "existing_support_bundle_token",
                                existingSupportBundleToken: existingSupportBundleToken,
                            },
                        } as MessageEvent<unknown>);
            queueMicrotask(() => {
                for (const listener of listeners.get(eventName) ?? []) listener(event);
            });
        }
    });
    return {
        postMessage,
        start: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn((type: string, listener: (event: Event | MessageEvent<unknown>) => void) => {
            const registered = listeners.get(type) ?? new Set();
            registered.add(listener);
            listeners.set(type, registered);
        }) as BrowserProtocolPort["addEventListener"],
        removeEventListener: vi.fn((type: string, listener: (event: Event | MessageEvent<unknown>) => void) => {
            listeners.get(type)?.delete(listener);
        }) as BrowserProtocolPort["removeEventListener"],
    };
}

describe("packaged diagnostics renderer proof", () => {
    it("proves health, logs, both support modes, cache, reset and performance", async () => {
        const value = fixture();
        await expect(
            provePackagedDiagnostics(
                value.client,
                value.bridge,
                { supportBundleExportToken: "support-token" },
                async () => "existing-token",
                () => "user-action",
            ),
        ).resolves.toBeUndefined();
    });

    it.each([
        "health",
        "log_settings_get",
        "log_settings_replace",
        "support_standard_review",
        "support_standard_export",
        "support_extended_review",
        "support_existing_destination",
        "log_clear",
        "maintenance",
        "interface_cache",
        "interface_configure",
        "interface_reset",
        "performance_start",
        "performance_stop",
        "performance_discard",
        "final_health",
    ] as const)("fails closed at %s", async (failurePoint) => {
        const value = fixture(failurePoint);
        await expect(
            provePackagedDiagnostics(
                value.client,
                value.bridge,
                { supportBundleExportToken: "support-token" },
                async () => "existing-token",
                () => "action",
            ),
        ).rejects.toThrow(
            new RegExp(
                failurePoint.replace("_get", "").replace("_replace", "").replace("interface_configure", "interface_reset"),
                "u",
            ),
        );
    });

    it("requires the exact operation set, protocol version and clean listener delivery", async () => {
        const value = fixture();
        const connection = connectionFrom(value.client);
        const factory = vi.fn((transport) => {
            expect(transport).toBeInstanceOf(MessagePortClientTransport);
            return connection;
        }) as unknown as typeof createClientConnection;
        await expect(
            runPackagedDiagnosticsProof(
                browserPort(),
                value.bridge,
                { supportBundleExportToken: "support-token" },
                async () => "existing-token",
                factory,
                () => "request",
            ),
        ).resolves.toBeUndefined();
        expect(connection.close).toHaveBeenCalledOnce();

        const wrongVersion = connectionFrom(fixture().client, 2);
        await expect(
            runPackagedDiagnosticsProof(
                browserPort(),
                fixture().bridge,
                { supportBundleExportToken: "support-token" },
                async () => "existing-token",
                vi.fn(() => wrongVersion) as unknown as typeof createClientConnection,
                () => "request",
            ),
        ).rejects.toThrow(/initialize/u);

        const missingOperation = connectionFrom(fixture().client);
        missingOperation.initialize = vi.fn(async () => ({
            protocolVersion: 1,
            availableOperations: ["diagnostics.health.get"] as ProtocolOperationName[],
        }));
        await expect(
            runPackagedDiagnosticsProof(
                browserPort(),
                fixture().bridge,
                { supportBundleExportToken: "support-token" },
                async () => "existing-token",
                vi.fn(() => missingOperation) as unknown as typeof createClientConnection,
                () => "request",
            ),
        ).rejects.toThrow(/available_operations/u);

        const listenerConnection = connectionFrom(fixture().client);
        const listenerFactory = vi.fn((_transport, options) => {
            options.reportListenerError(new Error("listener failed"));
            return listenerConnection;
        }) as unknown as typeof createClientConnection;
        await expect(
            runPackagedDiagnosticsProof(
                browserPort(),
                fixture().bridge,
                { supportBundleExportToken: "support-token" },
                async () => "existing-token",
                listenerFactory,
                () => "request",
            ),
        ).rejects.toThrow(/client_listener/u);
    });

    it("routes only the exact renderer signal and reports typed success or failure", async () => {
        const listeners: Array<(event: MessageEvent<unknown>) => void> = [];
        const browserWindow = {
            addEventListener: vi.fn((_type: string, listener: (event: MessageEvent<unknown>) => void) =>
                listeners.push(listener),
            ),
            removeEventListener: vi.fn(),
        } as unknown as Window;
        const factory = vi
            .fn()
            .mockReturnValueOnce(connectionFrom(fixture().client))
            .mockReturnValueOnce(connectionFrom(fixture("health").client)) as unknown as typeof createClientConnection;
        const dispose = installPackagedDiagnosticsProofListener(browserWindow, fixture().bridge, factory, () => "request");
        const receive = listeners[0];
        if (receive === undefined) throw new Error("listener was not installed");

        receive({ source: {}, data: { signal: PACKAGED_DIAGNOSTICS_PROOF_PORT_SIGNAL }, ports: [] } as unknown as MessageEvent);
        receive({ source: browserWindow, data: null, ports: [] } as unknown as MessageEvent);
        receive({ source: browserWindow, data: { signal: "other" }, ports: [] } as unknown as MessageEvent);

        const invalidPorts = [browserPort(), browserPort(), browserPort()];
        receive({
            source: browserWindow,
            data: { signal: PACKAGED_DIAGNOSTICS_PROOF_PORT_SIGNAL },
            ports: invalidPorts as unknown as MessagePort[],
        } as unknown as MessageEvent);
        for (const port of invalidPorts) expect(port.close).toHaveBeenCalledOnce();

        const malformedResult = browserPort();
        receive({
            source: browserWindow,
            data: { signal: PACKAGED_DIAGNOSTICS_PROOF_PORT_SIGNAL, request: { supportBundleExportToken: "" } },
            ports: [browserPort() as MessagePort, malformedResult as MessagePort],
        } as unknown as MessageEvent);
        await vi.waitFor(() =>
            expect(malformedResult.postMessage).toHaveBeenCalledWith({
                status: "failed",
                step: "unexpected",
                diagnosticCodes: [],
            }),
        );

        const successResult = browserPort();
        receive({
            source: browserWindow,
            data: {
                signal: PACKAGED_DIAGNOSTICS_PROOF_PORT_SIGNAL,
                request: { supportBundleExportToken: "support-token" },
            },
            ports: [browserPort() as MessagePort, successResult as MessagePort],
        } as unknown as MessageEvent);
        await vi.waitFor(() => expect(successResult.postMessage).toHaveBeenCalledWith({ status: "complete" }));

        const failedResult = browserPort();
        receive({
            source: browserWindow,
            data: {
                signal: PACKAGED_DIAGNOSTICS_PROOF_PORT_SIGNAL,
                request: { supportBundleExportToken: "support-token" },
            },
            ports: [browserPort() as MessagePort, failedResult as MessagePort],
        } as unknown as MessageEvent);
        await vi.waitFor(() =>
            expect(failedResult.postMessage).toHaveBeenCalledWith({
                status: "failed",
                step: "health",
                diagnosticCodes: [],
            }),
        );
        dispose();
        expect(browserWindow.removeEventListener).toHaveBeenCalledOnce();
    });

    it.each([
        "malformed_reply",
        "closed_before_reply",
        "post_failed",
    ] as const)("fails closed when the one-shot support token control channel reports %s", async (controlFailure) => {
        const listeners: Array<(event: MessageEvent<unknown>) => void> = [];
        const browserWindow = {
            addEventListener: vi.fn((_type: string, listener: (event: MessageEvent<unknown>) => void) =>
                listeners.push(listener),
            ),
            removeEventListener: vi.fn(),
        } as unknown as Window;
        const resultPort = browserPort("existing-token", controlFailure);
        const dispose = installPackagedDiagnosticsProofListener(
            browserWindow,
            fixture().bridge,
            vi.fn(() => connectionFrom(fixture().client)) as unknown as typeof createClientConnection,
            () => "request",
        );
        const receive = listeners[0];
        if (receive === undefined) throw new Error("listener was not installed");
        receive({
            source: browserWindow,
            data: {
                signal: PACKAGED_DIAGNOSTICS_PROOF_PORT_SIGNAL,
                request: { supportBundleExportToken: "support-token" },
            },
            ports: [browserPort() as MessagePort, resultPort as MessagePort],
        } as unknown as MessageEvent);
        await vi.waitFor(() =>
            expect(resultPort.postMessage).toHaveBeenCalledWith({
                status: "failed",
                step: "unexpected",
                diagnosticCodes: [],
            }),
        );
        expect(resultPort.close).toHaveBeenCalledOnce();
        dispose();
    });
});
