import { type DesktopOperationalDiagnosticCode, isDesktopOperationalDiagnosticCode } from "@oaam/app-server-protocol";
import type {
    DesktopAssetLayoutPreference,
    DesktopPresentationPreferenceInput,
    DesktopPresentationSnapshot,
} from "../presentation/presentation-preferences";
import type {
    DesktopDataLocationAction,
    DesktopDataLocationActionResult,
    DesktopDataLocationId,
    DesktopInterfaceCacheClearResult,
    DesktopInterfaceDefaultsRestoreResult,
    DesktopMaintenanceSnapshot,
    DesktopPerformanceRecordingSaveResult,
    DesktopPerformanceRecordingSnapshot,
    SupportBundleExportPickerResult,
} from "./desktop-local-operations";
import type { DesktopRendererDiagnosticInput } from "./desktop-renderer-diagnostics";
import type { DesktopImportPreviewFileReference, ImportPreviewFileRevealResult } from "./import-preview-file";
import {
    type InstallationRootPickerResult,
    parseProjectRootPickerResult,
    type ProjectRootPickerResult,
    type SourceRootPickerResult,
} from "./native-path-picker";
import type {
    DesktopObservedProjectRootReference,
    ObservedProjectRootAuthorizationResult,
    ObservedProjectRootRevealResult,
    RegisteredProjectRootAuthorizationResult,
    RegisteredProjectRootRevealResult,
} from "./observed-project-root";

export * from "./desktop-local-operations";
export * from "./import-preview-file";
export * from "./native-path-picker";
export * from "./observed-project-root";
export * from "./packaged-diagnostics-proof";
export * from "./packaged-opencode-project-proof";

export const PROTOCOL_PORT_CHANNEL = "oaam:desktop-protocol-port";
export const PROTOCOL_PORT_SIGNAL = "oaam:desktop-protocol-port-ready";
export const PACKAGED_ONBOARDING_PROOF_PORT_CHANNEL = "oaam:desktop-packaged-onboarding-proof-port";
export const PACKAGED_ONBOARDING_PROOF_PORT_SIGNAL = "oaam:desktop-packaged-onboarding-proof-port-ready";
export const PACKAGED_ZCODE_TARGET_PROOF_PORT_CHANNEL = "oaam:desktop-packaged-zcode-target-proof-port";
export const PACKAGED_ZCODE_TARGET_PROOF_PORT_SIGNAL = "oaam:desktop-packaged-zcode-target-proof-port-ready";
export function packagedZcodeTargetProtocolPortCount(mode: PackagedZcodeTargetProofMode): 1 | 4 {
    return mode === "deploy" ? 4 : 1;
}

export function packagedZcodeTargetTransferPortCount(mode: PackagedZcodeTargetProofMode): 2 | 5 {
    return mode === "deploy" ? 5 : 2;
}
export const PACKAGED_STATE_RESILIENCE_PROOF_PORT_CHANNEL = "oaam:desktop-packaged-state-resilience-proof-port";
export const PACKAGED_STATE_RESILIENCE_PROOF_PORT_SIGNAL = "oaam:desktop-packaged-state-resilience-proof-port-ready";
export const PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_CHANNEL = "oaam:desktop-packaged-project-lifecycle-proof-port";
export const PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_SIGNAL = "oaam:desktop-packaged-project-lifecycle-proof-port-ready";
export const PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_CHANNEL = "oaam:desktop-packaged-asset-lifecycle-proof-port";
export const PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_SIGNAL = "oaam:desktop-packaged-asset-lifecycle-proof-port-ready";
export const HOST_RETRY_CHANNEL = "oaam:desktop-host-retry";
export const HOST_STARTUP_GET_CHANNEL = "oaam:desktop-host-startup-get";
export const HOST_STARTUP_CHANGED_CHANNEL = "oaam:desktop-host-startup-changed";
export const PROJECT_ROOT_PICK_CHANNEL = "oaam:desktop-project-root-pick";
export const SOURCE_ROOT_PICK_CHANNEL = "oaam:desktop-source-root-pick";
export const INSTALLATION_ROOT_PICK_CHANNEL = "oaam:desktop-installation-root-pick";
export const STATE_BACKUP_DESTINATION_PICK_CHANNEL = "oaam:desktop-state-backup-destination-pick";
export const STATE_BACKUP_REMEMBERED_DESTINATION_CHANNEL = "oaam:desktop-state-backup-remembered-destination";
export const STATE_RESTORE_ARCHIVE_PICK_CHANNEL = "oaam:desktop-state-restore-archive-pick";
export const ASSET_VERSION_EXPORT_PICK_CHANNEL = "oaam:desktop-asset-version-export-pick";
export const STATE_RESILIENCE_PREFERENCES_GET_CHANNEL = "oaam:desktop-state-resilience-preferences-get";
export const STATE_BACKUP_DESTINATION_REMEMBER_CHANNEL = "oaam:desktop-state-backup-destination-remember";
export const STATE_BACKUP_FILE_ACTION_CHANNEL = "oaam:desktop-state-backup-file-action";
export const PRESENTATION_GET_CHANNEL = "oaam:desktop-presentation-get";
export const PRESENTATION_REPLACE_CHANNEL = "oaam:desktop-presentation-replace";
export const LAST_PROJECT_REPLACE_CHANNEL = "oaam:desktop-last-project-replace";
export const ASSET_LAYOUT_REPLACE_CHANNEL = "oaam:desktop-asset-layout-replace";
export const ONBOARDING_COMPLETE_CHANNEL = "oaam:desktop-onboarding-complete";
export const PRESENTATION_CHANGED_CHANNEL = "oaam:desktop-presentation-changed";
export const WINDOW_ACTION_CHANNEL = "oaam:desktop-window-action";
export const APP_IDENTITY_GET_CHANNEL = "oaam:desktop-app-identity-get";

