import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeFilesystemError } from "../../../src/filesystem/filesystem-types";

const INPUT = [
    "C:\\fixture\\tool.exe",
    { deviceId: "42", fileId: "100", entryKind: "file" },
    ["--version"],
    "C:\\fixture",
    [{ name: "SystemRoot", value: "C:\\Windows" }],
    "a".repeat(64),
    1_000,
    1_024,
];
const RESULT = {
    status: "complete",
    exitCode: 0,
    signal: null,
    stdout: new Uint8Array([1]),
    stderr: new Uint8Array(),
    rootProcess: { processId: 42, lifecycleToken: "123" },
    observedProcesses: [{ processId: 42, lifecycleToken: "123" }],
    cleanupComplete: true,
    invocationTokenAbsent: true,
    failureCode: "",
};

afterEach(() => {
    vi.doUnmock("node:worker_threads");
    vi.doUnmock("../../../src/paths/win32/native-addon");
    vi.doUnmock("../../../src/filesystem/filesystem-types");
    vi.doUnmock("../../../src/paths/win32/packaged-worker-path");
});

async function runWorker(input: unknown, invoke: ReturnType<typeof vi.fn>, withParent = true) {
    vi.resetModules();
    const parent = { postMessage: vi.fn(), close: vi.fn() };
    const loadNative = vi.fn(() => ({ invokeLocalExecutableTreeBounded: invoke }));
    vi.doMock("node:worker_threads", () => ({ parentPort: withParent ? parent : null, workerData: input }));
    vi.doMock("../../../src/filesystem/filesystem-types", async (original) => ({
        ...(await original<typeof import("../../../src/filesystem/filesystem-types")>()),
        SafeFilesystemError,
    }));
    vi.doMock("../../../src/paths/win32/native-addon", async (original) => ({
        ...(await original<typeof import("../../../src/paths/win32/native-addon")>()),
        loadWin32NativeFilesystemAddon: loadNative,
    }));
    await import("../../../src/paths/win32/local-executable-worker");
    await Promise.resolve();
    return { parent, loadNative };
}

describe("Win32 local executable worker entry", () => {
    it("does not load native or invoke without a parent", async () => {
        const invoke = vi.fn();
        const { loadNative } = await runWorker(INPUT, invoke, false);
        expect(loadNative).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
    });

    it("uses the existing direct mechanics once and closes the parent after transferring its receipt", async () => {
        const invoke = vi.fn(() => RESULT);
        const { parent, loadNative } = await runWorker(INPUT, invoke);
        expect(loadNative).toHaveBeenCalledOnce();
        expect(invoke).toHaveBeenCalledOnce();
        expect(invoke).toHaveBeenCalledWith(...INPUT);
        expect(parent.postMessage).toHaveBeenCalledWith({ kind: "result", result: RESULT });
        expect(parent.close).toHaveBeenCalledOnce();
    });

    it("revalidates worker input before loading native", async () => {
        const invoke = vi.fn();
        const input = [...INPUT];
        input[4] = [{ name: "OAAM_INVOCATION_TOKEN", value: "injected" }];
        const { parent, loadNative } = await runWorker(input, invoke);
        expect(loadNative).not.toHaveBeenCalled();
        expect(parent.postMessage).toHaveBeenCalledWith({
            kind: "error",
            failureKind: "io_error",
            systemCode: "LOCAL_INVOCATION_WORKER_FAILED",
        });
        expect(parent.close).toHaveBeenCalledOnce();
    });

    it("preserves typed native failure classification without private messages or output", async () => {
        const invoke = vi.fn(() => {
            throw new SafeFilesystemError({
                failureKind: "permission_denied",
                operation: "invoke_local_executable",
                targetPath: "C:\\private",
                systemCode: "EACCES",
                message: "private native message",
            });
        });
        const { parent } = await runWorker(INPUT, invoke);
        expect(parent.postMessage).toHaveBeenCalledWith({
            kind: "error",
            failureKind: "permission_denied",
            systemCode: "EACCES",
        });
        expect(JSON.stringify(parent.postMessage.mock.calls)).not.toContain("private");
        expect(parent.close).toHaveBeenCalledOnce();
    });

    it("routes the public Promise entry through the packaged worker without caller-thread native loading", async () => {
        vi.resetModules();
        const worker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 0) });
        const createWorker = vi.fn(() => worker);
        const loadNative = vi.fn();
        vi.doMock("node:worker_threads", () => ({ Worker: createWorker }));
        vi.doMock("../../../src/paths/win32/native-addon", async (original) => ({
            ...(await original<typeof import("../../../src/paths/win32/native-addon")>()),
            loadWin32NativeFilesystemAddon: loadNative,
        }));
        const resolveWorker = vi.fn(() => "C:\\fixture\\app.asar.unpacked\\local-executable-worker.js");
        vi.doMock("../../../src/paths/win32/packaged-worker-path", () => ({ resolveWin32PackagedWorkerPath: resolveWorker }));
        const { invokeLocalExecutableTreeBounded } = await import("../../../src/paths/win32/local-executable-invocation");
        const pending = invokeLocalExecutableTreeBounded(
            "C:\\fixture\\tool.exe",
            { deviceId: "42", fileId: "100", entryKind: "file" },
            ["--version"],
            "C:\\fixture",
            [{ name: "SystemRoot", value: "C:\\Windows" }],
            "a".repeat(64),
            1_000,
            1_024,
        );
        expect(createWorker).toHaveBeenCalledWith("C:\\fixture\\app.asar.unpacked\\local-executable-worker.js", {
            workerData: INPUT,
        });
        expect(resolveWorker).toHaveBeenCalledOnce();
        expect(loadNative).not.toHaveBeenCalled();
        worker.emit("message", { kind: "result", result: RESULT });
        worker.emit("exit", 0);
        await expect(pending).resolves.toEqual(RESULT);
    });
});
