/** Exact OpenCode CLI version observation through the existing owned-process authority. */

import {
    canonicalProviderHostPathWithinAccessRoot,
    probeDiagnostic as diagnostic,
    hostPathApiFor,
    invokeProviderLocalExecutableTreeBounded,
    observeProviderDirectoryMembersBounded,
    providerExecutableObservationFailureFromError,
    providerExecutableObservationFailureFromInvocation,
    providerExecutableObservationIdentityFailure,
    providerExecutableObservationMalformedOutput,
    sameProviderRegularFileIdentity,
    serializeProviderExecutableObservationFailure,
    snapshotProviderRegularFileNoFollow,
    type ProviderExecutableObservationFailureReceipt,
    type ProviderLocalExecutableTreeInvocationInput,
    type ProviderLocalExecutableTreeInvocationResult,
    type ProviderRegularFileIdentity,
    type ProviderRegularFileSnapshot,
} from "@oaam/adapter-framework";
import type { InstallationEvidence, OperationDiagnostic, Platform, PlatformContext, Sha256Digest } from "@oaam/core";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";
import { lstatSync } from "node:fs";
import { OPENCODE_CLI_VERSION_OBSERVATION_ANCHORS } from "./opencode-target-builds";

const CLI_VERSION_ARGUMENTS = ["--version"] as const;
const CLI_VERSION_TIMEOUT_MILLISECONDS = 5_000;
const CLI_VERSION_MAXIMUM_OUTPUT_BYTES = 4_096;
const CLI_VERSION_MAXIMUM_PROFILE_DIRECTORY_ENTRIES = 4_096;
const CLI_VERSION_MAXIMUM_EXECUTABLE_BYTES = 512 * 1_024 * 1_024;
const CLI_VERSION_ENVIRONMENT_NAMES = [
    "APPDATA",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "OPENCODE_DB",
    "OPENCODE_DISABLE_AUTOUPDATE",
    "OPENCODE_DISABLE_CLAUDE_CODE",
    "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
    "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
    "OPENCODE_DISABLE_DEFAULT_PLUGINS",
    "OPENCODE_DISABLE_EXTERNAL_SKILLS",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "OPENCODE_PURE",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WINDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
] as const;

export interface OpenCodeCliInstallationObservation {
    readonly status: "available" | "not_found" | "needs_permission" | "unknown";
    readonly evidence: readonly InstallationEvidence[];
    readonly diagnostics: readonly OperationDiagnostic[];
    readonly executable: {
        readonly path: string;
        readonly identity: ProviderRegularFileIdentity;
    } | null;
}

export interface OpenCodeCliVersionedInstallation extends OpenCodeCliInstallationObservation {
    readonly versionText: string;
    readonly buildIdentity: Sha256Digest | "";
    readonly platform: Platform;
}

interface VersionProfileDirectorySnapshot {
    readonly path: string;
    readonly deviceId: string;
    readonly fileId: string;
    readonly mode: string;
    readonly byteSize: string;
    readonly modificationTimeNanoseconds: string;
    readonly changeTimeNanoseconds: string;
    readonly members: readonly { readonly name: string; readonly entryKind: "file" | "directory" | "other" }[];
}

interface VersionInvocationProfile {
    readonly hostWorkingDirectory: string;
    readonly runtimeWorkingDirectory: string;
    readonly hostEnvironment: NodeJS.ProcessEnv;
    readonly runtimeEnvironment: NodeJS.ProcessEnv;
    readonly directorySnapshots: readonly VersionProfileDirectorySnapshot[];
}

