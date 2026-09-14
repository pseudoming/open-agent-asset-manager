import type { ProductionHostLaunchOptions } from "@oaam/app-server-bootstrap";
import type {
    HostImportPreviewFileReference,
    HostLocalPathSelectionKind,
    HostObservedProjectRootReference,
    HostStartupDisposition,
} from "@oaam/app-server-host";
import {
    type DesktopOperationalDiagnosticCode,
    type DesktopSimpleOperationalDiagnosticCode,
    isDesktopSimpleOperationalDiagnosticCode,
    type ProtocolDesktopRendererDiagnosticInputV1,
    protocolDesktopRendererDiagnosticInputSchema,
} from "@oaam/app-server-protocol";

export type DesktopHostBootOptions = Pick<ProductionHostLaunchOptions, "oaamRoot" | "databasePath" | "platformContexts">;

export type DesktopHostControlCommand =
    | { readonly type: "boot"; readonly options: DesktopHostBootOptions }
    | { readonly type: "connect"; readonly connectionKey: string }
    | {
          readonly type: "register_local_path";
          readonly requestId: string;
          readonly connectionKey: string;
          readonly kind: HostLocalPathSelectionKind;
          readonly rootPath: string;
      }
    | {
          readonly type: "resolve_observed_project_root";
          readonly requestId: string;
          readonly connectionKey: string;
          readonly purpose: "registration" | "reveal";
          readonly reference: HostObservedProjectRootReference;
      }
    | {
          readonly type: "resolve_registered_project_root";
          readonly requestId: string;
          readonly connectionKey: string;
          readonly purpose: "probe" | "reveal";
          readonly projectId: string;
      }
    | {
          readonly type: "resolve_import_preview_file_directory";
          readonly requestId: string;
          readonly connectionKey: string;
          readonly reference: HostImportPreviewFileReference;
      }
    | {
          readonly type: "desktop_preferences_read_result";
          readonly requestId: string;
          readonly status: "complete";
          readonly bytes: Uint8Array;
      }
    | {
          readonly type: "desktop_preferences_read_result";
          readonly requestId: string;
          readonly status: "failed";
          readonly code: string;
      }
    | {
          readonly type: "desktop_preferences_restore_result";
          readonly requestId: string;
          readonly status: "complete";
      }
    | {
          readonly type: "desktop_preferences_restore_result";
          readonly requestId: string;
          readonly status: "failed";
          readonly code: string;
      }
    | {
          readonly type: "resolve_state_backup_file";
          readonly requestId: string;
          readonly backupId: string;
      }
    | {
          readonly type: "mutate_state_backup_file";
          readonly requestId: string;
          readonly backupId: string;
          readonly action: "identity_bound_trash" | "retire_missing";
          readonly userActionId: string;
      }
    | {
          readonly type: "record_operational_diagnostic";
          readonly code: DesktopSimpleOperationalDiagnosticCode;
      }
    | ({
          readonly type: "record_operational_diagnostic";
          readonly code: "desktop.renderer.event";
      } & ProtocolDesktopRendererDiagnosticInputV1)
    | { readonly type: "drain" }
    | { readonly type: "shutdown" };

export type DesktopHostFailurePhase = "control" | "startup" | "connection" | "shutdown";

export type DesktopHostControlEvent =
    | { readonly type: "ready"; readonly hostInstanceId: string; readonly startupDisposition: HostStartupDisposition }
    | { readonly type: "local_path_registered"; readonly requestId: string; readonly token: string }
    | { readonly type: "local_path_registration_failed"; readonly requestId: string; readonly code: string }
    | {
          readonly type: "observed_project_root_resolved";
          readonly requestId: string;
          readonly purpose: "registration" | "reveal";
          readonly rootPath: string;
          readonly localPathSelectionToken?: string;
      }
    | { readonly type: "observed_project_root_resolution_failed"; readonly requestId: string; readonly code: string }
    | {
          readonly type: "registered_project_root_resolved";
          readonly requestId: string;
          readonly purpose: "probe" | "reveal";
          readonly rootPath: string;
          readonly localPathSelectionToken?: string;
      }
    | { readonly type: "registered_project_root_resolution_failed"; readonly requestId: string; readonly code: string }
    | { readonly type: "import_preview_file_directory_resolved"; readonly requestId: string; readonly directoryPath: string }
    | { readonly type: "import_preview_file_directory_resolution_failed"; readonly requestId: string; readonly code: string }
    | { readonly type: "desktop_preferences_read_requested"; readonly requestId: string }
    | {
          readonly type: "desktop_preferences_restore_requested";
          readonly requestId: string;
          readonly bytes: Uint8Array;
          readonly restoreTransactionPath: string;
      }
    | {
          readonly type: "state_backup_file_resolved";
          readonly requestId: string;
          readonly archivePath: string;
      }
    | {
          readonly type: "state_backup_file_resolution_failed";
          readonly requestId: string;
          readonly code: string;
      }
    | {
          readonly type: "state_backup_file_mutation_complete";
          readonly requestId: string;
      }
    | {
          readonly type: "state_backup_file_mutation_failed";
          readonly requestId: string;
          readonly code: string;
      }
    | { readonly type: "restore_replacement_required" }
    | { readonly type: "drained" }
    | { readonly type: "stopped" }
    | {
          readonly type: "failure";
          readonly phase: DesktopHostFailurePhase;
          readonly code: DesktopOperationalDiagnosticCode;
      };

