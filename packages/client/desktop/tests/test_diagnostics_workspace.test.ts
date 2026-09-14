import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OaamDesktopBridge } from "../src/bridge/desktop-bridge";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { DiagnosticsWorkspace } from "../src/renderer/features/diagnostics";
import {
    createDesktopPresentationTestBridge,
    ordinarySurfaceText,
    renderWithPresentation,
} from "./desktop-presentation-test-harness";

const DIGEST = "a".repeat(64);
const LOG_SETTINGS = {
    schemaVersion: 1 as const,
    enabled: true,
    retentionDays: 7,
    maximumBytes: 10 * 1024 * 1024,
};
const HEALTH = {
    schemaVersion: 1 as const,
    overallStatus: "healthy" as const,
    host: { lifecycleState: "ready" as const, startupMode: "normal" as const },
    ordinaryLog: {
        state: "active" as const,
        suspensionReason: "none" as const,
        retainedBytes: 1024,
        maximumBytes: 10 * 1024 * 1024,
        segmentCount: 1,
    },
};
const SUPPORT_REVIEW = {
    schemaVersion: 1 as const,
    supportBundleReviewToken: "support-review",
    mode: "standard" as const,
    createdAt: 10,
    archiveByteLength: 2048,
    archiveContentHash: DIGEST,
    entries: [
        { archivePath: "README.txt", category: "documentation" as const, byteLength: 100 },
        { archivePath: "diagnostics/adapters.json", category: "adapter_capabilities" as const, byteLength: 100 },
        { archivePath: "diagnostics/health.json", category: "health" as const, byteLength: 100 },
        { archivePath: "diagnostics/ordinary-log.jsonl", category: "ordinary_log" as const, byteLength: 100 },
        { archivePath: "diagnostics/product.json", category: "product" as const, byteLength: 100 },
        { archivePath: "manifest.json", category: "manifest" as const, byteLength: 100 },
    ],
    ordinaryLog: {
        retainedSegmentCount: 1,
        includedSegmentCount: 1,
        retainedBytes: 100,
        includedBytes: 100,
        truncated: false,
    },
};

afterEach(cleanup);

function diagnosticsClient(overrides: Partial<DesktopApplicationClientApi> = {}): DesktopApplicationClientApi {
    const available = new Set([
        "diagnostics.health.get",
        "diagnostics.ordinary_log.settings.get",
        "diagnostics.ordinary_log.settings.replace",
        "diagnostics.ordinary_log.clear",
        "diagnostics.support_bundle.inspect",
        "diagnostics.support_bundle.export",
        "asset.reindex",
    ]);
    return {
        availableOperations: [...available] as never,
        supportsOperation: vi.fn((operation: string) => available.has(operation)),
        getDiagnosticsHealth: vi.fn(async () => ({ status: "complete", value: HEALTH, diagnostics: [] })),
        getOrdinaryLogSettings: vi.fn(async () => ({ status: "complete", value: LOG_SETTINGS, diagnostics: [] })),
        replaceOrdinaryLogSettings: vi.fn(async (params) => ({
            status: "complete",
            value: { schemaVersion: 1, ...params },
            diagnostics: [],
        })),
        clearOrdinaryLog: vi.fn(async () => ({
            status: "complete",
            value: { removedSegmentCount: 1, removedBytes: 1024, settings: LOG_SETTINGS },
            diagnostics: [],
        })),
        inspectSupportBundle: vi.fn(async () => ({ status: "complete", value: SUPPORT_REVIEW, diagnostics: [] })),
        exportSupportBundle: vi.fn(async () => ({
            status: "complete",
            value: {
                schemaVersion: 1,
                mode: "standard",
                createdAt: 10,
                archiveByteLength: 2048,
                archiveContentHash: DIGEST,
                entryCount: 6,
            },
            diagnostics: [],
        })),
        reindexAssets: vi.fn(async () => ({
            status: "complete",
            value: { scannedAssets: 3, indexedAssets: 2, skippedAssets: 1, diagnostics: [] },
            diagnostics: [],
        })),
        subscribeInvalidation: vi.fn(() => () => undefined),
        ...overrides,
    } as unknown as DesktopApplicationClientApi;
}

