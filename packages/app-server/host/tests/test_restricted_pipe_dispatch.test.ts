import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRestrictedPipeDispatch, type RestrictedPipeRequest } from "../src/restricted-pipe-dispatch";

const session = { protocol: "oaam.restricted-probe.v1", hostInstanceId: randomUUID(), sessionId: randomUUID() };
function fixture(concurrency = 3, maximumFrameBytes = 16_384) {
    const stdin = new PassThrough({ highWaterMark: 32 });
    const invalid = vi.fn();
    const dispatch = createRestrictedPipeDispatch({
        session,
        maximumConcurrentRequests: concurrency,
        maximumFrameBytes,
        stdin,
        onInvalid: invalid,
    });
    function request(): RestrictedPipeRequest & { complete: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } {
        const operationId = randomUUID();
        return {
            operationId,
            text: JSON.stringify({ ...session, operationId, payload: "x".repeat(64) }),
            complete: vi.fn(),
            fail: vi.fn(),
        };
    }
    return {
        dispatch,
        stdin,
        invalid,
        request,
        response: (r: RestrictedPipeRequest) => ({ ...session, operationId: r.operationId, result: "done" }),
    };
}

describe("restricted pipe operation routing", () => {
    it.each([
        [0, 10],
        [17, 10],
        [NaN, 10],
        [1, 0],
        [1, NaN],
        [1, 32 * 1024 * 1024 + 1],
    ])("rejects invalid concurrency/frame bounds %s/%s", (concurrency, maximumFrameBytes) => {
        const stdin = new PassThrough();
        expect(() =>
            createRestrictedPipeDispatch({
                session,
                maximumConcurrentRequests: concurrency!,
                maximumFrameBytes: maximumFrameBytes!,
                stdin,
                onInvalid: vi.fn(),
            }),
        ).toThrow("invalid restricted pipe bounds");
        stdin.destroy();
    });
    it("rejects a request after close without writing it or invalidating a second time", () => {
        const f = fixture();
        f.dispatch.close();
        const request = f.request();
        f.dispatch.submit(request);
        expect(request.fail).toHaveBeenCalledOnce();
        expect(request.complete).not.toHaveBeenCalled();
        expect(f.dispatch.pendingCount).toBe(0);
        expect(f.invalid).not.toHaveBeenCalled();
        f.stdin.destroy();
    });
    it.each([null, 1, []])("retires a non-object request %j before registration", (value) => {
        const f = fixture(),
            request = { ...f.request(), text: JSON.stringify(value) };
        f.dispatch.submit(request);
        expect(request.fail).toHaveBeenCalledOnce();
        expect(f.invalid).toHaveBeenCalledOnce();
        expect(f.dispatch.pendingCount).toBe(0);
        f.stdin.destroy();
    });
    it("fails a registered request when the physical write throws", () => {
        const f = fixture(),
            request = f.request();
        const write = vi.spyOn(f.stdin, "write").mockImplementation(() => {
            throw new Error("write rejected");
        });
        f.dispatch.submit(request);
        expect(request.fail).toHaveBeenCalledOnce();
        expect(request.complete).not.toHaveBeenCalled();
        expect(f.invalid).toHaveBeenCalledOnce();
        expect(f.dispatch.pendingCount).toBe(0);
        write.mockRestore();
        f.stdin.destroy();
    });
    it("fails the request if its completion consumer throws before delivery", () => {
        const f = fixture();
        const request = f.request();
        request.complete.mockImplementation(() => {
            throw new Error("delivery failed");
        });
        f.dispatch.submit(request);
        f.dispatch.receive(f.response(request));
        expect(request.fail).toHaveBeenCalledTimes(1);
        expect(f.invalid).toHaveBeenCalledTimes(1);
        expect(f.dispatch.pendingCount).toBe(0);
        f.stdin.destroy();
    });

    it("routes concurrent read responses by operation while input is backpressured", async () => {
        const f = fixture();
        const first = f.request();
        const second = f.request();
        f.dispatch.submit(first);
        f.dispatch.submit(second);
        expect(f.stdin.writableNeedDrain).toBe(true);
        f.dispatch.receive(f.response(second));
        expect(second.complete).toHaveBeenCalledWith(f.response(second));
        expect(first.complete).not.toHaveBeenCalled();
        expect(f.dispatch.pendingCount).toBe(1);
        const received: Buffer[] = [];
        f.stdin.on("data", (chunk: Buffer) => received.push(chunk));
        f.dispatch.receive(f.response(first));
        f.dispatch.close();
        await new Promise<void>((resolve) => f.stdin.once("end", resolve));
        expect(
            Buffer.concat(received)
                .toString("utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line)),
        ).toEqual([JSON.parse(first.text), JSON.parse(second.text), { kind: "shutdown", ...session }]);
        expect(first.complete).toHaveBeenCalledTimes(1);
        expect(first.fail).not.toHaveBeenCalled();
        expect(second.fail).not.toHaveBeenCalled();
        expect(f.invalid).not.toHaveBeenCalled();
    });

    it.each([
        "session",
        "host",
        "operation",
        "oversized",
        "duplicate",
    ])("invalidates pending calls for a %s response violation without replay", (kind) => {
        const f = fixture();
        const first = f.request();
        const second = f.request();
        f.dispatch.submit(first);
        f.dispatch.submit(second);
        const value = f.response(first);
        if (kind === "session") value.sessionId = randomUUID();
        if (kind === "host") value.hostInstanceId = randomUUID();
        if (kind === "operation") value.operationId = randomUUID();
        if (kind === "oversized") value.result = "x".repeat(16_384);
        if (kind === "duplicate") f.dispatch.receive(value);
        f.dispatch.receive(value);
        expect(f.invalid).toHaveBeenCalledTimes(1);
        expect(second.fail).toHaveBeenCalledTimes(1);
        expect(first.fail).toHaveBeenCalledTimes(kind === "duplicate" ? 0 : 1);
        expect(first.complete).toHaveBeenCalledTimes(kind === "duplicate" ? 1 : 0);
        expect(f.dispatch.pendingCount).toBe(0);
        f.dispatch.receive(f.response(second));
        expect(second.complete).not.toHaveBeenCalled();
        f.stdin.destroy();
    });

    it("enforces the one-operation mutation boundary and fails each request once", () => {
        const f = fixture(1);
        const first = f.request();
        const second = f.request();
        f.dispatch.submit(first);
        f.dispatch.submit(second);
        expect(first.fail).toHaveBeenCalledTimes(1);
        expect(second.fail).toHaveBeenCalledTimes(1);
        expect(f.invalid).toHaveBeenCalledTimes(1);
        expect(first.complete).not.toHaveBeenCalled();
        f.stdin.destroy();
    });

    it("rejects an in-flight duplicate without replacing the original pending request", () => {
        const f = fixture();
        const request = f.request();
        const duplicate = { ...request, complete: vi.fn(), fail: vi.fn() };
        f.dispatch.submit(request);
        f.dispatch.submit(duplicate);
        expect(request.complete).not.toHaveBeenCalled();
        expect(request.fail).toHaveBeenCalledTimes(1);
        expect(duplicate.complete).not.toHaveBeenCalled();
        expect(duplicate.fail).toHaveBeenCalledTimes(1);
        expect(f.dispatch.pendingCount).toBe(0);
        expect(f.invalid).toHaveBeenCalledTimes(1);
        f.stdin.destroy();
    });

    it("ends a failed stream once when error and explicit close race", async () => {
        const f = fixture();
        const request = f.request();
        f.dispatch.submit(request);
        f.stdin.destroy(new Error("broken pipe"));
        await new Promise<void>((resolve) => f.stdin.once("close", resolve));
        f.dispatch.close();
        f.dispatch.fail();
        expect(request.fail).toHaveBeenCalledTimes(1);
        expect(f.invalid).toHaveBeenCalledTimes(1);
        expect(f.dispatch.pendingCount).toBe(0);
    });
});
