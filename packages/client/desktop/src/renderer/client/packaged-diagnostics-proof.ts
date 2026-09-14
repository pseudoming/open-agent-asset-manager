import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import type { ClientConnectionApi, createClientConnection } from "@oaam/client-framework";
import {
    type OaamDesktopBridge,
    PACKAGED_DIAGNOSTICS_PROOF_PORT_SIGNAL,
    type PackagedDiagnosticsProofRequest,
    type PackagedDiagnosticsProofStep,
    parsePackagedDiagnosticsProofControlReply,
    parsePackagedDiagnosticsProofRequest,
} from "../../bridge/desktop-bridge";
import { DesktopApplicationClient, type DesktopApplicationClientApi } from "./desktop-application-client";
import { type BrowserProtocolPort, MessagePortClientTransport } from "./message-port-transport";

const PROOF_PROJECT_ID = "12345678-1234-4123-8123-123456789abc";
const PROOF_LOG_MAXIMUM_BYTES = 2 * 1024 * 1024;
const PROOF_LOG_RETENTION_DAYS = 3;

class PackagedDiagnosticsProofFailure extends Error {
    public readonly step: PackagedDiagnosticsProofStep;
    public readonly diagnosticCodes: readonly string[];

    public constructor(step: PackagedDiagnosticsProofStep, diagnosticCodes: readonly string[] = []) {
        super(`Packaged diagnostics proof failed at ${step}`);
        this.name = "PackagedDiagnosticsProofFailure";
        this.step = step;
        this.diagnosticCodes = diagnosticCodes;
    }
}

function diagnosticCodes(value: { readonly diagnostics: readonly { readonly code: string }[] }): readonly string[] {
    return Object.freeze(
        [...new Set(value.diagnostics.map(({ code }) => code).filter((code) => /^[a-z0-9_.-]{1,128}$/u.test(code)))]
            .sort()
            .slice(0, 8),
    );
}

function fail(step: PackagedDiagnosticsProofStep, value?: { readonly diagnostics: readonly { readonly code: string }[] }): never {
    throw new PackagedDiagnosticsProofFailure(step, value === undefined ? [] : diagnosticCodes(value));
}

async function initialize(connection: ClientConnectionApi): Promise<readonly ProtocolOperationName[]> {
    const initialized = await connection.initialize({ protocolVersion: 1, clientKind: "desktop", clientVersion: "0.1.0" });
    if (initialized.protocolVersion !== 1) fail("initialize");
    return initialized.availableOperations;
}

function requireOperations(availableOperations: readonly ProtocolOperationName[], required: readonly ProtocolOperationName[]) {
    const available = new Set(availableOperations);
    if (required.some((operation) => !available.has(operation))) fail("available_operations");
}

async function proveLogsAndSupport(
    client: DesktopApplicationClientApi,
    request: PackagedDiagnosticsProofRequest,
    requestExistingSupportBundleToken: () => Promise<string>,
    createUserActionId: () => string,
): Promise<void> {
    const health = await client.getDiagnosticsHealth();
    if (
        health.status !== "complete" ||
        health.value.overallStatus !== "healthy" ||
        health.value.ordinaryLog.state !== "active" ||
        health.value.ordinaryLog.retainedBytes <= 0
    ) {
        fail("health", health);
    }
    const initialSettings = await client.getOrdinaryLogSettings();
    if (initialSettings.status !== "complete") fail("log_settings", initialSettings);
    const settings = await client.replaceOrdinaryLogSettings({
        enabled: true,
        retentionDays: PROOF_LOG_RETENTION_DAYS,
        maximumBytes: PROOF_LOG_MAXIMUM_BYTES,
    });
    if (
        settings.status !== "complete" ||
        !settings.value.enabled ||
        settings.value.retentionDays !== PROOF_LOG_RETENTION_DAYS ||
        settings.value.maximumBytes !== PROOF_LOG_MAXIMUM_BYTES
    ) {
        fail("log_settings", settings);
    }

    const standard = await client.inspectSupportBundle({ mode: "standard" });
    if (
        standard.status !== "complete" ||
        standard.value.mode !== "standard" ||
        standard.value.entries.length !== 6 ||
        standard.value.ordinaryLog.includedBytes <= 0
    ) {
        fail("support_standard_review", standard);
    }
    const exported = await client.exportSupportBundle({
        supportBundleReviewToken: standard.value.supportBundleReviewToken,
        localPathSelectionToken: request.supportBundleExportToken,
        userActionId: createUserActionId(),
    });
    if (exported.status !== "complete" || exported.value.mode !== "standard" || exported.value.entryCount !== 6) {
        fail("support_standard_export", exported);
    }

    const extended = await client.inspectSupportBundle({ mode: "extended" });
    if (
        extended.status !== "complete" ||
        extended.value.mode !== "extended" ||
        extended.value.entries.length !== 7 ||
        !extended.value.entries.some(({ category }) => category === "local_paths")
    ) {
        fail("support_extended_review", extended);
    }
    const existingDestination = await client.exportSupportBundle({
        supportBundleReviewToken: extended.value.supportBundleReviewToken,
        localPathSelectionToken: await requestExistingSupportBundleToken(),
        userActionId: createUserActionId(),
    });
    if (
        existingDestination.status !== "failed" ||
        !existingDestination.diagnostics.some(({ code }) => code === "host.core_invocation_failed")
    ) {
        fail("support_existing_destination", existingDestination);
    }

    const cleared = await client.clearOrdinaryLog({ confirmedPermanentRemoval: true });
    if (cleared.status !== "complete" || cleared.value.removedSegmentCount <= 0 || cleared.value.removedBytes <= 0) {
        fail("log_clear", cleared);
    }
}

