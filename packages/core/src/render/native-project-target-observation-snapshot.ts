/** Host-probe build observations with a fresh target-file view for each target check. */

import type { PhysicalPathIdentity, StableRegularFileRead } from "@oaam/shared/filesystem";
import { sha256Bytes } from "../foundation/crypto-bytes";
import { stableStringify } from "../foundation/fingerprint";
import type { ProbeResult, Sha256Digest } from "../types";

export interface StableBuildArtifactObservation {
    readonly executable: boolean;
    readonly identity: PhysicalPathIdentity;
    readonly byteSize: number;
    readonly buildIdentity: Sha256Digest;
}

interface TargetCheckBuildObservationState {
    readonly requests: Map<
        string,
        | { readonly status: "pending"; readonly observation: Promise<StableBuildArtifactObservation> }
        | { readonly status: "complete"; readonly exactKey: string }
        | { readonly status: "failed"; readonly error: unknown }
    >;
    readonly observations: Map<string, StableBuildArtifactObservation>;
    prewarmedBuilds?: {
        readonly key: string;
        readonly filePaths: ReadonlySet<string>;
        readonly terminal: Promise<
            | { readonly status: "complete"; readonly results: ReadonlyMap<string, TargetCheckBuildObservationResult> }
            | { readonly status: "failed"; readonly error: unknown }
        >;
    };
}

interface TargetCheckFileObservationState {
    readonly targetFileRequests: Map<
        string,
        | { readonly status: "pending"; readonly observation: Promise<StableRegularFileRead> }
        | { readonly status: "complete"; readonly exactKey: string }
        | { readonly status: "failed"; readonly error: unknown }
    >;
    readonly targetFiles: Map<string, StableRegularFileRead>;
}

interface TargetCheckObservationSnapshotState {
    readonly build: TargetCheckBuildObservationState;
    readonly targetFile: TargetCheckFileObservationState;
}

export type TargetCheckBuildObservationResult =
    | { readonly status: "complete"; readonly observation: StableBuildArtifactObservation }
    | { readonly status: "failed"; readonly error: unknown };

/** @internal One target-check view over retained build facts and fresh target-file facts. */
export interface TargetCheckObservationSnapshot {
    readonly snapshotKind: "target_check_observation";
}

const SNAPSHOT_STATES = new WeakMap<TargetCheckObservationSnapshot, TargetCheckObservationSnapshotState>();

/** @internal Create one operation-local snapshot. This object is never persisted or reused across user checks. */
export function createTargetCheckObservationSnapshot(): TargetCheckObservationSnapshot {
    return createTargetCheckObservationSnapshotWithBuildState(createTargetCheckBuildObservationState());
}

function createTargetCheckObservationSnapshotWithBuildState(
    build: TargetCheckBuildObservationState,
): TargetCheckObservationSnapshot {
    const snapshot = Object.freeze({ snapshotKind: "target_check_observation" as const });
    SNAPSHOT_STATES.set(snapshot, {
        build,
        targetFile: { targetFileRequests: new Map(), targetFiles: new Map() },
    });
    return snapshot;
}

function createTargetCheckBuildObservationState(): TargetCheckBuildObservationState {
    return { requests: new Map(), observations: new Map() };
}

/** @internal Reuse build facts for one Host probe array while keeping every target-file check fresh. */
export class TargetCheckObservationScopes {
    readonly #buildScopes = new WeakMap<readonly ProbeResult[], TargetCheckBuildObservationState>();

    public for(currentProbeResults: readonly ProbeResult[]): TargetCheckObservationSnapshot {
        if (!Object.isFrozen(currentProbeResults)) return createTargetCheckObservationSnapshot();
        let retained = this.#buildScopes.get(currentProbeResults);
        if (retained === undefined) {
            retained = createTargetCheckBuildObservationState();
            this.#buildScopes.set(currentProbeResults, retained);
        }
        return createTargetCheckObservationSnapshotWithBuildState(retained);
    }
}

