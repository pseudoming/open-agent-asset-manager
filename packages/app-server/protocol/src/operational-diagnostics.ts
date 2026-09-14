import { protocolOperationNameSchema } from "./operation-names";
import { protocolEnvironmentSelectorSchema, protocolSha256Schema } from "./primitives";
import {
    type InferProtocolSchema,
    optionalProtocolField,
    type ProtocolSchema,
    ProtocolValidationError,
    protocolArray,
    protocolBoolean,
    protocolEnum,
    protocolLiteral,
    protocolNonBlankString,
    protocolNonNegativeInteger,
    protocolObject,
    protocolPositiveInteger,
    protocolUnion,
} from "./validation";

export const MINIMUM_ORDINARY_LOG_RETENTION_DAYS = 1;
export const MAXIMUM_ORDINARY_LOG_RETENTION_DAYS = 14;
export const MINIMUM_ORDINARY_LOG_MAXIMUM_BYTES = 64 * 1024;
export const MAXIMUM_ORDINARY_LOG_MAXIMUM_BYTES = 50 * 1024 * 1024;

function boundedPositiveInteger(description: string, minimum: number, maximum: number): ProtocolSchema<number> {
    return Object.freeze({
        description,
        parse(value: unknown, path: string): number {
            const parsed = protocolPositiveInteger.parse(value, path);
            if (parsed < minimum || parsed > maximum) {
                throw new ProtocolValidationError(path, `expected ${description}`);
            }
            return parsed;
        },
    });
}

const protocolOrdinaryLogRetentionDaysSchema = boundedPositiveInteger(
    `ordinary-log retention days between ${MINIMUM_ORDINARY_LOG_RETENTION_DAYS} and ${MAXIMUM_ORDINARY_LOG_RETENTION_DAYS}`,
    MINIMUM_ORDINARY_LOG_RETENTION_DAYS,
    MAXIMUM_ORDINARY_LOG_RETENTION_DAYS,
);

const protocolOrdinaryLogMaximumBytesSchema = boundedPositiveInteger(
    `ordinary-log maximum bytes between ${MINIMUM_ORDINARY_LOG_MAXIMUM_BYTES} and ${MAXIMUM_ORDINARY_LOG_MAXIMUM_BYTES}`,
    MINIMUM_ORDINARY_LOG_MAXIMUM_BYTES,
    MAXIMUM_ORDINARY_LOG_MAXIMUM_BYTES,
);

export const protocolOrdinaryLogSettingsSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        enabled: protocolBoolean,
        retentionDays: protocolOrdinaryLogRetentionDaysSchema,
        maximumBytes: protocolOrdinaryLogMaximumBytesSchema,
    },
    "ordinary operational-log settings",
);

export const protocolOrdinaryLogSettingsReplaceParamsSchema = protocolObject(
    {
        enabled: protocolBoolean,
        retentionDays: protocolOrdinaryLogRetentionDaysSchema,
        maximumBytes: protocolOrdinaryLogMaximumBytesSchema,
    },
    "ordinary operational-log settings replacement",
);

export const protocolOrdinaryLogClearParamsSchema = protocolObject(
    {
        confirmedPermanentRemoval: protocolLiteral(true),
    },
    "ordinary operational-log clear confirmation",
);

export const protocolOrdinaryLogClearResultSchema = protocolObject(
    {
        removedSegmentCount: protocolNonNegativeInteger,
        removedBytes: protocolNonNegativeInteger,
        settings: protocolOrdinaryLogSettingsSchema,
    },
    "ordinary operational-log clear result",
);

export type ProtocolOrdinaryLogSettingsV1 = InferProtocolSchema<typeof protocolOrdinaryLogSettingsSchema>;
export type ProtocolOrdinaryLogSettingsReplaceParamsV1 = InferProtocolSchema<
    typeof protocolOrdinaryLogSettingsReplaceParamsSchema
>;
export type ProtocolOrdinaryLogClearResultV1 = InferProtocolSchema<typeof protocolOrdinaryLogClearResultSchema>;

export const SUPPORT_BUNDLE_MODES = Object.freeze(["standard", "extended"] as const);
export const SUPPORT_BUNDLE_ENTRY_CATEGORIES = Object.freeze([
    "documentation",
    "manifest",
    "product",
    "health",
    "adapter_capabilities",
    "ordinary_log",
    "local_paths",
] as const);

