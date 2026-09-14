import {
    PROTOCOL_ACCEPTED_LONG_NAMES,
    PROTOCOL_OPERATION_REGISTRY,
    createProtocolRequest,
    isProtocolResponseCandidate,
    parseProtocolNotification,
    parseProtocolResponse,
    type ProtocolAcceptedLongOperationName,
    type ProtocolInvalidationV1,
    type ProtocolOperationName,
    type ProtocolOperationParams,
    type ProtocolOperationProgress,
    type ProtocolOperationResult,
    type ProtocolOperationTerminal,
} from "@oaam/app-server-protocol";
import {
    ClientProtocolFaultError,
    ClientProtocolRejectionError,
    ClientStateError,
    ClientTransportError,
    type ClientDeliveryDisposition,
} from "./errors";
import type { ClientMessageTransport } from "./transport";
import type {
    ClientAcceptedOperation,
    ClientConnectionApi,
    ClientConnectionCloseReason,
    ClientConnectionOptions,
    ClientConnectionState,
    ClientRequestOperationName,
} from "./types";

interface PendingRequest {
    readonly id: string;
    readonly method: ProtocolOperationName;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
}

interface OperationTracker<TName extends ProtocolAcceptedLongOperationName = ProtocolAcceptedLongOperationName> {
    readonly operationId: string;
    readonly operation: TName;
    readonly listeners: Set<(progress: ProtocolOperationProgress<TName>, sequence: number) => void>;
    readonly resolveTerminal: (outcome: ProtocolOperationTerminal<TName>) => void;
    readonly rejectTerminal: (error: unknown) => void;
    handle: ClientAcceptedOperation<TName>;
    lastSequence: number;
    terminal: boolean;
}

const ACCEPTED_LONG_NAMES = new Set<ProtocolOperationName>(PROTOCOL_ACCEPTED_LONG_NAMES);

function deliveryAfterSend(method: ProtocolOperationName): Exclude<ClientDeliveryDisposition, "not_sent"> {
    const delivery = PROTOCOL_OPERATION_REGISTRY[method].delivery;
    return delivery === "immediate_mutation" || delivery === "accepted_long" || method === "operation.cancel"
        ? "uncertain"
        : "interrupted";
}

function isAcceptedLongOperation(method: ProtocolOperationName): method is ProtocolAcceptedLongOperationName {
    return ACCEPTED_LONG_NAMES.has(method);
}

export class ClientConnection implements ClientConnectionApi {
    readonly #transport: ClientMessageTransport;
    readonly #createRequestId: () => string;
    readonly #reportListenerError: (error: unknown) => void;
    readonly #pending = new Map<string, PendingRequest>();
    readonly #usedRequestIds = new Set<string>();
    readonly #operations = new Map<string, OperationTracker>();
    readonly #invalidationListeners = new Set<(invalidation: ProtocolInvalidationV1) => void>();
    readonly #closeListeners = new Set<(reason: ClientConnectionCloseReason) => void>();
    readonly #unsubscribeMessage: () => void;
    readonly #unsubscribeClose: () => void;
    #state: ClientConnectionState = "created";
    #availableOperations: readonly ProtocolOperationName[] = Object.freeze([]);
    #availableOperationSet = new Set<ProtocolOperationName>();

    public constructor(transport: ClientMessageTransport, options: ClientConnectionOptions) {
        this.#transport = transport;
        this.#createRequestId = options.createRequestId;
        this.#reportListenerError = options.reportListenerError;
        this.#unsubscribeMessage = transport.subscribeMessage((message) => this.#receive(message));
        this.#unsubscribeClose = transport.subscribeClose((reason) => this.#closeFromTransport(reason));
    }

    public get state(): ClientConnectionState {
        return this.#state;
    }

    public get availableOperations(): readonly ProtocolOperationName[] {
        return this.#availableOperations;
    }

    public initialize(params: ProtocolOperationParams<"initialize">): Promise<ProtocolOperationResult<"initialize">> {
        if (this.#state !== "created") {
            const code = this.#state === "closed" ? "client.closed" : "client.already_initialized";
            throw new ClientStateError(code, "this Client connection cannot initialize again");
        }
        this.#state = "initializing";
        let pending: Promise<ProtocolOperationResult<"initialize">>;
        try {
            pending = this.#dispatch("initialize", params);
        } catch (error) {
            this.#state = "created";
            throw error;
        }
        return pending.catch((error: unknown) => {
            if (this.#state === "initializing") {
                if (error instanceof ClientTransportError && error.delivery === "not_sent") {
                    this.#state = "created";
                } else {
                    this.#transitionClosed(Object.freeze({ kind: "initialization_failed", cause: error }), true);
                }
            }
            throw error;
        });
    }

    public request<TName extends ClientRequestOperationName>(
        method: TName,
        params: ProtocolOperationParams<TName>,
    ): Promise<ProtocolOperationResult<TName>> {
        this.#assertReady();
        const runtimeMethod: string = method;
        if (runtimeMethod === "initialize" || ACCEPTED_LONG_NAMES.has(runtimeMethod as ProtocolOperationName)) {
            throw new ClientStateError("client.invalid_call_class", `${method} is not a request-class operation`);
        }
        this.#assertAvailable(method);
        return this.#dispatch(method, params);
    }

