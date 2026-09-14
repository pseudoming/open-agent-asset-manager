import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { inspectFilesystemFailure } from "../filesystem/filesystem-facts";
import type { PhysicalPathIdentity, SafeFilesystemFailureKind, StableRegularFileRead } from "../filesystem/filesystem-types";

export type PathEnvironmentPlatform = "win32" | "darwin" | "linux" | "wsl";

export interface PlatformContextRegularFileReadInput {
    readonly platform: PathEnvironmentPlatform;
    readonly platformInstanceId: string;
    readonly accessRootPath: string;
    readonly filePath: string;
    readonly maximumBytes?: number;
}

/** Stable facts from one physical reader; identity belongs to that reader's native domain. */
export interface PlatformContextRegularFileSnapshot {
    readonly identity: PhysicalPathIdentity;
    readonly executable: boolean;
    readonly byteSize: number;
    readonly sha256Hex: string;
}

/** @internal The payload is consumed inside Shared, never projected as a build fact. */
export function snapshotStableRegularFileRead(read: StableRegularFileRead): PlatformContextRegularFileSnapshot {
    return Object.freeze({
        identity: Object.freeze({ ...read.identity }),
        executable: read.executable,
        byteSize: read.bytes.byteLength,
        sha256Hex: createHash("sha256").update(read.bytes).digest("hex"),
    });
}

/** @internal Same caller bounds as the existing asynchronous stable-file reader. */
export function validatePlatformContextRegularFileSnapshotInput(
    input: PlatformContextRegularFileReadInput,
    timeoutMilliseconds: number,
): void {
    validatePlatformContextRegularFileReadInput(input);
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0 || timeoutMilliseconds > 30_000) {
        throw new RangeError("timeoutMilliseconds must be no greater than 30000");
    }
}

export type WslHomePathResolution =
    | { readonly status: "available"; readonly homePath: string }
    | {
          readonly status: "unavailable";
          readonly reason: "invalid_distro_name" | "not_installed" | "command_failed" | "invalid_home" | "wrong_host";
      };

interface PathEnvironmentObservation {
    active: boolean;
    readonly wslHomes: Map<string, WslHomePathResolution>;
}

const pathEnvironmentObservations = new AsyncLocalStorage<PathEnvironmentObservation>();

/**
 * One caller-owned observation interval. Only repeated exact WSL HOME queries are
 * shared; filesystem, installation, build and target observations stay independent.
 * No result survives settlement or becomes authority for a later operation.
 */
export async function withPathEnvironmentObservation<T>(operation: () => Promise<T>): Promise<T> {
    const observation: PathEnvironmentObservation = { active: true, wslHomes: new Map() };
    return pathEnvironmentObservations.run(observation, async () => {
        try {
            return await operation();
        } finally {
            observation.active = false;
            observation.wslHomes.clear();
        }
    });
}

/** @internal Target resolver only; never exported by a public package entry. */
export function observeWslHomePathOnce(distroName: string, resolve: () => WslHomePathResolution): WslHomePathResolution {
    const observation = pathEnvironmentObservations.getStore();
    if (observation?.active !== true) return resolve();
    let result = observation.wslHomes.get(distroName);
    if (result === undefined) {
        result = Object.freeze({ ...resolve() });
        observation.wslHomes.set(distroName, result);
    }
    // A Provider receives its own value, not a mutable reference to another consumer's fact.
    return { ...result };
}

export type LocalProcessExecutableIdentity = PhysicalPathIdentity & {
    readonly entryKind: "file";
};

export interface LocalProcessObservation {
    readonly processId: number;
    readonly lifecycleToken: string;
    readonly executableIdentity: LocalProcessExecutableIdentity;
    readonly commandLineBytes: Uint8Array;
}

/** @internal One operation-local build observation wave; no file bytes leave this owner. */
export interface PlatformContextBuildObservationInput {
    readonly platform: PathEnvironmentPlatform;
    readonly platformInstanceId: string;
    readonly accessRootPath: string;
    readonly filePaths: readonly string[];
    readonly maximumConcurrency: number;
    readonly timeoutMilliseconds: number;
}

