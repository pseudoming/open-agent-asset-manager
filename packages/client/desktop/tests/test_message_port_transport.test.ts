import { describe, expect, it, vi } from "vitest";
import { MessagePortClientTransport, type BrowserProtocolPort } from "../src/renderer/client";

class FakeBrowserPort implements BrowserProtocolPort {
    readonly posted: unknown[] = [];
    readonly listeners = new Map<string, Set<(event: never) => void>>();
    started = false;
    closed = false;

    public postMessage(message: unknown): void {
        this.posted.push(message);
    }

    public start(): void {
        this.started = true;
    }

    public close(): void {
        this.closed = true;
    }

    public addEventListener(type: string, listener: (event: never) => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    public removeEventListener(type: string, listener: (event: never) => void): void {
        this.listeners.get(type)?.delete(listener);
    }

    public emit(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event as never);
    }
}

describe("Desktop MessagePort Client transport", () => {
    it("delivers ordered Protocol messages and local close exactly once", () => {
        const port = new FakeBrowserPort();
        const transport = new MessagePortClientTransport(port);
        const messages: unknown[] = [];
        const closes: unknown[] = [];
        const unsubscribeMessage = transport.subscribeMessage((message) => messages.push(message));
        const unsubscribeClose = transport.subscribeClose((reason) => closes.push(reason));
        expect(port.started).toBe(true);
        transport.send({ id: "1", method: "asset.list", params: {} });
        port.emit("message", { data: { id: "1", result: {} } });
        expect(port.posted).toHaveLength(1);
        expect(messages).toEqual([{ id: "1", result: {} }]);
        transport.close();
        transport.close();
        expect(port.closed).toBe(true);
        expect(closes).toEqual(["Desktop Client closed its Protocol port"]);
        expect(() => transport.send({ id: "2", method: "asset.list", params: {} })).toThrow(/closed/u);
        unsubscribeMessage();
        unsubscribeClose();
    });

    it.each(["messageerror", "close"])("turns remote %s into one transport close", (eventName) => {
        const port = new FakeBrowserPort();
        const transport = new MessagePortClientTransport(port);
        const listener = vi.fn();
        transport.subscribeClose(listener);
        const reason = new Event(eventName);
        port.emit(eventName, reason);
        port.emit(eventName, reason);
        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith(reason);
    });
});
