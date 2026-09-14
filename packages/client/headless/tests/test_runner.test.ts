import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import type { ProductionHostLaunchOptions } from "@oaam/app-server-bootstrap";
import type { HostConnectionSink, ProductionHost } from "@oaam/app-server-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHeadlessProcess, type HeadlessProcessDependencies, writeHeadlessDiagnosticForTest } from "../src/run-headless";

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryArguments(): { readonly argv: string[]; readonly root: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-headless-runner-"));
    temporaryRoots.push(root);
    const state = path.join(root, "state");
    const access = path.join(root, "access");
    fs.mkdirSync(state);
    fs.mkdirSync(access);
    return {
        root,
        argv: [
            "--oaam-root",
            state,
            "--database-path",
            path.join(state, "oaam.sqlite"),
            "--platform",
            "linux",
            "--platform-instance-id",
            "runner-test",
            "--access-root",
            access,
        ],
    };
}

function chunks(...values: string[]): AsyncIterable<string> {
    return (async function* () {
        yield* values;
    })();
}

function captureWritable(options: { callbackError?: Error; throwError?: Error } = {}): {
    readonly output: Writable;
    readonly text: () => string;
} {
    const content: string[] = [];
    const output = {
        write(text: string, _encoding: string, callback: (error?: Error | null) => void) {
            if (options.throwError !== undefined) throw options.throwError;
            content.push(text);
            callback(options.callbackError ?? null);
            return options.callbackError === undefined;
        },
    } as unknown as Writable;
    return { output, text: () => content.join("") };
}

function fakeHost(
    receive: (sink: HostConnectionSink, message: unknown) => void,
    shutdown: () => Promise<void> = async () => undefined,
): ProductionHost {
    return {
        hostInstanceId: "fake-host",
        state: "ready",
        availableOperations: ["initialize", "asset.list"],
        openConnection(sink) {
            return {
                connectionId: "connection-1",
                registerLocalPathSelection: vi.fn(),
                receive: (message) => receive(sink, message),
                close: vi.fn(),
            };
        },
        drain: async () => undefined,
        shutdown,
    };
}

function dependencies(launchHost: (options: ProductionHostLaunchOptions) => ProductionHost): HeadlessProcessDependencies {
    let id = 0;
    return { launchHost, createRequestId: () => `internal-${++id}` };
}

