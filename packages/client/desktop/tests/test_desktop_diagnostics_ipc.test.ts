import { describe, expect, it, vi } from "vitest";
import {
    DESKTOP_PERFORMANCE_RECORDING_CHANGED_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_DISCARD_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_GET_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_SAVE_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_START_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_STOP_CHANNEL,
    parseDesktopPerformanceRecordingSaveResult,
    parseDesktopPerformanceRecordingSnapshot,
    parseDesktopSensitiveCaptureConfirmation,
    parseSupportBundleExportPickerResult,
    parseSupportBundleExportSuggestedFileName,
    SUPPORT_BUNDLE_EXPORT_PICK_CHANNEL,
} from "../src/bridge/desktop-bridge";
import { registerDesktopDiagnosticsIpc } from "../src/main/desktop-diagnostics-ipc";
import { installDesktopDiagnosticsRuntime } from "../src/main/desktop-diagnostics-runtime";

function recordingAuthority() {
    let listener: ((snapshot: { readonly state: "idle" }) => void) | undefined;
    return {
        snapshot: { state: "idle" as const },
        start: vi.fn(async () => ({ state: "recording" as const })),
        stop: vi.fn(async () => ({ state: "ready" as const })),
        saveTo: vi.fn(async () => ({ status: "complete" as const, displayPath: "/saved/trace.json" })),
        discard: vi.fn(async () => ({ state: "idle" as const })),
        subscribe: vi.fn((next: typeof listener) => {
            listener = next;
            return () => {
                listener = undefined;
            };
        }),
        publish() {
            listener?.({ state: "idle" });
        },
    };
}

