import type { DesktopOperationalDiagnosticCode } from "@oaam/app-server-protocol";
import type { ClientConnectionApi, createClientConnection } from "@oaam/client-framework";
import type {
    AssetVersionExportKind,
    AssetVersionExportPickerResult,
    DesktopDataLocationActionResult,
    DesktopHostStartupSnapshot,
    DesktopImportPreviewFileReference,
    DesktopObservedProjectRootReference,
    ImportPreviewFileRevealResult,
    InstallationRootPickerResult,
    OaamDesktopBridge,
    ObservedProjectRootAuthorizationResult,
    ObservedProjectRootRevealResult,
    ProjectRootPickerResult,
    RegisteredProjectRootAuthorizationResult,
    RegisteredProjectRootRevealResult,
    SourceRootPickerResult,
} from "../../bridge/desktop-bridge";
import type { DesktopMessageId } from "../presentation";
import { DesktopApplicationClient } from "./desktop-application-client";
import { type BrowserProtocolPort, MessagePortClientTransport } from "./message-port-transport";

export type DesktopSessionState =
    | {
          readonly status: "starting";
          readonly phase: "startup" | "connecting" | "manual_retry";
          readonly message: DesktopMessageId;
      }
    | {
          readonly status: "starting";
          readonly phase: "reconnecting";
          readonly message: "session.host_recovering";
          readonly reasonCode: DesktopOperationalDiagnosticCode;
      }
    | {
          readonly status: "ready";
          readonly mode: "normal";
          readonly hostInstanceId: string;
          readonly assetCount: number;
          readonly catalogWarningCount: number;
      }
    | {
          readonly status: "ready";
          readonly mode: "state_recovery";
          readonly hostInstanceId: string;
          readonly assetCount: 0;
          readonly catalogWarningCount: 1;
          readonly recoveryReason: "missing_database" | "corrupt_database" | "incompatible_database" | "restore_reconciliation";
      }
    | {
          readonly status: "failed";
          readonly message: DesktopMessageId;
          readonly reasonCode:
              | DesktopOperationalDiagnosticCode
              | "session.catalog_unavailable"
              | "session.connection_closed"
              | "session.initialization_failed"
              | "session.restart_failed";
          readonly canRetry: true;
      };

export interface DesktopSessionDependencies {
    readonly createRequestId: () => string;
    readonly createConnection: typeof createClientConnection;
}

