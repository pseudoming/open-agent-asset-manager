import type {
    ProviderLocalExecutableTreeInvocationInput,
    ProviderLocalExecutableTreeInvocationResult,
} from "@oaam/adapter-framework";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type OpenCodeCliInstallationObservation,
    observeOpenCodeCliVersionForTest,
    parseOpenCodeCliVersionOutput,
} from "../src/opencode-probe-cli-version";

const IDENTITY = { deviceId: "device", fileId: "file", entryKind: "file" } as const;
const OTHER_IDENTITY = { deviceId: "device", fileId: "other", entryKind: "file" } as const;
const BUILD = `sha256:${"a".repeat(64)}` as const;
const KNOWN_WSL_BUILD = "sha256:8eb15fe87080dd11aa095cc0391eb3536d55a46fa9e4427c6a8b664d390ac089" as const;
let sandbox = "";
let homeDir = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-version-test-"));
    homeDir = path.join(sandbox, "home");
    createExistingProfile(homeDir);
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("OpenCode exact CLI version observation", () => {
    it("recognizes a freshly observed local WSL build without starting a version process", async () => {
        const invokeLocal = vi.fn();
        const snapshotExecutable = vi.fn(() => ({ identity: IDENTITY, sha256: KNOWN_WSL_BUILD }));
        const result = await observeLocalWsl({ snapshotExecutable, invokeLocal });
        expect(result).toMatchObject({ versionText: "1.18.11", buildIdentity: KNOWN_WSL_BUILD });
        expect(snapshotExecutable).toHaveBeenCalledOnce();
        expect(invokeLocal).not.toHaveBeenCalled();
    });

    it("accepts only one unambiguous numeric-dotted version", () => {
        expect(parseOpenCodeCliVersionOutput(Buffer.from("1.18.11\n"))).toBe("1.18.11");
        expect(parseOpenCodeCliVersionOutput(Buffer.from("2026.08\r\n"))).toBe("2026.08");
        for (const value of ["", "1", "v1.18.11", "1.18.11 extra", "1.18.11\nnoise", "1.18.x", "1.18.11\n\n"]) {
            expect(parseOpenCodeCliVersionOutput(Buffer.from(value))).toBeNull();
        }
        expect(parseOpenCodeCliVersionOutput(new Uint8Array([0xff]))).toBeNull();
        expect(parseOpenCodeCliVersionOutput(Buffer.from(`${Number.MAX_SAFE_INTEGER}0.1`))).toBeNull();
    });

    it("uses the existing selected profile, fixed --version and a bounded credential-free environment", async () => {
        const calls: ProviderLocalExecutableTreeInvocationInput[] = [];
        const before = profileMetadata(homeDir);
        const result = await observeLocal(
            {
                invokeLocal: async (input) => {
                    calls.push(input);
                    return invocation({ stdout: Buffer.from("1.18.11\n") });
                },
            },
            "opencode",
            { SystemRoot: path.join(homeDir, "system-root") },
        );

        expect(result).toMatchObject({ status: "available", versionText: "1.18.11", buildIdentity: BUILD, diagnostics: [] });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            arguments: ["--version"],
            workingDirectory: homeDir,
            platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox },
            timeoutMilliseconds: 5_000,
            maximumOutputBytes: 4_096,
        });
        expect(calls[0]?.environmentVariableNames).not.toContain("PATH");
        expect(calls[0]?.environmentVariableNames).not.toContain("ANTHROPIC_API_KEY");
        expect(calls[0]?.environment).toMatchObject({
            HOME: homeDir,
            OPENCODE_DB: ":memory:",
            OPENCODE_DISABLE_PROJECT_CONFIG: "true",
            OPENCODE_PURE: "1",
            TMPDIR: path.join(homeDir, ".cache"),
            XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
        });
        expect(profileMetadata(homeDir)).toEqual(before);
    });

    it("keeps source availability when installation or the pre-existing profile cannot support a trustworthy version", async () => {
        const invokeLocal = vi.fn();
        const unavailableInstallation: OpenCodeCliInstallationObservation = {
            ...installation(path.join(sandbox, "missing-opencode")),
            status: "not_found",
            executable: null,
        };
        const absent = await observeOpenCodeCliVersionForTest(unavailableInstallation, context(), "linux", {}, homeDir, {
            invokeLocal,
        });
        expect(absent).toMatchObject({ status: "not_found", versionText: "", buildIdentity: "" });
        expect(invokeLocal).not.toHaveBeenCalled();

        fs.rmSync(path.join(homeDir, ".local", "state", "opencode"), { recursive: true });
        const missingProfile = await observeLocal({ invokeLocal });
        expect(missingProfile).toMatchObject({ status: "available", versionText: "", buildIdentity: BUILD });
        expect(missingProfile.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_cli_version_profile_unavailable", causeKind: "partial" }),
        );
        expect(invokeLocal).not.toHaveBeenCalled();

        const outside = await observeOpenCodeCliVersionForTest(
            installation(path.join(sandbox, "opencode")),
            context(),
            "linux",
            {},
            "/outside",
            { invokeLocal, snapshotExecutable: () => ({ identity: IDENTITY, sha256: BUILD }) },
        );
        expect(outside.diagnostics).toContainEqual(expect.objectContaining({ code: "opencode_cli_version_profile_unavailable" }));
        expect(invokeLocal).not.toHaveBeenCalled();

        const outsideConfig = await observeOpenCodeCliVersionForTest(
            installation(path.join(sandbox, "opencode")),
            context(),
            "linux",
            { XDG_CONFIG_HOME: "/outside" },
            homeDir,
            { invokeLocal, snapshotExecutable: () => ({ identity: IDENTITY, sha256: BUILD }) },
        );
        expect(outsideConfig.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_cli_version_profile_unavailable" }),
        );
        expect(invokeLocal).not.toHaveBeenCalled();

        const directStateRoot = path.join(homeDir, ".local", "state", "opencode");
        fs.symlinkSync(path.join(homeDir, ".cache", "opencode"), directStateRoot, "dir");
        const linkedProfile = await observeLocal({ invokeLocal });
        expect(linkedProfile.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_cli_version_profile_unavailable" }),
        );
        expect(invokeLocal).not.toHaveBeenCalled();
    });

    it("fails closed for blank, malformed, stderr, timeout and residual-process results", async () => {
        for (const [result, code] of [
            [invocation({ stdout: new Uint8Array() }), "opencode_cli_version_output_invalid"],
            [invocation({ stdout: Buffer.from("OpenCode 1.18.11") }), "opencode_cli_version_output_invalid"],
            [
                invocation({ stdout: Buffer.from("1.18.11"), stderr: Buffer.from("warning") }),
                "opencode_cli_version_output_invalid",
            ],
            [
                invocation({ status: "timed_out", exitCode: null, failureCode: "timeout", stdout: new Uint8Array() }),
                "opencode_cli_version_observation_timed_out",
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
                "opencode_cli_version_process_tree_remains",
            ],
        ] as const) {
            const observed = await observeLocal({ invokeLocal: async () => result }, `opencode-${code}`);
            expect(observed).toMatchObject({ status: "available", versionText: "", buildIdentity: BUILD });
            expect(observed.diagnostics).toContainEqual(expect.objectContaining({ code }));
        }
    });

    it("preserves only the bounded process owner in version failure evidence", async () => {
        const observed = await observeLocal({
            invokeLocal: async () =>
                invocation({
                    status: "failed",
                    exitCode: 0,
                    failureCode: "observer_failed",
                    stdout: Buffer.from("must not escape"),
                    stderr: Buffer.from("C:\\secret\\stderr"),
                }),
        });
        const operationDiagnostic = observed.diagnostics.find(({ code }) => code === "opencode_cli_version_observation_failed");

        expect(JSON.parse(operationDiagnostic?.rawSummary ?? "null")).toEqual({
            schemaVersion: 2,
            stage: "runtime_observation",
            failure: "other",
            ownerCode: "observer_failed",
            exitKind: "zero",
            identity: "stable",
            timeout: "within_bound",
            cleanup: "complete",
        });
        expect(JSON.stringify(observed)).not.toContain("must not escape");
        expect(JSON.stringify(observed)).not.toContain("secret");
    });

    it("rejects executable identity or hash changes and never leaks their output", async () => {
        const local = await observeLocal({
            invokeLocal: async () =>
                invocation({ status: "failed", failureCode: "executable_changed", stdout: Buffer.from("1.18.11") }),
        });
        expect(local).toMatchObject({ versionText: "" });
        expect(local.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_cli_version_executable_identity_changed" }),
        );

        const selected = await observeLocalWsl({
            invokeLocal: async () =>
                invocation({ status: "failed", failureCode: "executable_changed", stdout: Buffer.from("private output") }),
        });
        expect(selected).toMatchObject({ versionText: "" });
        expect(selected.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_cli_version_executable_identity_changed" }),
        );
        expect(JSON.stringify(selected)).not.toContain("private output");
    });

    it("fails closed across prebinding, reviewed-build revalidation, and invocation hash drift", async () => {
        const inaccessible = await observeLocal({
            snapshotExecutable: () => {
                throw Object.assign(new Error("private path"), { code: "EACCES" });
            },
        });
        expect(inaccessible.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_cli_version_executable_unavailable" }),
        );

        const localIdentityChanged = await observeLocal({
            snapshotExecutable: () => ({ identity: OTHER_IDENTITY, sha256: BUILD }),
        });
        expect(localIdentityChanged.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_cli_version_executable_identity_changed" }),
        );

        const knownBuildChanged = await observeLocalWsl({
            snapshotExecutable: () => ({ identity: OTHER_IDENTITY, sha256: KNOWN_WSL_BUILD }),
        });
        expect(knownBuildChanged.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_cli_version_executable_identity_changed" }),
        );

        const knownBuildInspectionFailed = await observeLocalWsl({
            snapshotExecutable: () => {
                throw new Error("private path");
            },
        });
        expect(knownBuildInspectionFailed.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_cli_version_executable_unavailable" }),
        );
        expect(JSON.stringify(knownBuildInspectionFailed)).not.toContain("private path");

        const invocationHashChanged = await observeLocal({
            invokeLocal: async () => invocation({ executableSha256: `sha256:${"b".repeat(64)}` }),
        });
        expect(invocationHashChanged.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_cli_version_executable_identity_changed" }),
        );
    });

    it("preserves bounded invocation exceptions instead of promoting a version", async () => {
        const observed = await observeLocal({
            invokeLocal: async () => {
                throw Object.assign(new Error("fixture identity changed"), { code: "OPENCODE_EXECUTABLE_IDENTITY_CHANGED" });
            },
        });
        expect(observed).toMatchObject({ status: "available", versionText: "", buildIdentity: BUILD });
        expect(observed.diagnostics).toContainEqual(
            expect.objectContaining({
                code: "opencode_cli_version_executable_identity_changed",
                causeKind: "verification_failed",
            }),
        );
    });

    it("does not promote a version when the selected profile changes during invocation", async () => {
        const result = await observeLocal({
            invokeLocal: async () => {
                fs.writeFileSync(path.join(homeDir, ".cache", "opencode", "probe-residue"), "unexpected");
                return invocation({ stdout: Buffer.from("1.18.11") });
            },
        });
        expect(result).toMatchObject({ versionText: "", buildIdentity: BUILD });
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: "opencode_cli_version_profile_changed", causeKind: "version_incompatible" }),
        );
    });

    it("fails closed when the after-invocation profile snapshot cannot be confirmed", async () => {
        const result = await observeLocal({
            buildProfile: () => ({
                hostWorkingDirectory: homeDir,
                runtimeWorkingDirectory: homeDir,
                hostEnvironment: {},
                runtimeEnvironment: {},
                directorySnapshots: profileSnapshotFixture(),
            }),
            snapshotProfile: () => {
                throw new Error("fixture profile disappeared");
            },
            invokeLocal: async () => invocation({ stdout: Buffer.from("1.18.11") }),
        });
        expect(result).toMatchObject({ versionText: "", buildIdentity: BUILD });
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "opencode_cli_version_profile_changed" }));
    });
});

