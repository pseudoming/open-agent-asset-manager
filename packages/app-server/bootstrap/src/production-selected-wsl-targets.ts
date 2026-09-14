/** Process ownership for complete operations on an exact selected Deployment target. */
import { createHash, randomUUID } from "node:crypto";
import {
    createRestrictedProcessPool,
    RestrictedProcessStartError,
    resolveInstalledRestrictedCode,
    type RestrictedProcessTransport,
} from "@oaam/app-server-host";
import {
    createRestrictedTargetBinding,
    createRestrictedUsageTargetBinding,
    createRestrictedTargetChannel,
    RESTRICTED_TARGET_MAX_FRAME_BYTES,
    RESTRICTED_TARGET_PROTOCOL,
    type DeploymentTargetExecution,
    type AssetUsageTargetExecution,
    type RestrictedTargetBinding,
    type RestrictedUsageTargetBinding,
} from "@oaam/core/restricted-operations";
import type {
    PlatformContext,
    SelectedWslTargetExecution,
    SelectedWslTargetRequest,
    SelectedWslUsageTargetRequest,
} from "@oaam/core";

type TargetAdmission =
    | { kind: "deployment"; request: SelectedWslTargetRequest }
    | { kind: "usage"; request: SelectedWslUsageTargetRequest };

interface TargetPeer {
    readonly key: string;
    readonly transport: RestrictedProcessTransport;
    readonly channel: ReturnType<typeof createRestrictedTargetChannel>;
    readonly execution: DeploymentTargetExecution | AssetUsageTargetExecution;
    readonly deadlineAt: number;
    businessOperations: number;
    retired: boolean;
}
interface EnvironmentSlot {
    readonly context: PlatformContext;
    admission: Promise<void>;
    readonly peers: Partial<Record<TargetAdmission["kind"], TargetPeer>>;
    uncertain?: unknown;
}
interface Dependencies {
    readonly createPool: typeof createRestrictedProcessPool;
    readonly resolveCode: typeof resolveInstalledRestrictedCode;
    readonly now: () => number;
}

const key = (context: PlatformContext) => JSON.stringify([context.platform, context.platformInstanceId, context.accessRootPath]);
const MAXIMUM_BUSINESS_OPERATIONS = 128;
const ADMISSION_OPERATION_ALLOWANCE = 8;
const REQUEST_WINDOW_MILLISECONDS = 30_000;
const SERVICE_MILLISECONDS = 600_000;

export function createProductionSelectedWslTargets(
    contexts: readonly PlatformContext[],
    oaamRoot: string,
    getHostInstanceId: () => string,
) {
    return createProductionSelectedWslTargetsForTest(contexts, oaamRoot, getHostInstanceId, {
        createPool: createRestrictedProcessPool,
        resolveCode: resolveInstalledRestrictedCode,
        now: Date.now,
    });
}