export const protocolSupportBundleInspectParamsSchema = protocolObject(
    { mode: protocolEnum(SUPPORT_BUNDLE_MODES) },
    "support-bundle inspection params",
);

const protocolSupportBundleEntrySchema = protocolObject(
    {
        archivePath: protocolNonBlankString,
        category: protocolEnum(SUPPORT_BUNDLE_ENTRY_CATEGORIES),
        byteLength: protocolNonNegativeInteger,
    },
    "support-bundle entry",
);

const STANDARD_SUPPORT_BUNDLE_ENTRY_LAYOUT = Object.freeze([
    ["README.txt", "documentation"],
    ["diagnostics/adapters.json", "adapter_capabilities"],
    ["diagnostics/health.json", "health"],
    ["diagnostics/ordinary-log.jsonl", "ordinary_log"],
    ["diagnostics/product.json", "product"],
    ["manifest.json", "manifest"],
] as const);
const EXTENDED_SUPPORT_BUNDLE_ENTRY_LAYOUT = Object.freeze([
    ["README.txt", "documentation"],
    ["diagnostics/adapters.json", "adapter_capabilities"],
    ["diagnostics/health.json", "health"],
    ["diagnostics/locations.json", "local_paths"],
    ["diagnostics/ordinary-log.jsonl", "ordinary_log"],
    ["diagnostics/product.json", "product"],
    ["manifest.json", "manifest"],
] as const);

const protocolSupportBundleLogSnapshotSchema = protocolObject(
    {
        retainedSegmentCount: protocolNonNegativeInteger,
        includedSegmentCount: protocolNonNegativeInteger,
        retainedBytes: protocolNonNegativeInteger,
        includedBytes: protocolNonNegativeInteger,
        truncated: protocolBoolean,
    },
    "support-bundle ordinary-log snapshot",
);

const protocolSupportBundleReviewShapeSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        supportBundleReviewToken: protocolNonBlankString,
        mode: protocolEnum(SUPPORT_BUNDLE_MODES),
        createdAt: protocolNonNegativeInteger,
        archiveByteLength: protocolPositiveInteger,
        archiveContentHash: protocolSha256Schema,
        entries: protocolArray(protocolSupportBundleEntrySchema),
        ordinaryLog: protocolSupportBundleLogSnapshotSchema,
    },
    "support-bundle review",
);

export const protocolSupportBundleReviewSchema: ProtocolSchema<
    InferProtocolSchema<typeof protocolSupportBundleReviewShapeSchema>
> = Object.freeze({
    description: "exact support-bundle review",
    parse(value: unknown, path = "$") {
        const parsed = protocolSupportBundleReviewShapeSchema.parse(value, path);
        const expectedLayout =
            parsed.mode === "standard" ? STANDARD_SUPPORT_BUNDLE_ENTRY_LAYOUT : EXTENDED_SUPPORT_BUNDLE_ENTRY_LAYOUT;
        if (
            parsed.entries.length !== expectedLayout.length ||
            parsed.entries.some(
                (entry, index) =>
                    entry.archivePath !== expectedLayout[index]?.[0] || entry.category !== expectedLayout[index]?.[1],
            )
        ) {
            throw new ProtocolValidationError(`${path}.entries`, `expected exact ${parsed.mode} support-bundle inventory`);
        }
        const log = parsed.ordinaryLog;
        if (
            log.includedSegmentCount > log.retainedSegmentCount ||
            log.includedBytes > log.retainedBytes ||
            log.truncated !== log.includedBytes < log.retainedBytes
        ) {
            throw new ProtocolValidationError(`${path}.ordinaryLog`, "expected a consistent support-log snapshot");
        }
        return parsed;
    },
});

export const protocolSupportBundleExportParamsSchema = protocolObject(
    {
        supportBundleReviewToken: protocolNonBlankString,
        localPathSelectionToken: protocolNonBlankString,
        userActionId: protocolNonBlankString,
    },
    "support-bundle export params",
);

const protocolSupportBundleArtifactShapeSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        mode: protocolEnum(SUPPORT_BUNDLE_MODES),
        createdAt: protocolNonNegativeInteger,
        archiveByteLength: protocolPositiveInteger,
        archiveContentHash: protocolSha256Schema,
        entryCount: protocolPositiveInteger,
    },
    "support-bundle artifact",
);