const COMMAND_TYPES = new Set([
    "boot",
    "connect",
    "register_local_path",
    "resolve_observed_project_root",
    "resolve_registered_project_root",
    "resolve_import_preview_file_directory",
    "desktop_preferences_read_result",
    "desktop_preferences_restore_result",
    "resolve_state_backup_file",
    "mutate_state_backup_file",
    "record_operational_diagnostic",
    "drain",
    "shutdown",
]);
const EVENT_TYPES = new Set([
    "ready",
    "local_path_registered",
    "local_path_registration_failed",
    "observed_project_root_resolved",
    "observed_project_root_resolution_failed",
    "registered_project_root_resolved",
    "registered_project_root_resolution_failed",
    "import_preview_file_directory_resolved",
    "import_preview_file_directory_resolution_failed",
    "desktop_preferences_read_requested",
    "desktop_preferences_restore_requested",
    "state_backup_file_resolved",
    "state_backup_file_resolution_failed",
    "state_backup_file_mutation_complete",
    "state_backup_file_mutation_failed",
    "restore_replacement_required",
    "drained",
    "stopped",
    "failure",
]);
const PLATFORMS = new Set(["win32", "darwin", "linux", "wsl"]);
const PATH_SELECTION_KINDS = new Set<HostLocalPathSelectionKind>([
    "project_root",
    "source_root",
    "installation_root",
    "backup_destination",
    "restore_archive",
    "asset_export_file",
    "asset_native_export_file",
    "support_bundle_file",
]);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAXIMUM_DESKTOP_PREFERENCES_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.trim() === value && !value.includes("\0");
}

function isDesktopPreferencesBytes(value: unknown): value is Uint8Array {
    return value instanceof Uint8Array && value.byteLength <= MAXIMUM_DESKTOP_PREFERENCES_BYTES;
}

function parseObservedProjectRootReference(value: unknown): HostObservedProjectRootReference {
    if (
        !isRecord(value) ||
        !hasExactKeys(value, ["probeResultRowId", "probeToken", "projectRowId", "sourceRootRowId"]) ||
        !isNonEmptyString(value.probeToken) ||
        !isNonEmptyString(value.probeResultRowId) ||
        !isNonEmptyString(value.projectRowId) ||
        !isNonEmptyString(value.sourceRootRowId)
    ) {
        throw new TypeError("invalid observed Project root reference");
    }
    return Object.freeze({
        probeToken: value.probeToken,
        probeResultRowId: value.probeResultRowId,
        projectRowId: value.projectRowId,
        sourceRootRowId: value.sourceRootRowId,
    });
}

function parseImportPreviewFileReference(value: unknown): HostImportPreviewFileReference {
    if (!isRecord(value)) throw new TypeError("invalid import-preview file reference");
    const keys =
        value.logicalPath === undefined ? ["candidateId", "previewToken"] : ["candidateId", "logicalPath", "previewToken"];
    if (
        !hasExactKeys(value, keys) ||
        !isNonEmptyString(value.previewToken) ||
        !isNonEmptyString(value.candidateId) ||
        (value.logicalPath !== undefined && !isNonEmptyString(value.logicalPath))
    ) {
        throw new TypeError("invalid import-preview file reference");
    }
    return Object.freeze({
        previewToken: value.previewToken,
        candidateId: value.candidateId,
        ...(value.logicalPath === undefined ? {} : { logicalPath: value.logicalPath }),
    });
}

