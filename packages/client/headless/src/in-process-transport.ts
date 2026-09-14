import type { ProductionHost } from "@oaam/app-server-host";
import type { ProtocolRequestV1 } from "@oaam/app-server-protocol";
import type { ClientMessageTransport } from "@oaam/client-framework";

export class InProcessHostTransport implements ClientMessageTransport {
    readonly #messageListeners = new Set<(message: unknown) => void>();
    readonly #closeListeners = new Set<(reason: unknown) => void>();
    readonly #connection;
    #closed = false;

    public constructor(host: ProductionHost) {
        this.#connection = host.openConnection({
            send: (message) => {
                if (this.#closed) throw new Error("Headless transport is closed");
                for (const listener of this.#messageListeners) listener(message);
            },
            close: (reason) => this.#finishClose(reason),
        });
    }

    public send(message: ProtocolRequestV1): void {
        if (this.#closed) throw new Error("Headless transport is closed");
        this.#connection.receive(message);
    }

    public subscribeMessage(listener: (message: unknown) => void): () => void {
        this.#messageListeners.add(listener);
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
        if (this.#closed) return;
        this.#connection.close();
        this.#finishClose("Headless transport closed locally");
    }

    #finishClose(reason: unknown): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const listener of this.#closeListeners) listener(reason);
        this.#messageListeners.clear();
        this.#closeListeners.clear();
    }
}
