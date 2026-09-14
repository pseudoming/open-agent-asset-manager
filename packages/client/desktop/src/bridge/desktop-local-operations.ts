export const DESKTOP_MAINTENANCE_GET_CHANNEL = "oaam:desktop-maintenance-get";
export const DESKTOP_INTERFACE_CACHE_CLEAR_CHANNEL = "oaam:desktop-interface-cache-clear";
export const DESKTOP_DATA_LOCATION_ACTION_CHANNEL = "oaam:desktop-data-location-action";
export const DESKTOP_INTERFACE_DEFAULTS_RESTORE_CHANNEL = "oaam:desktop-interface-defaults-restore";
export const SUPPORT_BUNDLE_EXPORT_PICK_CHANNEL = "oaam:desktop-support-bundle-export-pick";
export const DESKTOP_PERFORMANCE_RECORDING_GET_CHANNEL = "oaam:desktop-performance-recording-get";
export const DESKTOP_PERFORMANCE_RECORDING_START_CHANNEL = "oaam:desktop-performance-recording-start";
export const DESKTOP_PERFORMANCE_RECORDING_STOP_CHANNEL = "oaam:desktop-performance-recording-stop";
export const DESKTOP_PERFORMANCE_RECORDING_SAVE_CHANNEL = "oaam:desktop-performance-recording-save";
export const DESKTOP_PERFORMANCE_RECORDING_DISCARD_CHANNEL = "oaam:desktop-performance-recording-discard";
export const DESKTOP_PERFORMANCE_RECORDING_CHANGED_CHANNEL = "oaam:desktop-performance-recording-changed";

export const DESKTOP_DATA_LOCATION_IDS = [
    "oaam_data",
    "desktop_profile",
    "state_backups",
    "ordinary_logs",
    "interface_cache",
] as const;

export const DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_DURATION_SECONDS = 120;
export const DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_BUFFER_BYTES = 100 * 1024 * 1024;
export const DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_ARTIFACT_BYTES = 128 * 1024 * 1024;
export const DESKTOP_PERFORMANCE_RECORDING_ARTIFACT_TTL_MS = 15 * 60 * 1000;

export type DesktopDataLocationId = (typeof DESKTOP_DATA_LOCATION_IDS)[number];
export type DesktopDataLocationAction = "open" | "copy_path";

export type DesktopInterfaceCacheMeasurement =
    | { readonly status: "available"; readonly byteSize: number }
    | { readonly status: "unavailable" };

export type DesktopDataLocation =
    | {
          readonly locationId: DesktopDataLocationId;
          readonly status: "available";
          readonly displayPath: string;
      }
    | {
          readonly locationId: DesktopDataLocationId;
          readonly status: "unavailable";
      };

export interface DesktopMaintenanceSnapshot {
    readonly interfaceCache: DesktopInterfaceCacheMeasurement;
    readonly dataLocations: readonly DesktopDataLocation[];
}

export type DesktopInterfaceCacheClearResult =
    | {
          readonly status: "complete";
          readonly interfaceCache: DesktopInterfaceCacheMeasurement;
      }
    | {
          readonly status: "failed";
          readonly code: "clear_failed";
          readonly interfaceCache: DesktopInterfaceCacheMeasurement;
      };

export type DesktopDataLocationActionResult =
    | { readonly status: "complete" }
    | {
          readonly status: "failed";
          readonly code: "unavailable" | "open_failed" | "copy_failed";
      };

export interface DesktopInterfaceDefaultsRestoreResult {
    readonly status: "complete" | "partial" | "failed";
    readonly presentation: "complete" | "failed";
    readonly windowState: "complete" | "failed";
}

export type SupportBundleExportPickerResult =
    | { readonly status: "cancelled" }
    | {
          readonly status: "selected";
          readonly displayPath: string;
          readonly localPathSelectionToken: string;
      };

export type DesktopPerformanceRecordingFailureCode =
    | "initialization_failed"
    | "start_failed"
    | "stop_failed"
    | "trace_too_large"
    | "cleanup_failed";

export type DesktopPerformanceRecordingSnapshot =
    | { readonly state: "idle" }
    | {
          readonly state: "recording";
          readonly startedAt: number;
          readonly deadlineAt: number;
          readonly maximumBufferBytes: typeof DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_BUFFER_BYTES;
      }
    | {
          readonly state: "ready";
          readonly stoppedAt: number;
          readonly expiresAt: number;
          readonly byteSize: number;
      }
    | {
          readonly state: "failed";
          readonly code: DesktopPerformanceRecordingFailureCode;
          readonly mayStillBeRecording: boolean;
      };