function parseHostStartupDisposition(value: unknown): HostStartupDisposition {
    if (isRecord(value) && hasExactKeys(value, ["mode"]) && value.mode === "normal") {
        return Object.freeze({ mode: "normal" });
    }
    if (
        isRecord(value) &&
        hasExactKeys(value, ["mode", "reason"]) &&
        value.mode === "state_recovery" &&
        (value.reason === "missing_database" ||
            value.reason === "corrupt_database" ||
            value.reason === "incompatible_database" ||
            value.reason === "restore_reconciliation")
    ) {
        return Object.freeze({ mode: "state_recovery", reason: value.reason });
    }
    throw new TypeError("invalid Desktop Host startup disposition");
}

function isLaunchOptions(value: unknown): value is DesktopHostBootOptions {
    if (!isRecord(value)) return false;
    const keys =
        value.databasePath === undefined ? ["oaamRoot", "platformContexts"] : ["databasePath", "oaamRoot", "platformContexts"];
    if (!hasExactKeys(value, keys) || !isNonEmptyString(value.oaamRoot)) return false;
    if (value.databasePath !== undefined && !isNonEmptyString(value.databasePath)) return false;
    if (!Array.isArray(value.platformContexts) || value.platformContexts.length === 0) return false;
    return value.platformContexts.every(
        (context) =>
            isRecord(context) &&
            hasExactKeys(context, ["accessRootPath", "platform", "platformInstanceId"]) &&
            typeof context.platform === "string" &&
            PLATFORMS.has(context.platform) &&
            isNonEmptyString(context.platformInstanceId) &&
            isNonEmptyString(context.accessRootPath),
    );
}