async function observeLocal(
    overrides: Parameters<typeof observeOpenCodeCliVersionForTest>[5],
    executableName = "opencode",
    environment: NodeJS.ProcessEnv = {},
) {
    return observeOpenCodeCliVersionForTest(
        installation(path.join(sandbox, executableName)),
        context(),
        "linux",
        environment,
        homeDir,
        {
            snapshotExecutable: () => ({ identity: IDENTITY, sha256: BUILD }),
            ...overrides,
        },
    );
}

async function observeLocalWsl(overrides: Parameters<typeof observeOpenCodeCliVersionForTest>[5]) {
    return observeOpenCodeCliVersionForTest(
        installation(path.join(sandbox, "opencode")),
        { ...context(), platform: "wsl" },
        "linux",
        {},
        homeDir,
        {
            snapshotExecutable: () => ({ identity: IDENTITY, sha256: BUILD }),
            ...overrides,
        },
    );
}

function context() {
    return { platform: "linux" as const, platformInstanceId: "fixture", accessRootPath: sandbox };
}

function createExistingProfile(root: string): void {
    for (const directory of [
        root,
        path.join(root, ".config", "opencode"),
        path.join(root, ".local", "share", "opencode", "log"),
        path.join(root, ".local", "share", "opencode", "repos"),
        path.join(root, ".cache", "opencode", "bin"),
        path.join(root, ".local", "state", "opencode"),
    ]) {
        fs.mkdirSync(directory, { recursive: true });
    }
}

function profileMetadata(root: string): string[] {
    return [
        root,
        path.join(root, ".config", "opencode"),
        path.join(root, ".local", "share", "opencode"),
        path.join(root, ".local", "share", "opencode", "log"),
        path.join(root, ".local", "share", "opencode", "repos"),
        path.join(root, ".cache", "opencode"),
        path.join(root, ".cache", "opencode", "bin"),
        path.join(root, ".local", "state", "opencode"),
    ].map((value) => {
        const stat = fs.lstatSync(value, { bigint: true });
        return `${value}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    });
}

function profileSnapshotFixture() {
    return [
        {
            path: "profile",
            deviceId: "1",
            fileId: "2",
            mode: "16877",
            byteSize: "0",
            modificationTimeNanoseconds: "3",
            changeTimeNanoseconds: "4",
            members: [],
        },
    ];
}

function installation(executablePath: string): OpenCodeCliInstallationObservation {
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
        stdout: Buffer.from("1.18.11"),
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
