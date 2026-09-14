import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeFilesystemError } from "@oaam/shared/filesystem";
import type { RestrictedProcessLaunch } from "../src/restricted-process-client";
import { restrictedCodeLaunchBinding } from "../src/restricted-code-admission";

const seam = vi.hoisted(() => ({
    port: null as unknown,
    configuration: {} as unknown,
    spawn: vi.fn(),
    inspect: vi.fn(),
    local: vi.fn(),
    linux: vi.fn(),
    linuxPair: vi.fn(),
    root: vi.fn(),
    verifyCode: vi.fn(),
    receive: vi.fn(),
}));
vi.mock("node:worker_threads", () => ({
    receiveMessageOnPort: seam.receive,
    get parentPort() {
        return seam.port;
    },
    get workerData() {
        return seam.configuration;
    },
}));
vi.mock("../src/restricted-windows-code-verification", () => ({ verifyWindowsRestrictedCodePackage: seam.verifyCode }));
vi.mock("node:child_process", async (original) => ({ ...(await original<object>()), spawn: seam.spawn }));
vi.mock("@oaam/shared/filesystem", async (original) => ({
    ...(await original<object>()),
    inspectRegularFileNoFollow: seam.inspect,
}));
vi.mock("@oaam/shared/paths", async (original) => ({
    ...(await original<object>()),
    observeLocalProcessExecutableBounded: seam.local,
    observeSelectedWslProcessLifecycleBounded: seam.linux,
    observeSelectedWslProcessLifecyclePairBounded: seam.linuxPair,
    getWslAccessRootPath: seam.root,
}));

