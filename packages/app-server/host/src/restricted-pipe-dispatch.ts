import type { Writable } from "node:stream";
import { MAXIMUM_RESTRICTED_FRAME_BYTES } from "./restricted-target-stdio";

export interface RestrictedPipeSession {
    readonly protocol: string;
    readonly hostInstanceId: string;
    readonly sessionId: string;
}

export interface RestrictedPipeRequest {
    readonly operationId: string;
    readonly text: string;
    complete(value: unknown): void;
    fail(): void;
}

/** Bounded in-flight routing. Core owns operation lifetime, sequence, replay and result authority. */
export function createRestrictedPipeDispatch(input: {
    readonly session: RestrictedPipeSession;
    readonly maximumFrameBytes: number;
    readonly maximumConcurrentRequests: number;
    readonly stdin: Writable;
    readonly onInvalid: () => void;
}) {
    if (
        !Number.isSafeInteger(input.maximumFrameBytes) ||
        input.maximumFrameBytes < 1 ||
        input.maximumFrameBytes > MAXIMUM_RESTRICTED_FRAME_BYTES ||
        !Number.isSafeInteger(input.maximumConcurrentRequests) ||
        input.maximumConcurrentRequests < 1 ||
        input.maximumConcurrentRequests > 16
    )
        throw new Error("invalid restricted pipe bounds");
    const pending = new Map<string, RestrictedPipeRequest>();
    let accepting = true;
    input.stdin.on("error", () => invalidate());

    function stop(shutdown: boolean) {
        if (!accepting) return;
        accepting = false;
        const requests = [...pending.values()];
        pending.clear();
        for (const request of requests) request.fail();
        if (!input.stdin.destroyed && !input.stdin.writableEnded) {
            input.stdin.end(shutdown ? JSON.stringify({ kind: "shutdown", ...input.session }) + "\n" : undefined);
        }
    }
    function invalidate() {
        if (!accepting) return;
        stop(false);
        input.onInvalid();
    }
    function matchesSession(value: unknown): value is Record<string, unknown> {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
        const record = value as Record<string, unknown>;
        return (
            record.protocol === input.session.protocol &&
            record.hostInstanceId === input.session.hostInstanceId &&
            record.sessionId === input.session.sessionId
        );
    }
    return {
        submit(request: RestrictedPipeRequest): void {
            if (!accepting) {
                request.fail();
                return;
            }
            let registered = false;
            try {
                const value: unknown = JSON.parse(request.text);
                if (
                    !matchesSession(value) ||
                    value.operationId !== request.operationId ||
                    !/^[a-f0-9-]{36}$/u.test(request.operationId) ||
                    pending.has(request.operationId) ||
                    pending.size >= input.maximumConcurrentRequests ||
                    Buffer.byteLength(request.text, "utf8") > input.maximumFrameBytes
                )
                    throw new Error("invalid restricted pipe request");
                pending.set(request.operationId, request);
                registered = true;
                // Node may buffer up to the already bounded pending count. write(false)
                // is ordinary backpressure and never licenses a replay or extra request.
                input.stdin.write(request.text + "\n");
            } catch {
                if (!registered) request.fail();
                invalidate();
            }
        },
        receive(value: unknown): void {
            if (!accepting) return;
            try {
                if (!matchesSession(value) || typeof value.operationId !== "string")
                    throw new Error("foreign restricted response");
                const request = pending.get(value.operationId);
                if (request === undefined) throw new Error("unknown restricted response");
                if (Buffer.byteLength(JSON.stringify(value), "utf8") > input.maximumFrameBytes)
                    throw new Error("oversized restricted response");
                request.complete(value);
                pending.delete(request.operationId);
            } catch {
                invalidate();
            }
        },
        close(): void {
            stop(true);
        },
        fail(): void {
            invalidate();
        },
        get pendingCount(): number {
            return pending.size;
        },
    };
}