interface OpenCodeCliVersionDependencies {
    readonly buildProfile: (
        platformContext: PlatformContext,
        environment: NodeJS.ProcessEnv,
        homeDir: string,
        hostPlatform: NodeJS.Platform,
    ) => VersionInvocationProfile;
    readonly snapshotProfile: (paths: readonly string[]) => readonly VersionProfileDirectorySnapshot[];
    readonly snapshotExecutable: (path: string, maximumBytes: number) => ProviderRegularFileSnapshot;
    readonly invokeLocal: (
        input: ProviderLocalExecutableTreeInvocationInput,
    ) => Promise<ProviderLocalExecutableTreeInvocationResult>;
    readonly sameIdentity: typeof sameProviderRegularFileIdentity;
}

const DEFAULT_DEPENDENCIES: OpenCodeCliVersionDependencies = {
    buildProfile: buildVersionInvocationProfile,
    snapshotProfile: snapshotVersionProfile,
    snapshotExecutable: snapshotProviderRegularFileNoFollow,
    invokeLocal: invokeProviderLocalExecutableTreeBounded,
    sameIdentity: sameProviderRegularFileIdentity,
};

export async function observeOpenCodeCliVersion(
    installation: OpenCodeCliInstallationObservation,
    platformContext: PlatformContext,
    hostPlatform: NodeJS.Platform = process.platform,
    environment: NodeJS.ProcessEnv = process.env,
    homeDir: string = environment.HOME ?? environment.USERPROFILE ?? "",
): Promise<OpenCodeCliVersionedInstallation> {
    return observeOpenCodeCliVersionForTest(installation, platformContext, hostPlatform, environment, homeDir);
}

