import * as crypto from "node:crypto";
import * as path from "node:path";
import {
    type DesktopOperationalDiagnosticCode,
    type HostOperationalDiagnosticCode,
    MAXIMUM_ORDINARY_LOG_MAXIMUM_BYTES,
    MAXIMUM_ORDINARY_LOG_RETENTION_DAYS,
    type ProtocolDesktopRendererDiagnosticInputV1,
    type ProtocolDiagnosticsHealthV1,
    type ProtocolDiagnosticV1,
    type ProtocolOperationalDiagnosticCode,
    type ProtocolOperationalDiagnosticRecordV1,
    type ProtocolOperationName,
    type ProtocolOperationOutcomeV1,
    type ProtocolOrdinaryLogClearResultV1,
    type ProtocolOrdinaryLogSettingsReplaceParamsV1,
    type ProtocolOrdinaryLogSettingsV1,
    protocolOperationalDiagnosticRecordSchema,
    protocolOrdinaryLogSettingsSchema,
} from "@oaam/app-server-protocol";
import {
    durableCreateFile,
    durableEnsureDirectory,
    durableReplaceFile,
    inventoryDirectoryNoFollow,
    type PhysicalPathIdentity,
    permanentlyRemoveRegularFileIfIdentity,
    readRegularFileNoFollow,
    SafeFilesystemError,
} from "@oaam/shared/filesystem";
import type { OperationalSupportLogSnapshot } from "./support-bundle";
import type { HostLifecycleState, HostStartupDisposition } from "./types";

export const DEFAULT_OPERATIONAL_LOG_MAXIMUM_BYTES = MAXIMUM_ORDINARY_LOG_MAXIMUM_BYTES;
export const DEFAULT_OPERATIONAL_LOG_SEGMENT_BYTES = 64 * 1024;
const MAXIMUM_OPERATIONAL_LOG_SEGMENTS = 1_024;
const MAXIMUM_OPERATIONAL_LOG_SETTINGS_BYTES = 2 * 1024;
const MILLISECONDS_PER_DAY = 86_400_000;
const SEGMENT_PREFIX = "ordinary-";
const SEGMENT_SUFFIX = ".jsonl";
const SETTINGS_FILE_NAME = "ordinary-settings.json";

const DEFAULT_ORDINARY_LOG_SETTINGS: ProtocolOrdinaryLogSettingsV1 = Object.freeze({
    schemaVersion: 1,
    enabled: true,
    retentionDays: MAXIMUM_ORDINARY_LOG_RETENTION_DAYS,
    maximumBytes: MAXIMUM_ORDINARY_LOG_MAXIMUM_BYTES,
});

export type OperationalDiagnosticInput =
    | { readonly source: "host"; readonly code: HostOperationalDiagnosticCode }
    | {
          readonly source: "protocol";
          readonly code: "protocol.request.accepted";
          readonly operation: ProtocolOperationName;
      }
    | {
          readonly source: "protocol";
          readonly code: "protocol.adapter_probe.owner_timing";
          readonly operationId: string;
          readonly stage: "provider_probe";
          readonly adapterId: string;
          readonly environment: { readonly platform: "win32" | "darwin" | "linux" | "wsl"; readonly platformInstanceId: string };
          readonly status: "complete" | "partial" | "failed";
          readonly startedOffsetMilliseconds: number;
          readonly endedOffsetMilliseconds: number;
          readonly elapsedMilliseconds: number;
      }
    | {
          readonly source: "protocol";
          readonly code: "protocol.adapter_probe.summary_timing";
          readonly operationId: string;
          readonly stage: "provider_probe";
          readonly status: "complete" | "partial" | "failed";
          readonly ownerCount: number;
          readonly elapsedMilliseconds: number;
          readonly maximumOwnerElapsedMilliseconds: number;
          readonly overheadMilliseconds: number;
      }
    | {
          readonly source: "protocol";
          readonly code: "protocol.request.terminal";
          readonly operation: ProtocolOperationName;
          readonly status: "complete" | "partial" | "failed";
          readonly diagnosticCodes: readonly string[];
          readonly operationId?: string;
      }
    | {
          readonly source: "protocol";
          readonly code: Exclude<
              ProtocolOperationalDiagnosticCode,
              | "protocol.request.accepted"
              | "protocol.adapter_probe.owner_timing"
              | "protocol.adapter_probe.summary_timing"
              | "protocol.request.terminal"
          >;
      }
    | {
          readonly source: "desktop";
          readonly code: Exclude<DesktopOperationalDiagnosticCode, "desktop.renderer.event">;
      }
    | ({ readonly source: "desktop"; readonly code: "desktop.renderer.event" } & ProtocolDesktopRendererDiagnosticInputV1);

