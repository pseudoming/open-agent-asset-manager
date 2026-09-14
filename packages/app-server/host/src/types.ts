import type {
    DesktopSimpleOperationalDiagnosticCode,
    ProtocolDesktopRendererDiagnosticInputV1,
    ProtocolDiagnosticsHealthV1,
    ProtocolNotificationV1,
    ProtocolOperationName,
    ProtocolOperationOutcomeV1,
    ProtocolOrdinaryLogClearResultV1,
    ProtocolOrdinaryLogSettingsReplaceParamsV1,
    ProtocolOrdinaryLogSettingsV1,
    ProtocolResponseEnvelopeV1,
} from "@oaam/app-server-protocol";
import type {
    ActivateStateRestoreInputV1,
    CoreResult,
    InspectStateRestoreInputV1,
    StateRestoreActivationV1,
    StateRestorePreparationV1,
    UuidV4,
} from "@oaam/core";
import type { HostLocalPathSelectionKind } from "./path-selection-store";

export type HostLifecycleState = "starting" | "ready" | "draining" | "stopped" | "failed";

export type HostStateRecoveryReason =
    | "missing_database"
    | "corrupt_database"
    | "incompatible_database"
    | "restore_reconciliation";

export type HostStartupDisposition =
    | { readonly mode: "normal" }
    | { readonly mode: "state_recovery"; readonly reason: HostStateRecoveryReason };

export type HostOutboundMessage = ProtocolResponseEnvelopeV1 | ProtocolNotificationV1;

export interface HostConnectionSink {
    send(message: HostOutboundMessage): void;
    close(reason: unknown): void;
}

export interface HostObservedProjectRootReference {
    readonly probeToken: string;
    readonly probeResultRowId: string;
    readonly projectRowId: string;
    readonly sourceRootRowId: string;
}

export interface HostImportPreviewFileReference {
    readonly previewToken: string;
    readonly candidateId: string;
    readonly logicalPath?: string;
}

export interface HostConnection {
    readonly connectionId: string;
    registerLocalPathSelection(kind: HostLocalPathSelectionKind, rootPath: string): string;
    resolveObservedProjectRoot(reference: HostObservedProjectRootReference): string;
    resolveImportPreviewFileDirectory(reference: HostImportPreviewFileReference): string;
    authorizeObservedProjectRootRegistration(reference: HostObservedProjectRootReference): {
        readonly rootPath: string;
        readonly localPathSelectionToken: string;
    };
    resolveRegisteredProjectRoot(projectId: UuidV4): string;
    authorizeRegisteredProjectRootProbe(projectId: UuidV4): {
        readonly rootPath: string;
        readonly localPathSelectionToken: string;
    };
    receive(message: unknown): void;
    close(): void;
}

export interface HostRestoreActivationControl {
    quiesceMutations(): Promise<void>;
}

export interface HostStateResilienceIntegration {
    readDesktopPreferences(): Promise<Uint8Array | undefined>;
    inspectStateRestore(input: InspectStateRestoreInputV1): Promise<CoreResult<StateRestorePreparationV1>>;
    activateStateRestore(
        input: ActivateStateRestoreInputV1,
        control: HostRestoreActivationControl,
    ): Promise<CoreResult<StateRestoreActivationV1>>;
    applyRestoredDesktopPreferences(bytes: Uint8Array, restoreTransactionPath: string): Promise<void>;
    restoreRequiresHostReplacement(): void;
}

export interface ProductionHost {
    readonly hostInstanceId: string;
    readonly state: HostLifecycleState;
    readonly startupDisposition: HostStartupDisposition;
    readonly availableOperations: readonly ProtocolOperationName[];
    operationalHealth(): ProtocolDiagnosticsHealthV1;
    ordinaryLogSettings(): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogSettingsV1>;
    replaceOrdinaryLogSettings(
        input: ProtocolOrdinaryLogSettingsReplaceParamsV1,
    ): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogSettingsV1>;
    clearOrdinaryLog(): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogClearResultV1>;
    recordDesktopOperationalDiagnostic(code: DesktopSimpleOperationalDiagnosticCode): void;
    recordDesktopRendererOperationalDiagnostic(input: ProtocolDesktopRendererDiagnosticInputV1): void;
    openConnection(sink: HostConnectionSink): HostConnection;
    resolveStateBackupFileAction(backupId: string): string;
    recycleStateBackupFileAction(backupId: string, userActionId: string): void;
    retireMissingStateBackupFileAction(backupId: string, userActionId: string): void;
    beginExclusiveRestore(operationId: string): Promise<void>;
    drain(): Promise<void>;
    shutdown(): Promise<void>;
}