export type DesktopWindowAction =
    | "quit"
    | "hide_to_tray"
    | "reload_interface"
    | "undo"
    | "redo"
    | "cut"
    | "copy"
    | "paste"
    | "delete"
    | "select_all"
    | "zoom_in"
    | "zoom_out"
    | "zoom_reset"
    | "toggle_full_screen";

const DESKTOP_WINDOW_ACTIONS: ReadonlySet<string> = new Set<DesktopWindowAction>([
    "quit",
    "hide_to_tray",
    "reload_interface",
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "delete",
    "select_all",
    "zoom_in",
    "zoom_out",
    "zoom_reset",
    "toggle_full_screen",
]);

export interface DesktopAppIdentity {
    readonly name: string;
    readonly version: string;
}

export type StateBackupDestinationPickerResult =
    | { readonly status: "cancelled" | "unavailable" }
    | {
          readonly status: "selected";
          readonly displayPath: string;
          readonly localPathSelectionToken: string;
      };

export type StateRestoreArchivePickerResult = ProjectRootPickerResult;
export type AssetVersionExportPickerResult = ProjectRootPickerResult;
export type AssetVersionExportKind = "native_files" | "oaam_version_package";
export type DesktopStateBackupFileAction = "reveal" | "trash" | "copy_path";

export type DesktopStateBackupFileActionResult =
    | { readonly status: "complete" }
    | {
          readonly status: "failed";
          readonly code: "unavailable" | "reveal_failed" | "trash_failed" | "copy_failed";
      };

export interface DesktopStateResiliencePreferencesV1 {
    readonly schemaVersion: 1;
    readonly lastCustomBackupDirectory?: string;
}

export type DesktopHostStartupSnapshot =
    | { readonly status: "starting" }
    | { readonly status: "recovering"; readonly reasonCode: DesktopOperationalDiagnosticCode }
    | { readonly status: "ready" }
    | {
          readonly status: "ready";
          readonly recoveryReason: "missing_database" | "corrupt_database" | "incompatible_database" | "restore_reconciliation";
      }
    | { readonly status: "failed"; readonly reasonCode: DesktopOperationalDiagnosticCode };

export type PackagedOnboardingProofStep =
    | "initialize"
    | "empty_catalog"
    | "provider_inventory"
    | "enablement_read"
    | "enablement_replace"
    | "environment_list"
    | "desktop_environment"
    | "probe"
    | "config_source"
    | "source_read"
    | "import_preview"
    | "import_candidate"
    | "import_accept"
    | "final_catalog"
    | "library_projection"
    | "client_listener"
    | "unexpected";

const PACKAGED_ONBOARDING_PROOF_STEPS: ReadonlySet<string> = new Set<PackagedOnboardingProofStep>([
    "initialize",
    "empty_catalog",
    "provider_inventory",
    "enablement_read",
    "enablement_replace",
    "environment_list",
    "desktop_environment",
    "probe",
    "config_source",
    "source_read",
    "import_preview",
    "import_candidate",
    "import_accept",
    "final_catalog",
    "library_projection",
    "client_listener",
    "unexpected",
]);

export type PackagedOnboardingProofReply =
    | { readonly status: "complete" }
    | {
          readonly status: "failed";
          readonly step: PackagedOnboardingProofStep;
          readonly diagnosticCodes: readonly string[];
      };

export type PackagedZcodeTargetProofMode = "deploy" | "reverse";
export type PackagedZcodeTargetAssetKind = "Guidance" | "Workflow" | "Skill" | "Subagent" | "Memory";

export interface PackagedProofSubjectIdentity {
    readonly projectId: string;
    readonly assetId: string;
    readonly versionId: string;
    readonly deploymentId: string;
}