/** @internal Read once per exact physical identity within one Host probe's build scope. */
export function observeStableBuildArtifactForTargetCheck(
    requestIdentity: Readonly<Record<string, unknown>>,
    snapshot: TargetCheckObservationSnapshot | undefined,
    readFresh: () => StableRegularFileRead,
): StableBuildArtifactObservation {
    const state = snapshot === undefined ? undefined : SNAPSHOT_STATES.get(snapshot);
    if (snapshot !== undefined && state === undefined) throw new TypeError("target-check observation snapshot owner is invalid");
    const requestKey = stableStringify(requestIdentity);
    const retained = state?.build.requests.get(requestKey);
    if (retained?.status === "failed") throw retained.error;
    if (retained?.status === "complete") {
        return state?.build.observations.get(retained.exactKey) as StableBuildArtifactObservation;
    }
    if (retained?.status === "pending") throw new TypeError("target-check build observation is still pending");
    try {
        return retainObservation(requestKey, stableBuildArtifactObservation(readFresh()), state?.build);
    } catch (error) {
        state?.build.requests.set(requestKey, { status: "failed", error });
        throw error;
    }
}

/** @internal Coalesce concurrent reads of one exact build inside the same Host probe's build scope. */
export function observeStableBuildArtifactForTargetCheckAsync(
    requestIdentity: Readonly<Record<string, unknown>>,
    snapshot: TargetCheckObservationSnapshot | undefined,
    readFresh: () => Promise<StableRegularFileRead>,
): Promise<StableBuildArtifactObservation> {
    return observeComputedBuildArtifactForTargetCheckAsync(requestIdentity, snapshot, async () =>
        stableBuildArtifactObservation(await readFresh()),
    );
}

/** @internal Retain a pre-hashed operation-local build observation without moving its file bytes into Core. */
export function observeComputedBuildArtifactForTargetCheckAsync(
    requestIdentity: Readonly<Record<string, unknown>>,
    snapshot: TargetCheckObservationSnapshot | undefined,
    observeFresh: () => Promise<StableBuildArtifactObservation>,
): Promise<StableBuildArtifactObservation> {
    const state = snapshot === undefined ? undefined : SNAPSHOT_STATES.get(snapshot);
    if (snapshot !== undefined && state === undefined) {
        return Promise.reject(new TypeError("target-check observation snapshot owner is invalid"));
    }
    const requestKey = stableStringify(requestIdentity);
    const retained = state?.build.requests.get(requestKey);
    if (retained?.status === "failed") return Promise.reject(retained.error);
    if (retained?.status === "complete") {
        return Promise.resolve(state?.build.observations.get(retained.exactKey) as StableBuildArtifactObservation);
    }
    if (retained?.status === "pending") return retained.observation;

    const observation = Promise.resolve()
        .then(observeFresh)
        .then((sample) => retainObservation(requestKey, sample, state?.build))
        .catch((error: unknown) => {
            state?.build.requests.set(requestKey, { status: "failed", error });
            throw error;
        });
    state?.build.requests.set(requestKey, { status: "pending", observation });
    return observation;
}

/** @internal Coalesce one exact target-file sample inside the same user check. */
export function observeStableTargetFileForTargetCheckAsync(
    requestIdentity: Readonly<Record<string, unknown>>,
    snapshot: TargetCheckObservationSnapshot | undefined,
    readFresh: () => Promise<StableRegularFileRead>,
): Promise<StableRegularFileRead> {
    const state = snapshot === undefined ? undefined : SNAPSHOT_STATES.get(snapshot);
    if (snapshot !== undefined && state === undefined) {
        return Promise.reject(new TypeError("target-check observation snapshot owner is invalid"));
    }
    if (state === undefined) return readFresh();
    const requestKey = stableStringify(requestIdentity);
    const retained = state.targetFile.targetFileRequests.get(requestKey);
    if (retained?.status === "failed") return Promise.reject(retained.error);
    if (retained?.status === "complete") {
        return Promise.resolve(
            copyStableRegularFileRead(state.targetFile.targetFiles.get(retained.exactKey) as StableRegularFileRead),
        );
    }
    if (retained?.status === "pending") return retained.observation.then(copyStableRegularFileRead);

    const observation = Promise.resolve()
        .then(readFresh)
        .then((sample) => retainTargetFile(requestKey, sample, state.targetFile))
        .catch((error: unknown) => {
            state.targetFile.targetFileRequests.set(requestKey, { status: "failed", error });
            throw error;
        });
    state.targetFile.targetFileRequests.set(requestKey, { status: "pending", observation });
    return observation.then(copyStableRegularFileRead);
}

