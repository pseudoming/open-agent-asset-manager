/** Native executable and structured install-root probe logic for Antigravity entries. */

import {
    canonicalProviderHostPathWithinAccessRoot,
    hostPathApiFor,
    inspectProviderRegularFileNoFollow,
    invokeProviderLocalExecutableTreeBounded,
    providerExecutableObservationFailureFromError,
    providerExecutableObservationFailureFromInvocation,
    providerExecutableObservationIdentityFailure,
    providerExecutableObservationMalformedOutput,
    sameProviderRegularFileIdentity,
    serializeProviderExecutableObservationFailure,
    snapshotProviderRegularFileNoFollow,
    type ProviderExecutableObservationFailureReceipt,
    type ProviderLocalExecutableTreeInvocationResult,
    type ProviderRegularFileIdentity,
    type ProviderRegularFileSnapshot,
} from "@oaam/adapter-framework";
import type { AdapterProbeResult, InstallationEvidence, OperationDiagnostic, Platform, PlatformContext } from "@oaam/core";
import { inspectFilesystemFailure, readRegularFileBounded } from "@oaam/shared/filesystem";
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { diagnostic, isPermission, uniqueSorted } from "./antigravity-probe-foundation";
import { findAntigravityStructuredInstallation } from "./antigravity-probe-structured-installation";

export interface InstallationSearch {
    status: "available" | "not_found" | "needs_permission" | "unknown";
    evidence: InstallationEvidence[];
    diagnostics: OperationDiagnostic[];
    versionText: string;
}

export interface AntigravityConcurrentInstallationDependencies {
    readonly observeCli: () => Promise<InstallationSearch>;
    readonly observeApp: () => Promise<InstallationSearch>;
    readonly observeIde: () => Promise<InstallationSearch>;
}

/** Settle each entry owner independently so a failed observation preserves sibling results. */
export async function observeAntigravityInstallationsConcurrently(
    dependencies: AntigravityConcurrentInstallationDependencies,
): Promise<{ cli: InstallationSearch; app: InstallationSearch; ide: InstallationSearch }> {
    const [cliOutcome, appOutcome, ideOutcome] = await Promise.allSettled([
        dependencies.observeCli(),
        dependencies.observeApp(),
        dependencies.observeIde(),
    ]);
    return {
        cli: cliOutcome.status === "fulfilled" ? cliOutcome.value : failedEntryInstallationObservation("cli", cliOutcome.reason),
        app: appOutcome.status === "fulfilled" ? appOutcome.value : failedEntryInstallationObservation("app", appOutcome.reason),
        ide: ideOutcome.status === "fulfilled" ? ideOutcome.value : failedEntryInstallationObservation("ide", ideOutcome.reason),
    };
}

function failedEntryInstallationObservation(entry: "cli" | "app" | "ide", error: unknown): InstallationSearch {
    const permissionDenied = isPermission(error);
    const label = entry === "cli" ? "CLI" : entry === "app" ? "App" : "IDE";
    return {
        status: permissionDenied ? "needs_permission" : "unknown",
        evidence: [],
        diagnostics: [
            {
                ...diagnostic(
                    `antigravity_${entry}_installation_observation_failed`,
                    `The exact Antigravity ${label} installation could not be inspected safely; other entries remain independently usable`,
                    permissionDenied ? "permission_denied" : "partial",
                    "warning",
                ),
                retryable: true,
                suggestedActions: [permissionDenied ? "grant_permission" : "retry"],
            },
        ],
        versionText: "",
    };
}

export interface CliInstallationSearch extends InstallationSearch {
    executable: { readonly path: string; readonly identity: ProviderRegularFileIdentity } | null;
}

export interface AntigravityInstallationCandidates {
    paths: string[];
    discoveryIncomplete: boolean;
}

export interface AntigravityStructuredInstallationPlan {
    readonly roots: readonly string[];
    readonly discoveryIncomplete: boolean;
}

interface CliVersionObservationDependencies {
    readonly invokeExecutableTree: typeof invokeProviderLocalExecutableTreeBounded;
    readonly sameIdentity: typeof sameProviderRegularFileIdentity;
    readonly snapshotExecutable: (path: string, maximumBytes: number) => ProviderRegularFileSnapshot;
    readonly now: () => number;
}

