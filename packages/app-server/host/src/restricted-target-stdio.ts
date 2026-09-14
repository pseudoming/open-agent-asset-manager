import type { Readable, Writable } from "node:stream";

/** Absolute transport ceiling; each Core operation selects its own smaller budget. */
export const MAXIMUM_RESTRICTED_FRAME_BYTES = 32 * 1024 * 1024;

/** Byte-framed, strictly decoded JSON lines for the private inherited pipe. */
export function createRestrictedJsonFrames(maximumBytes: number, receive: (value: unknown) => void) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAXIMUM_RESTRICTED_FRAME_BYTES) {
        throw new Error("invalid restricted frame limit");
    }
    let pending = Buffer.alloc(0);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return {
        push(chunk: Uint8Array) {
            let offset = 0;
            for (let index = 0; index < chunk.byteLength; index += 1) {
                if (chunk[index] !== 10) continue;
                if (pending.byteLength + index - offset > maximumBytes) throw new Error("restricted frame exceeds limit");
                const frame = Buffer.concat([pending, chunk.subarray(offset, index)]);
                pending = Buffer.alloc(0);
                if (frame.byteLength === 0) throw new Error("empty restricted frame");
                receive(JSON.parse(decoder.decode(frame)) as unknown);
                offset = index + 1;
            }
            if (pending.byteLength + chunk.byteLength - offset > maximumBytes) throw new Error("restricted frame exceeds limit");
            pending = Buffer.concat([pending, chunk.subarray(offset)]);
        },
        finish() {
            if (pending.byteLength !== 0) throw new Error("truncated restricted frame");
        },
    };
}

/** The Host owns only inherited stdio and lifecycle. Its already-constructed
 * Core service owns request validation, target execution and recovery guards. */
