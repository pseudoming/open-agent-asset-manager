import * as crypto from "node:crypto";
import * as path from "node:path";
import {
    durableCreateFile,
    durableEnsureDirectory,
    durableRemoveDirectoryTree,
    durableReplaceFile,
    inspectRegularFileNoFollow,
    readDirectoryEntriesBounded,
    readRegularFileBounded,
    readRegularFileRangeNoFollow,
    SafeFilesystemError,
} from "@oaam/shared/filesystem";
import type { DesktopPerformanceRecordingSaveResult, DesktopPerformanceRecordingSnapshot } from "../bridge/desktop-bridge";
import {
    DESKTOP_PERFORMANCE_RECORDING_ARTIFACT_TTL_MS,
    DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_ARTIFACT_BYTES,
    DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_BUFFER_BYTES,
    DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_DURATION_SECONDS,
} from "../bridge/desktop-bridge";

const PERFORMANCE_RECORDING_ROOT_NAME = "oaam-performance-recordings";
const PERFORMANCE_RECORDING_SESSION_PREFIX = "recording-";
const PERFORMANCE_RECORDING_FILE_NAME = "trace.json";
const MAXIMUM_ORPHAN_SESSION_COUNT = 128;
const MAXIMUM_SESSION_TREE_ENTRIES = 4;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const DESKTOP_PERFORMANCE_RECORDING_TRACE_CONFIG = Object.freeze({
    enable_argument_filter: true,
    included_categories: Object.freeze(["blink.user_timing", "electron", "toplevel"]),
    recording_mode: "record-until-full" as const,
    trace_buffer_size_in_kb: DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_BUFFER_BYTES / 1024,
});

export interface DesktopContentTracing {
    startRecording(options: Electron.TraceConfig): Promise<void>;
    stopRecording(resultFilePath?: string): Promise<string>;
}

