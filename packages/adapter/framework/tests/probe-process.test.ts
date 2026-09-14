import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { SafeFilesystemError } from "@oaam/shared/filesystem";
import { describe, expect, it } from "vitest";
import { inspectProviderRegularFileNoFollow, sameProviderRegularFileIdentity } from "../src/provider-probe-filesystem";
import {
    classifyProviderProcessObservationFailure,
    createProviderProbeDeadline,
    invokeProviderLocalExecutableTreeBounded,
    invokeProviderLocalExecutableTreeBoundedForTest,
    listProviderLocalProcessExecutableCandidateIdsBounded,
    listProviderLocalProcessIdsBounded,
    observeProviderLocalProcessBounded,
    observeProviderLocalProcessExecutableBounded,
    type ProviderLocalExecutableTreeInvocationResult,
    providerExecutableObservationFailureFromError,
    providerExecutableObservationFailureFromInvocation,
    providerExecutableObservationIdentityFailure,
    providerExecutableObservationMalformedOutput,
    remainingProviderProbeDeadlineMilliseconds,
    serializeProviderExecutableObservationFailure,
} from "../src/provider-probe-process";

const identity = { deviceId: "device", fileId: "file", entryKind: "file" } as const;
const otherIdentity = { deviceId: "device", fileId: "other", entryKind: "file" } as const;