export interface StructuredInstallationObservationDependencies {
    readonly readRegularFile: typeof readRegularFileBounded;
    readonly regularFile: (path: string) => boolean;
    readonly pathExists: (path: string) => boolean;
    readonly lstat: typeof lstatSync;
    readonly isExecutableNativeBinary: typeof isExecutableNativeBinary;
    readonly isNativeBinaryPrefix: typeof isNativeBinaryPrefix;
}

const DEFAULT_STRUCTURED_INSTALLATION_DEPENDENCIES: StructuredInstallationObservationDependencies = {
    readRegularFile: readRegularFileBounded,
    regularFile,
    pathExists,
    lstat: lstatSync,
    isExecutableNativeBinary,
    isNativeBinaryPrefix,
};

const DEFAULT_CLI_VERSION_DEPENDENCIES: CliVersionObservationDependencies = {
    invokeExecutableTree: invokeProviderLocalExecutableTreeBounded,
    sameIdentity: sameProviderRegularFileIdentity,
    snapshotExecutable: snapshotProviderRegularFileNoFollow,
    now: () => performance.now(),
};

const CLI_VERSION_ENVIRONMENT_NAMES = ["LANG", "LC_ALL"] as const;
const CLI_VERSION_ENVIRONMENT = Object.freeze({ LANG: "C", LC_ALL: "C" });
const CLI_VERSION_TIMEOUT_MILLISECONDS = 5_000;
const CLI_VERSION_MAXIMUM_OUTPUT_BYTES = 4_096;
const CLI_VERSION_MAXIMUM_EXECUTABLE_BYTES = 512 * 1_024 * 1_024;
const CLI_VERSION_OBSERVATION_ANCHORS = [
    {
        platform: "wsl",
        versionText: "1.1.11",
        buildIdentity: "sha256:daadeb6c2cb3df1b941beae8b5b4fdb69b6a17c795fcfeb75cebdba9c1578809",
    },
    {
        platform: "wsl",
        versionText: "1.1.22",
        buildIdentity: "sha256:2822292f90deea4556938a8728fe4ed02a1d66d1525cf75fa07a171e36a38c25",
    },
] as const;
export function findAntigravityCliInstallation(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
    installationRootPath?: string,
): CliInstallationSearch {
    const platform = platformContext.platform;
    const name = platform === "win32" ? "agy.exe" : "agy";
    const candidates = antigravityExecutableCandidates(environment, homeDir, name, platformContext, installationRootPath);
    return findNativeExecutable(candidates, "antigravity_cli_executable", platformContext);
}

/**
 * Ask the already selected executable for its own version through the bounded
 * owned-process authority. HOME and credential variables are deliberately not
 * projected: `--version` must not depend on or mutate a user profile.
 */
export async function observeAntigravityCliVersion(
    installation: CliInstallationSearch,
    environment: NodeJS.ProcessEnv,
    platformContext: PlatformContext,
    hostPlatform: NodeJS.Platform = process.platform,
): Promise<CliInstallationSearch> {
    return observeAntigravityCliVersionForTest(installation, environment, platformContext, hostPlatform, {});
}