export interface PackagedZcodeTargetFixtureSubjects {
    readonly assetKind: PackagedZcodeTargetAssetKind;
    readonly source: {
        readonly projectId: string;
        readonly assetId: string;
        readonly versionId: string;
    };
    readonly target: PackagedProofSubjectIdentity;
}

export type PackagedZcodeTargetProofRequest =
    | {
          readonly mode: "deploy";
          readonly assetKind: PackagedZcodeTargetAssetKind;
          readonly sourceProjectRegistrationToken: string;
          readonly sourceProjectToken: string;
          readonly targetProjectRegistrationToken: string;
          readonly targetProjectToken: string;
      }
    | {
          readonly mode: "reverse";
          readonly assetKind: PackagedZcodeTargetAssetKind;
          readonly subject: PackagedProofSubjectIdentity;
      };

export type PackagedZcodeTargetProofStep =
    | "initialize"
    | "empty_state"
    | "provider_inventory"
    | "enablement"
    | "environment"
    | "source_project"
    | "target_project"
    | "source_probe"
    | "source_read"
    | "import_accept"
    | "source_version"
    | "asset_copy"
    | "promotion_grant"
    | "target_probe"
    | "deployment_create"
    | "render_analyze"
    | "render_preview"
    | "deploy"
    | "inspection"
    | "library_projection"
    | "deployment_projection"
    | "stale_reverse"
    | "reverse_prepare"
    | "reverse_commit"
    | "reverse_recover"
    | "final_state"
    | "client_listener"
    | "unexpected";

export type PackagedZcodeTargetProofReply =
    | { readonly status: "complete"; readonly subjects?: PackagedZcodeTargetFixtureSubjects }
    | { readonly status: "complete"; readonly subject: PackagedProofSubjectIdentity }
    | {
          readonly status: "failed";
          readonly step: PackagedZcodeTargetProofStep;
          readonly diagnosticCodes: readonly string[];
      };

const PACKAGED_ZCODE_TARGET_PROOF_STEPS: ReadonlySet<string> = new Set<PackagedZcodeTargetProofStep>([
    "initialize",
    "empty_state",
    "provider_inventory",
    "enablement",
    "environment",
    "source_project",
    "target_project",
    "source_probe",
    "source_read",
    "import_accept",
    "source_version",
    "asset_copy",
    "promotion_grant",
    "target_probe",
    "deployment_create",
    "render_analyze",
    "render_preview",
    "deploy",
    "inspection",
    "library_projection",
    "deployment_projection",
    "stale_reverse",
    "reverse_prepare",
    "reverse_commit",
    "reverse_recover",
    "final_state",
    "client_listener",
    "unexpected",
]);

export type PackagedStateResilienceProofMode = "backup" | "restore" | "reopen" | "trash";

export type PackagedStateResilienceProofRequest =
    | {
          readonly mode: "backup" | "reopen" | "trash";
          readonly subject: PackagedProofSubjectIdentity;
      }
    | {
          readonly mode: "restore";
          readonly wrongPasswordArchiveToken: string;
          readonly archiveToken: string;
      };

export type PackagedStateResilienceProofStep =
    | "initialize"
    | "available_operations"
    | "nonempty_state"
    | "backup_inspect"
    | "backup_create"
    | "backup_inventory"
    | "restore_wrong_password"
    | "restore_inspect"
    | "restore_activate"
    | "reopen_state"
    | "trash_backup_create"
    | "trash_action"
    | "trash_inventory"
    | "client_listener"
    | "unexpected";

const PACKAGED_STATE_RESILIENCE_PROOF_STEPS: ReadonlySet<string> = new Set<PackagedStateResilienceProofStep>([
    "initialize",
    "available_operations",
    "nonempty_state",
    "backup_inspect",
    "backup_create",
    "backup_inventory",
    "restore_wrong_password",
    "restore_inspect",
    "restore_activate",
    "reopen_state",
    "trash_backup_create",
    "trash_action",
    "trash_inventory",
    "client_listener",
    "unexpected",
]);

export type PackagedStateResilienceProofReply =
    | { readonly status: "complete" }
    | {
          readonly status: "failed";
          readonly step: PackagedStateResilienceProofStep;
          readonly diagnosticCodes: readonly string[];
      };

export interface PackagedProjectLifecycleProofRequest {
    readonly rebindRootToken: string;
    readonly subject: PackagedProofSubjectIdentity;
}

export type PackagedProjectLifecycleProofStep =
    | "initialize"
    | "available_operations"
    | "initial_state"
    | "rename_inspect"
    | "rename_commit"
    | "rebind_backup"
    | "rebind_inspect"
    | "rebind_commit"
    | "stop_backup"
    | "stop_inspect"
    | "stop_commit"
    | "retained_state"
    | "restore_inspect"
    | "restore_commit"
    | "final_state"
    | "client_listener"
    | "unexpected";