export function runRestrictedTargetStdio(input: {
    service: { handle(request: unknown): unknown; close?(): void };
    session: { protocol: string; hostInstanceId: string; sessionId: string };
    processIdentity: {
        processId: number;
        lifecycleToken: string;
        parentIdentity?: { processId: number; lifecycleToken: string };
    };
    startupTiming?: {
        nodeEntryMilliseconds: number;
        runtimeValidationMilliseconds?: number;
        codeVerificationMilliseconds: number;
        compositionMilliseconds: number;
        processMaximumRssKiB: number;
    };
    deadlineAt: number;
    maximumFrameBytes: number;
    maximumConcurrentRequests?: number;
    stdin: Readable;
    stdout: Writable;
}): Promise<{ reason: "shutdown" | "eof" | "deadline" | "idle" | "invalid" }> {
    const remaining = input.deadlineAt - Date.now();
    const maximumConcurrentRequests = input.maximumConcurrentRequests ?? 1;
    if (!Number.isSafeInteger(input.deadlineAt) || remaining <= 0 || remaining > 600_000) {
        throw new Error("invalid restricted host lifetime");
    }
    if (!Number.isSafeInteger(maximumConcurrentRequests) || maximumConcurrentRequests < 1 || maximumConcurrentRequests > 16) {
        throw new Error("invalid restricted request concurrency");
    }
    return new Promise((resolve) => {
        let closed = false;
        let pending = 0;
        let writeBlocked = false;
        const drainWaiters = new Set<() => void>();
        let terminalReason: "shutdown" | "eof" | "deadline" | "idle" | "invalid" = "invalid";
        let idle: ReturnType<typeof setTimeout>;
        const deadline = setTimeout(() => close("deadline"), remaining);
        const close = (reason: "shutdown" | "eof" | "deadline" | "idle" | "invalid") => {
            if (closed) return;
            closed = true;
            terminalReason = reason;
            try {
                input.service.close?.();
            } catch {
                terminalReason = "invalid";
            }
            clearTimeout(deadline);
            clearTimeout(idle);
            input.stdin.removeListener("data", onData);
            input.stdin.removeListener("end", onEnd);
            input.stdin.removeListener("error", onError);
            if (input.stdout.writableLength === 0) input.stdout.removeListener("error", onError);
            else input.stdout.once("close", () => input.stdout.removeListener("error", onError));
            input.stdout.removeListener("drain", onDrain);
            for (const release of drainWaiters) release();
            drainWaiters.clear();
            input.stdin.pause();
            if (pending === 0) resolve({ reason: terminalReason });
        };
        const touch = () => {
            clearTimeout(idle);
            idle = setTimeout(() => close("idle"), 30_000);
        };
        function onDrain() {
            writeBlocked = false;
            const waiters = [...drainWaiters];
            drainWaiters.clear();
            for (const release of waiters) release();
        }
        function waitForDrain(): Promise<void> {
            return new Promise((resolve) => drainWaiters.add(resolve));
        }
        function writeFrame(encoded: Buffer): void | Promise<void> {
            if (closed) return;
            if (writeBlocked) return waitForDrain().then(() => writeFrame(encoded));
            if (input.stdout.write(encoded)) {
                touch();
                return;
            }
            writeBlocked = true;
            input.stdin.pause();
            input.stdout.once("drain", onDrain);
            return waitForDrain();
        }
        const frames = createRestrictedJsonFrames(input.maximumFrameBytes, (value) => {
            if (closed) return;
            touch();
            const shutdown = value as Record<string, unknown> | null;
            if (
                shutdown?.kind === "shutdown" &&
                Object.keys(shutdown).length === 4 &&
                shutdown.protocol === input.session.protocol &&
                shutdown.hostInstanceId === input.session.hostInstanceId &&
                shutdown.sessionId === input.session.sessionId
            ) {
                close("shutdown");
                return;
            }
            if (pending >= maximumConcurrentRequests) throw new Error("restricted request concurrency exceeded");
            pending += 1;
            const complete = () => {
                pending -= 1;
                if (closed && pending === 0) resolve({ reason: terminalReason });
                else if (!closed && !writeBlocked && pending < maximumConcurrentRequests) input.stdin.resume();
            };
            const publish = (response: unknown) => {
                if (closed) return;
                const encoded = Buffer.from(JSON.stringify(response) + "\n", "utf8");
                if (encoded.byteLength > input.maximumFrameBytes + 1) throw new Error("restricted response exceeds limit");
                // Pending operation count also bounds encoded responses waiting for drain.
                // A full writable buffer is normal flow control, not a failed peer.
                return writeFrame(encoded);
            };
            const finish = (response: unknown) => {
                try {
                    const draining = publish(response);
                    if (draining instanceof Promise)
                        void draining.then(complete, () => {
                            close("invalid");
                            complete();
                        });
                    else complete();
                } catch {
                    close("invalid");
                    complete();
                }
            };
            try {
                const response = input.service.handle(value);
                if (response instanceof Promise) {
                    void response.then(finish, () => {
                        close("invalid");
                        complete();
                    });
                } else {
                    finish(response);
                }
            } catch (error) {
                complete();
                throw error;
            }
        });
        function onData(chunk: Buffer) {
            try {
                frames.push(chunk);
            } catch {
                close("invalid");
            }
        }
        function onEnd() {
            try {
                frames.finish();
                close("eof");
            } catch {
                close("invalid");
            }
        }
        function onError() {
            close("invalid");
        }
        input.stdin.on("data", onData);
        input.stdin.once("end", onEnd);
        input.stdin.once("error", onError);
        input.stdout.once("error", onError);
        touch();
        const readyDrain = writeFrame(
            Buffer.from(
                JSON.stringify({
                    kind: "ready",
                    ...input.session,
                    processIdentity: input.processIdentity,
                    ...(input.startupTiming === undefined ? {} : { startupTiming: input.startupTiming }),
                }) + "\n",
            ),
        );
        if (readyDrain instanceof Promise)
            void readyDrain.then(() => {
                if (!closed && pending === 0 && !writeBlocked) input.stdin.resume();
            });
    });
}