/** @internal Exact dependency seam for bounded Provider tests. */
export async function observeAntigravityCliVersionForTest(
    installation: CliInstallationSearch,
    _environment: NodeJS.ProcessEnv,
    platformContext: PlatformContext,
    hostPlatform: NodeJS.Platform,
    overrides: Partial<CliVersionObservationDependencies> = {},
): Promise<CliInstallationSearch> {
    if (installation.status !== "available") return installation;
    const executableEvidence = installation.evidence.filter((evidence) => evidence.kind === "executable");
    const executable = executableEvidence[0];
    if (executableEvidence.length !== 1 || executable === undefined) {
        return versionUnavailable(installation, "antigravity_cli_version_executable_ambiguous", "", "invalid_schema");
    }
    const dependencies = { ...DEFAULT_CLI_VERSION_DEPENDENCIES, ...overrides };

    if (installation.executable === null) {
        return versionUnavailable(
            installation,
            "antigravity_cli_version_executable_identity_changed",
            executable.path,
            "partial",
        );
    }

    let executableSnapshot: ProviderRegularFileSnapshot;

    let executableSha256: string;
    const bindingStartedAt = dependencies.now();
    try {
        executableSnapshot = dependencies.snapshotExecutable(executable.path, CLI_VERSION_MAXIMUM_EXECUTABLE_BYTES);
        executableSha256 = executableSnapshot.sha256;
    } catch (error) {
        return versionUnavailable(
            installation,
            "antigravity_cli_version_executable_unavailable",
            executable.path,
            "partial",
            providerExecutableObservationFailureFromError("binding_before", error, {
                elapsedMilliseconds: dependencies.now() - bindingStartedAt,
            }),
        );
    }
    const observedExecutableIdentity = executableSnapshot.identity;
    if (!dependencies.sameIdentity(installation.executable.identity, observedExecutableIdentity)) {
        return versionUnavailable(
            installation,
            "antigravity_cli_version_executable_identity_changed",
            executable.path,
            "partial",
            providerExecutableObservationIdentityFailure("binding_before"),
        );
    }
    const knownBuilds = CLI_VERSION_OBSERVATION_ANCHORS.filter(
        (anchor) => anchor.platform === platformContext.platform && anchor.buildIdentity === executableSha256,
    );
    if (knownBuilds.length === 1) {
        return { ...installation, versionText: knownBuilds[0]?.versionText ?? "" };
    }
    if (knownBuilds.length > 1) {
        return versionUnavailable(
            installation,
            "antigravity_cli_version_build_identity_ambiguous",
            executable.path,
            "invalid_schema",
        );
    }
    let result: ProviderLocalExecutableTreeInvocationResult;
    const invocationStartedAt = dependencies.now();
    try {
        result = await dependencies.invokeExecutableTree({
            executablePath: executable.path,
            expectedExecutableIdentity: executableSnapshot.identity,
            arguments: ["--version"],
            workingDirectory: platformContext.accessRootPath,
            environment: CLI_VERSION_ENVIRONMENT,
            environmentVariableNames: CLI_VERSION_ENVIRONMENT_NAMES,
            platformContext,
            hostPlatform,
            timeoutMilliseconds: CLI_VERSION_TIMEOUT_MILLISECONDS,
            maximumOutputBytes: CLI_VERSION_MAXIMUM_OUTPUT_BYTES,
        });
    } catch (error) {
        const observation = providerExecutableObservationFailureFromError("host_invocation", error, {
            elapsedMilliseconds: dependencies.now() - invocationStartedAt,
        });
        return versionUnavailable(
            installation,
            "antigravity_cli_version_host_invocation_failed",
            executable.path,
            "partial",
            observation,
        );
    }
    if (result.executableSha256 !== executableSha256) {
        return versionUnavailable(
            installation,
            "antigravity_cli_version_executable_identity_changed",
            executable.path,
            "partial",
            providerExecutableObservationIdentityFailure("binding_after", {
                elapsedMilliseconds: dependencies.now() - invocationStartedAt,
                stdout: result.stdout,
                stderr: result.stderr,
            }),
        );
    }
    if (result.status !== "complete" || result.exitCode !== 0 || !result.cleanupComplete || !result.invocationTokenAbsent) {
        const observation = providerExecutableObservationFailureFromInvocation(result, {
            elapsedMilliseconds: dependencies.now() - invocationStartedAt,
            stdout: result.stdout,
            stderr: result.stderr,
        });
        return versionUnavailable(
            installation,
            antigravityVersionFailureCode(observation),
            executable.path,
            "partial",
            observation,
        );
    }
    if (result.stderr.byteLength !== 0) {
        return versionUnavailable(
            installation,
            "antigravity_cli_version_output_invalid",
            executable.path,
            "invalid_schema",
            providerExecutableObservationMalformedOutput({
                elapsedMilliseconds: dependencies.now() - invocationStartedAt,
                stdout: result.stdout,
                stderr: result.stderr,
            }),
        );
    }
    const versionText = parseCliVersionOutput(result.stdout);
    return versionText === null
        ? versionUnavailable(
              installation,
              "antigravity_cli_version_output_invalid",
              executable.path,
              "invalid_schema",
              providerExecutableObservationMalformedOutput({
                  elapsedMilliseconds: dependencies.now() - invocationStartedAt,
                  stdout: result.stdout,
                  stderr: result.stderr,
              }),
          )
        : { ...installation, versionText };
}

