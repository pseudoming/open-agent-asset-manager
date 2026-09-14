import { describe, expect, it } from "vitest";
import { ClientProtocolFaultError, ClientTransportError } from "../src";
import { createClientFixture, INITIALIZE_PARAMS, initializeFixture } from "./support/client-fixtures";

describe("Client Framework transport, Protocol, and listener failure handling", () => {
    it("classifies sent query, mutation, cancel, and accepted-long loss without retrying", async () => {
        const cases = [
            { method: "asset.list" as const, params: {}, delivery: "interrupted" },
            {
                method: "project.register" as const,
                params: { localPathSelectionToken: "path-token" },
                delivery: "uncertain",
            },
            { method: "operation.cancel" as const, params: { operationId: "operation-1" }, delivery: "uncertain" },
        ];
        for (const [index, testCase] of cases.entries()) {
            const fixture = createClientFixture([`init-${index}`, `request-${index}`]);
            await initializeFixture(fixture);
            const pending = fixture.connection.request(testCase.method, testCase.params);
            fixture.transport.emitClose(new Error("lost"));
            await expect(pending, testCase.method).rejects.toMatchObject({
                name: "ClientTransportError",
                delivery: testCase.delivery,
                method: testCase.method,
                requestId: `request-${index}`,
            });
            expect(fixture.transport.sent).toHaveLength(2);
        }

        const fixture = createClientFixture(["init-long", "request-long"]);
        await initializeFixture(fixture);
        const pending = fixture.connection.start("asset.reindex", {});
        fixture.transport.emitClose(new Error("lost before acknowledgement"));
        await expect(pending).rejects.toMatchObject({ delivery: "uncertain", method: "asset.reindex" });
        expect(fixture.transport.sent).toHaveLength(2);
    });

    it("reports not-sent without closing an already-ready connection", async () => {
        const fixture = createClientFixture(["init-1", "request-1", "request-2"]);
        await initializeFixture(fixture);
        fixture.transport.sendFailure = new Error("queue rejected");
        const first = fixture.connection.request("asset.list", {});
        await expect(first).rejects.toMatchObject({ delivery: "not_sent", method: "asset.list" });
        expect(fixture.connection.state).toBe("ready");

        fixture.transport.sendFailure = null;
        const second = fixture.connection.request("asset.list", {});
        fixture.transport.emitMessage({
            id: "request-2",
            result: { status: "complete", value: { assets: [] }, diagnostics: [] },
        });
        await expect(second).resolves.toMatchObject({ status: "complete" });
    });

    it("fails on malformed, unknown, duplicate, and wrong-result responses", async () => {
        const cases: readonly ((id: string) => unknown)[] = [
            (id) => ({ id, result: { wrong: true } }),
            (id) => ({ id, result: {}, error: { code: "protocol.invalid_params", message: "bad" } }),
            () => ({ id: 7, result: {} }),
            () => ({ id: "unknown", result: {} }),
        ];
        for (const [index, response] of cases.entries()) {
            const fixture = createClientFixture([`init-${index}`, `request-${index}`]);
            await initializeFixture(fixture);
            const pending = fixture.connection.request("asset.list", {});
            fixture.transport.emitMessage(response(`request-${index}`));
            await expect(pending).rejects.toBeInstanceOf(ClientProtocolFaultError);
            expect(fixture.connection.state).toBe("closed");
        }

        const fixture = createClientFixture(["init-duplicate", "request-duplicate"]);
        await initializeFixture(fixture);
        const pending = fixture.connection.request("asset.list", {});
        const response = {
            id: "request-duplicate",
            result: { status: "complete", value: { assets: [] }, diagnostics: [] },
        };
        fixture.transport.emitMessage(response);
        await expect(pending).resolves.toMatchObject({ status: "complete" });
        fixture.transport.emitMessage(response);
        expect(fixture.connection.state).toBe("closed");
    });

    it("fails on notifications before ready and on unknown or malformed notifications", async () => {
        const beforeReady = createClientFixture(["init-1"]);
        const initialize = beforeReady.connection.initialize(INITIALIZE_PARAMS);
        beforeReady.transport.emitMessage({
            method: "resource.invalidated",
            params: { resourceKind: "collection", collection: "assets" },
        });
        await expect(initialize).rejects.toBeInstanceOf(ClientProtocolFaultError);

        for (const message of [
            { method: "unknown", params: {} },
            { method: "resource.invalidated", params: { resourceKind: "asset", assetId: "not-a-uuid" } },
            null,
        ]) {
            const fixture = createClientFixture(["init-1"]);
            await initializeFixture(fixture);
            fixture.transport.emitMessage(message);
            expect(fixture.connection.state).toBe("closed");
        }
    });

    it("delivers invalidations and isolates both invalidation and close listener failures", async () => {
        const fixture = createClientFixture(["init-1"]);
        await initializeFixture(fixture);
        const invalidations: unknown[] = [];
        const invalidationFailure = new Error("invalidation listener failed");
        const closeFailure = new Error("close listener failed");
        fixture.connection.subscribeInvalidation((value) => invalidations.push(value));
        fixture.connection.subscribeInvalidation(() => {
            throw invalidationFailure;
        });
        fixture.connection.subscribeClose(() => {
            throw closeFailure;
        });
        fixture.transport.emitMessage({
            method: "resource.invalidated",
            params: { resourceKind: "collection", collection: "assets" },
        });
        fixture.connection.close();
        expect(invalidations).toEqual([{ resourceKind: "collection", collection: "assets" }]);
        expect(fixture.listenerErrors).toEqual([invalidationFailure, closeFailure]);
    });

    it("contains a throwing transport close and reports it through the listener-error boundary", async () => {
        const fixture = createClientFixture(["init-1"]);
        await initializeFixture(fixture);
        const closeFailure = new Error("close failed");
        fixture.transport.closeFailure = closeFailure;
        fixture.connection.close();
        expect(fixture.connection.state).toBe("closed");
        expect(fixture.listenerErrors).toEqual([closeFailure]);
    });

    it("uses a Protocol fault rather than business success when initialization receives an invalid result", async () => {
        const fixture = createClientFixture(["init-1"]);
        const pending = fixture.connection.initialize(INITIALIZE_PARAMS);
        fixture.transport.emitMessage({
            id: "init-1",
            result: { protocolVersion: 1, hostInstanceId: "host-1", availableOperations: ["foreign"] },
        });
        await expect(pending).rejects.toMatchObject({ name: "ClientProtocolFaultError", delivery: "interrupted" });
        await pending.catch((error: unknown) => expect(error).toBeInstanceOf(ClientProtocolFaultError));
    });

    it("preserves Client transport error identity", () => {
        const error = new ClientTransportError("uncertain", "asset.reindex", null, "lost", new Error("cause"));
        expect(error).toMatchObject({
            name: "ClientTransportError",
            delivery: "uncertain",
            method: "asset.reindex",
            requestId: null,
        });
    });
});
