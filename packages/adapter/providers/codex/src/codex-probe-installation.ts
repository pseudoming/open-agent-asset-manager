/** Native Codex CLI/App installation discovery. Source data alone is never installation evidence. */

import {
    canonicalProviderHostPathWithinAccessRoot,
    hostPathApiFor,
    readProviderRegularFileRangeNoFollow,
    sameProviderRegularFileIdentity,
} from "@oaam/adapter-framework";
import type { InstallationEvidence, OperationDiagnostic, Platform, PlatformContext } from "@oaam/core";
import { inspectFilesystemFailure, readDirectoryEntriesBounded } from "@oaam/shared/filesystem";
import { snapshotPlatformContextRegularFileNoFollowBounded } from "@oaam/shared/paths";
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { diagnostic, uniqueSortedStrings } from "./codex-probe-foundation";
import { findCodexLinuxAppInstallation } from "./codex-probe-linux-app-installation";
import { CODEX_CURRENT_BUILDS } from "./codex-runtime-builds";

export interface CodexInstallationSearch {
    status: "available" | "not_found" | "needs_permission" | "unknown";
    evidence: InstallationEvidence[];
    diagnostics: OperationDiagnostic[];
    versionText: string;
}

interface CandidateSearch {
    paths: string[];
    discoveryIncomplete: boolean;
}

interface CodexCliInstallationDependencies {
    readonly snapshotLocalExecutable: typeof snapshotPlatformContextRegularFileNoFollowBounded;
}

const DEFAULT_CODEX_CLI_INSTALLATION_DEPENDENCIES: CodexCliInstallationDependencies = {
    snapshotLocalExecutable: snapshotPlatformContextRegularFileNoFollowBounded,
};

const MAX_APP_BUILD_ENTRIES = 128;

export async function findCodexCliInstallation(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
    installationRootPath?: string,
): Promise<CodexInstallationSearch> {
    const candidates = cliCandidates(environment, homeDir, platformContext, installationRootPath);
    let discoveryIncomplete = candidates.discoveryIncomplete || false;
    let permissionDenied = false;
    let nonNativeFound = false;

    for (const candidate of candidates.paths) {
        let entryObserved = false;
        try {
            const link = lstatSync(candidate);
            entryObserved = true;
            const actual = canonicalProviderHostPathWithinAccessRoot(
                link.isSymbolicLink() ? realpathSync(candidate) : candidate,
                platformContext,
            );
            if (actual === null) {
                discoveryIncomplete = true;
                continue;
            }
            const stat = link.isSymbolicLink() ? statSync(actual) : link;
            if (!stat.isFile() || (platformContext.platform !== "win32" && (stat.mode & 0o111) === 0)) continue;
            if (!hasNativeBinaryMagic(actual, platformContext.platform)) {
                nonNativeFound = true;
                continue;
            }
            return installedExecutable(actual);
        } catch (error) {
            const failure = inspectFilesystemFailure(error);
            if (
                failure.source === "node_errno_error" &&
                (failure.systemCode === "ENOENT" || failure.systemCode === "ENOTDIR") &&
                !entryObserved
            ) {
                continue;
            }
            if (failure.source === "node_errno_error" && failure.failureKind === "permission_denied") {
                permissionDenied = true;
                continue;
            }
            discoveryIncomplete = true;
        }
    }

    if (permissionDenied) {
        return unavailableInstallation(
            "needs_permission",
            "codex_cli_install_permission_denied",
            "A Codex CLI installation candidate could not be inspected",
            "permission_denied",
            "",
            [],
        );
    }
    if (nonNativeFound) {
        return unavailableInstallation(
            "unknown",
            "codex_cli_launcher_not_native",
            "A codex-named launcher was found but it is not a verified native CLI binary",
            "version_incompatible",
        );
    }
    if (discoveryIncomplete) {
        return unavailableInstallation(
            "unknown",
            "codex_cli_install_discovery_incomplete",
            "Codex CLI discovery was incomplete inside the selected environment",
            "partial",
            "",
            [],
        );
    }
    return checkedNotFound(candidates.paths, "executable");
}

/** Retain the exact selected-WSL build hash already observed by this probe operation. */
export async function retainCodexCliCurrentBuildObservation(
    installation: CodexInstallationSearch,
    platformContext: PlatformContext,
    hostPlatform: NodeJS.Platform = process.platform,
    overrides: Partial<CodexCliInstallationDependencies> = {},
): Promise<CodexInstallationSearch> {
    const localWsl =
        hostPlatform === "linux" && platformContext.platform === "wsl" && platformContext.accessRootPath.startsWith("/");
    if (installation.status !== "available" || !localWsl) return installation;
    const candidates = installation.evidence.filter((evidence) => evidence.kind === "executable");
    if (candidates.length !== 1) return failedCurrentBuildObservation(installation);
    const evidence = candidates[0] as InstallationEvidence;
    if (evidence.currentBuildObservation !== undefined) return installation;
    return retainLocalWslCodexBuild(installation, evidence, platformContext, {
        ...DEFAULT_CODEX_CLI_INSTALLATION_DEPENDENCIES,
        ...overrides,
    });
}

