import type { ProtocolRequestV1 } from "@oaam/app-server-protocol";

export interface ClientMessageTransport {
    /**
     * Accept one request for ordered delivery or throw before peer delivery begins.
     * Implementations must not synchronously deliver a peer response before this call returns.
     */
    send(message: ProtocolRequestV1): void;
    subscribeMessage(listener: (message: unknown) => void): () => void;
    subscribeClose(listener: (reason: unknown) => void): () => void;
    close(): void;
}
