export const PACKAGED_DIAGNOSTICS_PROOF_PORT_CHANNEL = "oaam:desktop-packaged-diagnostics-proof-port";
export const PACKAGED_DIAGNOSTICS_PROOF_PORT_SIGNAL = "oaam:desktop-packaged-diagnostics-proof-port-ready";

export interface PackagedDiagnosticsProofRequest {
    readonly supportBundleExportToken: string;
}

export interface PackagedDiagnosticsProofControlRequest {
    readonly control: "request_existing_support_bundle_token";
}

export interface PackagedDiagnosticsProofControlReply {
    readonly control: "existing_support_bundle_token";
    readonly existingSupportBundleToken: string;
}

export type PackagedDiagnosticsProofStep =
    | "initialize"
    | "available_operations"
    | "health"
    | "log_settings"
    | "support_standard_review"
    | "support_standard_export"
    | "support_extended_review"
    | "support_existing_destination"
    | "log_clear"
    | "maintenance"
    | "interface_cache"
    | "interface_reset"
    | "performance_start"
    | "performance_stop"
    | "performance_discard"
    | "final_health"
    | "client_listener"
    | "unexpected";

export type PackagedDiagnosticsProofReply =
    | { readonly status: "complete" }
    | {
          readonly status: "failed";
          readonly step: PackagedDiagnosticsProofStep;
          readonly diagnosticCodes: readonly string[];
      };

const PROOF_STEPS: ReadonlySet<string> = new Set<PackagedDiagnosticsProofStep>([
    "initialize",
    "available_operations",
    "health",
    "log_settings",
    "support_standard_review",
    "support_standard_export",
    "support_extended_review",
    "support_existing_destination",
    "log_clear",
    "maintenance",
    "interface_cache",
    "interface_reset",
    "performance_start",
    "performance_stop",
    "performance_discard",
    "final_health",
    "client_listener",
    "unexpected",
]);

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.trim() === value && !value.includes("\0");
}

function isDiagnosticCodes(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.length <= 8 &&
        value.every((code) => typeof code === "string" && /^[a-z0-9_.-]{1,128}$/u.test(code))
    );
}

export function parsePackagedDiagnosticsProofRequest(value: unknown): PackagedDiagnosticsProofRequest {
    if (isExactRecord(value, ["supportBundleExportToken"]) && isNonEmptyString(value.supportBundleExportToken)) {
        return Object.freeze({ supportBundleExportToken: value.supportBundleExportToken });
    }
    throw new TypeError("invalid packaged diagnostics proof request");
}

export function parsePackagedDiagnosticsProofControlRequest(value: unknown): PackagedDiagnosticsProofControlRequest {
    if (isExactRecord(value, ["control"]) && value.control === "request_existing_support_bundle_token") {
        return Object.freeze({ control: "request_existing_support_bundle_token" });
    }
    throw new TypeError("invalid packaged diagnostics proof control request");
}

export function parsePackagedDiagnosticsProofControlReply(value: unknown): PackagedDiagnosticsProofControlReply {
    if (
        isExactRecord(value, ["control", "existingSupportBundleToken"]) &&
        value.control === "existing_support_bundle_token" &&
        isNonEmptyString(value.existingSupportBundleToken)
    ) {
        return Object.freeze({
            control: "existing_support_bundle_token",
            existingSupportBundleToken: value.existingSupportBundleToken,
        });
    }
    throw new TypeError("invalid packaged diagnostics proof control reply");
}

export function parsePackagedDiagnosticsProofReply(value: unknown): PackagedDiagnosticsProofReply {
    if (isExactRecord(value, ["status"]) && value.status === "complete") return Object.freeze({ status: "complete" });
    if (
        isExactRecord(value, ["diagnosticCodes", "status", "step"]) &&
        value.status === "failed" &&
        typeof value.step === "string" &&
        PROOF_STEPS.has(value.step) &&
        isDiagnosticCodes(value.diagnosticCodes)
    ) {
        return Object.freeze({
            status: "failed",
            step: value.step as PackagedDiagnosticsProofStep,
            diagnosticCodes: Object.freeze([...value.diagnosticCodes]),
        });
    }
    throw new TypeError("invalid packaged diagnostics proof reply");
}