async function retainLocalWslCodexBuild(
    installation: CodexInstallationSearch,
    evidence: InstallationEvidence,
    platformContext: PlatformContext,
    dependencies: CodexCliInstallationDependencies,
): Promise<CodexInstallationSearch> {
    try {
        if (canonicalProviderHostPathWithinAccessRoot(evidence.path, platformContext) !== evidence.path)
            return failedCurrentBuildObservation(installation);
        const before = readProviderRegularFileRangeNoFollow(evidence.path, 0, 4);
        const snapshot = await dependencies.snapshotLocalExecutable(
            { ...platformContext, filePath: evidence.path, maximumBytes: 512 * 1024 * 1024 },
            5_000,
        );
        const after = readProviderRegularFileRangeNoFollow(evidence.path, 0, 4);
        if (
            !hasNativeBinaryMagicBytes(before.bytes, "wsl") ||
            !hasNativeBinaryMagicBytes(after.bytes, "wsl") ||
            !sameProviderRegularFileIdentity(before.identity, snapshot.identity as typeof before.identity) ||
            !sameProviderRegularFileIdentity(after.identity, snapshot.identity as typeof after.identity) ||
            before.totalBytes !== snapshot.byteSize ||
            after.totalBytes !== snapshot.byteSize ||
            !before.executable ||
            !after.executable ||
            !snapshot.executable ||
            snapshot.identity.entryKind !== "file"
        )
            return failedCurrentBuildObservation(installation);
        const buildIdentity = `sha256:${snapshot.sha256Hex}` as const;
        return {
            ...installation,
            evidence: installation.evidence.map((candidate) =>
                candidate === evidence
                    ? {
                          ...candidate,
                          currentBuildObservation: {
                              buildIdentity,
                              byteSize: snapshot.byteSize,
                              executable: snapshot.executable,
                              identity: { ...snapshot.identity, entryKind: "file" },
                          },
                      }
                    : candidate,
            ),
            versionText:
                buildIdentity === CODEX_CURRENT_BUILDS.CODEX_CLI.buildIdentity
                    ? CODEX_CURRENT_BUILDS.CODEX_CLI.versionText
                    : installation.versionText,
        };
    } catch {
        return failedCurrentBuildObservation(installation);
    }
}

/** Keep a found CLI row actionable when this probe could not observe its exact version. */
export function diagnoseMissingCodexCliVersion(installation: CodexInstallationSearch): CodexInstallationSearch {
    if (installation.status !== "available" || installation.versionText.trim() !== "") return installation;
    const executablePaths = installation.evidence
        .filter((evidence) => evidence.kind === "executable")
        .map((evidence) => evidence.path);
    if (executablePaths.length !== 1) return installation;
    const versionDiagnostic = diagnostic(
        "codex_cli_version_not_observed",
        "Codex CLI was found, but this local check could not confirm its current version",
        "partial",
        "warning",
        executablePaths[0],
    );
    return {
        ...installation,
        diagnostics: [
            ...installation.diagnostics,
            {
                ...versionDiagnostic,
                retryable: true,
                suggestedActions: ["retry"],
            },
        ],
    };
}

function failedCurrentBuildObservation(installation: CodexInstallationSearch): CodexInstallationSearch {
    return {
        ...installation,
        status: "unknown",
        diagnostics: [
            ...installation.diagnostics,
            diagnostic(
                "codex_cli_build_observation_failed",
                "The exact Codex CLI build could not be retained for this local check",
                "verification_failed",
                "warning",
            ),
        ],
    };
}

