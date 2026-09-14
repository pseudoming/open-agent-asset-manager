import { createHash, randomBytes } from "node:crypto";
import type { PlatformContext, Sha256Digest } from "@oaam/core";
import { inspectFilesystemFailure, SafeFilesystemError, type SafeFilesystemFailureKind } from "@oaam/shared/filesystem";
import {
    invokeLocalExecutableTreeBounded,
    type LocalExecutableTreeInvocationResult,
    listLocalProcessExecutableCandidateIdsBounded,
    listLocalProcessIdsBounded,
    observeLocalProcessBounded,
    observeLocalProcessExecutableBounded,
} from "@oaam/shared/paths";
import { canonicalProviderHostPathWithinAccessRoot, isWindowsHostedWslContext } from "./probe-paths";
import type { ProviderRegularFileIdentity, ProviderRegularFileSnapshot } from "./provider-probe-filesystem";
import { sameProviderRegularFileIdentity, snapshotProviderRegularFileNoFollow } from "./provider-probe-filesystem";

const RETRYABLE_PROCESS_SYSTEM_CODES = new Set(["EAGAIN", "EBUSY", "ETXTBSY"]);
const MAXIMUM_PROVIDER_EXECUTABLE_BYTES = 512 * 1_024 * 1_024;

export interface ProviderLocalProcessObservation {
    readonly processId: number;
    readonly lifecycleToken: string;
    readonly executableIdentity: ProviderRegularFileIdentity;
    readonly commandLineBytes: Uint8Array;
}

export type ProviderProcessObservationFailureDisposition = "retryable_transition" | "deterministic_failure";

export interface ProviderProcessObservationFailure {
    readonly disposition: ProviderProcessObservationFailureDisposition;
    readonly failureKind: SafeFilesystemFailureKind;
    readonly systemCode: string;
}

export interface ProviderProbeDeadline {
    readonly startedAtMilliseconds: number;
    readonly expiresAtMilliseconds: number;
}

export type ProviderExecutableObservationStage =
    | "profile"
    | "binding_before"
    | "host_invocation"
    | "runtime_observation"
    | "binding_after"
    | "output_parse";

export type ProviderExecutableObservationFailure =
    | "runtime_root_not_observed"
    | "host_invocation_failed"
    | "timed_out"
    | "nonzero_exit"
    | "output_limit_exceeded"
    | "cleanup_incomplete"
    | "identity_changed"
    | "malformed_output"
    | "other";

export type ProviderExecutableObservationOwnerCode =
    | "binding_inspection_failed"
    | "cleanup_incomplete"
    | "host_invocation_exception"
    | "host_invocation_failed"
    | "host_output_limit"
    | "host_timeout"
    | "identity_changed"
    | "malformed_output"
    | "observer_exited_before_ready"
    | "observer_exited_while_target_running"
    | "observer_failed"
    | "observer_output_limit"
    | "observer_ready_malformed"
    | "observer_ready_not_observed"
    | "observer_ready_timeout"
    | "observer_signal_failed"
    | "observer_stderr"
    | "observer_handshake_failed"
    | "observer_process_tree_remains"
    | "process_tree_remains"
    | "process_exit_nonzero"
    | "process_timeout"
    | "profile_invalid"
    | "runtime_cleanup_required"
    | "runtime_root_not_observed"
    | "runtime_observation_failed"
    | "runtime_observation_identity_changed"
    | "runtime_observation_output_limit"
    | "runtime_observation_process_exited"
    | "runtime_observation_protocol_failed"
    | "runtime_observation_resource_limit"
    | "runtime_observation_timed_out"
    | "runtime_observation_wsl_process_transition_selected_wsl_invocation_exceeded_its_deadline"
    | "selected_wsl_invocation_failed"
    | "target_exited_before_observer_ready"
    | "unclassified"
    | "worker_protocol";