function antigravityVersionFailureCode(observation: ProviderExecutableObservationFailureReceipt): string {
    if (
        observation.ownerCode.startsWith("observer_") ||
        observation.ownerCode.startsWith("runtime_observation_") ||
        observation.ownerCode === "target_exited_before_observer_ready" ||
        observation.ownerCode === "selected_wsl_invocation_failed" ||
        observation.ownerCode === "worker_protocol"
    ) {
        return `antigravity_cli_version_${observation.ownerCode}`;
    }
    if (observation.failure === "timed_out") {
        return "antigravity_cli_version_observation_timed_out";
    }
    if (observation.failure === "output_limit_exceeded") return "antigravity_cli_version_output_limit_exceeded";
    if (observation.failure === "runtime_root_not_observed") return "antigravity_cli_version_runtime_root_not_observed";
    if (observation.failure === "identity_changed") return "antigravity_cli_version_executable_identity_changed";
    if (observation.failure === "cleanup_incomplete") {
        return "antigravity_cli_version_process_cleanup_incomplete";
    }
    if (observation.failure === "nonzero_exit") return "antigravity_cli_version_process_exit_nonzero";
    if (observation.failure === "host_invocation_failed") return "antigravity_cli_version_host_invocation_failed";
    return "antigravity_cli_version_observation_failed";
}

export async function findAntigravityAppInstallation(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
    installationRootPath?: string,
    overrides: Partial<StructuredInstallationObservationDependencies> = {},
): Promise<InstallationSearch> {
    const plan = planAntigravityAppInstallation(environment, homeDir, platformContext, installationRootPath);
    if (plan === null) return invalidHomeInstallation("app");
    return findAntigravityStructuredInstallation([...plan.roots], plan.discoveryIncomplete, "app", platformContext, {
        ...DEFAULT_STRUCTURED_INSTALLATION_DEPENDENCIES,
        ...overrides,
    });
}

export async function findAntigravityIdeInstallation(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
    installationRootPath?: string,
    overrides: Partial<StructuredInstallationObservationDependencies> = {},
): Promise<InstallationSearch> {
    const plan = planAntigravityIdeInstallation(environment, homeDir, platformContext, installationRootPath);
    if (plan === null) return invalidHomeInstallation("ide");
    return findAntigravityStructuredInstallation([...plan.roots], plan.discoveryIncomplete, "ide", platformContext, {
        ...DEFAULT_STRUCTURED_INSTALLATION_DEPENDENCIES,
        ...overrides,
    });
}

export function appendAntigravityResidualDiagnostic(
    installation: InstallationSearch,
    resource: AdapterProbeResult["observation"]["agentRuntimeResources"][number],
    label: string,
): void {
    if (installation.status !== "not_found" || resource.accessStatus !== "available") return;
    installation.diagnostics.push(
        diagnostic(
            `antigravity_${label.toLowerCase()}_residual_data`,
            `Antigravity ${label} data exists but a verified installation was not found; read-only import remains available`,
            "partial",
            "warning",
            resource.path,
        ),
    );
}

export function antigravityExecutableCandidates(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    name: string,
    platformContext: PlatformContext,
    installationRootPath?: string,
): AntigravityInstallationCandidates {
    const platform = platformContext.platform;
    const homePaths = hostPathApiFor(homeDir);
    if (homePaths === null) return { paths: [], discoveryIncomplete: true };
    if (installationRootPath !== undefined) {
        const candidate = canonicalProviderHostPathWithinAccessRoot(homePaths.join(installationRootPath, name), platformContext);
        return candidate === null ? { paths: [], discoveryIncomplete: true } : { paths: [candidate], discoveryIncomplete: false };
    }
    const runtimePaths = platform === "win32" ? path.win32 : path.posix;
    let discoveryIncomplete = false;
    const candidates = [
        ...(environment.PATH ?? "")
            .split(runtimePaths.delimiter)
            .filter((item) => item !== "")
            .flatMap((item) => {
                const paths = hostPathApiFor(item);
                if (paths !== homePaths) {
                    discoveryIncomplete = true;
                    return [];
                }
                return [paths.join(item, name)];
            }),
        homePaths.join(homeDir, ".local", "bin", name),
    ]
        .map((item) => homePaths.resolve(item))
        .flatMap((item) => {
            const canonical = canonicalProviderHostPathWithinAccessRoot(item, platformContext);
            if (canonical === null) {
                discoveryIncomplete = true;
                return [];
            }
            return [canonical];
        });
    return { paths: uniqueSorted(candidates), discoveryIncomplete };
}

