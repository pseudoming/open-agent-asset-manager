import {
    PROTOCOL_OPERATION_REGISTRY,
    parseProtocolOperationParams,
    parseProtocolOperationResult,
    parseProtocolTerminalOutcome,
    type ProtocolOperationParams,
    type ProtocolOperationProgress,
    type ProtocolOperationResult,
    type ProtocolOperationTerminal,
} from "./operations";
import {
    protocolAcceptedLongOperationNameSchema,
    protocolOperationNameSchema,
    type ProtocolAcceptedLongOperationName,
    type ProtocolOperationName,
} from "./operation-names";
import { protocolEnvironmentSelectorSchema, protocolUuidV4Schema } from "./primitives";
import {
    protocolEnum,
    protocolJsonValue,
    protocolLiteral,
    protocolNonBlankString,
    protocolObject,
    protocolPositiveInteger,
    protocolUnion,
    ProtocolValidationError,
    type InferProtocolSchema,
    type ProtocolJsonValue,
    type ProtocolSchema,
} from "./validation";

export const PROTOCOL_NOTIFICATION_NAMES = Object.freeze([
    "operation.progress",
    "operation.terminal",
    "resource.invalidated",
] as const);
export type ProtocolNotificationName = (typeof PROTOCOL_NOTIFICATION_NAMES)[number];

export const protocolRejectionSchema = protocolObject(
    {
        code: protocolEnum([
            "protocol.invalid_envelope",
            "protocol.not_initialized",
            "protocol.incompatible_version",
            "protocol.duplicate_id",
            "protocol.unknown_method",
            "protocol.invalid_params",
        ] as const),
        message: protocolNonBlankString,
    },
    "protocol rejection",
);
export type ProtocolRejectionV1 = InferProtocolSchema<typeof protocolRejectionSchema>;

export const protocolInvalidationSchema = protocolUnion(
    [
        protocolObject({ resourceKind: protocolLiteral("adapter_enablement") }, "adapter enablement invalidation"),
        protocolObject({ resourceKind: protocolLiteral("watched_scan_intent") }, "watched scan invalidation"),
        protocolObject(
            { resourceKind: protocolLiteral("environment_probe"), environment: protocolEnvironmentSelectorSchema },
            "environment probe invalidation",
        ),
        protocolObject({ resourceKind: protocolLiteral("project"), projectId: protocolUuidV4Schema }, "project invalidation"),
        protocolObject({ resourceKind: protocolLiteral("asset"), assetId: protocolUuidV4Schema }, "asset invalidation"),
        protocolObject(
            { resourceKind: protocolLiteral("deployment"), deploymentId: protocolUuidV4Schema },
            "deployment invalidation",
        ),
        protocolObject(
            {
                resourceKind: protocolLiteral("collection"),
                collection: protocolEnum(["projects", "assets", "deployments"] as const),
            },
            "collection invalidation",
        ),
        protocolObject(
            {
                resourceKind: protocolLiteral("host_review_record"),
                recordKind: protocolEnum([
                    "probe",
                    "read",
                    "import_preview",
                    "render_preview",
                    "rendered_inspection",
                    "state_backup",
                    "state_restore",
                    "support_bundle",
                    "project_lifecycle",
                ] as const),
                token: protocolNonBlankString,
                reason: protocolEnum(["replaced", "accepted", "cancelled", "expired", "evicted"] as const),
            },
            "host review record invalidation",
        ),
    ],
    "resource invalidation",
);
export type ProtocolInvalidationV1 = InferProtocolSchema<typeof protocolInvalidationSchema>;

const requestOuterSchema = protocolObject(
    {
        id: protocolNonBlankString,
        method: protocolOperationNameSchema,
        params: protocolJsonValue,
    },
    "protocol request",
);

const resultResponseOuterSchema = protocolObject(
    { id: protocolNonBlankString, result: protocolJsonValue },
    "protocol result response",
);
const errorResponseOuterSchema = protocolObject(
    { id: protocolNonBlankString, error: protocolRejectionSchema },
    "protocol error response",
);

const progressNotificationParamsSchema = protocolObject(
    {
        operationId: protocolNonBlankString,
        sequence: protocolPositiveInteger,
        operation: protocolAcceptedLongOperationNameSchema,
        progress: protocolJsonValue,
    },
    "operation progress notification params",
);
const terminalNotificationParamsSchema = protocolObject(
    {
        operationId: protocolNonBlankString,
        sequence: protocolPositiveInteger,
        operation: protocolAcceptedLongOperationNameSchema,
        outcome: protocolJsonValue,
    },
    "operation terminal notification params",
);

const progressNotificationOuterSchema = protocolObject(
    {
        method: protocolLiteral("operation.progress"),
        params: progressNotificationParamsSchema,
    },
    "operation progress notification",
);
const terminalNotificationOuterSchema = protocolObject(
    {
        method: protocolLiteral("operation.terminal"),
        params: terminalNotificationParamsSchema,
    },
    "operation terminal notification",
);
const invalidationNotificationOuterSchema = protocolObject(
    {
        method: protocolLiteral("resource.invalidated"),
        params: protocolInvalidationSchema,
    },
    "resource invalidation notification",
);

export type ProtocolRequestV1<TName extends ProtocolOperationName = ProtocolOperationName> = {
    readonly [TMethod in TName]: {
        readonly id: string;
        readonly method: TMethod;
        readonly params: ProtocolOperationParams<TMethod>;
    };
}[TName];