interface ProviderExecutableObservationFailureReceiptBase {
    readonly stage: ProviderExecutableObservationStage;
    readonly failure: ProviderExecutableObservationFailure;
    readonly ownerCode: ProviderExecutableObservationOwnerCode;
    readonly exitKind: "zero" | "nonzero" | "signal" | "unavailable";
    readonly identity: "stable" | "changed" | "unverified";
    readonly timeout: "within_bound" | "expired" | "unverified";
    readonly cleanup: "complete" | "incomplete" | "unverified";
}

export interface ProviderExecutableObservationFailureReceiptV2 extends ProviderExecutableObservationFailureReceiptBase {
    readonly schemaVersion: 2;
}

export interface ProviderExecutableObservationFailureReceiptV3 extends ProviderExecutableObservationFailureReceiptBase {
    readonly schemaVersion: 3;
    readonly elapsedMilliseconds: number;
    readonly stdoutByteCount: number | null;
    readonly stdoutSha256: Sha256Digest | null;
    readonly stderrByteCount: number | null;
    readonly stderrSha256: Sha256Digest | null;
}

export type ProviderExecutableObservationFailureReceipt =
    | ProviderExecutableObservationFailureReceiptV2
    | ProviderExecutableObservationFailureReceiptV3;

export interface ProviderExecutableObservationEvidence {
    readonly elapsedMilliseconds: number;
    readonly stdout?: Uint8Array | null;
    readonly stderr?: Uint8Array | null;
}

export interface ProviderExecutableObservationInvocation {
    readonly status: "complete" | "failed" | "timed_out" | "cleanup_failed";
    readonly exitCode: number | null;
    readonly signal?: string | null;
    readonly cleanupComplete: boolean;
    readonly invocationTokenAbsent: boolean;
    readonly failureCode: string;
}

const BOUNDED_EXECUTABLE_OBSERVATION_OWNER_CODES = new Set<ProviderExecutableObservationOwnerCode>([
    "host_invocation_failed",
    "observer_exited_before_ready",
    "observer_exited_while_target_running",
    "observer_failed",
    "observer_output_limit",
    "observer_ready_malformed",
    "observer_ready_not_observed",
    "observer_ready_timeout",
    "observer_signal_failed",
    "observer_stderr",
    "observer_handshake_failed",
    "observer_process_tree_remains",
    "process_tree_remains",
    "runtime_cleanup_required",
    "runtime_root_not_observed",
    "runtime_observation_failed",
    "runtime_observation_identity_changed",
    "runtime_observation_output_limit",
    "runtime_observation_process_exited",
    "runtime_observation_protocol_failed",
    "runtime_observation_resource_limit",
    "runtime_observation_timed_out",
    "runtime_observation_wsl_process_transition_selected_wsl_invocation_exceeded_its_deadline",
    "selected_wsl_invocation_failed",
    "target_exited_before_observer_ready",
    "worker_protocol",
]);

export interface ProviderLocalExecutableTreeInvocationInput {
    readonly executablePath: string;
    readonly expectedExecutableIdentity: ProviderRegularFileIdentity;
    readonly expectedExecutableSha256?: Sha256Digest;
    readonly arguments: readonly string[];
    readonly workingDirectory: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly environmentVariableNames: readonly string[];
    readonly platformContext: PlatformContext;
    readonly hostPlatform?: NodeJS.Platform;
    readonly timeoutMilliseconds: number;
    readonly maximumOutputBytes: number;
}

export type ProviderLocalExecutableTreeInvocationResult = LocalExecutableTreeInvocationResult & {
    readonly executableSha256: Sha256Digest;
};

interface ProviderLocalExecutableTreeInvocationDependencies {
    readonly snapshotExecutable: typeof snapshotProviderRegularFileNoFollow;
    readonly sameIdentity: typeof sameProviderRegularFileIdentity;
    readonly invoke: typeof invokeLocalExecutableTreeBounded;
    readonly randomBytes: typeof randomBytes;
}

const DEFAULT_INVOCATION_DEPENDENCIES: ProviderLocalExecutableTreeInvocationDependencies = {
    snapshotExecutable: snapshotProviderRegularFileNoFollow,
    sameIdentity: sameProviderRegularFileIdentity,
    invoke: invokeLocalExecutableTreeBounded,
    randomBytes,
};

