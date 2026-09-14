import { describe, expect, it } from "vitest";
import { discoverOpenCodeProjects } from "../src/opencode-probe-project-discovery";
import {
    discoverStoppedOpenCodeProjects,
    OPENCODE_PROJECT_DISCOVERY_ENVIRONMENT_VARIABLE_NAMES,
} from "../src/opencode-probe-stopped-project-discovery";

const identity = { deviceId: "device", fileId: "file", entryKind: "file" } as const;
const projectDocument = Buffer.from(
    JSON.stringify([
        {
            id: "project-a",
            worktree: "/selected/project-a",
            name: "Project A",
            sandboxes: ["/selected/project-a-sandbox"],
        },
    ]),
    "utf8",
);

function input() {
    return {
        executablePath: "/selected/opencode",
        executableIdentity: identity,
        environment: {
            HOME: "/selected/home",
            OPENCODE_DB: "/selected/opencode.db",
            PATH: "/must/not/be/projected",
        },
        workingDirectory: "/selected/home",
        platformContext: {
            platform: "linux" as const,
            platformInstanceId: "fixture",
            accessRootPath: "/selected",
        },
        hostPlatform: "linux" as const,
        diagnosticPath: "/selected/opencode.db",
        databasePath: "/selected/opencode.db",
    };
}

function invocation(
    overrides: Partial<{
        status: "complete" | "failed" | "timed_out" | "cleanup_failed";
        exitCode: number | null;
        stdout: Uint8Array;
        stderr: Uint8Array;
        cleanupComplete: boolean;
        invocationTokenAbsent: boolean;
        failureCode: string;
    }> = {},
) {
    return {
        status: "complete" as const,
        exitCode: 0,
        signal: null,
        stdout: projectDocument,
        stderr: new Uint8Array(),
        rootProcess: { processId: 42, lifecycleToken: "100" },
        observedProcesses: [{ processId: 42, lifecycleToken: "100" }],
        cleanupComplete: true,
        invocationTokenAbsent: true,
        failureCode: "",
        executableSha256: `sha256:${"a".repeat(64)}` as const,
        ...overrides,
    };
}

const debugHelpWithoutScrap = Buffer.from(
    [
        "opencode debug",
        "",
        "debugging and troubleshooting tools",
        "",
        "Commands:",
        "  opencode debug config  show resolved configuration",
        "  opencode debug paths   show global paths",
        "",
        "Options:",
        "  -h, --help  show help",
    ].join("\n"),
    "utf8",
);

const debugHelpWithScrap = Buffer.from(
    [
        "opencode debug",
        "",
        "debugging and troubleshooting tools",
        "",
        "Commands:",
        "  opencode debug config  show resolved configuration",
        "  opencode debug scrap   list all known projects",
        "",
        "Options:",
        "  -h, --help  show help",
    ].join("\n"),
    "utf8",
);

