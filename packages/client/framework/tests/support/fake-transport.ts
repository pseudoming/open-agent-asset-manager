import type { ProtocolRequestV1 } from "@oaam/app-server-protocol";
import type { ClientMessageTransport } from "../../src";

export class FakeClientTransport implements ClientMessageTransport {
    public readonly sent: ProtocolRequestV1[] = [];
    public closeCalls = 0;
    public sendFailure: unknown | null = null;
    public closeFailure: unknown | null = null;
    readonly #messageListeners = new Set<(message: unknown) => void>();
    readonly #closeListeners = new Set<(reason: unknown) => void>();
    #staleMessageListener: ((message: unknown) => void) | null = null;

    public send(message: ProtocolRequestV1): void {
        if (this.sendFailure !== null) throw this.sendFailure;
        this.sent.push(message);
    }

    public subscribeMessage(listener: (message: unknown) => void): () => void {
        this.#messageListeners.add(listener);
        this.#staleMessageListener = listener;
        return () => {
            this.#messageListeners.delete(listener);
        };
    }

    public subscribeClose(listener: (reason: unknown) => void): () => void {
        this.#closeListeners.add(listener);
        return () => {
            this.#closeListeners.delete(listener);
        };
    }

    public close(): void {
        this.closeCalls += 1;
        if (this.closeFailure !== null) throw this.closeFailure;
    }

    public emitMessage(message: unknown): void {
        for (const listener of [...this.#messageListeners]) listener(message);
    }

    public emitClose(reason: unknown): void {
        for (const listener of [...this.#closeListeners]) listener(reason);
    }

    public emitQueuedMessageAfterUnsubscribe(message: unknown): void {
        this.#staleMessageListener?.(message);
    }
}
