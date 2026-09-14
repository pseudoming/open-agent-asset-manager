import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import { createClientConnection, type ClientConnectionApi } from "../../src";
import { FakeClientTransport } from "./fake-transport";

export const INITIALIZE_PARAMS = Object.freeze({
    protocolVersion: 1 as const,
    clientKind: "headless" as const,
    clientVersion: "0.1.0",
});

export const REINDEX_TERMINAL = Object.freeze({
    status: "complete" as const,
    value: Object.freeze({
        scannedAssets: 1,
        indexedAssets: 1,
        skippedAssets: 0,
        diagnostics: Object.freeze([]),
    }),
    diagnostics: Object.freeze([]),
});

export interface ClientFixture {
    readonly connection: ClientConnectionApi;
    readonly transport: FakeClientTransport;
    readonly listenerErrors: unknown[];
}

export function createClientFixture(ids: readonly unknown[]): ClientFixture {
    const transport = new FakeClientTransport();
    const listenerErrors: unknown[] = [];
    let index = 0;
    const connection = createClientConnection(transport, {
        createRequestId: () => ids[index++] as string,
        reportListenerError: (error) => listenerErrors.push(error),
    });
    return { connection, transport, listenerErrors };
}

export async function initializeFixture(
    fixture: ClientFixture,
    availableOperations: readonly ProtocolOperationName[] = [
        "initialize",
        "asset.list",
        "asset.reindex",
        "project.register",
        "operation.observe",
        "operation.cancel",
    ],
): Promise<void> {
    const pending = fixture.connection.initialize(INITIALIZE_PARAMS);
    const request = fixture.transport.sent.at(-1);
    if (request === undefined) throw new Error("initialize request was not sent");
    fixture.transport.emitMessage({
        id: request.id,
        result: { protocolVersion: 1, hostInstanceId: "host-1", availableOperations },
    });
    await pending;
}
