import { SafeFilesystemError } from "@oaam/shared/filesystem";
import type { ProviderLocalExecutableTreeInvocationResult } from "@oaam/adapter-framework";
import { describe, expect, it, vi } from "vitest";
import { discoverOpenCodeProjects, discoverRunningOpenCodeProjects } from "../src/opencode-probe-project-discovery";
import { discoverOpenCodeResolvedProfileProjects } from "../src/opencode-probe-profile-project-discovery";

const identity = { deviceId: "device", fileId: "file", entryKind: "file" } as const;
const build = "sha256:8eb15fe87080dd11aa095cc0391eb3536d55a46fa9e4427c6a8b664d390ac089";
const document = Buffer.from(
    JSON.stringify([{ id: "project-a", name: "Project A", worktree: "/selected/project-a", sandboxes: [] }]),
);

function input() {
    return {
        executable: { path: "/selected/opencode", identity },
        executablePath: "/selected/opencode",
        executableIdentity: identity,
        environment: { HOME: "/wrong-home", OPENCODE_DB: "/wrong-profile/opencode.db" },
        workingDirectory: "/selected/home",
        databasePath: "/selected/profile/opencode.db",
        diagnosticPath: "/selected/profile/opencode.db",
        platformContext: { platform: "wsl" as const, platformInstanceId: "Ubuntu", accessRootPath: "/selected" },
        hostPlatform: "linux" as const,
    };
}

function complete(
    overrides: Partial<ProviderLocalExecutableTreeInvocationResult> = {},
): ProviderLocalExecutableTreeInvocationResult {
    return {
        status: "complete",
        exitCode: 0,
        signal: null,
        stdout: document,
        stderr: new Uint8Array(),
        rootProcess: { processId: 42, lifecycleToken: "100" },
        observedProcesses: [{ processId: 42, lifecycleToken: "100" }],
        cleanupComplete: true,
        invocationTokenAbsent: true,
        failureCode: "",
        executableSha256: build,
        ...overrides,
    };
}

const systemError = (code: string) => Object.assign(new Error("private process detail"), { code });

