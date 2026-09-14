import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestrictedJsonFrames, runRestrictedTargetStdio } from "../src/restricted-target-stdio";

const controlStreams: PassThrough[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const stream of controlStreams.splice(0)) stream.destroy();
});
function control(highWaterMark = 256) {
    const stdin = new PassThrough(),
        stdout = new PassThrough({ highWaterMark });
    controlStreams.push(stdin, stdout);
    const session = { protocol: "v1", hostInstanceId: "host", sessionId: "session" };
    const service = { handle: vi.fn((_value: unknown): unknown => ({ accepted: true })), close: vi.fn() };
    return {
        stdin,
        stdout,
        session,
        service,
        processIdentity: { processId: 10, lifecycleToken: "100" },
        deadlineAt: Date.now() + 60_000,
        maximumFrameBytes: 4096,
        maximumConcurrentRequests: 2,
    };
}

describe("restricted target inherited-pipe framing", () => {
    it("ignores remaining frames in the same received chunk after shutdown", async () => {
        const f = control();
        f.stdout.resume();
        const completion = runRestrictedTargetStdio(f);
        f.stdin.write(JSON.stringify({ kind: "shutdown", ...f.session }) + "\n{}\n");
        expect(await completion).toEqual({ reason: "shutdown" });
        expect(f.service.handle).not.toHaveBeenCalled();
        expect(f.service.close).toHaveBeenCalledOnce();
    });
    it.each([NaN, 0, 700_000])("rejects invalid remaining lifetime %s before installing listeners", (remaining) => {
        const f = control();
        expect(() => runRestrictedTargetStdio({ ...f, deadlineAt: Date.now() + remaining })).toThrow(
            "invalid restricted host lifetime",
        );
        expect(f.stdin.listenerCount("data")).toBe(0);
    });
    it.each([NaN, 0, 17])("rejects invalid request concurrency %s", (maximumConcurrentRequests) => {
        expect(() => runRestrictedTargetStdio({ ...control(), maximumConcurrentRequests })).toThrow(
            "invalid restricted request concurrency",
        );
    });
    it.each([
        "oversized",
        "close_error",
        "truncated",
    ] as const)("reports %s as invalid and closes the original service", async (failure) => {
        const f = control();
        f.stdout.resume();
        if (failure === "oversized") f.service.handle.mockReturnValue("x".repeat(4096));
        if (failure === "close_error")
            f.service.close.mockImplementation(() => {
                throw new Error("release failed");
            });
        const completion = runRestrictedTargetStdio(f);
        f.stdin.end(failure === "truncated" ? "{" : failure === "oversized" ? "{}\n" : "");
        expect(await completion).toEqual({ reason: "invalid" });
        expect(f.service.close).toHaveBeenCalledOnce();
    });
    it.each(["drain", "close"] as const)("handles ready-frame backpressure through %s", async (terminal) => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        const f = control(1),
            lines: unknown[] = [];
        const completion = runRestrictedTargetStdio(f);
        expect(f.stdout.writableNeedDrain).toBe(true);
        expect(f.stdin.isPaused()).toBe(true);
        if (terminal === "drain") {
            f.stdout.on("data", (bytes: Buffer) => lines.push(JSON.parse(bytes.toString("utf8"))));
            await vi.waitFor(() => expect(f.stdin.isPaused()).toBe(false));
            f.stdin.end();
            expect(await completion).toEqual({ reason: "eof" });
            expect(lines).toEqual([expect.objectContaining({ kind: "ready" })]);
        } else {
            await vi.advanceTimersByTimeAsync(30_000);
            expect(await completion).toEqual({ reason: "idle" });
            // Buffered output retains its error guard until its actual close event.
            f.stdout.emit("error", new Error("late output error"));
            expect(f.service.close).toHaveBeenCalledOnce();
            f.stdout.destroy();
            await new Promise<void>((resolve) => f.stdout.once("close", resolve));
            expect(f.stdout.listenerCount("error")).toBe(0);
        }
    });
    it.each([
        "success",
        "write_failure",
        "stream_failure",
    ] as const)("drains two concurrent responses with %s without replay", async (outcome) => {
        const f = control(),
            lines: { kind?: string; id?: string }[] = [],
            responses: ((value: unknown) => void)[] = [];
        f.stdout.on("data", (bytes: Buffer) => {
            const line = JSON.parse(bytes.toString("utf8")) as { kind?: string; id?: string };
            lines.push(line);
            if (line.kind === "ready") f.stdout.pause();
        });
        f.service.handle.mockImplementation(() => new Promise((resolve) => responses.push(resolve)));
        const write = f.stdout.write.bind(f.stdout);
        if (outcome === "write_failure")
            vi.spyOn(f.stdout, "write").mockImplementation((chunk: Uint8Array) => {
                if (Buffer.from(chunk).toString("utf8").includes('"id":"second"')) throw new Error("second write failed");
                return write(chunk);
            });
        const completion = runRestrictedTargetStdio(f);
        f.stdin.write("{}\n{}\n");
        expect(responses).toHaveLength(2);
        responses[0]!({ id: "first", payload: "x".repeat(2048) });
        await Promise.resolve();
        responses[1]!({ id: "second", payload: "y".repeat(2048) });
        await Promise.resolve();
        expect(f.stdout.writableNeedDrain).toBe(true);
        expect(lines).toHaveLength(1);
        if (outcome === "stream_failure") f.stdin.emit("error", new Error("input failed"));
        else f.stdout.resume();
        if (outcome === "success") {
            await vi.waitFor(() => expect(lines.map((value) => value.id)).toEqual([undefined, "first", "second"]));
            f.stdin.end();
        }
        expect(await completion).toEqual({ reason: outcome === "success" ? "eof" : "invalid" });
        expect(f.service.handle).toHaveBeenCalledTimes(2);
        expect(f.service.close).toHaveBeenCalledOnce();
        if (outcome === "write_failure") expect(lines.map((value) => value.id)).toEqual([undefined, "first"]);
        if (outcome === "stream_failure") expect(lines).toHaveLength(1);
    });
    it("assembles split UTF-8 bytes and multiple bounded frames without changing content", () => {
        const received: unknown[] = [];
        const frames = createRestrictedJsonFrames(1024, (value) => received.push(value));
        const bytes = Buffer.from(JSON.stringify({ text: "目标\nfile" }) + "\n" + JSON.stringify({ second: true }) + "\n");
        for (const byte of bytes) frames.push(new Uint8Array([byte]));
        frames.finish();
        expect(received).toEqual([{ text: "目标\nfile" }, { second: true }]);
    });

    it("rejects oversized, invalid UTF-8, empty, malformed and truncated frames", () => {
        expect(() => createRestrictedJsonFrames(0, () => undefined)).toThrow(/limit/);
        expect(() => createRestrictedJsonFrames(2, () => undefined).push(Buffer.from("{} \n"))).toThrow(/limit/);
        expect(() => createRestrictedJsonFrames(2, () => undefined).push(Buffer.from("abc"))).toThrow(/limit/);
        expect(() => createRestrictedJsonFrames(100, () => undefined).push(Buffer.from([0xff, 10]))).toThrow();
        expect(() => createRestrictedJsonFrames(100, () => undefined).push(Buffer.from("\n"))).toThrow(/empty/);
        expect(() => createRestrictedJsonFrames(100, () => undefined).push(Buffer.from("bad\n"))).toThrow();
        const partial = createRestrictedJsonFrames(100, () => undefined);
        partial.push(Buffer.from("{}"));
        expect(() => partial.finish()).toThrow(/truncated/);
    });

    it("passes received operations to the supplied Core service and closes only its own session", async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const lines: unknown[] = [];
        const output = createRestrictedJsonFrames(1024, (value) => lines.push(value));
        stdout.on("data", (chunk: Buffer) => output.push(chunk));
        const requests: unknown[] = [];
        const session = { protocol: "oaam.restricted-target.v1", hostInstanceId: "host", sessionId: "session" };
        const completion = runRestrictedTargetStdio({
            service: {
                handle(request) {
                    requests.push(request);
                    return { accepted: request };
                },
            },
            session,
            processIdentity: { processId: 10, lifecycleToken: "100" },
            deadlineAt: Date.now() + 10_000,
            maximumFrameBytes: 1024,
            stdin,
            stdout,
        });
        stdin.write(JSON.stringify({ operation: "bounded" }) + "\n");
        stdin.write(JSON.stringify({ kind: "shutdown", ...session }) + "\n");
        expect(await completion).toEqual({ reason: "shutdown" });
        expect(requests).toEqual([{ operation: "bounded" }]);
        expect(lines).toEqual([
            { kind: "ready", ...session, processIdentity: { processId: 10, lifecycleToken: "100" } },
            { accepted: { operation: "bounded" } },
        ]);
        stdin.destroy();
        stdout.destroy();
    });

    it("closes a malformed request without claiming target execution success", async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        let calls = 0;
        const completion = runRestrictedTargetStdio({
            service: {
                handle() {
                    calls += 1;
                    throw new Error("unapproved operation");
                },
            },
            session: { protocol: "v1", hostInstanceId: "host", sessionId: "session" },
            processIdentity: { processId: 10, lifecycleToken: "100" },
            deadlineAt: Date.now() + 10_000,
            maximumFrameBytes: 1024,
            stdin,
            stdout,
        });
        stdin.end("{}\n");
        expect(await completion).toEqual({ reason: "invalid" });
        expect(calls).toBe(1);
        stdin.destroy();
        stdout.destroy();
    });

    it("returns bounded concurrent read responses independently and drains pending work before shutdown", async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const lines: unknown[] = [];
        const output = createRestrictedJsonFrames(1024, (value) => lines.push(value));
        stdout.on("data", (chunk: Buffer) => output.push(chunk));
        const pending = new Map<string, (value: unknown) => void>();
        const session = { protocol: "probe-v1", hostInstanceId: "host", sessionId: "session" };
        const completion = runRestrictedTargetStdio({
            service: {
                handle(value) {
                    return new Promise((resolve) => pending.set((value as { id: string }).id, resolve));
                },
            },
            session,
            processIdentity: { processId: 10, lifecycleToken: "100" },
            deadlineAt: Date.now() + 10_000,
            maximumFrameBytes: 1024,
            maximumConcurrentRequests: 2,
            stdin,
            stdout,
        });
        stdin.write('{"id":"first"}\n{"id":"second"}\n');
        pending.get("second")!({ id: "second", result: "observed" });
        await Promise.resolve();
        expect(lines.slice(1)).toEqual([{ id: "second", result: "observed" }]);
        let finished = false;
        void completion.then(() => {
            finished = true;
        });
        stdin.write(JSON.stringify({ kind: "shutdown", ...session }) + "\n");
        await Promise.resolve();
        expect(finished).toBe(false);
        pending.get("first")!({ id: "first", result: "late" });
        expect(await completion).toEqual({ reason: "shutdown" });
        expect(lines.slice(1)).toEqual([{ id: "second", result: "observed" }]);
        stdin.destroy();
        stdout.destroy();
    });

    it("rejects excess concurrent input while waiting for already-started work to finish", async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        let settle!: (value: unknown) => void;
        let calls = 0;
        const completion = runRestrictedTargetStdio({
            service: {
                handle() {
                    calls += 1;
                    return new Promise((resolve) => {
                        settle = resolve;
                    });
                },
            },
            session: { protocol: "v1", hostInstanceId: "host", sessionId: "session" },
            processIdentity: { processId: 10, lifecycleToken: "100" },
            deadlineAt: Date.now() + 10_000,
            maximumFrameBytes: 1024,
            stdin,
            stdout,
        });
        stdin.write("{}\n{}\n");
        expect(calls).toBe(1);
        settle({ completed: true });
        expect(await completion).toEqual({ reason: "invalid" });
        stdin.destroy();
        stdout.destroy();
    });

    it("closes a rejected asynchronous Core operation without an unhandled rejection", async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const completion = runRestrictedTargetStdio({
            service: {
                async handle() {
                    throw new Error("Provider channel failed");
                },
            },
            session: { protocol: "v1", hostInstanceId: "host", sessionId: "session" },
            processIdentity: { processId: 10, lifecycleToken: "100" },
            deadlineAt: Date.now() + 10_000,
            maximumFrameBytes: 1024,
            stdin,
            stdout,
        });
        stdin.write("{}\n");
        expect(await completion).toEqual({ reason: "invalid" });
        stdin.destroy();
        stdout.destroy();
    });

    it("drains a real response above highWaterMark after delayed consumption and accepts the next request", async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough({ highWaterMark: 256 });
        const lines: unknown[] = [];
        let receiveLarge!: () => void;
        let receiveNext!: () => void;
        const largeReceived = new Promise<void>((resolve) => {
            receiveLarge = resolve;
        });
        const nextReceived = new Promise<void>((resolve) => {
            receiveNext = resolve;
        });
        const output = createRestrictedJsonFrames(16_384, (value) => {
            lines.push(value);
            const response = value as { kind?: string; id?: string };
            if (response.kind === "ready") stdout.pause();
            if (response.id === "large") receiveLarge();
            if (response.id === "next") receiveNext();
        });
        stdout.on("data", (chunk: Buffer) => output.push(chunk));
        const session = { protocol: "v1", hostInstanceId: "host", sessionId: "session" };
        const text = "data".repeat(2_048);
        const completion = runRestrictedTargetStdio({
            service: {
                handle(request) {
                    const id = (request as { id: string }).id;
                    return { id, text: id === "large" ? text : "next" };
                },
            },
            session,
            processIdentity: { processId: 10, lifecycleToken: "100" },
            deadlineAt: Date.now() + 10_000,
            maximumFrameBytes: 16_384,
            stdin,
            stdout,
        });
        stdin.write('{"id":"large"}\n');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(stdout.writableNeedDrain).toBe(true);
        expect(lines).toHaveLength(1);
        stdout.resume();
        await largeReceived;
        stdin.write('{"id":"next"}\n');
        await nextReceived;
        stdin.write(JSON.stringify({ kind: "shutdown", ...session }) + "\n");
        expect(await completion).toEqual({ reason: "shutdown" });
        expect(lines.slice(1)).toEqual([
            { id: "large", text },
            { id: "next", text: "next" },
        ]);
        stdin.destroy();
        stdout.destroy();
    });
});