export type PlatformContextBuildObservationItem =
    | {
          readonly status: "complete";
          readonly filePath: string;
          readonly identity: PhysicalPathIdentity;
          readonly executable: boolean;
          readonly byteSize: number;
          readonly sha256Hex: string;
      }
    | {
          readonly status: "failed";
          readonly filePath: string;
          readonly failureKind: SafeFilesystemFailureKind;
          readonly systemCode: string;
      };

export interface PlatformContextBuildObservationResult {
    readonly items: readonly PlatformContextBuildObservationItem[];
    readonly elapsedMilliseconds: number;
    readonly maximumConcurrencyObserved: number;
}

const MAXIMUM_BUILD_OBSERVATION_ITEMS = 64;
const MAXIMUM_BUILD_OBSERVATION_CONCURRENCY = 8;
const MAXIMUM_BUILD_OBSERVATION_MILLISECONDS = 10_000;

/** @internal Validate one narrowly bounded operation-local build wave. */
export function validatePlatformContextBuildObservationInput(input: PlatformContextBuildObservationInput): void {
    if (
        !Array.isArray(input.filePaths) ||
        input.filePaths.length === 0 ||
        input.filePaths.length > MAXIMUM_BUILD_OBSERVATION_ITEMS ||
        new Set(input.filePaths).size !== input.filePaths.length ||
        !Number.isSafeInteger(input.maximumConcurrency) ||
        input.maximumConcurrency <= 0 ||
        input.maximumConcurrency > MAXIMUM_BUILD_OBSERVATION_CONCURRENCY ||
        !Number.isSafeInteger(input.timeoutMilliseconds) ||
        input.timeoutMilliseconds <= 0 ||
        input.timeoutMilliseconds > MAXIMUM_BUILD_OBSERVATION_MILLISECONDS
    ) {
        throw new TypeError("platform-context build observation exceeds its reviewed bounds");
    }
    for (const filePath of input.filePaths) {
        validatePlatformContextRegularFileReadInput({
            platform: input.platform,
            platformInstanceId: input.platformInstanceId,
            accessRootPath: input.accessRootPath,
            filePath,
        });
    }
}

/** @internal Hash build evidence with bounded local concurrency and deterministic result order. */
export async function observeLocalPlatformContextBuildArtifactsBounded(
    input: PlatformContextBuildObservationInput,
    readRegularFile: (input: PlatformContextRegularFileReadInput, timeoutMilliseconds: number) => Promise<StableRegularFileRead>,
): Promise<PlatformContextBuildObservationResult> {
    validatePlatformContextBuildObservationInput(input);
    const started = performance.now();
    const items = new Array<PlatformContextBuildObservationItem | undefined>(input.filePaths.length);
    let nextIndex = 0;
    let active = 0;
    let maximumConcurrencyObserved = 0;
    const worker = async (): Promise<void> => {
        while (nextIndex < input.filePaths.length) {
            const index = nextIndex;
            nextIndex += 1;
            const filePath = input.filePaths[index] as string;
            active += 1;
            maximumConcurrencyObserved = Math.max(maximumConcurrencyObserved, active);
            let sample: StableRegularFileRead | undefined;
            try {
                sample = await readRegularFile(
                    {
                        platform: input.platform,
                        platformInstanceId: input.platformInstanceId,
                        accessRootPath: input.accessRootPath,
                        filePath,
                    },
                    input.timeoutMilliseconds,
                );
                items[index] = Object.freeze({
                    status: "complete" as const,
                    filePath,
                    identity: sample.identity,
                    executable: sample.executable,
                    byteSize: sample.bytes.byteLength,
                    sha256Hex: createHash("sha256").update(sample.bytes).digest("hex"),
                });
            } catch (error) {
                const failure = inspectFilesystemFailure(error);
                items[index] = Object.freeze({
                    status: "failed" as const,
                    filePath,
                    failureKind: failure.failureKind,
                    systemCode: failure.systemCode,
                });
            } finally {
                sample?.bytes.fill(0);
                active -= 1;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(input.maximumConcurrency, input.filePaths.length) }, async () => worker()));
    if (items.some((item) => item === undefined)) {
        throw new TypeError("platform-context build observation result is incomplete");
    }
    return Object.freeze({
        items: Object.freeze(items as PlatformContextBuildObservationItem[]),
        elapsedMilliseconds: Math.ceil(performance.now() - started),
        maximumConcurrencyObserved,
    });
}