describe("OpenCode stopped exact-build project discovery", () => {
    it("invokes only fixed debug scrap through the selected exact executable and minimal named environment", async () => {
        const calls: unknown[] = [];
        const result = await discoverStoppedOpenCodeProjects(input(), {
            invoke: async (value) => {
                calls.push(value);
                return invocation();
            },
            now: () => 0,
        });

        expect(result).toEqual({
            status: "complete",
            projectDocument,
            diagnostics: [],
            compatibilityFallback: "not_allowed",
        });
        expect(calls).toEqual([
            {
                executablePath: "/selected/opencode",
                expectedExecutableIdentity: identity,
                arguments: ["debug", "scrap"],
                workingDirectory: "/selected/home",
                environment: input().environment,
                environmentVariableNames: OPENCODE_PROJECT_DISCOVERY_ENVIRONMENT_VARIABLE_NAMES,
                platformContext: input().platformContext,
                hostPlatform: "linux",
                timeoutMilliseconds: 9_000,
                maximumOutputBytes: 4 * 1_024 * 1_024,
            },
        ]);
        expect(OPENCODE_PROJECT_DISCOVERY_ENVIRONMENT_VARIABLE_NAMES).not.toContain("PATH");
    });

    it("retries only bounded timeouts and accepts a later naturally complete tree", async () => {
        const sleeps: number[] = [];
        let calls = 0;
        const result = await discoverStoppedOpenCodeProjects(input(), {
            invoke: async () => {
                calls += 1;
                return calls === 1
                    ? invocation({
                          status: "timed_out",
                          exitCode: null,
                          stdout: new Uint8Array(),
                          failureCode: "timeout",
                      })
                    : invocation();
            },
            now: () => 0,
            sleep: async (milliseconds) => {
                sleeps.push(milliseconds);
            },
        });
        expect(result.status).toBe("complete");
        expect(calls).toBe(2);
        expect(sleeps).toEqual([3_000]);
    });

    it.each([
        [
            "residual process",
            invocation({
                status: "failed",
                exitCode: 0,
                cleanupComplete: true,
                invocationTokenAbsent: true,
                failureCode: "residual_process",
            }),
            "opencode_stopped_exact_build_residual_process",
        ],
        [
            "cleanup failure",
            invocation({
                status: "cleanup_failed",
                exitCode: null,
                cleanupComplete: false,
                invocationTokenAbsent: false,
                failureCode: "process_tree_remains",
            }),
            "opencode_stopped_exact_build_process_tree_remains",
        ],
        [
            "output overflow",
            invocation({
                status: "failed",
                exitCode: 1,
                stdout: new Uint8Array(),
                failureCode: "output_limit",
            }),
            "opencode_stopped_exact_build_output_limit",
        ],
    ])("fails closed without retrying a deterministic %s", async (_label, value, code) => {
        let calls = 0;
        const result = await discoverStoppedOpenCodeProjects(input(), {
            invoke: async () => {
                calls += 1;
                return value;
            },
            now: () => 0,
            sleep: async () => undefined,
        });
        expect(result).toMatchObject({
            status: "partial",
            projectDocument: null,
            diagnostics: [{ code }],
        });
        expect(calls).toBe(1);
    });

    it.each([
        ["missing exit", { exitCode: null }],
        ["nonzero exit", { exitCode: 2 }],
        ["unclean tree", { cleanupComplete: false }],
        ["remaining token", { invocationTokenAbsent: false }],
    ])("rejects a nominal complete result with %s without enabling the database fallback", async (_label, overrides) => {
        const result = await discoverStoppedOpenCodeProjects(input(), {
            invoke: async () => invocation(overrides),
            now: () => 0,
        });
        expect(result.diagnostics[0]?.code).toBe("opencode_stopped_exact_build_result_invalid");
        expect(result.compatibilityFallback).toBe("not_allowed");
    });

    it("enables the database fallback only for a naturally exited empty project-list protocol", async () => {
        const result = await discoverStoppedOpenCodeProjects(input(), {
            invoke: async () => invocation({ stdout: new Uint8Array() }),
            now: () => 0,
        });
        expect(result).toMatchObject({
            status: "partial",
            projectDocument: null,
            compatibilityFallback: "protocol_incompatible",
            diagnostics: [
                {
                    code: "opencode_stopped_exact_build_result_invalid",
                    causeKind: "invalid_schema",
                },
            ],
        });
    });

    it.each([
        ["Linux", input()],
        ["WSL in Linux", { ...input(), platformContext: { ...input().platformContext, platform: "wsl" as const } }],
    ])("admits the compatibility fallback for exact %s debug help that proves scrap is unavailable", async (_label, value) => {
        let localCalls = 0;
        const result = await discoverStoppedOpenCodeProjects(value, {
            invoke: async () => {
                localCalls += 1;
                return invocation({
                    status: "failed",
                    exitCode: 1,
                    stdout: new Uint8Array(),
                    stderr: debugHelpWithoutScrap,
                    failureCode: "exit",
                });
            },
            now: () => 0,
        });
        expect(result).toMatchObject({
            status: "partial",
            projectDocument: null,
            compatibilityFallback: "protocol_incompatible",
            diagnostics: [
                {
                    code: "opencode_stopped_exact_build_command_unavailable",
                    causeKind: "version_incompatible",
                },
            ],
        });
        expect(localCalls).toBe(1);
    });

    it.each([
        ["the command is still advertised", debugHelpWithScrap],
        ["the output is not exact debug help", Buffer.from("unknown command: scrap", "utf8")],
        [
            "the help has trailing failure text",
            Buffer.concat([debugHelpWithoutScrap, Buffer.from("\npermission denied", "utf8")]),
        ],
        ["the output is malformed UTF-8", Uint8Array.from([0xc3, 0x28])],
        ["the diagnostic exceeds its Provider limit", Buffer.alloc(64 * 1_024 + 1, 0x61)],
    ])("does not enable the database fallback when %s", async (_label, stderr) => {
        const result = await discoverStoppedOpenCodeProjects(input(), {
            invoke: async () =>
                invocation({
                    status: "failed",
                    exitCode: 1,
                    stdout: new Uint8Array(),
                    stderr,
                    failureCode: "exit",
                }),
            now: () => 0,
        });
        expect(result).toMatchObject({
            status: "partial",
            projectDocument: null,
            compatibilityFallback: "not_allowed",
            diagnostics: [{ code: "opencode_stopped_exact_build_exit" }],
        });
    });

    it("does not classify clean help after the executable result is no longer a natural exit", async () => {
        const result = await discoverStoppedOpenCodeProjects(input(), {
            invoke: async () =>
                invocation({
                    status: "failed",
                    exitCode: 1,
                    stdout: new Uint8Array(),
                    stderr: debugHelpWithoutScrap,
                    cleanupComplete: false,
                    invocationTokenAbsent: false,
                    failureCode: "exit",
                }),
            now: () => 0,
        });
        expect(result).toMatchObject({
            status: "partial",
            projectDocument: null,
            compatibilityFallback: "not_allowed",
            diagnostics: [{ code: "opencode_stopped_exact_build_process_tree_remains" }],
        });
    });

    it("stops when the ten-second ceiling cannot accommodate the next retry", async () => {
        const times = [0, 0, 8_000];
        let calls = 0;
        const result = await discoverStoppedOpenCodeProjects(input(), {
            invoke: async () => {
                calls += 1;
                return invocation({
                    status: "timed_out",
                    exitCode: null,
                    stdout: new Uint8Array(),
                    failureCode: "timeout",
                });
            },
            now: () => times.shift() ?? 8_000,
            sleep: async () => undefined,
        });
        expect(result.status).toBe("partial");
        expect(calls).toBe(1);
    });

    it("returns a bounded deadline diagnostic when no attempt can begin", async () => {
        const times = [0, 10_000];
        let calls = 0;
        const result = await discoverStoppedOpenCodeProjects(input(), {
            invoke: async () => {
                calls += 1;
                return invocation();
            },
            now: () => times.shift() ?? 10_000,
        });
        expect(result.diagnostics[0]?.code).toBe("opencode_stopped_exact_build_deadline_exceeded");
        expect(calls).toBe(0);
    });

    it("classifies a refused exact executable without exposing an output document", async () => {
        const result = await discoverStoppedOpenCodeProjects(input(), {
            invoke: async () => {
                throw Object.assign(new Error("denied"), { code: "EACCES" });
            },
            now: () => 0,
        });
        expect(result).toMatchObject({
            status: "partial",
            projectDocument: null,
            diagnostics: [
                {
                    code: "opencode_stopped_exact_build_eacces",
                    causeKind: "permission_denied",
                },
            ],
        });
    });
});