/** @internal Exact dependency seam for Provider-owned version observation tests. */
export async function observeOpenCodeCliVersionForTest(
    installation: OpenCodeCliInstallationObservation,
    platformContext: PlatformContext,
    hostPlatform: NodeJS.Platform,
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    overrides: Partial<OpenCodeCliVersionDependencies> = {},
): Promise<OpenCodeCliVersionedInstallation> {
    const base: OpenCodeCliVersionedInstallation = {
        ...installation,
        diagnostics: [...installation.diagnostics],
        versionText: "",
        buildIdentity: "",
        platform: platformContext.platform,
    };
    if (installation.status !== "available" || installation.executable === null) return base;

    const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

    let executableSnapshot: ProviderRegularFileSnapshot;

    let executableSha256: Sha256Digest;
    try {
        executableSnapshot = dependencies.snapshotExecutable(installation.executable.path, CLI_VERSION_MAXIMUM_EXECUTABLE_BYTES);
        executableSha256 = executableSnapshot.sha256;
    } catch (error) {
        return unavailable(
            base,
            "opencode_cli_version_executable_unavailable",
            error,
            installation.executable.path,
            providerExecutableObservationFailureFromError("binding_before", error),
        );
    }
    const observedBase: OpenCodeCliVersionedInstallation = {
        ...base,
        buildIdentity: executableSha256,
    };
    const observedExecutableIdentity = executableSnapshot.identity;
    if (!dependencies.sameIdentity(installation.executable.identity, observedExecutableIdentity)) {
        return versionUnavailable(
            observedBase,
            "opencode_cli_version_executable_identity_changed",
            installation.executable.path,
            executableSha256,
            providerExecutableObservationIdentityFailure("binding_before"),
        );
    }
    const knownBuilds = OPENCODE_CLI_VERSION_OBSERVATION_ANCHORS.filter(
        (anchor) => anchor.platform === platformContext.platform && anchor.buildIdentity === executableSha256,
    );
    if (knownBuilds.length === 1) {
        return {
            ...observedBase,
            versionText: knownBuilds[0]?.versionText ?? "",
        };
    }
    if (knownBuilds.length > 1) {
        return versionUnavailable(
            observedBase,
            "opencode_cli_version_build_identity_ambiguous",
            installation.executable.path,
            executableSha256,
        );
    }
    let profile: VersionInvocationProfile;
    try {
        profile = dependencies.buildProfile(platformContext, environment, homeDir, hostPlatform);
    } catch (error) {
        return unavailable(
            observedBase,
            "opencode_cli_version_profile_unavailable",
            error,
            installation.executable.path,
            providerExecutableObservationFailureFromError("profile", error),
        );
    }

    let invocation: ProviderLocalExecutableTreeInvocationResult | null = null;
    let invocationFailure: OperationDiagnostic | null = null;
    try {
        invocation = await dependencies.invokeLocal({
            executablePath: installation.executable.path,
            expectedExecutableIdentity: installation.executable.identity,
            arguments: CLI_VERSION_ARGUMENTS,
            workingDirectory: profile.hostWorkingDirectory,
            environment: profile.hostEnvironment,
            environmentVariableNames: CLI_VERSION_ENVIRONMENT_NAMES,
            platformContext,
            hostPlatform,
            timeoutMilliseconds: CLI_VERSION_TIMEOUT_MILLISECONDS,
            maximumOutputBytes: CLI_VERSION_MAXIMUM_OUTPUT_BYTES,
        });
    } catch (error) {
        invocationFailure = failureDiagnostic(
            "opencode_cli_version_observation_failed",
            error,
            installation.executable.path,
            providerExecutableObservationFailureFromError("host_invocation", error),
        );
    }

    try {
        const after = dependencies.snapshotProfile(profile.directorySnapshots.map((snapshot) => snapshot.path));
        if (!sameVersionProfile(profile.directorySnapshots, after)) {
            return versionUnavailable(
                observedBase,
                "opencode_cli_version_profile_changed",
                installation.executable.path,
                executableSha256,
            );
        }
    } catch (error) {
        return unavailable(observedBase, "opencode_cli_version_profile_changed", error, profile.hostWorkingDirectory);
    }
    if (invocationFailure !== null) {
        return { ...observedBase, diagnostics: [...observedBase.diagnostics, invocationFailure] };
    }
    if (invocation === null) {
        return unavailable(observedBase, "opencode_cli_version_observation_failed", null, installation.executable.path);
    }

    const buildIdentity = invocation.executableSha256;
    if (buildIdentity !== executableSha256) {
        return versionUnavailable(
            observedBase,
            "opencode_cli_version_executable_identity_changed",
            installation.executable.path,
            buildIdentity,
        );
    }
    if (
        invocation.status !== "complete" ||
        invocation.exitCode !== 0 ||
        ("signal" in invocation && invocation.signal !== null) ||
        !invocation.cleanupComplete ||
        !invocation.invocationTokenAbsent
    ) {
        const receipt = providerExecutableObservationFailureFromInvocation(invocation);
        const code =
            receipt.failure === "timed_out"
                ? "opencode_cli_version_observation_timed_out"
                : receipt.failure === "cleanup_incomplete"
                  ? "opencode_cli_version_process_tree_remains"
                  : receipt.failure === "identity_changed"
                    ? "opencode_cli_version_executable_identity_changed"
                    : receipt.failure === "runtime_root_not_observed"
                      ? "opencode_cli_version_runtime_root_not_observed"
                      : receipt.failure === "output_limit_exceeded"
                        ? "opencode_cli_version_output_limit_exceeded"
                        : receipt.failure === "nonzero_exit"
                          ? "opencode_cli_version_process_exit_nonzero"
                          : receipt.failure === "host_invocation_failed"
                            ? "opencode_cli_version_host_invocation_failed"
                            : "opencode_cli_version_observation_failed";
        return versionUnavailable(observedBase, code, installation.executable.path, buildIdentity, receipt);
    }
    if (invocation.stderr.byteLength !== 0) {
        return versionUnavailable(
            observedBase,
            "opencode_cli_version_output_invalid",
            installation.executable.path,
            buildIdentity,
            providerExecutableObservationMalformedOutput(),
        );
    }
    const versionText = parseOpenCodeCliVersionOutput(invocation.stdout);
    return versionText === null
        ? versionUnavailable(
              observedBase,
              "opencode_cli_version_output_invalid",
              installation.executable.path,
              buildIdentity,
              providerExecutableObservationMalformedOutput(),
          )
        : {
              ...observedBase,
              versionText,
              buildIdentity,
          };
}

