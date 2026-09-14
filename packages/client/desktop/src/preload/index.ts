import { contextBridge, ipcRenderer } from "electron";
import {
    APP_IDENTITY_GET_CHANNEL,
    ASSET_LAYOUT_REPLACE_CHANNEL,
    ASSET_VERSION_EXPORT_PICK_CHANNEL,
    type AssetVersionExportKind,
    DESKTOP_DATA_LOCATION_ACTION_CHANNEL,
    DESKTOP_INTERFACE_CACHE_CLEAR_CHANNEL,
    DESKTOP_INTERFACE_DEFAULTS_RESTORE_CHANNEL,
    DESKTOP_MAINTENANCE_GET_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_CHANGED_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_DISCARD_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_GET_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_SAVE_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_START_CHANNEL,
    DESKTOP_PERFORMANCE_RECORDING_STOP_CHANNEL,
    type DesktopHostStartupSnapshot,
    type DesktopWindowAction,
    HOST_RETRY_CHANNEL,
    HOST_STARTUP_CHANGED_CHANNEL,
    HOST_STARTUP_GET_CHANNEL,
    IMPORT_PREVIEW_FILE_REVEAL_CHANNEL,
    INSTALLATION_ROOT_PICK_CHANNEL,
    LAST_PROJECT_REPLACE_CHANNEL,
    type OaamDesktopBridge,
    OBSERVED_PROJECT_ROOT_AUTHORIZE_CHANNEL,
    OBSERVED_PROJECT_ROOT_REVEAL_CHANNEL,
    ONBOARDING_COMPLETE_CHANNEL,
    PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_CHANNEL,
    PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_SIGNAL,
    PACKAGED_DIAGNOSTICS_PROOF_PORT_CHANNEL,
    PACKAGED_DIAGNOSTICS_PROOF_PORT_SIGNAL,
    PACKAGED_ONBOARDING_PROOF_PORT_CHANNEL,
    PACKAGED_ONBOARDING_PROOF_PORT_SIGNAL,
    PACKAGED_OPENCODE_PROJECT_PROOF_PORT_CHANNEL,
    PACKAGED_OPENCODE_PROJECT_PROOF_PORT_SIGNAL,
    PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_CHANNEL,
    PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_SIGNAL,
    PACKAGED_STATE_RESILIENCE_PROOF_PORT_CHANNEL,
    PACKAGED_STATE_RESILIENCE_PROOF_PORT_SIGNAL,
    PACKAGED_ZCODE_TARGET_PROOF_PORT_CHANNEL,
    PACKAGED_ZCODE_TARGET_PROOF_PORT_SIGNAL,
    PRESENTATION_CHANGED_CHANNEL,
    PRESENTATION_GET_CHANNEL,
    PRESENTATION_REPLACE_CHANNEL,
    PROJECT_ROOT_PICK_CHANNEL,
    PROTOCOL_PORT_CHANNEL,
    PROTOCOL_PORT_SIGNAL,
    packagedZcodeTargetTransferPortCount,
    parseAssetVersionExportPickerResult,
    parseAssetVersionExportKind,
    parseAssetVersionExportSuggestedFileName,
    parseDesktopAppIdentity,
    parseDesktopBackupId,
    parseDesktopDataLocationAction,
    parseDesktopDataLocationActionResult,
    parseDesktopDataLocationId,
    parseDesktopHostStartupSnapshot,
    parseDesktopImportPreviewFileReference,
    parseDesktopInterfaceCacheClearResult,
    parseDesktopInterfaceDefaultsRestoreResult,
    parseDesktopMaintenanceSnapshot,
    parseDesktopObservedProjectRootReference,
    parseDesktopPerformanceRecordingSaveResult,
    parseDesktopPerformanceRecordingSnapshot,
    parseDesktopRegisteredProjectId,
    parseDesktopSensitiveCaptureConfirmation,
    parseDesktopStateBackupFileAction,
    parseDesktopStateBackupFileActionResult,
    parseDesktopStateResiliencePreferences,
    parseDesktopWindowAction,
    parseImportPreviewFileRevealResult,
    parseInstallationRootPickerResult,
    parseObservedProjectRootAuthorizationResult,
    parseObservedProjectRootRevealResult,
    parseProjectRootPickerResult,
    parseProjectRootPickerSuggestedPath,
    parseRegisteredProjectRootAuthorizationResult,
    parseRegisteredProjectRootRevealResult,
    parseSourceRootPickerResult,
    parseStateBackupDestinationPickerResult,
    parseStateRestoreArchivePickerResult,
    parseSupportBundleExportPickerResult,
    parseSupportBundleExportSuggestedFileName,
    REGISTERED_PROJECT_ROOT_AUTHORIZE_CHANNEL,
    REGISTERED_PROJECT_ROOT_REVEAL_CHANNEL,
    SOURCE_ROOT_PICK_CHANNEL,
    STATE_BACKUP_DESTINATION_PICK_CHANNEL,
    STATE_BACKUP_DESTINATION_REMEMBER_CHANNEL,
    STATE_BACKUP_FILE_ACTION_CHANNEL,
    STATE_BACKUP_REMEMBERED_DESTINATION_CHANNEL,
    STATE_RESILIENCE_PREFERENCES_GET_CHANNEL,
    STATE_RESTORE_ARCHIVE_PICK_CHANNEL,
    SUPPORT_BUNDLE_EXPORT_PICK_CHANNEL,
    WINDOW_ACTION_CHANNEL,
} from "../bridge/desktop-bridge";
import {
    type DesktopRendererDiagnosticInput,
    parseDesktopRendererDiagnosticInput,
    RENDERER_DIAGNOSTIC_CHANNEL,
} from "../bridge/desktop-renderer-diagnostics";
import {
    type DesktopAssetLayoutPreference,
    type DesktopPresentationPreferenceInput,
    type DesktopPresentationSnapshot,
    isDesktopAssetLayoutPreference,
    parseDesktopPresentationPreferenceInput,
    parseDesktopPresentationSnapshot,
    parseDesktopProjectId,
} from "../presentation/presentation-preferences";