export type OperationalLogSuspensionReason = Exclude<
    ProtocolDiagnosticsHealthV1["ordinaryLog"]["suspensionReason"],
    "none" | "user_disabled"
>;

export interface OperationalLogFilesystem {
    durableEnsureDirectory(parentPath: string, childName: string): unknown;
    inventoryDirectoryNoFollow(
        directoryPath: string,
        maximumEntries: number,
    ): {
        readonly entries: readonly {
            readonly relativeName: string;
            readonly identity: PhysicalPathIdentity;
        }[];
    };
    readRegularFileNoFollow(
        filePath: string,
        maximumBytes: number,
    ): { readonly bytes: Uint8Array; readonly identity: PhysicalPathIdentity };
    durableCreateFile(filePath: string, data: string | Uint8Array): PhysicalPathIdentity;
    durableReplaceFile(filePath: string, data: string | Uint8Array): PhysicalPathIdentity;
    permanentlyRemoveRegularFileIfIdentity(filePath: string, expectedIdentity: PhysicalPathIdentity): boolean;
}

export interface OperationalDiagnosticsDependencies {
    readonly now?: () => number;
    readonly createSegmentId?: () => string;
    readonly maximumBytes?: number;
    readonly maximumSegmentBytes?: number;
    readonly filesystem?: OperationalLogFilesystem;
}

export interface OperationalDiagnostics {
    record(input: OperationalDiagnosticInput): void;
    health(state: HostLifecycleState, startupDisposition: HostStartupDisposition): ProtocolDiagnosticsHealthV1;
    settings(): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogSettingsV1>;
    replaceSettings(input: ProtocolOrdinaryLogSettingsReplaceParamsV1): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogSettingsV1>;
    clearOrdinaryLog(): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogClearResultV1>;
    captureSupportLogSnapshot(maximumBytes: number): OperationalSupportLogSnapshot;
}

const physicalFilesystem: OperationalLogFilesystem = Object.freeze({
    durableEnsureDirectory,
    inventoryDirectoryNoFollow,
    readRegularFileNoFollow,
    durableCreateFile,
    durableReplaceFile,
    permanentlyRemoveRegularFileIfIdentity,
});

function boundedTerminalDiagnosticCodes(codes: readonly string[]): readonly string[] {
    return Object.freeze([...new Set(codes.filter((code) => code.length > 0 && code.trim() === code))].sort().slice(0, 16));
}

function operationalLogRecord(input: OperationalDiagnosticInput, occurredAt: number): ProtocolOperationalDiagnosticRecordV1 {
    return protocolOperationalDiagnosticRecordSchema.parse({
        schemaVersion: 1,
        occurredAt,
        ...(input.source === "protocol" && input.code === "protocol.request.terminal"
            ? { ...input, diagnosticCodes: boundedTerminalDiagnosticCodes(input.diagnosticCodes) }
            : input),
    });
}

function isSafeSegmentId(value: string): boolean {
    if (value.length !== 32) return false;
    for (const character of value) {
        const isDigit = character >= "0" && character <= "9";
        const isLowerHex = character >= "a" && character <= "f";
        if (!isDigit && !isLowerHex) return false;
    }
    return true;
}

