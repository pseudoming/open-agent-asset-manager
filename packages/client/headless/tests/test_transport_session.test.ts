import type { Writable } from "node:stream";
import type { ProductionHost } from "@oaam/app-server-host";
import type {
    ProtocolAcceptedLongOperationName,
    ProtocolInvalidationV1,
    ProtocolOperationProgress,
    ProtocolOperationTerminal,
} from "@oaam/app-server-protocol";
import {
    ClientProtocolFaultError,
    ClientProtocolRejectionError,
    ClientStateError,
    ClientTransportError,
    type ClientAcceptedOperation,
    type ClientConnectionApi,
} from "@oaam/client-framework";
import { describe, expect, it, vi } from "vitest";
import { HeadlessChannelError, HeadlessInputError, HeadlessProtocolSession } from "../src/headless-session";
import { InProcessHostTransport } from "../src/in-process-transport";
import { SerializedProtocolWriter } from "../src/ndjson";

const INITIALIZED = Object.freeze({
    protocolVersion: 1 as const,
    hostInstanceId: "host-1",
    availableOperations: Object.freeze(["initialize", "asset.list", "asset.reindex"] as const),
});
const ASSET_LIST = Object.freeze({
    status: "complete" as const,
    value: Object.freeze({ assets: Object.freeze([]) }),
    diagnostics: Object.freeze([]),
});
const REINDEX_TERMINAL = Object.freeze({
    status: "complete" as const,
    value: Object.freeze({
        scannedAssets: 1,
        indexedAssets: 1,
        skippedAssets: 0,
        diagnostics: Object.freeze([]),
    }),
    diagnostics: Object.freeze([]),
});

function captureWriter(): { readonly lines: unknown[]; readonly writer: SerializedProtocolWriter } {
    const lines: unknown[] = [];
    const output = {
        write(text: string, _encoding: string, callback: (error?: Error | null) => void) {
            lines.push(JSON.parse(text));
            callback(null);
            return true;
        },
    } as unknown as Writable;
    return { lines, writer: new SerializedProtocolWriter(output) };
}

interface FakeClientFixture {
    readonly client: ClientConnectionApi;
    readonly emitInvalidation: (value: ProtocolInvalidationV1) => void;
    readonly emitClose: () => void;
    readonly emitStaleClose: () => void;
    readonly close: ReturnType<typeof vi.fn>;
    readonly unsubscribeInvalidation: ReturnType<typeof vi.fn>;
    readonly unsubscribeClose: ReturnType<typeof vi.fn>;
}

function fakeClient(
    options: {
        initialize?: () => Promise<unknown>;
        request?: () => Promise<unknown>;
        start?: () => Promise<ClientAcceptedOperation<ProtocolAcceptedLongOperationName>>;
    } = {},
): FakeClientFixture {
    let invalidationListener: ((value: ProtocolInvalidationV1) => void) | null = null;
    let closeListener: (() => void) | null = null;
    let staleCloseListener: (() => void) | null = null;
    const close = vi.fn();
    const unsubscribeInvalidation = vi.fn();
    const unsubscribeClose = vi.fn();
    const client = {
        state: "ready",
        availableOperations: ["initialize", "asset.list", "asset.reindex"],
        initialize: vi.fn(options.initialize ?? (async () => INITIALIZED)),
        request: vi.fn(options.request ?? (async () => ASSET_LIST)),
        start: vi.fn(
            options.start ??
                (async () => {
                    throw new Error("no accepted operation configured");
                }),
        ),
        subscribeInvalidation(listener: (value: ProtocolInvalidationV1) => void) {
            invalidationListener = listener;
            return () => {
                invalidationListener = null;
                unsubscribeInvalidation();
            };
        },
        subscribeClose(listener: () => void) {
            closeListener = listener;
            staleCloseListener = listener;
            return () => {
                closeListener = null;
                unsubscribeClose();
            };
        },
        close,
    } as unknown as ClientConnectionApi;
    return {
        client,
        emitInvalidation: (value) => invalidationListener?.(value),
        emitClose: () => closeListener?.(),
        emitStaleClose: () => staleCloseListener?.(),
        close,
        unsubscribeInvalidation,
        unsubscribeClose,
    };
}

function request(id: string, method = "asset.list", params: unknown = {}): string {
    return JSON.stringify({ id, method, params });
}

function acceptedHandle(
    options: { terminal?: Promise<ProtocolOperationTerminal<"asset.reindex">>; terminalSequence?: () => number | null } = {},
): {
    readonly handle: ClientAcceptedOperation<"asset.reindex">;
    readonly emitProgress: (value: ProtocolOperationProgress<"asset.reindex">, sequence: number) => void;
    readonly unsubscribe: ReturnType<typeof vi.fn>;
} {
    let progressListener: ((value: ProtocolOperationProgress<"asset.reindex">, sequence: number) => void) | null = null;
    const unsubscribe = vi.fn();
    const handle = {
        operationId: "operation-1",
        operation: "asset.reindex" as const,
        terminal: options.terminal ?? Promise.resolve(REINDEX_TERMINAL),
        get terminalSequence() {
            return options.terminalSequence === undefined ? 2 : options.terminalSequence();
        },
        subscribeProgress(listener: (value: ProtocolOperationProgress<"asset.reindex">, sequence: number) => void) {
            progressListener = listener;
            return () => {
                progressListener = null;
                unsubscribe();
            };
        },
    };
    return { handle, emitProgress: (value, sequence) => progressListener?.(value, sequence), unsubscribe };
}