export const protocolSupportBundleArtifactSchema: ProtocolSchema<
    InferProtocolSchema<typeof protocolSupportBundleArtifactShapeSchema>
> = Object.freeze({
    description: "exact support-bundle artifact",
    parse(value: unknown, path = "$") {
        const parsed = protocolSupportBundleArtifactShapeSchema.parse(value, path);
        const expectedEntryCount = parsed.mode === "standard" ? 6 : 7;
        if (parsed.entryCount !== expectedEntryCount) {
            throw new ProtocolValidationError(`${path}.entryCount`, `expected ${expectedEntryCount} entries`);
        }
        return parsed;
    },
});

export type ProtocolSupportBundleMode = (typeof SUPPORT_BUNDLE_MODES)[number];
export type ProtocolSupportBundleReviewV1 = InferProtocolSchema<typeof protocolSupportBundleReviewSchema>;
export type ProtocolSupportBundleArtifactV1 = InferProtocolSchema<typeof protocolSupportBundleArtifactSchema>;

export const HOST_OPERATIONAL_DIAGNOSTIC_CODES = Object.freeze([
    "host.lifecycle.ready",
    "host.lifecycle.recovery_ready",
    "host.lifecycle.draining",
    "host.lifecycle.stopped",
    "host.connection.opened",
    "host.connection.closed",
    "host.transport.failed",
] as const);

export const PROTOCOL_OPERATIONAL_DIAGNOSTIC_CODES = Object.freeze([
    "protocol.request.accepted",
    "protocol.adapter_probe.owner_timing",
    "protocol.adapter_probe.summary_timing",
    "protocol.request.terminal",
    "protocol.invalid_envelope",
    "protocol.not_initialized",
    "protocol.incompatible_version",
    "protocol.duplicate_id",
    "protocol.unknown_method",
    "protocol.invalid_params",
] as const);
const PROTOCOL_REJECTION_OPERATIONAL_DIAGNOSTIC_CODES = Object.freeze([
    "protocol.invalid_envelope",
    "protocol.not_initialized",
    "protocol.incompatible_version",
    "protocol.duplicate_id",
    "protocol.unknown_method",
    "protocol.invalid_params",
] as const);

const DESKTOP_SIMPLE_OPERATIONAL_DIAGNOSTIC_CODES = Object.freeze([
    "desktop.host.starting",
    "desktop.host.ready",
    "desktop.host.draining",
    "desktop.host.stopped",
    "desktop.host.failed",
    "host.boot_delivery_failed",
    "host.connection_failed",
    "host.connection_unavailable",
    "host.control_failed",
    "host.control_state_invalid",
    "host.desktop_preferences_reply_failed",
    "host.drain_delivery_failed",
    "host.duplicate_boot",
    "host.invalid_control_message",
    "host.invalid_control_event",
    "host.preference_read_result_invalid",
    "host.preference_read_result_unexpected",
    "host.preference_restore_result_invalid",
    "host.preference_restore_result_unexpected",
    "host.process_failed",
    "host.process_spawn_failed",
    "host.process_termination_failed",
    "host.restore_replacement_failed",
    "host.restore_restarting",
    "host.shutdown_delivery_failed",
    "host.shutdown_failed",
    "host.startup_failed",
    "host.startup_liveness_timeout",
    "host.startup_recovering",
    "host.startup_timeout",
    "host.unexpected_backup_file_mutation",
    "host.unexpected_backup_file_resolution",
    "host.unexpected_exit",
    "host.unexpected_path_registration_result",
    "host.unexpected_ready",
    "host.unexpected_restore_replacement",
    "host.unexpected_stopped",
] as const);

export const DESKTOP_OPERATIONAL_DIAGNOSTIC_CODES = Object.freeze([
    ...DESKTOP_SIMPLE_OPERATIONAL_DIAGNOSTIC_CODES,
    "desktop.renderer.event",
] as const);