ipcRenderer.on(PROTOCOL_PORT_CHANNEL, (event) => {
    const [port] = event.ports;
    if (event.ports.length !== 1 || port === undefined) {
        for (const port of event.ports) port.close();
        return;
    }
    window.postMessage(PROTOCOL_PORT_SIGNAL, "*", [port]);
});

ipcRenderer.on(PACKAGED_ONBOARDING_PROOF_PORT_CHANNEL, (event) => {
    if (event.ports.length !== 2) {
        for (const port of event.ports) port.close();
        return;
    }
    window.postMessage(PACKAGED_ONBOARDING_PROOF_PORT_SIGNAL, "*", event.ports);
});

ipcRenderer.on(PACKAGED_OPENCODE_PROJECT_PROOF_PORT_CHANNEL, (event, request: unknown) => {
    if (event.ports.length !== 2) {
        for (const port of event.ports) port.close();
        return;
    }
    window.postMessage(Object.freeze({ signal: PACKAGED_OPENCODE_PROJECT_PROOF_PORT_SIGNAL, request }), "*", event.ports);
});

ipcRenderer.on(PACKAGED_ZCODE_TARGET_PROOF_PORT_CHANNEL, (event, request: unknown) => {
    const mode =
        typeof request === "object" && request !== null && "mode" in request && request.mode === "deploy" ? "deploy" : "reverse";
    const expectedPortCount = packagedZcodeTargetTransferPortCount(mode);
    if (event.ports.length !== expectedPortCount) {
        for (const port of event.ports) port.close();
        return;
    }
    window.postMessage(Object.freeze({ signal: PACKAGED_ZCODE_TARGET_PROOF_PORT_SIGNAL, request }), "*", event.ports);
});

ipcRenderer.on(PACKAGED_STATE_RESILIENCE_PROOF_PORT_CHANNEL, (event, request: unknown) => {
    const expectedPortCount =
        typeof request === "object" && request !== null && "mode" in request && request.mode === "restore" ? 3 : 2;
    if (event.ports.length !== expectedPortCount) {
        for (const port of event.ports) port.close();
        return;
    }
    window.postMessage(Object.freeze({ signal: PACKAGED_STATE_RESILIENCE_PROOF_PORT_SIGNAL, request }), "*", event.ports);
});

