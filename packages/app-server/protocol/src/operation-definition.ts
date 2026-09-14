import type { ProtocolDeliveryClass } from "./operation-names";
import { protocolOperationOutcome } from "./models";
import type { ProtocolSchema } from "./validation";

export interface ProtocolOperationDefinition<
    TDelivery extends ProtocolDeliveryClass = ProtocolDeliveryClass,
    TParams = unknown,
    TResult = unknown,
    TTerminal = unknown,
    TProgress = unknown,
> {
    readonly delivery: TDelivery;
    readonly paramsSchema: ProtocolSchema<TParams>;
    readonly resultSchema: ProtocolSchema<TResult>;
    readonly terminalSchema?: ProtocolSchema<TTerminal>;
    readonly progressSchema?: ProtocolSchema<TProgress>;
}

export function immediate<TDelivery extends "immediate_query" | "immediate_mutation", TParams, TValue>(
    delivery: TDelivery,
    paramsSchema: ProtocolSchema<TParams>,
    valueSchema: ProtocolSchema<TValue>,
) {
    return Object.freeze({ delivery, paramsSchema, resultSchema: protocolOperationOutcome(valueSchema) });
}

export function acceptedLong<TParams, TAcknowledgement, TTerminalValue, TProgress>(
    paramsSchema: ProtocolSchema<TParams>,
    acknowledgementSchema: ProtocolSchema<TAcknowledgement>,
    terminalSchema: ProtocolSchema<TTerminalValue>,
    progressSchema: ProtocolSchema<TProgress>,
) {
    return Object.freeze({
        delivery: "accepted_long" as const,
        paramsSchema,
        resultSchema: acknowledgementSchema,
        terminalSchema,
        progressSchema,
    });
}

export function acceptedLongWithProgress<TParams, TAcknowledgement, TTerminalValue, TProgress>(
    paramsSchema: ProtocolSchema<TParams>,
    acknowledgementSchema: ProtocolSchema<TAcknowledgement>,
    terminalSchema: ProtocolSchema<TTerminalValue>,
    progressSchema: ProtocolSchema<TProgress>,
) {
    return Object.freeze({
        delivery: "accepted_long" as const,
        paramsSchema,
        resultSchema: acknowledgementSchema,
        terminalSchema,
        progressSchema,
    });
}

export function control<TParams, TResult>(paramsSchema: ProtocolSchema<TParams>, resultSchema: ProtocolSchema<TResult>) {
    return Object.freeze({ delivery: "control" as const, paramsSchema, resultSchema });
}