export const DESKTOP_RENDERER_EVENT_KINDS = Object.freeze([
    "failure",
    "recovery_started",
    "recovery_dispatched",
    "recovery_failed",
    "process_gone",
] as const);
export const DESKTOP_RENDERER_FAILURE_KINDS = Object.freeze([
    "render",
    "window_error",
    "unhandled_rejection",
    "process_gone",
] as const);
export const DESKTOP_RENDERER_SURFACES = Object.freeze([
    "startup",
    "onboarding",
    "guided_import",
    "library",
    "sources",
    "deployment",
    "settings",
    "recovery_settings",
    "unknown",
] as const);

export type HostOperationalDiagnosticCode = (typeof HOST_OPERATIONAL_DIAGNOSTIC_CODES)[number];
export type ProtocolOperationalDiagnosticCode = (typeof PROTOCOL_OPERATIONAL_DIAGNOSTIC_CODES)[number];
export type DesktopSimpleOperationalDiagnosticCode = (typeof DESKTOP_SIMPLE_OPERATIONAL_DIAGNOSTIC_CODES)[number];
export type DesktopOperationalDiagnosticCode = (typeof DESKTOP_OPERATIONAL_DIAGNOSTIC_CODES)[number];
export type DesktopRendererEventKind = (typeof DESKTOP_RENDERER_EVENT_KINDS)[number];
export type DesktopRendererFailureKind = (typeof DESKTOP_RENDERER_FAILURE_KINDS)[number];
export type DesktopRendererSurface = (typeof DESKTOP_RENDERER_SURFACES)[number];

const desktopCodeSet = new Set<string>(DESKTOP_OPERATIONAL_DIAGNOSTIC_CODES);
const desktopSimpleCodeSet = new Set<string>(DESKTOP_SIMPLE_OPERATIONAL_DIAGNOSTIC_CODES);

export function isDesktopOperationalDiagnosticCode(value: unknown): value is DesktopOperationalDiagnosticCode {
    return typeof value === "string" && desktopCodeSet.has(value);
}

export function isDesktopSimpleOperationalDiagnosticCode(value: unknown): value is DesktopSimpleOperationalDiagnosticCode {
    return typeof value === "string" && desktopSimpleCodeSet.has(value);
}

const hostOperationalDiagnosticRecordSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        occurredAt: protocolNonNegativeInteger,
        source: protocolLiteral("host"),
        code: protocolEnum(HOST_OPERATIONAL_DIAGNOSTIC_CODES),
    },
    "Host operational diagnostic record",
);
const protocolAcceptedOperationalDiagnosticRecordSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        occurredAt: protocolNonNegativeInteger,
        source: protocolLiteral("protocol"),
        code: protocolLiteral("protocol.request.accepted"),
        operation: protocolOperationNameSchema,
    },
    "accepted Protocol operational diagnostic record",
);
const protocolAdapterIdSchema: ProtocolSchema<string> = Object.freeze({
    description: "bounded machine adapter identifier",
    parse(value: unknown, path: string) {
        if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) {
            throw new ProtocolValidationError(path, "expected a bounded machine adapter identifier");
        }
        return value;
    },
});
const protocolAdapterProbeOwnerTimingRecordSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        occurredAt: protocolNonNegativeInteger,
        source: protocolLiteral("protocol"),
        code: protocolLiteral("protocol.adapter_probe.owner_timing"),
        operationId: protocolNonBlankString,
        stage: protocolLiteral("provider_probe"),
        adapterId: protocolAdapterIdSchema,
        environment: protocolEnvironmentSelectorSchema,
        status: protocolEnum(["complete", "partial", "failed"] as const),
        startedOffsetMilliseconds: protocolNonNegativeInteger,
        endedOffsetMilliseconds: protocolNonNegativeInteger,
        elapsedMilliseconds: protocolNonNegativeInteger,
    },
    "adapter-probe owner timing record",
);
const protocolAdapterProbeSummaryTimingShapeSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        occurredAt: protocolNonNegativeInteger,
        source: protocolLiteral("protocol"),
        code: protocolLiteral("protocol.adapter_probe.summary_timing"),
        operationId: protocolNonBlankString,
        stage: protocolLiteral("provider_probe"),
        status: protocolEnum(["complete", "partial", "failed"] as const),
        ownerCount: protocolNonNegativeInteger,
        elapsedMilliseconds: protocolNonNegativeInteger,
        maximumOwnerElapsedMilliseconds: protocolNonNegativeInteger,
        overheadMilliseconds: protocolNonNegativeInteger,
    },
    "adapter-probe summary timing record",
);
export const protocolAdapterProbeSummaryTimingRecordSchema: ProtocolSchema<
    InferProtocolSchema<typeof protocolAdapterProbeSummaryTimingShapeSchema>