function diagnosticsBridge(overrides: Partial<OaamDesktopBridge> = {}): OaamDesktopBridge {
    return {
        ...createDesktopPresentationTestBridge(),
        pickSupportBundleExport: vi.fn(async () => ({
            status: "selected",
            displayPath: "/saved/support.zip",
            localPathSelectionToken: "support-path",
        })),
        getDesktopPerformanceRecording: vi.fn(async () => ({ state: "idle" })),
        startDesktopPerformanceRecording: vi.fn(async () => ({
            state: "recording",
            startedAt: Date.now(),
            deadlineAt: Date.now() + 120_000,
            maximumBufferBytes: 100 * 1024 * 1024,
        })),
        stopDesktopPerformanceRecording: vi.fn(async () => ({
            state: "ready",
            stoppedAt: Date.now(),
            expiresAt: Date.now() + 900_000,
            byteSize: 4096,
        })),
        saveDesktopPerformanceRecording: vi.fn(async () => ({
            status: "complete",
            displayPath: "/saved/trace.json",
        })),
        discardDesktopPerformanceRecording: vi.fn(async () => ({ state: "idle" })),
        ...overrides,
    };
}

describe("Desktop diagnostics workspace", () => {
    it("runs health, log, support, performance, reindex, and existing-owner links through their exact authorities", async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
        const client = diagnosticsClient();
        const bridge = diagnosticsBridge();
        const view = renderWithPresentation(createElement(DiagnosticsWorkspace, { client, desktopBridge: bridge }), bridge);

        expect(await screen.findByText("Healthy")).not.toBeNull();
        expect(screen.getByText("Ready")).not.toBeNull();
        expect(screen.getByText("Normal startup")).not.toBeNull();
        expect(screen.getByText("Logging active")).not.toBeNull();
        expect(screen.getByText("1 KiB")).not.toBeNull();
        fireEvent.click(screen.getByRole("switch", { name: "Enable ordinary logging" }));
        fireEvent.click(screen.getByRole("switch", { name: "Enable ordinary logging" }));
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
        await waitFor(() => expect(client.getDiagnosticsHealth).toHaveBeenCalledTimes(2));
        const retention = screen.getByRole("spinbutton", { name: "Retention (days)" });
        fireEvent.change(retention, { target: { value: "5" } });
        fireEvent.change(screen.getByRole("spinbutton", { name: "Maximum size (MiB)" }), { target: { value: "8" } });
        fireEvent.click(screen.getByRole("button", { name: "Save log settings" }));
        await waitFor(() =>
            expect(client.replaceOrdinaryLogSettings).toHaveBeenCalledWith({
                enabled: true,
                retentionDays: 5,
                maximumBytes: 8 * 1024 * 1024,
            }),
        );

        const clear = screen.getByRole("button", { name: "Permanently clear log" }) as HTMLButtonElement;
        expect(clear.disabled).toBe(true);
        fireEvent.click(
            screen.getByRole("checkbox", {
                name: "I understand that retained ordinary log segments will be permanently removed.",
            }),
        );
        await waitFor(() => expect(clear.disabled).toBe(false));
        fireEvent.click(clear);
        expect(await screen.findByText("Removed 1 log segments (1 KiB).")).not.toBeNull();

        const bundleMode = screen.getByRole("combobox", { name: "Bundle detail" });
        fireEvent.click(bundleMode);
        fireEvent.click(screen.getByRole("option", { name: "Extended (includes local path labels)" }));
        fireEvent.click(bundleMode);
        fireEvent.click(screen.getByRole("option", { name: "Standard" }));
        const supportReviewAction = view.container.querySelector('[data-oaam-diagnostics-action="support.inspect"]');
        expect(supportReviewAction).toBe(screen.getByRole("button", { name: "Review bundle" }));
        expect(screen.getByRole("button", { name: "Save log settings" }).hasAttribute("data-oaam-diagnostics-action")).toBe(
            false,
        );
        fireEvent.click(supportReviewAction as HTMLButtonElement);
        expect(await screen.findByText("6 reviewed files · compressed ZIP 2 KiB")).not.toBeNull();
        expect(screen.getByText("Archive SHA-256").nextElementSibling?.textContent).toBe(DIGEST);
        fireEvent.click(screen.getByRole("button", { name: "Copy archive hash" }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(DIGEST));
        const copiedHash = await screen.findByRole("button", { name: "Archive hash copied" });
        expect(view.container.querySelector('[data-oaam-support-hash-feedback="copied"]')?.textContent).toBe(
            "Archive hash copied",
        );
        writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
        fireEvent.click(copiedHash);
        expect(await screen.findByRole("button", { name: "Archive hash could not be copied" })).not.toBeNull();
        expect(view.container.querySelector('[data-oaam-support-hash-feedback="failed"]')?.textContent).toBe(
            "Archive hash could not be copied",
        );
        expect(
            screen.getByText("Included 1 of 1 segments (100 B of 100 B). The complete retained log is included."),
        ).not.toBeNull();
        expect(screen.getByText("OAAM health").nextElementSibling?.textContent).toBe("diagnostics/health.json");
        expect(screen.getByText("diagnostics/health.json")).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Export reviewed bundle…" }));
        await waitFor(() =>
            expect(client.exportSupportBundle).toHaveBeenCalledWith(
                expect.objectContaining({
                    supportBundleReviewToken: "support-review",
                    localPathSelectionToken: "support-path",
                }),
            ),
        );

        const performanceConfirmation = screen.getByRole("checkbox", {
            name: /trace may include function names/u,
        });
        fireEvent.click(performanceConfirmation);
        fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
        expect(await screen.findByText("Recording")).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
        expect(await screen.findByText(/Trace ready:/u)).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Save trace…" }));
        expect(await screen.findByText("The performance trace was saved to /saved/trace.json.")).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Rebuild Asset index" }));
        expect(await screen.findByText("Reindexed 2 Assets; skipped 1.")).not.toBeNull();
        const stateResilienceLink = screen.getByRole("link", { name: "Open backup and restore" });
        expect(stateResilienceLink.getAttribute("href")).toBe("#state-resilience-settings");
        stateResilienceLink.click();
        await waitFor(() => expect(window.location.hash).toBe("#state-resilience-settings"));

        const maintenanceLink = screen.getByRole("link", { name: "Open local maintenance" });
        expect(maintenanceLink.getAttribute("href")).toBe("#desktop-maintenance-settings");
        maintenanceLink.click();
        await waitFor(() => expect(window.location.hash).toBe("#desktop-maintenance-settings"));
        window.history.replaceState(null, "", "/");
    });

    it("projects failed recovery and suspended-log states into localized product language", async () => {
        const getDiagnosticsHealth = vi
            .fn()
            .mockResolvedValueOnce({
                status: "complete" as const,
                value: {
                    schemaVersion: 1 as const,
                    overallStatus: "unhealthy" as const,
                    host: { lifecycleState: "failed" as const, startupMode: "state_recovery" as const },
                    ordinaryLog: {
                        state: "suspended" as const,
                        suspensionReason: "write_failed" as const,
                        retainedBytes: 0,
                        maximumBytes: 10 * 1024 * 1024,
                        segmentCount: 0,
                    },
                },
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                status: "complete" as const,
                value: {
                    schemaVersion: 1 as const,
                    overallStatus: "degraded" as const,
                    host: { lifecycleState: "draining" as const, startupMode: "normal" as const },
                    ordinaryLog: {
                        state: "disabled" as const,
                        suspensionReason: "user_disabled" as const,
                        retainedBytes: 0,
                        maximumBytes: 10 * 1024 * 1024,
                        segmentCount: 0,
                    },
                },
                diagnostics: [],
            });
        const client = diagnosticsClient({
            getDiagnosticsHealth,
        });
        const bridge = diagnosticsBridge();
        const view = renderWithPresentation(createElement(DiagnosticsWorkspace, { client, desktopBridge: bridge }), bridge);

        expect(await screen.findByText("Unhealthy")).not.toBeNull();
        expect(screen.getByText("Failed")).not.toBeNull();
        expect(screen.getByText("Recovery mode")).not.toBeNull();
        expect(screen.getByText("Paused")).not.toBeNull();
        expect(screen.getByText("OAAM could not write the ordinary log.")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("state_recovery");
        expect(ordinarySurfaceText(view.container)).not.toContain("write_failed");

        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
        expect(await screen.findByText("Disabled by your setting")).not.toBeNull();
        expect(screen.getByText("Finishing active work")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("user_disabled");
    });

    it("retains a successful health warning as technical evidence without replacing ordinary product copy", async () => {
        const client = diagnosticsClient({
            getDiagnosticsHealth: vi.fn(async () => ({
                status: "complete",
                value: HEALTH,
                diagnostics: [
                    {
                        severity: "warning" as const,
                        code: "host.health.partial_fixture",
                        operation: "host" as const,
                        causeKind: "partial" as const,
                        retryable: true,
                        suggestedActions: ["retry" as const],
                        message: "One health source returned partial data.",
                    },
                ],
            })),
        });
        const bridge = diagnosticsBridge();
        const view = renderWithPresentation(createElement(DiagnosticsWorkspace, { client, desktopBridge: bridge }), bridge);

        expect(await screen.findByText("Diagnostics loaded with details that may need attention.")).not.toBeNull();
        expect(screen.getByText("Original detail: One health source returned partial data.")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("One health source returned partial data.");
    });

    it("keeps invalid settings and failed operations visible without issuing unauthorized mutations", async () => {
        const failure = {
            severity: "error" as const,
            code: "diagnostics.failed",
            operation: "host" as const,
            causeKind: "internal_error" as const,
            retryable: true,
            suggestedActions: ["retry"],
            message: "review failed",
        };
        const client = diagnosticsClient({
            getDiagnosticsHealth: vi.fn(async () => ({
                status: "complete",
                value: { ...HEALTH, overallStatus: "degraded" as const },
                diagnostics: [],
            })),
            replaceOrdinaryLogSettings: vi.fn(async () => ({ status: "failed", diagnostics: [failure] })),
            clearOrdinaryLog: vi.fn(async () => ({ status: "failed", diagnostics: [failure] })),
            inspectSupportBundle: vi.fn(async () => ({ status: "failed", diagnostics: [failure] })),
            reindexAssets: vi.fn(async () => ({ status: "failed", diagnostics: [failure] })),
        });
        const bridge = diagnosticsBridge({
            startDesktopPerformanceRecording: vi.fn(async () => {
                throw new Error("start denied");
            }),
        });
        const view = renderWithPresentation(createElement(DiagnosticsWorkspace, { client, desktopBridge: bridge }), bridge);
        await screen.findByText("Degraded");

        fireEvent.change(screen.getByRole("spinbutton", { name: "Retention (days)" }), { target: { value: "99" } });
        fireEvent.click(screen.getByRole("button", { name: "Save log settings" }));
        expect(await screen.findByText(/Retention must be 1–14 days/u)).not.toBeNull();
        expect(client.replaceOrdinaryLogSettings).not.toHaveBeenCalled();
        fireEvent.change(screen.getByRole("spinbutton", { name: "Retention (days)" }), { target: { value: "7" } });
        fireEvent.click(screen.getByRole("button", { name: "Save log settings" }));
        await waitFor(() => expect(client.replaceOrdinaryLogSettings).toHaveBeenCalledOnce());
        expect(await screen.findByText("The ordinary-log settings could not be saved.")).not.toBeNull();
        expect(screen.getByText("Original detail: review failed")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("review failed");

        fireEvent.click(
            screen.getByRole("checkbox", {
                name: "I understand that retained ordinary log segments will be permanently removed.",
            }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Permanently clear log" }));
        await waitFor(() => expect(client.clearOrdinaryLog).toHaveBeenCalledOnce());
        expect(await screen.findByText("The ordinary log could not be cleared.")).not.toBeNull();
        expect(screen.getByText("Original detail: review failed")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("review failed");

        fireEvent.click(screen.getByRole("button", { name: "Review bundle" }));
        const supportFailure = await screen.findByText(
            "The support bundle could not be inspected. Choose Review bundle to try again.",
        );
        expect(supportFailure.closest("section")?.querySelector("h3")?.textContent).toBe("Support bundle");
        expect(supportFailure.closest(".workbench-notice")?.querySelectorAll(".workbench-notice")).toHaveLength(0);
        expect(screen.getByText("Original detail: review failed")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("review failed");
        expect(client.inspectSupportBundle).toHaveBeenCalledOnce();
        vi.mocked(client.inspectSupportBundle).mockResolvedValueOnce({
            status: "complete",
            value: {
                ...SUPPORT_REVIEW,
                ordinaryLog: {
                    retainedSegmentCount: 2,
                    includedSegmentCount: 1,
                    retainedBytes: 300,
                    includedBytes: 100,
                    truncated: true,
                },
            },
            diagnostics: [],
        });
        fireEvent.click(screen.getByRole("button", { name: "Review bundle" }));
        await screen.findByText("6 reviewed files · compressed ZIP 2 KiB");
        expect(
            screen.getByText("Included 1 of 2 segments (100 B of 300 B). The retained log was truncated for this bundle."),
        ).not.toBeNull();
        expect(client.inspectSupportBundle).toHaveBeenCalledTimes(2);
        expect(client.exportSupportBundle).not.toHaveBeenCalled();
        expect(supportFailure.isConnected).toBe(false);
        fireEvent.click(
            screen.getByRole("checkbox", {
                name: /trace may include function names/u,
            }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
        expect(await screen.findByText("Performance recording could not start.")).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Rebuild Asset index" }));
        expect(await screen.findByText("The Asset index could not be rebuilt.")).not.toBeNull();
        expect(screen.getByText("Original detail: review failed")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("review failed");
    });

    it("keeps load and unavailable performance failures visible without manufacturing Host or Core authority", async () => {
        const loadFailure = {
            severity: "error" as const,
            code: "diagnostics.load_failed",
            operation: "host" as const,
            causeKind: "internal_error" as const,
            retryable: true,
            suggestedActions: ["retry"],
            message: "health unavailable",
        };
        const client = diagnosticsClient({
            getDiagnosticsHealth: vi.fn(async () => ({ status: "failed", diagnostics: [loadFailure] })),
        });
        const bridge = diagnosticsBridge();
        const view = renderWithPresentation(createElement(DiagnosticsWorkspace, { client, desktopBridge: bridge }), bridge);
        expect(await screen.findByText("Diagnostics could not be loaded.")).not.toBeNull();
        expect(screen.getByText("Original detail: health unavailable")).not.toBeNull();
        expect(ordinarySurfaceText(view.container)).not.toContain("health unavailable");

        const unavailableClient = diagnosticsClient({
            availableOperations: [],
            supportsOperation: vi.fn(() => false),
        });
        const unavailableBridge = diagnosticsBridge({
            getDesktopPerformanceRecording: vi.fn(async () => {
                throw new Error("tracing unavailable");
            }),
        });
        cleanup();
        renderWithPresentation(
            createElement(DiagnosticsWorkspace, { client: unavailableClient, desktopBridge: unavailableBridge }),
            unavailableBridge,
        );
        expect(await screen.findByText("Performance-recording state is unavailable.")).not.toBeNull();
        expect(screen.getByText("This OAAM session does not provide this diagnostic action.")).not.toBeNull();
    });

    it("renders pushed failed and ready trace states, retry-stop, cancellation, and discard without Host authority", async () => {
        let listener:
            | ((
                  snapshot: Parameters<OaamDesktopBridge["subscribeDesktopPerformanceRecording"]>[0] extends (
                      value: infer T,
                  ) => void
                      ? T
                      : never,
              ) => void)
            | undefined;
        const bridge = diagnosticsBridge({
            subscribeDesktopPerformanceRecording: (next) => {
                listener = next;
                return () => {
                    listener = undefined;
                };
            },
            stopDesktopPerformanceRecording: vi.fn(async () => ({
                state: "failed",
                code: "stop_failed",
                mayStillBeRecording: true,
            })),
            saveDesktopPerformanceRecording: vi.fn(async () => ({ status: "cancelled" })),
        });
        renderWithPresentation(
            createElement(DiagnosticsWorkspace, { client: diagnosticsClient(), desktopBridge: bridge }),
            bridge,
        );
        await screen.findByText("Healthy");
        listener?.({ state: "failed", code: "stop_failed", mayStillBeRecording: true });
        expect(await screen.findByText(/Retry stopping/u)).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
        await waitFor(() => expect(bridge.stopDesktopPerformanceRecording).toHaveBeenCalledOnce());
        fireEvent.click(screen.getByRole("button", { name: "Discard" }));
        await waitFor(() => expect(bridge.discardDesktopPerformanceRecording).toHaveBeenCalledOnce());
        listener?.({ state: "ready", stoppedAt: 1, expiresAt: Date.now() + 900_000, byteSize: 10 });
        expect(await screen.findByText(/Trace ready:/u)).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Save trace…" }));
        await waitFor(() => expect(bridge.saveDesktopPerformanceRecording).toHaveBeenCalledOnce());
        fireEvent.click(screen.getByRole("button", { name: "Discard" }));
        await waitFor(() => expect(bridge.discardDesktopPerformanceRecording).toHaveBeenCalledTimes(2));
    });
});
