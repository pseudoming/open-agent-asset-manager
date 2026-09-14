import type { ProtocolOperationName, ProtocolRejectionV1 } from "@oaam/app-server-protocol";

export type ClientDeliveryDisposition = "not_sent" | "interrupted" | "uncertain";

export class ClientStateError extends Error {
    public readonly code:
        | "client.already_initialized"
        | "client.closed"
        | "client.invalid_call_class"
        | "client.invalid_request_id"
        | "client.not_ready"
        | "client.operation_unavailable";

    public constructor(code: ClientStateError["code"], message: string) {
        super(message);
        this.name = "ClientStateError";
        this.code = code;
    }
}

export class ClientProtocolRejectionError extends Error {
    public readonly method: ProtocolOperationName;
    public readonly requestId: string;
    public readonly rejection: ProtocolRejectionV1;

    public constructor(method: ProtocolOperationName, requestId: string, rejection: ProtocolRejectionV1) {
        super(`${rejection.code}: ${rejection.message}`);
        this.name = "ClientProtocolRejectionError";
        this.method = method;
        this.requestId = requestId;
        this.rejection = rejection;
    }
}

export class ClientTransportError extends Error {
    public readonly delivery: ClientDeliveryDisposition;
    public readonly method: ProtocolOperationName;
    public readonly requestId: string | null;

    public constructor(
        delivery: ClientDeliveryDisposition,
        method: ProtocolOperationName,
        requestId: string | null,
        message: string,
        cause: unknown,
    ) {
        super(message, { cause });
        this.name = "ClientTransportError";
        this.delivery = delivery;
        this.method = method;
        this.requestId = requestId;
    }
}

export class ClientProtocolFaultError extends Error {
    public readonly delivery: Exclude<ClientDeliveryDisposition, "not_sent">;
    public readonly method: ProtocolOperationName | null;
    public readonly requestId: string | null;

    public constructor(
        delivery: Exclude<ClientDeliveryDisposition, "not_sent">,
        method: ProtocolOperationName | null,
        requestId: string | null,
        cause: unknown,
    ) {
        super("the Host emitted an invalid or uncorrelated Protocol message", { cause });
        this.name = "ClientProtocolFaultError";
        this.delivery = delivery;
        this.method = method;
        this.requestId = requestId;
    }
}
