import { describe, expect, it, vi } from "vitest";
import { observeAntigravityCliVersion, observeAntigravityCliVersionForTest } from "../src/antigravity-probe-installation";

const IDENTITY = { deviceId: "device", fileId: "file", entryKind: "file" } as const;
const OTHER_IDENTITY = { deviceId: "device", fileId: "other", entryKind: "file" } as const;
const BUILD = `sha256:${"1".repeat(64)}` as const;
const KNOWN_WSL_BUILD = "sha256:daadeb6c2cb3df1b941beae8b5b4fdb69b6a17c795fcfeb75cebdba9c1578809" as const;
const CURRENT_WSL_BUILD = "sha256:2822292f90deea4556938a8728fe4ed02a1d66d1525cf75fa07a171e36a38c25" as const;

describe("Antigravity exact CLI version observation", () => {
    it.each([
        [KNOWN_WSL_BUILD, "1.1.11"],
        [CURRENT_WSL_BUILD, "1.1.22"],
    ] as const)("recognizes the reviewed Linux-observed WSL build %s without an invocation", async (sha256, versionText) => {
        const invokeExecutableTree = vi.fn();
        const snapshotExecutable = vi.fn(() => ({ identity: IDENTITY, sha256 }));
        const observed = await observeLocalWsl({ snapshotExecutable, invokeExecutableTree });
        expect(observed).toMatchObject({ status: "available", versionText });
        expect(snapshotExecutable).toHaveBeenCalledOnce();
        expect(invokeExecutableTree).not.toHaveBeenCalled();
    });

    it("keeps a non-available public observation unchanged and rejects non-UTF-8 version output", async () => {
        const unavailable = { ...availableCli("/fixture/agy"), status: "not_found" as const };
        expect(await observeAntigravityCliVersion(unavailable, {}, localContext(), "linux")).toEqual(unavailable);

        const malformed = await observeLocal({
            invokeExecutableTree: async () => invocation({ stdout: new Uint8Array([0xff]) }),
        });
        expect(malformed.diagnostics).toContainEqual(expect.objectContaining({ code: "antigravity_cli_version_output_invalid" }));
    });

    it("uses fixed --version input without projecting HOME, PATH, or credentials", async () => {
        const calls: unknown[] = [];
        const observed = await observeLocal({
            async invokeExecutableTree(input) {
                calls.push(input);
                return invocation({ stdout: new TextEncoder().encode("1.1.10\n") });
            },
        });

        expect(observed).toMatchObject({ status: "available", versionText: "1.1.10" });
        expect(observed.evidence[0]?.currentBuildObservation).toBeUndefined();
        expect(calls).toEqual([
            expect.objectContaining({
                executablePath: "/fixture/agy",
                expectedExecutableIdentity: IDENTITY,
                arguments: ["--version"],
                workingDirectory: "/fixture",
                environment: { LANG: "C", LC_ALL: "C" },
                environmentVariableNames: ["LANG", "LC_ALL"],
                timeoutMilliseconds: 5_000,
                maximumOutputBytes: 4_096,
            }),
        ]);
        expect(JSON.stringify(calls)).not.toContain("HOME");
        expect(JSON.stringify(calls)).not.toContain("PATH");
        expect(JSON.stringify(calls)).not.toContain("TOKEN");
    });

    it.each([
        [
            invocation({ status: "timed_out", exitCode: null, failureCode: "timeout" }),
            "antigravity_cli_version_observation_timed_out",
            "process_timeout",
        ],
        [
            invocation({ status: "failed", exitCode: null, failureCode: "output_limit" }),
            "antigravity_cli_version_output_limit_exceeded",
            "host_output_limit",
        ],
        [
            invocation({ status: "failed", exitCode: null, failureCode: "runtime_root_not_observed" }),
            "antigravity_cli_version_runtime_root_not_observed",
            "runtime_root_not_observed",
        ],
        [
            invocation({ status: "failed", exitCode: null, failureCode: "runtime_executable_changed" }),
            "antigravity_cli_version_executable_identity_changed",
            "identity_changed",
        ],
        [
            invocation({
                status: "cleanup_failed",
                exitCode: null,
                failureCode: "runtime_cleanup_required",
                cleanupComplete: false,
                invocationTokenAbsent: false,
            }),
            "antigravity_cli_version_process_cleanup_incomplete",
            "runtime_cleanup_required",
        ],
        [
            invocation({ status: "failed", exitCode: 7, failureCode: "process_exit" }),
            "antigravity_cli_version_process_exit_nonzero",
            "process_exit_nonzero",
        ],
        [
            invocation({ status: "failed", exitCode: null, failureCode: "observer_failed" }),
            "antigravity_cli_version_observer_failed",
            "observer_failed",
        ],
        [
            invocation({ status: "failed", exitCode: 0, failureCode: "runtime_observation_failed" }),
            "antigravity_cli_version_runtime_observation_failed",
            "runtime_observation_failed",
        ],
    ])("preserves the bounded failure owner as %s", async (result, expectedCode, expectedOwnerCode) => {
        const observed = await observeLocal({ invokeExecutableTree: async () => result });
        expect(observed).toMatchObject({ versionText: "" });
        const operationDiagnostic = observed.diagnostics.find(({ code }) => code === expectedCode);
        expect(operationDiagnostic).toBeDefined();
        expect(operationDiagnostic).toMatchObject({ retryable: true, suggestedActions: ["retry"] });
        expect(JSON.parse(operationDiagnostic?.rawSummary ?? "null")).toMatchObject({
            schemaVersion: 3,
            ownerCode: expectedOwnerCode,
            elapsedMilliseconds: expect.any(Number),
            stdoutByteCount: expect.any(Number),
            stdoutSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
            stderrByteCount: expect.any(Number),
            stderrSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        });
        expect(JSON.stringify(observed)).not.toContain("/secret/path");
    });

    it("rejects hash drift, stderr, and malformed output without promoting a version", async () => {
        const hashDrift = await observeLocal({
            invokeExecutableTree: async () => invocation({ executableSha256: `sha256:${"2".repeat(64)}` }),
        });
        expect(hashDrift.diagnostics).toContainEqual(
            expect.objectContaining({ code: "antigravity_cli_version_executable_identity_changed" }),
        );

        for (const result of [
            invocation({ stderr: new TextEncoder().encode("secret stderr") }),
            invocation({ stdout: new TextEncoder().encode("Antigravity 1.1.10") }),
        ]) {
            const observed = await observeLocal({ invokeExecutableTree: async () => result });
            expect(observed).toMatchObject({ versionText: "" });
            expect(observed.diagnostics).toContainEqual(
                expect.objectContaining({ code: "antigravity_cli_version_output_invalid" }),
            );
            expect(JSON.stringify(observed)).not.toContain("secret stderr");
        }
    });

    it("fails closed for ambiguous, unavailable, and revalidated executable identity evidence", async () => {
        const ambiguous = await observeAntigravityCliVersionForTest(
            {
                ...availableCli("/fixture/agy"),
                evidence: [...availableCli("/fixture/agy").evidence, ...availableCli("/fixture/other-apy").evidence],
            },
            {},
            localContext(),
            "linux",
        );
        expect(ambiguous.diagnostics).toContainEqual(
            expect.objectContaining({ code: "antigravity_cli_version_executable_ambiguous" }),
        );

        const missingIdentity = await observeAntigravityCliVersionForTest(
            { ...availableCli("/fixture/agy"), executable: null },
            {},
            localContext(),
            "linux",
        );
        expect(missingIdentity.diagnostics).toContainEqual(
            expect.objectContaining({ code: "antigravity_cli_version_executable_identity_changed" }),
        );

        const inaccessible = await observeLocal({
            snapshotExecutable: () => {
                throw Object.assign(new Error("private path"), { code: "EACCES" });
            },
        });
        expect(inaccessible.diagnostics).toContainEqual(
            expect.objectContaining({ code: "antigravity_cli_version_executable_unavailable" }),
        );

        const localIdentityChanged = await observeLocal({
            snapshotExecutable: () => ({ identity: OTHER_IDENTITY, sha256: BUILD }),
        });
        expect(localIdentityChanged.diagnostics).toContainEqual(
            expect.objectContaining({ code: "antigravity_cli_version_executable_identity_changed" }),
        );

        const knownRuntimeChanged = await observeLocalWsl({
            snapshotExecutable: () => ({ identity: OTHER_IDENTITY, sha256: KNOWN_WSL_BUILD }),
        });
        expect(knownRuntimeChanged.diagnostics).toContainEqual(
            expect.objectContaining({ code: "antigravity_cli_version_executable_identity_changed" }),
        );

        const knownRevalidationFailed = await observeLocalWsl({
            snapshotExecutable: () => {
                throw new Error("private path");
            },
        });
        expect(knownRevalidationFailed.diagnostics).toContainEqual(
            expect.objectContaining({ code: "antigravity_cli_version_executable_unavailable" }),
        );
        expect(JSON.stringify(knownRevalidationFailed)).not.toContain("private path");
    });
});