const PACKAGED_PROJECT_LIFECYCLE_PROOF_STEPS: ReadonlySet<string> = new Set<PackagedProjectLifecycleProofStep>([
    "initialize",
    "available_operations",
    "initial_state",
    "rename_inspect",
    "rename_commit",
    "rebind_backup",
    "rebind_inspect",
    "rebind_commit",
    "stop_backup",
    "stop_inspect",
    "stop_commit",
    "retained_state",
    "restore_inspect",
    "restore_commit",
    "final_state",
    "client_listener",
    "unexpected",
]);

export type PackagedProjectLifecycleProofReply =
    | { readonly status: "complete" }
    | {
          readonly status: "failed";
          readonly step: PackagedProjectLifecycleProofStep;
          readonly diagnosticCodes: readonly string[];
      };

export interface PackagedAssetLifecycleProofRequest {
    readonly exportToken: string;
    readonly subject: PackagedProofSubjectIdentity;
}

export type PackagedAssetLifecycleProofControlRequest = {
    readonly control: "request_existing_export_token";
};

export type PackagedAssetLifecycleProofControlReply = {
    readonly control: "existing_export_token";
    readonly existingExportToken: string;
};

export type PackagedAssetLifecycleProofStep =
    | "initialize"
    | "available_operations"
    | "initial_state"
    | "stale_copy"
    | "create_copies"
    | "catalog_counts"
    | "catalog_page_one"
    | "catalog_page_two"
    | "versions"
    | "file_graph"
    | "large_preview"
    | "progressive_text"
    | "compare"
    | "export"
    | "export_existing"
    | "delete"
    | "restore"
    | "backup"
    | "purge_inspect"
    | "purge_stale"
    | "purge_commit"
    | "final_state"
    | "client_listener"
    | "unexpected";

const PACKAGED_ASSET_LIFECYCLE_PROOF_STEPS: ReadonlySet<string> = new Set<PackagedAssetLifecycleProofStep>([
    "initialize",
    "available_operations",
    "initial_state",
    "stale_copy",
    "create_copies",
    "catalog_counts",
    "catalog_page_one",
    "catalog_page_two",
    "versions",
    "file_graph",
    "large_preview",
    "progressive_text",
    "compare",
    "export",
    "export_existing",
    "delete",
    "restore",
    "backup",
    "purge_inspect",
    "purge_stale",
    "purge_commit",
    "final_state",
    "client_listener",
    "unexpected",
]);

export type PackagedAssetLifecycleProofReply =
    | { readonly status: "complete" }
    | {
          readonly status: "failed";
          readonly step: PackagedAssetLifecycleProofStep;
          readonly diagnosticCodes: readonly string[];
      };

