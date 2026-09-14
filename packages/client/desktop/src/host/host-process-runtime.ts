import * as crypto from "node:crypto";
import type { ProductionHostLaunchOptions } from "@oaam/app-server-bootstrap";
import type { ProductionHost } from "@oaam/app-server-host";
import {
    type DesktopHostControlCommand,
    type DesktopHostControlEvent,
    type DesktopHostFailurePhase,
    parseDesktopHostControlCommand,
} from "../process/control-protocol";
import { bindHostConnection, type HostMessagePort } from "./host-connection";

export interface HostParentPort {
    on(event: "message", listener: (event: { readonly data: unknown; readonly ports: readonly HostMessagePort[] }) => void): this;
    postMessage(message: DesktopHostControlEvent): void;
}

export interface HostProcessRuntimeDependencies {
    readonly launchHost: (options: ProductionHostLaunchOptions) => ProductionHost;
    readonly stopProcess: () => void;
    readonly createControlId?: () => string;
}

interface PendingDesktopPreferenceRequest<T> {
    readonly resolve: (value: T) => void;
    readonly reject: (error: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
}

export class HostProcessRuntime {
    readonly #parentPort: HostParentPort;
    readonly #dependencies: HostProcessRuntimeDependencies;
    readonly #connections = new Map<string, ReturnType<typeof bindHostConnection>>();
    readonly #preferenceReads = new Map<string, PendingDesktopPreferenceRequest<Uint8Array>>();
    readonly #preferenceRestores = new Map<string, PendingDesktopPreferenceRequest<void>>();
    #host: ProductionHost | undefined;
    #handling = Promise.resolve();

    public constructor(parentPort: HostParentPort, dependencies: HostProcessRuntimeDependencies) {
        this.#parentPort = parentPort;
        this.#dependencies = dependencies;
    }

    public start(): void {
        this.#parentPort.on("message", (event) => {
            this.#handling = this.#handling
                .then(() => this.#handle(event))
                .catch(() => {
                    for (const port of event.ports) port.close();
                    this.#reportFailure("control", "host.control_failed");
                });
        });
    }

