import {
    RestrictedProcessStartError,
    startRestrictedProcessTransport,
    type RestrictedProcessLaunch,
    type RestrictedProcessTransport,
} from "./restricted-process-client";

interface ProcessEntry {
    readonly promise: Promise<RestrictedProcessTransport>;
    peer?: RestrictedProcessTransport;
}

/** Bootstrap supplies exact session keys and launch inputs; Host owns bounded process reuse and release. */
export function createRestrictedProcessPool(maximumProcesses = 8) {
    return createRestrictedProcessPoolForTest(maximumProcesses, startRestrictedProcessTransport);
}

/** @internal Deterministic lifecycle tests supply process owners, never business responses. */
export function createRestrictedProcessPoolForTest(
    maximumProcesses: number,
    start: (configuration: RestrictedProcessLaunch) => Promise<RestrictedProcessTransport>,
) {
    if (!Number.isSafeInteger(maximumProcesses) || maximumProcesses < 1 || maximumProcesses > 16)
        throw new RangeError("invalid restricted process pool bound");
    const entries = new Map<string, ProcessEntry>();
    let closing = false;
    let shutdown: Promise<void> | undefined;
    let admission: Promise<void> = Promise.resolve();
    const releasedFailure = (error: unknown) => error instanceof RestrictedProcessStartError && error.cleanupConfirmed;

    function launch(key: string, configure: () => RestrictedProcessLaunch) {
        const entry: ProcessEntry = {
            promise: Promise.resolve().then(async () => {
                let configuration: RestrictedProcessLaunch;
                try {
                    if (closing) throw new Error("restricted process pool is shutting down");
                    configuration = configure();
                } catch (error) {
                    throw new RestrictedProcessStartError(true, error);
                }
                const peer = await start(configuration);
                entry.peer = peer;
                return peer;
            }),
        };
        entries.set(key, entry);
        void entry.promise.catch((error: unknown) => {
            if (releasedFailure(error) && entries.get(key) === entry) entries.delete(key);
        });
        return entry;
    }

    async function acquire(key: string, configure: () => RestrictedProcessLaunch): Promise<RestrictedProcessTransport> {
        // Admission and replacement are serialized; independent process startups remain concurrent.
        const selected = admission.then(async () => {
            if (closing) throw new Error("restricted process pool is shutting down");
            if (key.length === 0 || key.length > 512 || key.includes("\0")) throw new Error("invalid restricted process key");
            const previous = entries.get(key);
            if (previous !== undefined) {
                if (previous.peer === undefined || previous.peer.available) return previous;
                await previous.peer.close();
                entries.delete(key);
            }
            if (entries.size >= maximumProcesses) {
                const inactive = [...entries].find(([, entry]) => entry.peer !== undefined && !entry.peer.available);
                if (inactive === undefined) throw new Error("restricted process pool is at capacity");
                await inactive[1].peer!.close();
                entries.delete(inactive[0]);
            }
            if (closing) throw new Error("restricted process pool is shutting down");
            return launch(key, configure);
        });
        admission = selected.then(
            () => undefined,
            () => undefined,
        );
        const peer = await (await selected).promise;
        if (closing) throw new Error("restricted process pool is shutting down");
        return peer;
    }

    function close(): Promise<void> {
        if (shutdown !== undefined) return shutdown;
        closing = true;
        shutdown = (async () => {
            await admission;
            const owned = [...entries.values()];
            const results = await Promise.allSettled(
                owned.map(async ({ promise }) => {
                    let peer: RestrictedProcessTransport;
                    try {
                        peer = await promise;
                    } catch (error) {
                        if (releasedFailure(error)) return;
                        throw error;
                    }
                    await peer.close();
                }),
            );
            const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
            if (failures.length > 0)
                throw new AggregateError(
                    failures.map((failure) => failure.reason),
                    "restricted process cleanup was not confirmed",
                );
            entries.clear();
        })();
        return shutdown;
    }

    return Object.freeze({ acquire, close });
}