function ownedSegmentOccurredAt(name: string): number | null {
    if (!name.startsWith(SEGMENT_PREFIX) || !name.endsWith(SEGMENT_SUFFIX)) return null;
    const identity = name.slice(SEGMENT_PREFIX.length, -SEGMENT_SUFFIX.length);
    const separator = identity.indexOf("-");
    if (separator <= 0 || identity.indexOf("-", separator + 1) !== -1) return null;
    const occurredAtText = identity.slice(0, separator);
    const segmentId = identity.slice(separator + 1);
    const occurredAt = Number(occurredAtText);
    return Number.isSafeInteger(occurredAt) &&
        occurredAt >= 0 &&
        String(occurredAt) === occurredAtText &&
        isSafeSegmentId(segmentId)
        ? occurredAt
        : null;
}

function parseExistingSegment(bytes: Uint8Array, segmentOccurredAt: number): void {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length === 0 || !text.endsWith("\n")) throw new TypeError("operational log segment is incomplete");
    const lines = text.slice(0, -1).split("\n");
    for (const [index, line] of lines.entries()) {
        if (line.length === 0) throw new TypeError("operational log segment contains an empty record");
        const record = protocolOperationalDiagnosticRecordSchema.parse(JSON.parse(line) as unknown);
        if (index === 0 && record.occurredAt !== segmentOccurredAt) {
            throw new TypeError("operational log segment name does not match its first record");
        }
    }
}

function sameSettings(left: ProtocolOrdinaryLogSettingsV1, right: ProtocolOrdinaryLogSettingsV1): boolean {
    return (
        left.enabled === right.enabled && left.retentionDays === right.retentionDays && left.maximumBytes === right.maximumBytes
    );
}

function operationalSettings(input: ProtocolOrdinaryLogSettingsReplaceParamsV1): ProtocolOrdinaryLogSettingsV1 {
    return protocolOrdinaryLogSettingsSchema.parse({ schemaVersion: 1, ...input });
}

function settingsBytes(settings: ProtocolOrdinaryLogSettingsV1): Uint8Array {
    return new TextEncoder().encode(`${JSON.stringify(settings)}\n`);
}

function diagnostic(
    code: string,
    causeKind: ProtocolDiagnosticV1["causeKind"],
    message: string,
    retryable: boolean,
): ProtocolDiagnosticV1 {
    return {
        severity: "error",
        code,
        operation: "host",
        causeKind,
        retryable,
        suggestedActions: retryable ? ["retry"] : ["contact_support"],
        message,
    };
}

function settingsUnavailable<T>(): ProtocolOperationOutcomeV1<T> {
    return {
        status: "failed",
        diagnostics: [
            diagnostic(
                "host.ordinary_log_settings_unavailable",
                "invalid_schema",
                "Ordinary-log settings are unavailable because their exact Host-owned storage is unsafe.",
                false,
            ),
        ],
    };
}

function settingsWriteFailed<T>(): ProtocolOperationOutcomeV1<T> {
    return {
        status: "failed",
        diagnostics: [
            diagnostic(
                "host.ordinary_log_settings_write_failed",
                "internal_error",
                "Ordinary-log settings could not be committed and verified.",
                true,
            ),
        ],
    };
}

function cleanupDiagnostic(): ProtocolDiagnosticV1 {
    return diagnostic(
        "host.ordinary_log_cleanup_failed",
        "verification_failed",
        "Ordinary-log cleanup could not prove permanent removal of every selected OAAM-owned segment.",
        true,
    );
}

interface OperationalLogSegment {
    readonly relativeName: string;
    readonly filePath: string;
    readonly occurredAt: number;
    readonly identity: PhysicalPathIdentity;
    readonly bytes: Uint8Array;
}

function compareSegments(left: OperationalLogSegment, right: OperationalLogSegment): number {
    if (left.occurredAt !== right.occurredAt) return left.occurredAt - right.occurredAt;
    return left.relativeName < right.relativeName ? -1 : 1;
}

function isNotFound(error: unknown): boolean {
    return error instanceof SafeFilesystemError && error.failureKind === "not_found";
}

function validateNow(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid operational timestamp");
    return value;
}

function retentionCutoff(now: number, retentionDays: number): number {
    const retainedMilliseconds = retentionDays * MILLISECONDS_PER_DAY;
    return Math.max(0, now - retainedMilliseconds);
}

function validIdentity(identity: PhysicalPathIdentity): boolean {
    return identity.entryKind === "file" && identity.deviceId.length > 0 && identity.fileId.length > 0;
}

