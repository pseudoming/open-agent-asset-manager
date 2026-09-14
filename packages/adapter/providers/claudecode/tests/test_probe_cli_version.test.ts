import type {
    ProviderLocalExecutableTreeInvocationInput,
    ProviderLocalExecutableTreeInvocationResult,
} from "@oaam/adapter-framework";
import { describe, expect, it, vi } from "vitest";
import {
    type ClaudeCodeCliInstallationObservation,
    observeClaudeCodeCliVersionForTest,
    parseClaudeCodeCliVersionOutput,
} from "../src/claudecode-probe-cli-version";

const IDENTITY = { deviceId: "device", fileId: "file", entryKind: "file" } as const;
const OTHER_IDENTITY = { deviceId: "device", fileId: "other", entryKind: "file" } as const;
const BUILD = `sha256:${"a".repeat(64)}` as const;
const KNOWN_WSL_BUILD = "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863" as const;
const ROOT = "/fixture";
const HOME = "/fixture/home";

describe("Claude Code exact CLI version observation", () => {
    it("normalizes only one unambiguous numeric-dotted Claude version", () => {
        expect(parseClaudeCodeCliVersionOutput(Buffer.from("2.1.220 (Claude Code)\n"))).toBe("2.1.220");
        expect(parseClaudeCodeCliVersionOutput(Buffer.from("2.1.220\r\n"))).toBe("2.1.220");
        for (const value of [
            "",
            "2",
            "v2.1.220",
            "2.1.220 Claude Code",
            "2.1.220 (Claude Code)\nnoise",
            "2.1.x",
            "2.1.220\n\n",
            `${Number.MAX_SAFE_INTEGER}0.1`,
        ]) {
            expect(parseClaudeCodeCliVersionOutput(Buffer.from(value))).toBeNull();
        }
        expect(parseClaudeCodeCliVersionOutput(new Uint8Array([0xff]))).toBeNull();
    });

    it("uses the exact executable, fixed --version and a bounded credential-free environment", async () => {
        const calls: ProviderLocalExecutableTreeInvocationInput[] = [];
        const observed = await observeLocal({
            invokeLocal: async (input) => {
                calls.push(input);
                return invocation({ stdout: Buffer.from("2.1.220 (Claude Code)\n") });
            },
        });

        expect(observed).toMatchObject({ status: "available", versionText: "2.1.220", buildIdentity: BUILD, diagnostics: [] });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            executablePath: "/fixture/claude",
            expectedExecutableIdentity: IDENTITY,
            arguments: ["--version"],
            workingDirectory: HOME,
            platformContext: context(),
            timeoutMilliseconds: 5_000,
            maximumOutputBytes: 4_096,
        });
        expect(calls[0]?.environmentVariableNames).not.toContain("PATH");
        expect(calls[0]?.environmentVariableNames).not.toContain("ANTHROPIC_API_KEY");
        expect(calls[0]?.environment).toMatchObject({
            HOME,
            USERPROFILE: HOME,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_AUTOUPDATER: "1",
            ENABLE_TOOL_SEARCH: "false",
        });
    });

    it("revalidates a reviewed local WSL build before trusting its anchored version", async () => {
        const invokeLocal = vi.fn();
        const localWslContext = { platform: "wsl" as const, platformInstanceId: "local", accessRootPath: ROOT };
        const stableSnapshot = vi.fn(() => ({ identity: IDENTITY, sha256: KNOWN_WSL_BUILD }));
        const stable = await observeClaudeCodeCliVersionForTest(
            installation("/fixture/claude"),
            localWslContext,
            "linux",
            {},
            HOME,
            { invokeLocal, snapshotExecutable: stableSnapshot },
        );
        expect(stable).toMatchObject({ versionText: "2.1.220", buildIdentity: KNOWN_WSL_BUILD });
        expect(stableSnapshot).toHaveBeenCalledTimes(2);

        let changedCalls = 0;
        const changed = await observeClaudeCodeCliVersionForTest(
            installation("/fixture/claude"),
            localWslContext,
            "linux",
            {},
            HOME,
            {
                invokeLocal,
                snapshotExecutable: () => ({
                    identity: changedCalls++ === 0 ? IDENTITY : OTHER_IDENTITY,
                    sha256: KNOWN_WSL_BUILD,
                }),
            },
        );
        expect(failureReceiptOf(changed)).toMatchObject({ stage: "binding_after", identity: "changed" });

        let failedCalls = 0;
        const failed = await observeClaudeCodeCliVersionForTest(
            installation("/fixture/claude"),
            localWslContext,
            "linux",
            {},
            HOME,
            {
                invokeLocal,
                snapshotExecutable: () => {
                    if (failedCalls++ > 0) throw new Error("private revalidation failure");
                    return { identity: IDENTITY, sha256: KNOWN_WSL_BUILD };
                },
            },
        );
        expect(failureReceiptOf(failed)).toMatchObject({ stage: "binding_after", identity: "changed" });
        expect(invokeLocal).not.toHaveBeenCalled();
    });

    it("retains source availability when no trustworthy version can be observed", async () => {
        const invokeLocal = vi.fn();
        const missing = await observeClaudeCodeCliVersionForTest(
            { ...installation("/fixture/missing"), status: "not_found", executable: null },
            context(),
            "linux",
            {},
            HOME,
            { invokeLocal },
        );
        expect(missing).toMatchObject({ status: "not_found", versionText: "", buildIdentity: "" });
        expect(invokeLocal).not.toHaveBeenCalled();

        const outside = await observeClaudeCodeCliVersionForTest(
            installation("/fixture/claude"),
            context(),
            "linux",
            {},
            "/outside",
            { invokeLocal },
        );
        expect(outside).toMatchObject({ status: "available", versionText: "", buildIdentity: "" });
        expect(outside.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode_cli_version_observation_other_failure",
                causeKind: "partial",
                path: "",
            }),
        );
        expect(failureReceiptOf(outside)).toMatchObject({ stage: "profile", failure: "other", ownerCode: "profile_invalid" });
        expect(invokeLocal).not.toHaveBeenCalled();
    });

    it("maps every bounded process terminal to a finite non-sensitive diagnostic", async () => {
        for (const [result, code, failure, ownerCode] of [
            [
                invocation({ stdout: new Uint8Array() }),
                "claudecode_cli_version_output_malformed",
                "malformed_output",
                "malformed_output",
            ],
            [
                invocation({ stdout: Buffer.from("Claude Code 2.1.220") }),
                "claudecode_cli_version_output_malformed",
                "malformed_output",
                "malformed_output",
            ],
            [
                invocation({ stdout: Buffer.from("2.1.220"), stderr: Buffer.from("warning") }),
                "claudecode_cli_version_output_malformed",
                "malformed_output",
                "malformed_output",
            ],
            [
                invocation({ status: "timed_out", exitCode: null, failureCode: "timeout", stdout: new Uint8Array() }),
                "claudecode_cli_version_observation_timed_out",
                "timed_out",
                "process_timeout",
            ],
            [
                invocation({ status: "failed", exitCode: 2, failureCode: "exit" }),
                "claudecode_cli_version_process_exit_nonzero",
                "nonzero_exit",
                "process_exit_nonzero",
            ],
            [
                invocation({ status: "failed", failureCode: "output_limit", stdout: new Uint8Array() }),
                "claudecode_cli_version_output_limit_exceeded",
                "output_limit_exceeded",
                "host_output_limit",
            ],
            [
                invocation({ status: "failed", failureCode: "runtime_root_not_observed", stdout: new Uint8Array() }),
                "claudecode_cli_version_runtime_root_not_observed",
                "runtime_root_not_observed",
                "runtime_root_not_observed",
            ],
            [
                invocation({ status: "failed", failureCode: "host_invocation_failed", stdout: new Uint8Array() }),
                "claudecode_cli_version_host_invocation_failed",
                "host_invocation_failed",
                "host_invocation_failed",
            ],
            [
                invocation({
                    status: "cleanup_failed",
                    exitCode: null,
                    failureCode: "process_tree_remains",
                    cleanupComplete: false,
                    invocationTokenAbsent: false,
                    stdout: new Uint8Array(),
                }),
                "claudecode_cli_version_process_cleanup_incomplete",
                "cleanup_incomplete",
                "process_tree_remains",
            ],
            [
                invocation({ status: "failed", failureCode: "private_framework_detail", stdout: new Uint8Array() }),
                "claudecode_cli_version_observation_other_failure",
                "other",
                "unclassified",
            ],
            [
                invocation({ status: "failed", exitCode: null, failureCode: "observer_ready_timeout" }),
                "claudecode_cli_version_observer_ready_timeout",
                "timed_out",
                "observer_ready_timeout",
            ],
            [
                invocation({ status: "failed", exitCode: null, failureCode: "observer_stderr" }),
                "claudecode_cli_version_observer_stderr",
                "other",
                "observer_stderr",
            ],
        ] as const) {
            const observed = await observeLocal({ invokeLocal: async () => result });
            expect(observed).toMatchObject({ status: "available", versionText: "", buildIdentity: BUILD });
            expect(observed.diagnostics).toContainEqual(expect.objectContaining({ code, path: "" }));
            expect(failureReceiptOf(observed)).toMatchObject({ failure, ownerCode });
        }
    });

    it.each([
        "observer_exited_before_ready",
        "observer_exited_while_target_running",
        "observer_failed",
        "observer_output_limit",
        "observer_ready_malformed",
        "observer_ready_not_observed",
        "observer_signal_failed",
        "target_exited_before_observer_ready",
        "selected_wsl_invocation_failed",
        "worker_protocol",
        "observer_handshake_failed",
        "observer_process_tree_remains",
    ] as const)("retains the exact bounded Framework owner code %s", async (ownerCode) => {
        const observed = await observeLocal({
            invokeLocal: async () => invocation({ status: "failed", exitCode: null, failureCode: ownerCode }),
        });

        expect(observed.diagnostics).toContainEqual(expect.objectContaining({ code: `claudecode_cli_version_${ownerCode}` }));
        expect(failureReceiptOf(observed)).toMatchObject({ stage: "runtime_observation", ownerCode });
    });

    it("retains the exact selected-WSL process-transition deadline owner without leaking process details", async () => {
        const ownerCode = "runtime_observation_wsl_process_transition_selected_wsl_invocation_exceeded_its_deadline";
        const observed = await observeLocal({
            invokeLocal: async () => invocation({ status: "failed", exitCode: null, failureCode: ownerCode }),
        });

        expect(observed.diagnostics).toContainEqual(
            expect.objectContaining({ code: "claudecode_cli_version_observation_other_failure", path: "" }),
        );
        expect(failureReceiptOf(observed)).toMatchObject({ stage: "runtime_observation", ownerCode });
    });

    it("rejects local executable identity/hash changes and invocation exceptions", async () => {
        const changed = await observeLocal({
            invokeLocal: async () =>
                invocation({ status: "failed", failureCode: "executable_changed", stdout: Buffer.from("2.1.220") }),
        });
        expect(changed).toMatchObject({ versionText: "", buildIdentity: BUILD });
        expect(changed.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode_cli_version_executable_identity_changed",
                causeKind: "verification_failed",
            }),
        );

        const thrown = await observeLocal({
            invokeLocal: async () => {
                throw Object.assign(new Error("identity changed"), { code: "CLAUDECODE_EXECUTABLE_CHANGED" });
            },
        });
        expect(thrown).toMatchObject({ versionText: "", buildIdentity: "" });
        expect(thrown.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "claudecode_cli_version_executable_identity_changed",
                causeKind: "verification_failed",
            }),
        );
        expect(failureReceiptOf(thrown)).toMatchObject({
            stage: "host_invocation",
            failure: "identity_changed",
            ownerCode: "identity_changed",
            identity: "changed",
        });
    });

    it("fails closed across prebinding, known-build revalidation and invocation hash drift", async () => {
        const prebindingChanged = await observeClaudeCodeCliVersionForTest(
            installation("/fixture/claude"),
            context(),
            "linux",
            {},
            HOME,
            { snapshotExecutable: () => ({ identity: OTHER_IDENTITY, sha256: BUILD }) },
        );
        expect(failureReceiptOf(prebindingChanged)).toMatchObject({ stage: "binding_before", identity: "changed" });

        const prebindingFailed = await observeLocal({
            snapshotExecutable: () => {
                throw Object.assign(new Error("private path"), { code: "EACCES" });
            },
        });
        expect(failureReceiptOf(prebindingFailed)).toMatchObject({
            stage: "binding_before",
            ownerCode: "binding_inspection_failed",
        });

        const knownBuildChanged = await observeLocalWsl({
            snapshotExecutable: () => ({ identity: OTHER_IDENTITY, sha256: KNOWN_WSL_BUILD }),
        });
        expect(failureReceiptOf(knownBuildChanged)).toMatchObject({ stage: "binding_before", identity: "changed" });

        const knownBuildInspectionFailed = await observeLocalWsl({
            snapshotExecutable: () => {
                throw new Error("private path");
            },
        });
        expect(failureReceiptOf(knownBuildInspectionFailed)).toMatchObject({
            stage: "binding_before",
            ownerCode: "binding_inspection_failed",
        });

        const invocationHashChanged = await observeLocal({
            invokeLocal: async () => invocation({ executableSha256: `sha256:${"b".repeat(64)}` }),
        });
        expect(failureReceiptOf(invocationHashChanged)).toMatchObject({ stage: "binding_after", identity: "changed" });
    });

    it("does not retain Framework paths, arguments, stderr, messages or tokens", async () => {
        const secret = "token-secret /private/claude --version stderr-detail";
        const observed = await observeLocal({
            invokeLocal: async () => {
                throw Object.assign(new Error(secret), { code: `PRIVATE_${secret}` });
            },
        });

        expect(observed).toMatchObject({ status: "available", versionText: "", buildIdentity: "" });
        expect(observed.diagnostics[0]).toMatchObject({
            code: "claudecode_cli_version_host_invocation_failed",
            path: "",
        });
        expect(JSON.stringify(observed.diagnostics)).not.toContain(secret);
        expect(failureReceiptOf(observed)).toEqual({
            schemaVersion: 2,
            stage: "host_invocation",
            failure: "host_invocation_failed",
            ownerCode: "host_invocation_exception",
            exitKind: "unavailable",
            identity: "unverified",
            timeout: "unverified",
            cleanup: "unverified",
        });
    });

    it("projects only canonical Windows system paths into the local version environment", async () => {
        const invokeLocal = vi.fn(async () => invocation({ stdout: Buffer.from("2.1.220") }));
        const windowsHome = String.raw`C:\Users\fixture`;
        await observeClaudeCodeCliVersionForTest(
            installation(String.raw`C:\Users\fixture\claude.exe`),
            { platform: "win32", platformInstanceId: "windows", accessRootPath: "C:\\" },
            "win32",
            { SystemRoot: String.raw`C:\Windows` },
            windowsHome,
            { invokeLocal, snapshotExecutable: () => ({ identity: IDENTITY, sha256: BUILD }) },
        );
        expect(invokeLocal.mock.calls[0]?.[0].environment).toMatchObject({
            SystemRoot: String.raw`C:\Windows`,
            WINDIR: String.raw`C:\Windows`,
        });

        await observeClaudeCodeCliVersionForTest(
            installation(String.raw`C:\Users\fixture\claude.exe`),
            { platform: "win32", platformInstanceId: "windows", accessRootPath: "C:\\" },
            "win32",
            { SystemRoot: "relative" },
            windowsHome,
            { invokeLocal, snapshotExecutable: () => ({ identity: IDENTITY, sha256: BUILD }) },
        );
        expect(invokeLocal.mock.calls[1]?.[0].environment).not.toHaveProperty("SystemRoot");
    });
});