export type ProtocolResponseV1<TName extends ProtocolOperationName = ProtocolOperationName> =
    | { readonly id: string; readonly result: ProtocolOperationResult<TName> }
    | { readonly id: string; readonly error: ProtocolRejectionV1 };

type ProtocolProgressNotificationV1 = {
    readonly [TName in ProtocolAcceptedLongOperationName]: {
        readonly method: "operation.progress";
        readonly params: {
            readonly operationId: string;
            readonly sequence: number;
            readonly operation: TName;
            readonly progress: ProtocolOperationProgress<TName>;
        };
    };
}[ProtocolAcceptedLongOperationName];

type ProtocolTerminalNotificationV1 = {
    readonly [TName in ProtocolAcceptedLongOperationName]: {
        readonly method: "operation.terminal";
        readonly params: {
            readonly operationId: string;
            readonly sequence: number;
            readonly operation: TName;
            readonly outcome: ProtocolOperationTerminal<TName>;
        };
    };
}[ProtocolAcceptedLongOperationName];

export type ProtocolNotificationV1 =
    | ProtocolProgressNotificationV1
    | ProtocolTerminalNotificationV1
    | { readonly method: "resource.invalidated"; readonly params: ProtocolInvalidationV1 };

export interface ProtocolUnvalidatedResultResponseV1 {
    readonly id: string;
    readonly result: ProtocolJsonValue;
}

export type ProtocolResponseEnvelopeV1 =
    | ProtocolUnvalidatedResultResponseV1
    | { readonly id: string; readonly error: ProtocolRejectionV1 };

export function parseProtocolRequest(value: unknown): ProtocolRequestV1 {
    const outer = requestOuterSchema.parse(value);
    return Object.freeze({
        ...outer,
        params: parseProtocolOperationParams(outer.method, outer.params),
    }) as ProtocolRequestV1;
}

export function parseProtocolResponseEnvelope(value: unknown): ProtocolResponseEnvelopeV1 {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ProtocolValidationError("$", "expected response object");
    }
    if (Object.hasOwn(value, "result") === Object.hasOwn(value, "error")) {
        throw new ProtocolValidationError("$", "response must contain exactly one of result or error");
    }
    return Object.hasOwn(value, "result") ? resultResponseOuterSchema.parse(value) : errorResponseOuterSchema.parse(value);
}

export function parseProtocolResponse<TName extends ProtocolOperationName>(
    value: unknown,
    expectedOperation: TName,
): ProtocolResponseV1<TName> {
    const outer = parseProtocolResponseEnvelope(value);
    if ("error" in outer) return outer;
    return Object.freeze({
        id: outer.id,
        result: parseProtocolOperationResult(expectedOperation, outer.result),
    });
}

export function parseProtocolNotification(value: unknown): ProtocolNotificationV1 {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ProtocolValidationError("$", "expected notification object");
    }
    const method = (value as { method?: unknown }).method;
    if (method === "operation.progress") {
        const parsed = progressNotificationOuterSchema.parse(value);
        const progressSchema = PROTOCOL_OPERATION_REGISTRY[parsed.params.operation].progressSchema as ProtocolSchema<unknown>;
        return Object.freeze({
            method,
            params: Object.freeze({
                ...parsed.params,
                progress: progressSchema.parse(parsed.params.progress, "$.params.progress"),
            }),
        }) as ProtocolNotificationV1;
    }
    if (method === "operation.terminal") {
        const parsed = terminalNotificationOuterSchema.parse(value);
        return Object.freeze({
            method,
            params: Object.freeze({
                ...parsed.params,
                outcome: parseProtocolTerminalOutcome(parsed.params.operation, parsed.params.outcome),
            }),
        }) as ProtocolNotificationV1;
    }
    if (method === "resource.invalidated") return invalidationNotificationOuterSchema.parse(value);
    throw new ProtocolValidationError("$.method", "unknown notification");
}

export function parseProtocolJsonText(text: string): ProtocolJsonValue {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new ProtocolValidationError("$", "invalid JSON text");
    }
    return protocolJsonValue.parse(parsed);
}

export function stringifyProtocolJson(value: unknown): string {
    return JSON.stringify(protocolJsonValue.parse(value));
}

export function isProtocolResponseCandidate(value: unknown): boolean {
    return typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, "id");
}

export function createProtocolRequest<TName extends ProtocolOperationName>(
    id: string,
    method: TName,
    params: ProtocolOperationParams<TName>,
): ProtocolRequestV1<TName> {
    return parseProtocolRequest({ id, method, params }) as ProtocolRequestV1<TName>;
}

export function createProtocolResultResponse<TName extends ProtocolOperationName>(
    id: string,
    method: TName,
    result: ProtocolOperationResult<TName>,
): ProtocolResponseV1<TName> {
    return parseProtocolResponse({ id, result }, method);
}

export function createProtocolErrorResponse(id: string, error: ProtocolRejectionV1): ProtocolResponseV1 {
    return parseProtocolResponseEnvelope({ id, error }) as ProtocolResponseV1;
}

export function createProtocolNotification(value: ProtocolNotificationV1): ProtocolNotificationV1 {
    return parseProtocolNotification(value);
}

export function assertProtocolSchemaRoundTrip<T>(schema: ProtocolSchema<T>, value: unknown): T {
    const parsed = schema.parse(value);
    return schema.parse(parseProtocolJsonText(stringifyProtocolJson(parsed)));
}