function validateBound(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
    return value;
}

function overallStatus(
    state: HostLifecycleState,
    startupDisposition: HostStartupDisposition,
    logState: "active" | "disabled" | "suspended",
): ProtocolDiagnosticsHealthV1["overallStatus"] {
    if (logState === "suspended" || state === "stopped" || state === "failed") return "unhealthy";
    if (state !== "ready" || startupDisposition.mode === "state_recovery") return "degraded";
    return "healthy";
}

export class HostOperationalDiagnostics implements OperationalDiagnostics {
    readonly #now: () => number;
    readonly #createSegmentId: () => string;
    readonly #maximumBytesOverride: number | undefined;
    readonly #maximumSegmentBytes: number;
    readonly #filesystem: OperationalLogFilesystem;
    readonly #oaamRoot: string;
    readonly #ordinaryLogRoot: string;
    readonly #settingsPath: string;
    #logState:
        | { readonly state: "active"; readonly suspensionReason: "none" }
        | { readonly state: "disabled"; readonly suspensionReason: "user_disabled" }
        | { readonly state: "suspended"; readonly suspensionReason: OperationalLogSuspensionReason } = {
        state: "active",
        suspensionReason: "none",
    };
    #settings = DEFAULT_ORDINARY_LOG_SETTINGS;
    #settingsReadable = true;
    #settingsPersisted = false;
    #segments: OperationalLogSegment[] = [];
    #retainedBytes = 0;
    #currentSegmentName = "";

