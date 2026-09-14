import type { ProtocolDiagnosticsHealthV1 } from "@oaam/app-server-protocol";
import type { DesktopMessageId } from "../../presentation";

export const HOST_LIFECYCLE_MESSAGES = {
    starting: "diagnostics.health.lifecycle.starting",
    ready: "diagnostics.health.lifecycle.ready",
    draining: "diagnostics.health.lifecycle.draining",
    stopped: "diagnostics.health.lifecycle.stopped",
    failed: "diagnostics.health.lifecycle.failed",
} as const satisfies Readonly<Record<ProtocolDiagnosticsHealthV1["host"]["lifecycleState"], DesktopMessageId>>;

export const HOST_STARTUP_MODE_MESSAGES = {
    normal: "diagnostics.health.startup_mode.normal",
    state_recovery: "diagnostics.health.startup_mode.state_recovery",
} as const satisfies Readonly<Record<ProtocolDiagnosticsHealthV1["host"]["startupMode"], DesktopMessageId>>;

type SuspendedOrdinaryLog = Extract<ProtocolDiagnosticsHealthV1["ordinaryLog"], { readonly state: "suspended" }>;

export const ORDINARY_LOG_SUSPENSION_MESSAGES = {
    unsafe_storage: "diagnostics.health.log_reason.unsafe_storage",
    write_failed: "diagnostics.health.log_reason.write_failed",
    cleanup_failed: "diagnostics.health.log_reason.cleanup_failed",
} as const satisfies Readonly<Record<SuspendedOrdinaryLog["suspensionReason"], DesktopMessageId>>;

export function ordinaryLogStateMessage(log: ProtocolDiagnosticsHealthV1["ordinaryLog"]): {
    readonly state: DesktopMessageId;
    readonly reason: DesktopMessageId | undefined;
} {
    switch (log.state) {
        case "active":
            return { state: "diagnostics.health.log_state.active", reason: undefined };
        case "disabled":
            return { state: "diagnostics.health.log_state.disabled", reason: undefined };
        case "suspended":
            return {
                state: "diagnostics.health.log_state.suspended",
                reason: ORDINARY_LOG_SUSPENSION_MESSAGES[log.suspensionReason],
            };
    }
}
