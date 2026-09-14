import * as crypto from "node:crypto";
import { requestUtilityHostShutdown } from "./utility-host-shutdown";
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
} from "@oaam/app-server-protocol";
import {
    type DesktopHostBootOptions,
    type DesktopHostControlCommand,
    type DesktopHostControlEvent,
    parseDesktopHostControlEvent,
} from "../process/control-protocol";
import { DesktopOperationalDiagnosticQueue } from "./desktop-operational-diagnostic-queue";

export type UtilityHostSupervisorState = "stopped" | "starting" | "ready" | "draining" | "failed";

export type ObservedProjectRootResolution =
    | {
          readonly purpose: "registration";
          readonly rootPath: string;
          readonly localPathSelectionToken: string;
      }
    | { readonly purpose: "reveal"; readonly rootPath: string };

export type RegisteredProjectRootResolution =
    | { readonly purpose: "probe"; readonly rootPath: string; readonly localPathSelectionToken: string }
    | { readonly purpose: "reveal"; readonly rootPath: string };

export interface UtilityTransferPort {
    close(): void;
}

export interface UtilityProcessHandle {
    onMessage(listener: (message: unknown) => void): () => void;
    onExit(listener: (code: number) => void): () => void;
    postMessage(message: DesktopHostControlCommand, transfer?: readonly UtilityTransferPort[]): void;
    kill(): boolean;
}

export interface UtilityHostSupervisorDependencies {
    readonly spawn: () => UtilityProcessHandle;
    readonly createChannel: () => {
        readonly hostPort: UtilityTransferPort;
        readonly clientPort: UtilityTransferPort;
    };
    readonly createControlId?: () => string;
    readonly readDesktopPreferences?: () => Promise<Uint8Array>;
    readonly applyRestoredDesktopPreferences?: (bytes: Uint8Array, restoreTransactionPath: string) => Promise<void>;
    readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    readonly cancel?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface UtilityHostSupervisorOptions {
    readonly startupCheckMs?: number;
    readonly startupDeadlineMs?: number;
}

export type UtilityHostLaunchOptionsSource = DesktopHostBootOptions | (() => DesktopHostBootOptions);

export type UtilityHostSupervisorEvent =
    | {
          readonly state: "ready";
          readonly hostInstanceId: string;
          readonly reasonCode: "" | DesktopOperationalDiagnosticCode;
          readonly startupDisposition: HostStartupDisposition;
      }
    | {
          readonly state: Exclude<UtilityHostSupervisorState, "ready">;
          readonly hostInstanceId: string;
          readonly reasonCode: "" | DesktopOperationalDiagnosticCode;
      };

const SUPERVISOR_STATE_DIAGNOSTIC_CODES: Readonly<Record<UtilityHostSupervisorState, DesktopSimpleOperationalDiagnosticCode>> =
    Object.freeze({
        stopped: "desktop.host.stopped",
        starting: "desktop.host.starting",
        ready: "desktop.host.ready",
        draining: "desktop.host.draining",
        failed: "desktop.host.failed",
    });

export class UtilityHostSupervisor {
    readonly #dependencies: UtilityHostSupervisorDependencies;
    readonly #createLaunchOptions: () => DesktopHostBootOptions;
    readonly #startupCheckMs: number;
    readonly #startupDeadlineMs: number;
    readonly #listeners = new Set<(event: UtilityHostSupervisorEvent) => void>();
    readonly #pendingPathRegistrations = new Map<
        string,
        {
            readonly owner: UtilityProcessHandle;
            readonly resolve: (token: string) => void;
            readonly reject: (error: Error) => void;
            readonly timeout: ReturnType<typeof setTimeout>;
        }
    >();
    readonly #pendingObservedProjectRootResolutions = new Map<
        string,
        {
            readonly owner: UtilityProcessHandle;
            readonly purpose: ObservedProjectRootResolution["purpose"];
            readonly resolve: (result: ObservedProjectRootResolution) => void;
            readonly reject: (error: Error) => void;
            readonly timeout: ReturnType<typeof setTimeout>;
        }
    >();
    readonly #pendingRegisteredProjectRootResolutions = new Map<
        string,
        {
            readonly owner: UtilityProcessHandle;
            readonly purpose: RegisteredProjectRootResolution["purpose"];
            readonly resolve: (result: RegisteredProjectRootResolution) => void;
            readonly reject: (error: Error) => void;
            readonly timeout: ReturnType<typeof setTimeout>;
        }
    >();
    readonly #pendingImportPreviewFileResolutions = new Map<
        string,
        {
            readonly owner: UtilityProcessHandle;
            readonly resolve: (directoryPath: string) => void;
            readonly reject: (error: Error) => void;
            readonly timeout: ReturnType<typeof setTimeout>;
        }
    >();
    readonly #pendingBackupFileResolutions = new Map<
        string,
        {
            readonly owner: UtilityProcessHandle;
            readonly resolve: (archivePath: string) => void;
            readonly reject: (error: Error) => void;
            readonly timeout: ReturnType<typeof setTimeout>;
        }
    >();
    readonly #pendingBackupFileMutations = new Map<
        string,
        {
            readonly owner: UtilityProcessHandle;
            readonly resolve: () => void;
            readonly reject: (error: Error) => void;
            readonly timeout: ReturnType<typeof setTimeout>;
        }
    >();
    readonly #operationalDiagnostics = new DesktopOperationalDiagnosticQueue();
    #process: UtilityProcessHandle | undefined;
    #state: UtilityHostSupervisorState = "stopped";
    #hostInstanceId = "";
    #startupDisposition: HostStartupDisposition = Object.freeze({ mode: "normal" });
    #automaticReplacementUsed = false;
    #stopPurpose: "quit" | "restore" | undefined;
    #shutdownAcknowledged = false;
    #pendingFailureReason: "" | DesktopOperationalDiagnosticCode = "";
    #rendererConnectionKey = "";
    #startupCheckTimer: ReturnType<typeof setTimeout> | undefined;
    #startupDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    #startupCycleTerminal = false;

