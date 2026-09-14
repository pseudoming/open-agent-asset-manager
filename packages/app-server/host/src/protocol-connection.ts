import {
    createProtocolResultResponse,
    PROTOCOL_OPERATION_NAMES,
    PROTOCOL_VERSION,
    type ProtocolAcceptedLongOperationName,
    type ProtocolDiagnosticsHealthV1,
    type ProtocolNotificationV1,
    type ProtocolOperationName,
    type ProtocolOperationOutcomeV1,
    type ProtocolOrdinaryLogClearResultV1,
    type ProtocolOrdinaryLogSettingsReplaceParamsV1,
    type ProtocolOrdinaryLogSettingsV1,
    type ProtocolRejectionV1,
    type ProtocolRequestV1,
    ProtocolValidationError,
    parseProtocolRequest,
    parseProtocolResponseEnvelope,
} from "@oaam/app-server-protocol";
import type { CoreService, UuidV4 } from "@oaam/core";
import { projectedOutcomeOperationalDiagnosticCodes } from "./core-outcome";
import {
    dispatchH2Immediate,
    dispatchH2Long,
    type HOST_H2_IMMEDIATE_OPERATIONS,
    type HOST_H2_LONG_OPERATIONS,
    type ImmediateH2Request,
    isH2ImmediateOperation,
    type LongH2Request,
} from "./dispatch-h2";
import { dispatchH1Immediate, dispatchH1Long, type HOST_H1_OPERATIONS, isH1LongOperation } from "./dispatch-registry";
import type { HostOperationManager } from "./operation-manager";
import type { OperationalDiagnosticInput } from "./operational-diagnostics";
import type { HostLocalPathSelectionKind, HostPathSelectionStore } from "./path-selection-store";
import type { HostRenderApprovalAuthority } from "./render-approval-authority";
import type { HostReviewRecords } from "./review-records";
import {
    dispatchStateResilienceImmediate,
    dispatchStateResilienceLong,
    type HOST_STATE_RESILIENCE_IMMEDIATE_OPERATIONS,
    type HOST_STATE_RESILIENCE_LONG_OPERATIONS,
    type ImmediateStateResilienceRequest,
    isStateResilienceImmediateOperation,
    isStateResilienceLongOperation,
    type LongStateResilienceRequest,
} from "./state-resilience-dispatch";
import {
    dispatchSupportBundleLong,
    type HOST_SUPPORT_BUNDLE_LONG_OPERATIONS,
    type HostSupportBundleIntegration,
    isSupportBundleLongOperation,
    type SupportBundleRequest,
} from "./support-bundle-dispatch";
import type {
    HostConnection,
    HostConnectionSink,
    HostImportPreviewFileReference,
    HostObservedProjectRootReference,
    HostStateResilienceIntegration,
} from "./types";

const KNOWN_OPERATIONS = new Set<string>(PROTOCOL_OPERATION_NAMES);
type InstalledOperationName =
    | (typeof HOST_H1_OPERATIONS)[number]
    | (typeof HOST_H2_IMMEDIATE_OPERATIONS)[number]
    | (typeof HOST_H2_LONG_OPERATIONS)[number]
    | (typeof HOST_STATE_RESILIENCE_IMMEDIATE_OPERATIONS)[number]
    | (typeof HOST_STATE_RESILIENCE_LONG_OPERATIONS)[number]
    | (typeof HOST_SUPPORT_BUNDLE_LONG_OPERATIONS)[number]
    | "diagnostics.health.get"
    | "diagnostics.ordinary_log.settings.get"
    | "diagnostics.ordinary_log.settings.replace"
    | "diagnostics.ordinary_log.clear";
const DISPATCH_IS_EXHAUSTIVE: Exclude<ProtocolOperationName, InstalledOperationName> extends never ? true : never = true;
void DISPATCH_IS_EXHAUSTIVE;

interface AdapterProbeTimingState {
    startedAt: number;
    ownerCount: number;
    maximumOwnerElapsedMilliseconds: number;
}