export function findCodexAppInstallation(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
    installationRootPath?: string,
): CodexInstallationSearch {
    if (platformContext.platform === "linux" || platformContext.platform === "wsl") {
        return findCodexLinuxAppInstallation(platformContext, installationRootPath);
    }
    if (platformContext.platform !== "win32") {
        return unavailableInstallation(
            "unknown",
            "codex_app_install_environment_unobserved",
            "Codex App installation is not observable inside this selected environment",
            "partial",
        );
    }
    const paths = hostPathApiFor(homeDir);
    if (paths === null) {
        return unavailableInstallation(
            "unknown",
            "codex_app_home_invalid",
            "Codex App discovery requires a canonical Host-visible home path",
            "invalid_schema",
        );
    }
    const declaredBinRoot = environment.CODEX_APP_BIN_ROOT?.trim();
    const declaredLocalAppData = environment.LOCALAPPDATA?.trim();
    const localAppData = canonicalProviderHostPathWithinAccessRoot(
        declaredLocalAppData && declaredLocalAppData !== "" ? declaredLocalAppData : paths.join(homeDir, "AppData", "Local"),
        platformContext,
    );
    if (localAppData === null || hostPathApiFor(localAppData) !== paths) {
        return unavailableInstallation(
            "unknown",
            "codex_app_local_app_data_invalid",
            "LOCALAPPDATA does not resolve inside the selected Windows access root",
            "invalid_schema",
        );
    }
    const binRoot = canonicalProviderHostPathWithinAccessRoot(
        installationRootPath ??
            (declaredBinRoot && declaredBinRoot !== "" ? declaredBinRoot : paths.join(localAppData, "OpenAI", "Codex", "bin")),
        platformContext,
    );
    if (binRoot === null) {
        return unavailableInstallation(
            "unknown",
            "codex_app_bin_root_invalid",
            "The Codex App binary root falls outside the selected Windows access root",
            "partial",
        );
    }

    try {
        const rootStat = lstatSync(binRoot);
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
            return unavailableInstallation(
                "unknown",
                "codex_app_bin_root_untrusted",
                "The Codex App binary root is not a stable physical directory",
                "invalid_schema",
                binRoot,
            );
        }
        const entries = readDirectoryEntriesBounded(binRoot, MAX_APP_BUILD_ENTRIES);
        const validExecutables: string[] = [];
        let nonNativeFound = false;
        const directExecutable = canonicalProviderHostPathWithinAccessRoot(paths.join(binRoot, "codex.exe"), platformContext);
        if (directExecutable !== null && /^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/u.test(paths.basename(binRoot))) {
            try {
                const stat = lstatSync(directExecutable);
                if (!stat.isSymbolicLink() && stat.isFile()) {
                    if (hasNativeBinaryMagic(directExecutable, "win32")) validExecutables.push(directExecutable);
                    else nonNativeFound = true;
                }
            } catch (error) {
                const failure = inspectFilesystemFailure(error);
                if (
                    !(
                        failure.source === "node_errno_error" &&
                        (failure.systemCode === "ENOENT" || failure.systemCode === "ENOTDIR")
                    )
                ) {
                    if (failure.source === "node_errno_error" && failure.failureKind === "permission_denied") {
                        return unavailableInstallation(
                            "needs_permission",
                            "codex_app_executable_permission_denied",
                            "A Codex App executable candidate could not be inspected",
                            "permission_denied",
                            directExecutable,
                        );
                    }
                    return unavailableInstallation(
                        "unknown",
                        "codex_app_executable_io_error",
                        "A Codex App executable candidate could not be inspected reliably",
                        "partial",
                        directExecutable,
                    );
                }
            }
        }
        for (const entry of entries) {
            if (entry.entryKind !== "directory") continue;
            const executable = canonicalProviderHostPathWithinAccessRoot(
                paths.join(binRoot, entry.name, "codex.exe"),
                platformContext,
            );
            if (executable === null) continue;
            try {
                const stat = lstatSync(executable);
                if (stat.isSymbolicLink() || !stat.isFile()) continue;
                if (hasNativeBinaryMagic(executable, "win32")) validExecutables.push(executable);
                else nonNativeFound = true;
            } catch (error) {
                const failure = inspectFilesystemFailure(error);
                if (
                    failure.source === "node_errno_error" &&
                    (failure.systemCode === "ENOENT" || failure.systemCode === "ENOTDIR")
                ) {
                    continue;
                }
                if (failure.source === "node_errno_error" && failure.failureKind === "permission_denied") {
                    return unavailableInstallation(
                        "needs_permission",
                        "codex_app_executable_permission_denied",
                        "A Codex App executable candidate could not be inspected",
                        "permission_denied",
                        executable,
                    );
                }
                return unavailableInstallation(
                    "unknown",
                    "codex_app_executable_io_error",
                    "A Codex App executable candidate could not be inspected reliably",
                    "partial",
                    executable,
                );
            }
        }
        const selected = uniqueSortedStrings(validExecutables).at(-1);
        if (selected !== undefined) {
            return {
                status: "available",
                evidence: [
                    { kind: "install_root", path: binRoot, evidenceLevel: "local_artifact", diagnostics: [] },
                    { kind: "executable", path: selected, evidenceLevel: "local_artifact", diagnostics: [] },
                ],
                diagnostics: [],
                versionText: "",
            };
        }
        if (nonNativeFound) {
            return unavailableInstallation(
                "unknown",
                "codex_app_executable_not_native",
                "A Codex App executable candidate did not have native Windows binary identity",
                "version_incompatible",
                binRoot,
            );
        }
        return checkedNotFound([binRoot], "install_root");
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        if (failure.source === "node_errno_error" && (failure.systemCode === "ENOENT" || failure.systemCode === "ENOTDIR")) {
            return checkedNotFound([binRoot], "install_root");
        }
        if (failure.source === "node_errno_error" && failure.failureKind === "permission_denied") {
            return unavailableInstallation(
                "needs_permission",
                "codex_app_install_permission_denied",
                "The Codex App installation root could not be inspected",
                "permission_denied",
                binRoot,
            );
        }
        return unavailableInstallation(
            "unknown",
            "codex_app_install_io_error",
            "The Codex App installation root could not be inspected reliably",
            "partial",
            binRoot,
        );
    }
}