type VersionOverrides = NonNullable<Parameters<typeof observeAntigravityCliVersionForTest>[4]>;

function observeLocal(overrides: Partial<VersionOverrides>) {
    return observeAntigravityCliVersionForTest(availableCli("/fixture/agy"), {}, localContext(), "linux", {
        snapshotExecutable: () => ({ identity: IDENTITY, sha256: BUILD }),
        ...overrides,
    });
}

function observeLocalWsl(overrides: Partial<VersionOverrides>) {
    return observeAntigravityCliVersionForTest(
        availableCli("/fixture/agy"),
        {},
        { ...localContext(), platform: "wsl" },
        "linux",
        {
            snapshotExecutable: () => ({ identity: IDENTITY, sha256: BUILD }),
            ...overrides,
        },
    );
}

function availableCli(executablePath: string) {
    return {
        status: "available" as const,
        evidence: [
            {
                kind: "executable" as const,
                path: executablePath,
                evidenceLevel: "local_artifact" as const,
                diagnostics: [],
            },
        ],
        diagnostics: [],
        versionText: "",
        executable: { path: executablePath, identity: IDENTITY },
    };
}

function localContext() {
    return { platform: "linux" as const, platformInstanceId: "local", accessRootPath: "/fixture" };
}

function invocation(overrides: Record<string, unknown> = {}) {
    return {
        status: "complete" as const,
        exitCode: 0,
        signal: null,
        stdout: new TextEncoder().encode("1.1.10"),
        stderr: new Uint8Array(),
        rootProcess: { processId: 1234, lifecycleToken: "fixture" },
        observedProcesses: [],
        cleanupComplete: true,
        invocationTokenAbsent: true,
        failureCode: "",
        executableSha256: BUILD,
        ...overrides,
    };
}