const actualProcess = process;
const fixtures: {
    end(): void;
    finished: Promise<void>;
    child: { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
}[] = [];
afterEach(async () => {
    for (const f of fixtures.splice(0)) {
        f.end();
        await f.finished;
        for (const stream of [f.child.stdin, f.child.stdout, f.child.stderr]) stream.destroy();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    seam.port = null;
});

function fixture() {
    vi.resetModules();
    for (const mock of [
        seam.spawn,
        seam.inspect,
        seam.local,
        seam.linux,
        seam.linuxPair,
        seam.root,
        seam.verifyCode,
        seam.receive,
    ])
        mock.mockReset();
    const session = { protocol: "test.worker.v1", hostInstanceId: randomUUID(), sessionId: randomUUID() };
    const configuration: RestrictedProcessLaunch = {
        session,
        wslExecutablePath: "C:\\Windows\\System32\\wsl.exe",
        windowsCodeRootPath: "C:\\OAAM\\code",
        distroName: "Ubuntu",
        code: {
            rootPath: "/owned/code",
            manifest: {
                schemaVersion: 1,
                platform: "linux",
                architecture: "x64",
                nodeVersion: "22.14.0",
                nodeModulesVersion: "127",
                files: ["node", "restricted-wsl.cjs"].map((relativePath) => ({
                    relativePath,
                    bytes: 1,
                    sha256: "a".repeat(64),
                    executable: relativePath === "node",
                })),
            },
        },
        operation: {},
        deadlineAt: Date.now() + 60_000,
        maximumFrameBytes: 4096,
        maximumConcurrentRequests: 1,
    };
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const messages: Record<string, unknown>[] = [];
    const port = Object.assign(new EventEmitter(), {
        postMessage: vi.fn((message: Record<string, unknown>) => messages.push(message)),
        close: vi.fn(() => {
            port.removeAllListeners();
            finish();
        }),
    });
    let ended = false;
    const child = Object.assign(new EventEmitter(), {
        pid: 9001 as number | undefined,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => {
            end();
            return true;
        }),
    });
    const writes: string[] = [];
    child.stdin.on("data", (bytes: Buffer) => writes.push(bytes.toString("utf8")));
    const windowsIdentity = { processId: 9001, lifecycleToken: "100" };
    const identity = { processId: 9002, lifecycleToken: "200", parentIdentity: { processId: 9003, lifecycleToken: "300" } };
    seam.spawn.mockReturnValue(child);
    const codeObservation = {
        verification: { bindingHash: restrictedCodeLaunchBinding(configuration.code, session) },
        timing: {
            totalMilliseconds: 13,
            directoryMilliseconds: 2,
            stableReadMilliseconds: 7,
            hashMilliseconds: 3,
            fileCount: 2,
            byteCount: 2,
        },
    };
    seam.verifyCode.mockReturnValue(codeObservation);
    seam.root.mockImplementation((distro: string) => {
        if (distro !== "Ubuntu") throw new Error("selected distribution unavailable");
        return "\\\\wsl.localhost\\Ubuntu";
    });
    seam.inspect.mockReturnValue({ entryKind: "file", platform: "win32", volumeSerialNumber: "1", fileId: "2" });
    seam.local.mockImplementation(() => (ended ? null : windowsIdentity));
    seam.linux.mockImplementation((_distro: string, pid: number) =>
        ended
            ? null
            : {
                  processId: pid,
                  lifecycleToken: pid === identity.processId ? identity.lifecycleToken : identity.parentIdentity.lifecycleToken,
              },
    );
    seam.linuxPair.mockImplementation((_distro: string, pids: readonly number[]) =>
        pids.map((processId) => ({
            processId,
            lifecycleToken: processId === identity.processId ? identity.lifecycleToken : identity.parentIdentity.lifecycleToken,
        })),
    );
    seam.port = port;
    seam.configuration = configuration;
    const runtime = Object.create(actualProcess) as NodeJS.Process;
    Object.defineProperties(runtime, {
        platform: { value: "win32", configurable: true },
        env: {
            value: {
                ...Object.fromEntries(
                    Object.entries(actualProcess.env).filter(([key]) => !/^(?:systemroot|windir)$/iu.test(key)),
                ),
                SystemRoot: "C:\\Windows",
                windir: "C:\\Windows",
            },
        },
    });
    vi.stubGlobal("process", runtime);
    function end() {
        if (ended) return;
        ended = true;
        child.emit("close", 0, null);
    }
    const frame = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
    const handshake = () => {
        frame({ kind: "owned", ...session, processIdentity: identity });
        frame({ kind: "ready", ...session, processIdentity: identity });
    };
    const exchange = (buffers?: { header: SharedArrayBuffer; body: SharedArrayBuffer }) => {
        const operationId = randomUUID();
        const value = { ...session, operationId, kind: "operation" };
        port.emit("message", { kind: "exchange", operationId, text: JSON.stringify(value), ...buffers });
        return value;
    };
    const f = {
        configuration,
        runtime,
        port,
        child,
        messages,
        writes,
        finished,
        end,
        frame,
        handshake,
        exchange,
        identity,
        windowsIdentity,
        codeObservation,
        start: () => import("../src/restricted-process-worker"),
    };
    fixtures.push(f);
    return f;
}

// Explicit child-process and process-observation seams drive the original Worker
// entry and pipe dispatch. These tests launch no Windows executable or WSL service.
describe("restricted process Worker entry lifecycle", () => {
    it("joins a spawned child after listener setup fails and releases its deadline only after close", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        const f = fixture();
        vi.spyOn(f.port, "on").mockImplementationOnce(() => {
            throw new Error("listener setup failed");
        });
        await f.start();
        expect(f.messages).toEqual([expect.objectContaining({ kind: "failed", detail: "listener setup failed" })]);
        expect(f.child.stdin.writableEnded).toBe(true);
        expect(f.port.close).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);
        f.end();
        await f.finished;
        expect(f.messages.at(-1)).toMatchObject({ kind: "closed", cleanupConfirmed: false });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does nothing without a parent port", async () => {
        vi.resetModules();
        seam.port = null;
        seam.spawn.mockClear();
        await import("../src/restricted-process-worker");
        expect(seam.spawn).not.toHaveBeenCalled();
    });

    it("binds the exact spawn, owns before ready, dispatches once and confirms both process scopes absent", async () => {
        const f = fixture();
        await f.start();
        expect(f.messages).toEqual([expect.objectContaining({ kind: "spawned" })]);
        const [executable, args, options] = seam.spawn.mock.calls[0]!;
        expect(executable).toBe(f.configuration.wslExecutablePath);
        expect(args.slice(0, 12)).toEqual([
            "--distribution",
            "Ubuntu",
            "--exec",
            "/usr/bin/env",
            "-i",
            "PATH=/usr/bin:/bin",
            "LC_ALL=C.UTF-8",
            "/usr/bin/timeout",
            "--kill-after=2s",
            expect.stringMatching(/^5[67]s$/u),
            "/owned/code/node",
            "/owned/code/restricted-wsl.cjs",
        ]);
        expect(JSON.parse(Buffer.from(args[12], "base64").toString("utf8"))).toEqual({
            code: f.configuration.code,
            session: f.configuration.session,
            operation: {},
            windowsCodeVerification: f.codeObservation.verification,
        });
        expect(options).toEqual({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        f.handshake();
        expect(seam.linuxPair.mock.calls).toEqual([
            ["Ubuntu", [9002, 9003], 2_000],
            ["Ubuntu", [9002, 9003], 2_000],
        ]);
        expect(seam.linux).not.toHaveBeenCalled();
        const request = f.exchange();
        f.frame({ ...request, result: "once" });
        expect(f.messages.map((value) => value.kind)).toEqual(["spawned", "owned", "ready", "response"]);
        expect(seam.verifyCode).toHaveBeenCalledOnce();
        expect(seam.verifyCode).toHaveBeenCalledWith(
            f.configuration.windowsCodeRootPath,
            f.configuration.code,
            f.configuration.session,
        );
        expect(f.messages[2]).toMatchObject({ windowsCodeVerificationTiming: f.codeObservation.timing });
        expect(f.messages[3]).toMatchObject({ operationId: request.operationId, ok: true, value: { result: "once" } });
        expect(f.writes).toHaveLength(1);
        f.port.emit("message", { kind: "close" });
        expect(JSON.parse(f.writes[1]!)).toEqual({ kind: "shutdown", ...f.configuration.session });
        f.end();
        await f.finished;
        expect(f.messages.at(-1)).toMatchObject({
            kind: "closed",
            cleanupConfirmed: true,
            failed: false,
            windowsIdentity: f.windowsIdentity,
        });
        expect(f.port.close).toHaveBeenCalledOnce();
        expect(seam.linux.mock.calls).toEqual([
            ["Ubuntu", 9002, 2_000],
            ["Ubuntu", 9003, 2_000],
        ]);
    });

    it.each([
        "verification",
        "deadline",
        "cancel",
        "unexpected",
    ] as const)("does not spawn after %s fails during local verification", async (failure) => {
        const f = fixture();
        seam.verifyCode.mockImplementation(() => {
            expect(seam.spawn).not.toHaveBeenCalled();
            if (failure === "verification") throw new Error("current package digest changed");
            if (failure === "deadline") Object.assign(f.configuration, { deadlineAt: Date.now() + 4_999 });
            if (failure === "cancel" || failure === "unexpected")
                seam.receive.mockReturnValue({ message: { kind: failure === "cancel" ? "close" : "exchange" } });
            return f.codeObservation;
        });
        await f.start();
        await f.finished;
        expect(seam.spawn).not.toHaveBeenCalled();
        expect(f.messages).toEqual([
            expect.objectContaining({
                kind: "failed",
                startupPhase: failure === "verification" ? "windows_code_verification" : "pre_spawn",
            }),
            expect.objectContaining({ kind: "closed", cleanupConfirmed: true }),
        ]);
    });

    it.each([
        "platform",
        "executable",
        "distro",
        "deadline_nan",
        "deadline_short",
        "deadline_long",
        "code",
        "frame_nan",
        "frame_zero",
        "frame_large",
        "concurrency_nan",
        "concurrency_zero",
        "concurrency_large",
        "encoding",
        "not_file",
        "spawn_error",
        "nonerror",
    ] as const)("rejects %s before an owned process starts", async (failure) => {
        const f = fixture();
        if (failure === "platform") Object.defineProperty(f.runtime, "platform", { value: "linux" });
        if (failure === "executable") Object.assign(f.configuration, { wslExecutablePath: "foreign.exe" });
        if (failure === "distro") Object.assign(f.configuration, { distroName: "bad/distro" });
        if (failure.startsWith("deadline_"))
            Object.assign(f.configuration, {
                deadlineAt: failure === "deadline_nan" ? NaN : Date.now() + (failure === "deadline_short" ? 1000 : 700_000),
            });
        if (failure === "code") Object.assign(f.configuration, { code: {} });
        if (failure.startsWith("frame_"))
            Object.assign(f.configuration, {
                maximumFrameBytes: failure === "frame_nan" ? NaN : failure === "frame_zero" ? 0 : 32 * 1024 * 1024 + 1,
            });
        if (failure.startsWith("concurrency_"))
            Object.assign(f.configuration, {
                maximumConcurrentRequests: failure === "concurrency_nan" ? NaN : failure === "concurrency_zero" ? 0 : 17,
            });
        if (failure === "encoding") Object.assign(f.configuration, { operation: "x".repeat(24_000) });
        if (failure === "not_file") seam.inspect.mockReturnValue({ entryKind: "directory" });
        if (failure === "spawn_error" || failure === "nonerror")
            seam.spawn.mockImplementation(() => {
                throw failure === "spawn_error" ? new Error("x".repeat(300)) : "non-error startup rejection";
            });
        await f.start();
        await f.finished;
        expect(f.messages.map((value) => value.kind)).toEqual(["failed", "closed"]);
        expect(f.messages[1]).toMatchObject({ cleanupConfirmed: true, failed: true });
        expect(String(f.messages[0]!.detail).length).toBeLessThanOrEqual(256);
        const detail =
            failure === "platform"
                ? "Windows build"
                : failure === "executable"
                  ? "untrusted WSL executable"
                  : failure === "distro"
                    ? "selected distribution unavailable"
                    : failure.startsWith("deadline_")
                      ? "invalid restricted process deadline"
                      : failure === "code"
                        ? "invalid restricted code package binding"
                        : failure.startsWith("frame_") || failure.startsWith("concurrency_")
                          ? "invalid restricted process bounds"
                          : failure === "encoding"
                            ? "configuration exceeds its bound"
                            : failure === "not_file"
                              ? "regular file"
                              : failure === "spawn_error"
                                ? "x".repeat(256)
                                : "restricted startup failed";
        expect(f.messages[0]!.detail).toContain(detail);
        if (failure === "nonerror") expect(f.messages[0]!.detail).toBe("restricted startup failed");
    });

    it.each([
        "kind",
        "null",
        "protocol",
        "host",
        "session",
        "ready_first",
        "no_identity",
        "identity_null",
        "pid_zero",
        "pid_fractional",
        "token_type",
        "token_invalid",
        "same_pid",
        "owner_changed",
        "parent_changed",
        "stale",
        "startup_failure",
        "duplicate_owned",
        "truncated",
    ] as const)("retires %s handshake without forwarding a request", async (failure) => {
        const f = fixture();
        await f.start();
        const owned: Record<string, unknown> = { kind: "owned", ...f.configuration.session, processIdentity: f.identity };
        if (failure === "kind") owned.kind = "response";
        if (failure === "protocol") owned.protocol = "foreign";
        if (failure === "host") owned.hostInstanceId = randomUUID();
        if (failure === "session") owned.sessionId = randomUUID();
        if (failure === "ready_first") owned.kind = "ready";
        if (failure === "no_identity") delete owned.processIdentity;
        if (failure === "identity_null") owned.processIdentity = null;
        if (failure === "pid_zero" || failure === "pid_fractional")
            owned.processIdentity = { ...f.identity, processId: failure === "pid_zero" ? 0 : 1.5 };
        if (failure === "token_type" || failure === "token_invalid")
            owned.processIdentity = { ...f.identity, lifecycleToken: failure === "token_type" ? 10 : "not-a-token" };
        if (failure === "same_pid") owned.processIdentity = { ...f.identity, parentIdentity: f.identity };
        if (failure === "stale") seam.linuxPair.mockReturnValue([]);
        if (failure === "startup_failure") Object.assign(owned, { kind: "startup-failure", failureCode: "digest_mismatch" });
        if (failure === "truncated") f.child.stdout.write('{"unfinished":');
        else f.frame(failure === "null" ? null : owned);
        if (failure === "owner_changed" || failure === "parent_changed")
            f.frame({
                ...owned,
                kind: "ready",
                processIdentity: {
                    ...f.identity,
                    ...(failure === "owner_changed"
                        ? { processId: 9999 }
                        : { parentIdentity: { ...f.identity.parentIdentity, lifecycleToken: "400" } }),
                },
            });
        if (failure === "duplicate_owned") f.frame(owned);
        if (failure === "stale") f.frame({ ...owned, kind: "ready" });
        f.exchange();
        expect(f.messages.filter((value) => value.kind === "response")).toEqual([expect.objectContaining({ ok: false })]);
        expect(f.writes).toHaveLength(0);
        f.end();
        await f.finished;
        expect(f.messages.at(-1)).toMatchObject({ kind: "closed", failed: true });
        if (failure === "startup_failure")
            expect(f.messages).toContainEqual(
                expect.objectContaining({ kind: "failed", startupPhase: "service", failureCode: "digest_mismatch" }),
            );
    });

    it.each(
        (["owned", "ready"] as const).flatMap((stage) =>
            (["child_token", "parent_token", "foreign_pid", "reordered", "missing", "timeout"] as const).map((failure) => ({
                stage,
                failure,
            })),
        ),
    )("rejects $stage batch $failure and retains the original cleanup path", async ({ stage, failure }) => {
        const f = fixture();
        await f.start();
        if (stage === "ready") f.frame({ kind: "owned", ...f.configuration.session, processIdentity: f.identity });
        const pair = [
            { processId: f.identity.processId, lifecycleToken: f.identity.lifecycleToken },
            { ...f.identity.parentIdentity },
        ];
        if (failure === "child_token") pair[0]!.lifecycleToken = "201";
        if (failure === "parent_token") pair[1]!.lifecycleToken = "301";
        if (failure === "foreign_pid") pair[1]!.processId = 9999;
        if (failure === "reordered") pair.reverse();
        if (failure === "missing" || failure === "timeout")
            seam.linuxPair.mockImplementationOnce(() => {
                throw new SafeFilesystemError({
                    failureKind: failure === "timeout" ? "stale" : "io_error",
                    operation: "observe_selected_wsl_process",
                    targetPath: "wsl:Ubuntu:/proc/9002,9003/stat",
                    systemCode: failure === "timeout" ? "ETIMEDOUT" : "WSL_EXIT_1",
                    message: "selected WSL pair observation failed",
                });
            });
        else seam.linuxPair.mockReturnValueOnce(pair);
        f.frame({ kind: stage, ...f.configuration.session, processIdentity: f.identity });
        f.exchange();
        expect(f.messages.some((value) => value.kind === "ready")).toBe(false);
        expect(f.messages.filter((value) => value.kind === "response")).toEqual([expect.objectContaining({ ok: false })]);
        expect(f.writes).toHaveLength(0);
        f.end();
        await f.finished;
        expect(f.messages.at(-1)).toMatchObject({ kind: "closed", failed: true, cleanupConfirmed: true });
        expect(seam.linux.mock.calls).toEqual([
            ["Ubuntu", 9002, 2_000],
            ["Ubuntu", 9003, 2_000],
        ]);
    });

    it.each([
        "missing_pid",
        "missing_identity",
        "identity_error",
    ] as const)("does not claim cleanup when initial Windows %s cannot be established", async (failure) => {
        const f = fixture();
        if (failure === "missing_pid") f.child.pid = undefined;
        if (failure === "missing_identity") seam.local.mockReturnValue(null);
        if (failure === "identity_error")
            seam.local.mockImplementation(() => {
                throw new Error("unobservable");
            });
        await f.start();
        f.handshake();
        f.end();
        await f.finished;
        expect(f.messages.at(-1)).toMatchObject({ kind: "closed", failed: true, cleanupConfirmed: false });
    });

    it.each([
        "child",
        "stdout",
        "stderr",
        "stderr_bound",
        "deadline",
        "bad_response",
    ] as const)("stops %s failure and never resends an admitted request", async (failure) => {
        if (failure === "deadline") vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        const f = fixture();
        await f.start();
        f.handshake();
        f.exchange();
        if (failure === "child") f.child.emit("error", new Error("child failed"));
        if (failure === "stdout") f.child.stdout.emit("error", new Error("stdout failed"));
        if (failure === "stderr") f.child.stderr.emit("error", new Error("stderr failed"));
        if (failure === "stderr_bound") {
            f.child.stderr.write(Buffer.alloc(65_536));
            expect(f.messages.filter((value) => value.kind === "response")).toHaveLength(0);
            f.child.stderr.write("x");
        }
        if (failure === "deadline") await vi.advanceTimersByTimeAsync(60_000);
        if (failure === "bad_response") f.frame({ kind: "foreign" });
        if (failure !== "deadline") f.exchange();
        expect(f.writes).toHaveLength(1);
        expect(f.messages.filter((value) => value.kind === "response")).toEqual(
            Array.from({ length: failure === "deadline" ? 1 : 2 }, () => expect.objectContaining({ ok: false })),
        );
        f.end();
        await f.finished;
        expect(f.messages.at(-1)).toMatchObject({ failed: true });
        if (failure === "deadline") expect(f.child.kill).toHaveBeenCalledOnce();
    });

    it.each([
        "normal",
        "already_timed_out",
        "too_small",
        "failed",
    ] as const)("publishes shared-memory %s outcome without replay", async (outcome) => {
        const f = fixture();
        await f.start();
        f.handshake();
        const header = new SharedArrayBuffer(8),
            body = new SharedArrayBuffer(outcome === "too_small" ? 1 : 4096);
        const status = new Int32Array(header);
        if (outcome === "already_timed_out") Atomics.store(status, 0, -1);
        const request = f.exchange({ header, body });
        if (outcome === "failed") f.child.stdout.emit("error", new Error("broken pipe"));
        else f.frame({ ...request, result: "once" });
        expect(Atomics.load(status, 0)).toBe(outcome === "normal" ? 1 : -1);
        if (outcome === "normal")
            expect(JSON.parse(Buffer.from(body, 0, Atomics.load(status, 1)).toString("utf8"))).toMatchObject({
                operationId: request.operationId,
                result: "once",
            });
        expect(f.writes).toHaveLength(1);
        f.end();
        await f.finished;
    });

    it.each([
        "windows_alive",
        "windows_error",
        "windows_absent",
        "linux_alive",
        "linux_error",
    ] as const)("reports independently observed %s cleanup", async (observation) => {
        const f = fixture();
        await f.start();
        f.handshake();
        if (observation === "windows_alive") seam.local.mockReturnValue(f.windowsIdentity);
        if (observation === "windows_error" || observation === "windows_absent")
            seam.local.mockImplementation(() => {
                throw observation === "windows_absent"
                    ? new SafeFilesystemError({
                          failureKind: "not_found",
                          operation: "observe_local_process",
                          targetPath: `process:${f.windowsIdentity.processId}`,
                          message: "process absent",
                      })
                    : new Error("cleanup unobservable");
            });
        if (observation === "linux_alive")
            seam.linux.mockImplementation((_distro: string, pid: number) => ({
                processId: pid,
                lifecycleToken: pid === f.identity.processId ? "200" : "300",
            }));
        if (observation === "linux_error")
            seam.linux.mockImplementation(() => {
                throw new Error("cleanup unobservable");
            });
        f.end();
        await f.finished;
        expect(f.messages.at(-1)).toMatchObject({ kind: "closed", cleanupConfirmed: observation === "windows_absent" });
    });
});