export function listProviderLocalProcessIdsBounded(maximumEntries: number): number[] {
    return listLocalProcessIdsBounded(maximumEntries);
}

/**
 * Project a build-selected candidate prefilter without treating an image name
 * as executable authority. Providers must still call the exact observer for
 * every returned PID before invocation.
 */
export function listProviderLocalProcessExecutableCandidateIdsBounded(
    expectedExecutablePath: string,
    maximumEntries: number,
): number[] {
    return listLocalProcessExecutableCandidateIdsBounded(expectedExecutablePath, maximumEntries);
}

export function observeProviderLocalProcessBounded(
    processId: number,
    expectedExecutableIdentity: ProviderRegularFileIdentity,
    maximumCommandLineBytes: number,
): ProviderLocalProcessObservation | null {
    return observeLocalProcessBounded(processId, expectedExecutableIdentity, maximumCommandLineBytes);
}

export function observeProviderLocalProcessExecutableBounded(
    processId: number,
    expectedExecutablePath: string,
    expectedExecutableIdentity: ProviderRegularFileIdentity,
    maximumCommandLineBytes: number,
): ProviderLocalProcessObservation | null {
    return observeLocalProcessExecutableBounded(
        processId,
        expectedExecutablePath,
        expectedExecutableIdentity,
        maximumCommandLineBytes,
    );
}

/**
 * Invoke one exact local executable through the Shared owned-process-tree
 * authority. Framework, rather than a concrete Provider, creates the
 * invocation token, projects the minimum environment and rejects executable
 * replacement before any output can become Provider evidence.
 */
export async function invokeProviderLocalExecutableTreeBounded(
    input: ProviderLocalExecutableTreeInvocationInput,
): Promise<ProviderLocalExecutableTreeInvocationResult> {
    return invokeProviderLocalExecutableTreeBoundedForTest(input);
}

/** @internal Exact dependency seam for Framework fault tests; never exported from the package barrel. */
export async function invokeProviderLocalExecutableTreeBoundedForTest(
    input: ProviderLocalExecutableTreeInvocationInput,
    overrides: Partial<ProviderLocalExecutableTreeInvocationDependencies> = {},
): Promise<ProviderLocalExecutableTreeInvocationResult> {
    const dependencies = { ...DEFAULT_INVOCATION_DEPENDENCIES, ...overrides };
    requireLocalInvocationBinding(input);
    const before = snapshotExecutable(input.executablePath, dependencies);
    if (!dependencies.sameIdentity(before.identity, input.expectedExecutableIdentity)) {
        throw executableChanged(input.executablePath, "before invocation");
    }
    if (input.expectedExecutableSha256 !== undefined && before.sha256 !== input.expectedExecutableSha256) {
        throw new SafeFilesystemError({
            failureKind: "stale",
            operation: "invoke_local_executable",
            targetPath: input.executablePath,
            systemCode: "EXECUTABLE_BUILD_MISMATCH",
            message: "selected executable bytes do not match the required build before invocation",
        });
    }
    const invocation = await dependencies.invoke(
        input.executablePath,
        before.identity,
        input.arguments,
        input.workingDirectory,
        projectEnvironment(input.environment, input.environmentVariableNames),
        dependencies.randomBytes(32).toString("hex"),
        input.timeoutMilliseconds,
        input.maximumOutputBytes,
    );
    const after = snapshotExecutable(input.executablePath, dependencies);
    if (!dependencies.sameIdentity(before.identity, after.identity) || before.sha256 !== after.sha256) {
        return failedInvocation(invocation, before.sha256, "executable_changed");
    }
    if (invocation.status !== "complete") {
        return failedInvocation(invocation, before.sha256, invocation.failureCode);
    }
    return { ...invocation, executableSha256: before.sha256 };
}

/**
 * Classify one process-table observation failure without exposing platform errno
 * handling to a Provider. Only lifecycle disappearance/staleness and the
 * allowlisted busy transition codes are retryable.
 */