    public start<TName extends ProtocolAcceptedLongOperationName>(
        method: TName,
        params: ProtocolOperationParams<TName>,
    ): Promise<ClientAcceptedOperation<TName>> {
        this.#assertReady();
        if (!isAcceptedLongOperation(method)) {
            throw new ClientStateError("client.invalid_call_class", `${method} is not an accepted-long operation`);
        }
        this.#assertAvailable(method);
        return this.#dispatch(method, params) as Promise<ClientAcceptedOperation<TName>>;
    }

    public subscribeInvalidation(listener: (invalidation: ProtocolInvalidationV1) => void): () => void {
        this.#assertNotClosed();
        this.#invalidationListeners.add(listener);
        return () => {
            this.#invalidationListeners.delete(listener);
        };
    }

    public subscribeClose(listener: (reason: ClientConnectionCloseReason) => void): () => void {
        this.#assertNotClosed();
        this.#closeListeners.add(listener);
        return () => {
            this.#closeListeners.delete(listener);
        };
    }

    public close(): void {
        this.#transitionClosed(Object.freeze({ kind: "local", cause: "client close requested" }), true);
    }

    #assertReady(): void {
        if (this.#state !== "ready") {
            const code = this.#state === "closed" ? "client.closed" : "client.not_ready";
            throw new ClientStateError(code, "the Client connection is not ready");
        }
    }

    #assertNotClosed(): void {
        if (this.#state === "closed") {
            throw new ClientStateError("client.closed", "the Client connection is closed");
        }
    }

    #assertAvailable(method: ProtocolOperationName): void {
        if (!this.#availableOperationSet.has(method)) {
            throw new ClientStateError("client.operation_unavailable", `${method} is unavailable on this Host connection`);
        }
    }

    #nextRequestId(): string {
        const id = this.#createRequestId();
        if (typeof id !== "string" || id.length === 0 || id.trim() !== id || this.#usedRequestIds.has(id)) {
            throw new ClientStateError("client.invalid_request_id", "request ID factory returned an invalid or reused ID");
        }
        this.#usedRequestIds.add(id);
        return id;
    }

    #dispatch<TName extends ProtocolOperationName>(
        method: TName,
        params: ProtocolOperationParams<TName>,
    ): Promise<ProtocolOperationResult<TName>> {
        const id = this.#nextRequestId();
        const request = createProtocolRequest(id, method, params);
        return new Promise<ProtocolOperationResult<TName>>((resolve, reject) => {
            const pending: PendingRequest = Object.freeze({
                id,
                method,
                resolve: resolve as (value: unknown) => void,
                reject,
            });
            this.#pending.set(id, pending);
            try {
                this.#transport.send(request as import("@oaam/app-server-protocol").ProtocolRequestV1);
            } catch (cause) {
                this.#pending.delete(id);
                reject(new ClientTransportError("not_sent", method, id, `${method} was not sent`, cause));
            }
        });
    }

    #receive(message: unknown): void {
        if (this.#state === "closed") return;
        try {
            if (isProtocolResponseCandidate(message)) {
                this.#receiveResponse(message);
            } else {
                this.#receiveNotification(message);
            }
        } catch (cause) {
            this.#closeFromProtocol(cause);
        }
    }

    #receiveResponse(message: unknown): void {
        const id = (message as { readonly id: unknown }).id;
        if (typeof id !== "string") throw new Error("response ID is not a string");
        const pending = this.#pending.get(id);
        if (pending === undefined) throw new Error(`response uses unknown or duplicate request ID ${id}`);
        const response = parseProtocolResponse(message, pending.method);
        if ("error" in response) {
            this.#pending.delete(id);
            pending.reject(new ClientProtocolRejectionError(pending.method, id, response.error));
            return;
        }
        if (pending.method === "initialize") {
            const result = response.result as ProtocolOperationResult<"initialize">;
            this.#pending.delete(id);
            this.#availableOperations = Object.freeze([...result.availableOperations]);
            this.#availableOperationSet = new Set(result.availableOperations);
            this.#state = "ready";
            pending.resolve(result);
            return;
        }
        if (isAcceptedLongOperation(pending.method)) {
            const acknowledgement = response.result as ProtocolOperationResult<ProtocolAcceptedLongOperationName>;
            if (this.#operations.has(acknowledgement.operationId)) {
                throw new Error(`duplicate accepted operation ID ${acknowledgement.operationId}`);
            }
            const tracker = this.#createOperationTracker(pending.method, acknowledgement.operationId);
            this.#pending.delete(id);
            this.#operations.set(acknowledgement.operationId, tracker);
            pending.resolve(tracker.handle);
            return;
        }
        this.#pending.delete(id);
        pending.resolve(response.result);
    }

    #receiveNotification(message: unknown): void {
        if (this.#state !== "ready") throw new Error("notification arrived before initialization completed");
        const notification = parseProtocolNotification(message);
        if (notification.method === "resource.invalidated") {
            for (const listener of this.#invalidationListeners) this.#notifyListener(listener, notification.params);
            return;
        }
        const tracker = this.#operations.get(notification.params.operationId);
        if (tracker === undefined) throw new Error(`event uses unknown or not-yet-acknowledged operation ID`);
        if (tracker.operation !== notification.params.operation)
            throw new Error("event operation does not match acknowledgement");
        if (tracker.terminal) throw new Error("event arrived after terminal outcome");
        if (notification.params.sequence <= tracker.lastSequence) throw new Error("event sequence is not monotonic");
        tracker.lastSequence = notification.params.sequence;
        if (notification.method === "operation.progress") {
            for (const listener of tracker.listeners) {
                this.#notifyProgressListener(listener, notification.params.progress, notification.params.sequence);
            }
            return;
        }
        tracker.terminal = true;
        tracker.listeners.clear();
        tracker.resolveTerminal(notification.params.outcome);
    }

    #createOperationTracker<TName extends ProtocolAcceptedLongOperationName>(
        operation: TName,
        operationId: string,
    ): OperationTracker<TName> {
        let resolveTerminal!: (outcome: ProtocolOperationTerminal<TName>) => void;
        let rejectTerminal!: (error: unknown) => void;
        const terminal = new Promise<ProtocolOperationTerminal<TName>>((resolve, reject) => {
            resolveTerminal = resolve;
            rejectTerminal = reject;
        });
        const tracker = {
            operationId,
            operation,
            listeners: new Set<(progress: ProtocolOperationProgress<TName>, sequence: number) => void>(),
            resolveTerminal,
            rejectTerminal,
            lastSequence: 0,
            terminal: false,
        } as OperationTracker<TName>;
        tracker.handle = Object.freeze({
            operationId,
            operation,
            terminal,
            get terminalSequence() {
                return tracker.terminal ? tracker.lastSequence : null;
            },
            subscribeProgress: (listener: (progress: ProtocolOperationProgress<TName>, sequence: number) => void) => {
                if (tracker.terminal || this.#state === "closed") return () => undefined;
                tracker.listeners.add(listener);
                return () => {
                    tracker.listeners.delete(listener);
                };
            },
        });
        return tracker;
    }

    #notifyListener(listener: (invalidation: ProtocolInvalidationV1) => void, value: ProtocolInvalidationV1): void {
        try {
            listener(value);
        } catch (error) {
            this.#reportListenerError(error);
        }
    }

    #notifyProgressListener(
        listener: (progress: ProtocolOperationProgress<ProtocolAcceptedLongOperationName>, sequence: number) => void,
        progress: ProtocolOperationProgress<ProtocolAcceptedLongOperationName>,
        sequence: number,
    ): void {
        try {
            listener(progress, sequence);
        } catch (error) {
            this.#reportListenerError(error);
        }
    }

    #closeFromProtocol(cause: unknown): void {
        this.#transitionClosed(Object.freeze({ kind: "protocol", cause }), true);
    }

    #closeFromTransport(cause: unknown): void {
        this.#transitionClosed(Object.freeze({ kind: "transport", cause }), false);
    }

    #transitionClosed(reason: ClientConnectionCloseReason, closeTransport: boolean): void {
        if (this.#state === "closed") return;
        this.#state = "closed";
        this.#availableOperations = Object.freeze([]);
        this.#availableOperationSet.clear();
        this.#unsubscribeMessage();
        this.#unsubscribeClose();
        const protocolFailure = reason.kind === "protocol";
        for (const pending of this.#pending.values()) {
            const delivery = deliveryAfterSend(pending.method);
            pending.reject(
                protocolFailure
                    ? new ClientProtocolFaultError(delivery, pending.method, pending.id, reason.cause)
                    : new ClientTransportError(
                          delivery,
                          pending.method,
                          pending.id,
                          `${pending.method} was interrupted after send`,
                          reason.cause,
                      ),
            );
        }
        this.#pending.clear();
        for (const tracker of this.#operations.values()) {
            if (!tracker.terminal) {
                tracker.rejectTerminal(
                    protocolFailure
                        ? new ClientProtocolFaultError("uncertain", tracker.operation, null, reason.cause)
                        : new ClientTransportError(
                              "uncertain",
                              tracker.operation,
                              null,
                              `${tracker.operation} lost its terminal channel`,
                              reason.cause,
                          ),
                );
            }
            tracker.listeners.clear();
        }
        this.#invalidationListeners.clear();
        for (const listener of this.#closeListeners) this.#notifyCloseListener(listener, reason);
        this.#closeListeners.clear();
        if (closeTransport) {
            try {
                this.#transport.close();
            } catch (error) {
                this.#reportListenerError(error);
            }
        }
    }

    #notifyCloseListener(listener: (reason: ClientConnectionCloseReason) => void, reason: ClientConnectionCloseReason): void {
        try {
            listener(reason);
        } catch (error) {
            this.#reportListenerError(error);
        }
    }
}

export function createClientConnection(transport: ClientMessageTransport, options: ClientConnectionOptions): ClientConnectionApi {
    return new ClientConnection(transport, options);
}