describe("Provider local process observation", () => {
    it("projects a bounded process-ID snapshot without exposing a process-table path", () => {
        const processIds = listProviderLocalProcessIdsBounded(65_536);
        const executableCandidates = listProviderLocalProcessExecutableCandidateIdsBounded(
            fs.realpathSync(process.execPath),
            65_536,
        );

        expect(processIds).toContain(process.pid);
        expect(executableCandidates).toContain(process.pid);
        expect(processIds).toEqual([...processIds].sort((left, right) => left - right));
        expect(executableCandidates).toEqual([...executableCandidates].sort((left, right) => left - right));
        expect(new Set(executableCandidates).size).toBe(executableCandidates.length);
    });

    it("projects the Shared process fact without exposing raw process-table mechanics", () => {
        const executableIdentity = inspectProviderRegularFileNoFollow(fs.realpathSync(process.execPath));
        const observation = observeProviderLocalProcessBounded(process.pid, executableIdentity, 65_536);
        const pathAwareObservation = observeProviderLocalProcessExecutableBounded(
            process.pid,
            fs.realpathSync(process.execPath),
            executableIdentity,
            65_536,
        );

        expect(observation).not.toBeNull();
        if (observation === null) throw new Error("current process executable identity must match");
        expect(observation.processId).toBe(process.pid);
        expect(observation.lifecycleToken).toMatch(/^[0-9]+$/u);
        expect(observation.commandLineBytes.byteLength).toBeGreaterThan(0);
        expect(sameProviderRegularFileIdentity(observation.executableIdentity, executableIdentity)).toBe(true);
        expect(pathAwareObservation).toEqual(observation);
    });

    it("retries only lifecycle transitions and allowlisted busy process-table failures", () => {
        const failures = [
            new SafeFilesystemError({
                failureKind: "not_found",
                operation: "observe_local_process",
                targetPath: "41",
                systemCode: "ENOENT",
                message: "the sampled PID exited",
            }),
            new SafeFilesystemError({
                failureKind: "stale",
                operation: "observe_local_process",
                targetPath: "42",
                systemCode: "STALE_SAMPLE",
                message: "the sampled PID changed",
            }),
            ...["EAGAIN", "EBUSY", "ETXTBSY"].map((code) =>
                Object.assign(new Error(`process table is busy (${code})`), { code }),
            ),
        ];

        expect(failures.map((failure) => classifyProviderProcessObservationFailure(failure))).toEqual([
            { disposition: "retryable_transition", failureKind: "not_found", systemCode: "ENOENT" },
            { disposition: "retryable_transition", failureKind: "stale", systemCode: "STALE_SAMPLE" },
            { disposition: "retryable_transition", failureKind: "io_error", systemCode: "EAGAIN" },
            { disposition: "retryable_transition", failureKind: "io_error", systemCode: "EBUSY" },
            { disposition: "retryable_transition", failureKind: "io_error", systemCode: "ETXTBSY" },
        ]);
    });

    it("fails closed for deterministic and unknown process-table failures", () => {
        const failures = [
            new SafeFilesystemError({
                failureKind: "permission_denied",
                operation: "observe_local_process",
                targetPath: "51",
                systemCode: "EACCES",
                message: "permission denied",
            }),
            new SafeFilesystemError({
                failureKind: "unsupported_platform",
                operation: "observe_local_process",
                targetPath: "52",
                systemCode: "UNSUPPORTED",
                message: "unsupported platform",
            }),
            new SafeFilesystemError({
                failureKind: "wrong_entry_type",
                operation: "observe_local_process",
                targetPath: "53",
                systemCode: "ENOTDIR",
                message: "wrong entry kind",
            }),
            new SafeFilesystemError({
                failureKind: "resource_limit",
                operation: "observe_local_process",
                targetPath: "54",
                systemCode: "RESOURCE_LIMIT",
                message: "resource limit",
            }),
            new Error("unknown process observation failure"),
        ];

        expect(failures.map((failure) => classifyProviderProcessObservationFailure(failure))).toEqual([
            { disposition: "deterministic_failure", failureKind: "permission_denied", systemCode: "EACCES" },
            { disposition: "deterministic_failure", failureKind: "unsupported_platform", systemCode: "UNSUPPORTED" },
            { disposition: "deterministic_failure", failureKind: "wrong_entry_type", systemCode: "ENOTDIR" },
            { disposition: "deterministic_failure", failureKind: "resource_limit", systemCode: "RESOURCE_LIMIT" },
            { disposition: "deterministic_failure", failureKind: "io_error", systemCode: "UNKNOWN" },
        ]);
    });

    it("projects bounded executable-observation failure facts without retaining private failure text", () => {
        const receipts = [
            providerExecutableObservationFailureFromInvocation({
                status: "cleanup_failed",
                exitCode: 0,
                cleanupComplete: false,
                invocationTokenAbsent: false,
                failureCode: "runtime_observation_wsl_process_transition_selected_wsl_invocation_exceeded_its_deadline",
            }),
            providerExecutableObservationFailureFromInvocation({
                status: "timed_out",
                exitCode: null,
                signal: null,
                cleanupComplete: true,
                invocationTokenAbsent: true,
                failureCode: "private_framework_detail",
            }),
            providerExecutableObservationFailureFromInvocation({
                status: "failed",
                exitCode: 7,
                signal: null,
                cleanupComplete: true,
                invocationTokenAbsent: true,
                failureCode: "private_framework_detail",
            }),
            providerExecutableObservationFailureFromError(
                "host_invocation",
                Object.assign(new Error("secret argv and path"), { code: "ENOBUFS" }),
            ),
            providerExecutableObservationIdentityFailure("binding_after"),
            providerExecutableObservationMalformedOutput(),
        ];

        expect(receipts).toEqual([
            {
                schemaVersion: 2,
                stage: "runtime_observation",
                failure: "cleanup_incomplete",
                ownerCode: "runtime_observation_wsl_process_transition_selected_wsl_invocation_exceeded_its_deadline",
                exitKind: "zero",
                identity: "stable",
                timeout: "within_bound",
                cleanup: "incomplete",
            },
            expect.objectContaining({ failure: "timed_out", ownerCode: "process_timeout", timeout: "expired" }),
            expect.objectContaining({ failure: "nonzero_exit", ownerCode: "process_exit_nonzero", exitKind: "nonzero" }),
            expect.objectContaining({
                stage: "host_invocation",
                failure: "output_limit_exceeded",
                ownerCode: "host_output_limit",
            }),
            expect.objectContaining({
                stage: "binding_after",
                failure: "identity_changed",
                ownerCode: "identity_changed",
            }),
            expect.objectContaining({
                stage: "output_parse",
                failure: "malformed_output",
                ownerCode: "malformed_output",
            }),
        ]);
        const serialized = receipts.map(serializeProviderExecutableObservationFailure).join("\n");
        expect(serialized).not.toContain("private_framework_detail");
        expect(serialized).not.toContain("secret argv");
        expect(serialized).not.toContain("path");
    });

    it("maps an unknown completed failure to the fixed unclassified owner code", () => {
        expect(
            providerExecutableObservationFailureFromInvocation({
                status: "failed",
                exitCode: 0,
                cleanupComplete: true,
                invocationTokenAbsent: true,
                failureCode: "provider_private_unknown_failure",
            }),
        ).toMatchObject({ failure: "other", ownerCode: "unclassified" });
    });

    it("retains bounded timing and output facts without retaining executable output", () => {
        const stdout = Buffer.from("1.2.3\n", "utf8");
        const stderr = Buffer.from("private stderr must not be logged", "utf8");
        const receipt = providerExecutableObservationFailureFromInvocation(
            {
                status: "failed",
                exitCode: 0,
                cleanupComplete: true,
                invocationTokenAbsent: true,
                failureCode: "runtime_observation_protocol_failed",
            },
            { elapsedMilliseconds: 12.6, stdout, stderr },
        );
        expect(receipt).toEqual({
            schemaVersion: 3,
            stage: "runtime_observation",
            failure: "other",
            ownerCode: "runtime_observation_protocol_failed",
            exitKind: "zero",
            identity: "stable",
            timeout: "within_bound",
            cleanup: "complete",
            elapsedMilliseconds: 13,
            stdoutByteCount: stdout.byteLength,
            stdoutSha256: `sha256:${createHash("sha256").update(stdout).digest("hex")}`,
            stderrByteCount: stderr.byteLength,
            stderrSha256: `sha256:${createHash("sha256").update(stderr).digest("hex")}`,
        });
        const serialized = serializeProviderExecutableObservationFailure(receipt);
        expect(serialized).not.toContain("1.2.3");
        expect(serialized).not.toContain("private stderr");
        expect(
            providerExecutableObservationFailureFromInvocation(
                {
                    status: "failed",
                    exitCode: 0,
                    cleanupComplete: true,
                    invocationTokenAbsent: true,
                    failureCode: "runtime_observation_failed",
                },
                { elapsedMilliseconds: 1 },
            ),
        ).toMatchObject({ stdoutByteCount: null, stdoutSha256: null, stderrByteCount: null, stderrSha256: null });
        expect(() =>
            providerExecutableObservationFailureFromInvocation(
                {
                    status: "failed",
                    exitCode: 0,
                    cleanupComplete: true,
                    invocationTokenAbsent: true,
                    failureCode: "runtime_observation_failed",
                },
                { elapsedMilliseconds: Number.NaN },
            ),
        ).toThrow(/elapsed time/u);
    });

    it("classifies every bounded invocation failure without preserving private owner text", () => {
        const base = {
            status: "failed" as const,
            exitCode: 0,
            signal: null,
            cleanupComplete: true,
            invocationTokenAbsent: true,
            failureCode: "private_failure",
        };
        const cases = [
            [{ failureCode: "runtime_root_not_observed" }, "runtime_root_not_observed", "runtime_root_not_observed"],
            [{ failureCode: "host_invocation_failed" }, "host_invocation_failed", "host_invocation_failed"],
            [{ status: "timed_out", failureCode: "private_failure" }, "timed_out", "process_timeout"],
            [{ failureCode: "timeout" }, "timed_out", "process_timeout"],
            [{ failureCode: "observer_ready_timeout" }, "timed_out", "observer_ready_timeout"],
            [{ failureCode: "ETIMEDOUT" }, "timed_out", "process_timeout"],
            [{ failureCode: "output_limit" }, "output_limit_exceeded", "host_output_limit"],
            [{ failureCode: "host_output_limit" }, "output_limit_exceeded", "host_output_limit"],
            [{ failureCode: "executable_changed" }, "identity_changed", "identity_changed"],
            [{ failureCode: "runtime_executable_changed" }, "identity_changed", "identity_changed"],
            [{ failureCode: "wsl_executable_changed" }, "identity_changed", "identity_changed"],
            [{ cleanupComplete: false }, "cleanup_incomplete", "cleanup_incomplete"],
            [{ invocationTokenAbsent: false }, "cleanup_incomplete", "cleanup_incomplete"],
            [{ failureCode: "runtime_cleanup_required" }, "cleanup_incomplete", "runtime_cleanup_required"],
            [{ failureCode: "runtime_observation_failed" }, "other", "runtime_observation_failed"],
            [{ failureCode: "runtime_observation_protocol_failed" }, "other", "runtime_observation_protocol_failed"],
            [{ exitCode: 9 }, "nonzero_exit", "process_exit_nonzero"],
        ] as const;

        for (const [overrides, failure, ownerCode] of cases) {
            expect(providerExecutableObservationFailureFromInvocation({ ...base, ...overrides })).toMatchObject({
                failure,
                ownerCode,
            });
        }
        expect(
            providerExecutableObservationFailureFromInvocation({
                ...base,
                exitCode: null,
                signal: "SIGTERM",
                failureCode: "observer_failed",
            }),
        ).toMatchObject({ failure: "other", ownerCode: "observer_failed", exitKind: "signal" });
    });

    it("maps only fixed filesystem failure enums at every executable-observation stage", () => {
        const cases = [
            ["binding_before", "EXECUTABLE_IDENTITY_CHANGED", "identity_changed", "identity_changed"],
            ["binding_after", "IDENTITY_CHANGED", "identity_changed", "identity_changed"],
            ["host_invocation", "ETIMEDOUT", "timed_out", "host_timeout"],
            ["runtime_observation", "OBSERVER_READY_TIMEOUT", "timed_out", "host_timeout"],
            ["host_invocation", "ENOBUFS", "output_limit_exceeded", "host_output_limit"],
            ["host_invocation", "HOST_OUTPUT_LIMIT", "output_limit_exceeded", "host_output_limit"],
            ["host_invocation", "ERR_MAXBUFFER", "output_limit_exceeded", "host_output_limit"],
            ["host_invocation", "PRIVATE_FAILURE", "host_invocation_failed", "host_invocation_exception"],
            ["profile", "PRIVATE_FAILURE", "other", "profile_invalid"],
            ["binding_before", "PRIVATE_FAILURE", "other", "binding_inspection_failed"],
            ["binding_after", "PRIVATE_FAILURE", "other", "binding_inspection_failed"],
            ["runtime_observation", "PRIVATE_FAILURE", "other", "unclassified"],
        ] as const;

        for (const [stage, systemCode, failure, ownerCode] of cases) {
            expect(
                providerExecutableObservationFailureFromError(
                    stage,
                    Object.assign(new Error("private path, argv, and stderr"), { code: systemCode }),
                ),
            ).toMatchObject({ stage, failure, ownerCode });
        }
    });

    it("keeps one cooperative deadline bounded across checkpoints", () => {
        const deadline = createProviderProbeDeadline(1_000, 10_000);

        expect(deadline).toEqual({ startedAtMilliseconds: 1_000, expiresAtMilliseconds: 11_000 });
        expect(Object.isFrozen(deadline)).toBe(true);
        expect(remainingProviderProbeDeadlineMilliseconds(deadline, 900)).toBe(10_000);
        expect(remainingProviderProbeDeadlineMilliseconds(deadline, 4_000)).toBe(7_000);
        expect(remainingProviderProbeDeadlineMilliseconds(deadline, 11_000)).toBeNull();
        expect(remainingProviderProbeDeadlineMilliseconds(deadline, 12_000)).toBeNull();
    });

    it("rejects invalid or overflowing cooperative deadline inputs", () => {
        expect(() => createProviderProbeDeadline(-1, 1)).toThrow(/non-negative safe integer/u);
        expect(() => createProviderProbeDeadline(0.5, 1)).toThrow(/non-negative safe integer/u);
        expect(() => createProviderProbeDeadline(0, 0)).toThrow(/positive safe integer/u);
        expect(() => createProviderProbeDeadline(0, 0.5)).toThrow(/positive safe integer/u);
        expect(() => createProviderProbeDeadline(Number.MAX_SAFE_INTEGER, 1)).toThrow(/safe-integer range/u);
        expect(() =>
            remainingProviderProbeDeadlineMilliseconds({ startedAtMilliseconds: 0, expiresAtMilliseconds: 1 }, -1),
        ).toThrow(/non-negative safe integer/u);
        expect(() =>
            remainingProviderProbeDeadlineMilliseconds({ startedAtMilliseconds: 0, expiresAtMilliseconds: 1 }, 0.5),
        ).toThrow(/non-negative safe integer/u);
    });

    it("owns the invocation token, minimum environment and exact executable snapshot", async () => {
        const invocations: unknown[][] = [];
        const result = await invokeProviderLocalExecutableTreeBoundedForTest(
            {
                ...invocationInput(),
                expectedExecutableSha256: executableSnapshot(identity, "same build").sha256,
            },
            {
                snapshotExecutable: () => executableSnapshot(identity, "same build"),
                sameIdentity: (left, right) => left.fileId === right.fileId,
                randomBytes: () => Buffer.alloc(32, 0xab),
                invoke: async (...arguments_) => {
                    invocations.push(arguments_);
                    return completeInvocation();
                },
            },
        );

        expect(result).toMatchObject({
            status: "complete",
            executableSha256: "sha256:f9374d3b27dd8062a8170ba0d89f865633f5809cfa8a2d161e8ff3dc91f63554",
        });
        expect(new TextDecoder().decode(result.stdout)).toBe("projects");
        expect(invocations).toEqual([
            [
                "/selected/opencode",
                identity,
                ["debug", "scrap"],
                "/selected",
                [
                    { name: "HOME", value: "/selected" },
                    { name: "LANG", value: "C.UTF-8" },
                ],
                "ab".repeat(32),
                1_500,
                4_096,
            ],
        ]);
    });

    it("rejects a different required build before invoking or reading a second snapshot", async () => {
        let reads = 0;
        let invocations = 0;
        await expect(
            invokeProviderLocalExecutableTreeBoundedForTest(
                {
                    ...invocationInput(),
                    expectedExecutableSha256: executableSnapshot(identity, "required build").sha256,
                },
                {
                    snapshotExecutable: () => {
                        reads += 1;
                        return executableSnapshot(identity, "other build");
                    },
                    sameIdentity: () => true,
                    invoke: async () => {
                        invocations += 1;
                        return completeInvocation();
                    },
                },
            ),
        ).rejects.toMatchObject({ systemCode: "EXECUTABLE_BUILD_MISMATCH" });
        expect(reads).toBe(1);
        expect(invocations).toBe(0);
    });

    it.each([
        "sha256:abc",
        `sha256:${"A".repeat(64)}`,
        `sha256:${"0".repeat(64)}\n`,
    ])("rejects noncanonical required digest %j before reading or invoking", async (digest) => {
        let reads = 0;
        let invocations = 0;
        await expect(
            invokeProviderLocalExecutableTreeBoundedForTest(
                {
                    ...invocationInput(),
                    expectedExecutableSha256: digest as `sha256:${string}`,
                },
                {
                    snapshotExecutable: () => {
                        reads += 1;
                        return executableSnapshot(identity, "same build");
                    },
                    invoke: async () => {
                        invocations += 1;
                        return completeInvocation();
                    },
                },
            ),
        ).rejects.toThrow(/canonical digest/u);
        expect(reads).toBe(0);
        expect(invocations).toBe(0);
    });

    it("uses the installed Shared authority when no test dependencies are supplied", async () => {
        const executablePath = fs.realpathSync("/bin/sh");
        const result = await invokeProviderLocalExecutableTreeBounded({
            ...invocationInput(),
            executablePath,
            expectedExecutableIdentity: inspectProviderRegularFileNoFollow(executablePath),
            arguments: ["-c", "printf framework-owned; sleep 0.05"],
            workingDirectory: "/tmp",
            environment: {},
            environmentVariableNames: [],
            platformContext: {
                platform: "linux",
                platformInstanceId: "linux",
                accessRootPath: "/",
            },
        });

        expect(result.status).toBe("complete");
        expect(new TextDecoder().decode(result.stdout)).toBe("framework-owned");
        expect(result.cleanupComplete).toBe(true);
        expect(result.invocationTokenAbsent).toBe(true);
    });

    it("discards failed invocation output and rejects executable replacement after invocation", async () => {
        const timedOut = await invokeProviderLocalExecutableTreeBoundedForTest(invocationInput(), {
            snapshotExecutable: () => executableSnapshot(identity, "same build"),
            sameIdentity: (left, right) => left.fileId === right.fileId,
            randomBytes: () => Buffer.alloc(32),
            invoke: async () => ({
                ...completeInvocation(),
                status: "timed_out",
                stdout: Buffer.from("must not escape"),
                stderr: Buffer.from("must not escape"),
                failureCode: "timeout",
            }),
        });
        expect(timedOut).toMatchObject({ status: "timed_out", failureCode: "timeout" });
        expect(timedOut.stdout).toHaveLength(0);
        expect(timedOut.stderr).toHaveLength(0);

        let reads = 0;
        const replacedIdentity = await invokeProviderLocalExecutableTreeBoundedForTest(invocationInput(), {
            snapshotExecutable: () => executableSnapshot(reads++ === 0 ? identity : otherIdentity, "same build"),
            sameIdentity: (left, right) => left.fileId === right.fileId,
            randomBytes: () => Buffer.alloc(32),
            invoke: async () => completeInvocation(),
        });
        expect(replacedIdentity).toMatchObject({ status: "failed", failureCode: "executable_changed" });
        expect(replacedIdentity.stdout).toHaveLength(0);

        reads = 0;
        const replacedBytes = await invokeProviderLocalExecutableTreeBoundedForTest(invocationInput(), {
            snapshotExecutable: () => executableSnapshot(identity, reads++ === 0 ? "first build" : "second build"),
            sameIdentity: (left, right) => left.fileId === right.fileId,
            randomBytes: () => Buffer.alloc(32),
            invoke: async () => completeInvocation(),
        });
        expect(replacedBytes).toMatchObject({ status: "failed", failureCode: "executable_changed" });
    });

    it("retains bounded stderr only for a clean natural non-zero exit with a stable executable", async () => {
        const cleanExit = await invokeProviderLocalExecutableTreeBoundedForTest(invocationInput(), {
            snapshotExecutable: () => executableSnapshot(identity, "same build"),
            sameIdentity: (left, right) => left.fileId === right.fileId,
            randomBytes: () => Buffer.alloc(32),
            invoke: async () => ({
                ...completeInvocation(),
                status: "failed",
                exitCode: 2,
                stdout: Buffer.from("must not escape"),
                stderr: Buffer.from("unknown command"),
                failureCode: "exit",
            }),
        });
        expect(cleanExit).toMatchObject({ status: "failed", exitCode: 2, failureCode: "exit" });
        expect(cleanExit.stdout).toHaveLength(0);
        expect(new TextDecoder().decode(cleanExit.stderr)).toBe("unknown command");

        let reads = 0;
        const replacedExecutable = await invokeProviderLocalExecutableTreeBoundedForTest(invocationInput(), {
            snapshotExecutable: () => executableSnapshot(reads++ === 0 ? identity : otherIdentity, "same build"),
            sameIdentity: (left, right) => left.fileId === right.fileId,
            randomBytes: () => Buffer.alloc(32),
            invoke: async () => ({
                ...completeInvocation(),
                status: "failed",
                exitCode: 2,
                stderr: Buffer.from("unknown command"),
                failureCode: "exit",
            }),
        });
        expect(replacedExecutable).toMatchObject({ status: "failed", failureCode: "executable_changed" });
        expect(replacedExecutable.stderr).toHaveLength(0);
    });

    it("fails before invocation for a changed executable or foreign local binding", async () => {
        let invocations = 0;
        await expect(
            invokeProviderLocalExecutableTreeBoundedForTest(invocationInput(), {
                snapshotExecutable: () => executableSnapshot(otherIdentity, "same build"),
                sameIdentity: (left, right) => left.fileId === right.fileId,
                invoke: async () => {
                    invocations += 1;
                    return completeInvocation();
                },
            }),
        ).rejects.toMatchObject({ failureKind: "stale", systemCode: "EXECUTABLE_IDENTITY_CHANGED" });

        for (const input of [
            {
                ...invocationInput(),
                platformContext: {
                    platform: "wsl" as const,
                    platformInstanceId: "wsl:Ubuntu",
                    accessRootPath: "\\\\wsl.localhost\\Ubuntu\\",
                },
                executablePath: "\\\\wsl.localhost\\Ubuntu\\selected\\opencode",
                workingDirectory: "\\\\wsl.localhost\\Ubuntu\\selected",
                hostPlatform: "win32" as const,
            },
            { ...invocationInput(), executablePath: "/foreign/opencode" },
            { ...invocationInput(), workingDirectory: "/foreign" },
        ]) {
            await expect(
                invokeProviderLocalExecutableTreeBoundedForTest(input, {
                    invoke: async () => {
                        invocations += 1;
                        return completeInvocation();
                    },
                }),
            ).rejects.toMatchObject({
                failureKind: "invalid_path",
                systemCode: "PROVIDER_LOCAL_INVOCATION_BINDING_INVALID",
            });
        }
        expect(invocations).toBe(0);
    });
});