/** @internal Controls substitute code location, time and process ownership, not operation results. */
export function createProductionSelectedWslTargetsForTest(
    contexts: readonly PlatformContext[],
    oaamRoot: string,
    getHostInstanceId: () => string,
    dependencies: Dependencies,
) {
    const pool = dependencies.createPool();
    const slots = new Map<string, EnvironmentSlot>(
        contexts
            .filter((context) => context.platform === "wsl")
            .map((context) => [key(context), { context: structuredClone(context), admission: Promise.resolve(), peers: {} }]),
    );
    let closing = false;
    let shutdown: Promise<void> | undefined;

    async function createPeer(slot: EnvironmentSlot, admission: TargetAdmission, targetKey: string): Promise<TargetPeer> {
        try {
            const binding =
                admission.kind === "deployment"
                    ? createRestrictedTargetBinding({ ...admission.request, platformContext: slot.context }, randomUUID())
                    : createRestrictedUsageTargetBinding({ ...admission.request, platformContext: slot.context }, randomUUID());
            const installed = await dependencies.resolveCode(slot.context.platformInstanceId);
            if (closing) throw new Error("restricted target owner is shutting down");
            const session = {
                protocol: RESTRICTED_TARGET_PROTOCOL,
                hostInstanceId: getHostInstanceId(),
                sessionId: randomUUID(),
            };
            const poolKey = createHash("sha256")
                .update(
                    JSON.stringify([session.hostInstanceId, oaamRoot, slot.context, session.protocol, installed.code, targetKey]),
                )
                .digest("hex");
            const deadlineAt = dependencies.now() + SERVICE_MILLISECONDS;
            const transport = await pool.acquire(poolKey, () => ({
                session,
                distroName: slot.context.platformInstanceId,
                ...installed,
                operation: {
                    protocol: RESTRICTED_TARGET_PROTOCOL,
                    configuration: {
                        hostInstanceId: session.hostInstanceId,
                        sessionId: session.sessionId,
                        bindings: [binding],
                        deadlineAt,
                    },
                },
                deadlineAt,
                maximumFrameBytes: RESTRICTED_TARGET_MAX_FRAME_BYTES,
                maximumConcurrentRequests: 1,
            }));
            let peer!: TargetPeer;
            const channel = createRestrictedTargetChannel(session, (input) => {
                if (input.operation.kind !== "continue_graph") {
                    if (peer.businessOperations >= MAXIMUM_BUSINESS_OPERATIONS)
                        throw new Error("restricted target operation budget exhausted");
                    peer.businessOperations += 1;
                }
                return transport.exchangeSync(input);
            });
            peer = {
                key: targetKey,
                transport,
                channel,
                execution:
                    admission.kind === "deployment"
                        ? channel.bind(binding as RestrictedTargetBinding)
                        : channel.bindUsage(binding as RestrictedUsageTargetBinding),
                deadlineAt,
                businessOperations: 0,
                retired: false,
            };
            return peer;
        } catch (error) {
            if (error instanceof RestrictedProcessStartError && !error.cleanupConfirmed) slot.uncertain = error;
            throw error;
        }
    }

    async function reserve(slot: EnvironmentSlot, admission: TargetAdmission): Promise<TargetPeer> {
        if (closing) throw new Error("restricted target owner is shutting down");
        if (slot.uncertain !== undefined) throw slot.uncertain;
        const targetKey =
            admission.kind === "deployment"
                ? JSON.stringify([admission.kind, admission.request.deploymentId, admission.request.targetRootPath])
                : JSON.stringify([admission.kind, admission.request.targetRootPath]);
        const previous = slot.peers[admission.kind];
        if (
            previous !== undefined &&
            (previous.key !== targetKey ||
                previous.retired ||
                !previous.transport.available ||
                !previous.channel.available ||
                previous.businessOperations + ADMISSION_OPERATION_ALLOWANCE > MAXIMUM_BUSINESS_OPERATIONS ||
                dependencies.now() + REQUEST_WINDOW_MILLISECONDS >= previous.deadlineAt)
        ) {
            previous.retired = true;
            try {
                await previous.transport.close();
            } catch (error) {
                slot.uncertain = error;
                throw error;
            }
            slot.peers[admission.kind] = undefined;
        }
        const peer = slot.peers[admission.kind] ?? (await createPeer(slot, admission, targetKey));
        slot.peers[admission.kind] = peer;
        if (closing) throw new Error("restricted target owner is shutting down");
        return peer;
    }

    async function withPeer<T>(admission: TargetAdmission, run: (peer: TargetPeer) => T | Promise<T>): Promise<T> {
        if (closing) throw new Error("restricted target owner is shutting down");
        const frozen = structuredClone(admission);
        const slot = slots.get(key(frozen.request.platformContext));
        if (slot === undefined) throw new Error("restricted target Environment is outside this Host");
        const operation = slot.admission.then(async () => {
            const peer = await reserve(slot, frozen);
            try {
                return await run(peer);
            } finally {
                if (!peer.channel.available || !peer.transport.available) peer.retired = true;
            }
        });
        slot.admission = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    }

    const execution: SelectedWslTargetExecution = Object.freeze<SelectedWslTargetExecution>({
        withTarget(request, run) {
            return withPeer({ kind: "deployment", request }, (peer) => run(peer.execution as DeploymentTargetExecution));
        },
        withUsageTarget(request, run) {
            return withPeer({ kind: "usage", request }, (peer) => run(peer.execution as AssetUsageTargetExecution));
        },
    });

    function close(): Promise<void> {
        if (shutdown !== undefined) return shutdown;
        closing = true;
        shutdown = (async () => {
            await Promise.all([...slots.values()].map((slot) => slot.admission));
            const errors: unknown[] = [];
            try {
                await pool.close();
            } catch (error) {
                errors.push(error);
            }
            for (const slot of slots.values()) if (slot.uncertain !== undefined) errors.push(slot.uncertain);
            if (errors.length > 0) throw new AggregateError(errors, "restricted target release was not confirmed");
        })();
        return shutdown;
    }
    return Object.freeze({ execution, close });
}