async function proveMaintenanceAndPerformance(
    bridge: Pick<
        OaamDesktopBridge,
        | "completeOnboarding"
        | "replacePresentationPreferences"
        | "rememberLastProject"
        | "replaceAssetLayout"
        | "subscribePresentation"
        | "getDesktopMaintenance"
        | "clearDesktopInterfaceCache"
        | "restoreDesktopInterfaceDefaults"
        | "startDesktopPerformanceRecording"
        | "stopDesktopPerformanceRecording"
        | "discardDesktopPerformanceRecording"
    >,
): Promise<void> {
    const maintenance = await bridge.getDesktopMaintenance();
    if (
        maintenance.dataLocations.length !== 5 ||
        maintenance.dataLocations.some(({ status }) => status !== "available") ||
        maintenance.interfaceCache.status !== "available"
    ) {
        fail("maintenance");
    }
    const cache = await bridge.clearDesktopInterfaceCache();
    if (cache.status !== "complete" || cache.interfaceCache.status !== "available") fail("interface_cache");

    await bridge.completeOnboarding();
    await bridge.replacePresentationPreferences({
        language: "ja",
        theme: "dark",
        textSize: "default",
        surfacePalette: "warm",
        leftPaneWidth: 288,
        rightPaneWidth: 336,
    });
    await bridge.replaceAssetLayout("cards");
    const configured = await bridge.rememberLastProject(PROOF_PROJECT_ID);
    if (
        !configured.preferences.onboardingCompleted ||
        configured.preferences.language !== "ja" ||
        configured.preferences.theme !== "dark" ||
        configured.preferences.assetLayout !== "cards" ||
        configured.preferences.lastSelectedProjectId !== PROOF_PROJECT_ID
    ) {
        fail("interface_reset");
    }
    let unsubscribe = (): void => undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanupResetListener = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        unsubscribe();
    };
    const restored = new Promise<void>((resolve, reject) => {
        unsubscribe = bridge.subscribePresentation((snapshot) => {
            if (
                snapshot.preferences.language !== "system" ||
                snapshot.preferences.theme !== "system" ||
                snapshot.preferences.assetLayout !== "list" ||
                !snapshot.preferences.onboardingCompleted ||
                snapshot.preferences.lastSelectedProjectId !== PROOF_PROJECT_ID
            ) {
                return;
            }
            cleanupResetListener();
            resolve();
        });
        timeout = setTimeout(() => {
            cleanupResetListener();
            reject(new PackagedDiagnosticsProofFailure("interface_reset"));
        }, 5_000);
    });
    let reset: Awaited<ReturnType<typeof bridge.restoreDesktopInterfaceDefaults>>;
    try {
        reset = await bridge.restoreDesktopInterfaceDefaults();
    } catch (error) {
        cleanupResetListener();
        throw error;
    }
    if (reset.status !== "complete" || reset.presentation !== "complete" || reset.windowState !== "complete") {
        cleanupResetListener();
        fail("interface_reset");
    }
    await restored;

    const recording = await bridge.startDesktopPerformanceRecording(true);
    if (recording.state !== "recording") fail("performance_start");
    const stopped = await bridge.stopDesktopPerformanceRecording();
    if (stopped.state !== "ready" || stopped.byteSize <= 0) fail("performance_stop");
    const discarded = await bridge.discardDesktopPerformanceRecording();
    if (discarded.state !== "idle") fail("performance_discard");
}