export function classifyProviderProcessObservationFailure(error: unknown): ProviderProcessObservationFailure {
    const inspection = inspectFilesystemFailure(error);
    const retryable =
        inspection.failureKind === "not_found" ||
        inspection.failureKind === "stale" ||
        RETRYABLE_PROCESS_SYSTEM_CODES.has(inspection.systemCode);
    return {
        disposition: retryable ? "retryable_transition" : "deterministic_failure",
        failureKind: inspection.failureKind,
        systemCode: inspection.systemCode,
    };
}

export function providerExecutableObservationFailureFromInvocation(
    invocation: ProviderExecutableObservationInvocation,
    evidence?: ProviderExecutableObservationEvidence,
): ProviderExecutableObservationFailureReceipt {
    const code = invocation.failureCode.toLowerCase();
    const ownerCode = boundedExecutableObservationOwnerCode(invocation, code);
    const failure: ProviderExecutableObservationFailure =
        code === "runtime_root_not_observed"
            ? "runtime_root_not_observed"
            : code === "host_invocation_failed"
              ? "host_invocation_failed"
              : invocation.status === "timed_out" || code === "timeout" || code.endsWith("_timeout") || code === "etimedout"
                ? "timed_out"
                : code === "output_limit" || code.includes("output_limit")
                  ? "output_limit_exceeded"
                  : code === "executable_changed" || code === "runtime_executable_changed" || code === "wsl_executable_changed"
                    ? "identity_changed"
                    : !invocation.cleanupComplete || !invocation.invocationTokenAbsent || code === "runtime_cleanup_required"
                      ? "cleanup_incomplete"
                      : invocation.exitCode !== null && invocation.exitCode !== 0
                        ? "nonzero_exit"
                        : "other";
    return providerExecutableObservationFailureReceipt(
        failure === "host_invocation_failed" ? "host_invocation" : "runtime_observation",
        failure,
        ownerCode,
        {
            exitKind:
                invocation.signal !== undefined && invocation.signal !== null
                    ? "signal"
                    : invocation.exitCode === null
                      ? "unavailable"
                      : invocation.exitCode === 0
                        ? "zero"
                        : "nonzero",
            identity: failure === "identity_changed" ? "changed" : "stable",
            timeout: failure === "timed_out" ? "expired" : "within_bound",
            cleanup: invocation.cleanupComplete && invocation.invocationTokenAbsent ? "complete" : "incomplete",
        },
        evidence,
    );
}

export function providerExecutableObservationFailureFromError(
    stage: ProviderExecutableObservationStage,
    error: unknown,
    evidence?: ProviderExecutableObservationEvidence,
): ProviderExecutableObservationFailureReceipt {
    const inspection = inspectFilesystemFailure(error);
    const systemCode = inspection.systemCode.toUpperCase();
    const failure: ProviderExecutableObservationFailure =
        systemCode.includes("IDENTITY_CHANGED") || systemCode.includes("EXECUTABLE_CHANGED")
            ? "identity_changed"
            : systemCode === "ETIMEDOUT" || systemCode.includes("TIMEOUT")
              ? "timed_out"
              : systemCode === "ENOBUFS" || systemCode.includes("OUTPUT_LIMIT") || systemCode.includes("MAXBUFFER")
                ? "output_limit_exceeded"
                : stage === "host_invocation"
                  ? "host_invocation_failed"
                  : "other";
    const ownerCode: ProviderExecutableObservationOwnerCode =
        failure === "identity_changed"
            ? "identity_changed"
            : failure === "timed_out"
              ? "host_timeout"
              : failure === "output_limit_exceeded"
                ? "host_output_limit"
                : stage === "profile"
                  ? "profile_invalid"
                  : stage === "binding_before" || stage === "binding_after"
                    ? "binding_inspection_failed"
                    : stage === "host_invocation"
                      ? "host_invocation_exception"
                      : "unclassified";
    return providerExecutableObservationFailureReceipt(
        stage,
        failure,
        ownerCode,
        {
            exitKind: "unavailable",
            identity: failure === "identity_changed" ? "changed" : "unverified",
            timeout: failure === "timed_out" ? "expired" : "unverified",
            cleanup: "unverified",
        },
        evidence,
    );
}