ipcRenderer.on(PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_CHANNEL, (event, request: unknown) => {
    if (event.ports.length !== 2) {
        for (const port of event.ports) port.close();
        return;
    }
    window.postMessage(Object.freeze({ signal: PACKAGED_PROJECT_LIFECYCLE_PROOF_PORT_SIGNAL, request }), "*", event.ports);
});

ipcRenderer.on(PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_CHANNEL, (event, request: unknown) => {
    if (event.ports.length !== 2) {
        for (const port of event.ports) port.close();
        return;
    }
    window.postMessage(Object.freeze({ signal: PACKAGED_ASSET_LIFECYCLE_PROOF_PORT_SIGNAL, request }), "*", event.ports);
});

ipcRenderer.on(PACKAGED_DIAGNOSTICS_PROOF_PORT_CHANNEL, (event, request: unknown) => {
    if (event.ports.length !== 2) {
        for (const port of event.ports) port.close();
        return;
    }
    window.postMessage(Object.freeze({ signal: PACKAGED_DIAGNOSTICS_PROOF_PORT_SIGNAL, request }), "*", event.ports);
});

const bridge: OaamDesktopBridge = Object.freeze({
    initialAppIdentity: parseDesktopAppIdentity(ipcRenderer.sendSync(APP_IDENTITY_GET_CHANNEL)),
    initialHostStartup: parseDesktopHostStartupSnapshot(ipcRenderer.sendSync(HOST_STARTUP_GET_CHANNEL)),
    initialPresentation: parseDesktopPresentationSnapshot(ipcRenderer.sendSync(PRESENTATION_GET_CHANNEL)),
    async retrySession() {
        await ipcRenderer.invoke(HOST_RETRY_CHANNEL);
    },
    async pickProjectRoot(suggestedRootPath: string | undefined) {
        const suggestion = parseProjectRootPickerSuggestedPath(suggestedRootPath);
        return parseProjectRootPickerResult(await ipcRenderer.invoke(PROJECT_ROOT_PICK_CHANNEL, suggestion));
    },
    async authorizeObservedProjectRoot(reference: Parameters<OaamDesktopBridge["authorizeObservedProjectRoot"]>[0]) {
        return parseObservedProjectRootAuthorizationResult(
            await ipcRenderer.invoke(
                OBSERVED_PROJECT_ROOT_AUTHORIZE_CHANNEL,
                parseDesktopObservedProjectRootReference(reference),
            ),
        );
    },
    async revealObservedProjectRoot(reference: Parameters<OaamDesktopBridge["revealObservedProjectRoot"]>[0]) {
        return parseObservedProjectRootRevealResult(
            await ipcRenderer.invoke(OBSERVED_PROJECT_ROOT_REVEAL_CHANNEL, parseDesktopObservedProjectRootReference(reference)),
        );
    },
    async authorizeRegisteredProjectRoot(projectId: string) {
        return parseRegisteredProjectRootAuthorizationResult(
            await ipcRenderer.invoke(REGISTERED_PROJECT_ROOT_AUTHORIZE_CHANNEL, parseDesktopRegisteredProjectId(projectId)),
        );
    },
    async revealRegisteredProjectRoot(projectId: string) {
        return parseRegisteredProjectRootRevealResult(
            await ipcRenderer.invoke(REGISTERED_PROJECT_ROOT_REVEAL_CHANNEL, parseDesktopRegisteredProjectId(projectId)),
        );
    },
    async revealImportPreviewFile(reference: Parameters<OaamDesktopBridge["revealImportPreviewFile"]>[0]) {
        return parseImportPreviewFileRevealResult(
            await ipcRenderer.invoke(IMPORT_PREVIEW_FILE_REVEAL_CHANNEL, parseDesktopImportPreviewFileReference(reference)),
        );
    },
    async pickSourceRoot() {
        return parseSourceRootPickerResult(await ipcRenderer.invoke(SOURCE_ROOT_PICK_CHANNEL));
    },
    async pickInstallationRoot() {
        return parseInstallationRootPickerResult(await ipcRenderer.invoke(INSTALLATION_ROOT_PICK_CHANNEL));
    },
    async pickStateBackupDestination() {
        return parseStateBackupDestinationPickerResult(await ipcRenderer.invoke(STATE_BACKUP_DESTINATION_PICK_CHANNEL));
    },
    async selectRememberedStateBackupDestination() {
        return parseStateBackupDestinationPickerResult(await ipcRenderer.invoke(STATE_BACKUP_REMEMBERED_DESTINATION_CHANNEL));
    },
    async pickStateRestoreArchive() {
        return parseStateRestoreArchivePickerResult(await ipcRenderer.invoke(STATE_RESTORE_ARCHIVE_PICK_CHANNEL));
    },
    async pickAssetVersionExport(exportKind: AssetVersionExportKind, suggestedFileName: string) {
        return parseAssetVersionExportPickerResult(
            await ipcRenderer.invoke(
                ASSET_VERSION_EXPORT_PICK_CHANNEL,
                parseAssetVersionExportKind(exportKind),
                parseAssetVersionExportSuggestedFileName(suggestedFileName),
            ),
        );
    },
    async pickSupportBundleExport(suggestedFileName: string) {
        return parseSupportBundleExportPickerResult(
            await ipcRenderer.invoke(
                SUPPORT_BUNDLE_EXPORT_PICK_CHANNEL,
                parseSupportBundleExportSuggestedFileName(suggestedFileName),
            ),
        );
    },
    async getStateResiliencePreferences() {
        return parseDesktopStateResiliencePreferences(await ipcRenderer.invoke(STATE_RESILIENCE_PREFERENCES_GET_CHANNEL));
    },
    async rememberStateBackupDestination(backupId: string) {
        return parseDesktopStateResiliencePreferences(
            await ipcRenderer.invoke(STATE_BACKUP_DESTINATION_REMEMBER_CHANNEL, parseDesktopBackupId(backupId)),
        );
    },
    async performStateBackupFileAction(
        backupId: Parameters<OaamDesktopBridge["performStateBackupFileAction"]>[0],
        action: Parameters<OaamDesktopBridge["performStateBackupFileAction"]>[1],
    ) {
        return parseDesktopStateBackupFileActionResult(
            await ipcRenderer.invoke(
                STATE_BACKUP_FILE_ACTION_CHANNEL,
                parseDesktopBackupId(backupId),
                parseDesktopStateBackupFileAction(action),
            ),
        );
    },
    async completeOnboarding(): Promise<DesktopPresentationSnapshot> {
        return parseDesktopPresentationSnapshot(await ipcRenderer.invoke(ONBOARDING_COMPLETE_CHANNEL));
    },
    async replacePresentationPreferences(input: DesktopPresentationPreferenceInput): Promise<DesktopPresentationSnapshot> {
        return parseDesktopPresentationSnapshot(
            await ipcRenderer.invoke(PRESENTATION_REPLACE_CHANNEL, parseDesktopPresentationPreferenceInput(input)),
        );
    },
    async rememberLastProject(projectId: string): Promise<DesktopPresentationSnapshot> {
        return parseDesktopPresentationSnapshot(
            await ipcRenderer.invoke(LAST_PROJECT_REPLACE_CHANNEL, parseDesktopProjectId(projectId)),
        );
    },
    async replaceAssetLayout(assetLayout: DesktopAssetLayoutPreference): Promise<DesktopPresentationSnapshot> {
        if (!isDesktopAssetLayoutPreference(assetLayout)) throw new TypeError("invalid Desktop Asset layout preference");
        return parseDesktopPresentationSnapshot(await ipcRenderer.invoke(ASSET_LAYOUT_REPLACE_CHANNEL, assetLayout));
    },
    async performWindowAction(action: DesktopWindowAction) {
        await ipcRenderer.invoke(WINDOW_ACTION_CHANNEL, parseDesktopWindowAction(action));
    },
    async recordRendererDiagnostic(input: DesktopRendererDiagnosticInput) {
        await ipcRenderer.invoke(RENDERER_DIAGNOSTIC_CHANNEL, parseDesktopRendererDiagnosticInput(input));
    },
    async getDesktopMaintenance() {
        return parseDesktopMaintenanceSnapshot(await ipcRenderer.invoke(DESKTOP_MAINTENANCE_GET_CHANNEL));
    },
    async clearDesktopInterfaceCache() {
        return parseDesktopInterfaceCacheClearResult(await ipcRenderer.invoke(DESKTOP_INTERFACE_CACHE_CLEAR_CHANNEL));
    },
    async performDesktopDataLocationAction(
        locationId: Parameters<OaamDesktopBridge["performDesktopDataLocationAction"]>[0],
        action: Parameters<OaamDesktopBridge["performDesktopDataLocationAction"]>[1],
    ) {
        return parseDesktopDataLocationActionResult(
            await ipcRenderer.invoke(
                DESKTOP_DATA_LOCATION_ACTION_CHANNEL,
                parseDesktopDataLocationId(locationId),
                parseDesktopDataLocationAction(action),
            ),
        );
    },
    async restoreDesktopInterfaceDefaults() {
        return parseDesktopInterfaceDefaultsRestoreResult(await ipcRenderer.invoke(DESKTOP_INTERFACE_DEFAULTS_RESTORE_CHANNEL));
    },
    async getDesktopPerformanceRecording() {
        return parseDesktopPerformanceRecordingSnapshot(await ipcRenderer.invoke(DESKTOP_PERFORMANCE_RECORDING_GET_CHANNEL));
    },
    async startDesktopPerformanceRecording(confirmedSensitiveCapture: true) {
        return parseDesktopPerformanceRecordingSnapshot(
            await ipcRenderer.invoke(
                DESKTOP_PERFORMANCE_RECORDING_START_CHANNEL,
                parseDesktopSensitiveCaptureConfirmation(confirmedSensitiveCapture),
            ),
        );
    },
    async stopDesktopPerformanceRecording() {
        return parseDesktopPerformanceRecordingSnapshot(await ipcRenderer.invoke(DESKTOP_PERFORMANCE_RECORDING_STOP_CHANNEL));
    },
    async saveDesktopPerformanceRecording() {
        return parseDesktopPerformanceRecordingSaveResult(await ipcRenderer.invoke(DESKTOP_PERFORMANCE_RECORDING_SAVE_CHANNEL));
    },
    async discardDesktopPerformanceRecording() {
        return parseDesktopPerformanceRecordingSnapshot(await ipcRenderer.invoke(DESKTOP_PERFORMANCE_RECORDING_DISCARD_CHANNEL));
    },
    subscribeHostStartup(listener: (snapshot: DesktopHostStartupSnapshot) => void): () => void {
        const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => {
            listener(parseDesktopHostStartupSnapshot(value));
        };
        ipcRenderer.on(HOST_STARTUP_CHANGED_CHANNEL, receive);
        return () => {
            ipcRenderer.off(HOST_STARTUP_CHANGED_CHANNEL, receive);
        };
    },
    subscribePresentation(listener: (snapshot: DesktopPresentationSnapshot) => void): () => void {
        const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => {
            listener(parseDesktopPresentationSnapshot(value));
        };
        ipcRenderer.on(PRESENTATION_CHANGED_CHANNEL, receive);
        return () => {
            ipcRenderer.off(PRESENTATION_CHANGED_CHANNEL, receive);
        };
    },
    subscribeDesktopPerformanceRecording(listener: Parameters<OaamDesktopBridge["subscribeDesktopPerformanceRecording"]>[0]) {
        const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => {
            listener(parseDesktopPerformanceRecordingSnapshot(value));
        };
        ipcRenderer.on(DESKTOP_PERFORMANCE_RECORDING_CHANGED_CHANNEL, receive);
        return () => {
            ipcRenderer.off(DESKTOP_PERFORMANCE_RECORDING_CHANGED_CHANNEL, receive);
        };
    },
});

contextBridge.exposeInMainWorld("oaamDesktop", bridge);