describe("OpenCode resolved-profile public read", () => {
    it.each([
        "EACCES",
        "EPERM",
    ])("reads the resolved profile after initial %s without requiring explicit profile selection", async (code) => {
        const invoke = vi.fn(async () => complete());
        const discoverStopped = vi.fn();
        const discoverCompatibilityDatabase = vi.fn();
        const result = await discoverOpenCodeProjects(input(), {
            discoverRunning: (value) =>
                discoverRunningOpenCodeProjects(value, {
                    inspectExecutable: () => identity,
                    listProcessCandidates: () => [42],
                    observeProcess: () => {
                        throw systemError(code);
                    },
                    now: () => 0,
                }),
            discoverResolvedProfile: (value) =>
                discoverOpenCodeResolvedProfileProjects(value, { invoke, inspectDatabase: () => identity }),
            discoverStopped,
            discoverCompatibilityDatabase,
        });
        expect(result).toMatchObject({
            status: "complete",
            evidenceLevel: "agent_runtime_verified",
            projects: [{ runtimeProjectKey: "project-a", locatorKey: "stopped_debug_scrap:project-a" }],
            diagnostics: [
                {
                    severity: "info",
                    code: `opencode_process_observation_${code.toLowerCase()}`,
                    retryable: false,
                    suggestedActions: [],
                },
            ],
        });
        expect(result.diagnostics[0]?.message).toContain("resolved OpenCode profile only");
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith(
            expect.objectContaining({
                expectedExecutableSha256: build,
                expectedExecutableIdentity: identity,
                executablePath: "/selected/opencode",
                arguments: ["debug", "scrap"],
                environment: { HOME: "/selected/home", OPENCODE_DB: "/selected/profile/opencode.db" },
                timeoutMilliseconds: 9_000,
                maximumOutputBytes: 4 * 1_024 * 1_024,
            }),
        );
        expect(discoverStopped).not.toHaveBeenCalled();
        expect(discoverCompatibilityDatabase).not.toHaveBeenCalled();
    });

    it.each([
        ["EACCES", "ENOSYS"],
        ["ENOSYS", "EACCES"],
    ])("does not hide another deterministic inventory failure (%j)", async (first, second) => {
        const discoverResolvedProfile = vi.fn();
        const result = await discoverOpenCodeProjects(input(), {
            discoverRunning: (value) =>
                discoverRunningOpenCodeProjects(value, {
                    inspectExecutable: () => identity,
                    listProcessCandidates: () => [1, 2],
                    observeProcess: (pid) => {
                        throw systemError(pid === 1 ? first : second);
                    },
                    now: () => 0,
                }),
            discoverResolvedProfile,
        });
        expect(result.status).toBe("partial");
        expect(discoverResolvedProfile).not.toHaveBeenCalled();
    });

    it("retains an initial inventory permission fact instead of claiming stopped", async () => {
        const result = await discoverRunningOpenCodeProjects(input(), {
            inspectExecutable: () => identity,
            listProcessCandidates: () => {
                throw systemError("EACCES");
            },
            now: () => 0,
        });
        expect(result).toMatchObject({ status: "partial", processVisibility: "permission_limited" });
    });

    it.each([
        { platformContext: { ...input().platformContext, platform: "linux" as const } },
        { hostPlatform: "win32" as const },
        { databasePath: "/foreign/opencode.db" },
        { workingDirectory: "/foreign" },
        { executablePath: "/foreign/opencode" },
    ])("rejects an unproved environment or foreign profile binding before invocation: %j", async (override) => {
        const invoke = vi.fn();
        const inspectDatabase = vi.fn();
        const result = await discoverOpenCodeResolvedProfileProjects({ ...input(), ...override }, { invoke, inspectDatabase });
        expect(result.status).toBe("partial");
        expect(invoke).not.toHaveBeenCalled();
        expect(inspectDatabase).not.toHaveBeenCalled();
    });

    it("does not invoke when no-follow inspection rejects the database", async () => {
        const invoke = vi.fn();
        const result = await discoverOpenCodeResolvedProfileProjects(input(), {
            invoke,
            inspectDatabase: () => {
                throw systemError("EACCES");
            },
        });
        expect(result.diagnostics[0]?.causeKind).toBe("permission_denied");
        expect(invoke).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain("private process detail");
    });

    it.each<Partial<ProviderLocalExecutableTreeInvocationResult>>([
        { status: "timed_out" },
        { status: "cleanup_failed" },
        { cleanupComplete: false },
        { invocationTokenAbsent: false },
        { exitCode: 1 },
        { signal: "SIGTERM" },
        { executableSha256: `sha256:${"0".repeat(64)}` },
    ])("discards captured output on invalid completion without compatibility fallback: %j", async (override) => {
        const discoverCompatibilityDatabase = vi.fn();
        const result = await discoverOpenCodeProjects(input(), {
            discoverRunning: (value) =>
                discoverRunningOpenCodeProjects(value, {
                    inspectExecutable: () => identity,
                    listProcessCandidates: () => {
                        throw systemError("EACCES");
                    },
                    now: () => 0,
                }),
            discoverResolvedProfile: (value) =>
                discoverOpenCodeResolvedProfileProjects(value, {
                    inspectDatabase: () => identity,
                    invoke: async () => complete(override),
                }),
            discoverCompatibilityDatabase,
        });
        expect(result).toMatchObject({ status: "partial", projects: [], evidenceLevel: "local_artifact" });
        expect(result.diagnostics.every((item) => item.severity === "warning")).toBe(true);
        expect(discoverCompatibilityDatabase).not.toHaveBeenCalled();
    });

    it("retains a pre-invocation build mismatch without claiming a permission failure or exposing private exception text", async () => {
        const result = await discoverOpenCodeResolvedProfileProjects(input(), {
            inspectDatabase: () => identity,
            invoke: async () => {
                throw new SafeFilesystemError({
                    operation: "invoke_local_executable",
                    failureKind: "stale",
                    systemCode: "EXECUTABLE_BUILD_MISMATCH",
                    targetPath: input().executablePath,
                    message: "private build detail",
                });
            },
        });
        expect(result.diagnostics[0]).toMatchObject({
            code: "opencode_profile_build_unreviewed",
            causeKind: "version_incompatible",
        });
        expect(JSON.stringify(result)).not.toContain("private build detail");
    });

    it.each([
        Buffer.from("invalid JSON"),
        Buffer.from('[{"id":"a"}]'),
    ])("rejects malformed public payload without accepting projects", async (stdout) => {
        const result = await discoverOpenCodeResolvedProfileProjects(input(), {
            inspectDatabase: () => identity,
            invoke: async () => complete({ stdout }),
        });
        expect(result).toMatchObject({ status: "partial", projects: [], diagnostics: [{ causeKind: "invalid_schema" }] });
    });
});