export function providerExecutableObservationMalformedOutput(
    evidence?: ProviderExecutableObservationEvidence,
): ProviderExecutableObservationFailureReceipt {
    return providerExecutableObservationFailureReceipt(
        "output_parse",
        "malformed_output",
        "malformed_output",
        {
            exitKind: "zero",
            identity: "stable",
            timeout: "within_bound",
            cleanup: "complete",
        },
        evidence,
    );
}

export function providerExecutableObservationIdentityFailure(
    stage: Extract<ProviderExecutableObservationStage, "binding_before" | "binding_after">,
    evidence?: ProviderExecutableObservationEvidence,
): ProviderExecutableObservationFailureReceipt {
    return providerExecutableObservationFailureReceipt(
        stage,
        "identity_changed",
        "identity_changed",
        {
            exitKind: "unavailable",
            identity: "changed",
            timeout: "unverified",
            cleanup: "unverified",
        },
        evidence,
    );
}

export function serializeProviderExecutableObservationFailure(receipt: ProviderExecutableObservationFailureReceipt): string {
    return JSON.stringify(receipt);
}

function boundedExecutableObservationOwnerCode(
    invocation: ProviderExecutableObservationInvocation,
    code: string,
): ProviderExecutableObservationOwnerCode {
    if (BOUNDED_EXECUTABLE_OBSERVATION_OWNER_CODES.has(code as ProviderExecutableObservationOwnerCode)) {
        return code as ProviderExecutableObservationOwnerCode;
    }
    if (code === "executable_changed" || code === "runtime_executable_changed" || code === "wsl_executable_changed") {
        return "identity_changed";
    }
    if (!invocation.cleanupComplete || !invocation.invocationTokenAbsent) return "cleanup_incomplete";
    if (invocation.status === "timed_out" || code === "timeout" || code.endsWith("_timeout") || code === "etimedout") {
        return "process_timeout";
    }
    if (code === "output_limit" || code.includes("output_limit")) return "host_output_limit";
    if (invocation.exitCode !== null && invocation.exitCode !== 0) return "process_exit_nonzero";
    return "unclassified";
}

function providerExecutableObservationFailureReceipt(
    stage: ProviderExecutableObservationStage,
    failure: ProviderExecutableObservationFailure,
    ownerCode: ProviderExecutableObservationOwnerCode,
    state: Pick<ProviderExecutableObservationFailureReceiptBase, "exitKind" | "identity" | "timeout" | "cleanup">,
    evidence?: ProviderExecutableObservationEvidence,
): ProviderExecutableObservationFailureReceipt {
    const base = { stage, failure, ownerCode, ...state };
    if (evidence === undefined) return Object.freeze({ schemaVersion: 2, ...base });
    const elapsedMilliseconds = normalizedElapsedMilliseconds(evidence.elapsedMilliseconds);
    const stdout = boundedOutputFacts(evidence.stdout);
    const stderr = boundedOutputFacts(evidence.stderr);
    return Object.freeze({
        schemaVersion: 3,
        ...base,
        elapsedMilliseconds,
        stdoutByteCount: stdout.byteCount,
        stdoutSha256: stdout.sha256,
        stderrByteCount: stderr.byteCount,
        stderrSha256: stderr.sha256,
    });
}

function normalizedElapsedMilliseconds(value: number): number {
    if (!Number.isFinite(value) || value < 0) throw new TypeError("executable observation elapsed time must be finite");
    return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
}