describe("OpenCode running-first and stopped exact-build dispatch", () => {
    function baseInput() {
        return {
            executable: { path: "/selected/opencode", identity },
            environment: input().environment,
            workingDirectory: "/selected/home",
            platformContext: input().platformContext,
            hostPlatform: "linux" as const,
            diagnosticPath: "/selected/opencode.db",
            databasePath: "/selected/opencode.db",
        };
    }

    it("keeps a successful running route authoritative and never invokes stopped discovery", async () => {
        let stoppedCalls = 0;
        const result = await discoverOpenCodeProjects(baseInput(), {
            discoverRunning: async () => ({
                status: "complete",
                projects: [
                    {
                        runtimeProjectKey: "running",
                        displayName: "",
                        primaryRuntimePath: "/selected/running",
                        additionalRuntimePaths: [],
                        locatorKey: "debug_scrap:running",
                    },
                ],
                diagnostics: [],
            }),
            discoverStopped: async () => {
                stoppedCalls += 1;
                throw new Error("stopped fallback must not run");
            },
        });
        expect(result).toMatchObject({
            status: "complete",
            evidenceLevel: "agent_runtime_verified",
            projects: [{ runtimeProjectKey: "running" }],
        });
        expect(stoppedCalls).toBe(0);
    });

    it("passes the exact selected build to stopped discovery and labels its runtime-owned list truthfully", async () => {
        const calls: unknown[] = [];
        const result = await discoverOpenCodeProjects(baseInput(), {
            discoverRunning: async () => ({ status: "stopped", projects: [], diagnostics: [] }),
            discoverStopped: async (value) => {
                calls.push(value);
                return {
                    status: "complete",
                    projectDocument,
                    diagnostics: [],
                    compatibilityFallback: "not_allowed",
                };
            },
        });
        expect(calls).toEqual([
            {
                executablePath: "/selected/opencode",
                executableIdentity: identity,
                environment: input().environment,
                workingDirectory: "/selected/home",
                platformContext: input().platformContext,
                hostPlatform: "linux",
                diagnosticPath: "/selected/opencode.db",
                databasePath: "/selected/opencode.db",
            },
        ]);
        expect(result).toMatchObject({
            status: "complete",
            evidenceLevel: "agent_runtime_verified",
            projects: [
                {
                    runtimeProjectKey: "project-a",
                    locatorKey: "stopped_debug_scrap:project-a",
                },
            ],
        });
    });

    it("never falls back to direct SQLite without an exact executable or a persistent selected profile", async () => {
        let stoppedCalls = 0;
        const noExecutable = await discoverOpenCodeProjects(
            { ...baseInput(), executable: null },
            {
                discoverStopped: async () => {
                    stoppedCalls += 1;
                    throw new Error("must not run");
                },
            },
        );
        expect(noExecutable.diagnostics[0]?.code).toBe("opencode_stopped_exact_build_unavailable");

        const noRegistry = await discoverOpenCodeProjects(
            { ...baseInput(), databasePath: null },
            {
                discoverRunning: async () => ({ status: "stopped", projects: [], diagnostics: [] }),
                discoverStopped: async () => {
                    stoppedCalls += 1;
                    throw new Error("must not run");
                },
            },
        );
        expect(noRegistry.diagnostics[0]?.code).toBe("opencode_stopped_registry_unavailable");
        expect(stoppedCalls).toBe(0);
    });

    it("does not use the compatibility database for an ambiguous stopped-command failure", async () => {
        let compatibilityCalls = 0;
        const failed = await discoverOpenCodeProjects(baseInput(), {
            discoverRunning: async () => ({ status: "stopped", projects: [], diagnostics: [] }),
            discoverStopped: async () => ({
                status: "partial",
                projectDocument: null,
                compatibilityFallback: "not_allowed",
                diagnostics: [
                    {
                        severity: "warning",
                        code: "fixture_failed",
                        message: "fixture",
                        path: "/selected/opencode",
                        traceId: "",
                        operation: "probe",
                        causeKind: "partial",
                        retryable: false,
                        suggestedActions: [],
                        rawSummary: "",
                    },
                ],
            }),
            discoverCompatibilityDatabase: async () => {
                compatibilityCalls += 1;
                throw new Error("ambiguous command failures must not use the compatibility database");
            },
        });
        expect(failed.diagnostics[0]?.code).toBe("fixture_failed");
        expect(compatibilityCalls).toBe(0);
    });

    it("uses one low-confidence database attempt only for stopped output-protocol incompatibility", async () => {
        const calls: unknown[] = [];
        const invalid = await discoverOpenCodeProjects(baseInput(), {
            discoverRunning: async () => ({ status: "stopped", projects: [], diagnostics: [] }),
            discoverStopped: async () => ({
                status: "complete",
                projectDocument: Buffer.from("[{}]", "utf8"),
                diagnostics: [],
                compatibilityFallback: "not_allowed",
            }),
            discoverCompatibilityDatabase: async (value) => {
                calls.push(value);
                return {
                    status: "partial",
                    projectDocument,
                    diagnostics: [
                        {
                            severity: "warning",
                            code: "opencode_compatibility_database_used",
                            message: "compatibility",
                            path: "/selected/opencode.db",
                            traceId: "",
                            operation: "probe",
                            causeKind: "partial",
                            retryable: false,
                            suggestedActions: [],
                            rawSummary: "",
                        },
                    ],
                };
            },
        });
        expect(calls).toEqual([
            {
                databasePath: "/selected/opencode.db",
                platformContext: input().platformContext,
            },
        ]);
        expect(invalid).toMatchObject({
            status: "partial",
            evidenceLevel: "local_artifact",
            projects: [
                {
                    runtimeProjectKey: "project-a",
                    locatorKey: "compatibility_database:project-a",
                },
            ],
            diagnostics: [
                { code: "opencode_stopped_exact_build_project_schema_invalid" },
                { code: "opencode_compatibility_database_used" },
            ],
        });
    });

    it("permits the same one-shot fallback for a naturally exited empty protocol result", async () => {
        let calls = 0;
        const result = await discoverOpenCodeProjects(baseInput(), {
            discoverRunning: async () => ({ status: "stopped", projects: [], diagnostics: [] }),
            discoverStopped: async () => ({
                status: "partial",
                projectDocument: null,
                compatibilityFallback: "protocol_incompatible",
                diagnostics: [
                    {
                        severity: "warning",
                        code: "opencode_stopped_exact_build_result_invalid",
                        message: "protocol",
                        path: "/selected/opencode",
                        traceId: "",
                        operation: "probe",
                        causeKind: "partial",
                        retryable: false,
                        suggestedActions: [],
                        rawSummary: "",
                    },
                ],
            }),
            discoverCompatibilityDatabase: async () => {
                calls += 1;
                return {
                    status: "partial",
                    projectDocument: null,
                    diagnostics: [
                        {
                            severity: "warning",
                            code: "opencode_compatibility_database_nonempty_wal",
                            message: "fallback unavailable",
                            path: "/selected/opencode.db",
                            traceId: "",
                            operation: "probe",
                            causeKind: "partial",
                            retryable: false,
                            suggestedActions: [],
                            rawSummary: "",
                        },
                    ],
                };
            },
        });
        expect(calls).toBe(1);
        expect(result).toMatchObject({
            status: "partial",
            projects: [],
            diagnostics: [
                { code: "opencode_stopped_exact_build_result_invalid" },
                { code: "opencode_compatibility_database_nonempty_wal" },
            ],
        });
    });
});
