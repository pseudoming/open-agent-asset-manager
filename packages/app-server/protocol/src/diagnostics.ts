import {
    optionalProtocolField,
    protocolArray,
    protocolBoolean,
    protocolEnum,
    protocolNonBlankString,
    protocolObject,
    type InferProtocolSchema,
} from "./validation";

export const PROTOCOL_DIAGNOSTIC_SEVERITIES = Object.freeze(["info", "warning", "error"] as const);
export const PROTOCOL_DIAGNOSTIC_OPERATIONS = Object.freeze([
    "project",
    "asset",
    "version",
    "probe",
    "read",
    "render",
    "deploy",
    "scan",
    "search",
    "reindex",
    "settings",
    "backup",
    "restore",
    "reverse_accept",
    "internal",
    "host",
    "protocol",
] as const);
export const PROTOCOL_DIAGNOSTIC_CAUSES = Object.freeze([
    "not_found",
    "unavailable",
    "permission_denied",
    "version_incompatible",
    "partial",
    "invalid_schema",
    "unsupported",
    "conflict",
    "verification_failed",
    "internal_error",
] as const);
export const PROTOCOL_SUGGESTED_ACTIONS = Object.freeze([
    "retry",
    "grant_permission",
    "install_runtime",
    "upgrade_runtime",
    "upgrade_adapter",
    "choose_target",
    "rebuild_deployment",
    "skip",
    "contact_support",
] as const);

export const protocolDiagnosticSchema = protocolObject(
    {
        severity: protocolEnum(PROTOCOL_DIAGNOSTIC_SEVERITIES),
        code: protocolNonBlankString,
        operation: protocolEnum(PROTOCOL_DIAGNOSTIC_OPERATIONS),
        causeKind: protocolEnum(PROTOCOL_DIAGNOSTIC_CAUSES),
        retryable: protocolBoolean,
        suggestedActions: protocolArray(protocolEnum(PROTOCOL_SUGGESTED_ACTIONS)),
        message: protocolNonBlankString,
        traceId: optionalProtocolField(protocolNonBlankString),
        path: optionalProtocolField(protocolNonBlankString),
    },
    "protocol diagnostic",
);

export type ProtocolDiagnosticV1 = InferProtocolSchema<typeof protocolDiagnosticSchema>;