interface HostConnectionOwner extends HostSupportBundleIntegration {
    readonly hostInstanceId: string;
    readonly availableOperations: readonly ProtocolOperationName[];
    canAcceptRequest(): boolean;
    beginRequest(): (() => void) | null;
    beginExclusiveRestore(operationId: string): Promise<void>;
    reviewRecords(): HostReviewRecords;
    renderApprovalAuthority(): HostRenderApprovalAuthority;
    operationalHealth(): ProtocolDiagnosticsHealthV1;
    ordinaryLogSettings(): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogSettingsV1>;
    replaceOrdinaryLogSettings(
        input: ProtocolOrdinaryLogSettingsReplaceParamsV1,
    ): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogSettingsV1>;
    clearOrdinaryLog(): ProtocolOperationOutcomeV1<ProtocolOrdinaryLogClearResultV1>;
    recordOperationalDiagnostic(input: OperationalDiagnosticInput): void;
    removeConnection(connection: ProtocolHostConnection): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trustedRequest(value: unknown): { readonly envelope: Record<string, unknown>; readonly id: string } | null {
    if (!isRecord(value)) return null;
    const id = value.id;
    return typeof id === "string" && id.length > 0 && id.trim() === id ? { envelope: value, id } : null;
}

function hasExactEnvelopeKeys(value: Record<string, unknown>): boolean {
    const keys = Object.keys(value).sort();
    return keys.length === 3 && keys[0] === "id" && keys[1] === "method" && keys[2] === "params";
}

function rejection(code: ProtocolRejectionV1["code"], message: string): ProtocolRejectionV1 {
    return { code, message };
}

function operationalTerminalOutcome(value: ProtocolOperationOutcomeV1<unknown>): {
    readonly status: "complete" | "partial" | "failed";
    readonly diagnosticCodes: readonly string[];
} {
    const diagnosticCodes = value.diagnostics.map((diagnostic) => diagnostic.code);
    return Object.freeze({ status: value.status, diagnosticCodes: Object.freeze(diagnosticCodes) });
}

export class ProtocolHostConnection implements HostConnection {
    readonly #owner: HostConnectionOwner;
    readonly #core: CoreService | undefined;
    readonly #operations: HostOperationManager;
    readonly #stateResilience: HostStateResilienceIntegration;
    readonly #sink: HostConnectionSink;
    readonly #usedIds = new Set<string>();
    readonly #pendingOperationalDiagnosticCodes = new Map<string, readonly string[]>();
    readonly #monotonicNow: () => number;
    #initialized = false;
    #closed = false;
    #queue: Promise<void> = Promise.resolve();

    public constructor(
        public readonly connectionId: string,
        owner: HostConnectionOwner,
        core: CoreService | undefined,
        operations: HostOperationManager,
        stateResilience: HostStateResilienceIntegration,
        pathSelections: HostPathSelectionStore,
        sink: HostConnectionSink,
        monotonicNow: (() => number) | undefined = undefined,
    ) {
        this.#owner = owner;
        this.#core = core;
        this.#operations = operations;
        this.#stateResilience = stateResilience;
        this.#pathSelections = pathSelections;
        this.#sink = sink;
        this.#monotonicNow = monotonicNow ?? (() => performance.now());
    }

    readonly #pathSelections: HostPathSelectionStore;

