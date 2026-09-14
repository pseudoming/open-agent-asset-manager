import type { ProtocolRequestV1 } from "@oaam/app-server-protocol";
import type { ClientMessageTransport } from "@oaam/client-framework";

export interface BrowserProtocolPort {
    postMessage(message: unknown): void;
    start(): void;
    close(): void;
    addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
    addEventListener(type: "messageerror" | "close", listener: (event: Event) => void): void;
    removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
    removeEventListener(type: "messageerror" | "close", listener: (event: Event) => void): void;
}

export class MessagePortClientTransport implements ClientMessageTransport {
    readonly #port: BrowserProtocolPort;
    readonly #messageListeners = new Set<(message: unknown) => void>();
    readonly #closeListeners = new Set<(reason: unknown) => void>();
    readonly #onMessage = (event: MessageEvent<unknown>): void => {
        for (const listener of this.#messageListeners) listener(event.data);
    };
    readonly #onClose = (event: Event): void => {
        this.#closeFromPort(event);
    };
    #closed = false;

    public constructor(port: BrowserProtocolPort) {
        this.#port = port;
        port.addEventListener("message", this.#onMessage);
        port.addEventListener("messageerror", this.#onClose);
        port.addEventListener("close", this.#onClose);
        port.start();
    }

    public send(message: ProtocolRequestV1): void {
        if (this.#closed) throw new Error("Desktop Protocol port is closed");
        this.#port.postMessage(message);
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
        this.#closed = true;
        this.#detach();
        this.#port.close();
        this.#notifyClose("Desktop Client closed its Protocol port");
    }

    #closeFromPort(reason: unknown): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#detach();
        this.#notifyClose(reason);
    }

    #detach(): void {
        this.#port.removeEventListener("message", this.#onMessage);
        this.#port.removeEventListener("messageerror", this.#onClose);
        this.#port.removeEventListener("close", this.#onClose);
    }

    #notifyClose(reason: unknown): void {
        for (const listener of this.#closeListeners) listener(reason);
        this.#messageListeners.clear();
        this.#closeListeners.clear();
    }
}