export async function provePackagedDiagnostics(
    client: DesktopApplicationClientApi,
    bridge: Parameters<typeof proveMaintenanceAndPerformance>[0],
    request: PackagedDiagnosticsProofRequest,
    requestExistingSupportBundleToken: () => Promise<string>,
    createUserActionId: () => string = () => globalThis.crypto.randomUUID(),
): Promise<void> {
    await proveLogsAndSupport(client, request, requestExistingSupportBundleToken, createUserActionId);
    await proveMaintenanceAndPerformance(bridge);
    const finalHealth = await client.getDiagnosticsHealth();
    if (
        finalHealth.status !== "complete" ||
        finalHealth.value.overallStatus !== "healthy" ||
        finalHealth.value.ordinaryLog.state !== "active" ||
        finalHealth.value.ordinaryLog.maximumBytes !== PROOF_LOG_MAXIMUM_BYTES
    ) {
        fail("final_health", finalHealth);
    }
}

export async function runPackagedDiagnosticsProof(
    port: BrowserProtocolPort,
    bridge: Parameters<typeof proveMaintenanceAndPerformance>[0],
    request: PackagedDiagnosticsProofRequest,
    requestExistingSupportBundleToken: () => Promise<string>,
    createConnection: typeof createClientConnection,
    createRequestId: () => string,
): Promise<void> {
    let listenerError: unknown;
    const connection = createConnection(new MessagePortClientTransport(port), {
        createRequestId,
        reportListenerError: (error) => {
            listenerError ??= error;
        },
    });
    try {
        const availableOperations = await initialize(connection);
        requireOperations(availableOperations, [
            "diagnostics.health.get",
            "diagnostics.ordinary_log.settings.get",
            "diagnostics.ordinary_log.settings.replace",
            "diagnostics.ordinary_log.clear",
            "diagnostics.support_bundle.inspect",
            "diagnostics.support_bundle.export",
        ]);
        await provePackagedDiagnostics(
            new DesktopApplicationClient(connection, availableOperations),
            bridge,
            request,
            requestExistingSupportBundleToken,
        );
        if (listenerError !== undefined) fail("client_listener");
    } finally {
        connection.close();
    }
}

export function installPackagedDiagnosticsProofListener(
    browserWindow: Window,
    bridge: Parameters<typeof proveMaintenanceAndPerformance>[0],
    createConnection: typeof createClientConnection,
    createRequestId: () => string,
): () => void {
    const receive = (event: MessageEvent<unknown>): void => {
        if (event.source !== browserWindow || event.data === null || typeof event.data !== "object") return;
        if ((event.data as { readonly signal?: unknown }).signal !== PACKAGED_DIAGNOSTICS_PROOF_PORT_SIGNAL) return;
        if (event.ports.length !== 2) {
            for (const port of event.ports) port.close();
            return;
        }
        const [protocolPort, resultPort] = event.ports;
        if (protocolPort === undefined || resultPort === undefined) return;
        void (async () => {
            try {
                const request = parsePackagedDiagnosticsProofRequest((event.data as { readonly request?: unknown }).request);
                await runPackagedDiagnosticsProof(
                    protocolPort as BrowserProtocolPort,
                    bridge,
                    request,
                    () => requestExistingSupportBundleToken(resultPort as BrowserProtocolPort),
                    createConnection,
                    createRequestId,
                );
                resultPort.postMessage(Object.freeze({ status: "complete" }));
            } catch (error) {
                resultPort.postMessage(
                    Object.freeze({
                        status: "failed",
                        step: error instanceof PackagedDiagnosticsProofFailure ? error.step : "unexpected",
                        diagnosticCodes: error instanceof PackagedDiagnosticsProofFailure ? error.diagnosticCodes : [],
                    }),
                );
            } finally {
                resultPort.close();
            }
        })();
    };
    browserWindow.addEventListener("message", receive);
    return () => browserWindow.removeEventListener("message", receive);
}

function requestExistingSupportBundleToken(port: BrowserProtocolPort): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const cleanup = (): void => {
            port.removeEventListener("message", receive);
            port.removeEventListener("messageerror", close);
            port.removeEventListener("close", close);
        };
        const receive = (event: MessageEvent<unknown>): void => {
            try {
                const reply = parsePackagedDiagnosticsProofControlReply(event.data);
                cleanup();
                resolve(reply.existingSupportBundleToken);
            } catch (error) {
                cleanup();
                reject(error);
            }
        };
        const close = (): void => {
            cleanup();
            reject(new Error("Packaged diagnostics proof control port closed before token delivery"));
        };
        port.addEventListener("message", receive);
        port.addEventListener("messageerror", close);
        port.addEventListener("close", close);
        port.start();
        try {
            port.postMessage(Object.freeze({ control: "request_existing_support_bundle_token" }));
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}