    public constructor(oaamRoot: string, dependencies: OperationalDiagnosticsDependencies = {}) {
        this.#now = dependencies.now ?? Date.now;
        this.#createSegmentId = dependencies.createSegmentId ?? (() => crypto.randomBytes(16).toString("hex"));
        this.#maximumBytesOverride =
            dependencies.maximumBytes === undefined
                ? undefined
                : validateBound(dependencies.maximumBytes, "operational log maximum bytes");
        this.#maximumSegmentBytes = validateBound(
            dependencies.maximumSegmentBytes ?? DEFAULT_OPERATIONAL_LOG_SEGMENT_BYTES,
            "operational log segment bytes",
        );
        if (this.#maximumSegmentBytes > this.#effectiveMaximumBytes()) {
            throw new TypeError("operational log segment bytes cannot exceed the aggregate maximum");
        }
        this.#filesystem = dependencies.filesystem ?? physicalFilesystem;
        this.#oaamRoot = oaamRoot;
        this.#ordinaryLogRoot = path.join(oaamRoot, "logs", "ordinary");
        this.#settingsPath = path.join(oaamRoot, "logs", SETTINGS_FILE_NAME);
        this.#open(oaamRoot);
    }

    public record(input: OperationalDiagnosticInput): void {
        if (this.#logState.state !== "active") return;
        try {
            const occurredAt = validateNow(this.#now());
            const line = new TextEncoder().encode(`${JSON.stringify(operationalLogRecord(input, occurredAt))}\n`);
            if (line.byteLength > this.#maximumSegmentBytes) throw new TypeError("operational record exceeds segment bound");
            if (!this.#applyRetention(occurredAt, line.byteLength)) return;
            const current = this.#segments.find((segment) => segment.relativeName === this.#currentSegmentName);
            if (current === undefined || current.bytes.byteLength + line.byteLength > this.#maximumSegmentBytes) {
                this.#createSegment(occurredAt, line);
            } else {
                this.#replaceCurrentSegment(current, line);
            }
            this.#retainedBytes += line.byteLength;
        } catch {
            this.#suspend("write_failed");
        }
    }

    public health(state: HostLifecycleState, startupDisposition: HostStartupDisposition): ProtocolDiagnosticsHealthV1 {
        const ordinaryLog =
            this.#logState.state === "active"
                ? {
                      state: "active" as const,
                      suspensionReason: "none" as const,
                      retainedBytes: this.#retainedBytes,
                      maximumBytes: this.#effectiveMaximumBytes(),
                      segmentCount: this.#segments.length,
                  }
                : this.#logState.state === "disabled"
                  ? {
                        state: "disabled" as const,
                        suspensionReason: "user_disabled" as const,
                        retainedBytes: this.#retainedBytes,
                        maximumBytes: this.#effectiveMaximumBytes(),
                        segmentCount: this.#segments.length,
                    }
                  : {
                        state: "suspended" as const,
                        suspensionReason: this.#logState.suspensionReason,
                        retainedBytes: this.#retainedBytes,
                        maximumBytes: this.#effectiveMaximumBytes(),
                        segmentCount: this.#segments.length,
                    };
        return {
            schemaVersion: 1,
            overallStatus: overallStatus(state, startupDisposition, this.#logState.state),
            host: {
                lifecycleState: state,
                startupMode: startupDisposition.mode,
            },
            ordinaryLog,
        };
    }

    public settings(): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogSettingsV1> {
        if (!this.#settingsReadable) return settingsUnavailable();
        return { status: "complete", value: this.#settings, diagnostics: [] };
    }

    public replaceSettings(
        input: ProtocolOrdinaryLogSettingsReplaceParamsV1,
    ): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogSettingsV1> {
        const next = operationalSettings(input);
        const bytes = settingsBytes(next);
        try {
            if (this.#settingsPersisted) {
                this.#filesystem.durableReplaceFile(this.#settingsPath, bytes);
            } else {
                this.#filesystem.durableCreateFile(this.#settingsPath, bytes);
            }
        } catch {
            // A durable mutation may report may-have-applied. Exact readback
            // below is the only safe way to decide whether the requested
            // whole setting became current.
        }
        try {
            if (!sameSettings(this.#readPersistedSettings(), next)) {
                this.#suspend("write_failed");
                return settingsWriteFailed();
            }
        } catch {
            this.#suspend("write_failed");
            return settingsWriteFailed();
        }

        this.#settings = next;
        this.#settingsReadable = true;
        this.#settingsPersisted = true;
        try {
            this.#reloadSegments();
        } catch {
            this.#suspend("unsafe_storage");
            return {
                status: "partial",
                value: this.#settings,
                diagnostics: [cleanupDiagnostic()],
            };
        }
        if (!this.#applyRetention(validateNow(this.#now()), 0)) {
            return {
                status: "partial",
                value: this.#settings,
                diagnostics: [cleanupDiagnostic()],
            };
        }
        this.#setConfiguredState();
        return { status: "complete", value: this.#settings, diagnostics: [] };
    }

    public clearOrdinaryLog(): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogClearResultV1> {
        if (!this.#settingsReadable) return settingsUnavailable();
        try {
            this.#reloadSegments();
        } catch {
            this.#suspend("unsafe_storage");
            return {
                status: "failed",
                diagnostics: [cleanupDiagnostic()],
            };
        }
        const initialBytes = this.#retainedBytes;
        const initialCount = this.#segments.length;
        let oldestSegment = this.#segments[0];
        while (oldestSegment !== undefined) {
            if (!this.#removeOldestSegment(oldestSegment)) {
                return {
                    status: "partial",
                    value: {
                        removedSegmentCount: initialCount - this.#segments.length,
                        removedBytes: initialBytes - this.#retainedBytes,
                        settings: this.#settings,
                    },
                    diagnostics: [cleanupDiagnostic()],
                };
            }
            oldestSegment = this.#segments[0];
        }
        this.#setConfiguredState();
        return {
            status: "complete",
            value: {
                removedSegmentCount: initialCount,
                removedBytes: initialBytes,
                settings: this.#settings,
            },
            diagnostics: [],
        };
    }

    public captureSupportLogSnapshot(maximumBytes: number): OperationalSupportLogSnapshot {
        validateBound(maximumBytes, "support-log maximum bytes");
        if (!this.#settingsReadable) throw new TypeError("ordinary-log storage is unavailable");
        try {
            this.#reloadSegments();
        } catch (error) {
            this.#suspend("unsafe_storage");
            throw error;
        }
        const selected: OperationalLogSegment[] = [];
        let includedBytes = 0;
        for (let index = this.#segments.length - 1; index >= 0; index -= 1) {
            const segment = this.#segments[index] as OperationalLogSegment;
            if (includedBytes + segment.bytes.byteLength > maximumBytes) break;
            selected.push(segment);
            includedBytes += segment.bytes.byteLength;
        }
        selected.reverse();
        const bytes = new Uint8Array(includedBytes);
        let offset = 0;
        for (const segment of selected) {
            bytes.set(segment.bytes, offset);
            offset += segment.bytes.byteLength;
        }
        return {
            bytes,
            retainedSegmentCount: this.#segments.length,
            includedSegmentCount: selected.length,
            retainedBytes: this.#retainedBytes,
            includedBytes,
            truncated: includedBytes < this.#retainedBytes,
            locations: {
                oaamRoot: this.#oaamRoot,
                ordinaryLogRoot: this.#ordinaryLogRoot,
                settingsPath: this.#settingsPath,
            },
        };
    }

    #open(oaamRoot: string): void {
        try {
            this.#filesystem.durableEnsureDirectory(oaamRoot, "logs");
            try {
                this.#settings = this.#readPersistedSettings();
                this.#settingsPersisted = true;
            } catch (error) {
                if (!isNotFound(error)) {
                    this.#settingsReadable = false;
                    this.#suspend("unsafe_storage");
                    return;
                }
            }
            this.#filesystem.durableEnsureDirectory(path.join(oaamRoot, "logs"), "ordinary");
            this.#reloadSegments();
            if (!this.#applyRetention(validateNow(this.#now()), 0)) return;
            this.#setConfiguredState();
        } catch {
            this.#suspend("unsafe_storage");
        }
    }

    #readPersistedSettings(): ProtocolOrdinaryLogSettingsV1 {
        const bytes = this.#filesystem.readRegularFileNoFollow(this.#settingsPath, MAXIMUM_OPERATIONAL_LOG_SETTINGS_BYTES).bytes;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
            throw new TypeError("ordinary-log settings must be one complete JSON line");
        }
        return protocolOrdinaryLogSettingsSchema.parse(JSON.parse(text.slice(0, -1)) as unknown);
    }

    #reloadSegments(): void {
        const inventory = this.#filesystem.inventoryDirectoryNoFollow(this.#ordinaryLogRoot, MAXIMUM_OPERATIONAL_LOG_SEGMENTS);
        const segments: OperationalLogSegment[] = [];
        let retainedBytes = 0;
        for (const entry of inventory.entries) {
            const occurredAt = ownedSegmentOccurredAt(entry.relativeName);
            if (occurredAt === null || !validIdentity(entry.identity)) {
                throw new TypeError("ordinary-log root contains a non-owned entry");
            }
            const filePath = path.join(this.#ordinaryLogRoot, entry.relativeName);
            const observed = this.#filesystem.readRegularFileNoFollow(filePath, this.#maximumSegmentBytes);
            if (
                observed.identity.deviceId !== entry.identity.deviceId ||
                observed.identity.fileId !== entry.identity.fileId ||
                observed.identity.entryKind !== entry.identity.entryKind
            ) {
                throw new TypeError("ordinary-log segment changed while it was inventoried");
            }
            parseExistingSegment(observed.bytes, occurredAt);
            retainedBytes += observed.bytes.byteLength;
            segments.push({
                relativeName: entry.relativeName,
                filePath,
                occurredAt,
                identity: observed.identity,
                bytes: observed.bytes,
            });
        }
        this.#segments = segments.sort(compareSegments);
        this.#retainedBytes = retainedBytes;
        this.#currentSegmentName = "";
    }

    #createSegment(occurredAt: number, line: Uint8Array): void {
        const segmentId = this.#createSegmentId();
        if (!isSafeSegmentId(segmentId)) throw new TypeError("invalid operational segment id");
        const relativeName = `${SEGMENT_PREFIX}${occurredAt}-${segmentId}${SEGMENT_SUFFIX}`;
        const filePath = path.join(this.#ordinaryLogRoot, relativeName);
        const identity = this.#filesystem.durableCreateFile(filePath, line);
        this.#segments.push({
            relativeName,
            filePath,
            occurredAt,
            identity,
            bytes: new Uint8Array(line),
        });
        this.#segments.sort(compareSegments);
        this.#currentSegmentName = relativeName;
    }

    #replaceCurrentSegment(current: OperationalLogSegment, line: Uint8Array): void {
        const next = new Uint8Array(current.bytes.byteLength + line.byteLength);
        next.set(current.bytes);
        next.set(line, current.bytes.byteLength);
        const identity = this.#filesystem.durableReplaceFile(current.filePath, next);
        const index = this.#segments.indexOf(current);
        if (index < 0) throw new TypeError("current operational-log segment is no longer retained");
        this.#segments[index] = { ...current, identity, bytes: next };
    }

    #applyRetention(now: number, requiredBytes: number): boolean {
        const cutoff = retentionCutoff(now, this.#settings.retentionDays);
        let oldestSegment = this.#segments[0];
        while (oldestSegment !== undefined && oldestSegment.occurredAt < cutoff) {
            if (!this.#removeOldestSegment(oldestSegment)) return false;
            oldestSegment = this.#segments[0];
        }
        while (oldestSegment !== undefined && this.#retainedBytes + requiredBytes > this.#effectiveMaximumBytes()) {
            if (!this.#removeOldestSegment(oldestSegment)) return false;
            oldestSegment = this.#segments[0];
        }
        return true;
    }

    #removeOldestSegment(segment: OperationalLogSegment): boolean {
        try {
            if (!this.#filesystem.permanentlyRemoveRegularFileIfIdentity(segment.filePath, segment.identity)) {
                throw new TypeError("owned operational-log segment disappeared before permanent removal");
            }
            this.#segments.shift();
            this.#retainedBytes -= segment.bytes.byteLength;
            if (this.#currentSegmentName === segment.relativeName) this.#currentSegmentName = "";
            return true;
        } catch {
            this.#suspend("cleanup_failed");
            return false;
        }
    }

    #effectiveMaximumBytes(): number {
        return this.#maximumBytesOverride ?? this.#settings.maximumBytes;
    }

    #setConfiguredState(): void {
        this.#logState = this.#settings.enabled
            ? { state: "active", suspensionReason: "none" }
            : { state: "disabled", suspensionReason: "user_disabled" };
    }

    #suspend(reason: OperationalLogSuspensionReason): void {
        this.#logState = { state: "suspended", suspensionReason: reason };
        this.#currentSegmentName = "";
    }
}

class EphemeralOperationalDiagnostics implements OperationalDiagnostics {
    public record(_input: OperationalDiagnosticInput): void {
        // Internal tests that construct ProductionHostRuntime directly do not own a filesystem profile.
    }

    public health(state: HostLifecycleState, startupDisposition: HostStartupDisposition): ProtocolDiagnosticsHealthV1 {
        return {
            schemaVersion: 1,
            overallStatus: overallStatus(state, startupDisposition, "disabled"),
            host: { lifecycleState: state, startupMode: startupDisposition.mode },
            ordinaryLog: {
                state: "disabled",
                suspensionReason: "user_disabled",
                retainedBytes: 0,
                maximumBytes: DEFAULT_OPERATIONAL_LOG_MAXIMUM_BYTES,
                segmentCount: 0,
            },
        };
    }

    public settings(): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogSettingsV1> {
        return settingsUnavailable();
    }

    public replaceSettings(
        _input: ProtocolOrdinaryLogSettingsReplaceParamsV1,
    ): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogSettingsV1> {
        return settingsUnavailable();
    }

    public clearOrdinaryLog(): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogClearResultV1> {
        return settingsUnavailable();
    }

    public captureSupportLogSnapshot(_maximumBytes: number): OperationalSupportLogSnapshot {
        return {
            bytes: new Uint8Array(),
            retainedSegmentCount: 0,
            includedSegmentCount: 0,
            retainedBytes: 0,
            includedBytes: 0,
            truncated: false,
            locations: null,
        };
    }
}

/** @internal Only direct Host-runtime tests may omit a persistent OAAM profile. */
export function createEphemeralOperationalDiagnosticsForTest(): OperationalDiagnostics {
    return new EphemeralOperationalDiagnostics();
}
