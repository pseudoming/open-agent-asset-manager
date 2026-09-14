import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_ARTIFACT_BYTES,
    DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_BUFFER_BYTES,
    DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_DURATION_SECONDS,
} from "../src/bridge/desktop-bridge";
import {
    DESKTOP_PERFORMANCE_RECORDING_TRACE_CONFIG,
    DesktopPerformanceRecordingAuthority,
    type DesktopContentTracing,
} from "../src/main/performance-recording";

const createdRoots: string[] = [];
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION_ID = "22222222-2222-4222-8222-222222222222";

function temporaryRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-performance-recording-test-"));
    createdRoots.push(root);
    return root;
}

afterEach(() => {
    vi.restoreAllMocks();
    for (const root of createdRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tracing(bytes = Buffer.from('{"traceEvents":[]}')): DesktopContentTracing & {
    startRecording: ReturnType<typeof vi.fn>;
    stopRecording: ReturnType<typeof vi.fn>;
} {
    return {
        startRecording: vi.fn(async () => undefined),
        stopRecording: vi.fn(async (filePath: string) => {
            fs.writeFileSync(filePath, bytes);
            return filePath;
        }),
    };
}

describe("Desktop performance-recording authority", () => {
    it("records one bounded trace, saves through Shared, publishes state, and removes only its owned session", async () => {
        const root = temporaryRoot();
        const exactTracing = tracing();
        const timers: Array<() => void> = [];
        let now = 1_000;
        const authority = new DesktopPerformanceRecordingAuthority({
            contentTracing: exactTracing,
            temporaryRootPath: root,
            now: () => now,
            createId: () => SESSION_ID,
            setTimer: (listener) => {
                timers.push(listener);
                return timers.length as unknown as ReturnType<typeof setTimeout>;
            },
            clearTimer: vi.fn(),
        });
        const snapshots: unknown[] = [];
        const unsubscribe = authority.subscribe((snapshot) => snapshots.push(snapshot));

        await expect(authority.start()).resolves.toEqual({
            state: "recording",
            startedAt: 1_000,
            deadlineAt: 1_000 + DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_DURATION_SECONDS * 1000,
            maximumBufferBytes: DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_BUFFER_BYTES,
        });
        expect(exactTracing.startRecording).toHaveBeenCalledWith({
            ...DESKTOP_PERFORMANCE_RECORDING_TRACE_CONFIG,
            included_categories: [...DESKTOP_PERFORMANCE_RECORDING_TRACE_CONFIG.included_categories],
        });
        await expect(authority.start()).rejects.toThrow(/discarded/u);

        now = 2_000;
        const ready = await authority.stop();
        expect(ready).toMatchObject({ state: "ready", stoppedAt: 2_000, byteSize: 18 });
        const destination = path.join(root, "saved-trace.json");
        await expect(authority.saveTo(destination)).resolves.toEqual({
            status: "complete",
            displayPath: destination,
        });
        expect(fs.readFileSync(destination, "utf8")).toBe('{"traceEvents":[]}');
        expect(authority.snapshot).toEqual({ state: "idle" });
        expect(fs.readdirSync(path.join(root, "oaam-performance-recordings"))).toEqual([]);
        expect(snapshots.map((snapshot) => (snapshot as { state: string }).state)).toEqual(["recording", "ready", "idle"]);
        unsubscribe();
        await authority.discard();
        expect(snapshots).toHaveLength(3);
    });

    it("auto-stops, expires, retries a failed stop, and preserves fail-closed state while Electron may still record", async () => {
        const root = temporaryRoot();
        const timers: Array<() => void> = [];
        const exactTracing = tracing();
        exactTracing.stopRecording.mockRejectedValueOnce(new Error("flush failed"));
        const authority = new DesktopPerformanceRecordingAuthority({
            contentTracing: exactTracing,
            temporaryRootPath: root,
            createId: () => SESSION_ID,
            setTimer: (listener) => {
                timers.push(listener);
                return timers.length as unknown as ReturnType<typeof setTimeout>;
            },
            clearTimer: vi.fn(),
        });

        await authority.start();
        timers[0]?.();
        await vi.waitFor(() =>
            expect(authority.snapshot).toEqual({
                state: "failed",
                code: "stop_failed",
                mayStillBeRecording: true,
            }),
        );
        await authority.stop();
        expect(authority.snapshot.state).toBe("ready");
        timers[1]?.();
        await vi.waitFor(() => expect(authority.snapshot).toEqual({ state: "idle" }));
        expect(exactTracing.stopRecording).toHaveBeenCalledTimes(2);
    });

    it("rejects oversized and unsavable traces without losing the exact ready artifact before a successful discard", async () => {
        const root = temporaryRoot();
        const oversizedTracing = tracing();
        oversizedTracing.stopRecording.mockImplementationOnce(async (filePath: string) => {
            fs.writeFileSync(filePath, Buffer.alloc(1));
            fs.truncateSync(filePath, DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_ARTIFACT_BYTES + 1);
            return filePath;
        });
        const oversized = new DesktopPerformanceRecordingAuthority({
            contentTracing: oversizedTracing,
            temporaryRootPath: root,
            createId: () => SESSION_ID,
        });
        await oversized.start();
        await expect(oversized.stop()).resolves.toEqual({
            state: "failed",
            code: "trace_too_large",
            mayStillBeRecording: false,
        });
        await oversized.discard();
        expect(oversized.snapshot).toEqual({ state: "idle" });

        const exact = new DesktopPerformanceRecordingAuthority({
            contentTracing: tracing(),
            temporaryRootPath: root,
            createId: () => SECOND_SESSION_ID,
        });
        await exact.start();
        await exact.stop();
        await expect(exact.saveTo(path.join(root, "missing-parent", "trace.json"))).resolves.toEqual({
            status: "failed",
            code: "save_failed",
        });
        expect(exact.snapshot.state).toBe("ready");
        await exact.discard();
        await expect(exact.saveTo(path.join(root, "unused.json"))).resolves.toEqual({
            status: "failed",
            code: "not_ready",
        });
    });

    it("cleans only exact startup orphans, retains unrelated entries, and blocks an uninitialized workspace", async () => {
        const root = temporaryRoot();
        const recordingRoot = path.join(root, "oaam-performance-recordings");
        const orphan = path.join(recordingRoot, `recording-${SESSION_ID}`);
        const unrelated = path.join(recordingRoot, "keep-me");
        fs.mkdirSync(orphan, { recursive: true });
        fs.writeFileSync(path.join(orphan, "trace.json"), "old");
        fs.mkdirSync(unrelated);
        const authority = new DesktopPerformanceRecordingAuthority({
            contentTracing: tracing(),
            temporaryRootPath: root,
            createId: () => SECOND_SESSION_ID,
        });
        expect(fs.existsSync(orphan)).toBe(false);
        expect(fs.existsSync(unrelated)).toBe(true);
        await authority.start();
        await authority.shutdown();
        expect(authority.snapshot).toEqual({ state: "idle" });

        const unavailableRoot = path.join(root, "missing", "nested");
        const blocked = new DesktopPerformanceRecordingAuthority({
            contentTracing: tracing(),
            temporaryRootPath: unavailableRoot,
            createId: () => SESSION_ID,
        });
        expect(blocked.snapshot).toEqual({
            state: "failed",
            code: "initialization_failed",
            mayStillBeRecording: false,
        });
        await blocked.discard();
        expect(blocked.snapshot).toEqual({
            state: "failed",
            code: "initialization_failed",
            mayStillBeRecording: false,
        });
        await expect(blocked.start()).resolves.toEqual(blocked.snapshot);
    });

    it("surfaces start and cleanup failures without claiming a usable trace", async () => {
        const root = temporaryRoot();
        const startFailure = tracing();
        startFailure.startRecording.mockRejectedValueOnce(new Error("start failed"));
        const failed = new DesktopPerformanceRecordingAuthority({
            contentTracing: startFailure,
            temporaryRootPath: root,
            createId: () => SESSION_ID,
        });
        await expect(failed.start()).resolves.toEqual({
            state: "failed",
            code: "start_failed",
            mayStillBeRecording: false,
        });

        const invalidIdentity = new DesktopPerformanceRecordingAuthority({
            contentTracing: tracing(),
            temporaryRootPath: root,
            createId: () => "not-a-uuid",
        });
        await expect(invalidIdentity.start()).resolves.toEqual({
            state: "failed",
            code: "start_failed",
            mayStillBeRecording: false,
        });
    });
});