describe("in-process Headless Host transport", () => {
    it("forwards requests, messages, close, and unsubscribe through one Host connection", () => {
        let sink: Parameters<ProductionHost["openConnection"]>[0] | undefined;
        const receive = vi.fn();
        const connectionClose = vi.fn(() => sink?.close("host close"));
        const host = {
            openConnection(nextSink: Parameters<ProductionHost["openConnection"]>[0]) {
                sink = nextSink;
                return { connectionId: "connection-1", registerLocalPathSelection: vi.fn(), receive, close: connectionClose };
            },
        } as unknown as ProductionHost;
        const transport = new InProcessHostTransport(host);
        const messages: unknown[] = [];
        const closes: unknown[] = [];
        const unsubscribeMessage = transport.subscribeMessage((message) => messages.push(message));
        const unsubscribeClose = transport.subscribeClose((reason) => closes.push(reason));
        const sent = { id: "request-1", method: "asset.list", params: {} } as const;

        transport.send(sent);
        sink?.send({ id: "request-1", result: ASSET_LIST });
        expect(receive).toHaveBeenCalledWith(sent);
        expect(messages).toEqual([{ id: "request-1", result: ASSET_LIST }]);
        unsubscribeMessage();
        sink?.send({ id: "request-2", result: ASSET_LIST });
        transport.close();
        transport.close();
        unsubscribeClose();

        expect(connectionClose).toHaveBeenCalledTimes(1);
        expect(closes).toEqual(["host close"]);
        expect(() => transport.send(sent)).toThrow(/transport is closed/u);
        expect(() => sink?.send({ id: "request-3", result: ASSET_LIST })).toThrow(/transport is closed/u);
    });

    it("propagates a Client message-listener failure to the Host send boundary", () => {
        let sink: Parameters<ProductionHost["openConnection"]>[0] | undefined;
        const host = {
            openConnection(nextSink: Parameters<ProductionHost["openConnection"]>[0]) {
                sink = nextSink;
                return { connectionId: "connection-1", registerLocalPathSelection: vi.fn(), receive: vi.fn(), close: vi.fn() };
            },
        } as unknown as ProductionHost;
        const transport = new InProcessHostTransport(host);
        const failure = new Error("listener failed");
        transport.subscribeMessage(() => {
            throw failure;
        });
        expect(() => sink?.send({ id: "request-1", result: ASSET_LIST })).toThrow(failure);
    });
});

