/** Exact Claude Code CLI version observation through the existing owned-process authority. */

import {
    canonicalProviderHostPathWithinAccessRoot,
    probeDiagnostic as diagnostic,
    providerExecutableObservationFailureFromError as failureFromError,
    providerExecutableObservationFailureFromInvocation as failureFromInvocation,
    hostPathApiFor,
    providerExecutableObservationIdentityFailure as identityFailure,
    invokeProviderLocalExecutableTreeBounded,
    providerExecutableObservationMalformedOutput as malformedOutputFailure,
    type ProviderLocalExecutableTreeInvocationInput,
    type ProviderLocalExecutableTreeInvocationResult,
    type ProviderRegularFileIdentity,
    type ProviderRegularFileSnapshot,
    sameProviderRegularFileIdentity,
    serializeProviderExecutableObservationFailure,
    snapshotProviderRegularFileNoFollow,
    type ProviderExecutableObservationFailure as VersionObservationFailure,
    type ProviderExecutableObservationFailureReceipt as VersionObservationFailureReceipt,
    type ProviderExecutableObservationOwnerCode as VersionObservationOwnerCode,
} from "@oaam/adapter-framework";
import type { InstallationEvidence, OperationDiagnostic, PlatformContext, Sha256Digest } from "@oaam/core";

const VERSION_ARGUMENTS = ["--version"] as const;
const VERSION_TIMEOUT_MILLISECONDS = 5_000;
const VERSION_MAXIMUM_OUTPUT_BYTES = 4_096;
const VERSION_MAXIMUM_EXECUTABLE_BYTES = 512 * 1_024 * 1_024;
const CLI_VERSION_OBSERVATION_ANCHORS = [
    {
        platform: "wsl",
        versionText: "2.1.220",
        buildIdentity: "sha256:674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863",
    },
] as const;
const VERSION_ENVIRONMENT_NAMES = [
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
    "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL",
    "CLAUDE_CODE_DISABLE_WORKING_SYNC",
    "CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "DISABLE_AUTOUPDATER",
    "ENABLE_TOOL_SEARCH",
    "HOME",
    "LANG",
    "LC_ALL",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
] as const;

export interface ClaudeCodeCliInstallationObservation {
    readonly status: "available" | "not_found" | "needs_permission" | "unknown";
    readonly evidence: InstallationEvidence[];
    readonly diagnostics: OperationDiagnostic[];
    readonly executable: {
        readonly path: string;
        readonly identity: ProviderRegularFileIdentity;
    } | null;
}

export interface ClaudeCodeCliVersionedInstallation extends ClaudeCodeCliInstallationObservation {
    readonly versionText: string;
    readonly buildIdentity: Sha256Digest | "";
}

interface VersionInvocationProfile {
    readonly hostWorkingDirectory: string;
    readonly runtimeWorkingDirectory: string;
    readonly hostEnvironment: NodeJS.ProcessEnv;
    readonly runtimeEnvironment: NodeJS.ProcessEnv;
}

export interface ClaudeCodeCliVersionDependencies {
    readonly invokeLocal: (
        input: ProviderLocalExecutableTreeInvocationInput,
    ) => Promise<ProviderLocalExecutableTreeInvocationResult>;
    readonly sameIdentity: typeof sameProviderRegularFileIdentity;
    readonly snapshotExecutable: (path: string, maximumBytes: number) => ProviderRegularFileSnapshot;
}

const DEFAULT_DEPENDENCIES: ClaudeCodeCliVersionDependencies = {
    invokeLocal: invokeProviderLocalExecutableTreeBounded,
    sameIdentity: sameProviderRegularFileIdentity,
    snapshotExecutable: snapshotProviderRegularFileNoFollow,
};

export async function observeClaudeCodeCliVersion(
    installation: ClaudeCodeCliInstallationObservation,
    platformContext: PlatformContext,
    hostPlatform: NodeJS.Platform = process.platform,
    environment: NodeJS.ProcessEnv = process.env,
    homeDir: string = environment.HOME ?? environment.USERPROFILE ?? "",
): Promise<ClaudeCodeCliVersionedInstallation> {
    return observeClaudeCodeCliVersionForTest(installation, platformContext, hostPlatform, environment, homeDir);
}