export function parseOpenCodeCliVersionOutput(bytes: Uint8Array): string | null {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
    const value = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
    if (!/^[0-9]+(?:\.[0-9]+){1,15}$/u.test(value)) return null;
    return value.split(".").every((segment) => Number.isSafeInteger(Number(segment))) ? value : null;
}

function buildVersionInvocationProfile(
    platformContext: PlatformContext,
    environment: NodeJS.ProcessEnv,
    homeDir: string,
): VersionInvocationProfile {
    const paths = hostPathApiFor(homeDir);
    if (paths === null || canonicalProviderHostPathWithinAccessRoot(homeDir, platformContext) !== homeDir) {
        throw new TypeError("OpenCode version profile requires one canonical home inside the selected PlatformContext");
    }
    const configBase = versionProfileBase(environment.XDG_CONFIG_HOME, paths.join(homeDir, ".config"), platformContext);
    const dataBase = versionProfileBase(environment.XDG_DATA_HOME, paths.join(homeDir, ".local", "share"), platformContext);
    const cacheBase = versionProfileBase(environment.XDG_CACHE_HOME, paths.join(homeDir, ".cache"), platformContext);
    const stateBase = versionProfileBase(environment.XDG_STATE_HOME, paths.join(homeDir, ".local", "state"), platformContext);
    const configRoot = paths.join(configBase, "opencode");
    const dataRoot = paths.join(dataBase, "opencode");
    const cacheRoot = paths.join(cacheBase, "opencode");
    const stateRoot = paths.join(stateBase, "opencode");
    const hostPaths = [
        homeDir,
        configRoot,
        dataRoot,
        paths.join(dataRoot, "log"),
        paths.join(dataRoot, "repos"),
        cacheRoot,
        paths.join(cacheRoot, "bin"),
        stateRoot,
    ];
    const directorySnapshots = snapshotVersionProfile(hostPaths);
    const hostEnvironment = versionEnvironment(
        homeDir,
        configBase,
        dataBase,
        cacheBase,
        stateBase,
        environment,
        platformContext.platform,
    );
    return {
        hostWorkingDirectory: homeDir,
        runtimeWorkingDirectory: homeDir,
        hostEnvironment,
        runtimeEnvironment: hostEnvironment,
        directorySnapshots,
    };
}

function versionProfileBase(value: string | undefined, fallback: string, platformContext: PlatformContext): string {
    const candidate = value?.trim() || fallback;
    const canonical = canonicalProviderHostPathWithinAccessRoot(candidate, platformContext);
    if (canonical === null || canonical !== candidate) {
        throw new TypeError("OpenCode version profile base must remain canonical inside the selected PlatformContext");
    }
    return canonical;
}

function snapshotVersionProfile(paths: readonly string[]): readonly VersionProfileDirectorySnapshot[] {
    return paths.map((path) => {
        const entry = lstatSync(path, { bigint: true });
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
            throw new TypeError("OpenCode version profile requires pre-existing direct directories");
        }
        return {
            path,
            deviceId: entry.dev.toString(),
            fileId: entry.ino.toString(),
            mode: entry.mode.toString(),
            byteSize: entry.size.toString(),
            modificationTimeNanoseconds: entry.mtimeNs.toString(),
            changeTimeNanoseconds: entry.ctimeNs.toString(),
            members: [...observeProviderDirectoryMembersBounded(path, CLI_VERSION_MAXIMUM_PROFILE_DIRECTORY_ENTRIES)].sort(
                (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
            ),
        };
    });
}

function sameVersionProfile(
    before: readonly VersionProfileDirectorySnapshot[],
    after: readonly VersionProfileDirectorySnapshot[],
): boolean {
    return JSON.stringify(before) === JSON.stringify(after);
}