export function planAntigravityAppInstallation(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
    installationRootPath?: string,
): AntigravityStructuredInstallationPlan | null {
    const paths = hostPathApiFor(homeDir);
    if (paths === null) return null;
    const platform = platformContext.platform;
    const executableName = platform === "win32" ? "Antigravity.exe" : "antigravity";
    const executableSearch = antigravityExecutableCandidates(
        environment,
        homeDir,
        executableName,
        platformContext,
        installationRootPath,
    );
    const localAppData = environment.LOCALAPPDATA?.trim() || paths.join(homeDir, "AppData", "Local");
    return {
        roots:
            installationRootPath === undefined
                ? uniqueSorted([
                      ...(platform === "win32" ? [paths.join(localAppData, "Programs", "Antigravity")] : []),
                      paths.join(homeDir, "Antigravity-x64"),
                      paths.join(homeDir, ".local", "Antigravity-x64"),
                      ...executableSearch.paths.map((candidate) => paths.dirname(candidate)),
                  ])
                : [installationRootPath],
        discoveryIncomplete: executableSearch.discoveryIncomplete,
    };
}

export function planAntigravityIdeInstallation(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
    installationRootPath?: string,
): AntigravityStructuredInstallationPlan | null {
    const paths = hostPathApiFor(homeDir);
    if (paths === null) return null;
    const platform = platformContext.platform;
    const executableName = platform === "win32" ? "Antigravity IDE.exe" : "antigravity-ide";
    const executableSearch = antigravityExecutableCandidates(
        environment,
        homeDir,
        executableName,
        platformContext,
        installationRootPath,
    );
    const localAppData = environment.LOCALAPPDATA?.trim() || paths.join(homeDir, "AppData", "Local");
    return {
        roots:
            installationRootPath === undefined
                ? uniqueSorted([
                      ...(platform === "win32" ? [paths.join(localAppData, "Programs", "Antigravity IDE")] : []),
                      paths.join(homeDir, "Antigravity IDE"),
                      paths.join(homeDir, ".local", "Antigravity IDE"),
                      ...(platform === "win32" ? [] : [paths.join(homeDir, ".local", "share", "antigravity-ide")]),
                      ...executableSearch.paths.flatMap((candidate) => {
                          const parent = paths.dirname(candidate);
                          return [parent, paths.dirname(parent)];
                      }),
                  ])
                : [installationRootPath],
        discoveryIncomplete: executableSearch.discoveryIncomplete,
    };
}

function findNativeExecutable(
    candidates: AntigravityInstallationCandidates,
    locatorKey: string,
    platformContext: PlatformContext,
): CliInstallationSearch {
    const platform = platformContext.platform;
    let permissionDenied = false;
    let discoveryIncomplete = candidates.discoveryIncomplete;
    for (const candidate of candidates.paths) {
        try {
            const link = lstatSync(candidate);
            const actual = canonicalProviderHostPathWithinAccessRoot(
                link.isSymbolicLink() ? realpathSync(candidate) : candidate,
                platformContext,
            );
            if (actual === null) {
                discoveryIncomplete = true;
                continue;
            }
            const stat = statSync(actual);
            if (!stat.isFile() || (platform !== "win32" && (stat.mode & 0o111) === 0)) continue;
            if (!isNativeBinary(actual, platform)) continue;
            return availableNativeInstallation(actual, inspectProviderRegularFileNoFollow(actual));
        } catch (error) {
            if (isPermission(error)) permissionDenied = true;
            else if (inspectFilesystemFailure(error).failureKind !== "not_found") discoveryIncomplete = true;
        }
    }
    if (permissionDenied) {
        return {
            status: "needs_permission",
            evidence: [],
            diagnostics: [
                diagnostic(
                    `${locatorKey}_permission`,
                    "An Antigravity executable candidate could not be inspected",
                    "permission_denied",
                    "warning",
                ),
            ],
            versionText: "",
            executable: null,
        };
    }
    if (discoveryIncomplete) {
        return {
            ...incompleteInstallation(
                locatorKey,
                "Antigravity executable discovery was incomplete inside the selected access root",
            ),
            executable: null,
        };
    }
    return {
        status: "not_found",
        evidence: candidates.paths.map((candidate) => ({
            kind: "executable" as const,
            path: candidate,
            evidenceLevel: "local_artifact" as const,
            diagnostics: [],
        })),
        diagnostics: [
            diagnostic(`${locatorKey}_not_found`, "No verified Antigravity executable was found", "not_found", "warning"),
        ],
        versionText: "",
        executable: null,
    };
}