function invocationInput() {
    return {
        executablePath: "/selected/opencode",
        expectedExecutableIdentity: identity,
        arguments: ["debug", "scrap"],
        workingDirectory: "/selected",
        environment: { LANG: "C.UTF-8", HOME: "/selected" },
        environmentVariableNames: ["LANG", "UNSET", "HOME"],
        platformContext: {
            platform: "linux" as const,
            platformInstanceId: "linux",
            accessRootPath: "/selected",
        },
        timeoutMilliseconds: 1_500,
        maximumOutputBytes: 4_096,
    };
}

function executableSnapshot(fileIdentity: typeof identity | typeof otherIdentity, contents: string) {
    return {
        identity: fileIdentity,
        sha256: `sha256:${createHash("sha256").update(contents).digest("hex")}` as const,
    };
}

function completeInvocation(): ProviderLocalExecutableTreeInvocationResult {
    return {
        status: "complete",
        exitCode: 0,
        signal: null,
        stdout: Buffer.from("projects", "utf8"),
        stderr: new Uint8Array(),
        rootProcess: { processId: 42, lifecycleToken: "100" },
        observedProcesses: [{ processId: 42, lifecycleToken: "100" }],
        cleanupComplete: true,
        invocationTokenAbsent: true,
        failureCode: "",
        executableSha256: `sha256:${"0".repeat(64)}`,
    };
}