function cliCandidates(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    context: PlatformContext,
    installationRootPath?: string,
): CandidateSearch {
    const paths = hostPathApiFor(homeDir);
    if (paths === null) return { paths: [], discoveryIncomplete: true };
    const runtimePaths = context.platform === "win32" ? path.win32 : path.posix;
    const executableName = context.platform === "win32" ? "codex.exe" : "codex";
    let discoveryIncomplete = false;
    const manualCandidate = installationRootPath === undefined ? undefined : paths.join(installationRootPath, executableName);
    if (manualCandidate !== undefined) {
        const canonical = canonicalProviderHostPathWithinAccessRoot(manualCandidate, context);
        return canonical === null ? { paths: [], discoveryIncomplete: true } : { paths: [canonical], discoveryIncomplete: false };
    }
    const candidates: string[] = [paths.join(homeDir, ".local", "bin", executableName)];
    for (const rawEntry of (environment.PATH ?? environment.Path ?? "").split(runtimePaths.delimiter)) {
        if (rawEntry.trim() === "") continue;
        const entryPaths = hostPathApiFor(rawEntry);
        if (entryPaths !== paths) {
            discoveryIncomplete = true;
            continue;
        }
        candidates.push(entryPaths.join(rawEntry, executableName));
    }
    return {
        paths: uniqueSortedStrings(
            candidates.flatMap((candidate) => {
                const canonical = canonicalProviderHostPathWithinAccessRoot(candidate, context);
                if (canonical === null) {
                    discoveryIncomplete = true;
                    return [];
                }
                return [canonical];
            }),
        ),
        discoveryIncomplete,
    };
}

function installedExecutable(executable: string): CodexInstallationSearch {
    return {
        status: "available",
        evidence: [{ kind: "executable", path: executable, evidenceLevel: "local_artifact", diagnostics: [] }],
        diagnostics: [],
        versionText: "",
    };
}

function checkedNotFound(
    paths: readonly string[],
    kind: Extract<InstallationEvidence["kind"], "executable" | "install_root">,
): CodexInstallationSearch {
    return {
        status: "not_found",
        evidence: paths.map((candidate) => ({ kind, path: candidate, evidenceLevel: "local_artifact", diagnostics: [] })),
        diagnostics: [],
        versionText: "",
    };
}

function unavailableInstallation(
    status: "needs_permission" | "unknown",
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"],
    targetPath = "",
    additionalDiagnostics: readonly OperationDiagnostic[] = [],
): CodexInstallationSearch {
    return {
        status,
        evidence: [],
        diagnostics: [diagnostic(code, message, causeKind, "warning", targetPath), ...additionalDiagnostics],
        versionText: "",
    };
}

function hasNativeBinaryMagic(targetPath: string, platform: Platform): boolean {
    const descriptor = openSync(targetPath, "r");
    try {
        const bytes = Buffer.alloc(4);
        const byteCount = readSync(descriptor, bytes, 0, bytes.length, 0);
        return hasNativeBinaryMagicBytes(bytes.subarray(0, byteCount), platform);
    } finally {
        closeSync(descriptor);
    }
}

function hasNativeBinaryMagicBytes(bytes: Uint8Array, platform: Platform): boolean {
    if (platform === "win32") return bytes.byteLength >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a;
    if (bytes.byteLength < 4) return false;
    if (platform === "linux" || platform === "wsl") {
        return bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
    }
    const magic = Buffer.from(bytes.buffer, bytes.byteOffset, 4).readUInt32BE(0);
    return (
        magic === 0xfeedface ||
        magic === 0xfeedfacf ||
        magic === 0xcefaedfe ||
        magic === 0xcffaedfe ||
        magic === 0xcafebabe ||
        magic === 0xbebafeca ||
        magic === 0xcafebabf ||
        magic === 0xbfbafeca
    );
}
