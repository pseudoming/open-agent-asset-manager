import type {
    ProviderLocalExecutableTreeInvocationInput,
    ProviderLocalExecutableTreeInvocationResult,
} from "@oaam/adapter-framework";
import { describe, expect, it } from "vitest";
import { invokeOpenCodeExecutableTreeBounded } from "../src/opencode-probe-local-invocation";

const identity = { deviceId: "device", fileId: "file", entryKind: "file" } as const;
const executablePath = "/home/user/.opencode/bin/opencode";
const workingDirectory = "/home/user";
const platformContext = { platform: "linux", platformInstanceId: "linux", accessRootPath: "/home/user" } as const;
const projectDocument = JSON.stringify([{ id: "project-a", worktree: "/home/user/project-a", sandboxes: [] }]);

function localTreeInvocation(
    overrides: Partial<ProviderLocalExecutableTreeInvocationResult> = {},
): ProviderLocalExecutableTreeInvocationResult {
    return {
        status: "complete",
        exitCode: 0,
        signal: null,
        stdout: Buffer.from(projectDocument, "utf8"),
        stderr: new Uint8Array(),
        rootProcess: { processId: 42, lifecycleToken: "100" },
        observedProcesses: [{ processId: 42, lifecycleToken: "100" }],
        cleanupComplete: true,
        invocationTokenAbsent: true,
        failureCode: "",
        executableSha256: `sha256:${"0".repeat(64)}`,
        ...overrides,
    };
}

describe("OpenCode Framework-owned local invocation projection", () => {
    it("projects only a clean executable-tree result into project-list evidence", async () => {
        const options = {
            expectedExecutableIdentity: identity,
            environment: { HOME: workingDirectory, OPENCODE_DISABLE_AUTOUPDATE: "true" },
            workingDirectory,
            platformContext,
            hostPlatform: "linux" as const,
            timeoutMilliseconds: 1_000,
            maximumOutputBytes: 1_024,
        };
        const invocations: ProviderLocalExecutableTreeInvocationInput[] = [];
        const success = await invokeOpenCodeExecutableTreeBounded(
            executablePath,
            ["debug", "scrap"],
            options,
            async (invocation) => {
                invocations.push(invocation);
                return localTreeInvocation();
            },
        );
        expect(Buffer.from(success.stdout).toString("utf8")).toBe(projectDocument);
        expect(invocations).toEqual([
            expect.objectContaining({
                executablePath,
                expectedExecutableIdentity: identity,
                arguments: ["debug", "scrap"],
                workingDirectory,
                platformContext,
                hostPlatform: "linux",
                timeoutMilliseconds: 1_000,
                maximumOutputBytes: 1_024,
            }),
        ]);
        expect(invocations[0]?.environmentVariableNames).toEqual(
            expect.arrayContaining(["HOME", "OPENCODE_DB", "OPENCODE_DISABLE_AUTOUPDATE"]),
        );

        for (const [status, failureCode, expectedStatus] of [
            ["timed_out", "timeout", "transient"],
            ["cleanup_failed", "residual_process", "failed"],
            ["failed", "executable_changed", "failed"],
        ] as const) {
            const result = await invokeOpenCodeExecutableTreeBounded(executablePath, ["debug", "scrap"], options, async () =>
                localTreeInvocation({
                    status,
                    stdout: Buffer.from("must not escape", "utf8"),
                    failureCode,
                }),
            );
            expect(result).toMatchObject({ status: expectedStatus, failureCode });
            expect(result.stdout).toHaveLength(0);
        }
    });
});
