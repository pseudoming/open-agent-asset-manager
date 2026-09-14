import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    RestrictedProcessStartError,
    startRestrictedProcessTransport,
    startRestrictedProcessTransportForTest,
    type RestrictedProcessLaunch,
} from "../src/restricted-process-client";

afterEach(() => vi.restoreAllMocks());

// A real Worker owns the synthetic pipe peer. No external process or target filesystem is opened.
const PEER = `
const { parentPort: port, workerData: data } = require('node:worker_threads');
const timers = new Set();
let ordinal = 0;
if (data.mode === 'startup-failure') port.postMessage({ kind: 'failed' });
else if (data.mode === 'startup-error') setImmediate(() => { throw new Error('worker startup error'); });
else if (data.mode === 'startup-null') port.postMessage(null);
else if (data.mode === 'startup-unknown') port.postMessage({ kind: 'unexpected' });
else if (data.mode !== 'startup-silent') {
  if (data.mode === 'informational') { port.postMessage({ kind: 'spawned' }); port.postMessage({ kind: 'owned' }); }
  const ready = { kind: 'ready', ...data.session };
  if (data.mode.startsWith('foreign-')) ready[data.mode.slice(8)] = 'foreign';
  port.postMessage(ready);
}
port.on('message', (request) => {
  if (request.kind === 'close') {
    for (const timer of timers) clearTimeout(timer);
    port.postMessage({ kind: 'closed', cleanupConfirmed: data.mode !== 'cleanup-failure' });
    port.close(); return;
  }
  if (data.mode === 'lost') return;
  if (data.mode === 'unknown-control') { port.postMessage({ kind: 'unexpected' }); return; }
  const reply = () => {
    const value = { ...data.session, operationId: request.operationId, result: JSON.parse(request.text).payload };
    if (request.header) {
      const header = new Int32Array(request.header);
      const bytes = Buffer.from(data.mode === 'invalid-sync' ? '{' : JSON.stringify(value));
      new Uint8Array(request.body).set(bytes);
      Atomics.store(header, 1, data.mode === 'zero-sync' ? 0 : data.mode === 'oversized-sync' ? request.body.byteLength + 1 : bytes.length);
      Atomics.store(header, 0, data.mode === 'failed-sync' ? -1 : 1); Atomics.notify(header, 0);
    } else port.postMessage({ kind: 'response', operationId: data.mode === 'foreign-operation' ? data.session.sessionId : request.operationId, ok: data.mode !== 'response-failed', value });
  };
  const timer = setTimeout(reply, ordinal++ === 0 ? 30 : 1); timers.add(timer);
});
`;

function config(maximumConcurrentRequests: number, deadline = 2_000): RestrictedProcessLaunch {
    return {
        session: { protocol: "test.restricted.v1", hostInstanceId: randomUUID(), sessionId: randomUUID() },
        wslExecutablePath: "unused-by-test-peer",
        windowsCodeRootPath: "C:\\OAAM\\code",
        distroName: "Ubuntu",
        code: {
            rootPath: "/unused-by-test-peer",
            manifest: {
                schemaVersion: 1,
                platform: "linux",
                architecture: "x64",
                nodeVersion: "22.14.0",
                nodeModulesVersion: "127",
                files: [],
            },
        },
        operation: {},
        deadlineAt: Date.now() + deadline,
        maximumConcurrentRequests,
        maximumFrameBytes: 16_384,
    };
}

async function start(mode = "normal", concurrency = 3, deadline = 2_000) {
    const launch = config(concurrency, deadline);
    const worker = new Worker(PEER, { eval: true, workerData: { mode, session: launch.session } });
    let exited = false;
    worker.once("exit", () => {
        exited = true;
    });
    const transport = await startRestrictedProcessTransportForTest(launch, () => worker);
    return {
        transport,
        deadlineAt: launch.deadlineAt,
        exited: () => exited,
        request: (payload: string) => ({ ...launch.session, operationId: randomUUID(), payload }),
    };
}

