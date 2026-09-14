/** One process/session/channel owner for each selected Environment in this Windows Host. */
import { createHash, randomUUID } from "node:crypto";
import {
    createRestrictedProcessPool,
    RestrictedProcessStartError,
    resolveInstalledRestrictedCode,
    type RestrictedProcessTransport,
} from "@oaam/app-server-host";
import {
    createRestrictedProbeChannel,
    RESTRICTED_PROBE_MAX_FRAME_BYTES,
    RESTRICTED_PROBE_PROTOCOL,
    type RestrictedBuildObservationSelection,
} from "@oaam/core/restricted-operations";
import type { AdapterProbeContext, PlatformContext, SelectedWslProbeExecution } from "@oaam/core";

interface ProbePeer {
    readonly transport: RestrictedProcessTransport;
    readonly channel: ReturnType<typeof createRestrictedProbeChannel>;
    readonly deadlineAt: number;
    readonly inFlight: Set<Promise<void>>;
    admitted: number;
    retired: boolean;
}
interface EnvironmentSlot {
    readonly context: PlatformContext;
    admission: Promise<void>;
    current?: ProbePeer;
    uncertain?: unknown;
}
interface Dependencies {
    readonly createPool: typeof createRestrictedProcessPool;
    readonly resolveCode: typeof resolveInstalledRestrictedCode;
    readonly now: () => number;
}

const MAXIMUM_REQUESTS = 128;
const MAXIMUM_IN_FLIGHT = 16;
const REQUEST_WINDOW_MILLISECONDS = 30_000;
const SERVICE_MILLISECONDS = 600_000;
const key = (context: PlatformContext) => JSON.stringify([context.platform, context.platformInstanceId, context.accessRootPath]);

export function createProductionSelectedWslProbes(
    contexts: readonly PlatformContext[],
    oaamRoot: string,
    getHostInstanceId: () => string,
) {
    return createProductionSelectedWslProbesForTest(contexts, oaamRoot, getHostInstanceId, {
        createPool: createRestrictedProcessPool,
        resolveCode: resolveInstalledRestrictedCode,
        now: Date.now,
    });
}

/** @internal Only package location, process ownership and time are replaceable in controls. */
export function createProductionSelectedWslProbesForTest(
    contexts: readonly PlatformContext[],
    oaamRoot: string,
    getHostInstanceId: () => string,
    dependencies: Dependencies,
) {
    const pool = dependencies.createPool();
    const slots = new Map<string, EnvironmentSlot>(
        contexts
            .filter((context) => context.platform === "wsl")
            .map((context) => [key(context), { context: structuredClone(context), admission: Promise.resolve() }]),
    );
    let closing = false;
    let shutdown: Promise<void> | undefined;

    async function createPeer(slot: EnvironmentSlot): Promise<ProbePeer> {
        try {
            const installed = await dependencies.resolveCode(slot.context.platformInstanceId);
            if (closing) throw new Error("restricted probe owner is shutting down");
            const session = {
                protocol: RESTRICTED_PROBE_PROTOCOL,
                hostInstanceId: getHostInstanceId(),
                sessionId: randomUUID(),
            };
            const poolKey = createHash("sha256")
                .update(JSON.stringify([session.hostInstanceId, oaamRoot, slot.context, session.protocol, installed.code]))
                .digest("hex");
            const deadlineAt = dependencies.now() + SERVICE_MILLISECONDS;
            const transport = await pool.acquire(poolKey, () => ({
                session,
                distroName: slot.context.platformInstanceId,
                ...installed,
                operation: {
                    protocol: RESTRICTED_PROBE_PROTOCOL,
                    configuration: {
                        hostInstanceId: session.hostInstanceId,
                        sessionId: session.sessionId,
                        platformContext: slot.context,
                        deadlineAt,
                    },
                },
                deadlineAt,
                maximumFrameBytes: RESTRICTED_PROBE_MAX_FRAME_BYTES,
                maximumConcurrentRequests: MAXIMUM_IN_FLIGHT,
            }));
            const channel = createRestrictedProbeChannel({
                ...session,
                platformContext: slot.context,
                exchange: (request) => transport.exchange(request),
            });
            return { transport, channel, deadlineAt, inFlight: new Set(), admitted: 0, retired: false };
        } catch (error) {
            if (error instanceof RestrictedProcessStartError && !error.cleanupConfirmed) slot.uncertain = error;
            throw error;
        }
    }

    async function reserve(slot: EnvironmentSlot) {
        for (;;) {
            if (closing) throw new Error("restricted probe owner is shutting down");
            if (slot.uncertain !== undefined) throw slot.uncertain;
            const previous = slot.current;
            if (
                previous !== undefined &&
                (previous.retired ||
                    !previous.transport.available ||
                    previous.admitted >= MAXIMUM_REQUESTS ||
                    dependencies.now() + REQUEST_WINDOW_MILLISECONDS >= previous.deadlineAt)
            ) {
                previous.retired = true;
                await Promise.all(previous.inFlight);
                try {
                    await previous.transport.close();
                } catch (error) {
                    slot.uncertain = error;
                    throw error;
                }
                slot.current = undefined;
                continue;
            }
            if (previous !== undefined && previous.inFlight.size >= MAXIMUM_IN_FLIGHT) {
                await Promise.race(previous.inFlight);
                continue;
            }
            const peer = previous ?? (await createPeer(slot));
            slot.current = peer;
            if (closing) throw new Error("restricted probe owner is shutting down");
            peer.admitted += 1;
            let release!: () => void;
            const completed = new Promise<void>((resolve) => {
                release = resolve;
            });
            peer.inFlight.add(completed);
            return {
                peer,
                release: () => {
                    peer.inFlight.delete(completed);
                    release();
                },
            };
        }
    }

    async function withPeer<T>(context: PlatformContext, run: (channel: ProbePeer["channel"]) => Promise<T>): Promise<T> {
        const slot = slots.get(key(context));
        if (slot === undefined) throw new Error("restricted probe Environment is outside this Host");
        const reservation = slot.admission.then(() => reserve(slot));
        slot.admission = reservation.then(
            () => undefined,
            () => undefined,
        );
        const lease = await reservation;
        try {
            return await run(lease.peer.channel);
        } catch (error) {
            lease.peer.retired = true;
            throw error;
        } finally {
            lease.release();
        }
    }
    const execution: SelectedWslProbeExecution = Object.freeze({
        probe(adapterId: string, context: AdapterProbeContext) {
            const request = structuredClone(context);
            return withPeer(request.platformContext, (channel) => channel.probe(adapterId, request));
        },
        observeBuildArtifacts(source: RestrictedBuildObservationSelection) {
            const selection = structuredClone(source);
            const context = selection.platformContext;
            if (context === undefined) return Promise.reject(new Error("restricted build observation has no Environment"));
            return withPeer(context, (channel) => channel.observeBuildArtifacts(selection));
        },
    });

    function close(): Promise<void> {
        if (shutdown !== undefined) return shutdown;
        closing = true;
        shutdown = (async () => {
            const results = await Promise.allSettled([pool.close(), ...[...slots.values()].map((slot) => slot.admission)]);
            const errors = results
                .filter((result): result is PromiseRejectedResult => result.status === "rejected")
                .map((result) => result.reason as unknown);
            for (const slot of slots.values()) if (slot.uncertain !== undefined) errors.push(slot.uncertain);
            if (errors.length !== 0) throw new AggregateError(errors, "restricted probe release was not confirmed");
        })();
        return shutdown;
    }
    return Object.freeze({ execution, close });
}