export class DesktopSession {
    readonly #bridge: OaamDesktopBridge;
    readonly #dependencies: DesktopSessionDependencies;
    readonly #listeners = new Set<(state: DesktopSessionState) => void>();
    #client: ClientConnectionApi | undefined;
    #applicationClient: DesktopApplicationClient | undefined;
    #state: DesktopSessionState = Object.freeze({
        status: "starting",
        phase: "startup",
        message: "session.starting",
    });
    #recoveryReason: "missing_database" | "corrupt_database" | "incompatible_database" | "restore_reconciliation" | undefined;
    #generation = 0;

    public constructor(bridge: OaamDesktopBridge, dependencies: DesktopSessionDependencies) {
        this.#bridge = bridge;
        this.#dependencies = dependencies;
        this.#applyHostStartup(bridge.initialHostStartup);
        bridge.subscribeHostStartup((snapshot) => this.#applyHostStartup(snapshot));
    }

    public get state(): DesktopSessionState {
        return this.#state;
    }

    public get applicationClient(): DesktopApplicationClient | undefined {
        return this.#applicationClient;
    }

    public get desktopBridge(): OaamDesktopBridge {
        return this.#bridge;
    }

    public subscribe(listener: (state: DesktopSessionState) => void): () => void {
        this.#listeners.add(listener);
        listener(this.#state);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    public attach(port: BrowserProtocolPort): void {
        this.#generation += 1;
        const generation = this.#generation;
        this.#client?.close();
        this.#applicationClient = undefined;
        this.#transition(Object.freeze({ status: "starting", phase: "connecting", message: "session.connecting" }));
        const transport = new MessagePortClientTransport(port);
        const client = this.#dependencies.createConnection(transport, {
            createRequestId: this.#dependencies.createRequestId,
            reportListenerError: () => {
                transport.close();
            },
        });
        this.#client = client;
        client.subscribeClose(() => {
            if (generation === this.#generation) {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        message: "session.connection_closed",
                        reasonCode: "session.connection_closed",
                        canRetry: true,
                    }),
                );
            }
        });
        void this.#initialize(client, generation);
    }

    public async retry(): Promise<void> {
        this.#generation += 1;
        const generation = this.#generation;
        this.#client?.close();
        this.#client = undefined;
        this.#applicationClient = undefined;
        this.#transition(Object.freeze({ status: "starting", phase: "manual_retry", message: "session.restarting" }));
        try {
            await this.#bridge.retrySession();
        } catch {
            if (generation === this.#generation) {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        message: "session.restart_failed",
                        reasonCode: "session.restart_failed",
                        canRetry: true,
                    }),
                );
            }
        }
    }

    public async refreshCatalogSummary(): Promise<void> {
        const client = this.#client;
        const generation = this.#generation;
        const current = this.#state;
        if (client === undefined || current.status !== "ready" || current.mode !== "normal") {
            throw new Error("OAAM Desktop is not ready to refresh the catalog");
        }
        const listed = await client.request("asset.list", {});
        if (generation !== this.#generation || this.#state.status !== "ready" || this.#state.mode !== "normal") {
            throw new Error("OAAM Desktop catalog refresh became stale");
        }
        if (listed.status === "failed") throw new Error("OAAM Desktop catalog refresh failed");
        this.#transition(
            Object.freeze({
                ...this.#state,
                assetCount: listed.value.assets.length,
                catalogWarningCount: listed.diagnostics.filter((diagnostic) => diagnostic.severity !== "info").length,
            }),
        );
    }

    public pickProjectRoot(suggestedRootPath?: string): Promise<ProjectRootPickerResult> {
        if (this.#state.status !== "ready") {
            return Promise.reject(new Error("OAAM Desktop is not ready to select a project folder"));
        }
        return this.#bridge.pickProjectRoot(suggestedRootPath);
    }

    public authorizeObservedProjectRoot(
        reference: DesktopObservedProjectRootReference,
    ): Promise<ObservedProjectRootAuthorizationResult> {
        if (this.#state.status !== "ready") {
            return Promise.reject(new Error("OAAM Desktop is not ready to authorize an observed project folder"));
        }
        return this.#bridge.authorizeObservedProjectRoot(reference);
    }

    public revealObservedProjectRoot(reference: DesktopObservedProjectRootReference): Promise<ObservedProjectRootRevealResult> {
        if (this.#state.status !== "ready") {
            return Promise.reject(new Error("OAAM Desktop is not ready to reveal an observed project folder"));
        }
        return this.#bridge.revealObservedProjectRoot(reference);
    }

    public authorizeRegisteredProjectRoot(projectId: string): Promise<RegisteredProjectRootAuthorizationResult> {
        if (this.#state.status !== "ready") {
            return Promise.reject(new Error("OAAM Desktop is not ready to authorize a registered Project folder"));
        }
        return this.#bridge.authorizeRegisteredProjectRoot(projectId);
    }

    public revealRegisteredProjectRoot(projectId: string): Promise<RegisteredProjectRootRevealResult> {
        if (this.#state.status !== "ready") {
            return Promise.reject(new Error("OAAM Desktop is not ready to reveal a registered Project folder"));
        }
        return this.#bridge.revealRegisteredProjectRoot(projectId);
    }

    public revealImportPreviewFile(reference: DesktopImportPreviewFileReference): Promise<ImportPreviewFileRevealResult> {
        if (this.#state.status !== "ready") {
            return Promise.reject(new Error("OAAM Desktop is not ready to reveal an import-preview file"));
        }
        return this.#bridge.revealImportPreviewFile(reference);
    }

    public pickSourceRoot(): Promise<SourceRootPickerResult> {
        if (this.#state.status !== "ready") {
            return Promise.reject(new Error("OAAM Desktop is not ready to select a source folder"));
        }
        return this.#bridge.pickSourceRoot();
    }

    public pickInstallationRoot(): Promise<InstallationRootPickerResult> {
        if (this.#state.status !== "ready") {
            return Promise.reject(new Error("OAAM Desktop is not ready to select a tool installation folder"));
        }
        return this.#bridge.pickInstallationRoot();
    }

    public pickAssetVersionExport(
        exportKind: AssetVersionExportKind,
        suggestedFileName: string,
    ): Promise<AssetVersionExportPickerResult> {
        if (this.#state.status !== "ready") {
            return Promise.reject(new Error("OAAM Desktop is not ready to select an Asset Version export file"));
        }
        return this.#bridge.pickAssetVersionExport(exportKind, suggestedFileName);
    }

    public openDiagnostics(): Promise<DesktopDataLocationActionResult> {
        return this.#bridge.performDesktopDataLocationAction("ordinary_logs", "open");
    }

    public close(): void {
        this.#generation += 1;
        this.#client?.close();
        this.#client = undefined;
        this.#applicationClient = undefined;
    }

    async #initialize(client: ClientConnectionApi, generation: number): Promise<void> {
        try {
            const initialized = await client.initialize({
                protocolVersion: 1,
                clientKind: "desktop",
                clientVersion: "0.1.0",
            });
            if (this.#recoveryReason !== undefined) {
                if (
                    initialized.availableOperations.includes("asset.list") ||
                    !initialized.availableOperations.includes("state_restore.inspect") ||
                    !initialized.availableOperations.includes("state_restore.activate")
                ) {
                    throw new Error("Recovery-only Host advertised an invalid operation set");
                }
                if (generation !== this.#generation) return;
                this.#applicationClient = new DesktopApplicationClient(client, initialized.availableOperations);
                this.#transition(
                    Object.freeze({
                        status: "ready",
                        mode: "state_recovery",
                        hostInstanceId: initialized.hostInstanceId,
                        assetCount: 0,
                        catalogWarningCount: 1,
                        recoveryReason: this.#recoveryReason,
                    }),
                );
                return;
            }
            const listed = await client.request("asset.list", {});
            if (generation !== this.#generation) return;
            if (listed.status === "failed") {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        message: "session.catalog_unavailable",
                        reasonCode: "session.catalog_unavailable",
                        canRetry: true,
                    }),
                );
                return;
            }
            this.#applicationClient = new DesktopApplicationClient(client, initialized.availableOperations);
            this.#transition(
                Object.freeze({
                    status: "ready",
                    mode: "normal",
                    hostInstanceId: initialized.hostInstanceId,
                    assetCount: listed.value.assets.length,
                    catalogWarningCount: listed.diagnostics.filter((diagnostic) => diagnostic.severity !== "info").length,
                }),
            );
        } catch {
            if (generation === this.#generation) {
                this.#transition(
                    Object.freeze({
                        status: "failed",
                        message: "session.initialization_failed",
                        reasonCode: "session.initialization_failed",
                        canRetry: true,
                    }),
                );
            }
        }
    }

    #applyHostStartup(snapshot: DesktopHostStartupSnapshot): void {
        if (snapshot.status === "ready") {
            this.#recoveryReason = "recoveryReason" in snapshot ? snapshot.recoveryReason : undefined;
            return;
        }
        this.#recoveryReason = undefined;
        if (snapshot.status === "starting") {
            if (this.#state.status !== "starting") {
                this.#resetForHostChange(Object.freeze({ status: "starting", phase: "startup", message: "session.starting" }));
            }
            return;
        }
        if (snapshot.status === "recovering") {
            this.#resetForHostChange(
                Object.freeze({
                    status: "starting",
                    phase: "reconnecting",
                    message: "session.host_recovering",
                    reasonCode: snapshot.reasonCode,
                }),
            );
            return;
        }
        this.#generation += 1;
        this.#client?.close();
        this.#client = undefined;
        this.#applicationClient = undefined;
        this.#transition(
            Object.freeze({
                status: "failed",
                message:
                    snapshot.reasonCode === "host.startup_timeout"
                        ? "session.host_startup_timeout"
                        : "session.host_startup_failed",
                reasonCode: snapshot.reasonCode,
                canRetry: true,
            }),
        );
    }

    #resetForHostChange(state: Extract<DesktopSessionState, { readonly status: "starting" }>): void {
        this.#generation += 1;
        this.#client?.close();
        this.#client = undefined;
        this.#applicationClient = undefined;
        this.#transition(state);
    }

    #transition(state: DesktopSessionState): void {
        this.#state = state;
        for (const listener of this.#listeners) listener(state);
    }
}
