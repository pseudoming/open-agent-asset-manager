import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalExecutableTreeInvocationResult } from "../../../src/paths/path-environment";
import {
    invokeLocalExecutableInWorker,
    type LocalInvocationArguments,
} from "../../../src/paths/win32/local-executable-worker-client";

const INPUT: LocalInvocationArguments = [
    "C:\\fixture\\tool.exe",
    { deviceId: "42", fileId: "100", entryKind: "file" },
    ["--version"],
    "C:\\fixture",
    [{ name: "SystemRoot", value: "C:\\Windows" }],
    "a".repeat(64),
    1_000,
    1_024,
];
const RESULT: LocalExecutableTreeInvocationResult = {
    status: "complete",
    exitCode: 0,
    signal: null,
    stdout: new Uint8Array([1, 2]),
    stderr: new Uint8Array(),
    rootProcess: { processId: 42, lifecycleToken: "123" },
    observedProcesses: [{ processId: 42, lifecycleToken: "123" }],
    cleanupComplete: true,
    invocationTokenAbsent: true,
    failureCode: "",
};
class FakeWorker extends EventEmitter {
    readonly terminate = vi.fn(async () => 1);
}

afterEach(() => vi.useRealTimers());

describe("Win32 local executable worker client", () => {
    it("passes exact validated arguments and waits for natural exit after the result", async () => {
        const worker = new FakeWorker();
        const createWorker = vi.fn((_input: LocalInvocationArguments) => worker);
        let settled = false;
        const pending = invokeLocalExecutableInWorker(INPUT, { createWorker }).then((result) => {
            settled = true;
            return result;
        });
        expect(createWorker).toHaveBeenCalledOnce();
        expect(createWorker).toHaveBeenCalledWith(INPUT);
        worker.emit("message", { kind: "result", result: RESULT });
        await Promise.resolve();
        expect(settled).toBe(false);
        worker.emit("exit", 0);
        await expect(pending).resolves.toEqual(RESULT);
        expect(worker.terminate).not.toHaveBeenCalled();
    });

    it("validates environment aliases before creating any worker", async () => {
        const createWorker = vi.fn();
        for (const environment of [
            [{ name: "oaam_invocation_token", value: "caller" }],
            [
                { name: "PATH", value: "a" },
                { name: "Path", value: "b" },
            ],
        ]) {
            const input: LocalInvocationArguments = [...INPUT];
            input[4] = environment;
            await expect(invokeLocalExecutableInWorker(input, { createWorker })).rejects.toBeInstanceOf(TypeError);
        }
        expect(createWorker).not.toHaveBeenCalled();
    });

    it.each([
        ["unknown envelope", { kind: "other" }],
        ["extra field", { kind: "result", result: RESULT, extra: true }],
        ["output bound", { kind: "result", result: { ...RESULT, stdout: new Uint8Array(1_025) } }],
        ["missing root identity", { kind: "result", result: { ...RESULT, rootProcess: null } }],
        ["missing observed identity", { kind: "result", result: { ...RESULT, observedProcesses: [] } }],
        ["false cleanup success", { kind: "result", result: { ...RESULT, cleanupComplete: false } }],
        ["false token absence", { kind: "result", result: { ...RESULT, invocationTokenAbsent: false } }],
        ["unsafe failed output", { kind: "result", result: { ...RESULT, status: "timed_out", failureCode: "timeout" } }],
        ["unknown failure kind", { kind: "error", failureKind: "private", systemCode: "PRIVATE" }],
        ["malformed failure code", { kind: "error", failureKind: "io_error", systemCode: "" }],
    ])("rejects %s and waits for termination", async (_label, message) => {
        const worker = new FakeWorker();
        let finishCleanup: (code: number) => void = () => undefined;
        worker.terminate.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finishCleanup = resolve;
                }),
        );
        let settled = false;
        const pending = invokeLocalExecutableInWorker(INPUT, { createWorker: () => worker }).catch((error: unknown) => {
            settled = true;
            throw error;
        });
        const rejected = expect(pending).rejects.toMatchObject({ failureKind: "io_error", operation: "invoke_local_executable" });
        worker.emit("message", message);
        await Promise.resolve();
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
        finishCleanup(1);
        await rejected;
    });

    it("rejects duplicate results instead of accepting the first captured output", async () => {
        const worker = new FakeWorker();
        const pending = invokeLocalExecutableInWorker(INPUT, { createWorker: () => worker });
        const rejected = expect(pending).rejects.toMatchObject({ systemCode: "LOCAL_INVOCATION_WORKER_PROTOCOL" });
        worker.emit("message", { kind: "result", result: RESULT });
        worker.emit("message", { kind: "result", result: RESULT });
        worker.emit("exit", 0);
        await rejected;
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it("preserves typed native failures without transferring private messages", async () => {
        const worker = new FakeWorker();
        const pending = invokeLocalExecutableInWorker(INPUT, { createWorker: () => worker });
        const rejected = expect(pending).rejects.toMatchObject({
            failureKind: "permission_denied",
            systemCode: "EACCES",
            targetPath: INPUT[0],
        });
        worker.emit("message", { kind: "error", failureKind: "permission_denied", systemCode: "EACCES" });
        await rejected;
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it.each([0, 2])("rejects exit %i before a valid result", async (code) => {
        const worker = new FakeWorker();
        const pending = invokeLocalExecutableInWorker(INPUT, { createWorker: () => worker });
        const rejected = expect(pending).rejects.toMatchObject({ systemCode: "LOCAL_INVOCATION_WORKER_PROTOCOL" });
        worker.emit("exit", code);
        await rejected;
        expect(worker.terminate).not.toHaveBeenCalled();
    });

    it("does not trust a result followed by abnormal exit", async () => {
        const worker = new FakeWorker();
        const pending = invokeLocalExecutableInWorker(INPUT, { createWorker: () => worker });
        const rejected = expect(pending).rejects.toMatchObject({ systemCode: "LOCAL_INVOCATION_WORKER_PROTOCOL" });
        worker.emit("message", { kind: "result", result: RESULT });
        worker.emit("exit", 1);
        await rejected;
    });

    it("handles worker errors and distinguishes failed termination", async () => {
        const worker = new FakeWorker();
        worker.terminate.mockRejectedValueOnce(new Error("private cleanup failure"));
        const pending = invokeLocalExecutableInWorker(INPUT, { createWorker: () => worker });
        const rejected = expect(pending).rejects.toMatchObject({ systemCode: "LOCAL_INVOCATION_WORKER_CLEANUP" });
        worker.emit("error", new Error("private worker failure"));
        await rejected;
    });

    it("bounds the outer wait without extending the native deadline and clears its timer", async () => {
        vi.useFakeTimers();
        const worker = new FakeWorker();
        const createWorker = vi.fn((_input: LocalInvocationArguments) => worker);
        const pending = invokeLocalExecutableInWorker(INPUT, { createWorker });
        const rejected = expect(pending).rejects.toMatchObject({ failureKind: "stale", systemCode: "ETIMEDOUT" });
        await vi.advanceTimersByTimeAsync(1_999);
        expect(worker.terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        expect(createWorker.mock.calls[0]?.[0]?.[6]).toBe(1_000);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("preserves clean nonzero native exit and its bounded stderr", async () => {
        const worker = new FakeWorker();
        const result = {
            ...RESULT,
            status: "failed",
            exitCode: 2,
            failureCode: "exit",
            stdout: new Uint8Array(),
            stderr: new Uint8Array([3]),
        };
        const pending = invokeLocalExecutableInWorker(INPUT, { createWorker: () => worker });
        worker.emit("message", { kind: "result", result });
        worker.emit("exit", 0);
        await expect(pending).resolves.toEqual(result);
    });

    it("maps construction failure before any native invocation", async () => {
        await expect(
            invokeLocalExecutableInWorker(INPUT, {
                createWorker: () => {
                    throw new Error("private construction");
                },
            }),
        ).rejects.toMatchObject({ failureKind: "io_error", systemCode: "LOCAL_INVOCATION_WORKER_PROTOCOL" });
    });
});