describe("restricted process client with a real worker peer", () => {
    it("still joins the owner when the startup deadline has already elapsed", async () => {
        await expect(start("startup-silent", 1, -1)).rejects.toMatchObject({ cleanupConfirmed: true });
    });
    it("reports a constructor rejection without inventing external ownership", async () => {
        await expect(
            startRestrictedProcessTransportForTest(config(1), () => {
                throw "constructor refused";
            }),
        ).rejects.toMatchObject({ cleanupConfirmed: true, message: "restricted process startup failed" });
    });
    it("rejects the ordinary worker entry in this Linux source checkout without a Windows launch", async () => {
        await expect(startRestrictedProcessTransport(config(1, 500))).rejects.toBeInstanceOf(RestrictedProcessStartError);
    });
    it.each([
        "foreign-protocol",
        "foreign-hostInstanceId",
        "foreign-sessionId",
        "startup-null",
        "startup-unknown",
        "startup-silent",
    ])("joins confirmed cleanup after %s startup rejection", async (mode) => {
        await expect(start(mode, 1, 200)).rejects.toMatchObject({ cleanupConfirmed: true });
    });
    it("reports unconfirmed cleanup when the Worker itself errors before readiness", async () => {
        await expect(start("startup-error", 1)).rejects.toMatchObject({ cleanupConfirmed: false });
    });
    it("waits for ready through owned and spawned informational messages", async () => {
        const f = await start("informational", 1);
        expect(f.transport.ready.kind).toBe("ready");
        await f.transport.close();
        expect(f.exited()).toBe(true);
    });
    it.each([
        "foreign-operation",
        "response-failed",
        "unknown-control",
    ])("retires %s responses without resending the operation", async (mode) => {
        const f = await start(mode, 1);
        await expect(f.transport.exchange(f.request("once"))).rejects.toThrow("must not be replayed");
        expect(f.transport.available).toBe(false);
        expect(() => f.transport.exchange(f.request("again"))).toThrow("must not be replayed");
        await f.transport.close();
        expect(f.exited()).toBe(true);
    });
    it("bounds duplicate and competing admission while allowing the original response to complete", async () => {
        const f = await start("normal", 1),
            request = f.request("first");
        const pending = f.transport.exchange(request);
        await expect(f.transport.exchange(request)).rejects.toThrow("must not be replayed");
        await expect(f.transport.exchange(f.request("second"))).rejects.toThrow("must not be replayed");
        expect(() => f.transport.exchangeSync(f.request("sync"))).toThrow("exclusive transport");
        await expect(pending).resolves.toMatchObject({ result: "first" });
        await f.transport.close();
    });
    it("rejects synchronous execution on a concurrent read transport", async () => {
        const f = await start("normal", 2);
        expect(() => f.transport.exchangeSync(f.request("sync"))).toThrow("exclusive transport");
        await f.transport.close();
    });
    it("rejects oversized local frames before admitting a request", async () => {
        const f = await start("normal", 1);
        expect(() => f.transport.exchange(f.request("x".repeat(16_384)))).toThrow("frame limit");
        expect(f.transport.available).toBe(true);
        await expect(f.transport.exchange(f.request("valid"))).resolves.toMatchObject({ result: "valid" });
        await f.transport.close();
    });
    it("expires admission at the declared deadline", async () => {
        const f = await start("normal", 1);
        const clock = vi.spyOn(Date, "now").mockReturnValue(f.deadlineAt);
        expect(f.transport.available).toBe(false);
        expect(() => f.transport.exchange(f.request("late"))).toThrow("must not be replayed");
        clock.mockRestore();
        await f.transport.close();
    });
    it.each([
        "zero-sync",
        "oversized-sync",
        "failed-sync",
        "lost",
    ])("retires %s shared-memory outcomes without a second write", async (mode) => {
        const f = await start(mode, 1, 400);
        expect(() => f.transport.exchangeSync(f.request("once"))).toThrow("must not be replayed");
        expect(f.transport.available).toBe(false);
        await f.transport.close();
        expect(f.exited()).toBe(true);
    });
    it("matches concurrent asynchronous operations and waits for worker exit on close", async () => {
        const f = await start();
        try {
            const order: string[] = [];
            const first = f.transport.exchange(f.request("first")).then((result) => {
                order.push("first");
                return result;
            });
            const second = f.transport.exchange(f.request("second")).then((result) => {
                order.push("second");
                return result;
            });
            await expect(second).resolves.toMatchObject({ result: "second" });
            await expect(first).resolves.toMatchObject({ result: "first" });
            expect(order).toEqual(["second", "first"]);
        } finally {
            await f.transport.close();
        }
        expect(f.transport.available).toBe(false);
        expect(f.exited()).toBe(true);
        await expect(f.transport.close()).resolves.toBeUndefined();
    });

    it("wakes a synchronous caller through shared memory without blocking the pipe worker", async () => {
        const f = await start("normal", 1);
        try {
            expect(f.transport.exchangeSync(f.request("execute-once"))).toMatchObject({ result: "execute-once" });
        } finally {
            await f.transport.close();
        }
        expect(f.exited()).toBe(true);
    });

    it("invalidates malformed synchronous responses and closes the owner", async () => {
        const f = await start("invalid-sync", 1);
        expect(() => f.transport.exchangeSync(f.request("once"))).toThrow();
        expect(f.transport.available).toBe(false);
        await f.transport.close();
        expect(f.exited()).toBe(true);
    });

    it("rejects a lost response without replaying and joins cleanup", async () => {
        const f = await start("lost", 1, 200);
        await expect(f.transport.exchange(f.request("uncertain"))).rejects.toThrow("must not be replayed");
        await f.transport.close();
        expect(f.exited()).toBe(true);
    });

    it("does not treat worker exit alone as confirmed external cleanup", async () => {
        const f = await start("cleanup-failure");
        await expect(f.transport.close()).rejects.toThrow("cleanup was not confirmed");
        expect(f.exited()).toBe(true);
    });

    it("joins startup-failure cleanup before rejecting construction", async () => {
        const launch = config(1);
        const worker = new Worker(PEER, { eval: true, workerData: { mode: "startup-failure", session: launch.session } });
        let exited = false;
        worker.once("exit", () => {
            exited = true;
        });
        await expect(startRestrictedProcessTransportForTest(launch, () => worker)).rejects.toThrow("must not be replayed");
        expect(exited).toBe(true);
    });
});
