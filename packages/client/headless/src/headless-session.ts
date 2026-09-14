import {
    PROTOCOL_ACCEPTED_LONG_NAMES,
    createProtocolErrorResponse,
    createProtocolNotification,
    parseProtocolJsonText,
    parseProtocolRequest,
    parseProtocolResponse,
    type ProtocolAcceptedLongOperationName,
    type ProtocolNotificationV1,
    type ProtocolOperationName,
    type ProtocolOperationParams,
    type ProtocolOperationTerminal,
    type ProtocolRequestV1,
    type ProtocolRejectionV1,
} from "@oaam/app-server-protocol";
import {
    ClientProtocolFaultError,
    ClientProtocolRejectionError,
    ClientStateError,
    ClientTransportError,
    type ClientAcceptedOperation,
    type ClientConnectionApi,
    type ClientRequestOperationName,
} from "@oaam/client-framework";
import type { SerializedProtocolWriter } from "./ndjson";

export type HeadlessExitCode = 0 | 1 | 2 | 3;

export class HeadlessInputError extends Error {
    public constructor() {
        super("Headless input is invalid");
        this.name = "HeadlessInputError";
    }
}

export class HeadlessChannelError extends Error {
    public constructor() {
        super("Headless Host channel is unavailable");
        this.name = "HeadlessChannelError";
    }
}

const ACCEPTED_LONG_NAMES = new Set<ProtocolOperationName>(PROTOCOL_ACCEPTED_LONG_NAMES);