describe("Headless process runner", () => {
    it("runs the real initialize and empty Core asset.list route before graceful EOF shutdown", async () => {
        const launch = temporaryArguments();
        const stdout = captureWritable();
        const stderr = captureWritable();
        const exitCode = await runHeadlessProcess({
            argv: launch.argv,
            input: chunks(
                `${JSON.stringify({
                    id: "initialize-1",
                    method: "initialize",
                    params: { protocolVersion: 1, clientKind: "headless", clientVersion: "0.1.0" },
                })}\n${JSON.stringify({ id: "asset-list-1", method: "asset.list", params: {} })}\n`,
            ),
            stdout: stdout.output,
            stderr: stderr.output,
        });
        expect(exitCode).toBe(0);
        expect(stderr.text()).toBe("");
        const responses = stdout
            .text()
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(responses).toHaveLength(2);
        expect(responses[0]).toMatchObject({ id: "initialize-1", result: { protocolVersion: 1 } });
        expect(responses[1]).toEqual({
            id: "asset-list-1",
            result: { status: "complete", value: { assets: [] }, diagnostics: [] },
        });
    });

    it("maps invalid launch configuration to exit 2, or 3 when stderr itself is unavailable", async () => {
        const stdout = captureWritable();
        const stderr = captureWritable();
        await expect(
            runHeadlessProcess({ argv: [], input: chunks(), stdout: stdout.output, stderr: stderr.output }),
        ).resolves.toBe(2);
        expect(stderr.text()).toBe("oaam-headless: invalid launch configuration\n");

        const failedStderr = captureWritable({ callbackError: new Error("stderr failed") });
        await expect(
            runHeadlessProcess({ argv: [], input: chunks(), stdout: stdout.output, stderr: failedStderr.output }),
        ).resolves.toBe(3);
    });

    it("maps Host startup failure to exit 3 without exposing the exception", async () => {
        const launch = temporaryArguments();
        const stderr = captureWritable();
        const failure = new Error("secret startup detail");
        const exitCode = await runHeadlessProcess(
            { argv: launch.argv, input: chunks(), stdout: captureWritable().output, stderr: stderr.output },
            dependencies(() => {
                throw failure;
            }),
        );
        expect(exitCode).toBe(3);
        expect(stderr.text()).toBe("oaam-headless: Host startup failed\n");
        expect(stderr.text()).not.toContain(failure.message);
    });

    it("maps malformed NDJSON to exit 2 and a thrown input stream to uncertain exit 3", async () => {
        const launch = temporaryArguments();
        const malformedStderr = captureWritable();
        const malformed = await runHeadlessProcess(
            {
                argv: launch.argv,
                input: chunks("{\n"),
                stdout: captureWritable().output,
                stderr: malformedStderr.output,
            },
            dependencies(() => fakeHost(() => undefined)),
        );
        expect(malformed).toBe(2);
        expect(malformedStderr.text()).toBe("oaam-headless: invalid Protocol input\n");

        const failedDiagnostic = await runHeadlessProcess(
            {
                argv: launch.argv,
                input: chunks("{\n"),
                stdout: captureWritable().output,
                stderr: captureWritable({ callbackError: new Error("stderr failed") }).output,
            },
            dependencies(() => fakeHost(() => undefined)),
        );
        expect(failedDiagnostic).toBe(3);

        const inputFailure = new Error("input failed");
        const uncertainStderr = captureWritable();
        const uncertain = await runHeadlessProcess(
            {
                argv: launch.argv,
                input: {
                    [Symbol.asyncIterator]() {
                        return {
                            next: async () => {
                                throw inputFailure;
                            },
                        };
                    },
                },
                stdout: captureWritable().output,
                stderr: uncertainStderr.output,
            },
            dependencies(() => fakeHost(() => undefined)),
        );
        expect(uncertain).toBe(3);
        expect(uncertainStderr.text()).toBe("oaam-headless: transport delivery uncertain\n");
    });

    it("preserves a worse accepted-operation channel failure while reporting later invalid input", async () => {
        const launch = temporaryArguments();
        const stdout = captureWritable();
        const stderr = captureWritable();
        const input = (async function* () {
            yield `${JSON.stringify({
                id: "initialize-1",
                method: "initialize",
                params: { protocolVersion: 1, clientKind: "headless", clientVersion: "0.1.0" },
            })}\n`;
            yield `${JSON.stringify({ id: "reindex-1", method: "asset.reindex", params: {} })}\n`;
            await new Promise<void>((resolve) => {
                setImmediate(resolve);
            });
            yield "{\n";
        })();
        const exitCode = await runHeadlessProcess(
            { argv: launch.argv, input, stdout: stdout.output, stderr: stderr.output },
            dependencies(() =>
                fakeHost((sink, message) => {
                    const record = message as { readonly id: string; readonly method: string };
                    if (record.method === "initialize") {
                        sink.send({
                            id: record.id,
                            result: {
                                protocolVersion: 1,
                                hostInstanceId: "fake-host",
                                availableOperations: ["initialize", "asset.reindex"],
                            },
                        });
                        return;
                    }
                    sink.send({ id: record.id, result: { operationId: "operation-1" } });
                    queueMicrotask(() => sink.close("accepted operation lost"));
                }),
            ),
        );
        expect(exitCode).toBe(3);
        expect(stderr.text()).toBe("oaam-headless: invalid Protocol input\n");
    });

    it("maps a closed Host channel and an output failure to exit 3", async () => {
        const launch = temporaryArguments();
        const initializeLine = `${JSON.stringify({
            id: "initialize-1",
            method: "initialize",
            params: { protocolVersion: 1, clientKind: "headless", clientVersion: "0.1.0" },
        })}\n`;
        const channelStderr = captureWritable();
        const channelExit = await runHeadlessProcess(
            {
                argv: launch.argv,
                input: chunks(initializeLine),
                stdout: captureWritable().output,
                stderr: channelStderr.output,
            },
            dependencies(() =>
                fakeHost((sink) => {
                    sink.close("channel lost");
                }),
            ),
        );
        expect(channelExit).toBe(3);
        expect(channelStderr.text()).toBe("oaam-headless: Host channel unavailable\n");

        const outputFailure = new Error("stdout failed");
        const outputStderr = captureWritable();
        const outputExit = await runHeadlessProcess(
            {
                argv: launch.argv,
                input: chunks(initializeLine),
                stdout: captureWritable({ callbackError: outputFailure }).output,
                stderr: outputStderr.output,
            },
            dependencies(() =>
                fakeHost((sink, message) => {
                    const record = message as { readonly id: string };
                    sink.send({
                        id: record.id,
                        result: {
                            protocolVersion: 1,
                            hostInstanceId: "fake-host",
                            availableOperations: ["initialize", "asset.list"],
                        },
                    });
                }),
            ),
        );
        expect(outputExit).toBe(3);
        expect(outputStderr.text()).toBe("oaam-headless: transport delivery uncertain\n");
    });

    it("raises exit 3 when graceful Host shutdown fails after otherwise successful input", async () => {
        const launch = temporaryArguments();
        const stdout = captureWritable();
        const stderr = captureWritable();
        const exitCode = await runHeadlessProcess(
            { argv: launch.argv, input: chunks(), stdout: stdout.output, stderr: stderr.output },
            dependencies(() =>
                fakeHost(
                    () => undefined,
                    async () => {
                        throw new Error("shutdown failed");
                    },
                ),
            ),
        );
        expect(exitCode).toBe(3);
        expect(stderr.text()).toBe("oaam-headless: Host shutdown failed\n");
    });

    it("enforces the fixed diagnostic byte bound and handles a synchronous stderr throw", async () => {
        const stderr = captureWritable();
        await expect(writeHeadlessDiagnosticForTest(stderr.output, "x".repeat(257))).rejects.toBeInstanceOf(RangeError);
        const failure = new Error("write threw");
        await expect(writeHeadlessDiagnosticForTest(captureWritable({ throwError: failure }).output, "bounded")).rejects.toBe(
            failure,
        );
    });
});
