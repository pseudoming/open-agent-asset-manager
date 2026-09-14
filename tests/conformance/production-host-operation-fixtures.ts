/** Shared polling and outcome checks for real Production Host conformance journeys. */

import type {
    ProtocolAcceptedLongOperationName,
    ProtocolNotificationV1,
    ProtocolOperationTerminal,
    ProtocolResponseEnvelopeV1,
} from "@oaam/app-server-protocol";
import type { HostOutboundMessage } from "@oaam/app-server-host";

export async function waitForHostResponse(
    messages: readonly HostOutboundMessage[],
    id: string,
): Promise<ProtocolResponseEnvelopeV1> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const found = messages.find(
            (message): message is ProtocolResponseEnvelopeV1 => !("method" in message) && message.id === id,
        );
        if (found !== undefined) return found;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`Host response did not arrive: ${id}`);
}

type TerminalNotification = Extract<ProtocolNotificationV1, { readonly method: "operation.terminal" }>;

export async function waitForHostTerminal<TName extends ProtocolAcceptedLongOperationName>(
    messages: readonly HostOutboundMessage[],
    operation: TName,
): Promise<ProtocolOperationTerminal<TName>> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const found = [...messages]
            .reverse()
            .find(
                (message): message is TerminalNotification =>
                    "method" in message && message.method === "operation.terminal" && message.params.operation === operation,
            );
        if (found !== undefined) return found.params.outcome as ProtocolOperationTerminal<TName>;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`Host operation did not terminate: ${operation}`);
}

export function hostOutcomeValue<T = Record<string, unknown>>(
    response: unknown,
    acceptedStatuses: readonly string[] = ["complete"],
): T {
    const result = isRecord(response) && "result" in response ? response.result : response;
    if (
        !isRecord(result) ||
        typeof result.status !== "string" ||
        !acceptedStatuses.includes(result.status) ||
        !("value" in result)
    ) {
        throw new Error(`Host outcome failed: ${JSON.stringify(result)}`);
    }
    return result.value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