export type DesktopPerformanceRecordingSaveResult =
    | { readonly status: "cancelled" }
    | { readonly status: "complete"; readonly displayPath: string }
    | { readonly status: "failed"; readonly code: "not_ready" | "save_failed" };

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.trim() === value && !value.includes("\0");
}

function isSafeNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseDesktopDataLocationId(value: unknown): DesktopDataLocationId {
    if (typeof value !== "string" || !DESKTOP_DATA_LOCATION_IDS.includes(value as DesktopDataLocationId)) {
        throw new TypeError("invalid Desktop data-location identity");
    }
    return value as DesktopDataLocationId;
}

export function parseDesktopDataLocationAction(value: unknown): DesktopDataLocationAction {
    if (value !== "open" && value !== "copy_path") throw new TypeError("invalid Desktop data-location action");
    return value;
}

function parseDesktopInterfaceCacheMeasurement(value: unknown): DesktopInterfaceCacheMeasurement {
    if (isExactRecord(value, ["status"]) && value.status === "unavailable") {
        return Object.freeze({ status: "unavailable" });
    }
    if (
        isExactRecord(value, ["byteSize", "status"]) &&
        value.status === "available" &&
        isSafeNonNegativeInteger(value.byteSize)
    ) {
        return Object.freeze({ status: "available", byteSize: value.byteSize });
    }
    throw new TypeError("invalid Desktop interface-cache measurement");
}

function parseDesktopDataLocation(value: unknown, expectedId: DesktopDataLocationId): DesktopDataLocation {
    if (isExactRecord(value, ["locationId", "status"]) && value.locationId === expectedId && value.status === "unavailable") {
        return Object.freeze({ locationId: expectedId, status: "unavailable" });
    }
    if (
        isExactRecord(value, ["displayPath", "locationId", "status"]) &&
        value.locationId === expectedId &&
        value.status === "available" &&
        isNonEmptyString(value.displayPath) &&
        value.displayPath.length <= 32_768
    ) {
        return Object.freeze({ locationId: expectedId, status: "available", displayPath: value.displayPath });
    }
    throw new TypeError("invalid Desktop data location");
}

export function parseDesktopMaintenanceSnapshot(value: unknown): DesktopMaintenanceSnapshot {
    if (
        !isExactRecord(value, ["dataLocations", "interfaceCache"]) ||
        !Array.isArray(value.dataLocations) ||
        value.dataLocations.length !== DESKTOP_DATA_LOCATION_IDS.length
    ) {
        throw new TypeError("invalid Desktop maintenance snapshot");
    }
    const dataLocations: unknown[] = value.dataLocations;
    return Object.freeze({
        interfaceCache: parseDesktopInterfaceCacheMeasurement(value.interfaceCache),
        dataLocations: Object.freeze(
            DESKTOP_DATA_LOCATION_IDS.map((locationId, index) => parseDesktopDataLocation(dataLocations[index], locationId)),
        ),
    });
}

export function parseDesktopInterfaceCacheClearResult(value: unknown): DesktopInterfaceCacheClearResult {
    if (isExactRecord(value, ["interfaceCache", "status"]) && value.status === "complete") {
        return Object.freeze({ status: "complete", interfaceCache: parseDesktopInterfaceCacheMeasurement(value.interfaceCache) });
    }
    if (
        isExactRecord(value, ["code", "interfaceCache", "status"]) &&
        value.status === "failed" &&
        value.code === "clear_failed"
    ) {
        return Object.freeze({
            status: "failed",
            code: "clear_failed",
            interfaceCache: parseDesktopInterfaceCacheMeasurement(value.interfaceCache),
        });
    }
    throw new TypeError("invalid Desktop interface-cache clear result");
}

export function parseDesktopDataLocationActionResult(value: unknown): DesktopDataLocationActionResult {
    if (isExactRecord(value, ["status"]) && value.status === "complete") return Object.freeze({ status: "complete" });
    if (
        isExactRecord(value, ["code", "status"]) &&
        value.status === "failed" &&
        (value.code === "unavailable" || value.code === "open_failed" || value.code === "copy_failed")
    ) {
        return Object.freeze({ status: "failed", code: value.code });
    }
    throw new TypeError("invalid Desktop data-location action result");
}

export function parseDesktopInterfaceDefaultsRestoreResult(value: unknown): DesktopInterfaceDefaultsRestoreResult {
    if (
        !isExactRecord(value, ["presentation", "status", "windowState"]) ||
        (value.presentation !== "complete" && value.presentation !== "failed") ||
        (value.windowState !== "complete" && value.windowState !== "failed")
    ) {
        throw new TypeError("invalid Desktop interface-default restore result");
    }
    const expectedStatus =
        value.presentation === "complete" && value.windowState === "complete"
            ? "complete"
            : value.presentation === "failed" && value.windowState === "failed"
              ? "failed"
              : "partial";
    if (value.status !== expectedStatus) throw new TypeError("inconsistent Desktop interface-default restore result");
    return Object.freeze({ status: expectedStatus, presentation: value.presentation, windowState: value.windowState });
}

