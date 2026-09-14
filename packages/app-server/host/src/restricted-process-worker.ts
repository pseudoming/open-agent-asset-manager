/** Provider-neutral Windows pipe/process owner for an already prepared target-local service. */
import { spawn } from "node:child_process";
import { posix } from "node:path";
import { parentPort, receiveMessageOnPort, workerData } from "node:worker_threads";
import { inspectRegularFileNoFollow, SafeFilesystemError } from "@oaam/shared/filesystem";
import {
    getWslAccessRootPath,
    observeLocalProcessExecutableBounded,
    observeSelectedWslProcessLifecycleBounded,
    observeSelectedWslProcessLifecyclePairBounded,
    type OwnedInvocationProcessIdentity,
} from "@oaam/shared/paths";
import { createRestrictedJsonFrames, MAXIMUM_RESTRICTED_FRAME_BYTES } from "./restricted-target-stdio";
import { createRestrictedPipeDispatch } from "./restricted-pipe-dispatch";
import type { RestrictedProcessLaunch } from "./restricted-process-client";
import { requireRestrictedCodePackage } from "./restricted-code-package";
import { requireRestrictedWslExecutable } from "./restricted-process-launch";
import { verifyWindowsRestrictedCodePackage } from "./restricted-windows-code-verification";

interface ExchangeMessage {
    kind: "exchange";
    operationId: string;
    text: string;
    header?: SharedArrayBuffer;
    body?: SharedArrayBuffer;
}

