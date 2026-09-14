import {
    createProtocolNotification,
    parseProtocolOperationProgress,
    parseProtocolTerminalOutcome,
    type ProtocolAcceptedLongOperationName,
    type ProtocolNotificationV1,
    type ProtocolOperationEventV1,
    type ProtocolOperationProgress,
} from "@oaam/app-server-protocol";
import { hostCapacityFailure, hostInvocationFailure } from "./core-outcome";

export interface OperationManagerOptions {
    readonly createOperationId: () => string;
    readonly maximumActiveOperations?: number;
    readonly maximumCompletedOperations?: number;
}

export interface OperationReservation {
    readonly operationId: string;
}

export interface OperationRunContext {
    readonly operationId: string;
    reportProgress(progress: unknown): void;
    afterTerminal(callback: () => void): void;
    isCancellationRequested(): boolean;
}

interface IdleWaiter {
    readonly excludedOperationId?: string;
    readonly resolve: () => void;
}

interface StoredOperation {
    readonly operationId: string;
    readonly operation: ProtocolAcceptedLongOperationName;
    readonly notify: (notification: ProtocolNotificationV1) => void;
    readonly events: ProtocolOperationEventV1[];
    readonly countedActive: boolean;
    readonly cancellable: boolean;
    cancellationRequested: boolean;
    state: "reserved" | "running" | "completed";
}

const DEFAULT_MAXIMUM_ACTIVE_OPERATIONS = 64;
const DEFAULT_MAXIMUM_COMPLETED_OPERATIONS = 128;
const MAXIMUM_ID_ATTEMPTS = 4;
const CANCELLABLE_OPERATIONS = new Set<ProtocolAcceptedLongOperationName>(["asset_version.compare"]);

export class HostOperationManager {
    readonly #createOperationId: () => string;
    readonly #maximumActiveOperations: number;
    readonly #maximumCompletedOperations: number;
    readonly #operations = new Map<string, StoredOperation>();
    readonly #completedOrder: string[] = [];
    readonly #idleWaiters = new Set<IdleWaiter>();
    #activeCount = 0;

    public constructor(options: OperationManagerOptions) {
        this.#createOperationId = options.createOperationId;
        this.#maximumActiveOperations = options.maximumActiveOperations ?? DEFAULT_MAXIMUM_ACTIVE_OPERATIONS;
        this.#maximumCompletedOperations = options.maximumCompletedOperations ?? DEFAULT_MAXIMUM_COMPLETED_OPERATIONS;
        if (this.#maximumActiveOperations < 1 || this.#maximumCompletedOperations < 1) {
            throw new Error("Operation manager bounds must be positive");
        }
    }

