import {
    PROTOCOL_OPERATION_NAMES,
    createProtocolErrorResponse,
    createProtocolNotification,
    createProtocolResultResponse,
    parseProtocolRequest,
    type ProtocolRequestV1,
    type ProtocolResponseV1,
} from "../../packages/app-server/protocol/src";
import type { ClientMessageTransport } from "../../packages/client/framework/src";

const COMPLETE_REINDEX = Object.freeze({
    status: "complete" as const,
    value: Object.freeze({
        scannedAssets: 1,
        indexedAssets: 1,
        skippedAssets: 0,
        diagnostics: Object.freeze([]),
    }),
    diagnostics: Object.freeze([]),
});

const OPERATION_NAMES = new Set<string>(PROTOCOL_OPERATION_NAMES);

export type FakeLongBehavior = "mismatched_event" | "normal" | "terminal_before_ack" | "progress_after_terminal";

export class InMemoryClientTransport implements ClientMessageTransport {
    readonly #messageListeners = new Set<(message: unknown) => void>();
    readonly #closeListeners = new Set<(reason: unknown) => void>();
    #serverReceiver: ((message: unknown) => void) | null = null;
    #closed = false;

    public attachServer(receiver: (message: unknown) => void): void {
        this.#serverReceiver = receiver;
    }

    public send(message: ProtocolRequestV1): void {
        if (this.#closed) throw new Error("loopback transport is closed");
        const receiver = this.#serverReceiver;
        if (receiver === null) throw new Error("loopback server is not attached");
        queueMicrotask(() => receiver(message));
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
        this.#closed = true;
    }

    public deliverFromHost(message: unknown): void {
        queueMicrotask(() => {
            if (this.#closed) return;
            for (const listener of [...this.#messageListeners]) listener(message);
        });
    }

    public closeFromHost(reason: unknown): void {
        queueMicrotask(() => {
            if (this.#closed) return;
            this.#closed = true;
            for (const listener of [...this.#closeListeners]) listener(reason);
        });
    }
}

export class StrictFakeHostSession {
    public protectedCallbackCalls = 0;
    public readonly emitted: unknown[] = [];
    public closed = false;
    readonly #transport: InMemoryClientTransport;
    readonly #seenRequestIds = new Set<string>();
    readonly #longBehavior: FakeLongBehavior;
    #initialized = false;

    public constructor(transport: InMemoryClientTransport, longBehavior: FakeLongBehavior = "normal") {
        this.#transport = transport;
        this.#longBehavior = longBehavior;
        transport.attachServer((message) => this.receiveRaw(message));
    }

    public receiveRaw(message: unknown): void {
        if (this.closed) return;
        const trustedId = this.#trustedId(message);
        if (trustedId !== null && this.#seenRequestIds.has(trustedId)) {
            this.#rejectAndClose(trustedId, "protocol.duplicate_id", "duplicate request ID");
            return;
        }
        let request: ProtocolRequestV1;
        try {
            request = parseProtocolRequest(message);
        } catch {
            if (trustedId !== null) {
                const code = this.#looksLikeKnownMethod(message) ? "protocol.invalid_params" : "protocol.invalid_envelope";
                this.#rejectAndClose(trustedId, code, "invalid request");
            } else {
                this.#closeWithoutResponse();
            }
            return;
        }
        this.#seenRequestIds.add(request.id);
        if (!this.#initialized) {
            if (request.method !== "initialize") {
                this.#emit(
                    createProtocolErrorResponse(request.id, {
                        code: "protocol.not_initialized",
                        message: "initialize must be first",
                    }),
                );
                return;
            }
            this.#initialized = true;
            this.#emit(
                createProtocolResultResponse(request.id, "initialize", {
                    protocolVersion: 1,
                    hostInstanceId: "fake-host-1",
                    availableOperations: ["initialize", "asset.list", "asset.reindex"],
                }),
            );
            return;
        }
        if (request.method === "asset.list") {
            this.protectedCallbackCalls += 1;
            this.#emit(
                createProtocolResultResponse(request.id, "asset.list", {
                    status: "complete",
                    value: { assets: [] },
                    diagnostics: [],
                }),
            );
            return;
        }
        if (request.method === "asset.reindex") {
            this.protectedCallbackCalls += 1;
            this.#emitLongOperation(request.id);
            return;
        }
        this.#emit(
            createProtocolErrorResponse(request.id, {
                code: "protocol.unknown_method",
                message: "operation is not available in this fake Host",
            }),
        );
    }

    public sendUnknownNotification(): void {
        this.#emit({ method: "fake.unknown", params: {} });
    }

    public sendWrongResponseId(): void {
        this.#emit({ id: "wrong-id", result: { status: "complete", value: { assets: [] }, diagnostics: [] } });
    }

    #emitLongOperation(requestId: string): void {
        const acknowledgement = createProtocolResultResponse(requestId, "asset.reindex", {
            operationId: "operation-1",
        });
        const terminal = createProtocolNotification({
            method: "operation.terminal",
            params: {
                operationId: "operation-1",
                sequence: 1,
                operation: "asset.reindex",
                outcome: COMPLETE_REINDEX,
            },
        });
        const progress = createProtocolNotification({
            method: "operation.progress",
            params: {
                operationId: "operation-1",
                sequence: 2,
                operation: "asset.reindex",
                progress: { stage: "late", completedUnits: 1, totalUnits: 1 },
            },
        });
        if (this.#longBehavior === "terminal_before_ack") {
            this.#emit(terminal);
            this.#emit(acknowledgement);
            return;
        }
        this.#emit(acknowledgement);
        if (this.#longBehavior === "mismatched_event") {
            this.#emit({
                method: "operation.progress",
                params: {
                    operationId: "operation-1",
                    sequence: 1,
                    operation: "adapter.probe",
                    progress: { stage: "wrong", completedUnits: 0, totalUnits: 1 },
                },
            });
            return;
        }
        this.#emit(terminal);
        if (this.#longBehavior === "progress_after_terminal") this.#emit(progress);
    }

    #trustedId(message: unknown): string | null {
        if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
        const id = (message as { readonly id?: unknown }).id;
        return typeof id === "string" && id.length > 0 && id.trim() === id ? id : null;
    }

    #looksLikeKnownMethod(message: unknown): boolean {
        if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
        const method = (message as { readonly method?: unknown }).method;
        return typeof method === "string" && OPERATION_NAMES.has(method);
    }

    #rejectAndClose(
        id: string,
        code: "protocol.duplicate_id" | "protocol.invalid_envelope" | "protocol.invalid_params",
        message: string,
    ): void {
        this.#emit(createProtocolErrorResponse(id, { code, message }));
        this.#closeWithoutResponse();
    }

    #closeWithoutResponse(): void {
        this.closed = true;
        this.#transport.closeFromHost(new Error("fake Host closed invalid connection"));
    }

    #emit(message: ProtocolResponseV1 | unknown): void {
        this.emitted.push(message);
        this.#transport.deliverFromHost(message);
    }
}

export async function flushLoopback(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}