type AcceptedRequest = Extract<ProtocolRequestV1, { readonly method: ProtocolAcceptedLongOperationName }>;
type RequestClassRequest = Exclude<ProtocolRequestV1, AcceptedRequest | { readonly method: "initialize" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outcomeExitCode(value: unknown): HeadlessExitCode {
    return isRecord(value) && (value.status === "partial" || value.status === "failed") ? 1 : 0;
}

function clientStateRejection(error: ClientStateError): ProtocolRejectionV1 | null {
    switch (error.code) {
        case "client.not_ready":
            return { code: "protocol.not_initialized", message: "The Headless Client has not initialized." };
        case "client.already_initialized":
        case "client.invalid_call_class":
            return { code: "protocol.invalid_params", message: "The operation is invalid in the current Client state." };
        case "client.operation_unavailable":
            return { code: "protocol.unknown_method", message: "The operation is unavailable on this Host." };
        case "client.closed":
        case "client.invalid_request_id":
            return null;
    }
}

function startParsedRequest(client: ClientConnectionApi, request: AcceptedRequest) {
    return client.start<ProtocolAcceptedLongOperationName>(
        request.method,
        request.params as ProtocolOperationParams<ProtocolAcceptedLongOperationName>,
    );
}

function dispatchParsedRequest(client: ClientConnectionApi, request: RequestClassRequest) {
    return client.request<ClientRequestOperationName>(
        request.method as ClientRequestOperationName,
        request.params as ProtocolOperationParams<ClientRequestOperationName>,
    );
}

export class HeadlessProtocolSession {
    readonly #client: ClientConnectionApi;
    readonly #writer: SerializedProtocolWriter;
    readonly #externalRequestIds = new Set<string>();
    readonly #pendingTerminals = new Set<Promise<void>>();
    readonly #unsubscribeInvalidation: () => void;
    readonly #unsubscribeClose: () => void;
    #exitCode: HeadlessExitCode = 0;
    #closing = false;

    public constructor(client: ClientConnectionApi, writer: SerializedProtocolWriter) {
        this.#client = client;
        this.#writer = writer;
        this.#unsubscribeInvalidation = client.subscribeInvalidation((invalidation) => {
            this.#writer.enqueue(
                createProtocolNotification({
                    method: "resource.invalidated",
                    params: invalidation,
                }),
            );
        });
        this.#unsubscribeClose = client.subscribeClose(() => {
            if (!this.#closing) this.#recordExit(3);
        });
    }

    public get exitCode(): HeadlessExitCode {
        return this.#exitCode;
    }

    public async acceptLine(text: string): Promise<void> {
        let request: ProtocolRequestV1;
        try {
            request = parseProtocolRequest(parseProtocolJsonText(text));
        } catch {
            this.#recordExit(2);
            throw new HeadlessInputError();
        }
        if (this.#externalRequestIds.has(request.id)) {
            this.#writer.enqueue(
                createProtocolErrorResponse(request.id, {
                    code: "protocol.duplicate_id",
                    message: "Request id was already used by this Headless session.",
                }),
            );
            this.#recordExit(2);
            throw new HeadlessInputError();
        }
        this.#externalRequestIds.add(request.id);
        await this.#dispatch(request);
    }

    public async finish(): Promise<HeadlessExitCode> {
        await Promise.all([...this.#pendingTerminals]);
        await this.#writer.finish();
        return this.#exitCode;
    }

    public close(): void {
        if (this.#closing) return;
        this.#closing = true;
        this.#unsubscribeInvalidation();
        this.#unsubscribeClose();
        this.#client.close();
    }

    #recordExit(candidate: HeadlessExitCode): void {
        if (candidate > this.#exitCode) this.#exitCode = candidate;
    }

    async #dispatch(request: ProtocolRequestV1): Promise<void> {
        try {
            if (request.method === "initialize") {
                const result = await this.#client.initialize(request.params);
                this.#writer.enqueue(parseProtocolResponse({ id: request.id, result }, request.method));
                return;
            }
            if (ACCEPTED_LONG_NAMES.has(request.method)) {
                const accepted = await startParsedRequest(this.#client, request as AcceptedRequest);
                this.#writer.enqueue(
                    parseProtocolResponse({ id: request.id, result: { operationId: accepted.operationId } }, request.method),
                );
                this.#trackTerminal(accepted);
                return;
            }
            const result = await dispatchParsedRequest(this.#client, request as RequestClassRequest);
            this.#recordExit(outcomeExitCode(result));
            this.#writer.enqueue(parseProtocolResponse({ id: request.id, result }, request.method));
        } catch (error) {
            if (error instanceof ClientProtocolRejectionError) {
                this.#recordExit(2);
                this.#writer.enqueue(createProtocolErrorResponse(request.id, error.rejection));
                return;
            }
            if (error instanceof ClientStateError) {
                const rejected = clientStateRejection(error);
                if (rejected !== null) {
                    this.#recordExit(2);
                    this.#writer.enqueue(createProtocolErrorResponse(request.id, rejected));
                    return;
                }
            }
            this.#recordExit(3);
            if (
                error instanceof ClientTransportError ||
                error instanceof ClientProtocolFaultError ||
                error instanceof ClientStateError
            ) {
                throw new HeadlessChannelError();
            }
            throw error;
        }
    }

    #trackTerminal(accepted: ClientAcceptedOperation<ProtocolAcceptedLongOperationName>): void {
        accepted.subscribeProgress((progress, sequence) => {
            this.#writer.enqueue(
                createProtocolNotification({
                    method: "operation.progress",
                    params: {
                        operationId: accepted.operationId,
                        sequence,
                        operation: accepted.operation,
                        progress,
                    },
                } as ProtocolNotificationV1),
            );
        });
        const pending = accepted.terminal
            .then((outcome: ProtocolOperationTerminal<ProtocolAcceptedLongOperationName>) => {
                this.#recordExit(outcomeExitCode(outcome));
                const terminalSequence = accepted.terminalSequence;
                if (terminalSequence === null) throw new HeadlessChannelError();
                this.#writer.enqueue(
                    createProtocolNotification({
                        method: "operation.terminal",
                        params: {
                            operationId: accepted.operationId,
                            sequence: terminalSequence,
                            operation: accepted.operation,
                            outcome,
                        },
                    } as ProtocolNotificationV1),
                );
            })
            .catch(() => {
                this.#recordExit(3);
            })
            .finally(() => {
                this.#pendingTerminals.delete(pending);
            });
        this.#pendingTerminals.add(pending);
    }
}