    public reserve(
        operation: ProtocolAcceptedLongOperationName,
        notify: (notification: ProtocolNotificationV1) => void,
    ): OperationReservation {
        const operationId = this.#nextOperationId();
        const countedActive = this.#activeCount < this.#maximumActiveOperations;
        if (countedActive) this.#activeCount += 1;
        this.#operations.set(operationId, {
            operationId,
            operation,
            notify,
            events: [],
            countedActive,
            cancellable: CANCELLABLE_OPERATIONS.has(operation),
            cancellationRequested: false,
            state: "reserved",
        });
        return Object.freeze({ operationId });
    }

    public abandon(reservation: OperationReservation): void {
        const operation = this.#operations.get(reservation.operationId);
        if (operation?.state !== "reserved") return;
        this.#operations.delete(reservation.operationId);
        if (operation.countedActive) this.#releaseActive();
    }

    public start(reservation: OperationReservation, run: (context: OperationRunContext) => Promise<unknown>): void {
        const operation = this.#operations.get(reservation.operationId);
        if (operation?.state !== "reserved") throw new Error("Operation reservation is unavailable");
        operation.state = "running";
        queueMicrotask(() => {
            if (!operation.countedActive) {
                this.#complete(operation, hostCapacityFailure());
                return;
            }
            void this.#run(operation, run);
        });
    }

    public observe(operationId: string, afterSequence: number) {
        const operation = this.#operations.get(operationId);
        return operation === undefined
            ? { status: "operation_unavailable" as const, events: [] as [] }
            : {
                  status: "available" as const,
                  events: operation.events.filter((event) => event.sequence > afterSequence),
              };
    }

    public requestCancellation(operationId: string) {
        const operation = this.#operations.get(operationId);
        if (operation === undefined) return { status: "operation_unavailable" as const };
        if (!operation.cancellable || operation.state === "completed") return { status: "not_cancellable" as const };
        operation.cancellationRequested = true;
        return { status: "requested" as const };
    }

    public async waitForIdle(): Promise<void> {
        await this.#waitForIdle();
    }

    public async waitForIdleExcluding(operationId: string): Promise<void> {
        await this.#waitForIdle(operationId);
    }

    async #waitForIdle(excludedOperationId?: string): Promise<void> {
        if (this.#activeCountExcluding(excludedOperationId) === 0) return;
        await new Promise<void>((resolve) => {
            this.#idleWaiters.add({
                ...(excludedOperationId === undefined ? {} : { excludedOperationId }),
                resolve,
            });
        });
    }

    async #run(operation: StoredOperation, run: (context: OperationRunContext) => Promise<unknown>): Promise<void> {
        const afterTerminalCallbacks: Array<() => void> = [];
        let outcome: unknown;
        try {
            outcome = parseProtocolTerminalOutcome(
                operation.operation,
                await run({
                    operationId: operation.operationId,
                    reportProgress: (progress) => this.#reportProgress(operation, progress),
                    afterTerminal: (callback) => afterTerminalCallbacks.push(callback),
                    isCancellationRequested: () => operation.cancellationRequested,
                }),
            );
        } catch {
            outcome = parseProtocolTerminalOutcome(operation.operation, hostInvocationFailure());
        }
        this.#complete(operation, outcome);
        for (const callback of afterTerminalCallbacks) {
            try {
                callback();
            } catch {
                // A post-terminal process-lifecycle signal cannot rewrite the retained terminal outcome.
            }
        }
    }

    #reportProgress(operation: StoredOperation, progress: unknown): void {
        if (operation.state !== "running") throw new Error("Operation is not accepting progress");
        const parsedProgress = parseProtocolOperationProgress(operation.operation, progress) as ProtocolOperationProgress<
            typeof operation.operation
        >;
        this.#assertMonotonicProgress(operation, parsedProgress);
        const sequence = operation.events.length + 1;
        const event = Object.freeze({
            eventKind: "progress" as const,
            operationId: operation.operationId,
            sequence,
            operation: operation.operation,
            progress: parsedProgress,
        }) as ProtocolOperationEventV1;
        operation.events.push(event);
        try {
            operation.notify(
                createProtocolNotification({
                    method: "operation.progress",
                    params: {
                        operationId: operation.operationId,
                        sequence,
                        operation: operation.operation,
                        progress: parsedProgress,
                    },
                } as ProtocolNotificationV1),
            );
        } catch {
            // Losing an optional push notification cannot alter retained progress or final authority.
        }
    }

    #assertMonotonicProgress(operation: StoredOperation, progress: ProtocolOperationProgress<typeof operation.operation>): void {
        if (progress.completedUnits > progress.totalUnits) {
            throw new Error("Operation progress cannot exceed its total units");
        }
        let previous: Extract<ProtocolOperationEventV1, { readonly eventKind: "progress" }> | undefined;
        for (let index = operation.events.length - 1; index >= 0; index -= 1) {
            const event = operation.events[index];
            if (event?.eventKind === "progress" && event.progress.stage === progress.stage) {
                previous = event;
                break;
            }
        }
        if (previous === undefined) return;
        if (progress.totalUnits !== previous.progress.totalUnits) {
            throw new Error("Operation progress total units cannot change within one stage");
        }
        if (progress.completedUnits < previous.progress.completedUnits) {
            throw new Error("Operation progress cannot regress within one stage");
        }
    }

    #complete(operation: StoredOperation, outcome: unknown): void {
        const sequence = operation.events.length + 1;
        const parsedOutcome = parseProtocolTerminalOutcome(operation.operation, outcome);
        const event = Object.freeze({
            eventKind: "terminal" as const,
            operationId: operation.operationId,
            sequence,
            operation: operation.operation,
            outcome: parsedOutcome,
        }) as ProtocolOperationEventV1;
        operation.events.push(event);
        operation.state = "completed";
        this.#completedOrder.push(operation.operationId);
        if (operation.countedActive) this.#releaseActive();
        this.#evictCompleted();
        try {
            operation.notify(
                createProtocolNotification({
                    method: "operation.terminal",
                    params: {
                        operationId: operation.operationId,
                        sequence,
                        operation: operation.operation,
                        outcome: parsedOutcome,
                    },
                } as ProtocolNotificationV1),
            );
        } catch {
            // Losing an optional push notification cannot alter the retained operation result.
        }
    }

    #releaseActive(): void {
        this.#activeCount -= 1;
        this.#resolveIdleWaiters();
    }

    #activeCountExcluding(excludedOperationId?: string): number {
        if (excludedOperationId === undefined) return this.#activeCount;
        let count = 0;
        for (const operation of this.#operations.values()) {
            if (operation.countedActive && operation.state !== "completed" && operation.operationId !== excludedOperationId) {
                count += 1;
            }
        }
        return count;
    }

    #resolveIdleWaiters(): void {
        for (const waiter of this.#idleWaiters) {
            if (this.#activeCountExcluding(waiter.excludedOperationId) !== 0) continue;
            this.#idleWaiters.delete(waiter);
            waiter.resolve();
        }
    }

    #evictCompleted(): void {
        while (this.#completedOrder.length > this.#maximumCompletedOperations) {
            this.#operations.delete(this.#completedOrder.shift() as string);
        }
    }

    #nextOperationId(): string {
        for (let attempt = 0; attempt < MAXIMUM_ID_ATTEMPTS; attempt += 1) {
            const candidate = this.#createOperationId();
            if (candidate.length > 0 && candidate.trim() === candidate && !this.#operations.has(candidate)) return candidate;
        }
        throw new Error("Could not allocate a unique operation id");
    }
}