/** @internal Exact dependency seam for Provider-owned version observation tests. */
export async function observeClaudeCodeCliVersionForTest(
    installation: ClaudeCodeCliInstallationObservation,
    platformContext: PlatformContext,
    hostPlatform: NodeJS.Platform,
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    overrides: Partial<ClaudeCodeCliVersionDependencies> = {},
): Promise<ClaudeCodeCliVersionedInstallation> {
    const base: ClaudeCodeCliVersionedInstallation = {
        ...installation,
        diagnostics: [...installation.diagnostics],
        versionText: "",
        buildIdentity: "",
    };
    if (installation.status !== "available" || installation.executable === null) return base;

    const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

    let profile: VersionInvocationProfile;
    try {
        profile = buildVersionInvocationProfile(platformContext, environment, homeDir);
    } catch (error) {
        return versionFailure(base, failureFromError("profile", error));
    }

    let executableSnapshot: ProviderRegularFileSnapshot;

    let executableSha256: Sha256Digest;
    try {
        executableSnapshot = dependencies.snapshotExecutable(installation.executable.path, VERSION_MAXIMUM_EXECUTABLE_BYTES);
        executableSha256 = executableSnapshot.sha256;
        if (!dependencies.sameIdentity(installation.executable.identity, executableSnapshot.identity)) {
            return versionFailure(base, identityFailure("binding_before"), executableSha256);
        }
    } catch (error) {
        return versionFailure(base, failureFromError("binding_before", error));
    }
    const knownBuilds = CLI_VERSION_OBSERVATION_ANCHORS.filter(
        (anchor) => anchor.platform === platformContext.platform && anchor.buildIdentity === executableSha256,
    );
    if (knownBuilds.length === 1) {
        const identityStable = sameKnownLocalBuildIdentity(installation, executableSnapshot, dependencies);
        if (!identityStable) {
            return versionFailure(base, identityFailure("binding_after"), executableSha256);
        }
        return {
            ...base,
            versionText: knownBuilds[0]?.versionText ?? "",
            buildIdentity: executableSha256,
        };
    }
    if (knownBuilds.length > 1) return versionFailure(base, malformedOutputFailure(), executableSha256);

    let invocation: ProviderLocalExecutableTreeInvocationResult;
    try {
        invocation = await dependencies.invokeLocal({
            executablePath: installation.executable.path,
            expectedExecutableIdentity: installation.executable.identity,
            arguments: VERSION_ARGUMENTS,
            workingDirectory: profile.hostWorkingDirectory,
            environment: profile.hostEnvironment,
            environmentVariableNames: VERSION_ENVIRONMENT_NAMES,
            platformContext,
            hostPlatform,
            timeoutMilliseconds: VERSION_TIMEOUT_MILLISECONDS,
            maximumOutputBytes: VERSION_MAXIMUM_OUTPUT_BYTES,
        });
    } catch (error) {
        const failure = failureFromError("host_invocation", error);
        return versionFailure(base, failure);
    }

    const buildIdentity = invocation.executableSha256;
    if (buildIdentity !== executableSha256) {
        return versionFailure(base, identityFailure("binding_after"), buildIdentity);
    }
    if (
        invocation.status !== "complete" ||
        invocation.exitCode !== 0 ||
        ("signal" in invocation && invocation.signal !== null) ||
        !invocation.cleanupComplete ||
        !invocation.invocationTokenAbsent
    ) {
        return versionFailure(base, failureFromInvocation(invocation), buildIdentity);
    }
    if (invocation.stderr.byteLength !== 0) {
        return versionFailure(base, malformedOutputFailure(), buildIdentity);
    }
    const versionText = parseClaudeCodeCliVersionOutput(invocation.stdout);
    return versionText === null
        ? versionFailure(base, malformedOutputFailure(), buildIdentity)
        : {
              ...base,
              versionText,
              buildIdentity,
          };
}