export interface OwnedInvocationProcessIdentity {
    readonly processId: number;
    readonly lifecycleToken: string;
}

export interface LocalExecutableTreeInvocationResult {
    readonly status: "complete" | "failed" | "timed_out" | "cleanup_failed";
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
    readonly rootProcess: OwnedInvocationProcessIdentity | null;
    readonly observedProcesses: readonly OwnedInvocationProcessIdentity[];
    readonly cleanupComplete: boolean;
    readonly invocationTokenAbsent: boolean;
    readonly failureCode: string;
}

export interface LocalExecutableEnvironmentEntry {
    readonly name: string;
    readonly value: string;
}

export const MAXIMUM_LOCAL_PROCESS_COMMAND_LINE_BYTES = 1_048_576;
export const MAXIMUM_LOCAL_PROCESS_TABLE_ENTRIES = 65_536;
export const MAXIMUM_LOCAL_EXECUTABLE_ARGUMENTS = 128;
export const MAXIMUM_LOCAL_EXECUTABLE_ARGUMENT_BYTES = 65_536;
export const MAXIMUM_LOCAL_EXECUTABLE_ENVIRONMENT_ENTRIES = 32;
export const MAXIMUM_LOCAL_EXECUTABLE_ENVIRONMENT_BYTES = 256 * 1_024;
export const MAXIMUM_LOCAL_EXECUTABLE_INVOCATION_MILLISECONDS = 10_000;
export const MAXIMUM_LOCAL_EXECUTABLE_OUTPUT_BYTES = 4 * 1_024 * 1_024;
export const MAXIMUM_SELECTED_WSL_OPERATION_MILLISECONDS = 10_000;

export function validatePlatformContextRegularFileReadInput(input: PlatformContextRegularFileReadInput): void {
    if (
        input === null ||
        typeof input !== "object" ||
        !["win32", "darwin", "linux", "wsl"].includes(input.platform) ||
        input.platformInstanceId.trim() === "" ||
        input.platformInstanceId.includes("\0") ||
        input.accessRootPath.length === 0 ||
        input.accessRootPath.includes("\0") ||
        input.filePath.length === 0 ||
        input.filePath.includes("\0") ||
        (input.maximumBytes !== undefined && (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 0))
    ) {
        throw new TypeError("platform-context regular-file input must contain canonical non-empty identities and paths");
    }
}

export function validateLocalProcessTableEntryLimit(maximumEntries: number): void {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0 || maximumEntries > MAXIMUM_LOCAL_PROCESS_TABLE_ENTRIES) {
        throw new RangeError(
            `maximumEntries must be a positive safe integer no greater than ${MAXIMUM_LOCAL_PROCESS_TABLE_ENTRIES}`,
        );
    }
}

export function validateLocalProcessObservationInput(
    processId: number,
    expectedExecutableIdentity: LocalProcessExecutableIdentity,
    maximumCommandLineBytes: number,
): void {
    if (!Number.isSafeInteger(processId) || processId <= 0) {
        throw new RangeError("processId must be a positive safe integer");
    }
    if (
        expectedExecutableIdentity === null ||
        typeof expectedExecutableIdentity !== "object" ||
        expectedExecutableIdentity.entryKind !== "file" ||
        typeof expectedExecutableIdentity.deviceId !== "string" ||
        expectedExecutableIdentity.deviceId.length === 0 ||
        typeof expectedExecutableIdentity.fileId !== "string" ||
        expectedExecutableIdentity.fileId.length === 0
    ) {
        throw new TypeError("expectedExecutableIdentity must identify one regular file");
    }
    if (
        !Number.isSafeInteger(maximumCommandLineBytes) ||
        maximumCommandLineBytes <= 0 ||
        maximumCommandLineBytes > MAXIMUM_LOCAL_PROCESS_COMMAND_LINE_BYTES
    ) {
        throw new RangeError(
            `maximumCommandLineBytes must be a positive safe integer no greater than ${MAXIMUM_LOCAL_PROCESS_COMMAND_LINE_BYTES}`,
        );
    }
}