describe("Headless Protocol session", () => {
    it("round-trips initialize, immediate outcomes, invalidation, and local close", async () => {
        const fixture = fakeClient();
        const output = captureWriter();
        const session = new HeadlessProtocolSession(fixture.client, output.writer);
        await session.acceptLine(
            request("initialize-1", "initialize", {
                protocolVersion: 1,
                clientKind: "headless",
                clientVersion: "0.1.0",
            }),
        );
        await session.acceptLine(request("asset-list-1"));
        fixture.emitInvalidation({ resourceKind: "collection", collection: "assets" });
        expect(await session.finish()).toBe(0);
        expect(output.lines).toEqual([
            { id: "initialize-1", result: INITIALIZED },
            { id: "asset-list-1", result: ASSET_LIST },
            { method: "resource.invalidated", params: { resourceKind: "collection", collection: "assets" } },
        ]);
        session.close();
        session.close();
        fixture.emitClose();
        fixture.emitStaleClose();
        expect(fixture.unsubscribeInvalidation).toHaveBeenCalledTimes(1);
        expect(fixture.unsubscribeClose).toHaveBeenCalledTimes(1);
        expect(fixture.close).toHaveBeenCalledTimes(1);
        expect(session.exitCode).toBe(0);
    });

    it.each([
        ["partial", { status: "partial", value: { assets: [] }, diagnostics: [] }],
        ["failed", { status: "failed", diagnostics: [] }],
    ])("maps a %s Core outcome to exit 1", async (_label, result) => {
        const fixture = fakeClient({ request: async () => result });
        const output = captureWriter();
        const session = new HeadlessProtocolSession(fixture.client, output.writer);
        await session.acceptLine(request("asset-list-1"));
        expect(await session.finish()).toBe(1);
    });

    it("rejects malformed and duplicate external request IDs without ambiguity", async () => {
        const fixture = fakeClient();
        const output = captureWriter();
        const session = new HeadlessProtocolSession(fixture.client, output.writer);
        await expect(session.acceptLine("{")).rejects.toBeInstanceOf(HeadlessInputError);
        expect(session.exitCode).toBe(2);

        const duplicateFixture = fakeClient();
        const duplicateOutput = captureWriter();
        const duplicateSession = new HeadlessProtocolSession(duplicateFixture.client, duplicateOutput.writer);
        await duplicateSession.acceptLine(request("same-id"));
        await expect(duplicateSession.acceptLine(request("same-id"))).rejects.toBeInstanceOf(HeadlessInputError);
        expect(await duplicateSession.finish()).toBe(2);
        expect(duplicateOutput.lines.at(-1)).toEqual({
            id: "same-id",
            error: {
                code: "protocol.duplicate_id",
                message: "Request id was already used by this Headless session.",
            },
        });
    });

    it("forwards progress and preserves the exact terminal sequence", async () => {
        let terminalSequence: number | null = null;
        let resolveTerminal: ((value: ProtocolOperationTerminal<"asset.reindex">) => void) | undefined;
        const terminal = new Promise<ProtocolOperationTerminal<"asset.reindex">>((resolve) => {
            resolveTerminal = resolve;
        });
        const accepted = acceptedHandle({ terminal, terminalSequence: () => terminalSequence });
        const fixture = fakeClient({ start: async () => accepted.handle });
        const output = captureWriter();
        const session = new HeadlessProtocolSession(fixture.client, output.writer);
        await session.acceptLine(request("reindex-1", "asset.reindex"));
        accepted.emitProgress({ stage: "indexing", completedUnits: 1, totalUnits: 2 }, 1);
        terminalSequence = 2;
        resolveTerminal?.(REINDEX_TERMINAL);
        expect(await session.finish()).toBe(0);
        expect(output.lines).toEqual([
            { id: "reindex-1", result: { operationId: "operation-1" } },
            {
                method: "operation.progress",
                params: {
                    operationId: "operation-1",
                    sequence: 1,
                    operation: "asset.reindex",
                    progress: { stage: "indexing", completedUnits: 1, totalUnits: 2 },
                },
            },
            {
                method: "operation.terminal",
                params: {
                    operationId: "operation-1",
                    sequence: 2,
                    operation: "asset.reindex",
                    outcome: REINDEX_TERMINAL,
                },
            },
        ]);
    });

    it.each([
        ["terminal rejection", () => Promise.reject(new Error("lost")), () => 2],
        ["missing terminal sequence", () => Promise.resolve(REINDEX_TERMINAL), () => null],
    ])("maps %s to exit 3 without fabricating a terminal event", async (_label, createTerminal, terminalSequence) => {
        const accepted = acceptedHandle({ terminal: createTerminal(), terminalSequence });
        const fixture = fakeClient({ start: async () => accepted.handle });
        const output = captureWriter();
        const session = new HeadlessProtocolSession(fixture.client, output.writer);
        await session.acceptLine(request("reindex-1", "asset.reindex"));
        expect(await session.finish()).toBe(3);
        expect(output.lines).toEqual([{ id: "reindex-1", result: { operationId: "operation-1" } }]);
    });

    it("projects typed Protocol and recoverable Client state rejections", async () => {
        const cases = [
            new ClientProtocolRejectionError("asset.list", "internal", {
                code: "protocol.invalid_params",
                message: "bad params",
            }),
            new ClientStateError("client.not_ready", "not ready"),
            new ClientStateError("client.already_initialized", "already"),
            new ClientStateError("client.invalid_call_class", "wrong class"),
            new ClientStateError("client.operation_unavailable", "unavailable"),
        ];
        for (const [index, failure] of cases.entries()) {
            const fixture = fakeClient({
                request: async () => {
                    throw failure;
                },
            });
            const output = captureWriter();
            const session = new HeadlessProtocolSession(fixture.client, output.writer);
            await session.acceptLine(request(`request-${index}`));
            expect(await session.finish()).toBe(2);
            expect(output.lines).toHaveLength(1);
            expect(output.lines[0]).toMatchObject({
                id: `request-${index}`,
                error: { code: expect.stringMatching(/^protocol\./u) },
            });
        }
    });

    it.each([
        new ClientStateError("client.closed", "closed"),
        new ClientStateError("client.invalid_request_id", "bad id"),
        new ClientTransportError("uncertain", "asset.list", "internal", "lost", null),
        new ClientProtocolFaultError("uncertain", "asset.list", "internal", null),
    ])("maps a channel failure to HeadlessChannelError", async (failure) => {
        const fixture = fakeClient({
            request: async () => {
                throw failure;
            },
        });
        const session = new HeadlessProtocolSession(fixture.client, captureWriter().writer);
        await expect(session.acceptLine(request("asset-list-1"))).rejects.toBeInstanceOf(HeadlessChannelError);
        expect(session.exitCode).toBe(3);
    });

    it("rethrows an unexpected implementation failure and records a remote close", async () => {
        const failure = new Error("unexpected");
        const fixture = fakeClient({
            request: async () => {
                throw failure;
            },
        });
        const session = new HeadlessProtocolSession(fixture.client, captureWriter().writer);
        await expect(session.acceptLine(request("asset-list-1"))).rejects.toBe(failure);
        expect(session.exitCode).toBe(3);

        const closeFixture = fakeClient();
        const closeSession = new HeadlessProtocolSession(closeFixture.client, captureWriter().writer);
        closeFixture.emitClose();
        expect(closeSession.exitCode).toBe(3);
    });
});
