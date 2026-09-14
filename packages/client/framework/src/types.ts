import type {
    ProtocolAcceptedLongOperationName,
    ProtocolInvalidationV1,
    ProtocolOperationName,
    ProtocolOperationParams,
    ProtocolOperationProgress,
    ProtocolOperationResult,
    ProtocolOperationTerminal,
} from "@oaam/app-server-protocol";

export type ClientConnectionState = "created" | "initializing" | "ready" | "closed";

export type ClientRequestOperationName = Exclude<ProtocolOperationName, ProtocolAcceptedLongOperationName | "initialize">;

export interface ClientAcceptedOperation<TName extends ProtocolAcceptedLongOperationName> {
    readonly operationId: string;
    readonly operation: TName;
    readonly terminal: Promise<ProtocolOperationTerminal<TName>>;
    readonly terminalSequence: number | null;
    subscribeProgress(listener: (progress: ProtocolOperationProgress<TName>, sequence: number) => void): () => void;
}

export type ClientConnectionCloseReason =
    | { readonly kind: "local"; readonly cause: unknown }
    | { readonly kind: "transport"; readonly cause: unknown }
    | { readonly kind: "protocol"; readonly cause: unknown }
    | { readonly kind: "initialization_failed"; readonly cause: unknown };

export interface ClientConnectionOptions {
    readonly createRequestId: () => string;
    readonly reportListenerError: (error: unknown) => void;
}

export interface ClientConnectionApi {
    readonly state: ClientConnectionState;
    readonly availableOperations: readonly ProtocolOperationName[];
    initialize(params: ProtocolOperationParams<"initialize">): Promise<ProtocolOperationResult<"initialize">>;
    request<TName extends ClientRequestOperationName>(
        method: TName,
        params: ProtocolOperationParams<TName>,
    ): Promise<ProtocolOperationResult<TName>>;
    start<TName extends ProtocolAcceptedLongOperationName>(
        method: TName,
        params: ProtocolOperationParams<TName>,
    ): Promise<ClientAcceptedOperation<TName>>;
    subscribeInvalidation(listener: (invalidation: ProtocolInvalidationV1) => void): () => void;
    subscribeClose(listener: (reason: ClientConnectionCloseReason) => void): () => void;
    close(): void;
}