    public constructor(
        dependencies: UtilityHostSupervisorDependencies,
        launchOptions: UtilityHostLaunchOptionsSource,
        options: UtilityHostSupervisorOptions = {},
    ) {
        this.#dependencies = dependencies;
        this.#createLaunchOptions = typeof launchOptions === "function" ? launchOptions : () => launchOptions;
        this.#startupCheckMs = options.startupCheckMs ?? 10_000;
        this.#startupDeadlineMs = options.startupDeadlineMs ?? 30_000;
        if (
            !Number.isSafeInteger(this.#startupCheckMs) ||
            this.#startupCheckMs <= 0 ||
            !Number.isSafeInteger(this.#startupDeadlineMs) ||
            this.#startupDeadlineMs <= this.#startupCheckMs
        ) {
            throw new TypeError("Desktop Host startup timing must have a positive check before its deadline");
        }
    }

    public get state(): UtilityHostSupervisorState {
        return this.#state;
    }

    public subscribe(listener: (event: UtilityHostSupervisorEvent) => void): () => void {
        this.#listeners.add(listener);
        listener(this.#event(""));
        return () => {
            this.#listeners.delete(listener);
        };
    }

    public recordRendererDiagnostic(input: ProtocolDesktopRendererDiagnosticInputV1): void {
        this.#recordOperationalDiagnosticCommand(
            Object.freeze({ type: "record_operational_diagnostic", code: "desktop.renderer.event", ...input }),
        );
    }

    public start(): void {
        if ((this.#state !== "stopped" && this.#state !== "failed") || this.#process !== undefined) {
            throw new Error("Desktop Host supervisor is already active");
        }
        this.#stopPurpose = undefined;
        this.#shutdownAcknowledged = false;
        this.#beginStartupCycle(false);
    }

    public retry(): void {
        if (this.#state !== "failed") throw new Error("Desktop Host retry requires a failed supervisor");
        if (this.#process !== undefined) {
            throw new Error("Desktop Host retry requires the failed process to be terminated");
        }
        this.#stopPurpose = undefined;
        this.#shutdownAcknowledged = false;
        this.#beginStartupCycle(false);
    }

    public connect(options: { readonly claimPathSelectionAuthority?: boolean } = {}): UtilityTransferPort {
        if (this.#state !== "ready" || this.#process === undefined) {
            throw new Error("Desktop Host is not ready for a renderer connection");
        }
        const channel = this.#dependencies.createChannel();
        const connectionKey = this.#newControlId();
        try {
            this.#process.postMessage(Object.freeze({ type: "connect", connectionKey }), [channel.hostPort]);
            if (options.claimPathSelectionAuthority !== false) this.#rendererConnectionKey = connectionKey;
        } catch (error) {
            channel.hostPort.close();
            channel.clientPort.close();
            throw error;
        }
        return channel.clientPort;
    }

    public registerLocalPathSelection(kind: HostLocalPathSelectionKind, rootPath: string): Promise<string> {
        const owner = this.#process;
        if (this.#state !== "ready" || owner === undefined || this.#rendererConnectionKey === "") {
            return Promise.reject(new Error("Desktop Host renderer connection is unavailable"));
        }
        const requestId = this.#newControlId();
        return new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.#pendingPathRegistrations.delete(requestId);
                reject(new Error("Desktop Host path registration timed out"));
            }, 5_000);
            timeout.unref();
            this.#pendingPathRegistrations.set(requestId, { owner, resolve, reject, timeout });
            try {
                owner.postMessage(
                    Object.freeze({
                        type: "register_local_path",
                        requestId,
                        connectionKey: this.#rendererConnectionKey,
                        kind,
                        rootPath,
                    }),
                );
            } catch {
                clearTimeout(timeout);
                this.#pendingPathRegistrations.delete(requestId);
                reject(new Error("Desktop Host path registration could not be delivered"));
            }
        });
    }