export function validateLocalProcessExecutableObservationInput(expectedExecutablePath: string): void {
    if (
        typeof expectedExecutablePath !== "string" ||
        expectedExecutablePath.length === 0 ||
        expectedExecutablePath.includes("\0")
    ) {
        throw new TypeError("expectedExecutablePath must be one non-empty NUL-free path");
    }
}

export function validateLocalExecutableTreeInvocationInput(
    executablePath: string,
    expectedExecutableIdentity: LocalProcessExecutableIdentity,
    arguments_: readonly string[],
    workingDirectory: string,
    environmentEntries: readonly LocalExecutableEnvironmentEntry[],
    invocationToken: string,
    timeoutMilliseconds: number,
    maximumOutputBytes: number,
): void {
    validateLocalProcessExecutableObservationInput(executablePath);
    validateLocalProcessObservationInput(1, expectedExecutableIdentity, 1);
    validateLocalProcessExecutableObservationInput(workingDirectory);
    if (!Array.isArray(arguments_) || arguments_.length > MAXIMUM_LOCAL_EXECUTABLE_ARGUMENTS) {
        throw new RangeError(`arguments must contain no more than ${MAXIMUM_LOCAL_EXECUTABLE_ARGUMENTS} entries`);
    }
    let argumentBytes = 0;
    for (const argument of arguments_) {
        if (typeof argument !== "string" || argument.includes("\0")) {
            throw new TypeError("arguments must contain only NUL-free strings");
        }
        argumentBytes += Buffer.byteLength(argument, "utf8");
        if (!Number.isSafeInteger(argumentBytes) || argumentBytes > MAXIMUM_LOCAL_EXECUTABLE_ARGUMENT_BYTES) {
            throw new RangeError(`arguments must contain no more than ${MAXIMUM_LOCAL_EXECUTABLE_ARGUMENT_BYTES} UTF-8 bytes`);
        }
    }
    if (!Array.isArray(environmentEntries) || environmentEntries.length > MAXIMUM_LOCAL_EXECUTABLE_ENVIRONMENT_ENTRIES) {
        throw new RangeError(
            `environmentEntries must contain no more than ${MAXIMUM_LOCAL_EXECUTABLE_ENVIRONMENT_ENTRIES} entries`,
        );
    }
    const names = new Set<string>();
    let environmentBytes = 0;
    for (const entry of environmentEntries) {
        if (
            entry === null ||
            typeof entry !== "object" ||
            typeof entry.name !== "string" ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.name) ||
            typeof entry.value !== "string" ||
            entry.value.includes("\0")
        ) {
            throw new TypeError("environmentEntries must contain unique bounded POSIX-style names and NUL-free values");
        }
        const environmentNameIdentity = entry.name.toUpperCase();
        if (names.has(environmentNameIdentity) || environmentNameIdentity === "OAAM_INVOCATION_TOKEN") {
            throw new TypeError("environmentEntries must contain unique bounded POSIX-style names and NUL-free values");
        }
        names.add(environmentNameIdentity);
        environmentBytes += Buffer.byteLength(entry.name, "utf8") + Buffer.byteLength(entry.value, "utf8") + 2;
        if (!Number.isSafeInteger(environmentBytes) || environmentBytes > MAXIMUM_LOCAL_EXECUTABLE_ENVIRONMENT_BYTES) {
            throw new RangeError(
                `environmentEntries must contain no more than ${MAXIMUM_LOCAL_EXECUTABLE_ENVIRONMENT_BYTES} UTF-8 bytes`,
            );
        }
    }
    if (!/^[a-f0-9]{64}$/u.test(invocationToken)) {
        throw new TypeError("invocationToken must be one lowercase 256-bit hexadecimal value");
    }
    if (
        !Number.isSafeInteger(timeoutMilliseconds) ||
        timeoutMilliseconds <= 0 ||
        timeoutMilliseconds > MAXIMUM_LOCAL_EXECUTABLE_INVOCATION_MILLISECONDS
    ) {
        throw new RangeError(`timeoutMilliseconds must be no greater than ${MAXIMUM_LOCAL_EXECUTABLE_INVOCATION_MILLISECONDS}`);
    }
    if (
        !Number.isSafeInteger(maximumOutputBytes) ||
        maximumOutputBytes <= 0 ||
        maximumOutputBytes > MAXIMUM_LOCAL_EXECUTABLE_OUTPUT_BYTES
    ) {
        throw new RangeError(`maximumOutputBytes must be no greater than ${MAXIMUM_LOCAL_EXECUTABLE_OUTPUT_BYTES}`);
    }
}

