/** Serialized source-read lifetimes for each exact selected Environment; Core owns Host locks and read authority. */
import { createHash, randomUUID } from "node:crypto";
import {
    createRestrictedProcessPool,
    DEFAULT_HOST_REVIEW_RECORD_MAXIMUM_BYTES,
    RestrictedProcessStartError,
    resolveInstalledRestrictedCode,
    type RestrictedProcessTransport,
} from "@oaam/app-server-host";
import {
    createRestrictedSourceChannel,
    RESTRICTED_SOURCE_MAX_FRAME_BYTES,
    RESTRICTED_SOURCE_PROTOCOL,
    type SelectedWslSourceExecution,
    type SelectedWslSourceReadRequest,
} from "@oaam/core/restricted-operations";
import type { PlatformContext } from "@oaam/core";

interface SourcePeer {
    readonly transport: RestrictedProcessTransport;
    readonly channel: ReturnType<typeof createRestrictedSourceChannel>;
    readonly deadlineAt: number;
}
interface EnvironmentSlot {
    readonly context: PlatformContext;
    admission: Promise<void>;
    current?: SourcePeer;
    uncertain?: unknown;
}
interface Dependencies {
    readonly createPool: typeof createRestrictedProcessPool;
    readonly resolveCode: typeof resolveInstalledRestrictedCode;
    readonly now: () => number;
}
const key = (context: PlatformContext) => JSON.stringify([context.platform, context.platformInstanceId, context.accessRootPath]);
const SOURCE_OPERATION_HEADROOM_MILLISECONDS = 120_000;
const SERVICE_MILLISECONDS = 600_000;

export function createProductionSelectedWslSources(
    contexts: readonly PlatformContext[],
    oaamRoot: string,
    getHostInstanceId: () => string,
) {
    return createProductionSelectedWslSourcesForTest(
        contexts,
        oaamRoot,
        getHostInstanceId,
        {
            createPool: createRestrictedProcessPool,
            resolveCode: resolveInstalledRestrictedCode,
            now: Date.now,
        },
        DEFAULT_HOST_REVIEW_RECORD_MAXIMUM_BYTES,
    );
}

/** @internal Substitute physical process ownership, package location, time and the actual Host consumer capacity. */
export function createProductionSelectedWslSourcesForTest(
    contexts: readonly PlatformContext[],
    oaamRoot: string,
    getHostInstanceId: () => string,
    dependencies: Dependencies,
    maximumResultBytes = DEFAULT_HOST_REVIEW_RECORD_MAXIMUM_BYTES,
) {
    const pool = dependencies.createPool();
    const slots = new Map<string, EnvironmentSlot>(
        contexts
            .filter((context) => context.platform === "wsl")
            .map((context) => [key(context), { context: structuredClone(context), admission: Promise.resolve() }]),
    );
    let closing = false;
    let shutdown: Promise<void> | undefined;

    async function createPeer(slot: EnvironmentSlot): Promise<SourcePeer> {
        try {
            const installed = await dependencies.resolveCode(slot.context.platformInstanceId);
            if (closing) throw new Error("restricted source owner is shutting down");
            const session = {
                protocol: RESTRICTED_SOURCE_PROTOCOL,
                hostInstanceId: getHostInstanceId(),
                sessionId: randomUUID(),
            };
            const deadlineAt = dependencies.now() + SERVICE_MILLISECONDS;
            const poolKey = createHash("sha256")
                .update(
                    JSON.stringify([
                        session.hostInstanceId,
                        oaamRoot,
                        slot.context,
                        session.protocol,
                        installed.code,
                        maximumResultBytes,
                    ]),
                )
                .digest("hex");
            const transport = await pool.acquire(poolKey, () => ({
                session,
                distroName: slot.context.platformInstanceId,
                ...installed,
                deadlineAt,
                maximumFrameBytes: RESTRICTED_SOURCE_MAX_FRAME_BYTES,
                maximumConcurrentRequests: 1,
                operation: {
                    protocol: RESTRICTED_SOURCE_PROTOCOL,
                    configuration: {
                        hostInstanceId: session.hostInstanceId,
                        sessionId: session.sessionId,
                        platformContext: slot.context,
                        deadlineAt,
                        maximumResultBytes,
                    },
                },
            }));
            const channel = createRestrictedSourceChannel({
                ...session,
                platformContext: slot.context,
                deadlineAt,
                maximumResultBytes,
                exchange: (request) => transport.exchange(request),
                async abort() {
                    try {
                        await transport.close();
                        slot.uncertain = undefined;
                    } catch (error) {
                        slot.uncertain = error;
                        throw error;
                    }
                },
            });
            return { transport, channel, deadlineAt };
        } catch (error) {
            if (error instanceof RestrictedProcessStartError && !error.cleanupConfirmed) slot.uncertain = error;
            throw error;
        }
    }
    async function reserve(slot: EnvironmentSlot): Promise<SourcePeer> {
        if (closing) throw new Error("restricted source owner is shutting down");
        if (slot.uncertain !== undefined) throw slot.uncertain;
        const current = slot.current;
        if (
            current !== undefined &&
            (!current.transport.available ||
                !current.channel.available ||
                dependencies.now() + SOURCE_OPERATION_HEADROOM_MILLISECONDS >= current.deadlineAt)
        ) {
            await current.channel.close();
            slot.current = undefined;
        }
        const peer = slot.current ?? (await createPeer(slot));
        slot.current = peer;
        if (closing) throw new Error("restricted source owner is shutting down");
        return peer;
    }
    const execution: SelectedWslSourceExecution = Object.freeze<SelectedWslSourceExecution>({
        async read(request) {
            if (closing) throw new Error("restricted source owner is shutting down");
            // Freeze all data before waiting for the preceding read; retain only the existing Host revalidator function.
            const frozen: SelectedWslSourceReadRequest = {
                ...structuredClone({
                    platformContext: request.platformContext,
                    target: request.target,
                    preparation: request.preparation,
                    authority: request.authority,
                }),
                revalidateAuthority: request.revalidateAuthority,
            };
            const slot = slots.get(key(frozen.platformContext));
            if (slot === undefined) throw new Error("restricted source Environment is outside this Host");
            const operation = slot.admission.then(async () => (await reserve(slot)).channel.read(frozen));
            slot.admission = operation.then(
                () => undefined,
                () => undefined,
            );
            return operation;
        },
    });
    function close(): Promise<void> {
        if (shutdown !== undefined) return shutdown;
        closing = true;
        shutdown = (async () => {
            await Promise.all([...slots.values()].map((slot) => slot.admission));
            const closed = await Promise.allSettled([...slots.values()].map((slot) => slot.current?.channel.close()));
            const errors: unknown[] = closed.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
            try {
                await pool.close();
            } catch (error) {
                errors.push(error);
            }
            for (const slot of slots.values()) if (slot.uncertain !== undefined) errors.push(slot.uncertain);
            if (errors.length > 0) throw new AggregateError(errors, "restricted source release was not confirmed");
        })();
        return shutdown;
    }
    return Object.freeze({ execution, close });
}