    async #handle(event: { readonly data: unknown; readonly ports: readonly HostMessagePort[] }): Promise<void> {
        let command: DesktopHostControlCommand;
        try {
            command = parseDesktopHostControlCommand(event.data);
        } catch {
            for (const port of event.ports) port.close();
            this.#reportFailure("control", "host.invalid_control_message");
            return;
        }
        if (command.type === "boot") {
            if (this.#host !== undefined || event.ports.length !== 0) {
                for (const port of event.ports) port.close();
                this.#reportFailure("startup", "host.duplicate_boot");
                return;
            }
            try {
                this.#host = this.#dependencies.launchHost({
                    ...command.options,
                    desktopPreferences: {
                        read: () => this.#requestDesktopPreferences(),
                        applyRestored: (bytes, restoreTransactionPath) =>
                            this.#requestDesktopPreferenceRestore(bytes, restoreTransactionPath),
                    },
                    restoreRequiresHostReplacement: () => {
                        this.#parentPort.postMessage(Object.freeze({ type: "restore_replacement_required" }));
                    },
                });
                this.#parentPort.postMessage(
                    Object.freeze({
                        type: "ready",
                        hostInstanceId: this.#host.hostInstanceId,
                        startupDisposition: this.#host.startupDisposition,
                    }),
                );
            } catch {
                this.#reportFailure("startup", "host.startup_failed");
            }
            return;
        }
        if (command.type === "desktop_preferences_read_result") {
            if (event.ports.length !== 0) {
                for (const port of event.ports) port.close();
                this.#reportFailure("control", "host.preference_read_result_invalid");
                return;
            }
            const pending = this.#preferenceReads.get(command.requestId);
            if (pending === undefined) {
                this.#reportFailure("control", "host.preference_read_result_unexpected");
                return;
            }
            clearTimeout(pending.timeout);
            this.#preferenceReads.delete(command.requestId);
            if (command.status === "complete") pending.resolve(new Uint8Array(command.bytes));
            else pending.reject(new Error(command.code));
            return;
        }
        if (command.type === "desktop_preferences_restore_result") {
            if (event.ports.length !== 0) {
                for (const port of event.ports) port.close();
                this.#reportFailure("control", "host.preference_restore_result_invalid");
                return;
            }
            const pending = this.#preferenceRestores.get(command.requestId);
            if (pending === undefined) {
                this.#reportFailure("control", "host.preference_restore_result_unexpected");
                return;
            }
            clearTimeout(pending.timeout);
            this.#preferenceRestores.delete(command.requestId);
            if (command.status === "complete") pending.resolve();
            else pending.reject(new Error(command.code));
            return;
        }
        if (command.type === "record_operational_diagnostic") {
            for (const port of event.ports) port.close();
            if (event.ports.length !== 0 || this.#host === undefined) return;
            try {
                if (command.code === "desktop.renderer.event") {
                    this.#host.recordDesktopRendererOperationalDiagnostic({
                        event: command.event,
                        failureKind: command.failureKind,
                        surface: command.surface,
                        componentTrail: command.componentTrail,
                    });
                } else {
                    this.#host.recordDesktopOperationalDiagnostic(command.code);
                }
            } catch {
                // Operational logging cannot take down the Host process.
            }
            return;
        }
        if (command.type === "connect") {
            const [port] = event.ports;
            if (
                this.#host?.state !== "ready" ||
                event.ports.length !== 1 ||
                port === undefined ||
                this.#connections.has(command.connectionKey)
            ) {
                for (const port of event.ports) port.close();
                this.#reportFailure("connection", "host.connection_unavailable");
                return;
            }
            try {
                const connection = bindHostConnection(this.#host, port);
                this.#connections.set(command.connectionKey, connection);
                port.on("close", () => {
                    if (this.#connections.get(command.connectionKey) === connection) {
                        this.#connections.delete(command.connectionKey);
                    }
                });
            } catch {
                port.close();
                this.#reportFailure("connection", "host.connection_failed");
            }
            return;
        }
        if (command.type === "resolve_state_backup_file") {
            if (event.ports.length !== 0 || this.#host?.state !== "ready") {
                for (const port of event.ports) port.close();
                this.#reportStateBackupFileFailure(command.requestId, "host.state_backup_file_unavailable");
                return;
            }
            try {
                const archivePath = this.#host.resolveStateBackupFileAction(command.backupId);
                this.#parentPort.postMessage(
                    Object.freeze({
                        type: "state_backup_file_resolved",
                        requestId: command.requestId,
                        archivePath,
                    }),
                );
            } catch {
                this.#reportStateBackupFileFailure(command.requestId, "host.state_backup_file_resolution_failed");
            }
            return;
        }
        if (command.type === "mutate_state_backup_file") {
            if (event.ports.length !== 0 || this.#host?.state !== "ready") {
                for (const port of event.ports) port.close();
                this.#reportStateBackupFileMutationFailure(command.requestId, "host.state_backup_file_unavailable");
                return;
            }
            try {
                if (command.action === "identity_bound_trash") {
                    this.#host.recycleStateBackupFileAction(command.backupId, command.userActionId);
                } else {
                    this.#host.retireMissingStateBackupFileAction(command.backupId, command.userActionId);
                }
                this.#parentPort.postMessage(
                    Object.freeze({
                        type: "state_backup_file_mutation_complete",
                        requestId: command.requestId,
                    }),
                );
            } catch {
                this.#reportStateBackupFileMutationFailure(command.requestId, "host.state_backup_file_mutation_failed");
            }
            return;
        }
        if (command.type === "register_local_path") {
            if (event.ports.length !== 0 || this.#host?.state !== "ready") {
                for (const port of event.ports) port.close();
                this.#reportLocalPathFailure(command.requestId, "host.path_registration_unavailable");
                return;
            }
            const connection = this.#connections.get(command.connectionKey);
            if (connection === undefined) {
                this.#reportLocalPathFailure(command.requestId, "host.path_connection_unavailable");
                return;
            }
            try {
                const token = connection.registerLocalPathSelection(command.kind, command.rootPath);
                this.#parentPort.postMessage(
                    Object.freeze({
                        type: "local_path_registered",
                        requestId: command.requestId,
                        token,
                    }),
                );
            } catch {
                this.#reportLocalPathFailure(command.requestId, "host.path_registration_failed");
            }
            return;
        }
        if (command.type === "resolve_observed_project_root") {
            if (event.ports.length !== 0 || this.#host?.state !== "ready") {
                for (const port of event.ports) port.close();
                this.#parentPort.postMessage(
                    Object.freeze({
                        type: "observed_project_root_resolution_failed",
                        requestId: command.requestId,
                        code: "host.observed_project_root_unavailable",
                    }),
                );
                return;
            }
            const connection = this.#connections.get(command.connectionKey);
            if (connection === undefined) {
                this.#parentPort.postMessage(
                    Object.freeze({
                        type: "observed_project_root_resolution_failed",
                        requestId: command.requestId,
                        code: "host.observed_project_root_connection_unavailable",
                    }),
                );
                return;
            }
            try {
                if (command.purpose === "registration") {
                    const resolved = connection.authorizeObservedProjectRootRegistration(command.reference);
                    this.#parentPort.postMessage(
                        Object.freeze({
                            type: "observed_project_root_resolved",
                            requestId: command.requestId,
                            purpose: "registration",
                            rootPath: resolved.rootPath,
                            localPathSelectionToken: resolved.localPathSelectionToken,
                        }),
                    );
                } else {
                    this.#parentPort.postMessage(
                        Object.freeze({
                            type: "observed_project_root_resolved",
                            requestId: command.requestId,
                            purpose: "reveal",
                            rootPath: connection.resolveObservedProjectRoot(command.reference),
                        }),
                    );
                }
            } catch {
                this.#parentPort.postMessage(
                    Object.freeze({
                        type: "observed_project_root_resolution_failed",
                        requestId: command.requestId,
                        code: "host.observed_project_root_resolution_failed",
                    }),
                );
            }
            return;
        }
        if (command.type === "resolve_registered_project_root") {
            if (event.ports.length !== 0 || this.#host?.state !== "ready") {
                for (const port of event.ports) port.close();
                this.#parentPort.postMessage(
                    Object.freeze({
                        type: "registered_project_root_resolution_failed",
                        requestId: command.requestId,
                        code: "host.registered_project_root_unavailable",
                    }),
                );
                return;
            }
            const connection = this.#connections.get(command.connectionKey);
            if (connection === undefined) {
                this.#parentPort.postMessage(
                    Object.freeze({
                        type: "registered_project_root_resolution_failed",
                        requestId: command.requestId,
                        code: "host.registered_project_root_connection_unavailable",
                    }),
                );
                return;
            }
            try {
                const projectId = command.projectId as Parameters<typeof connection.resolveRegisteredProjectRoot>[0];
                if (command.purpose === "probe") {
                    const resolved = connection.authorizeRegisteredProjectRootProbe(projectId);
                    this.#parentPort.postMessage(
                        Object.freeze({
                            type: "registered_project_root_resolved",
                            requestId: command.requestId,
                            purpose: "probe",
                            rootPath: resolved.rootPath,
                            localPathSelectionToken: resolved.localPathSelectionToken,
                        }),
                    );
                } else {
                    this.#parentPort.postMessage(
                        Object.freeze({
                            type: "registered_project_root_resolved",
                            requestId: command.requestId,
                            purpose: "reveal",
                            rootPath: connection.resolveRegisteredProjectRoot(projectId),
                        }),
                    );
                }
            } catch {
                this.#parentPort.postMessage(
                    Object.freeze({
                        type: "registered_project_root_resolution_failed",
                        requestId: command.requestId,
                        code: "host.registered_project_root_resolution_failed",
                    }),
                );
            }
            return;
        }
        if (command.type === "resolve_import_preview_file_directory") {
            if (event.ports.length !== 0 || this.#host?.state !== "ready") {
                for (const port of event.ports) port.close();
                this.#parentPort.postMessage(
                    Object.freeze({
                        type: "import_preview_file_directory_resolution_failed",
                        requestId: command.requestId,
                        code: "host.import_preview_file_unavailable",
                    }),
                );
                return;
            }
            const connection = this.#connections.get(command.connectionKey);
            if (connection === undefined) {
                this.#parentPort.postMessage(
                    Object.freeze({
                        type: "import_preview_file_directory_resolution_failed",
                        requestId: command.requestId,
                        code: "host.import_preview_file_connection_unavailable",
                    }),
                );
                return;
            }
            try {
                this.#parentPort.postMessage(
                    Object.freeze({
                        type: "import_preview_file_directory_resolved",
                        requestId: command.requestId,
                        directoryPath: connection.resolveImportPreviewFileDirectory(command.reference),
                    }),
                );
            } catch {
                this.#parentPort.postMessage(
                    Object.freeze({
                        type: "import_preview_file_directory_resolution_failed",
                        requestId: command.requestId,
                        code: "host.import_preview_file_resolution_failed",
                    }),
                );
            }
            return;
        }
        if (event.ports.length !== 0 || this.#host === undefined) {
            for (const port of event.ports) port.close();
            this.#reportFailure("control", "host.control_state_invalid");
            return;
        }
        if (command.type === "drain") {
            await this.#host.drain();
            this.#parentPort.postMessage(Object.freeze({ type: "drained" }));
            return;
        }
        try {
            await this.#host.shutdown();
            this.#rejectPreferenceRequests("Desktop Host stopped before preference request completed");
            this.#parentPort.postMessage(Object.freeze({ type: "stopped" }));
            this.#dependencies.stopProcess();
        } catch {
            this.#reportFailure("shutdown", "host.shutdown_failed");
        }
    }

    #reportFailure(
        phase: DesktopHostFailurePhase,
        code: Extract<DesktopHostControlEvent, { readonly type: "failure" }>["code"],
    ): void {
        this.#parentPort.postMessage(
            Object.freeze({
                type: "failure",
                phase,
                code,
            }),
        );
    }

    #reportLocalPathFailure(requestId: string, code: string): void {
        this.#parentPort.postMessage(
            Object.freeze({
                type: "local_path_registration_failed",
                requestId,
                code,
            }),
        );
    }

    #reportStateBackupFileFailure(requestId: string, code: string): void {
        this.#parentPort.postMessage(
            Object.freeze({
                type: "state_backup_file_resolution_failed",
                requestId,
                code,
            }),
        );
    }

    #reportStateBackupFileMutationFailure(requestId: string, code: string): void {
        this.#parentPort.postMessage(
            Object.freeze({
                type: "state_backup_file_mutation_failed",
                requestId,
                code,
            }),
        );
    }

    #requestDesktopPreferences(): Promise<Uint8Array> {
        const requestId = this.#newControlId();
        return new Promise<Uint8Array>((resolve, reject) => {
            const timeout = this.#preferenceTimeout(requestId, this.#preferenceReads, reject);
            this.#preferenceReads.set(requestId, { resolve, reject, timeout });
            this.#parentPort.postMessage(Object.freeze({ type: "desktop_preferences_read_requested", requestId }));
        });
    }

    #requestDesktopPreferenceRestore(bytes: Uint8Array, restoreTransactionPath: string): Promise<void> {
        const requestId = this.#newControlId();
        return new Promise<void>((resolve, reject) => {
            const timeout = this.#preferenceTimeout(requestId, this.#preferenceRestores, reject);
            this.#preferenceRestores.set(requestId, { resolve, reject, timeout });
            this.#parentPort.postMessage(
                Object.freeze({
                    type: "desktop_preferences_restore_requested",
                    requestId,
                    bytes: new Uint8Array(bytes),
                    restoreTransactionPath,
                }),
            );
        });
    }

    #preferenceTimeout<T>(
        requestId: string,
        requests: Map<string, PendingDesktopPreferenceRequest<T>>,
        reject: (error: Error) => void,
    ): ReturnType<typeof setTimeout> {
        const timeout = setTimeout(() => {
            requests.delete(requestId);
            reject(new Error("Desktop preference owner did not respond"));
        }, 5_000);
        timeout.unref();
        return timeout;
    }

    #newControlId(): string {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const candidate = (this.#dependencies.createControlId ?? crypto.randomUUID)();
            if (
                candidate.length > 0 &&
                candidate.trim() === candidate &&
                !candidate.includes("\0") &&
                !this.#preferenceReads.has(candidate) &&
                !this.#preferenceRestores.has(candidate)
            ) {
                return candidate;
            }
        }
        throw new Error("Desktop Host process could not allocate a control id");
    }

    #rejectPreferenceRequests(message: string): void {
        for (const requests of [this.#preferenceReads, this.#preferenceRestores] as const) {
            for (const [requestId, pending] of requests) {
                clearTimeout(pending.timeout);
                requests.delete(requestId);
                pending.reject(new Error(message));
            }
        }
    }
}