    public registerLocalPathSelection(kind: HostLocalPathSelectionKind, rootPath: string): string {
        if (this.#closed) throw new Error("Host connection is closed");
        return this.#pathSelections.register(kind, rootPath);
    }

    public resolveObservedProjectRoot(reference: HostObservedProjectRootReference): string {
        if (this.#closed) throw new Error("Host connection is closed");
        return this.#owner.reviewRecords().resolveProbeProjectRoot(this.connectionId, reference);
    }

    public resolveImportPreviewFileDirectory(reference: HostImportPreviewFileReference): string {
        if (this.#closed) throw new Error("Host connection is closed");
        return this.#owner.reviewRecords().resolveImportPreviewFileDirectory(this.connectionId, reference);
    }

    public authorizeObservedProjectRootRegistration(reference: HostObservedProjectRootReference): {
        readonly rootPath: string;
        readonly localPathSelectionToken: string;
    } {
        const rootPath = this.resolveObservedProjectRoot(reference);
        return Object.freeze({
            rootPath,
            localPathSelectionToken: this.#pathSelections.register("project_root", rootPath),
        });
    }

    public resolveRegisteredProjectRoot(projectId: UuidV4): string {
        if (this.#closed) throw new Error("Host connection is closed");
        if (this.#core === undefined) throw new Error("Registered Project authority is unavailable");
        const project = this.#core.getProject(projectId);
        const manifest = project.status === "complete" && project.value.found ? project.value.value : undefined;
        if (manifest === undefined || manifest.deleted) {
            throw new Error("Registered Project is unavailable");
        }
        return manifest.rootPath;
    }

    public authorizeRegisteredProjectRootProbe(projectId: UuidV4): {
        readonly rootPath: string;
        readonly localPathSelectionToken: string;
    } {
        const rootPath = this.resolveRegisteredProjectRoot(projectId);
        return Object.freeze({
            rootPath,
            localPathSelectionToken: this.#pathSelections.register("project_root", rootPath),
        });
    }

    public receive(message: unknown): void {
        if (this.#closed) return;
        const finish = this.#owner.beginRequest();
        if (finish === null) {
            this.#close("Host is not accepting new work");
            return;
        }
        this.#queue = this.#queue
            .then(() => this.#handle(message))
            .catch(() => this.#close("Host connection failed"))
            .finally(finish);
    }

    public close(): void {
        this.#close("Host connection closed locally");
    }

    #handle(message: unknown): void {
        if (this.#closed) return;
        const trusted = trustedRequest(message);
        if (trusted === null) {
            this.#owner.recordOperationalDiagnostic({ source: "protocol", code: "protocol.invalid_envelope" });
            this.#close("Protocol request has no trustworthy id");
            return;
        }
        const { envelope, id } = trusted;
        if (this.#usedIds.has(id)) {
            this.#sendError(id, "protocol.duplicate_id", "Request id was already used on this connection.");
            this.#close("Protocol request id was duplicated");
            return;
        }
        this.#usedIds.add(id);
        if (!hasExactEnvelopeKeys(envelope)) {
            this.#sendError(id, "protocol.invalid_envelope", "Request envelope must contain exactly id, method, and params.");
            return;
        }
        const method = envelope.method;
        if (typeof method !== "string" || !KNOWN_OPERATIONS.has(method)) {
            this.#sendError(id, "protocol.unknown_method", "Request method is not in the closed Protocol registry.");
            return;
        }
        if (!this.#initialized && method !== "initialize") {
            this.#sendError(id, "protocol.not_initialized", "The first request must initialize this connection.");
            return;
        }
        if (method === "initialize" && !this.#hasCompatibleVersion(envelope.params)) {
            this.#sendError(id, "protocol.incompatible_version", "Client Protocol version is incompatible with this Host.");
            return;
        }
        let request: ProtocolRequestV1;
        try {
            request = parseProtocolRequest(envelope);
        } catch (error) {
            if (!(error instanceof ProtocolValidationError)) throw error;
            this.#sendError(id, "protocol.invalid_params", error.message);
            return;
        }
        if (!this.#owner.availableOperations.includes(request.method)) {
            this.#sendError(id, "protocol.unknown_method", "Operation is not installed by this Host.");
            return;
        }
        if (request.method === "initialize") {
            if (this.#initialized) {
                this.#sendError(id, "protocol.invalid_params", "This connection is already initialized.");
                return;
            }
            this.#initialized = true;
            this.#send(
                createProtocolResultResponse(id, "initialize", {
                    protocolVersion: PROTOCOL_VERSION,
                    hostInstanceId: this.#owner.hostInstanceId,
                    availableOperations: [...this.#owner.availableOperations],
                }),
            );
            return;
        }
        if (request.method === "operation.observe") {
            this.#send(
                parseProtocolResponseEnvelope(
                    createProtocolResultResponse(
                        id,
                        request.method,
                        this.#operations.observe(request.params.operationId, request.params.afterSequence),
                    ),
                ),
            );
            return;
        }
        if (request.method === "operation.cancel") {
            this.#send(
                createProtocolResultResponse(
                    id,
                    request.method,
                    this.#operations.requestCancellation(request.params.operationId),
                ),
            );
            return;
        }
        this.#owner.recordOperationalDiagnostic({
            source: "protocol",
            code: "protocol.request.accepted",
            operation: request.method,
        });
        if (request.method === "diagnostics.health.get") {
            this.#sendImmediate(
                request.method,
                createProtocolResultResponse(request.id, request.method, {
                    status: "complete",
                    value: this.#owner.operationalHealth(),
                    diagnostics: [],
                }),
            );
            return;
        }
        if (request.method === "diagnostics.ordinary_log.settings.get") {
            this.#sendImmediate(
                request.method,
                createProtocolResultResponse(request.id, request.method, this.#owner.ordinaryLogSettings()),
            );
            return;
        }
        if (request.method === "diagnostics.ordinary_log.settings.replace") {
            this.#sendImmediate(
                request.method,
                createProtocolResultResponse(request.id, request.method, this.#owner.replaceOrdinaryLogSettings(request.params)),
            );
            return;
        }
        if (request.method === "diagnostics.ordinary_log.clear") {
            this.#sendImmediate(
                request.method,
                createProtocolResultResponse(request.id, request.method, this.#owner.clearOrdinaryLog()),
            );
            return;
        }
        const core = this.#core;
        if (core !== undefined) {
            const immediate = dispatchH1Immediate(core, request);
            if (immediate !== null) {
                this.#sendImmediate(request.method, immediate);
                return;
            }
            if (isH2ImmediateOperation(request.method)) {
                this.#sendImmediate(request.method, dispatchH2Immediate(core, request as ImmediateH2Request, this.#h2Context()));
                return;
            }
            if (isStateResilienceImmediateOperation(request.method)) {
                this.#sendImmediate(
                    request.method,
                    dispatchStateResilienceImmediate(core, request as ImmediateStateResilienceRequest),
                );
                return;
            }
        }
        if (isH1LongOperation(request.method)) {
            this.#startLong(request.method, request);
            return;
        }
        this.#startLong(request.method as ProtocolAcceptedLongOperationName, request);
    }

    #startLong(operation: ProtocolAcceptedLongOperationName, request: ProtocolRequestV1): void {
        const adapterProbeTiming: AdapterProbeTimingState | undefined =
            operation === "adapter.probe"
                ? {
                      startedAt: 0,
                      ownerCount: 0,
                      maximumOwnerElapsedMilliseconds: 0,
                  }
                : undefined;
        const reservation = this.#operations.reserve(operation, (notification) => {
            if (notification.method === "operation.progress") {
                if (adapterProbeTiming !== undefined) {
                    this.#recordAdapterProbeOwnerTiming(notification, adapterProbeTiming);
                }
            }
            if (notification.method === "operation.terminal") {
                this.#recordTerminal(operation, notification.params.outcome, notification.params.operationId, adapterProbeTiming);
            }
            this.#sendNotification(notification);
        });
        if (!this.#send(createProtocolResultResponse(request.id, operation, { operationId: reservation.operationId }))) {
            this.#operations.abandon(reservation);
            return;
        }
        if (adapterProbeTiming !== undefined) adapterProbeTiming.startedAt = this.#monotonicNow();
        this.#operations.start(reservation, async (operationContext) => {
            let outcome: unknown;
            if (isH1LongOperation(operation)) {
                outcome = await dispatchH1Long(
                    this.#requireCore(),
                    request,
                    operationContext,
                    this.#pathSelections,
                    this.#owner.renderApprovalAuthority(),
                );
            } else if (isStateResilienceLongOperation(operation)) {
                outcome = await dispatchStateResilienceLong(this.#core, request as LongStateResilienceRequest, {
                    ...this.#h2Context(),
                    integration: this.#stateResilience,
                    operation: operationContext,
                    beginExclusiveRestore: (operationId) => this.#owner.beginExclusiveRestore(operationId),
                });
            } else if (isSupportBundleLongOperation(operation)) {
                outcome = await dispatchSupportBundleLong(request as SupportBundleRequest, {
                    ...this.#h2Context(),
                    integration: this.#owner,
                });
            } else {
                outcome = await dispatchH2Long(
                    this.#requireCore(),
                    request as LongH2Request,
                    this.#h2Context(),
                    operationContext,
                );
            }
            const operationalCodes = projectedOutcomeOperationalDiagnosticCodes(outcome);
            if (operationalCodes.length > 0) {
                this.#pendingOperationalDiagnosticCodes.set(reservation.operationId, operationalCodes);
            }
            return outcome;
        });
    }

    #recordAdapterProbeOwnerTiming(
        notification: Extract<ProtocolNotificationV1, { method: "operation.progress" }>,
        timing: AdapterProbeTimingState,
    ): void {
        const progress = notification.params.progress;
        if (!("adapterId" in progress)) return;
        const elapsedMilliseconds = progress.elapsedMilliseconds;
        const endedOffsetMilliseconds = Math.max(elapsedMilliseconds, Math.round(this.#monotonicNow() - timing.startedAt));
        const startedOffsetMilliseconds = endedOffsetMilliseconds - elapsedMilliseconds;
        timing.ownerCount += 1;
        timing.maximumOwnerElapsedMilliseconds = Math.max(timing.maximumOwnerElapsedMilliseconds, elapsedMilliseconds);
        this.#owner.recordOperationalDiagnostic({
            source: "protocol",
            code: "protocol.adapter_probe.owner_timing",
            operationId: notification.params.operationId,
            stage: "provider_probe",
            adapterId: progress.adapterId,
            environment: progress.environment,
            status: progress.outcome,
            startedOffsetMilliseconds,
            endedOffsetMilliseconds,
            elapsedMilliseconds,
        });
    }

    #requireCore(): CoreService {
        if (this.#core === undefined) throw new Error("Recovery-only Host operation requested ordinary Core authority");
        return this.#core;
    }

    public sendReviewInvalidation(notification: ProtocolNotificationV1): void {
        this.#sendNotification(notification);
    }

    #h2Context() {
        return {
            connectionId: this.connectionId,
            pathSelections: this.#pathSelections,
            reviews: this.#owner.reviewRecords(),
            renderApprovals: this.#owner.renderApprovalAuthority(),
        };
    }

    #hasCompatibleVersion(params: unknown): boolean {
        return isRecord(params) && params.protocolVersion === PROTOCOL_VERSION;
    }

    #sendError(id: string, code: ProtocolRejectionV1["code"], message: string): void {
        this.#owner.recordOperationalDiagnostic({ source: "protocol", code });
        this.#send(parseProtocolResponseEnvelope({ id, error: rejection(code, message) }));
    }

    #sendNotification(notification: ProtocolNotificationV1): void {
        this.#send(notification);
    }

    #sendImmediate(operation: ProtocolOperationName, message: Parameters<HostConnectionSink["send"]>[0]): boolean {
        const parsedResult = (message as unknown as { readonly result: ProtocolOperationOutcomeV1<unknown> }).result;
        this.#recordTerminal(operation, parsedResult);
        return this.#send(message);
    }

    #recordTerminal(
        operation: ProtocolOperationName,
        outcome: ProtocolOperationOutcomeV1<unknown>,
        operationId?: string,
        adapterProbeTiming?: AdapterProbeTimingState,
    ): void {
        const terminal = operationalTerminalOutcome(outcome);
        if (operationId !== undefined && adapterProbeTiming !== undefined) {
            const elapsedMilliseconds = Math.max(
                adapterProbeTiming.maximumOwnerElapsedMilliseconds,
                Math.round(this.#monotonicNow() - adapterProbeTiming.startedAt),
            );
            this.#owner.recordOperationalDiagnostic({
                source: "protocol",
                code: "protocol.adapter_probe.summary_timing",
                operationId,
                stage: "provider_probe",
                status: terminal.status,
                ownerCount: adapterProbeTiming.ownerCount,
                elapsedMilliseconds,
                maximumOwnerElapsedMilliseconds: adapterProbeTiming.maximumOwnerElapsedMilliseconds,
                overheadMilliseconds: elapsedMilliseconds - adapterProbeTiming.maximumOwnerElapsedMilliseconds,
            });
        }
        const projectedCodes = operationId === undefined ? [] : (this.#pendingOperationalDiagnosticCodes.get(operationId) ?? []);
        if (operationId !== undefined) this.#pendingOperationalDiagnosticCodes.delete(operationId);
        this.#owner.recordOperationalDiagnostic({
            source: "protocol",
            code: "protocol.request.terminal",
            operation,
            status: terminal.status,
            diagnosticCodes: [...terminal.diagnosticCodes, ...projectedCodes],
            ...(operationId === undefined ? {} : { operationId }),
        });
    }

    #send(message: Parameters<HostConnectionSink["send"]>[0]): boolean {
        if (this.#closed) return false;
        try {
            this.#sink.send(message);
            return true;
        } catch {
            this.#owner.recordOperationalDiagnostic({ source: "host", code: "host.transport.failed" });
            this.#close("Host response transport failed");
            return false;
        }
    }

    #close(reason: unknown): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#pathSelections.clear();
        this.#owner.removeConnection(this);
        try {
            this.#sink.close(reason);
        } catch {
            // A failed close callback cannot restore or alter Host/Core authority.
        }
    }
}