export interface OaamDesktopBridge {
    readonly initialAppIdentity: DesktopAppIdentity;
    readonly initialHostStartup: DesktopHostStartupSnapshot;
    readonly initialPresentation: DesktopPresentationSnapshot;
    retrySession(): Promise<void>;
    pickProjectRoot(suggestedRootPath?: string): Promise<ProjectRootPickerResult>;
    authorizeObservedProjectRoot(reference: DesktopObservedProjectRootReference): Promise<ObservedProjectRootAuthorizationResult>;
    revealObservedProjectRoot(reference: DesktopObservedProjectRootReference): Promise<ObservedProjectRootRevealResult>;
    authorizeRegisteredProjectRoot(projectId: string): Promise<RegisteredProjectRootAuthorizationResult>;
    revealRegisteredProjectRoot(projectId: string): Promise<RegisteredProjectRootRevealResult>;
    revealImportPreviewFile(reference: DesktopImportPreviewFileReference): Promise<ImportPreviewFileRevealResult>;
    pickSourceRoot(): Promise<SourceRootPickerResult>;
    pickInstallationRoot(): Promise<InstallationRootPickerResult>;
    pickStateBackupDestination(): Promise<StateBackupDestinationPickerResult>;
    selectRememberedStateBackupDestination(): Promise<StateBackupDestinationPickerResult>;
    pickStateRestoreArchive(): Promise<StateRestoreArchivePickerResult>;
    pickAssetVersionExport(
        exportKind: AssetVersionExportKind,
        suggestedFileName: string,
    ): Promise<AssetVersionExportPickerResult>;
    pickSupportBundleExport(suggestedFileName: string): Promise<SupportBundleExportPickerResult>;
    getStateResiliencePreferences(): Promise<DesktopStateResiliencePreferencesV1>;
    rememberStateBackupDestination(backupId: string): Promise<DesktopStateResiliencePreferencesV1>;
    performStateBackupFileAction(
        backupId: string,
        action: DesktopStateBackupFileAction,
    ): Promise<DesktopStateBackupFileActionResult>;
    completeOnboarding(): Promise<DesktopPresentationSnapshot>;
    replacePresentationPreferences(input: DesktopPresentationPreferenceInput): Promise<DesktopPresentationSnapshot>;
    rememberLastProject(projectId: string): Promise<DesktopPresentationSnapshot>;
    replaceAssetLayout(assetLayout: DesktopAssetLayoutPreference): Promise<DesktopPresentationSnapshot>;
    performWindowAction(action: DesktopWindowAction): Promise<void>;
    recordRendererDiagnostic(input: DesktopRendererDiagnosticInput): Promise<void>;
    getDesktopMaintenance(): Promise<DesktopMaintenanceSnapshot>;
    clearDesktopInterfaceCache(): Promise<DesktopInterfaceCacheClearResult>;
    performDesktopDataLocationAction(
        locationId: DesktopDataLocationId,
        action: DesktopDataLocationAction,
    ): Promise<DesktopDataLocationActionResult>;
    restoreDesktopInterfaceDefaults(): Promise<DesktopInterfaceDefaultsRestoreResult>;
    getDesktopPerformanceRecording(): Promise<DesktopPerformanceRecordingSnapshot>;
    startDesktopPerformanceRecording(confirmedSensitiveCapture: true): Promise<DesktopPerformanceRecordingSnapshot>;
    stopDesktopPerformanceRecording(): Promise<DesktopPerformanceRecordingSnapshot>;
    saveDesktopPerformanceRecording(): Promise<DesktopPerformanceRecordingSaveResult>;
    discardDesktopPerformanceRecording(): Promise<DesktopPerformanceRecordingSnapshot>;
    subscribeHostStartup(listener: (snapshot: DesktopHostStartupSnapshot) => void): () => void;
    subscribePresentation(listener: (snapshot: DesktopPresentationSnapshot) => void): () => void;
    subscribeDesktopPerformanceRecording(listener: (snapshot: DesktopPerformanceRecordingSnapshot) => void): () => void;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.trim() === value && !value.includes("\0");
}

function isPackagedProofSubjectId(value: unknown): value is string {
    return isNonEmptyString(value) && value.length <= 256;
}

export function parseDesktopWindowAction(value: unknown): DesktopWindowAction {
    if (typeof value !== "string" || !DESKTOP_WINDOW_ACTIONS.has(value)) {
        throw new TypeError("invalid Desktop window action");
    }
    return value as DesktopWindowAction;
}

export function parseDesktopAppIdentity(value: unknown): DesktopAppIdentity {
    if (
        !isExactRecord(value, ["name", "version"]) ||
        !isNonEmptyString(value.name) ||
        !isNonEmptyString(value.version) ||
        value.name.length > 128 ||
        value.version.length > 64
    ) {
        throw new TypeError("invalid Desktop app identity");
    }
    return Object.freeze({ name: value.name, version: value.version });
}

function isPackagedProofDiagnosticCode(value: unknown): value is string {
    return typeof value === "string" && /^[a-z0-9_.-]{1,128}$/u.test(value);
}

function isPackagedProofDiagnosticCodes(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.length <= 8 &&
        value.every(isPackagedProofDiagnosticCode) &&
        new Set(value).size === value.length &&
        value.every((code, index) => index === 0 || String(value[index - 1]) < code)
    );
}

export function parsePackagedOnboardingProofReply(value: unknown): PackagedOnboardingProofReply {
    if (isExactRecord(value, ["status"]) && value.status === "complete") {
        return Object.freeze({ status: "complete" });
    }
    if (
        isExactRecord(value, ["diagnosticCodes", "status", "step"]) &&
        value.status === "failed" &&
        typeof value.step === "string" &&
        PACKAGED_ONBOARDING_PROOF_STEPS.has(value.step) &&
        isPackagedProofDiagnosticCodes(value.diagnosticCodes)
    ) {
        return Object.freeze({
            status: "failed",
            step: value.step as PackagedOnboardingProofStep,
            diagnosticCodes: Object.freeze([...value.diagnosticCodes]),
        });
    }
    throw new TypeError("invalid packaged onboarding proof reply");
}

function parsePackagedProofSubjectIdentity(value: unknown): PackagedProofSubjectIdentity {
    if (
        !isExactRecord(value, ["assetId", "deploymentId", "projectId", "versionId"]) ||
        !isPackagedProofSubjectId(value.assetId) ||
        !isPackagedProofSubjectId(value.deploymentId) ||
        !isPackagedProofSubjectId(value.projectId) ||
        !isPackagedProofSubjectId(value.versionId)
    ) {
        throw new TypeError("invalid packaged proof subject identity");
    }
    return Object.freeze({
        projectId: value.projectId,
        assetId: value.assetId,
        versionId: value.versionId,
        deploymentId: value.deploymentId,
    });
}