export function validateSelectedWslProcessLifecycleInput(processId: number, timeoutMilliseconds: number): void {
    if (!Number.isSafeInteger(processId) || processId <= 0) {
        throw new RangeError("processId must be a positive safe integer");
    }
    validateSelectedWslOperationTimeout(timeoutMilliseconds);
}

export function validateSelectedWslProcessLifecyclePairInput(
    processIds: readonly [number, number],
    timeoutMilliseconds: number,
): void {
    if (!Array.isArray(processIds) || processIds.length !== 2 || processIds[0] === processIds[1]) {
        throw new RangeError("processIds must contain two distinct exact PIDs");
    }
    for (const processId of processIds) validateSelectedWslProcessLifecycleInput(processId, timeoutMilliseconds);
}

function validateSelectedWslOperationTimeout(timeoutMilliseconds: number): void {
    if (
        !Number.isSafeInteger(timeoutMilliseconds) ||
        timeoutMilliseconds <= 0 ||
        timeoutMilliseconds > MAXIMUM_SELECTED_WSL_OPERATION_MILLISECONDS
    ) {
        throw new RangeError(
            `timeoutMilliseconds must be a positive safe integer no greater than ${MAXIMUM_SELECTED_WSL_OPERATION_MILLISECONDS}`,
        );
    }
}

/**
 * Build-selected path and reachable-environment mechanics.
 *
 * Both target implementations must provide the same public shape. Functions
 * that only make sense inside one target implementation remain private to
 * that implementation instead of weakening this contract with optional
 * members.
 */
export interface PathEnvironment {
    readonly getHomeDir: () => string;
    readonly getPhysicalHomeDirectory: (targetRootPath: string) => string;
    readonly resolveHome: (path: string) => string;
    readonly isWsl: () => boolean;
    readonly detectReachablePathPlatforms: () => PathEnvironmentPlatform[];
    readonly getWslDistroNames: () => string[];
    readonly getRunningWslDistroNames: () => string[];
    readonly getWslAccessRootPath: (distroName: string) => string;
    readonly resolveWslHomePath: (distroName: string) => WslHomePathResolution;
    readonly withPathEnvironmentObservation: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly readPlatformContextRegularFileNoFollow: (input: PlatformContextRegularFileReadInput) => StableRegularFileRead;
    readonly listLocalProcessIdsBounded: (maximumEntries: number) => number[];
    readonly listLocalProcessExecutableCandidateIdsBounded: (expectedExecutablePath: string, maximumEntries: number) => number[];
    readonly observeLocalProcessBounded: (
        processId: number,
        expectedExecutableIdentity: LocalProcessExecutableIdentity,
        maximumCommandLineBytes: number,
    ) => LocalProcessObservation | null;
    readonly observeLocalProcessExecutableBounded: (
        processId: number,
        expectedExecutablePath: string,
        expectedExecutableIdentity: LocalProcessExecutableIdentity,
        maximumCommandLineBytes: number,
    ) => LocalProcessObservation | null;
    readonly invokeLocalExecutableTreeBounded: (
        executablePath: string,
        expectedExecutableIdentity: LocalProcessExecutableIdentity,
        arguments_: readonly string[],
        workingDirectory: string,
        environmentEntries: readonly LocalExecutableEnvironmentEntry[],
        invocationToken: string,
        timeoutMilliseconds: number,
        maximumOutputBytes: number,
    ) => Promise<LocalExecutableTreeInvocationResult>;
    /** Exact PID presence, including zombies and same-lifecycle executable changes. */
    readonly observeSelectedWslProcessLifecycleBounded: (
        distroName: string,
        processId: number,
        timeoutMilliseconds: number,
    ) => OwnedInvocationProcessIdentity | null;
    /** Two present PIDs, each stable across adjacent reads within one bounded invocation. */
    readonly observeSelectedWslProcessLifecyclePairBounded: (
        distroName: string,
        processIds: readonly [number, number],
        timeoutMilliseconds: number,
    ) => readonly [OwnedInvocationProcessIdentity, OwnedInvocationProcessIdentity];
}