export interface DesktopPerformanceRecordingDependencies {
    readonly contentTracing: DesktopContentTracing;
    readonly temporaryRootPath: string;
    readonly now?: () => number;
    readonly createId?: () => string;
    readonly setTimer?: (listener: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface RecordingSession {
    readonly rootPath: string;
    readonly traceFilePath: string;
}

function idleSnapshot(): DesktopPerformanceRecordingSnapshot {
    return Object.freeze({ state: "idle" });
}

function failedSnapshot(
    code: Extract<DesktopPerformanceRecordingSnapshot, { readonly state: "failed" }>["code"],
    mayStillBeRecording: boolean,
): DesktopPerformanceRecordingSnapshot {
    return Object.freeze({ state: "failed", code, mayStillBeRecording });
}

function recordingSessionName(id: string): string {
    if (!UUID_V4.test(id)) throw new TypeError("performance-recording session identity must be a UUID v4");
    return `${PERFORMANCE_RECORDING_SESSION_PREFIX}${id}`;
}

function isOwnedSessionName(value: string): boolean {
    return (
        value.startsWith(PERFORMANCE_RECORDING_SESSION_PREFIX) &&
        UUID_V4.test(value.slice(PERFORMANCE_RECORDING_SESSION_PREFIX.length))
    );
}

function exactPath(left: string, right: string): boolean {
    return path.resolve(left) === path.resolve(right);
}

export class DesktopPerformanceRecordingAuthority {
    readonly #contentTracing: DesktopContentTracing;
    readonly #rootPath: string;
    readonly #now: () => number;
    readonly #createId: () => string;
    readonly #setTimer: NonNullable<DesktopPerformanceRecordingDependencies["setTimer"]>;
    readonly #clearTimer: NonNullable<DesktopPerformanceRecordingDependencies["clearTimer"]>;
    readonly #listeners = new Set<(snapshot: DesktopPerformanceRecordingSnapshot) => void>();
    #snapshot: DesktopPerformanceRecordingSnapshot = idleSnapshot();
    #initialized = false;
    #session: RecordingSession | undefined;
    #recordingMayBeActive = false;
    #automaticStopTimer: ReturnType<typeof setTimeout> | undefined;
    #expiryTimer: ReturnType<typeof setTimeout> | undefined;
    #tail: Promise<void> = Promise.resolve();

    public constructor(dependencies: DesktopPerformanceRecordingDependencies) {
        this.#contentTracing = dependencies.contentTracing;
        this.#rootPath = path.join(dependencies.temporaryRootPath, PERFORMANCE_RECORDING_ROOT_NAME);
        this.#now = dependencies.now ?? Date.now;
        this.#createId = dependencies.createId ?? crypto.randomUUID;
        this.#setTimer = dependencies.setTimer ?? setTimeout;
        this.#clearTimer = dependencies.clearTimer ?? clearTimeout;
        this.#initialize();
    }

    public get snapshot(): DesktopPerformanceRecordingSnapshot {
        return this.#snapshot;
    }

    public subscribe(listener: (snapshot: DesktopPerformanceRecordingSnapshot) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    public start(): Promise<DesktopPerformanceRecordingSnapshot> {
        return this.#runExclusive(async () => {
            if (!this.#initialized) return this.#snapshot;
            if (this.#snapshot.state !== "idle" || this.#session !== undefined || this.#recordingMayBeActive) {
                throw new Error("Desktop performance recording must be discarded before another recording can start");
            }
            let session: RecordingSession | undefined;
            try {
                session = this.#createSession();
                await this.#contentTracing.startRecording({
                    ...DESKTOP_PERFORMANCE_RECORDING_TRACE_CONFIG,
                    included_categories: [...DESKTOP_PERFORMANCE_RECORDING_TRACE_CONFIG.included_categories],
                });
                this.#session = session;
                this.#recordingMayBeActive = true;
                const startedAt = this.#now();
                this.#publish(
                    Object.freeze({
                        state: "recording",
                        startedAt,
                        deadlineAt: startedAt + DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_DURATION_SECONDS * 1000,
                        maximumBufferBytes: DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_BUFFER_BYTES,
                    }),
                );
                this.#automaticStopTimer = this.#setTimer(() => {
                    void this.stop();
                }, DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_DURATION_SECONDS * 1000);
            } catch {
                if (session !== undefined) this.#removeSessionBestEffort(session);
                this.#session = undefined;
                this.#recordingMayBeActive = false;
                this.#publish(failedSnapshot("start_failed", false));
            }
            return this.#snapshot;
        });
    }

    public stop(): Promise<DesktopPerformanceRecordingSnapshot> {
        return this.#runExclusive(() => this.#stop());
    }

    public saveTo(destinationPath: string): Promise<DesktopPerformanceRecordingSaveResult> {
        return this.#runExclusive(async () => {
            const session = this.#session;
            if (this.#snapshot.state !== "ready" || session === undefined) {
                return Object.freeze({ status: "failed", code: "not_ready" });
            }
            try {
                const bytes = readRegularFileBounded(session.traceFilePath, DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_ARTIFACT_BYTES);
                try {
                    inspectRegularFileNoFollow(destinationPath);
                    durableReplaceFile(destinationPath, bytes);
                } catch (error) {
                    if (!(error instanceof SafeFilesystemError) || error.failureKind !== "not_found") throw error;
                    durableCreateFile(destinationPath, bytes);
                }
                const result = Object.freeze({ status: "complete" as const, displayPath: destinationPath });
                this.#finishSession(session);
                return result;
            } catch {
                return Object.freeze({ status: "failed", code: "save_failed" });
            }
        });
    }

    public discard(): Promise<DesktopPerformanceRecordingSnapshot> {
        return this.#runExclusive(async () => {
            if (this.#recordingMayBeActive) await this.#stop();
            const session = this.#session;
            if (this.#recordingMayBeActive) return this.#snapshot;
            if (session === undefined) {
                this.#clearTimers();
                if (this.#initialized) this.#publish(idleSnapshot());
                return this.#snapshot;
            }
            this.#finishSession(session);
            return this.#snapshot;
        });
    }

    public shutdown(): Promise<void> {
        return this.#runExclusive(async () => {
            this.#clearTimers();
            if (this.#recordingMayBeActive) await this.#stop();
            if (this.#recordingMayBeActive) return;
            const session = this.#session;
            if (session !== undefined) this.#finishSession(session);
        });
    }

    #initialize(): void {
        try {
            durableEnsureDirectory(path.dirname(this.#rootPath), path.basename(this.#rootPath));
            const entries = readDirectoryEntriesBounded(this.#rootPath, MAXIMUM_ORPHAN_SESSION_COUNT);
            for (const entry of entries) {
                if (entry.entryKind !== "directory" || !isOwnedSessionName(entry.name)) continue;
                durableRemoveDirectoryTree(path.join(this.#rootPath, entry.name), MAXIMUM_SESSION_TREE_ENTRIES);
            }
            this.#initialized = true;
        } catch {
            this.#publish(failedSnapshot("initialization_failed", false));
        }
    }

    #createSession(): RecordingSession {
        const sessionRootPath = path.join(this.#rootPath, recordingSessionName(this.#createId()));
        const ensured = durableEnsureDirectory(this.#rootPath, path.basename(sessionRootPath));
        if (!ensured.created) throw new Error("performance-recording session directory already exists");
        return Object.freeze({
            rootPath: sessionRootPath,
            traceFilePath: path.join(sessionRootPath, PERFORMANCE_RECORDING_FILE_NAME),
        });
    }

    async #stop(): Promise<DesktopPerformanceRecordingSnapshot> {
        const session = this.#session;
        if (!this.#recordingMayBeActive || session === undefined) return this.#snapshot;
        if (this.#automaticStopTimer !== undefined) {
            this.#clearTimer(this.#automaticStopTimer);
            this.#automaticStopTimer = undefined;
        }
        try {
            const returnedPath = await this.#contentTracing.stopRecording(session.traceFilePath);
            this.#recordingMayBeActive = false;
            if (!exactPath(returnedPath, session.traceFilePath)) {
                throw new Error("Electron returned an unexpected performance trace path");
            }
            const trace = readRegularFileRangeNoFollow(session.traceFilePath, 0, 1);
            if (trace.totalBytes > DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_ARTIFACT_BYTES) {
                this.#removeSessionBestEffort(session);
                this.#session = undefined;
                this.#publish(failedSnapshot("trace_too_large", false));
                return this.#snapshot;
            }
            const stoppedAt = this.#now();
            this.#publish(
                Object.freeze({
                    state: "ready",
                    stoppedAt,
                    expiresAt: stoppedAt + DESKTOP_PERFORMANCE_RECORDING_ARTIFACT_TTL_MS,
                    byteSize: trace.totalBytes,
                }),
            );
            this.#expiryTimer = this.#setTimer(() => {
                void this.discard();
            }, DESKTOP_PERFORMANCE_RECORDING_ARTIFACT_TTL_MS);
        } catch {
            this.#publish(failedSnapshot("stop_failed", this.#recordingMayBeActive));
        }
        return this.#snapshot;
    }

    #finishSession(session: RecordingSession): void {
        this.#clearTimers();
        try {
            durableRemoveDirectoryTree(session.rootPath, MAXIMUM_SESSION_TREE_ENTRIES);
            this.#session = undefined;
            this.#recordingMayBeActive = false;
            this.#publish(idleSnapshot());
        } catch {
            this.#session = session;
            this.#publish(failedSnapshot("cleanup_failed", false));
        }
    }

    #removeSessionBestEffort(session: RecordingSession): void {
        try {
            durableRemoveDirectoryTree(session.rootPath, MAXIMUM_SESSION_TREE_ENTRIES);
        } catch {
            // The exact OAAM-owned session is retried by next-start orphan cleanup.
        }
    }

    #clearTimers(): void {
        if (this.#automaticStopTimer !== undefined) this.#clearTimer(this.#automaticStopTimer);
        if (this.#expiryTimer !== undefined) this.#clearTimer(this.#expiryTimer);
        this.#automaticStopTimer = undefined;
        this.#expiryTimer = undefined;
    }

    #publish(snapshot: DesktopPerformanceRecordingSnapshot): void {
        this.#snapshot = snapshot;
        for (const listener of this.#listeners) listener(snapshot);
    }

    #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.#tail.then(operation, operation);
        this.#tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }
}