export function parseSupportBundleExportPickerResult(value: unknown): SupportBundleExportPickerResult {
    if (isExactRecord(value, ["status"]) && value.status === "cancelled") return Object.freeze({ status: "cancelled" });
    if (
        isExactRecord(value, ["displayPath", "localPathSelectionToken", "status"]) &&
        value.status === "selected" &&
        isNonEmptyString(value.displayPath) &&
        value.displayPath.length <= 32_768 &&
        isNonEmptyString(value.localPathSelectionToken)
    ) {
        return Object.freeze({
            status: "selected",
            displayPath: value.displayPath,
            localPathSelectionToken: value.localPathSelectionToken,
        });
    }
    throw new TypeError("invalid support-bundle export picker result");
}

export function parseSupportBundleExportSuggestedFileName(value: unknown): string {
    if (!isNonEmptyString(value) || value.length > 255 || value.includes("/") || value.includes("\\")) {
        throw new TypeError("invalid support-bundle export file name");
    }
    return value;
}

export function parseDesktopSensitiveCaptureConfirmation(value: unknown): true {
    if (value !== true) throw new TypeError("performance recording requires fresh sensitive-data confirmation");
    return true;
}

export function parseDesktopPerformanceRecordingSnapshot(value: unknown): DesktopPerformanceRecordingSnapshot {
    if (isExactRecord(value, ["state"]) && value.state === "idle") return Object.freeze({ state: "idle" });
    if (
        isExactRecord(value, ["deadlineAt", "maximumBufferBytes", "startedAt", "state"]) &&
        value.state === "recording" &&
        isSafeNonNegativeInteger(value.startedAt) &&
        isSafeNonNegativeInteger(value.deadlineAt) &&
        value.deadlineAt === value.startedAt + DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_DURATION_SECONDS * 1000 &&
        value.maximumBufferBytes === DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_BUFFER_BYTES
    ) {
        return Object.freeze({
            state: "recording",
            startedAt: value.startedAt,
            deadlineAt: value.deadlineAt,
            maximumBufferBytes: DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_BUFFER_BYTES,
        });
    }
    if (
        isExactRecord(value, ["byteSize", "expiresAt", "state", "stoppedAt"]) &&
        value.state === "ready" &&
        isSafeNonNegativeInteger(value.stoppedAt) &&
        isSafeNonNegativeInteger(value.expiresAt) &&
        value.expiresAt === value.stoppedAt + DESKTOP_PERFORMANCE_RECORDING_ARTIFACT_TTL_MS &&
        isSafeNonNegativeInteger(value.byteSize) &&
        value.byteSize <= DESKTOP_PERFORMANCE_RECORDING_MAXIMUM_ARTIFACT_BYTES
    ) {
        return Object.freeze({
            state: "ready",
            stoppedAt: value.stoppedAt,
            expiresAt: value.expiresAt,
            byteSize: value.byteSize,
        });
    }
    if (
        isExactRecord(value, ["code", "mayStillBeRecording", "state"]) &&
        value.state === "failed" &&
        (value.code === "initialization_failed" ||
            value.code === "start_failed" ||
            value.code === "stop_failed" ||
            value.code === "trace_too_large" ||
            value.code === "cleanup_failed") &&
        typeof value.mayStillBeRecording === "boolean"
    ) {
        return Object.freeze({ state: "failed", code: value.code, mayStillBeRecording: value.mayStillBeRecording });
    }
    throw new TypeError("invalid Desktop performance-recording snapshot");
}

export function parseDesktopPerformanceRecordingSaveResult(value: unknown): DesktopPerformanceRecordingSaveResult {
    if (isExactRecord(value, ["status"]) && value.status === "cancelled") return Object.freeze({ status: "cancelled" });
    if (
        isExactRecord(value, ["displayPath", "status"]) &&
        value.status === "complete" &&
        isNonEmptyString(value.displayPath) &&
        value.displayPath.length <= 32_768
    ) {
        return Object.freeze({ status: "complete", displayPath: value.displayPath });
    }
    if (
        isExactRecord(value, ["code", "status"]) &&
        value.status === "failed" &&
        (value.code === "not_ready" || value.code === "save_failed")
    ) {
        return Object.freeze({ status: "failed", code: value.code });
    }
    throw new TypeError("invalid Desktop performance-recording save result");
}