function availableNativeInstallation(
    executablePath: string,
    executableIdentity: ProviderRegularFileIdentity,
): CliInstallationSearch {
    return {
        status: "available",
        evidence: [
            {
                kind: "executable",
                path: executablePath,
                evidenceLevel: "local_artifact",
                diagnostics: [],
            },
        ],
        diagnostics: [],
        versionText: "",
        executable: { path: executablePath, identity: executableIdentity },
    };
}

function incompleteInstallation(locatorKey: string, message: string): InstallationSearch {
    return {
        status: "unknown",
        evidence: [],
        diagnostics: [diagnostic(`${locatorKey}_discovery_incomplete`, message, "partial", "warning")],
        versionText: "",
    };
}

function invalidHomeInstallation(kind: "app" | "ide"): InstallationSearch {
    return {
        status: "unknown",
        evidence: [],
        diagnostics: [
            diagnostic(
                `antigravity_${kind}_home_path_invalid`,
                `Antigravity ${kind} home path is not canonical absolute`,
                "invalid_schema",
                "warning",
            ),
        ],
        versionText: "",
    };
}

function parseCliVersionOutput(bytes: Uint8Array): string | null {
    let output: string;
    try {
        output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
    const match = /^([0-9]+(?:\.[0-9]+){1,15}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]{0,127})?)\r?\n?$/u.exec(output);
    return match?.[1] ?? null;
}

function versionUnavailable<T extends InstallationSearch>(
    installation: T,
    code: string,
    executablePath: string,
    causeKind: "invalid_schema" | "partial",
    observation?: ProviderExecutableObservationFailureReceipt,
): T {
    const operationDiagnostic = diagnostic(
        code,
        "The exact Antigravity CLI version could not be observed without a user profile",
        causeKind,
        "warning",
        executablePath,
    );
    return {
        ...installation,
        versionText: "",
        diagnostics: [
            ...installation.diagnostics,
            observation === undefined
                ? operationDiagnostic
                : {
                      ...operationDiagnostic,
                      retryable: true,
                      suggestedActions: ["retry"],
                      rawSummary: serializeProviderExecutableObservationFailure(observation),
                  },
        ],
    };
}

function isNativeBinary(path: string, platform: Platform): boolean {
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) return false;
        const descriptor = openSync(path, "r");
        try {
            const bytes = Buffer.alloc(4);
            const read = readSync(descriptor, bytes, 0, bytes.length, 0);
            if (read < 2) return false;
            return isNativeBinaryPrefix(bytes, platform);
        } finally {
            closeSync(descriptor);
        }
    } catch {
        return false;
    }
}

function isNativeBinaryPrefix(bytes: Uint8Array, platform: Platform): boolean {
    if (bytes.byteLength < 2) return false;
    if (platform === "linux" || platform === "wsl") {
        return bytes.byteLength >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
    }
    if (platform === "win32") return bytes[0] === 0x4d && bytes[1] === 0x5a;
    if (bytes.byteLength < 4) return false;
    const magic = Buffer.from(bytes.buffer, bytes.byteOffset, 4).readUInt32BE(0);
    return (
        magic === 0xfeedface ||
        magic === 0xfeedfacf ||
        magic === 0xcefaedfe ||
        magic === 0xcffaedfe ||
        magic === 0xcafebabe ||
        magic === 0xcafebabf
    );
}

function isExecutableNativeBinary(path: string, platform: Platform): boolean {
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) return false;
        if (platform !== "win32" && (stat.mode & 0o111) === 0) return false;
        return isNativeBinary(path, platform);
    } catch {
        return false;
    }
}

function regularFile(path: string): boolean {
    try {
        const stat = lstatSync(path);
        return !stat.isSymbolicLink() && stat.isFile();
    } catch {
        return false;
    }
}

function pathExists(path: string): boolean {
    try {
        const stat = lstatSync(path);
        return !stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory());
    } catch {
        return false;
    }
}