function parsePackagedZcodeTargetFixtureSubjects(value: unknown): PackagedZcodeTargetFixtureSubjects {
    if (
        !isExactRecord(value, ["assetKind", "source", "target"]) ||
        !isPackagedZcodeTargetAssetKind(value.assetKind) ||
        !isExactRecord(value.source, ["assetId", "projectId", "versionId"])
    ) {
        throw new TypeError("invalid packaged ZCode fixture subjects");
    }
    if (
        !isPackagedProofSubjectId(value.source.assetId) ||
        !isPackagedProofSubjectId(value.source.projectId) ||
        !isPackagedProofSubjectId(value.source.versionId)
    ) {
        throw new TypeError("invalid packaged ZCode source fixture subject");
    }
    return Object.freeze({
        assetKind: value.assetKind,
        source: Object.freeze({
            projectId: value.source.projectId,
            assetId: value.source.assetId,
            versionId: value.source.versionId,
        }),
        target: parsePackagedProofSubjectIdentity(value.target),
    });
}

export function parsePackagedZcodeTargetProofRequest(value: unknown): PackagedZcodeTargetProofRequest {
    if (
        isExactRecord(value, [
            "assetKind",
            "mode",
            "sourceProjectRegistrationToken",
            "sourceProjectToken",
            "targetProjectRegistrationToken",
            "targetProjectToken",
        ]) &&
        value.mode === "deploy" &&
        isPackagedZcodeTargetAssetKind(value.assetKind) &&
        isNonEmptyString(value.sourceProjectRegistrationToken) &&
        isNonEmptyString(value.sourceProjectToken) &&
        isNonEmptyString(value.targetProjectRegistrationToken) &&
        isNonEmptyString(value.targetProjectToken)
    ) {
        return Object.freeze({
            mode: "deploy",
            assetKind: value.assetKind,
            sourceProjectRegistrationToken: value.sourceProjectRegistrationToken,
            sourceProjectToken: value.sourceProjectToken,
            targetProjectRegistrationToken: value.targetProjectRegistrationToken,
            targetProjectToken: value.targetProjectToken,
        });
    }
    if (
        isExactRecord(value, ["assetKind", "mode", "subject"]) &&
        value.mode === "reverse" &&
        isPackagedZcodeTargetAssetKind(value.assetKind)
    ) {
        return Object.freeze({
            mode: "reverse",
            assetKind: value.assetKind,
            subject: parsePackagedProofSubjectIdentity(value.subject),
        });
    }
    throw new TypeError("invalid packaged ZCode target proof request");
}

function isPackagedZcodeTargetAssetKind(value: unknown): value is PackagedZcodeTargetAssetKind {
    return value === "Guidance" || value === "Workflow" || value === "Skill" || value === "Subagent" || value === "Memory";
}

export function parsePackagedZcodeTargetProofReply(value: unknown): PackagedZcodeTargetProofReply {
    if (isExactRecord(value, ["status"]) && value.status === "complete") {
        return Object.freeze({ status: "complete" });
    }
    if (isExactRecord(value, ["status", "subjects"]) && value.status === "complete") {
        return Object.freeze({ status: "complete", subjects: parsePackagedZcodeTargetFixtureSubjects(value.subjects) });
    }
    if (isExactRecord(value, ["status", "subject"]) && value.status === "complete") {
        return Object.freeze({ status: "complete", subject: parsePackagedProofSubjectIdentity(value.subject) });
    }
    if (
        isExactRecord(value, ["diagnosticCodes", "status", "step"]) &&
        value.status === "failed" &&
        typeof value.step === "string" &&
        PACKAGED_ZCODE_TARGET_PROOF_STEPS.has(value.step) &&
        isPackagedProofDiagnosticCodes(value.diagnosticCodes)
    ) {
        return Object.freeze({
            status: "failed",
            step: value.step as PackagedZcodeTargetProofStep,
            diagnosticCodes: Object.freeze([...value.diagnosticCodes]),
        });
    }
    throw new TypeError("invalid packaged ZCode target proof reply");
}

export function parsePackagedStateResilienceProofRequest(value: unknown): PackagedStateResilienceProofRequest {
    if (
        isExactRecord(value, ["archiveToken", "mode", "wrongPasswordArchiveToken"]) &&
        value.mode === "restore" &&
        isNonEmptyString(value.wrongPasswordArchiveToken) &&
        isNonEmptyString(value.archiveToken)
    ) {
        return Object.freeze({
            mode: "restore",
            wrongPasswordArchiveToken: value.wrongPasswordArchiveToken,
            archiveToken: value.archiveToken,
        });
    }
    if (
        isExactRecord(value, ["mode", "subject"]) &&
        (value.mode === "backup" || value.mode === "reopen" || value.mode === "trash")
    ) {
        return Object.freeze({ mode: value.mode, subject: parsePackagedProofSubjectIdentity(value.subject) });
    }
    throw new TypeError("invalid packaged State resilience proof request");
}