function boundedOutputFacts(bytes: Uint8Array | null | undefined): {
    readonly byteCount: number | null;
    readonly sha256: Sha256Digest | null;
} {
    if (bytes === null || bytes === undefined) return { byteCount: null, sha256: null };
    return {
        byteCount: bytes.byteLength,
        sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
}

/**
 * Create a pure cooperative deadline. Callers must checkpoint before and after
 * synchronous inventory work and before every per-process observation.
 */
export function createProviderProbeDeadline(startedAtMilliseconds: number, totalMilliseconds: number): ProviderProbeDeadline {
    if (!isNonNegativeSafeInteger(startedAtMilliseconds)) {
        throw new TypeError("Provider probe deadline start must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(totalMilliseconds) || totalMilliseconds <= 0) {
        throw new TypeError("Provider probe deadline duration must be a positive safe integer");
    }
    const expiresAtMilliseconds = startedAtMilliseconds + totalMilliseconds;
    if (!Number.isSafeInteger(expiresAtMilliseconds)) {
        throw new TypeError("Provider probe deadline must remain within the safe-integer range");
    }
    return Object.freeze({ startedAtMilliseconds, expiresAtMilliseconds });
}

/**
 * Return the remaining cooperative budget, or `null` once it is exhausted.
 * A backward clock sample is clamped to the start so the budget never grows.
 */
export function remainingProviderProbeDeadlineMilliseconds(
    deadline: ProviderProbeDeadline,
    nowMilliseconds: number,
): number | null {
    if (!isNonNegativeSafeInteger(nowMilliseconds)) {
        throw new TypeError("Provider probe deadline sample must be a non-negative safe integer");
    }
    const remaining = deadline.expiresAtMilliseconds - Math.max(deadline.startedAtMilliseconds, nowMilliseconds);
    return remaining <= 0 ? null : remaining;
}

function isNonNegativeSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

function requireLocalInvocationBinding(input: ProviderLocalExecutableTreeInvocationInput): void {
    if (input.expectedExecutableSha256 !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(input.expectedExecutableSha256)) {
        throw new TypeError("expected executable SHA-256 must be a canonical digest");
    }
    const hostPlatform = input.hostPlatform ?? process.platform;
    if (
        isWindowsHostedWslContext(input.platformContext, hostPlatform) ||
        canonicalProviderHostPathWithinAccessRoot(input.executablePath, input.platformContext) !== input.executablePath ||
        canonicalProviderHostPathWithinAccessRoot(input.workingDirectory, input.platformContext) !== input.workingDirectory
    ) {
        throw new SafeFilesystemError({
            failureKind: "invalid_path",
            operation: "invoke_local_executable",
            targetPath: input.executablePath,
            systemCode: "PROVIDER_LOCAL_INVOCATION_BINDING_INVALID",
            message: "local executable invocation must remain inside the exact selected PlatformContext",
        });
    }
}

function snapshotExecutable(
    executablePath: string,
    dependencies: ProviderLocalExecutableTreeInvocationDependencies,
): ProviderRegularFileSnapshot {
    return dependencies.snapshotExecutable(executablePath, MAXIMUM_PROVIDER_EXECUTABLE_BYTES);
}

function projectEnvironment(
    environment: NodeJS.ProcessEnv,
    names: readonly string[],
): Array<{ readonly name: string; readonly value: string }> {
    return [...names].sort().flatMap((name) => {
        const value = environment[name];
        return value === undefined ? [] : [{ name, value }];
    });
}

function failedInvocation(
    invocation: LocalExecutableTreeInvocationResult,
    executableSha256: Sha256Digest,
    failureCode: string,
): ProviderLocalExecutableTreeInvocationResult {
    const retainNaturalExitStderr =
        invocation.status === "failed" &&
        invocation.failureCode === "exit" &&
        failureCode === "exit" &&
        invocation.exitCode !== null &&
        invocation.exitCode !== 0 &&
        invocation.signal === null &&
        invocation.cleanupComplete &&
        invocation.invocationTokenAbsent;
    return {
        ...invocation,
        status: invocation.status === "complete" ? "failed" : invocation.status,
        stdout: new Uint8Array(),
        stderr: retainNaturalExitStderr ? invocation.stderr : new Uint8Array(),
        failureCode,
        executableSha256,
    };
}

function executableChanged(executablePath: string, phase: string): SafeFilesystemError {
    return new SafeFilesystemError({
        failureKind: "stale",
        operation: "invoke_local_executable",
        targetPath: executablePath,
        systemCode: "EXECUTABLE_IDENTITY_CHANGED",
        message: `selected executable identity changed ${phase}`,
    });
}
