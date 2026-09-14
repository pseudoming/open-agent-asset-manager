import { Worker } from "node:worker_threads";
import { resolveWin32PackagedWorkerPath } from "@oaam/shared/paths";
import type { RestrictedPipeSession } from "./restricted-pipe-dispatch";
import type { RestrictedCodePackage } from "./restricted-code-package";

export interface RestrictedProcessLaunch {
    readonly session: RestrictedPipeSession;
    readonly wslExecutablePath: string;
    readonly windowsCodeRootPath: string;
    readonly distroName: string;
    readonly code: RestrictedCodePackage;
    readonly operation: unknown;
    readonly deadlineAt: number;
    readonly maximumFrameBytes: number;
    readonly maximumConcurrentRequests: number;
}

export interface RestrictedProcessTransport {
    readonly ready: Record<string, unknown>;
    readonly available: boolean;
    exchange(request: { operationId: string }): Promise<unknown>;
    exchangeSync(request: { operationId: string }): unknown;
    close(): Promise<void>;
}

/** @internal The Node Worker must use the actual unpacked file in a Windows Desktop package. */
export function resolveRestrictedProcessWorkerPath(platform: NodeJS.Platform, entry: string): string {
    return platform === "win32" ? resolveWin32PackagedWorkerPath(entry) : entry;
}

/** Internal lifecycle fact: a failed start is retryable only after owned cleanup was proved. */
export class RestrictedProcessStartError extends Error {
    public constructor(
        public readonly cleanupConfirmed: boolean,
        cause: unknown,
    ) {
        super(cause instanceof Error ? cause.message : "restricted process startup failed", { cause });
        this.name = "RestrictedProcessStartError";
    }
}

/** Windows Host transport owner. The worker keeps stdio responsive during synchronous Core execution. */
export async function startRestrictedProcessTransport(config: RestrictedProcessLaunch): Promise<RestrictedProcessTransport> {
    return startRestrictedProcessTransportForTest(config);
}

/** @internal Test-owned peers exercise the actual Worker/message/shared-memory lifecycle. */
export async function startRestrictedProcessTransportForTest(
    config: RestrictedProcessLaunch,
    createWorker: () => Worker = () =>
        new Worker(resolveRestrictedProcessWorkerPath(process.platform, require.resolve("./restricted-process-worker")), {
            workerData: config,
        }),
): Promise<RestrictedProcessTransport> {
    let worker: Worker;
    try {
        worker = createWorker();
    } catch (error) {
        throw new RestrictedProcessStartError(true, error);
    }
    const pending = new Map<
        string,
        { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
    >();
    let usable = false;
    let closing = false;
    let exitCode: number | undefined;
    let terminal: Record<string, unknown> | undefined;
    let readyValue: Record<string, unknown> | undefined;
    let resolveReady: (value: Record<string, unknown>) => void;
    let rejectReady: (error: Error) => void;
    const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    let resolveExit: () => void;
    const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
    });
    const failure = () => new Error("restricted process response is unavailable; operation must not be replayed");
    function failPending(error: Error) {
        usable = false;
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        pending.clear();
    }
    function requestClose() {
        closing = true;
        failPending(failure());
        if (exitCode === undefined) worker.postMessage({ kind: "close" });
    }
    const startupTimer = setTimeout(
        () => {
            rejectReady(failure());
            requestClose();
        },
        Math.min(15_000, Math.max(1, config.deadlineAt - Date.now())),
    );
    worker.on("message", (message: Record<string, unknown>) => {
        if (message?.kind === "ready" && readyValue === undefined && !closing) {
            if (
                message.protocol !== config.session.protocol ||
                message.hostInstanceId !== config.session.hostInstanceId ||
                message.sessionId !== config.session.sessionId
            ) {
                rejectReady(failure());
                requestClose();
                return;
            }
            clearTimeout(startupTimer);
            readyValue = message;
            usable = true;
            resolveReady(message);
        } else if (message?.kind === "response" && typeof message.operationId === "string") {
            const request = pending.get(message.operationId);
            if (request === undefined) {
                requestClose();
                return;
            }
            pending.delete(message.operationId);
            clearTimeout(request.timer);
            if (message.ok === true) request.resolve(message.value);
            else {
                request.reject(failure());
                requestClose();
            }
        } else if (message?.kind === "closed") {
            terminal = message;
            failPending(failure());
            rejectReady(failure());
        } else if (message?.kind === "failed") {
            rejectReady(failure());
            requestClose();
        } else if (message?.kind !== "spawned" && message?.kind !== "owned") {
            rejectReady(failure());
            requestClose();
        }
    });
    worker.once("error", (error) => {
        rejectReady(error);
        failPending(error);
    });
    worker.once("exit", (code) => {
        clearTimeout(startupTimer);
        exitCode = code;
        rejectReady(failure());
        failPending(failure());
        resolveExit();
    });
    async function close() {
        requestClose();
        // The process owner retains its hard target-local timeout even on startup failure.
        // Never terminate that owner while it still owns an external process.
        await exited;
        if (exitCode !== 0 || terminal?.cleanupConfirmed !== true)
            throw new Error("restricted process cleanup was not confirmed");
    }
    let initialReady: Record<string, unknown>;
    try {
        initialReady = await ready;
    } catch (error) {
        try {
            await close();
        } catch (cleanupError) {
            throw new RestrictedProcessStartError(false, cleanupError);
        }
        throw new RestrictedProcessStartError(true, error);
    }
    function encode(request: { operationId: string }): string {
        if (!usable || Date.now() >= config.deadlineAt) throw failure();
        const text = JSON.stringify(request);
        if (Buffer.byteLength(text, "utf8") > config.maximumFrameBytes) throw new Error("restricted request exceeds frame limit");
        return text;
    }
    return {
        ready: initialReady,
        get available() {
            return usable && Date.now() < config.deadlineAt;
        },
        exchange(request) {
            const text = encode(request);
            if (pending.has(request.operationId) || pending.size >= config.maximumConcurrentRequests)
                return Promise.reject(failure());
            return new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => {
                        requestClose();
                    },
                    Math.min(30_000, config.deadlineAt - Date.now()),
                );
                pending.set(request.operationId, { resolve, reject, timer });
                worker.postMessage({ kind: "exchange", operationId: request.operationId, text });
            });
        },
        exchangeSync(request) {
            const text = encode(request);
            if (pending.size !== 0 || config.maximumConcurrentRequests !== 1)
                throw new Error("synchronous restricted execution requires an exclusive transport");
            const headerMemory = new SharedArrayBuffer(8);
            const body = new SharedArrayBuffer(config.maximumFrameBytes);
            const header = new Int32Array(headerMemory);
            worker.postMessage({ kind: "exchange", operationId: request.operationId, text, header: headerMemory, body });
            Atomics.wait(header, 0, 0, Math.min(30_000, config.deadlineAt - Date.now()));
            if (Atomics.load(header, 0) !== 1) {
                Atomics.compareExchange(header, 0, 0, -2);
                requestClose();
                throw failure();
            }
            const length = Atomics.load(header, 1);
            if (length < 1 || length > config.maximumFrameBytes) {
                requestClose();
                throw failure();
            }
            try {
                return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(body, 0, length))) as unknown;
            } catch (error) {
                requestClose();
                throw error;
            }
        },
        close,
    };
}