export function parsePackagedStateResilienceProofReply(value: unknown): PackagedStateResilienceProofReply {
    if (isExactRecord(value, ["status"]) && value.status === "complete") {
        return Object.freeze({ status: "complete" });
    }
    if (
        isExactRecord(value, ["diagnosticCodes", "status", "step"]) &&
        value.status === "failed" &&
        typeof value.step === "string" &&
        PACKAGED_STATE_RESILIENCE_PROOF_STEPS.has(value.step) &&
        isPackagedProofDiagnosticCodes(value.diagnosticCodes)
    ) {
        return Object.freeze({
            status: "failed",
            step: value.step as PackagedStateResilienceProofStep,
            diagnosticCodes: Object.freeze([...value.diagnosticCodes]),
        });
    }
    throw new TypeError("invalid packaged State resilience proof reply");
}

export function parsePackagedProjectLifecycleProofRequest(value: unknown): PackagedProjectLifecycleProofRequest {
    if (isExactRecord(value, ["rebindRootToken", "subject"]) && isNonEmptyString(value.rebindRootToken)) {
        return Object.freeze({
            rebindRootToken: value.rebindRootToken,
            subject: parsePackagedProofSubjectIdentity(value.subject),
        });
    }
    throw new TypeError("invalid packaged Project lifecycle proof request");
}

export function parsePackagedProjectLifecycleProofReply(value: unknown): PackagedProjectLifecycleProofReply {
    if (isExactRecord(value, ["status"]) && value.status === "complete") {
        return Object.freeze({ status: "complete" });
    }
    if (
        isExactRecord(value, ["diagnosticCodes", "status", "step"]) &&
        value.status === "failed" &&
        typeof value.step === "string" &&
        PACKAGED_PROJECT_LIFECYCLE_PROOF_STEPS.has(value.step) &&
        isPackagedProofDiagnosticCodes(value.diagnosticCodes)
    ) {
        return Object.freeze({
            status: "failed",
            step: value.step as PackagedProjectLifecycleProofStep,
            diagnosticCodes: Object.freeze([...value.diagnosticCodes]),
        });
    }
    throw new TypeError("invalid packaged Project lifecycle proof reply");
}

export function parsePackagedAssetLifecycleProofRequest(value: unknown): PackagedAssetLifecycleProofRequest {
    if (isExactRecord(value, ["exportToken", "subject"]) && isNonEmptyString(value.exportToken)) {
        return Object.freeze({
            exportToken: value.exportToken,
            subject: parsePackagedProofSubjectIdentity(value.subject),
        });
    }
    throw new TypeError("invalid packaged Asset lifecycle proof request");
}

export function parsePackagedAssetLifecycleProofControlRequest(value: unknown): PackagedAssetLifecycleProofControlRequest {
    if (isExactRecord(value, ["control"]) && value.control === "request_existing_export_token") {
        return Object.freeze({ control: "request_existing_export_token" });
    }
    throw new TypeError("invalid packaged Asset lifecycle proof control request");
}

export function parsePackagedAssetLifecycleProofControlReply(value: unknown): PackagedAssetLifecycleProofControlReply {
    if (
        isExactRecord(value, ["control", "existingExportToken"]) &&
        value.control === "existing_export_token" &&
        isNonEmptyString(value.existingExportToken)
    ) {
        return Object.freeze({
            control: "existing_export_token",
            existingExportToken: value.existingExportToken,
        });
    }
    throw new TypeError("invalid packaged Asset lifecycle proof control reply");
}

export function parsePackagedAssetLifecycleProofReply(value: unknown): PackagedAssetLifecycleProofReply {
    if (isExactRecord(value, ["status"]) && value.status === "complete") {
        return Object.freeze({ status: "complete" });
    }
    if (
        isExactRecord(value, ["diagnosticCodes", "status", "step"]) &&
        value.status === "failed" &&
        typeof value.step === "string" &&
        PACKAGED_ASSET_LIFECYCLE_PROOF_STEPS.has(value.step) &&
        isPackagedProofDiagnosticCodes(value.diagnosticCodes)
    ) {
        return Object.freeze({
            status: "failed",
            step: value.step as PackagedAssetLifecycleProofStep,
            diagnosticCodes: Object.freeze([...value.diagnosticCodes]),
        });
    }
    throw new TypeError("invalid packaged Asset lifecycle proof reply");
}