export function parseDesktopHostControlCommand(value: unknown): DesktopHostControlCommand {
    if (!isRecord(value) || typeof value.type !== "string" || !COMMAND_TYPES.has(value.type)) {
        throw new TypeError("invalid Desktop Host control command");
    }
    if (value.type === "boot") {
        if (!hasExactKeys(value, ["options", "type"]) || !isLaunchOptions(value.options)) {
            throw new TypeError("invalid Desktop Host boot command");
        }
        return Object.freeze({
            type: "boot",
            options: Object.freeze({
                oaamRoot: value.options.oaamRoot,
                ...(value.options.databasePath === undefined ? {} : { databasePath: value.options.databasePath }),
                platformContexts: Object.freeze(
                    value.options.platformContexts.map((context) =>
                        Object.freeze({
                            platform: context.platform,
                            platformInstanceId: context.platformInstanceId,
                            accessRootPath: context.accessRootPath,
                        }),
                    ),
                ),
            }),
        });
    }
    if (value.type === "connect") {
        if (!hasExactKeys(value, ["connectionKey", "type"]) || !isNonEmptyString(value.connectionKey)) {
            throw new TypeError("invalid Desktop Host connect command");
        }
        return Object.freeze({ type: "connect", connectionKey: value.connectionKey });
    }
    if (value.type === "register_local_path") {
        if (
            !hasExactKeys(value, ["connectionKey", "kind", "requestId", "rootPath", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.connectionKey) ||
            typeof value.kind !== "string" ||
            !PATH_SELECTION_KINDS.has(value.kind as HostLocalPathSelectionKind) ||
            !isNonEmptyString(value.rootPath)
        ) {
            throw new TypeError("invalid Desktop Host local-path registration command");
        }
        return Object.freeze({
            type: "register_local_path",
            requestId: value.requestId,
            connectionKey: value.connectionKey,
            kind: value.kind as HostLocalPathSelectionKind,
            rootPath: value.rootPath,
        });
    }
    if (value.type === "resolve_observed_project_root") {
        if (
            !hasExactKeys(value, ["connectionKey", "purpose", "reference", "requestId", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.connectionKey) ||
            (value.purpose !== "registration" && value.purpose !== "reveal")
        ) {
            throw new TypeError("invalid observed Project root resolution command");
        }
        return Object.freeze({
            type: "resolve_observed_project_root",
            requestId: value.requestId,
            connectionKey: value.connectionKey,
            purpose: value.purpose,
            reference: parseObservedProjectRootReference(value.reference),
        });
    }
    if (value.type === "resolve_registered_project_root") {
        if (
            !hasExactKeys(value, ["connectionKey", "projectId", "purpose", "requestId", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.connectionKey) ||
            !isNonEmptyString(value.projectId) ||
            !UUID_V4_PATTERN.test(value.projectId) ||
            (value.purpose !== "probe" && value.purpose !== "reveal")
        ) {
            throw new TypeError("invalid registered Project root resolution command");
        }
        return Object.freeze({
            type: "resolve_registered_project_root",
            requestId: value.requestId,
            connectionKey: value.connectionKey,
            purpose: value.purpose,
            projectId: value.projectId,
        });
    }
    if (value.type === "resolve_import_preview_file_directory") {
        if (
            !hasExactKeys(value, ["connectionKey", "reference", "requestId", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.connectionKey)
        ) {
            throw new TypeError("invalid import-preview file-directory resolution command");
        }
        return Object.freeze({
            type: "resolve_import_preview_file_directory",
            requestId: value.requestId,
            connectionKey: value.connectionKey,
            reference: parseImportPreviewFileReference(value.reference),
        });
    }
    if (value.type === "desktop_preferences_read_result") {
        if (
            value.status === "complete" &&
            hasExactKeys(value, ["bytes", "requestId", "status", "type"]) &&
            isNonEmptyString(value.requestId) &&
            isDesktopPreferencesBytes(value.bytes)
        ) {
            return Object.freeze({
                type: "desktop_preferences_read_result",
                requestId: value.requestId,
                status: "complete",
                bytes: new Uint8Array(value.bytes),
            });
        }
        if (
            value.status === "failed" &&
            hasExactKeys(value, ["code", "requestId", "status", "type"]) &&
            isNonEmptyString(value.requestId) &&
            isNonEmptyString(value.code)
        ) {
            return Object.freeze({
                type: "desktop_preferences_read_result",
                requestId: value.requestId,
                status: "failed",
                code: value.code,
            });
        }
        throw new TypeError("invalid Desktop preference read result");
    }
    if (value.type === "desktop_preferences_restore_result") {
        if (
            value.status === "complete" &&
            hasExactKeys(value, ["requestId", "status", "type"]) &&
            isNonEmptyString(value.requestId)
        ) {
            return Object.freeze({
                type: "desktop_preferences_restore_result",
                requestId: value.requestId,
                status: "complete",
            });
        }
        if (
            value.status === "failed" &&
            hasExactKeys(value, ["code", "requestId", "status", "type"]) &&
            isNonEmptyString(value.requestId) &&
            isNonEmptyString(value.code)
        ) {
            return Object.freeze({
                type: "desktop_preferences_restore_result",
                requestId: value.requestId,
                status: "failed",
                code: value.code,
            });
        }
        throw new TypeError("invalid Desktop preference restore result");
    }
    if (value.type === "resolve_state_backup_file") {
        if (
            !hasExactKeys(value, ["backupId", "requestId", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            typeof value.backupId !== "string" ||
            !UUID_V4_PATTERN.test(value.backupId)
        ) {
            throw new TypeError("invalid State backup file resolution command");
        }
        return Object.freeze({
            type: "resolve_state_backup_file",
            requestId: value.requestId,
            backupId: value.backupId,
        });
    }
    if (value.type === "mutate_state_backup_file") {
        if (
            !hasExactKeys(value, ["action", "backupId", "requestId", "type", "userActionId"]) ||
            !isNonEmptyString(value.requestId) ||
            typeof value.backupId !== "string" ||
            !UUID_V4_PATTERN.test(value.backupId) ||
            (value.action !== "identity_bound_trash" && value.action !== "retire_missing") ||
            !isNonEmptyString(value.userActionId)
        ) {
            throw new TypeError("invalid State backup file mutation command");
        }
        return Object.freeze({
            type: "mutate_state_backup_file",
            requestId: value.requestId,
            backupId: value.backupId,
            action: value.action,
            userActionId: value.userActionId,
        });
    }
    if (value.type === "record_operational_diagnostic") {
        if (value.code === "desktop.renderer.event") {
            if (!hasExactKeys(value, ["code", "componentTrail", "event", "failureKind", "surface", "type"])) {
                throw new TypeError("invalid Desktop Renderer operational diagnostic command");
            }
            const renderer = protocolDesktopRendererDiagnosticInputSchema.parse({
                event: value.event,
                failureKind: value.failureKind,
                surface: value.surface,
                componentTrail: value.componentTrail,
            });
            return Object.freeze({ type: "record_operational_diagnostic", code: value.code, ...renderer });
        }
        if (!hasExactKeys(value, ["code", "type"]) || !isDesktopSimpleOperationalDiagnosticCode(value.code)) {
            throw new TypeError("invalid Desktop operational diagnostic command");
        }
        return Object.freeze({ type: "record_operational_diagnostic", code: value.code });
    }
    if (!hasExactKeys(value, ["type"])) throw new TypeError("Desktop Host control command contains extra fields");
    if (value.type === "drain") return Object.freeze({ type: "drain" });
    return Object.freeze({ type: "shutdown" });
}

export function parseDesktopHostControlEvent(value: unknown): DesktopHostControlEvent {
    if (!isRecord(value) || typeof value.type !== "string" || !EVENT_TYPES.has(value.type)) {
        throw new TypeError("invalid Desktop Host control event");
    }
    if (value.type === "ready") {
        if (!hasExactKeys(value, ["hostInstanceId", "startupDisposition", "type"]) || !isNonEmptyString(value.hostInstanceId)) {
            throw new TypeError("invalid Desktop Host ready event");
        }
        return Object.freeze({
            type: "ready",
            hostInstanceId: value.hostInstanceId,
            startupDisposition: parseHostStartupDisposition(value.startupDisposition),
        });
    }
    if (value.type === "failure") {
        if (
            !hasExactKeys(value, ["code", "phase", "type"]) ||
            !["control", "startup", "connection", "shutdown"].includes(String(value.phase)) ||
            !isDesktopSimpleOperationalDiagnosticCode(value.code)
        ) {
            throw new TypeError("invalid Desktop Host failure event");
        }
        return Object.freeze({
            type: "failure",
            phase: value.phase as DesktopHostFailurePhase,
            code: value.code,
        });
    }
    if (value.type === "local_path_registered") {
        if (
            !hasExactKeys(value, ["requestId", "token", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.token)
        ) {
            throw new TypeError("invalid Desktop Host local-path registration result");
        }
        return Object.freeze({
            type: "local_path_registered",
            requestId: value.requestId,
            token: value.token,
        });
    }
    if (value.type === "local_path_registration_failed") {
        if (
            !hasExactKeys(value, ["code", "requestId", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.code)
        ) {
            throw new TypeError("invalid Desktop Host local-path registration failure");
        }
        return Object.freeze({
            type: "local_path_registration_failed",
            requestId: value.requestId,
            code: value.code,
        });
    }
    if (value.type === "observed_project_root_resolved") {
        const expectedKeys =
            value.purpose === "registration"
                ? ["localPathSelectionToken", "purpose", "requestId", "rootPath", "type"]
                : ["purpose", "requestId", "rootPath", "type"];
        if (
            !hasExactKeys(value, expectedKeys) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.rootPath) ||
            (value.purpose !== "registration" && value.purpose !== "reveal") ||
            (value.purpose === "registration" && !isNonEmptyString(value.localPathSelectionToken))
        ) {
            throw new TypeError("invalid observed Project root resolution");
        }
        return Object.freeze({
            type: "observed_project_root_resolved",
            requestId: value.requestId,
            purpose: value.purpose,
            rootPath: value.rootPath,
            ...(value.purpose === "registration" ? { localPathSelectionToken: value.localPathSelectionToken as string } : {}),
        });
    }
    if (value.type === "observed_project_root_resolution_failed") {
        if (
            !hasExactKeys(value, ["code", "requestId", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.code)
        ) {
            throw new TypeError("invalid observed Project root resolution failure");
        }
        return Object.freeze({
            type: "observed_project_root_resolution_failed",
            requestId: value.requestId,
            code: value.code,
        });
    }
    if (value.type === "registered_project_root_resolved") {
        const expectedKeys =
            value.purpose === "probe"
                ? ["localPathSelectionToken", "purpose", "requestId", "rootPath", "type"]
                : ["purpose", "requestId", "rootPath", "type"];
        if (
            !hasExactKeys(value, expectedKeys) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.rootPath) ||
            (value.purpose !== "probe" && value.purpose !== "reveal") ||
            (value.purpose === "probe" && !isNonEmptyString(value.localPathSelectionToken))
        ) {
            throw new TypeError("invalid registered Project root resolution");
        }
        return Object.freeze({
            type: "registered_project_root_resolved",
            requestId: value.requestId,
            purpose: value.purpose,
            rootPath: value.rootPath,
            ...(value.purpose === "probe" ? { localPathSelectionToken: value.localPathSelectionToken as string } : {}),
        });
    }
    if (value.type === "registered_project_root_resolution_failed") {
        if (
            !hasExactKeys(value, ["code", "requestId", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.code)
        ) {
            throw new TypeError("invalid registered Project root resolution failure");
        }
        return Object.freeze({
            type: "registered_project_root_resolution_failed",
            requestId: value.requestId,
            code: value.code,
        });
    }
    if (value.type === "import_preview_file_directory_resolved") {
        if (
            !hasExactKeys(value, ["directoryPath", "requestId", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.directoryPath)
        ) {
            throw new TypeError("invalid import-preview file-directory resolution");
        }
        return Object.freeze({
            type: "import_preview_file_directory_resolved",
            requestId: value.requestId,
            directoryPath: value.directoryPath,
        });
    }
    if (value.type === "import_preview_file_directory_resolution_failed") {
        if (
            !hasExactKeys(value, ["code", "requestId", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.code)
        ) {
            throw new TypeError("invalid import-preview file-directory resolution failure");
        }
        return Object.freeze({
            type: "import_preview_file_directory_resolution_failed",
            requestId: value.requestId,
            code: value.code,
        });
    }
    if (value.type === "desktop_preferences_read_requested") {
        if (!hasExactKeys(value, ["requestId", "type"]) || !isNonEmptyString(value.requestId)) {
            throw new TypeError("invalid Desktop preference read request");
        }
        return Object.freeze({ type: "desktop_preferences_read_requested", requestId: value.requestId });
    }
    if (value.type === "desktop_preferences_restore_requested") {
        if (
            !hasExactKeys(value, ["bytes", "requestId", "restoreTransactionPath", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            !isDesktopPreferencesBytes(value.bytes) ||
            !isNonEmptyString(value.restoreTransactionPath)
        ) {
            throw new TypeError("invalid Desktop preference restore request");
        }
        return Object.freeze({
            type: "desktop_preferences_restore_requested",
            requestId: value.requestId,
            bytes: new Uint8Array(value.bytes),
            restoreTransactionPath: value.restoreTransactionPath,
        });
    }
    if (value.type === "state_backup_file_resolved") {
        if (
            !hasExactKeys(value, ["archivePath", "requestId", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.archivePath)
        ) {
            throw new TypeError("invalid State backup file resolution");
        }
        return Object.freeze({
            type: "state_backup_file_resolved",
            requestId: value.requestId,
            archivePath: value.archivePath,
        });
    }
    if (value.type === "state_backup_file_resolution_failed") {
        if (
            !hasExactKeys(value, ["code", "requestId", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.code)
        ) {
            throw new TypeError("invalid State backup file resolution failure");
        }
        return Object.freeze({
            type: "state_backup_file_resolution_failed",
            requestId: value.requestId,
            code: value.code,
        });
    }
    if (value.type === "state_backup_file_mutation_complete") {
        if (!hasExactKeys(value, ["requestId", "type"]) || !isNonEmptyString(value.requestId)) {
            throw new TypeError("invalid State backup file mutation completion");
        }
        return Object.freeze({
            type: "state_backup_file_mutation_complete",
            requestId: value.requestId,
        });
    }
    if (value.type === "state_backup_file_mutation_failed") {
        if (
            !hasExactKeys(value, ["code", "requestId", "type"]) ||
            !isNonEmptyString(value.requestId) ||
            !isNonEmptyString(value.code)
        ) {
            throw new TypeError("invalid State backup file mutation failure");
        }
        return Object.freeze({
            type: "state_backup_file_mutation_failed",
            requestId: value.requestId,
            code: value.code,
        });
    }
    if (!hasExactKeys(value, ["type"])) throw new TypeError("Desktop Host control event contains extra fields");
    if (value.type === "restore_replacement_required") {
        return Object.freeze({ type: "restore_replacement_required" });
    }
    if (value.type === "drained") return Object.freeze({ type: "drained" });
    return Object.freeze({ type: "stopped" });
}