function versionEnvironment(
    homePath: string,
    configBase: string,
    dataBase: string,
    cacheBase: string,
    stateBase: string,
    inherited: NodeJS.ProcessEnv,
    platform: Platform,
): NodeJS.ProcessEnv {
    const paths = hostPathApiFor(homePath);
    if (paths === null) throw new TypeError("OpenCode version profile path must be canonical absolute");
    const systemRoot = safeSystemPath(inherited.SystemRoot ?? inherited.SYSTEMROOT ?? inherited.WINDIR);
    return {
        APPDATA: configBase,
        HOME: homePath,
        LANG: "C",
        LC_ALL: "C",
        LOCALAPPDATA: dataBase,
        OPENCODE_DB: ":memory:",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_CLAUDE_CODE: "true",
        OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        OPENCODE_PURE: "1",
        ...(platform === "win32" && systemRoot !== null ? { SystemRoot: systemRoot, WINDIR: systemRoot } : {}),
        TEMP: cacheBase,
        TMP: cacheBase,
        TMPDIR: cacheBase,
        USERPROFILE: homePath,
        XDG_CACHE_HOME: cacheBase,
        XDG_CONFIG_HOME: configBase,
        XDG_DATA_HOME: dataBase,
        XDG_STATE_HOME: stateBase,
    };
}

function safeSystemPath(value: string | undefined): string | null {
    if (value === undefined || value.includes("\0")) return null;
    const paths = hostPathApiFor(value);
    return paths?.isAbsolute(value) && paths.normalize(value) === value ? value : null;
}

function unavailable(
    base: OpenCodeCliVersionedInstallation,
    code: string,
    error: unknown,
    path: string,
    observation?: ProviderExecutableObservationFailureReceipt,
): OpenCodeCliVersionedInstallation {
    return {
        ...base,
        diagnostics: [...base.diagnostics, failureDiagnostic(code, error, path, observation)],
    };
}

function versionUnavailable(
    base: OpenCodeCliVersionedInstallation,
    code: string,
    path: string,
    buildIdentity: Sha256Digest | "",
    observation?: ProviderExecutableObservationFailureReceipt,
): OpenCodeCliVersionedInstallation {
    const causeKind = code.includes("identity_changed") ? "verification_failed" : "version_incompatible";
    const operationDiagnostic = diagnostic(
        code,
        "The exact OpenCode executable did not provide one trustworthy numeric version",
        causeKind,
        "warning",
        path,
    );
    return {
        ...base,
        buildIdentity,
        diagnostics: [
            ...base.diagnostics,
            observation === undefined
                ? operationDiagnostic
                : {
                      ...operationDiagnostic,
                      rawSummary: serializeProviderExecutableObservationFailure(observation),
                  },
        ],
    };
}

function failureDiagnostic(
    code: string,
    error: unknown,
    path: string,
    observation?: ProviderExecutableObservationFailureReceipt,
): OperationDiagnostic {
    const systemCode =
        typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
    const identityChanged = systemCode.includes("IDENTITY_CHANGED") || systemCode.includes("EXECUTABLE_CHANGED");
    const failure = inspectFilesystemFailure(error);
    const operationDiagnostic = diagnostic(
        identityChanged ? "opencode_cli_version_executable_identity_changed" : code,
        identityChanged
            ? "The exact OpenCode executable identity changed during version observation"
            : "The exact OpenCode executable version could not be observed through the bounded process authority",
        identityChanged
            ? "verification_failed"
            : failure.source === "node_errno_error" && failure.failureKind === "permission_denied"
              ? "permission_denied"
              : "partial",
        "warning",
        path,
    );
    return observation === undefined
        ? operationDiagnostic
        : { ...operationDiagnostic, rawSummary: serializeProviderExecutableObservationFailure(observation) };
}