describe("Desktop diagnostics finite IPC", () => {
    it("binds only the primary sender, main-owned pickers, fresh confirmation, and finite performance methods", async () => {
        const handlers = new Map<string, (...args: never[]) => unknown>();
        const webContents = { send: vi.fn() };
        const window = { webContents };
        const recording = recordingAuthority();
        const registerPath = vi.fn(async () => "support-path-token");
        const dispose = registerDesktopDiagnosticsIpc({
            ipcMain: {
                handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => handlers.set(channel, handler)),
            } as never,
            getPrimaryWindow: () => window as never,
            hostIsReady: () => true,
            performanceRecording: recording as never,
            pickSupportBundleExportPath: vi.fn(async () => "/saved/support.zip"),
            registerSupportBundleExportPath: registerPath,
            pickPerformanceRecordingExportPath: vi.fn(async () => "/saved/trace.json"),
        });

        expect([...handlers.keys()]).toEqual([
            SUPPORT_BUNDLE_EXPORT_PICK_CHANNEL,
            DESKTOP_PERFORMANCE_RECORDING_GET_CHANNEL,
            DESKTOP_PERFORMANCE_RECORDING_START_CHANNEL,
            DESKTOP_PERFORMANCE_RECORDING_STOP_CHANNEL,
            DESKTOP_PERFORMANCE_RECORDING_SAVE_CHANNEL,
            DESKTOP_PERFORMANCE_RECORDING_DISCARD_CHANNEL,
        ]);
        const event = { sender: webContents };
        await expect(
            handlers.get(SUPPORT_BUNDLE_EXPORT_PICK_CHANNEL)?.(event as never, "oaam-support.zip" as never),
        ).resolves.toEqual({
            status: "selected",
            displayPath: "/saved/support.zip",
            localPathSelectionToken: "support-path-token",
        });
        expect(registerPath).toHaveBeenCalledWith("/saved/support.zip");
        expect(handlers.get(DESKTOP_PERFORMANCE_RECORDING_GET_CHANNEL)?.(event as never)).toEqual({
            state: "idle",
        });
        await expect(
            Promise.resolve().then(() =>
                handlers.get(DESKTOP_PERFORMANCE_RECORDING_START_CHANNEL)?.(event as never, false as never),
            ),
        ).rejects.toThrow(/fresh/u);
        await expect(handlers.get(DESKTOP_PERFORMANCE_RECORDING_START_CHANNEL)?.(event as never, true as never)).resolves.toEqual(
            { state: "recording" },
        );
        await expect(handlers.get(DESKTOP_PERFORMANCE_RECORDING_STOP_CHANNEL)?.(event as never)).resolves.toEqual({
            state: "ready",
        });
        await expect(handlers.get(DESKTOP_PERFORMANCE_RECORDING_SAVE_CHANNEL)?.(event as never)).resolves.toEqual({
            status: "complete",
            displayPath: "/saved/trace.json",
        });
        await expect(handlers.get(DESKTOP_PERFORMANCE_RECORDING_DISCARD_CHANNEL)?.(event as never)).resolves.toEqual({
            state: "idle",
        });

        recording.publish();
        expect(webContents.send).toHaveBeenCalledWith(DESKTOP_PERFORMANCE_RECORDING_CHANGED_CHANNEL, { state: "idle" });
        dispose();
        recording.publish();
        expect(webContents.send).toHaveBeenCalledTimes(1);

        for (const handler of handlers.values()) {
            await expect(Promise.resolve().then(() => handler({ sender: {} } as never))).rejects.toThrow(/unavailable/u);
        }
    });

    it("returns cancellation and blocks support selection while the Host is unavailable", async () => {
        const handlers = new Map<string, (...args: never[]) => unknown>();
        const webContents = {};
        const window = { webContents };
        const recording = recordingAuthority();
        registerDesktopDiagnosticsIpc({
            ipcMain: {
                handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => handlers.set(channel, handler)),
            } as never,
            getPrimaryWindow: () => window as never,
            hostIsReady: () => false,
            performanceRecording: recording as never,
            pickSupportBundleExportPath: vi.fn(async () => undefined),
            registerSupportBundleExportPath: vi.fn(),
            pickPerformanceRecordingExportPath: vi.fn(async () => undefined),
        });
        const event = { sender: webContents };
        await expect(handlers.get(SUPPORT_BUNDLE_EXPORT_PICK_CHANNEL)?.(event as never, "support.zip" as never)).rejects.toThrow(
            /unavailable/u,
        );
        await expect(handlers.get(DESKTOP_PERFORMANCE_RECORDING_SAVE_CHANNEL)?.(event as never)).resolves.toEqual({
            status: "cancelled",
        });

        const cancelledHandlers = new Map<string, (...args: never[]) => unknown>();
        registerDesktopDiagnosticsIpc({
            ipcMain: {
                handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) =>
                    cancelledHandlers.set(channel, handler),
                ),
            } as never,
            getPrimaryWindow: () => window as never,
            hostIsReady: () => true,
            performanceRecording: recording as never,
            pickSupportBundleExportPath: vi.fn(async () => undefined),
            registerSupportBundleExportPath: vi.fn(),
            pickPerformanceRecordingExportPath: vi.fn(async () => undefined),
        });
        await expect(
            cancelledHandlers.get(SUPPORT_BUNDLE_EXPORT_PICK_CHANNEL)?.(event as never, "support.zip" as never),
        ).resolves.toEqual({ status: "cancelled" });
    });

    it("builds localized save dialogs without exposing arbitrary renderer paths", async () => {
        const handlers = new Map<string, (...args: never[]) => unknown>();
        const webContents = {};
        const window = { webContents };
        const showSaveDialog = vi
            .fn()
            .mockResolvedValueOnce({ canceled: false, filePath: "/support.zip" })
            .mockResolvedValueOnce({ canceled: false, filePath: "/trace.json" });
        installDesktopDiagnosticsRuntime({
            ipcMain: {
                handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => handlers.set(channel, handler)),
            } as never,
            dialog: { showSaveDialog } as never,
            getPrimaryWindow: () => window as never,
            hostIsReady: () => true,
            performanceRecording: recordingAuthority() as never,
            registerSupportBundleExportPath: vi.fn(async () => "token"),
            text: (id) => id,
            now: () => new Date("2026-07-25T01:02:03.000Z"),
        });
        const event = { sender: webContents };
        await handlers.get(SUPPORT_BUNDLE_EXPORT_PICK_CHANNEL)?.(event as never, "support.zip" as never);
        await handlers.get(DESKTOP_PERFORMANCE_RECORDING_SAVE_CHANNEL)?.(event as never);
        expect(showSaveDialog).toHaveBeenNthCalledWith(
            1,
            window,
            expect.objectContaining({ defaultPath: "support.zip", filters: [{ name: "ZIP", extensions: ["zip"] }] }),
        );
        expect(showSaveDialog).toHaveBeenNthCalledWith(
            2,
            window,
            expect.objectContaining({
                defaultPath: "oaam-performance-trace-2026-07-25T01-02-03.000Z.json",
                filters: [{ name: "JSON", extensions: ["json"] }],
            }),
        );
    });

    it("parses only exact bounded diagnostics bridge values", () => {
        expect(parseSupportBundleExportSuggestedFileName("support.zip")).toBe("support.zip");
        expect(parseSupportBundleExportPickerResult({ status: "cancelled" })).toEqual({ status: "cancelled" });
        expect(
            parseSupportBundleExportPickerResult({
                status: "selected",
                displayPath: "/support.zip",
                localPathSelectionToken: "token",
            }),
        ).toMatchObject({ status: "selected" });
        expect(parseDesktopSensitiveCaptureConfirmation(true)).toBe(true);
        expect(
            parseDesktopPerformanceRecordingSnapshot({
                state: "recording",
                startedAt: 10,
                deadlineAt: 120_010,
                maximumBufferBytes: 100 * 1024 * 1024,
            }),
        ).toMatchObject({ state: "recording" });
        expect(
            parseDesktopPerformanceRecordingSnapshot({
                state: "ready",
                stoppedAt: 10,
                expiresAt: 900_010,
                byteSize: 1,
            }),
        ).toMatchObject({ state: "ready" });
        expect(
            parseDesktopPerformanceRecordingSnapshot({
                state: "failed",
                code: "stop_failed",
                mayStillBeRecording: true,
            }),
        ).toMatchObject({ state: "failed" });
        expect(parseDesktopPerformanceRecordingSaveResult({ status: "cancelled" })).toEqual({ status: "cancelled" });
        expect(parseDesktopPerformanceRecordingSaveResult({ status: "complete", displayPath: "/trace.json" })).toMatchObject({
            status: "complete",
        });
        expect(parseDesktopPerformanceRecordingSaveResult({ status: "failed", code: "not_ready" })).toMatchObject({
            status: "failed",
        });

        for (const invalid of ["../support.zip", "folder/support.zip", "", "a".repeat(256)]) {
            expect(() => parseSupportBundleExportSuggestedFileName(invalid)).toThrow(TypeError);
        }
        expect(() => parseDesktopSensitiveCaptureConfirmation(false)).toThrow(TypeError);
        expect(() =>
            parseSupportBundleExportPickerResult({ status: "selected", displayPath: "", localPathSelectionToken: "x" }),
        ).toThrow(TypeError);
        expect(() => parseDesktopPerformanceRecordingSnapshot({ state: "recording", startedAt: 1 })).toThrow(TypeError);
        expect(() =>
            parseDesktopPerformanceRecordingSnapshot({ state: "failed", code: "unknown", mayStillBeRecording: false }),
        ).toThrow(TypeError);
        expect(() => parseDesktopPerformanceRecordingSaveResult({ status: "failed", code: "unknown" })).toThrow(TypeError);
    });
});
