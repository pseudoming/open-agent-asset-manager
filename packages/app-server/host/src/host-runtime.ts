import * as crypto from "node:crypto";
import * as os from "node:os";
import {
    createProtocolNotification,
    type DesktopSimpleOperationalDiagnosticCode,
    PROTOCOL_OPERATION_NAMES,
    type ProtocolDesktopRendererDiagnosticInputV1,
    type ProtocolDiagnosticsHealthV1,
    type ProtocolOperationName,
    type ProtocolOperationOutcomeV1,
    type ProtocolOrdinaryLogClearResultV1,
    type ProtocolOrdinaryLogSettingsReplaceParamsV1,
    type ProtocolOrdinaryLogSettingsV1,
    type ProtocolSupportBundleArtifactV1,
    type ProtocolSupportBundleMode,
} from "@oaam/app-server-protocol";
import type { CoreService } from "@oaam/core";
import { HostOperationManager } from "./operation-manager";
import {
    createEphemeralOperationalDiagnosticsForTest,
    type OperationalDiagnosticInput,
    type OperationalDiagnostics,
} from "./operational-diagnostics";
import { HostPathSelectionStore } from "./path-selection-store";
import { ProtocolHostConnection } from "./protocol-connection";
import { createHostRenderApprovalAuthority, type HostRenderApprovalAuthority } from "./render-approval-authority";
import { createOwnedReviewSpoolRoot, HostReviewRecordStore } from "./review-record-store";
import { HostReviewRecords } from "./review-records";
import {
    buildAndVerifySupportBundle,
    defaultSupportBundleProductFacts,
    EXTENDED_SUPPORT_LOG_MAXIMUM_BYTES,
    type PreparedSupportBundle,
    publishPreparedSupportBundle,
    STANDARD_SUPPORT_LOG_MAXIMUM_BYTES,
    type SupportBundleProductFacts,
} from "./support-bundle";
import type {
    HostConnection,
    HostConnectionSink,
    HostLifecycleState,
    HostStartupDisposition,
    HostStateResilienceIntegration,
    ProductionHost,
} from "./types";

export interface HostRuntimeDependencies {
    readonly createConnectionId?: () => string;
    readonly createOperationId?: () => string;
    readonly createReviewToken?: () => string;
    readonly createReviewMemberId?: () => string;
    readonly createPathSelectionToken?: () => string;
    readonly createReviewSpoolRoot?: () => string;
    readonly now?: () => number;
    readonly monotonicNow?: () => number;
    readonly maximumActiveOperations?: number;
    readonly maximumCompletedOperations?: number;
    readonly operationalDiagnostics?: OperationalDiagnostics;
    readonly supportProductFacts?: SupportBundleProductFacts;
    readonly renderApprovalAuthority?: HostRenderApprovalAuthority;
}

type ResolvedHostRuntimeDependencies = HostRuntimeDependencies & {
    readonly createConnectionId: () => string;
    readonly createOperationId: () => string;
    readonly createReviewToken: () => string;
    readonly createReviewMemberId: () => string;
    readonly createPathSelectionToken: () => string;
    readonly createReviewSpoolRoot: () => string;
    readonly renderApprovalAuthority: HostRenderApprovalAuthority;
};

const DEFAULT_DEPENDENCIES: ResolvedHostRuntimeDependencies = Object.freeze({
    createConnectionId: () => crypto.randomUUID(),
    createOperationId: () => crypto.randomUUID(),
    createReviewToken: () => crypto.randomUUID(),
    createReviewMemberId: () => crypto.randomUUID(),
    createPathSelectionToken: () => crypto.randomUUID(),
    createReviewSpoolRoot: () => createOwnedReviewSpoolRoot(os.tmpdir()),
    renderApprovalAuthority: createHostRenderApprovalAuthority(),
});

export class ProductionHostRuntime implements ProductionHost {
    readonly #core: CoreService | undefined;
    readonly #dependencies: ResolvedHostRuntimeDependencies;
    readonly #connections = new Set<ProtocolHostConnection>();
    readonly #drainWaiters = new Set<() => void>();
    readonly #availableOperations: readonly ProtocolOperationName[];
    readonly #operations: HostOperationManager;
    readonly #operationalDiagnostics: OperationalDiagnostics;
    readonly #stateResilience: HostStateResilienceIntegration;
    #releaseOwnedCore: (() => void | Promise<void>) | undefined;
    #shutdownPromise: Promise<void> | undefined;
    #reviewRecords: HostReviewRecords | undefined;
    #reviewStore: HostReviewRecordStore | undefined;
    #state: HostLifecycleState = "ready";
    #activeRequests = 0;

