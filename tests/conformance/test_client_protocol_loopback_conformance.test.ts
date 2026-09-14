import { describe, expect, it } from "vitest";
import { ClientProtocolFaultError, createClientConnection, type ClientConnectionApi } from "../../packages/client/framework/src";
import { flushLoopback, InMemoryClientTransport, StrictFakeHostSession, type FakeLongBehavior } from "./client-loopback-fixtures";

const INITIALIZE_PARAMS = Object.freeze({
    protocolVersion: 1 as const,
    clientKind: "headless" as const,
    clientVersion: "0.1.0",
});

function createLoopback(longBehavior: FakeLongBehavior = "normal") {
    const transport = new InMemoryClientTransport();
    const host = new StrictFakeHostSession(transport, longBehavior);
    let sequence = 0;
    const connection = createClientConnection(transport, {
        createRequestId: () => `request-${++sequence}`,
        reportListenerError: (error) => {
            throw error;
        },
    });
    return { transport, host, connection };
}

async function initialize(connection: ClientConnectionApi): Promise<void> {
    const pending = connection.initialize(INITIALIZE_PARAMS);
    await flushLoopback();
    await pending;
}

describe("Protocol and Client Framework in-memory loopback conformance", () => {
    it("runs initialization and one protected non-mutating operation through both strict packages", async () => {
        const { connection, host } = createLoopback();
        await initialize(connection);
        const pending = connection.request("asset.list", {});
        await flushLoopback();
        await expect(pending).resolves.toEqual({ status: "complete", value: { assets: [] }, diagnostics: [] });
        expect(host.protectedCallbackCalls).toBe(1);
        expect(connection.state).toBe("ready");
    });

    it("rejects malformed and wrong-operation requests before the protected callback", async () => {
        const invalidMessages = [
            null,
            [],
            { id: null, method: "asset.list", params: {} },
            { id: "bad-1", method: "asset.list" },
            { id: "bad-2", method: "asset.list", params: { foreign: true } },
            { id: "bad-3", method: "fake.operation", params: {} },
            { id: "bad-4", method: "asset.list", params: {}, jsonrpc: "2.0" },
        ];
        for (const message of invalidMessages) {
            const transport = new InMemoryClientTransport();
            const host = new StrictFakeHostSession(transport);
            host.receiveRaw(message);
            await flushLoopback();
            expect(host.protectedCallbackCalls, JSON.stringify(message)).toBe(0);
            expect(host.closed, JSON.stringify(message)).toBe(true);
            const trustedId =
                typeof message === "object" &&
                message !== null &&
                !Array.isArray(message) &&
                typeof (message as { id?: unknown }).id === "string";
            expect(host.emitted.length, JSON.stringify(message)).toBe(trustedId ? 1 : 0);
        }
    });

    it("rejects a valid operation before initialization without invoking it", async () => {
        const transport = new InMemoryClientTransport();
        const host = new StrictFakeHostSession(transport);
        host.receiveRaw({ id: "request-1", method: "asset.list", params: {} });
        await flushLoopback();
        expect(host.protectedCallbackCalls).toBe(0);
        expect(host.emitted).toEqual([
            {
                id: "request-1",
                error: { code: "protocol.not_initialized", message: "initialize must be first" },
            },
        ]);
        expect(host.closed).toBe(false);
    });

    it("rejects a duplicate raw request ID before a protected operation callback", async () => {
        const transport = new InMemoryClientTransport();
        const host = new StrictFakeHostSession(transport);
        host.receiveRaw({ id: "same", method: "initialize", params: INITIALIZE_PARAMS });
        host.receiveRaw({ id: "same", method: "asset.list", params: {} });
        await flushLoopback();
        expect(host.protectedCallbackCalls).toBe(0);
        expect(host.emitted.at(-1)).toEqual({
            id: "same",
            error: { code: "protocol.duplicate_id", message: "duplicate request ID" },
        });
        expect(host.closed).toBe(true);
    });

    it("fails deterministically when terminal arrives before acknowledgement", async () => {
        const { connection, host } = createLoopback("terminal_before_ack");
        await initialize(connection);
        const pending = connection.start("asset.reindex", {});
        await flushLoopback();
        await expect(pending).rejects.toMatchObject({ name: "ClientProtocolFaultError", delivery: "uncertain" });
        expect(host.protectedCallbackCalls).toBe(1);
        expect(connection.state).toBe("closed");
    });

    it("keeps the terminal outcome but closes on progress emitted after terminal", async () => {
        const { connection, host } = createLoopback("progress_after_terminal");
        await initialize(connection);
        const pending = connection.start("asset.reindex", {});
        await flushLoopback();
        const handle = await pending;
        await expect(handle.terminal).resolves.toMatchObject({ status: "complete" });
        expect(host.protectedCallbackCalls).toBe(1);
        expect(connection.state).toBe("closed");
    });

    it("closes when an operation event contradicts its acknowledgement", async () => {
        const { connection, host } = createLoopback("mismatched_event");
        await initialize(connection);
        const pending = connection.start("asset.reindex", {});
        await flushLoopback();
        const handle = await pending;
        await expect(handle.terminal).rejects.toBeInstanceOf(ClientProtocolFaultError);
        expect(host.protectedCallbackCalls).toBe(1);
        expect(connection.state).toBe("closed");
    });

    it("closes on an unknown notification or uncorrelated response without business success", async () => {
        for (const inject of [
            (host: StrictFakeHostSession) => host.sendUnknownNotification(),
            (host: StrictFakeHostSession) => host.sendWrongResponseId(),
        ]) {
            const { connection, host } = createLoopback();
            await initialize(connection);
            const reasons: unknown[] = [];
            connection.subscribeClose((reason) => reasons.push(reason));
            inject(host);
            await flushLoopback();
            expect(connection.state).toBe("closed");
            expect(host.protectedCallbackCalls).toBe(0);
            expect(reasons).toEqual([expect.objectContaining({ kind: "protocol", cause: expect.anything() })]);
            expect((reasons[0] as { cause: unknown }).cause).not.toBeInstanceOf(ClientProtocolFaultError);
        }
    });
});