async function run(): Promise<void> {
    if (parentPort === null) return;
    const port = parentPort;
    let child: ReturnType<typeof spawn> | undefined;
    let spawned = false;
    let closed = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let startupPhase = "configuration";
    try {
        const config = workerData as RestrictedProcessLaunch;
        if (process.platform !== "win32") throw new Error("restricted process transport requires the Windows build");
        const wslExecutablePath = validateLaunch(config);
        startupPhase = "windows_code_verification";
        const codeObservation = verifyWindowsRestrictedCodePackage(config.windowsCodeRootPath, config.code, config.session);
        const encoded = Buffer.from(
            JSON.stringify({
                code: config.code,
                session: config.session,
                operation: config.operation,
                windowsCodeVerification: codeObservation.verification,
            }),
            "utf8",
        ).toString("base64");
        if (encoded.length > 24_000) throw new Error("restricted launch configuration exceeds its bound");
        startupPhase = "wsl_executable_identity";
        const identity = inspectRegularFileNoFollow(wslExecutablePath);
        if (identity.entryKind !== "file") throw new Error("WSL executable must be a regular file");
        startupPhase = "pre_spawn";
        const remaining = config.deadlineAt - Date.now();
        if (remaining <= 5_000) throw new Error("restricted process startup budget exhausted during code verification");
        const pending = receiveMessageOnPort(port);
        if (pending !== undefined)
            throw new Error(
                pending.message?.kind === "close"
                    ? "restricted process launch cancelled before spawn"
                    : "unexpected restricted process message before spawn",
            );
        startupPhase = "spawn";
        const owned = spawn(
            wslExecutablePath,
            [
                "--distribution",
                config.distroName,
                "--exec",
                "/usr/bin/env",
                "-i",
                "PATH=/usr/bin:/bin",
                "LC_ALL=C.UTF-8",
                "/usr/bin/timeout",
                "--kill-after=2s",
                `${Math.max(1, Math.floor((remaining - 3_000) / 1_000))}s`,
                posix.join(config.code.rootPath, "node"),
                posix.join(config.code.rootPath, "restricted-wsl.cjs"),
                encoded,
            ],
            { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        child = owned;
        spawned = true;
        const closedProcess = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
            owned.once("close", (code, signal) => {
                closed = true;
                resolve({ code, signal });
            }),
        );
        let failed = false;
        let ready = false;
        let stderrBytes = 0;
        let windowsIdentity: OwnedInvocationProcessIdentity | null = null;
        const linuxIdentities: OwnedInvocationProcessIdentity[] = [];
        const dispatch = createRestrictedPipeDispatch({
            ...config,
            stdin: owned.stdin,
            onInvalid: () => {
                failed = true;
            },
        });
        const invalidate = () => {
            failed = true;
            dispatch.fail();
        };
        deadline = setTimeout(() => {
            invalidate();
            owned.kill();
        }, remaining);
        owned.on("error", invalidate);
        owned.stdout.on("error", invalidate);
        owned.stderr.on("error", invalidate);
        owned.stderr.on("data", (chunk: Buffer) => {
            stderrBytes += chunk.byteLength;
            if (stderrBytes > 65_536) invalidate();
        });
        const frames = createRestrictedJsonFrames(config.maximumFrameBytes, (value) => {
            if (ready) {
                dispatch.receive(value);
                return;
            }
            const response = value as Record<string, unknown> | null;
            if (
                (response?.kind !== "owned" && response?.kind !== "ready" && response?.kind !== "startup-failure") ||
                response.protocol !== config.session.protocol ||
                response.hostInstanceId !== config.session.hostInstanceId ||
                response.sessionId !== config.session.sessionId
            )
                throw new Error("restricted service readiness mismatch");
            if (response.kind === "startup-failure") {
                port.postMessage({ ...response, kind: "failed", startupPhase: "service" });
                invalidate();
                return;
            }
            const processIdentity = response.processIdentity as OwnedInvocationProcessIdentity & {
                parentIdentity: OwnedInvocationProcessIdentity;
            };
            const reported = [processIdentity, processIdentity?.parentIdentity];
            const firstOwnership = linuxIdentities.length === 0;
            if (firstOwnership !== (response.kind === "owned")) throw new Error("restricted ownership handshake order mismatch");
            if (!reported.every(isIdentity) || reported[0]!.processId === reported[1]!.processId)
                throw new Error("invalid restricted process identity");
            if (firstOwnership)
                linuxIdentities.push(
                    ...reported.map((observed) => ({
                        processId: observed.processId,
                        lifecycleToken: observed.lifecycleToken,
                    })),
                );
            for (const [index, observed] of reported.entries()) {
                if (
                    linuxIdentities[index]?.processId !== observed.processId ||
                    linuxIdentities[index]?.lifecycleToken !== observed.lifecycleToken
                )
                    throw new Error("restricted readiness owner changed");
            }
            const fresh = observeSelectedWslProcessLifecyclePairBounded(
                config.distroName,
                [reported[0]!.processId, reported[1]!.processId],
                2_000,
            );
            for (const [index, observed] of reported.entries()) {
                const current = fresh[index];
                if (
                    current === undefined ||
                    current.processId !== observed.processId ||
                    current.lifecycleToken !== observed.lifecycleToken
                )
                    invalidate();
            }
            if (response.kind === "owned") {
                port.postMessage(response);
                return;
            }
            if (failed) throw new Error("restricted process failed before readiness");
            ready = true;
            port.postMessage({ ...response, windowsCodeVerificationTiming: codeObservation.timing });
        });
        owned.stdout.on("data", (chunk: Buffer) => {
            try {
                frames.push(chunk);
            } catch {
                invalidate();
            }
        });
        port.on("message", (message: ExchangeMessage | { kind: "close" }) => {
            if (message.kind === "close") {
                dispatch.close();
                return;
            }
            const notify = (ok: boolean, value?: unknown) => {
                if (message.header !== undefined && message.body !== undefined) {
                    const header = new Int32Array(message.header);
                    if (ok) {
                        const bytes = Buffer.from(JSON.stringify(value));
                        if (bytes.byteLength > message.body.byteLength) {
                            invalidate();
                            return;
                        }
                        if (Atomics.load(header, 0) === 0) {
                            new Uint8Array(message.body).set(bytes);
                            Atomics.store(header, 1, bytes.byteLength);
                            Atomics.compareExchange(header, 0, 0, 1);
                        }
                    } else Atomics.compareExchange(header, 0, 0, -1);
                    Atomics.notify(header, 0);
                } else port.postMessage({ kind: "response", operationId: message.operationId, ok, ...(ok ? { value } : {}) });
            };
            if (!ready || failed) {
                notify(false);
                return;
            }
            dispatch.submit({
                operationId: message.operationId,
                text: message.text,
                complete: (value) => notify(true, value),
                fail: () => notify(false),
            });
        });
        try {
            if (owned.pid === undefined) throw new Error("WSL process did not start");
            const observed = observeLocalProcessExecutableBounded(
                owned.pid,
                config.wslExecutablePath,
                { ...identity, entryKind: "file" },
                32_768,
            );
            if (observed === null) throw new Error("WSL host identity unavailable");
            windowsIdentity = { processId: observed.processId, lifecycleToken: observed.lifecycleToken };
            port.postMessage({ kind: "spawned", processIdentity: windowsIdentity });
        } catch {
            invalidate();
        }
        const result = await closedProcess;
        clearTimeout(deadline);
        try {
            frames.finish();
        } catch {
            failed = true;
        }
        dispatch.fail();
        let cleanupConfirmed = windowsIdentity !== null && linuxIdentities.length === 2;
        if (windowsIdentity !== null) {
            try {
                const observed = observeLocalProcessExecutableBounded(
                    windowsIdentity.processId,
                    config.wslExecutablePath,
                    { ...identity, entryKind: "file" },
                    32_768,
                );
                if (observed?.lifecycleToken === windowsIdentity.lifecycleToken) cleanupConfirmed = false;
            } catch (error) {
                if (
                    !(
                        error instanceof SafeFilesystemError &&
                        error.failureKind === "not_found" &&
                        error.operation === "observe_local_process" &&
                        error.targetPath === `process:${windowsIdentity.processId}`
                    )
                )
                    cleanupConfirmed = false;
            }
        }
        for (const observed of linuxIdentities) {
            try {
                const fresh = observeSelectedWslProcessLifecycleBounded(config.distroName, observed.processId, 2_000);
                if (fresh?.lifecycleToken === observed.lifecycleToken) cleanupConfirmed = false;
            } catch {
                cleanupConfirmed = false;
            }
        }
        port.postMessage({ kind: "closed", ...result, failed, stderrBytes, cleanupConfirmed, windowsIdentity, linuxIdentities });
    } catch (error) {
        port.postMessage({
            kind: "failed",
            startupPhase,
            detail: error instanceof Error ? error.message.slice(0, 256) : "restricted startup failed",
        });
        if (spawned && !closed && child !== undefined) {
            child.stdin?.end();
            await new Promise<void>((resolve) => child?.once("close", () => resolve()));
        }
        port.postMessage({ kind: "closed", failed: true, cleanupConfirmed: !spawned });
    } finally {
        // Keep the deadline while joining an owned child, including failed setup.
        // Once that join completes, no timer should retain the Worker.
        clearTimeout(deadline);
        port.close();
    }
}

function isIdentity(value: unknown): value is OwnedInvocationProcessIdentity {
    if (value === null || typeof value !== "object") return false;
    const identity = value as OwnedInvocationProcessIdentity;
    return (
        Number.isSafeInteger(identity.processId) &&
        identity.processId > 0 &&
        typeof identity.lifecycleToken === "string" &&
        /^[0-9]+$/u.test(identity.lifecycleToken)
    );
}

function validateLaunch(config: RestrictedProcessLaunch): string {
    const wslExecutablePath = requireRestrictedWslExecutable(config.wslExecutablePath, process.env);
    getWslAccessRootPath(config.distroName);
    if (
        !Number.isSafeInteger(config.deadlineAt) ||
        config.deadlineAt <= Date.now() + 5_000 ||
        config.deadlineAt > Date.now() + 600_000
    )
        throw new Error("invalid restricted process deadline");
    requireRestrictedCodePackage(config.code);
    if (
        !Number.isSafeInteger(config.maximumFrameBytes) ||
        config.maximumFrameBytes < 1 ||
        config.maximumFrameBytes > MAXIMUM_RESTRICTED_FRAME_BYTES ||
        !Number.isSafeInteger(config.maximumConcurrentRequests) ||
        config.maximumConcurrentRequests < 1 ||
        config.maximumConcurrentRequests > 16
    )
        throw new Error("invalid restricted process bounds");
    return wslExecutablePath;
}

void run();
