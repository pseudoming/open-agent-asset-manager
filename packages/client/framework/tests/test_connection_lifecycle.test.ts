import { describe, expect, it } from "vitest";
import {
    ClientProtocolRejectionError,
    ClientStateError,
    ClientTransportError,
    type ClientAcceptedOperation,
    type ClientConnectionApi,
} from "../src";
import { createClientFixture, INITIALIZE_PARAMS, initializeFixture } from "./support/client-fixtures";

describe("Client Framework connection lifecycle and request correlation", () => {
    it("initializes once, advertises operations, and correlates an immediate request", async () => {
        const fixture = createClientFixture(["init-1", "request-1"]);
        expect(fixture.connection.state).toBe("created");
        expect(fixture.connection.availableOperations).toEqual([]);

        const initializing = fixture.connection.initialize(INITIALIZE_PARAMS);
        expect(fixture.connection.state).toBe("initializing");
        expect(() => fixture.connection.initialize(INITIALIZE_PARAMS)).toThrowError(ClientStateError);
        fixture.transport.emitMessage({
            id: "init-1",
            result: {
                protocolVersion: 1,
                hostInstanceId: "host-1",
                availableOperations: ["initialize", "asset.list"],
            },
        });
        await expect(initializing).resolves.toEqual({
            protocolVersion: 1,
            hostInstanceId: "host-1",
            availableOperations: ["initialize", "asset.list"],
        });
        expect(fixture.connection.state).toBe("ready");
        expect(fixture.connection.availableOperations).toEqual(["initialize", "asset.list"]);

        const request = fixture.connection.request("asset.list", {});
        fixture.transport.emitMessage({
            id: "request-1",
            result: { status: "complete", value: { assets: [] }, diagnostics: [] },
        });
        await expect(request).resolves.toEqual({ status: "complete", value: { assets: [] }, diagnostics: [] });
    });

    it("keeps Protocol rejection distinct and leaves an initialized connection usable", async () => {
        const fixture = createClientFixture(["init-1", "request-1", "request-2"]);
        await initializeFixture(fixture);
        const rejected = fixture.connection.request("asset.list", {});
        fixture.transport.emitMessage({
            id: "request-1",
            error: { code: "protocol.invalid_params", message: "bad request" },
        });
        await expect(rejected).rejects.toMatchObject({
            name: "ClientProtocolRejectionError",
            method: "asset.list",
            requestId: "request-1",
            rejection: { code: "protocol.invalid_params" },
        });
        await rejected.catch((error: unknown) => expect(error).toBeInstanceOf(ClientProtocolRejectionError));

        const next = fixture.connection.request("asset.list", {});
        fixture.transport.emitMessage({
            id: "request-2",
            result: { status: "complete", value: { assets: [] }, diagnostics: [] },
        });
        await expect(next).resolves.toMatchObject({ status: "complete" });
    });

    it("fails closed operations before readiness and unavailable or wrong-class calls after readiness", async () => {
        const fixture = createClientFixture(["init-1"]);
        expect(() => fixture.connection.request("asset.list", {})).toThrowError(
            expect.objectContaining({ code: "client.not_ready" }),
        );
        expect(() => fixture.connection.start("asset.reindex", {})).toThrowError(
            expect.objectContaining({ code: "client.not_ready" }),
        );
        await initializeFixture(fixture, ["initialize"]);
        expect(() => fixture.connection.request("asset.list", {})).toThrowError(
            expect.objectContaining({ code: "client.operation_unavailable" }),
        );
        expect(() =>
            fixture.connection.request(
                "asset.reindex" as Parameters<ClientConnectionApi["request"]>[0],
                {} as Parameters<ClientConnectionApi["request"]>[1],
            ),
        ).toThrowError(expect.objectContaining({ code: "client.invalid_call_class" }));
        expect(() =>
            fixture.connection.request(
                "initialize" as Parameters<ClientConnectionApi["request"]>[0],
                INITIALIZE_PARAMS as Parameters<ClientConnectionApi["request"]>[1],
            ),
        ).toThrowError(expect.objectContaining({ code: "client.invalid_call_class" }));
        expect(() =>
            fixture.connection.start(
                "asset.list" as Parameters<ClientConnectionApi["start"]>[0],
                {} as Parameters<ClientConnectionApi["start"]>[1],
            ),
        ).toThrowError(expect.objectContaining({ code: "client.invalid_call_class" }));
    });

    it("allows an explicit initialize retry only when transport reports not-sent", async () => {
        const fixture = createClientFixture(["init-1", "init-2"]);
        fixture.transport.sendFailure = new Error("not connected");
        const first = fixture.connection.initialize(INITIALIZE_PARAMS);
        await expect(first).rejects.toMatchObject({ delivery: "not_sent", method: "initialize" });
        await first.catch((error: unknown) => expect(error).toBeInstanceOf(ClientTransportError));
        expect(fixture.connection.state).toBe("created");

        fixture.transport.sendFailure = null;
        const second = fixture.connection.initialize(INITIALIZE_PARAMS);
        fixture.transport.emitMessage({
            id: "init-2",
            result: { protocolVersion: 1, hostInstanceId: "host-1", availableOperations: ["initialize"] },
        });
        await expect(second).resolves.toMatchObject({ hostInstanceId: "host-1" });
    });

    it("closes a connection whose initialization is rejected", async () => {
        const fixture = createClientFixture(["init-1"]);
        const closeReasons: unknown[] = [];
        fixture.connection.subscribeClose((reason) => closeReasons.push(reason));
        const pending = fixture.connection.initialize(INITIALIZE_PARAMS);
        fixture.transport.emitMessage({
            id: "init-1",
            error: { code: "protocol.incompatible_version", message: "upgrade required" },
        });
        await expect(pending).rejects.toBeInstanceOf(ClientProtocolRejectionError);
        expect(fixture.connection.state).toBe("closed");
        expect(fixture.transport.closeCalls).toBe(1);
        expect(closeReasons).toEqual([
            expect.objectContaining({ kind: "initialization_failed", cause: expect.any(ClientProtocolRejectionError) }),
        ]);
    });

    it("rejects invalid and reused request IDs before sending", async () => {
        for (const invalidId of [undefined, "", " request"]) {
            const fixture = createClientFixture([invalidId]);
            expect(() => fixture.connection.initialize(INITIALIZE_PARAMS), String(invalidId)).toThrowError(
                expect.objectContaining({ code: "client.invalid_request_id" }),
            );
            expect(fixture.connection.state).toBe("created");
            expect(fixture.transport.sent).toEqual([]);
        }

        const fixture = createClientFixture(["same", "same"]);
        await initializeFixture(fixture);
        expect(() => fixture.connection.request("asset.list", {})).toThrowError(
            expect.objectContaining({ code: "client.invalid_request_id" }),
        );
    });

    it("closes idempotently, clears subscriptions, and rejects use after close", async () => {
        const fixture = createClientFixture(["init-1"]);
        const invalidations: unknown[] = [];
        const closes: unknown[] = [];
        const unsubscribeInvalidation = fixture.connection.subscribeInvalidation((value) => invalidations.push(value));
        const unsubscribeClose = fixture.connection.subscribeClose((value) => closes.push(value));
        unsubscribeInvalidation();
        unsubscribeClose();
        fixture.connection.close();
        fixture.connection.close();
        fixture.transport.emitQueuedMessageAfterUnsubscribe({
            method: "resource.invalidated",
            params: { resourceKind: "asset", assetId: "bad" },
        });
        expect(fixture.transport.closeCalls).toBe(1);
        expect(invalidations).toEqual([]);
        expect(closes).toEqual([]);
        expect(fixture.connection.availableOperations).toEqual([]);
        expect(() => fixture.connection.initialize(INITIALIZE_PARAMS)).toThrowError(
            expect.objectContaining({ code: "client.closed" }),
        );
        expect(() => fixture.connection.request("asset.list", {})).toThrowError(
            expect.objectContaining({ code: "client.closed" }),
        );
        expect(() => fixture.connection.subscribeInvalidation(() => undefined)).toThrowError(
            expect.objectContaining({ code: "client.closed" }),
        );
        expect(() => fixture.connection.subscribeClose(() => undefined)).toThrowError(
            expect.objectContaining({ code: "client.closed" }),
        );
    });

    it("exposes the public accepted-operation type without broadening request results", () => {
        const typeWitness: ClientAcceptedOperation<"asset.reindex"> | null = null;
        expect(typeWitness).toBeNull();
    });
});