> = Object.freeze({
    description: "consistent adapter-probe summary timing record",
    parse(value: unknown, path = "$") {
        const parsed = protocolAdapterProbeSummaryTimingShapeSchema.parse(value, path);
        if (
            parsed.maximumOwnerElapsedMilliseconds > parsed.elapsedMilliseconds ||
            parsed.overheadMilliseconds !== parsed.elapsedMilliseconds - parsed.maximumOwnerElapsedMilliseconds
        ) {
            throw new ProtocolValidationError(path, "expected exact adapter-probe wall/max/overhead arithmetic");
        }
        return parsed;
    },
});
export const protocolAdapterProbeOwnerTimingRecord: ProtocolSchema<
    InferProtocolSchema<typeof protocolAdapterProbeOwnerTimingRecordSchema>
> = Object.freeze({
    description: "consistent adapter-probe owner timing record",
    parse(value: unknown, path = "$") {
        const parsed = protocolAdapterProbeOwnerTimingRecordSchema.parse(value, path);
        if (
            parsed.endedOffsetMilliseconds < parsed.startedOffsetMilliseconds ||
            parsed.elapsedMilliseconds !== parsed.endedOffsetMilliseconds - parsed.startedOffsetMilliseconds
        ) {
            throw new ProtocolValidationError(path, "expected exact adapter-probe start/end/elapsed arithmetic");
        }
        return parsed;
    },
});
const protocolOperationalTerminalDiagnosticCodesSchema: ProtocolSchema<readonly string[]> = Object.freeze({
    description: "bounded canonical Protocol terminal diagnostic codes",
    parse(value: unknown, path: string) {
        const parsed = protocolArray(protocolNonBlankString).parse(value, path);
        if (parsed.length > 16) {
            throw new ProtocolValidationError(path, "expected no more than 16 terminal diagnostic codes");
        }
        const canonical = [...new Set(parsed)].sort();
        if (canonical.length !== parsed.length || canonical.some((code, index) => code !== parsed[index])) {
            throw new ProtocolValidationError(path, "expected unique sorted terminal diagnostic codes");
        }
        return Object.freeze(canonical);
    },
});
const protocolTerminalOperationalDiagnosticRecordSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        occurredAt: protocolNonNegativeInteger,
        source: protocolLiteral("protocol"),
        code: protocolLiteral("protocol.request.terminal"),
        operation: protocolOperationNameSchema,
        status: protocolEnum(["complete", "partial", "failed"] as const),
        diagnosticCodes: protocolOperationalTerminalDiagnosticCodesSchema,
        operationId: optionalProtocolField(protocolNonBlankString),
    },
    "terminal Protocol operational diagnostic record",
);
const protocolRejectedOperationalDiagnosticRecordSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        occurredAt: protocolNonNegativeInteger,
        source: protocolLiteral("protocol"),
        code: protocolEnum(PROTOCOL_REJECTION_OPERATIONAL_DIAGNOSTIC_CODES),
    },
    "rejected Protocol operational diagnostic record",
);
const desktopSimpleOperationalDiagnosticRecordSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        occurredAt: protocolNonNegativeInteger,
        source: protocolLiteral("desktop"),
        code: protocolEnum(DESKTOP_SIMPLE_OPERATIONAL_DIAGNOSTIC_CODES),
    },
    "Desktop operational diagnostic record",
);

const protocolRendererComponentIdentifierSchema: ProtocolSchema<string> = Object.freeze({
    description: "safe Renderer component identifier",
    parse(value: unknown, path: string) {
        if (
            typeof value !== "string" ||
            value.length === 0 ||
            value.length > 80 ||
            !/^[A-Za-z_$][A-Za-z0-9_$.-]*$/u.test(value)
        ) {
            throw new ProtocolValidationError(path, "expected a bounded code-only component identifier");
        }
        return value;
    },
});