    public resolveObservedProjectRoot(
        purpose: ObservedProjectRootResolution["purpose"],
        reference: HostObservedProjectRootReference,
    ): Promise<ObservedProjectRootResolution> {
        const owner = this.#process;
        if (this.#state !== "ready" || owner === undefined || this.#rendererConnectionKey === "") {
            return Promise.reject(new Error("Desktop Host renderer connection is unavailable"));
        }
        const requestId = this.#newControlId();
        return new Promise<ObservedProjectRootResolution>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.#pendingObservedProjectRootResolutions.delete(requestId);
                reject(new Error("Desktop Host observed Project root resolution timed out"));
            }, 5_000);
            timeout.unref();
            this.#pendingObservedProjectRootResolutions.set(requestId, { owner, purpose, resolve, reject, timeout });
            try {
                owner.postMessage(
                    Object.freeze({
                        type: "resolve_observed_project_root",
                        requestId,
                        connectionKey: this.#rendererConnectionKey,
                        purpose,
                        reference,
                    }),
                );
            } catch {
                clearTimeout(timeout);
                this.#pendingObservedProjectRootResolutions.delete(requestId);
                reject(new Error("Desktop Host observed Project root resolution could not be delivered"));
            }
        });
    }

    public resolveRegisteredProjectRoot(
        purpose: RegisteredProjectRootResolution["purpose"],
        projectId: string,
    ): Promise<RegisteredProjectRootResolution> {
        const owner = this.#process;
        if (this.#state !== "ready" || owner === undefined || this.#rendererConnectionKey === "") {
            return Promise.reject(new Error("Desktop Host renderer connection is unavailable"));
        }
        const requestId = this.#newControlId();
        return new Promise<RegisteredProjectRootResolution>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.#pendingRegisteredProjectRootResolutions.delete(requestId);
                reject(new Error("Desktop Host registered Project root resolution timed out"));
            }, 5_000);
            timeout.unref();
            this.#pendingRegisteredProjectRootResolutions.set(requestId, { owner, purpose, resolve, reject, timeout });
            try {
                owner.postMessage(
                    Object.freeze({
                        type: "resolve_registered_project_root",
                        requestId,
                        connectionKey: this.#rendererConnectionKey,
                        purpose,
                        projectId,
                    }),
                );
            } catch {
                clearTimeout(timeout);
                this.#pendingRegisteredProjectRootResolutions.delete(requestId);
                reject(new Error("Desktop Host registered Project root resolution could not be delivered"));
            }
        });
    }

    public resolveImportPreviewFileDirectory(reference: HostImportPreviewFileReference): Promise<string> {
        const owner = this.#process;
        if (this.#state !== "ready" || owner === undefined || this.#rendererConnectionKey === "") {
            return Promise.reject(new Error("Desktop Host renderer connection is unavailable"));
        }
        const requestId = this.#newControlId();
        return new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.#pendingImportPreviewFileResolutions.delete(requestId);
                reject(new Error("Desktop Host import-preview file resolution timed out"));
            }, 5_000);
            timeout.unref();
            this.#pendingImportPreviewFileResolutions.set(requestId, { owner, resolve, reject, timeout });
            try {
                owner.postMessage(
                    Object.freeze({
                        type: "resolve_import_preview_file_directory",
                        requestId,
                        connectionKey: this.#rendererConnectionKey,
                        reference,
                    }),
                );
            } catch {
                clearTimeout(timeout);
                this.#pendingImportPreviewFileResolutions.delete(requestId);
                reject(new Error("Desktop Host import-preview file resolution could not be delivered"));
            }
        });
    }

    public resolveStateBackupFile(backupId: string): Promise<string> {
        const owner = this.#process;
        if (this.#state !== "ready" || owner === undefined) {
            return Promise.reject(new Error("Desktop Host is not ready to resolve a State backup file"));
        }
        const requestId = this.#newControlId();
        return new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.#pendingBackupFileResolutions.delete(requestId);
                reject(new Error("Desktop Host backup file resolution timed out"));
            }, 5_000);
            timeout.unref();
            this.#pendingBackupFileResolutions.set(requestId, { owner, resolve, reject, timeout });
            try {
                owner.postMessage(Object.freeze({ type: "resolve_state_backup_file", requestId, backupId }));
            } catch {
                clearTimeout(timeout);
                this.#pendingBackupFileResolutions.delete(requestId);
                reject(new Error("Desktop Host backup file resolution could not be delivered"));
            }
        });
    }

    public mutateStateBackupFile(
        backupId: string,
        action: "identity_bound_trash" | "retire_missing",
        userActionId: string,
    ): Promise<void> {
        const owner = this.#process;
        if (this.#state !== "ready" || owner === undefined) {
            return Promise.reject(new Error("Desktop Host is not ready to mutate a State backup file"));
        }
        const requestId = this.#newControlId();
        return new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.#pendingBackupFileMutations.delete(requestId);
                reject(new Error("Desktop Host backup file mutation timed out"));
            }, 5_000);
            timeout.unref();
            this.#pendingBackupFileMutations.set(requestId, { owner, resolve, reject, timeout });
            try {
                owner.postMessage(
                    Object.freeze({
                        type: "mutate_state_backup_file",
                        requestId,
                        backupId,
                        action,
                        userActionId,
                    }),
                );
            } catch {
                clearTimeout(timeout);
                this.#pendingBackupFileMutations.delete(requestId);
                reject(new Error("Desktop Host backup file mutation could not be delivered"));
            }
        });
    }

    public drain(): void {
        const owner = this.#process;
        if (this.#state !== "ready" || owner === undefined) return;
        this.#state = "draining";
        this.#emit("");
        this.#recordOperationalDiagnostic(SUPERVISOR_STATE_DIAGNOSTIC_CODES.draining);
        try {
            owner.postMessage(Object.freeze({ type: "drain" }));
        } catch {
            this.#terminateFailedProcess(owner, "host.drain_delivery_failed");
        }
    }

    public shutdown(): void {
        if (this.#stopPurpose === "quit") return;
        if (this.#stopPurpose === "restore") {
            this.#stopPurpose = "quit";
            return;
        }
        this.#stopPurpose = "quit";
        this.#clearStartupTimers();
        requestUtilityHostShutdown(this.#process, (state, reason) => this.#transition(state, reason));
    }

    #beginStartupCycle(automaticReplacementUsed: boolean): void {
        this.#clearStartupTimers();
        this.#automaticReplacementUsed = automaticReplacementUsed;
        this.#startupCycleTerminal = false;
        this.#startupDeadlineTimer = this.#schedule(() => {
            this.#startupDeadlineTimer = undefined;
            this.#startupDeadlineReached();
        }, this.#startupDeadlineMs);
        this.#startProcess();
    }

    #startProcess(): void {
        this.#state = "starting";
        this.#hostInstanceId = "";
        this.#rendererConnectionKey = "";
        this.#pendingFailureReason = "";
        this.#emit(this.#automaticReplacementUsed ? "host.startup_recovering" : "");
        this.#recordOperationalDiagnostic(SUPERVISOR_STATE_DIAGNOSTIC_CODES.starting);
        if (this.#automaticReplacementUsed) this.#recordOperationalDiagnostic("host.startup_recovering");
        let launchOptions: DesktopHostBootOptions;
        try {
            launchOptions = this.#createLaunchOptions();
        } catch {
            this.#handleSpawnFailure();
            return;
        }
        let processHandle: UtilityProcessHandle;
        try {
            processHandle = this.#dependencies.spawn();
        } catch {
            this.#handleSpawnFailure();
            return;
        }
        this.#process = processHandle;
        processHandle.onMessage((message) => this.#receive(message, processHandle));
        processHandle.onExit((code) => this.#handleExit(code, processHandle));
        try {
            processHandle.postMessage(Object.freeze({ type: "boot", options: launchOptions }));
        } catch {
            this.#terminateFailedProcess(processHandle, "host.boot_delivery_failed");
            return;
        }
        if (processHandle === this.#process && this.#state === "starting") this.#scheduleStartupCheck(processHandle);
    }

    #receive(message: unknown, owner: UtilityProcessHandle): void {
        if (owner !== this.#process) return;
        let event: DesktopHostControlEvent;
        try {
            event = parseDesktopHostControlEvent(message);
        } catch {
            this.#terminateFailedProcess(owner, "host.invalid_control_event");
            return;
        }
        if (event.type === "ready") {
            if (this.#state !== "starting") {
                this.#terminateFailedProcess(owner, "host.unexpected_ready");
                return;
            }
            this.#clearStartupTimers();
            this.#startupCycleTerminal = false;
            this.#automaticReplacementUsed = false;
            this.#hostInstanceId = event.hostInstanceId;
            this.#startupDisposition = event.startupDisposition;
            this.#transition("ready", "");
            return;
        }
        if (event.type === "local_path_registered" || event.type === "local_path_registration_failed") {
            const pending = this.#pendingPathRegistrations.get(event.requestId);
            if (pending === undefined || pending.owner !== owner) {
                this.#terminateFailedProcess(owner, "host.unexpected_path_registration_result");
                return;
            }
            clearTimeout(pending.timeout);
            this.#pendingPathRegistrations.delete(event.requestId);
            if (event.type === "local_path_registered") pending.resolve(event.token);
            else pending.reject(new Error(event.code));
            return;
        }
        if (event.type === "observed_project_root_resolved" || event.type === "observed_project_root_resolution_failed") {
            const pending = this.#pendingObservedProjectRootResolutions.get(event.requestId);
            if (pending === undefined || pending.owner !== owner) {
                this.#terminateFailedProcess(owner, "host.unexpected_path_registration_result");
                return;
            }
            clearTimeout(pending.timeout);
            this.#pendingObservedProjectRootResolutions.delete(event.requestId);
            if (event.type === "observed_project_root_resolution_failed") {
                pending.reject(new Error(event.code));
                return;
            }
            if (event.purpose !== pending.purpose) {
                this.#terminateFailedProcess(owner, "host.unexpected_path_registration_result");
                return;
            }
            if (event.purpose === "registration") {
                pending.resolve({
                    purpose: "registration",
                    rootPath: event.rootPath,
                    localPathSelectionToken: event.localPathSelectionToken as string,
                });
            } else {
                pending.resolve({ purpose: "reveal", rootPath: event.rootPath });
            }
            return;
        }
        if (event.type === "registered_project_root_resolved" || event.type === "registered_project_root_resolution_failed") {
            const pending = this.#pendingRegisteredProjectRootResolutions.get(event.requestId);
            if (pending === undefined || pending.owner !== owner) {
                this.#terminateFailedProcess(owner, "host.unexpected_path_registration_result");
                return;
            }
            clearTimeout(pending.timeout);
            this.#pendingRegisteredProjectRootResolutions.delete(event.requestId);
            if (event.type === "registered_project_root_resolution_failed") {
                pending.reject(new Error(event.code));
                return;
            }
            if (event.purpose !== pending.purpose) {
                this.#terminateFailedProcess(owner, "host.unexpected_path_registration_result");
                return;
            }
            pending.resolve(
                event.purpose === "probe"
                    ? {
                          purpose: "probe",
                          rootPath: event.rootPath,
                          localPathSelectionToken: event.localPathSelectionToken as string,
                      }
                    : { purpose: "reveal", rootPath: event.rootPath },
            );
            return;
        }
        if (
            event.type === "import_preview_file_directory_resolved" ||
            event.type === "import_preview_file_directory_resolution_failed"
        ) {
            const pending = this.#pendingImportPreviewFileResolutions.get(event.requestId);
            if (pending === undefined || pending.owner !== owner) {
                this.#terminateFailedProcess(owner, "host.unexpected_path_registration_result");
                return;
            }
            clearTimeout(pending.timeout);
            this.#pendingImportPreviewFileResolutions.delete(event.requestId);
            if (event.type === "import_preview_file_directory_resolved") pending.resolve(event.directoryPath);
            else pending.reject(new Error(event.code));
            return;
        }
        if (event.type === "desktop_preferences_read_requested") {
            void this.#answerDesktopPreferenceRead(owner, event.requestId);
            return;
        }
        if (event.type === "desktop_preferences_restore_requested") {
            void this.#answerDesktopPreferenceRestore(owner, event.requestId, event.bytes, event.restoreTransactionPath);
            return;
        }
        if (event.type === "state_backup_file_resolved" || event.type === "state_backup_file_resolution_failed") {
            const pending = this.#pendingBackupFileResolutions.get(event.requestId);
            if (pending === undefined || pending.owner !== owner) {
                this.#terminateFailedProcess(owner, "host.unexpected_backup_file_resolution");
                return;
            }
            clearTimeout(pending.timeout);
            this.#pendingBackupFileResolutions.delete(event.requestId);
            if (event.type === "state_backup_file_resolved") pending.resolve(event.archivePath);
            else pending.reject(new Error(event.code));
            return;
        }
        if (event.type === "state_backup_file_mutation_complete" || event.type === "state_backup_file_mutation_failed") {
            const pending = this.#pendingBackupFileMutations.get(event.requestId);
            if (pending === undefined || pending.owner !== owner) {
                this.#terminateFailedProcess(owner, "host.unexpected_backup_file_mutation");
                return;
            }
            clearTimeout(pending.timeout);
            this.#pendingBackupFileMutations.delete(event.requestId);
            if (event.type === "state_backup_file_mutation_complete") pending.resolve();
            else pending.reject(new Error(event.code));
            return;
        }
        if (event.type === "restore_replacement_required") {
            if (this.#state !== "ready") {
                this.#terminateFailedProcess(owner, "host.unexpected_restore_replacement");
                return;
            }
            this.#stopPurpose = "restore";
            this.#shutdownAcknowledged = false;
            requestUtilityHostShutdown(owner, (state, reason) =>
                this.#transition(state, state === "draining" ? "host.restore_restarting" : reason),
            );
            this.#recordOperationalDiagnostic("host.restore_restarting");
            return;
        }
        if (event.type === "drained") {
            if (this.#state === "draining") this.#emit("");
            return;
        }
        if (event.type === "stopped") {
            if (this.#stopPurpose === undefined) {
                this.#terminateFailedProcess(owner, "host.unexpected_stopped");
                return;
            }
            this.#shutdownAcknowledged = true;
            this.#rejectTerminatedRequests(owner, "stopped");
            return;
        }
        if (this.#stopPurpose !== undefined) {
            this.#pendingFailureReason = event.code;
            this.#transition("failed", event.code);
        } else this.#terminateFailedProcess(owner, event.code);
    }

    #handleExit(code: number, owner: UtilityProcessHandle): void {
        if (owner !== this.#process) return;
        const stateBeforeExit = this.#state;
        this.#clearStartupCheck();
        this.#rejectTerminatedRequests(owner, "exited");
        const failureReason = this.#pendingFailureReason;
        this.#pendingFailureReason = "";
        this.#process = undefined;
        this.#hostInstanceId = "";
        if (this.#stopPurpose !== undefined) {
            this.#clearStartupTimers();
            if (!this.#shutdownAcknowledged) {
                this.#transition("failed", failureReason === "" ? "host.unexpected_exit" : failureReason);
            } else if (this.#stopPurpose === "restore") {
                this.#stopPurpose = undefined;
                this.#shutdownAcknowledged = false;
                this.#beginStartupCycle(true);
            } else this.#transition("stopped", "");
            return;
        }
        if (this.#startupCycleTerminal) {
            this.#clearStartupTimers();
            this.#transition("failed", failureReason === "" ? "host.startup_timeout" : failureReason);
            return;
        }
        if (stateBeforeExit === "ready" || stateBeforeExit === "draining") {
            this.#beginStartupCycle(true);
            return;
        }
        if (!this.#automaticReplacementUsed) {
            this.#automaticReplacementUsed = true;
            this.#startProcess();
            return;
        }
        this.#clearStartupTimers();
        this.#transition(
            "failed",
            failureReason === "" ? (code === 0 ? "host.unexpected_exit" : "host.process_failed") : failureReason,
        );
    }

    #terminateFailedProcess(owner: UtilityProcessHandle, reasonCode: DesktopOperationalDiagnosticCode): void {
        if (owner !== this.#process) return;
        if (this.#startupCycleTerminal) {
            owner.kill();
            return;
        }
        this.#clearStartupCheck();
        this.#pendingFailureReason = reasonCode;
        this.#state = "starting";
        this.#hostInstanceId = "";
        this.#rendererConnectionKey = "";
        this.#emit(reasonCode);
        if (isDesktopSimpleOperationalDiagnosticCode(reasonCode)) this.#recordOperationalDiagnostic(reasonCode);
        if (!owner.kill()) {
            this.#rejectTerminatedRequests(owner, "failed");
            this.#startupCycleTerminal = true;
            this.#clearStartupTimers();
            this.#pendingFailureReason = "host.process_termination_failed";
            this.#transition("failed", "host.process_termination_failed");
        }
    }

    #rejectTerminatedRequests(owner: UtilityProcessHandle, terminal: "stopped" | "exited" | "failed"): void {
        const prefix = `Desktop Host ${terminal} before`;
        this.#rejectPending(owner, `${prefix} path registration completed`);
        this.#rejectObservedProjectRootResolutions(owner, `${prefix} observed Project root resolution completed`);
        this.#rejectRegisteredProjectRootResolutions(owner, `${prefix} registered Project root resolution completed`);
        this.#rejectImportPreviewFileResolutions(owner, `${prefix} import-preview file resolution completed`);
        this.#rejectBackupFileResolutions(owner, `${prefix} backup file resolution completed`);
        this.#rejectBackupFileMutations(owner, `${prefix} backup file mutation completed`);
    }

    #handleSpawnFailure(): void {
        if (!this.#automaticReplacementUsed) {
            this.#automaticReplacementUsed = true;
            this.#startProcess();
            return;
        }
        this.#clearStartupTimers();
        this.#transition("failed", "host.process_spawn_failed");
    }

    #scheduleStartupCheck(owner: UtilityProcessHandle): void {
        this.#clearStartupCheck();
        this.#startupCheckTimer = this.#schedule(() => {
            this.#startupCheckTimer = undefined;
            if (owner === this.#process && this.#state === "starting" && !this.#startupCycleTerminal) {
                this.#terminateFailedProcess(owner, "host.startup_liveness_timeout");
            }
        }, this.#startupCheckMs);
    }

    #startupDeadlineReached(): void {
        if (this.#state !== "starting" || this.#startupCycleTerminal) return;
        this.#startupCycleTerminal = true;
        this.#pendingFailureReason = "host.startup_timeout";
        this.#clearStartupCheck();
        this.#transition("failed", "host.startup_timeout");
        const owner = this.#process;
        if (owner !== undefined && !owner.kill()) {
            this.#pendingFailureReason = "host.process_termination_failed";
            this.#transition("failed", "host.process_termination_failed");
        }
    }

    #schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
        const handle = (this.#dependencies.schedule ?? setTimeout)(callback, delayMs);
        handle.unref?.();
        return handle;
    }

    #clearStartupCheck(): void {
        if (this.#startupCheckTimer === undefined) return;
        (this.#dependencies.cancel ?? clearTimeout)(this.#startupCheckTimer);
        this.#startupCheckTimer = undefined;
    }

    #clearStartupTimers(): void {
        this.#clearStartupCheck();
        if (this.#startupDeadlineTimer === undefined) return;
        (this.#dependencies.cancel ?? clearTimeout)(this.#startupDeadlineTimer);
        this.#startupDeadlineTimer = undefined;
    }

    #transition(state: UtilityHostSupervisorState, reasonCode: "" | DesktopOperationalDiagnosticCode): void {
        this.#state = state;
        if (state !== "ready") {
            this.#hostInstanceId = "";
            this.#rendererConnectionKey = "";
            this.#startupDisposition = Object.freeze({ mode: "normal" });
        }
        this.#emit(reasonCode);
        this.#recordOperationalDiagnostic(SUPERVISOR_STATE_DIAGNOSTIC_CODES[state]);
        if (isDesktopSimpleOperationalDiagnosticCode(reasonCode)) this.#recordOperationalDiagnostic(reasonCode);
    }

    #emit(reasonCode: "" | DesktopOperationalDiagnosticCode): void {
        const event = this.#event(reasonCode);
        for (const listener of this.#listeners) listener(event);
    }

    #event(reasonCode: "" | DesktopOperationalDiagnosticCode): UtilityHostSupervisorEvent {
        return this.#state === "ready"
            ? Object.freeze({
                  state: "ready",
                  hostInstanceId: this.#hostInstanceId,
                  reasonCode,
                  startupDisposition: this.#startupDisposition,
              })
            : Object.freeze({
                  state: this.#state,
                  hostInstanceId: this.#hostInstanceId,
                  reasonCode,
              });
    }

    #recordOperationalDiagnostic(code: DesktopSimpleOperationalDiagnosticCode): void {
        this.#recordOperationalDiagnosticCommand({ type: "record_operational_diagnostic", code });
    }

    #recordOperationalDiagnosticCommand(
        command: Extract<DesktopHostControlCommand, { readonly type: "record_operational_diagnostic" }>,
    ): void {
        const owner = this.#process;
        this.#operationalDiagnostics.record(
            (this.#state === "ready" || this.#state === "draining") && owner !== undefined ? owner : undefined,
            Object.freeze(command),
        );
    }

    #newControlId(): string {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const candidate = (this.#dependencies.createControlId ?? crypto.randomUUID)();
            if (
                candidate.length > 0 &&
                candidate.trim() === candidate &&
                !candidate.includes("\0") &&
                !this.#pendingPathRegistrations.has(candidate) &&
                !this.#pendingObservedProjectRootResolutions.has(candidate) &&
                !this.#pendingRegisteredProjectRootResolutions.has(candidate) &&
                !this.#pendingImportPreviewFileResolutions.has(candidate) &&
                !this.#pendingBackupFileResolutions.has(candidate) &&
                !this.#pendingBackupFileMutations.has(candidate)
            ) {
                return candidate;
            }
        }
        throw new Error("Desktop Host supervisor could not allocate a control id");
    }

    #rejectPending(owner: UtilityProcessHandle, message: string): void {
        for (const [requestId, pending] of this.#pendingPathRegistrations) {
            if (pending.owner !== owner) continue;
            clearTimeout(pending.timeout);
            this.#pendingPathRegistrations.delete(requestId);
            pending.reject(new Error(message));
        }
    }

    #rejectObservedProjectRootResolutions(owner: UtilityProcessHandle, message: string): void {
        for (const [requestId, pending] of this.#pendingObservedProjectRootResolutions) {
            if (pending.owner !== owner) continue;
            clearTimeout(pending.timeout);
            this.#pendingObservedProjectRootResolutions.delete(requestId);
            pending.reject(new Error(message));
        }
    }

    #rejectRegisteredProjectRootResolutions(owner: UtilityProcessHandle, message: string): void {
        for (const [requestId, pending] of this.#pendingRegisteredProjectRootResolutions) {
            if (pending.owner !== owner) continue;
            clearTimeout(pending.timeout);
            this.#pendingRegisteredProjectRootResolutions.delete(requestId);
            pending.reject(new Error(message));
        }
    }

    #rejectImportPreviewFileResolutions(owner: UtilityProcessHandle, message: string): void {
        for (const [requestId, pending] of this.#pendingImportPreviewFileResolutions) {
            if (pending.owner !== owner) continue;
            clearTimeout(pending.timeout);
            this.#pendingImportPreviewFileResolutions.delete(requestId);
            pending.reject(new Error(message));
        }
    }

    async #answerDesktopPreferenceRead(owner: UtilityProcessHandle, requestId: string): Promise<void> {
        let result: DesktopHostControlCommand;
        try {
            const read = this.#dependencies.readDesktopPreferences;
            if (read === undefined) throw new Error("Desktop preference owner is unavailable");
            const bytes = await read();
            if (owner !== this.#process) return;
            result = Object.freeze({
                type: "desktop_preferences_read_result",
                requestId,
                status: "complete",
                bytes: new Uint8Array(bytes),
            });
        } catch {
            if (owner !== this.#process) return;
            result = Object.freeze({
                type: "desktop_preferences_read_result",
                requestId,
                status: "failed",
                code: "desktop.preferences_read_failed",
            });
        }
        this.#deliverDesktopPreferenceResult(owner, result);
    }

    async #answerDesktopPreferenceRestore(
        owner: UtilityProcessHandle,
        requestId: string,
        bytes: Uint8Array,
        restoreTransactionPath: string,
    ): Promise<void> {
        let result: DesktopHostControlCommand;
        try {
            const apply = this.#dependencies.applyRestoredDesktopPreferences;
            if (apply === undefined) throw new Error("Desktop preference owner is unavailable");
            await apply(new Uint8Array(bytes), restoreTransactionPath);
            if (owner !== this.#process) return;
            result = Object.freeze({
                type: "desktop_preferences_restore_result",
                requestId,
                status: "complete",
            });
        } catch {
            if (owner !== this.#process) return;
            result = Object.freeze({
                type: "desktop_preferences_restore_result",
                requestId,
                status: "failed",
                code: "desktop.preferences_restore_failed",
            });
        }
        this.#deliverDesktopPreferenceResult(owner, result);
    }

    #deliverDesktopPreferenceResult(owner: UtilityProcessHandle, result: DesktopHostControlCommand): void {
        try {
            owner.postMessage(result);
        } catch {
            if (owner !== this.#process) return;
            this.#terminateFailedProcess(owner, "host.desktop_preferences_reply_failed");
        }
    }

    #rejectBackupFileResolutions(owner: UtilityProcessHandle, message: string): void {
        for (const [requestId, pending] of this.#pendingBackupFileResolutions) {
            if (pending.owner !== owner) continue;
            clearTimeout(pending.timeout);
            this.#pendingBackupFileResolutions.delete(requestId);
            pending.reject(new Error(message));
        }
    }

    #rejectBackupFileMutations(owner: UtilityProcessHandle, message: string): void {
        for (const [requestId, pending] of this.#pendingBackupFileMutations) {
            if (pending.owner !== owner) continue;
            clearTimeout(pending.timeout);
            this.#pendingBackupFileMutations.delete(requestId);
            pending.reject(new Error(message));
        }
    }
}