export function parseAssetVersionExportPickerResult(value: unknown): AssetVersionExportPickerResult {
    try {
        return parseProjectRootPickerResult(value);
    } catch {
        throw new TypeError("invalid Desktop Asset Version export picker result");
    }
}

export function parseAssetVersionExportKind(value: unknown): AssetVersionExportKind {
    if (value === "native_files" || value === "oaam_version_package") return value;
    throw new TypeError("invalid Desktop Asset Version export kind");
}

export function parseAssetVersionExportSuggestedFileName(value: unknown): string {
    if (
        !isNonEmptyString(value) ||
        value.length > 240 ||
        value.includes("/") ||
        value.includes("\\") ||
        !value.toLocaleLowerCase("en-US").endsWith(".zip")
    ) {
        throw new TypeError("invalid Desktop Asset Version export filename");
    }
    return value;
}

export function parseStateBackupDestinationPickerResult(value: unknown): StateBackupDestinationPickerResult {
    if (isExactRecord(value, ["status"]) && (value.status === "cancelled" || value.status === "unavailable")) {
        return Object.freeze({ status: value.status });
    }
    try {
        return parseProjectRootPickerResult(value);
    } catch {
        throw new TypeError("invalid Desktop State backup destination result");
    }
}

export function parseStateRestoreArchivePickerResult(value: unknown): StateRestoreArchivePickerResult {
    try {
        return parseProjectRootPickerResult(value);
    } catch {
        throw new TypeError("invalid Desktop State restore archive result");
    }
}

export function parseDesktopStateResiliencePreferences(value: unknown): DesktopStateResiliencePreferencesV1 {
    const keys =
        typeof value === "object" && value !== null && !Array.isArray(value) && "lastCustomBackupDirectory" in value
            ? ["lastCustomBackupDirectory", "schemaVersion"]
            : ["schemaVersion"];
    if (
        !isExactRecord(value, keys) ||
        value.schemaVersion !== 1 ||
        ("lastCustomBackupDirectory" in value && !isNonEmptyString(value.lastCustomBackupDirectory))
    ) {
        throw new TypeError("invalid Desktop State resilience preferences");
    }
    return Object.freeze({
        schemaVersion: 1,
        ...(typeof value.lastCustomBackupDirectory === "string"
            ? { lastCustomBackupDirectory: value.lastCustomBackupDirectory }
            : {}),
    });
}

export function parseDesktopStateBackupFileAction(value: unknown): DesktopStateBackupFileAction {
    if (value !== "reveal" && value !== "trash" && value !== "copy_path") {
        throw new TypeError("invalid Desktop State backup file action");
    }
    return value;
}

export function parseDesktopStateBackupFileActionResult(value: unknown): DesktopStateBackupFileActionResult {
    if (isExactRecord(value, ["status"]) && value.status === "complete") {
        return Object.freeze({ status: "complete" });
    }
    if (
        isExactRecord(value, ["code", "status"]) &&
        value.status === "failed" &&
        (value.code === "unavailable" ||
            value.code === "reveal_failed" ||
            value.code === "trash_failed" ||
            value.code === "copy_failed")
    ) {
        return Object.freeze({ status: "failed", code: value.code });
    }
    throw new TypeError("invalid Desktop State backup file action result");
}

export function parseDesktopBackupId(value: unknown): string {
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
        throw new TypeError("invalid Desktop State backup identity");
    }
    return value;
}

export function parseDesktopHostStartupSnapshot(value: unknown): DesktopHostStartupSnapshot {
    if (isExactRecord(value, ["status"])) {
        if (value.status === "starting") return Object.freeze({ status: "starting" });
        if (value.status === "ready") return Object.freeze({ status: "ready" });
    }
    if (
        isExactRecord(value, ["reasonCode", "status"]) &&
        value.status === "recovering" &&
        isDesktopOperationalDiagnosticCode(value.reasonCode)
    ) {
        return Object.freeze({ status: "recovering", reasonCode: value.reasonCode });
    }
    if (
        isExactRecord(value, ["recoveryReason", "status"]) &&
        value.status === "ready" &&
        (value.recoveryReason === "missing_database" ||
            value.recoveryReason === "corrupt_database" ||
            value.recoveryReason === "incompatible_database" ||
            value.recoveryReason === "restore_reconciliation")
    ) {
        return Object.freeze({ status: "ready", recoveryReason: value.recoveryReason });
    }
    if (
        isExactRecord(value, ["reasonCode", "status"]) &&
        value.status === "failed" &&
        isDesktopOperationalDiagnosticCode(value.reasonCode)
    ) {
        return Object.freeze({ status: "failed", reasonCode: value.reasonCode });
    }
    throw new TypeError("invalid Desktop Host startup snapshot");
}