/** @internal Start one exact build wave for all target analyses sharing the same Host operation snapshot. */
export function primeTargetCheckBuildObservations(
    snapshot: TargetCheckObservationSnapshot,
    input: {
        readonly planIdentity: Readonly<Record<string, unknown>>;
        readonly filePaths: readonly string[];
        readonly observe: () => Promise<readonly (TargetCheckBuildObservationResult & { readonly filePath: string })[]>;
    },
): void {
    const state = SNAPSHOT_STATES.get(snapshot);
    if (state === undefined) throw new TypeError("target-check observation snapshot owner is invalid");
    const filePaths = [...input.filePaths].sort(compareUtf8);
    if (
        filePaths.length === 0 ||
        new Set(filePaths).size !== filePaths.length ||
        filePaths.some((filePath) => typeof filePath !== "string" || filePath.length === 0)
    ) {
        throw new TypeError("target-check build observation plan is invalid");
    }
    const key = stableStringify({ planIdentity: input.planIdentity, filePaths });
    if (state.build.prewarmedBuilds !== undefined) {
        if (state.build.prewarmedBuilds.key !== key) throw new TypeError("target-check build observation plan changed");
        return;
    }
    const filePathSet = new Set(filePaths);
    const terminal = Promise.resolve()
        .then(input.observe)
        .then((results) => {
            const byPath = new Map<string, TargetCheckBuildObservationResult>();
            for (const result of results) {
                if (!filePathSet.has(result.filePath) || byPath.has(result.filePath)) {
                    throw new TypeError("target-check build observation result identity changed");
                }
                byPath.set(result.filePath, result);
            }
            if (byPath.size !== filePaths.length) {
                throw new TypeError("target-check build observation result is incomplete");
            }
            return { status: "complete" as const, results: byPath as ReadonlyMap<string, TargetCheckBuildObservationResult> };
        })
        .catch((error: unknown) => ({ status: "failed" as const, error }));
    state.build.prewarmedBuilds = { key, filePaths: filePathSet, terminal };
}

/** @internal Return undefined only when this exact file was not part of the operation wave. */
export function prewarmedTargetCheckBuildObservation(
    snapshot: TargetCheckObservationSnapshot | undefined,
    filePath: string,
): Promise<StableBuildArtifactObservation> | undefined {
    if (snapshot === undefined) return undefined;
    const state = SNAPSHOT_STATES.get(snapshot);
    if (state === undefined) throw new TypeError("target-check observation snapshot owner is invalid");
    const prewarmed = state.build.prewarmedBuilds;
    if (prewarmed === undefined || !prewarmed.filePaths.has(filePath)) return undefined;
    return prewarmed.terminal.then((terminal) => {
        if (terminal.status === "failed") throw terminal.error;
        const result = terminal.results.get(filePath);
        if (result === undefined) throw new TypeError("target-check build observation result is incomplete");
        if (result.status === "failed") throw result.error;
        return result.observation;
    });
}

function stableBuildArtifactObservation(sample: StableRegularFileRead): StableBuildArtifactObservation {
    return Object.freeze({
        executable: sample.executable,
        identity: Object.freeze({ ...sample.identity }),
        byteSize: sample.bytes.byteLength,
        buildIdentity: sha256Bytes(sample.bytes),
    });
}

function retainObservation(
    requestKey: string,
    observation: StableBuildArtifactObservation,
    state: TargetCheckBuildObservationState | undefined,
): StableBuildArtifactObservation {
    if (state !== undefined) {
        const exactKey = stableStringify({ requestKey, ...observation });
        state.observations.set(exactKey, observation);
        state.requests.set(requestKey, { status: "complete", exactKey });
    }
    return observation;
}

function retainTargetFile(
    requestKey: string,
    sample: StableRegularFileRead,
    state: TargetCheckFileObservationState,
): StableRegularFileRead {
    const retained = copyStableRegularFileRead(sample);
    const exactKey = stableStringify({
        requestKey,
        executable: retained.executable,
        identity: retained.identity,
        byteSize: retained.bytes.byteLength,
        contentHash: sha256Bytes(retained.bytes),
    });
    state.targetFiles.set(exactKey, retained);
    state.targetFileRequests.set(requestKey, { status: "complete", exactKey });
    return retained;
}

function copyStableRegularFileRead(sample: StableRegularFileRead): StableRegularFileRead {
    return {
        bytes: new Uint8Array(sample.bytes),
        executable: sample.executable,
        identity: { ...sample.identity },
    };
}

function compareUtf8(left: string, right: string): number {
    return Buffer.from(left).compare(Buffer.from(right));
}