async function observeLocal(overrides: Parameters<typeof observeClaudeCodeCliVersionForTest>[5]) {
    return observeClaudeCodeCliVersionForTest(installation("/fixture/claude"), context(), "linux", {}, HOME, {
        snapshotExecutable: () => ({ identity: IDENTITY, sha256: BUILD }),
        ...overrides,
    });
}

async function observeLocalWsl(overrides: Parameters<typeof observeClaudeCodeCliVersionForTest>[5]) {
    return observeClaudeCodeCliVersionForTest(
        installation("/fixture/claude"),
        { ...context(), platform: "wsl" },
        "linux",
        {},
        HOME,
        {
            snapshotExecutable: () => ({ identity: IDENTITY, sha256: BUILD }),
            ...overrides,
        },
    );
}

function context() {
    return { platform: "linux" as const, platformInstanceId: "fixture", accessRootPath: ROOT };
}

function failureReceiptOf(observation: Awaited<ReturnType<typeof observeClaudeCodeCliVersionForTest>>) {
    const rawSummary = observation.diagnostics.at(-1)?.rawSummary;
    if (rawSummary === undefined || rawSummary === "") throw new TypeError("expected one bounded failure receipt");
    return JSON.parse(rawSummary) as Record<string, unknown>;
}

function installation(executablePath: string): ClaudeCodeCliInstallationObservation {
    return {
        status: "available",
        evidence: [{ kind: "executable", path: executablePath, evidenceLevel: "local_artifact", diagnostics: [] }],
        diagnostics: [],
        executable: { path: executablePath, identity: IDENTITY },
    };
}

function invocation(
    overrides: Partial<ProviderLocalExecutableTreeInvocationResult> = {},
): ProviderLocalExecutableTreeInvocationResult {
    return {
        status: "complete",
        exitCode: 0,
        signal: null,
        stdout: Buffer.from("2.1.220"),
        stderr: new Uint8Array(),
        rootProcess: { processId: 42, lifecycleToken: "fixture" },
        observedProcesses: [{ processId: 42, lifecycleToken: "fixture" }],
        cleanupComplete: true,
        invocationTokenAbsent: true,
        failureCode: "",
        executableSha256: BUILD,
        ...overrides,
    };
}