    public constructor(
        public readonly hostInstanceId: string,
        core: CoreService | undefined,
        stateResilience: HostStateResilienceIntegration,
        dependencies: HostRuntimeDependencies = DEFAULT_DEPENDENCIES,
        availableOperations: readonly ProtocolOperationName[] = PROTOCOL_OPERATION_NAMES,
        public readonly startupDisposition: HostStartupDisposition = { mode: "normal" },
        releaseOwnedCore?: () => void | Promise<void>,
    ) {
        this.#core = core;
        this.#stateResilience = stateResilience;
        this.#releaseOwnedCore = releaseOwnedCore;
        this.#dependencies = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...dependencies });
        this.#availableOperations = Object.freeze([...availableOperations]);
        this.#operationalDiagnostics =
            this.#dependencies.operationalDiagnostics ?? createEphemeralOperationalDiagnosticsForTest();
        this.#operations = new HostOperationManager({
            createOperationId: this.#dependencies.createOperationId,
            ...(this.#dependencies.maximumActiveOperations === undefined
                ? {}
                : { maximumActiveOperations: this.#dependencies.maximumActiveOperations }),
            ...(this.#dependencies.maximumCompletedOperations === undefined
                ? {}
                : { maximumCompletedOperations: this.#dependencies.maximumCompletedOperations }),
        });
        this.#record({
            source: "host",
            code: startupDisposition.mode === "normal" ? "host.lifecycle.ready" : "host.lifecycle.recovery_ready",
        });
    }

    public get state(): HostLifecycleState {
        return this.#state;
    }

    public get availableOperations(): readonly ProtocolOperationName[] {
        return this.#availableOperations;
    }

