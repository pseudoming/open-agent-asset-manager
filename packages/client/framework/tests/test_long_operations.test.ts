import { describe, expect, it } from "vitest";
import { ClientProtocolFaultError, ClientTransportError } from "../src";
import { createClientFixture, initializeFixture, REINDEX_TERMINAL } from "./support/client-fixtures";

function progress(operationId: string, sequence: number, operation = "asset.reindex") {
    return {
        method: "operation.progress",
        params: {
            operationId,
            sequence,
            operation,
            progress: { stage: "indexing", completedUnits: sequence, totalUnits: 3 },
        },
    };
}

function terminal(operationId: string, sequence: number, operation = "asset.reindex") {
    return {
        method: "operation.terminal",
        params: { operationId, sequence, operation, outcome: REINDEX_TERMINAL },
    };
}

describe("Client Framework accepted-long operation lifecycle", () => {
    it("requires acknowledgement before progress and resolves exactly one terminal outcome", async () => {
        const fixture = createClientFixture(["init-1", "long-1"]);
        await initializeFixture(fixture);
        const started = fixture.connection.start("asset.reindex", {});
        fixture.transport.emitMessage({ id: "long-1", result: { operationId: "operation-1" } });
        const handle = await started;
        expect(handle).toMatchObject({ operationId: "operation-1", operation: "asset.reindex" });
        expect(handle.terminalSequence).toBeNull();

        const seen: unknown[] = [];
        const unsubscribe = handle.subscribeProgress((value, sequence) => seen.push({ value, sequence }));
        fixture.transport.emitMessage(progress("operation-1", 1));
        unsubscribe();
        fixture.transport.emitMessage(progress("operation-1", 2));
        fixture.transport.emitMessage(terminal("operation-1", 3));
        await expect(handle.terminal).resolves.toEqual(REINDEX_TERMINAL);
        expect(handle.terminalSequence).toBe(3);
        expect(seen).toEqual([
            {
                value: { stage: "indexing", completedUnits: 1, totalUnits: 3 },
                sequence: 1,
            },
        ]);
        expect(handle.subscribeProgress(() => undefined)()).toBeUndefined();
    });

    it("fails the connection when an event arrives before acknowledgement", async () => {
        const fixture = createClientFixture(["init-1", "long-1"]);
        await initializeFixture(fixture);
        const closes: unknown[] = [];
        fixture.connection.subscribeClose((reason) => closes.push(reason));
        const started = fixture.connection.start("asset.reindex", {});
        fixture.transport.emitMessage(progress("operation-1", 1));
        await expect(started).rejects.toMatchObject({ name: "ClientProtocolFaultError", delivery: "uncertain" });
        await started.catch((error: unknown) => expect(error).toBeInstanceOf(ClientProtocolFaultError));
        expect(closes).toEqual([expect.objectContaining({ kind: "protocol" })]);
    });

    it("rejects duplicate operation IDs without leaving the second start unresolved", async () => {
        const fixture = createClientFixture(["init-1", "long-1", "long-2"]);
        await initializeFixture(fixture);
        const first = fixture.connection.start("asset.reindex", {});
        fixture.transport.emitMessage({ id: "long-1", result: { operationId: "operation-1" } });
        const firstHandle = await first;
        const second = fixture.connection.start("asset.reindex", {});
        fixture.transport.emitMessage({ id: "long-2", result: { operationId: "operation-1" } });
        await expect(second).rejects.toBeInstanceOf(ClientProtocolFaultError);
        await expect(firstHandle.terminal).rejects.toBeInstanceOf(ClientProtocolFaultError);
    });

    it("rejects mismatched, non-monotonic, and post-terminal events", async () => {
        const cases = [
            {
                label: "mismatched operation",
                first: progress("operation-1", 1, "deployment.deploy"),
                after: undefined,
            },
            {
                label: "non-monotonic sequence",
                first: progress("operation-1", 1),
                after: progress("operation-1", 1),
            },
            {
                label: "post-terminal event",
                first: terminal("operation-1", 1),
                after: progress("operation-1", 2),
            },
        ];
        for (const [index, testCase] of cases.entries()) {
            const fixture = createClientFixture([`init-${index}`, `long-${index}`]);
            await initializeFixture(fixture);
            const started = fixture.connection.start("asset.reindex", {});
            fixture.transport.emitMessage({ id: `long-${index}`, result: { operationId: "operation-1" } });
            const handle = await started;
            fixture.transport.emitMessage(testCase.first);
            if (testCase.after !== undefined) fixture.transport.emitMessage(testCase.after);
            expect(fixture.connection.state, testCase.label).toBe("closed");
            if (testCase.label === "post-terminal event") {
                await expect(handle.terminal).resolves.toEqual(REINDEX_TERMINAL);
            } else {
                await expect(handle.terminal).rejects.toBeInstanceOf(ClientProtocolFaultError);
            }
        }
    });

    it("marks an accepted operation uncertain when its transport closes", async () => {
        const fixture = createClientFixture(["init-1", "long-1"]);
        await initializeFixture(fixture);
        const started = fixture.connection.start("asset.reindex", {});
        fixture.transport.emitMessage({ id: "long-1", result: { operationId: "operation-1" } });
        const handle = await started;
        fixture.transport.emitClose(new Error("lost"));
        await expect(handle.terminal).rejects.toMatchObject({
            name: "ClientTransportError",
            delivery: "uncertain",
            method: "asset.reindex",
            requestId: null,
        });
        await handle.terminal.catch((error: unknown) => expect(error).toBeInstanceOf(ClientTransportError));
        expect(handle.subscribeProgress(() => undefined)()).toBeUndefined();
        expect(fixture.transport.closeCalls).toBe(0);
    });

    it("reports progress listener errors without breaking operation delivery", async () => {
        const fixture = createClientFixture(["init-1", "long-1"]);
        await initializeFixture(fixture);
        const started = fixture.connection.start("asset.reindex", {});
        fixture.transport.emitMessage({ id: "long-1", result: { operationId: "operation-1" } });
        const handle = await started;
        const listenerFailure = new Error("listener failed");
        handle.subscribeProgress(() => {
            throw listenerFailure;
        });
        fixture.transport.emitMessage(progress("operation-1", 1));
        fixture.transport.emitMessage(terminal("operation-1", 2));
        await expect(handle.terminal).resolves.toEqual(REINDEX_TERMINAL);
        expect(fixture.listenerErrors).toEqual([listenerFailure]);
    });
});