function sameKnownLocalBuildIdentity(
    installation: ClaudeCodeCliInstallationObservation,
    beforeSnapshot: ProviderRegularFileSnapshot,
    dependencies: ClaudeCodeCliVersionDependencies,
): boolean {
    const executable = installation.executable;
    if (executable === null) return false;
    try {
        const afterSnapshot = dependencies.snapshotExecutable(executable.path, VERSION_MAXIMUM_EXECUTABLE_BYTES);
        if (
            !dependencies.sameIdentity(beforeSnapshot.identity, afterSnapshot.identity) ||
            beforeSnapshot.sha256 !== afterSnapshot.sha256
        ) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

export function parseClaudeCodeCliVersionOutput(bytes: Uint8Array): string | null {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
    const value = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
    const match = /^([0-9]+(?:\.[0-9]+){1,15})(?: \(Claude Code\))?$/u.exec(value);
    if (match === null) return null;
    const versionText = match[1] as string;
    return versionText.split(".").every((segment) => Number.isSafeInteger(Number(segment))) ? versionText : null;
}

function buildVersionInvocationProfile(
    platformContext: PlatformContext,
    environment: NodeJS.ProcessEnv,
    homeDir: string,
): VersionInvocationProfile {
    if (canonicalProviderHostPathWithinAccessRoot(homeDir, platformContext) !== homeDir) {
        throw new TypeError("Claude version observation requires one canonical home inside the selected PlatformContext");
    }
    const hostEnvironment = versionEnvironment(homeDir, environment, platformContext.platform);
    return {
        hostWorkingDirectory: homeDir,
        runtimeWorkingDirectory: homeDir,
        hostEnvironment,
        runtimeEnvironment: hostEnvironment,
    };
}

function versionEnvironment(
    homePath: string,
    inherited: NodeJS.ProcessEnv,
    platform: PlatformContext["platform"],
): NodeJS.ProcessEnv {
    const systemRoot = safeSystemPath(inherited.SystemRoot ?? inherited.SYSTEMROOT ?? inherited.WINDIR);
    return {
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
        CLAUDE_CODE_DISABLE_WORKING_SYNC: "1",
        CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
        DISABLE_AUTOUPDATER: "1",
        ENABLE_TOOL_SEARCH: "false",
        HOME: homePath,
        LANG: "C",
        LC_ALL: "C",
        ...(platform === "win32" && systemRoot !== null ? { SystemRoot: systemRoot, WINDIR: systemRoot } : {}),
        TEMP: homePath,
        TMP: homePath,
        TMPDIR: homePath,
        USERPROFILE: homePath,
    };
}

function safeSystemPath(value: string | undefined): string | null {
    if (value === undefined || value.includes("\0")) return null;
    const paths = hostPathApiFor(value);
    return paths?.isAbsolute(value) && paths.normalize(value) === value ? value : null;
}

function versionFailure(
    base: ClaudeCodeCliVersionedInstallation,
    receipt: VersionObservationFailureReceipt,
    buildIdentity: Sha256Digest | "" = "",
): ClaudeCodeCliVersionedInstallation {
    const definition = preciseOwnerDiagnostic(receipt.ownerCode) ?? VERSION_FAILURE_DIAGNOSTICS[receipt.failure];
    const operationDiagnostic = diagnostic(definition.code, definition.message, definition.causeKind, "warning");
    return {
        ...base,
        buildIdentity,
        diagnostics: [
            ...base.diagnostics,
            { ...operationDiagnostic, rawSummary: serializeProviderExecutableObservationFailure(receipt) },
        ],
    };
}

function preciseOwnerDiagnostic(
    ownerCode: VersionObservationOwnerCode,
): { readonly code: string; readonly message: string; readonly causeKind: OperationDiagnostic["causeKind"] } | null {
    if (
        !ownerCode.startsWith("observer_") &&
        ownerCode !== "target_exited_before_observer_ready" &&
        ownerCode !== "selected_wsl_invocation_failed" &&
        ownerCode !== "worker_protocol"
    ) {
        return null;
    }
    return {
        code: `claudecode_cli_version_${ownerCode}`,
        message: "The bounded Claude CLI runtime observer did not reach its exact verified terminal state",
        causeKind: "verification_failed",
    };
}

const VERSION_FAILURE_DIAGNOSTICS: Record<
    VersionObservationFailure,
    { readonly code: string; readonly message: string; readonly causeKind: OperationDiagnostic["causeKind"] }
> = {
    runtime_root_not_observed: {
        code: "claudecode_cli_version_runtime_root_not_observed",
        message: "The Claude CLI version process could not be bound to one observed runtime process",
        causeKind: "verification_failed",
    },
    host_invocation_failed: {
        code: "claudecode_cli_version_host_invocation_failed",
        message: "The bounded host could not start the exact Claude CLI version process",
        causeKind: "partial",
    },
    timed_out: {
        code: "claudecode_cli_version_observation_timed_out",
        message: "The exact Claude CLI version check did not finish within its bounded time",
        causeKind: "partial",
    },
    nonzero_exit: {
        code: "claudecode_cli_version_process_exit_nonzero",
        message: "The exact Claude CLI version command did not complete successfully",
        causeKind: "version_incompatible",
    },
    output_limit_exceeded: {
        code: "claudecode_cli_version_output_limit_exceeded",
        message: "The exact Claude CLI version output exceeded its safety bound",
        causeKind: "verification_failed",
    },
    cleanup_incomplete: {
        code: "claudecode_cli_version_process_cleanup_incomplete",
        message: "The Claude CLI version process did not reach a verified clean terminal state",
        causeKind: "verification_failed",
    },
    identity_changed: {
        code: "claudecode_cli_version_executable_identity_changed",
        message: "The exact Claude CLI executable changed during version observation",
        causeKind: "verification_failed",
    },
    malformed_output: {
        code: "claudecode_cli_version_output_malformed",
        message: "The exact Claude CLI executable did not provide one trustworthy numeric version",
        causeKind: "version_incompatible",
    },
    other: {
        code: "claudecode_cli_version_observation_other_failure",
        message: "The exact Claude CLI version could not be verified through the bounded process authority",
        causeKind: "partial",
    },
};