const protocolRendererComponentTrailSchema: ProtocolSchema<readonly string[]> = Object.freeze({
    description: "bounded Renderer component trail",
    parse(value: unknown, path: string) {
        const parsed = protocolArray(protocolRendererComponentIdentifierSchema).parse(value, path);
        if (parsed.length > 8) throw new ProtocolValidationError(path, "expected no more than 8 component identifiers");
        if (new Set(parsed).size !== parsed.length) {
            throw new ProtocolValidationError(path, "expected unique component identifiers");
        }
        return parsed;
    },
});

export const protocolDesktopRendererDiagnosticInputSchema = protocolObject(
    {
        event: protocolEnum(DESKTOP_RENDERER_EVENT_KINDS),
        failureKind: protocolEnum(DESKTOP_RENDERER_FAILURE_KINDS),
        surface: protocolEnum(DESKTOP_RENDERER_SURFACES),
        componentTrail: protocolRendererComponentTrailSchema,
    },
    "privacy-bounded Desktop Renderer diagnostic input",
);

const desktopRendererOperationalDiagnosticRecordSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        occurredAt: protocolNonNegativeInteger,
        source: protocolLiteral("desktop"),
        code: protocolLiteral("desktop.renderer.event"),
        event: protocolEnum(DESKTOP_RENDERER_EVENT_KINDS),
        failureKind: protocolEnum(DESKTOP_RENDERER_FAILURE_KINDS),
        surface: protocolEnum(DESKTOP_RENDERER_SURFACES),
        componentTrail: protocolRendererComponentTrailSchema,
    },
    "privacy-bounded Desktop Renderer operational diagnostic record",
);

export type ProtocolDesktopRendererDiagnosticInputV1 = InferProtocolSchema<typeof protocolDesktopRendererDiagnosticInputSchema>;

export const protocolOperationalDiagnosticRecordSchema = protocolUnion(
    [
        hostOperationalDiagnosticRecordSchema,
        protocolAcceptedOperationalDiagnosticRecordSchema,
        protocolAdapterProbeOwnerTimingRecord,
        protocolAdapterProbeSummaryTimingRecordSchema,
        protocolTerminalOperationalDiagnosticRecordSchema,
        protocolRejectedOperationalDiagnosticRecordSchema,
        desktopSimpleOperationalDiagnosticRecordSchema,
        desktopRendererOperationalDiagnosticRecordSchema,
    ],
    "operational diagnostic record",
);

export type ProtocolOperationalDiagnosticRecordV1 = InferProtocolSchema<typeof protocolOperationalDiagnosticRecordSchema>;

const protocolOrdinaryLogHealthSchema = protocolUnion(
    [
        protocolObject(
            {
                state: protocolLiteral("active"),
                suspensionReason: protocolLiteral("none"),
                retainedBytes: protocolNonNegativeInteger,
                maximumBytes: protocolPositiveInteger,
                segmentCount: protocolNonNegativeInteger,
            },
            "active ordinary operational-log health",
        ),
        protocolObject(
            {
                state: protocolLiteral("disabled"),
                suspensionReason: protocolLiteral("user_disabled"),
                retainedBytes: protocolNonNegativeInteger,
                maximumBytes: protocolPositiveInteger,
                segmentCount: protocolNonNegativeInteger,
            },
            "disabled ordinary operational-log health",
        ),
        protocolObject(
            {
                state: protocolLiteral("suspended"),
                suspensionReason: protocolEnum(["unsafe_storage", "write_failed", "cleanup_failed"] as const),
                retainedBytes: protocolNonNegativeInteger,
                maximumBytes: protocolPositiveInteger,
                segmentCount: protocolNonNegativeInteger,
            },
            "suspended ordinary operational-log health",
        ),
    ],
    "ordinary operational-log health",
);

export const protocolDiagnosticsHealthSchema = protocolObject(
    {
        schemaVersion: protocolLiteral(1),
        overallStatus: protocolEnum(["healthy", "degraded", "unhealthy"] as const),
        host: protocolObject(
            {
                lifecycleState: protocolEnum(["starting", "ready", "draining", "stopped", "failed"] as const),
                startupMode: protocolEnum(["normal", "state_recovery"] as const),
            },
            "diagnostics Host health",
        ),
        ordinaryLog: protocolOrdinaryLogHealthSchema,
    },
    "diagnostics health",
);

export type ProtocolDiagnosticsHealthV1 = InferProtocolSchema<typeof protocolDiagnosticsHealthSchema>;