    public openConnection(sink: HostConnectionSink): HostConnection {
        if (this.#state !== "ready") throw new Error("Host is not accepting new connections");
        const connection = new ProtocolHostConnection(
            this.#newConnectionId(),
            this,
            this.#core,
            this.#operations,
            this.#stateResilience,
            new HostPathSelectionStore({
                createToken: this.#dependencies.createPathSelectionToken,
                ...(this.#dependencies.now === undefined ? {} : { now: this.#dependencies.now }),
            }),
            sink,
            this.#dependencies.monotonicNow,
        );
        this.#connections.add(connection);
        this.#record({ source: "host", code: "host.connection.opened" });
        return connection;
    }

    public canAcceptRequest(): boolean {
        return this.#state === "ready";
    }

    public beginRequest(): (() => void) | null {
        if (!this.canAcceptRequest()) return null;
        this.#activeRequests += 1;
        let finished = false;
        return () => {
            if (finished) return;
            finished = true;
            this.#activeRequests -= 1;
            if (this.#activeRequests === 0) {
                for (const resolve of this.#drainWaiters) resolve();
                this.#drainWaiters.clear();
            }
        };
    }

    public removeConnection(connection: ProtocolHostConnection): void {
        if (this.#connections.delete(connection)) this.#record({ source: "host", code: "host.connection.closed" });
    }

    public operationalHealth(): ProtocolDiagnosticsHealthV1 {
        return this.#operationalDiagnostics.health(this.#state, this.startupDisposition);
    }

    public ordinaryLogSettings(): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogSettingsV1> {
        return this.#operationalDiagnostics.settings();
    }

    public replaceOrdinaryLogSettings(
        input: ProtocolOrdinaryLogSettingsReplaceParamsV1,
    ): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogSettingsV1> {
        return this.#operationalDiagnostics.replaceSettings(input);
    }

    public clearOrdinaryLog(): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogClearResultV1> {
        return this.#operationalDiagnostics.clearOrdinaryLog();
    }

    public prepareSupportBundle(mode: ProtocolSupportBundleMode): Promise<PreparedSupportBundle> {
        const providerResult = this.#core?.listAdapterProviders();
        const providers = providerResult === undefined || providerResult.status === "failed" ? null : providerResult.value;
        const maximumLogBytes = mode === "standard" ? STANDARD_SUPPORT_LOG_MAXIMUM_BYTES : EXTENDED_SUPPORT_LOG_MAXIMUM_BYTES;
        return buildAndVerifySupportBundle({
            mode,
            createdAt: this.#dependencies.now?.() ?? Date.now(),
            product: this.#dependencies.supportProductFacts ?? defaultSupportBundleProductFacts(),
            health: this.operationalHealth(),
            providers,
            ordinaryLog: this.#operationalDiagnostics.captureSupportLogSnapshot(maximumLogBytes),
        });
    }

    public publishSupportBundle(
        prepared: PreparedSupportBundle,
        destinationPath: string,
        userActionId: string,
    ): ProtocolSupportBundleArtifactV1 {
        return publishPreparedSupportBundle(prepared, destinationPath, userActionId);
    }

    public recordDesktopOperationalDiagnostic(code: DesktopSimpleOperationalDiagnosticCode): void {
        this.#record({ source: "desktop", code });
    }

    public recordDesktopRendererOperationalDiagnostic(input: ProtocolDesktopRendererDiagnosticInputV1): void {
        this.#record({ source: "desktop", code: "desktop.renderer.event", ...input });
    }

    public recordOperationalDiagnostic(input: OperationalDiagnosticInput): void {
        this.#record(input);
    }

    #newConnectionId(): string {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const connectionId = this.#dependencies.createConnectionId();
            if (
                connectionId.length > 0 &&
                connectionId.trim() === connectionId &&
                !connectionId.includes("\0") &&
                ![...this.#connections].some((connection) => connection.connectionId === connectionId)
            ) {
                return connectionId;
            }
        }
        throw new Error("Host could not allocate a unique connection id");
    }

    public reviewRecords(): HostReviewRecords {
        if (this.#reviewRecords !== undefined) return this.#reviewRecords;
        const store = new HostReviewRecordStore({
            rootPath: this.#dependencies.createReviewSpoolRoot(),
            createToken: this.#dependencies.createReviewToken,
            ...(this.#dependencies.now === undefined ? {} : { now: this.#dependencies.now }),
            onInvalidated: (ownerConnectionId, kind, token, reason) => {
                if (kind === "probe") this.#reviewRecords?.invalidateProbeOperationSnapshot(token);
                for (const connection of this.#connections) {
                    if (connection.connectionId !== ownerConnectionId) continue;
                    connection.sendReviewInvalidation(
                        createProtocolNotification({
                            method: "resource.invalidated",
                            params: {
                                resourceKind: "host_review_record",
                                recordKind: kind,
                                token,
                                reason,
                            },
                        }),
                    );
                }
            },
        });
        this.#reviewStore = store;
        this.#reviewRecords = new HostReviewRecords(store, this.#dependencies.createReviewMemberId);
        return this.#reviewRecords;
    }

    public renderApprovalAuthority(): HostRenderApprovalAuthority {
        return this.#dependencies.renderApprovalAuthority;
    }

    public async drain(): Promise<void> {
        if (this.#state === "stopped") return;
        if (this.#state === "ready") {
            this.#state = "draining";
            this.#record({ source: "host", code: "host.lifecycle.draining" });
        }
        await Promise.all([this.#waitForRequests(), this.#operations.waitForIdle()]);
    }

    public async beginExclusiveRestore(operationId: string): Promise<void> {
        if (this.#state === "stopped") throw new Error("Host is stopped");
        if (this.#state === "ready") this.#state = "draining";
        await Promise.all([this.#waitForRequests(), this.#operations.waitForIdleExcluding(operationId)]);
    }

    public resolveStateBackupFileAction(backupId: string): string {
        if (this.#state !== "ready") throw new Error("Host is not ready for a State backup file action");
        const inventory = this.#requireCore().listStateBackups();
        if (inventory.status === "failed") throw new Error("State backup inventory is unavailable");
        const selected = inventory.value.entries.find((entry) => entry.backupId === backupId);
        if (selected?.observation !== "available") {
            throw new Error("State backup is missing, replaced, or not registered");
        }
        return selected.archivePath;
    }

    public recycleStateBackupFileAction(backupId: string, userActionId: string): void {
        this.#requireReadyStateBackupMutation();
        const result = this.#requireCore().recycleStateBackup({ backupId, userActionId });
        if (result.status === "failed") throw new Error("State backup could not be recycled");
    }

    public retireMissingStateBackupFileAction(backupId: string, userActionId: string): void {
        this.#requireReadyStateBackupMutation();
        const result = this.#requireCore().retireMissingStateBackup({ backupId, userActionId });
        if (result.status === "failed") throw new Error("Trashed State backup could not be retired");
    }

    public shutdown(): Promise<void> {
        this.#shutdownPromise ??= this.#completeShutdown();
        return this.#shutdownPromise;
    }

    async #completeShutdown(): Promise<void> {
        // shutdown memoizes this sole transition before stopped can be reached.
        await this.drain();
        for (const connection of [...this.#connections]) connection.close();
        const releaseOwnedCore = this.#releaseOwnedCore;
        this.#releaseOwnedCore = undefined;
        try {
            this.#reviewStore?.close();
        } finally {
            await releaseOwnedCore?.();
            this.#state = "stopped";
            this.#record({ source: "host", code: "host.lifecycle.stopped" });
        }
    }

    async #waitForRequests(): Promise<void> {
        if (this.#activeRequests === 0) return;
        await new Promise<void>((resolve) => {
            this.#drainWaiters.add(resolve);
        });
    }

    #requireReadyStateBackupMutation(): void {
        if (this.#state !== "ready") throw new Error("Host is not ready for a State backup mutation");
    }

    #requireCore(): CoreService {
        if (this.#core === undefined) throw new Error("Recovery-only Host has no ordinary Core authority");
        return this.#core;
    }

    #record(input: OperationalDiagnosticInput): void {
        this.#operationalDiagnostics.record(input);
    }
}
