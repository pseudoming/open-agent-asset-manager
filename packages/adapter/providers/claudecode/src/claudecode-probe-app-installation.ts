/** Read-only discovery of the Windows AppX package and its App-owned Code engine. */

import {
    canonicalProviderHostPathWithinAccessRoot,
    probeDiagnostic as diagnostic,
    hostPathApiFor,
    inspectProviderRegularFileNoFollow,
    invokeProviderLocalExecutableTreeBounded,
} from "@oaam/adapter-framework";
import type { InstallationEvidence, OperationDiagnostic, PlatformContext } from "@oaam/core";
import { inspectFilesystemFailure, readDirectoryEntriesBounded, readRegularFileBounded } from "@oaam/shared/filesystem";
import { findClaudeLinuxAppInstallation } from "./claudecode-probe-linux-app-installation";

export interface ClaudeCodeAppInstallationSearch {
    readonly status: "available" | "not_found" | "needs_permission" | "unknown";
    readonly evidence: InstallationEvidence[];
    readonly diagnostics: OperationDiagnostic[];
    /** Exact App-owned Code engine build, not the outer AppX marketing version. */
    readonly versionText: string;
    readonly appVersionText: string;
}

interface SearchRootResult {
    readonly paths: string[];
    readonly failure: "not_found" | "needs_permission" | "unknown" | null;
    readonly diagnostic: OperationDiagnostic | null;
}

interface AppInstallationDependencies {
    readonly readDirectoryEntries: typeof readDirectoryEntriesBounded;
    readonly inspectExecutable: typeof inspectProviderRegularFileNoFollow;
    readonly invokeExecutableTree: typeof invokeProviderLocalExecutableTreeBounded;
    readonly resolvePackageQueryEnvironment: typeof resolveClaudeCodeAppxProcessEnvironmentForTest;
}

interface PackageCandidate {
    readonly path: string;
    readonly versionText: string;
}

interface EngineCandidate {
    readonly rootPath: string;
    readonly executablePath: string;
    readonly versionText: string;
}

const MAX_WINDOWS_APPS_ENTRIES = 512;
const MAX_ENGINE_BUILD_ENTRIES = 128;
const MAX_APPX_MANIFEST_BYTES = 256 * 1024;
const MAX_APPX_QUERY_OUTPUT_BYTES = 256 * 1024;
const MAX_REGISTERED_PACKAGES = 16;
const APPX_QUERY_TIMEOUT_MILLISECONDS = 10_000;
const PACKAGE_NAME = "Claude";
const PACKAGE_PUBLISHER_ID = "pzs8sxrjxfjjc";
const PACKAGE_ARCHITECTURE = "x64";
const EXPECTED_PUBLISHER =
    "CN=&quot;Anthropic, PBC&quot;, O=&quot;Anthropic, PBC&quot;, L=San Francisco, S=California, C=US, SERIALNUMBER=4860621, OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, OID.1.3.6.1.4.1.311.60.2.1.3=US";
const APPX_QUERY_SCRIPT = [
    "$ErrorActionPreference='Stop'",
    "$items=@(Get-AppxPackage -Name 'Claude' -PackageTypeFilter Main | Select-Object Name,PackageFullName,InstallLocation,Version,Architecture,PublisherId,Status)",
    "[Console]::Out.Write((ConvertTo-Json -InputObject $items -Compress -Depth 3))",
].join(";");
const DEFAULT_DEPENDENCIES: AppInstallationDependencies = {
    readDirectoryEntries: readDirectoryEntriesBounded,
    inspectExecutable: inspectProviderRegularFileNoFollow,
    invokeExecutableTree: invokeProviderLocalExecutableTreeBounded,
    resolvePackageQueryEnvironment: resolveClaudeCodeAppxProcessEnvironmentForTest,
};

export async function findClaudeCodeAppInstallation(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
    installationRootPath?: string,
): Promise<ClaudeCodeAppInstallationSearch> {
    return findClaudeCodeAppInstallationForTest(environment, homeDir, platformContext, {}, installationRootPath);
}

/** @internal Dependency seam for hostile installation-discovery tests. */
export async function findClaudeCodeAppInstallationForTest(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
    overrides: Partial<AppInstallationDependencies> = {},
    installationRootPath?: string,
): Promise<ClaudeCodeAppInstallationSearch> {
    const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
    if (platformContext.platform === "linux" || platformContext.platform === "wsl") {
        return findClaudeLinuxAppInstallation(platformContext, installationRootPath);
    }
    if (platformContext.platform !== "win32") {
        return unavailable(
            "unknown",
            "claudecode_app_install_environment_unobserved",
            "Claude Code App installation is not observable inside this selected environment",
            "partial",
        );
    }
    const paths = hostPathApiFor(homeDir);
    if (paths === null) {
        return unavailable(
            "unknown",
            "claudecode_app_home_invalid",
            "Claude Code App discovery requires a canonical Host-visible home path",
            "invalid_schema",
        );
    }
    const localAppData = canonicalProviderHostPathWithinAccessRoot(
        environment.LOCALAPPDATA?.trim() || paths.join(homeDir, "AppData", "Local"),
        platformContext,
    );
    const programFiles = canonicalProviderHostPathWithinAccessRoot(
        environment.ProgramFiles?.trim() || paths.join(platformContext.accessRootPath, "Program Files"),
        platformContext,
    );
    if (localAppData === null || programFiles === null) {
        return unavailable(
            "unknown",
            "claudecode_app_install_root_invalid",
            "Claude Code App installation roots fall outside the selected Windows access root",
            "invalid_schema",
        );
    }
    const windowsAppsRoot = canonicalProviderHostPathWithinAccessRoot(paths.join(programFiles, "WindowsApps"), platformContext);
    const declaredEngineRoot = environment.CLAUDE_CODE_APP_ENGINE_ROOT?.trim();
    const engineRoot = canonicalProviderHostPathWithinAccessRoot(
        declaredEngineRoot && declaredEngineRoot !== ""
            ? declaredEngineRoot
            : paths.join(localAppData, "Claude-3p", "claude-code"),
        platformContext,
    );
    if (windowsAppsRoot === null || engineRoot === null) {
        return unavailable(
            "unknown",
            "claudecode_app_install_root_invalid",
            "Claude Code App package or engine root falls outside the selected Windows access root",
            "invalid_schema",
        );
    }

    let packages = findPackages(windowsAppsRoot, platformContext, dependencies.readDirectoryEntries);
    let engines = findEngines(engineRoot, platformContext, dependencies.readDirectoryEntries);
    if (installationRootPath !== undefined) {
        const selectedRoot = canonicalProviderHostPathWithinAccessRoot(installationRootPath, platformContext);
        if (selectedRoot === null) {
            return unavailable(
                "unknown",
                "claudecode_app_selected_install_root_invalid",
                "The selected Claude App installation folder falls outside the selected Windows access root",
                "invalid_schema",
            );
        }
        const selectedPackages = findSelectedPackages(selectedRoot, platformContext, dependencies.readDirectoryEntries);
        const selectedEngines = findSelectedEngines(selectedRoot, platformContext, dependencies.readDirectoryEntries);
        const selectedFailure = firstFailure(selectedPackages, selectedEngines);
        if (selectedFailure !== null) return selectedFailure;
        if (selectedPackages.paths.length === 0 && selectedEngines.paths.length === 0) {
            return unavailable(
                "unknown",
                "claudecode_app_selected_install_root_unverified",
                "The selected folder is not a verified Claude App package or App-owned Code-engine root",
                "version_incompatible",
            );
        }
        packages = selectedPackages;
        engines = selectedEngines;
    }
    if (packages.failure === "needs_permission") {
        packages = await queryRegisteredPackages(environment, homeDir, platformContext, windowsAppsRoot, dependencies);
    }
    const failed = firstFailure(packages, engines);
    if (failed !== null) return failed;
    if (packages.paths.length === 0 && engines.paths.length === 0) {
        return {
            status: "not_found",
            evidence: [
                { kind: "install_root", path: windowsAppsRoot, evidenceLevel: "local_artifact", diagnostics: [] },
                { kind: "install_root", path: engineRoot, evidenceLevel: "local_artifact", diagnostics: [] },
            ],
            diagnostics: [
                diagnostic(
                    "claudecode_app_executable_not_found",
                    "No exact Claude AppX package or App-owned Code engine was found",
                    "not_found",
                    "warning",
                ),
            ],
            versionText: "",
            appVersionText: "",
        };
    }
    if (packages.paths.length === 0 || engines.paths.length === 0) {
        return unavailable(
            "unknown",
            "claudecode_app_install_incomplete",
            "Claude AppX and its App-owned Code engine were not both present",
            "partial",
        );
    }
    const selectedPackage = selectHighest(packages.paths.map(decodePackageCandidate));
    const selectedEngine = selectHighest(engines.paths.map(decodeEngineCandidate));
    if (selectedPackage === null || selectedEngine === null) {
        return unavailable(
            "unknown",
            "claudecode_app_install_selection_invalid",
            "Claude Code App installation candidates could not be selected deterministically",
            "invalid_schema",
        );
    }
    return {
        status: "available",
        evidence: [
            { kind: "install_root", path: selectedPackage.path, evidenceLevel: "local_artifact", diagnostics: [] },
            { kind: "install_root", path: selectedEngine.rootPath, evidenceLevel: "local_artifact", diagnostics: [] },
            { kind: "executable", path: selectedEngine.executablePath, evidenceLevel: "agent_runtime_verified", diagnostics: [] },
        ],
        diagnostics: [],
        versionText: selectedEngine.versionText,
        appVersionText: selectedPackage.versionText,
    };
}

function findSelectedPackages(
    root: string,
    platformContext: PlatformContext,
    readDirectoryEntries: typeof readDirectoryEntriesBounded,
): SearchRootResult {
    const nested = findPackages(root, platformContext, readDirectoryEntries);
    if (nested.failure !== null) return nested;
    const versionText = /^Claude_(\d+\.\d+\.\d+\.\d+)_x64__pzs8sxrjxfjjc$/u.exec(hostPathApiFor(root)?.basename(root) ?? "")?.[1];
    if (versionText === undefined) return nested;
    try {
        validatePackage(root, versionText, platformContext);
        return { paths: [...new Set([...nested.paths, root])].sort(compareText), failure: null, diagnostic: null };
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        return packageQueryFailure(
            "claudecode_app_selected_package_invalid",
            "The selected Claude App package folder failed exact package validation",
            failure.failureKind === "permission_denied" ? "permission_denied" : "version_incompatible",
            root,
            failure.failureKind === "permission_denied" ? "needs_permission" : "unknown",
        );
    }
}

function findSelectedEngines(
    root: string,
    platformContext: PlatformContext,
    readDirectoryEntries: typeof readDirectoryEntriesBounded,
): SearchRootResult {
    const nested = findEngines(root, platformContext, readDirectoryEntries);
    if (nested.failure !== null) return nested;
    const paths = hostPathApiFor(root);
    const versionText = paths === null ? undefined : /^(\d+\.\d+\.\d+)$/u.exec(paths.basename(root))?.[1];
    if (paths === null || versionText === undefined) return nested;
    const executable = canonicalProviderHostPathWithinAccessRoot(paths.join(root, "claude.exe"), platformContext);
    if (executable === null) {
        return packageQueryFailure(
            "claudecode_app_selected_engine_invalid",
            "The selected Claude App Code-engine folder falls outside the selected access root",
            "invalid_schema",
            root,
        );
    }
    try {
        inspectProviderRegularFileNoFollow(executable);
        return {
            paths: [...new Set([...nested.paths, `${root}\0${executable}`])].sort(compareText),
            failure: null,
            diagnostic: null,
        };
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        return packageQueryFailure(
            "claudecode_app_selected_engine_invalid",
            "The selected Claude App Code-engine folder failed exact executable validation",
            failure.failureKind === "permission_denied" ? "permission_denied" : "version_incompatible",
            root,
            failure.failureKind === "permission_denied" ? "needs_permission" : "unknown",
        );
    }
}

function findPackages(
    root: string,
    platformContext: PlatformContext,
    readDirectoryEntries: typeof readDirectoryEntriesBounded,
): SearchRootResult {
    return inspectSearchRoot(
        root,
        MAX_WINDOWS_APPS_ENTRIES,
        readDirectoryEntries,
        (entryName) => {
            const match = /^Claude_(\d+\.\d+\.\d+\.\d+)_x64__pzs8sxrjxfjjc$/u.exec(entryName);
            if (match === null) return null;
            const paths = hostPathApiFor(root);
            if (paths === null) throw new TypeError("Claude AppX root path grammar is invalid");
            const packageRoot = canonicalProviderHostPathWithinAccessRoot(paths.join(root, entryName), platformContext);
            if (packageRoot === null) throw new Error("Claude AppX candidate escapes the selected access root");
            validatePackage(packageRoot, match[1] ?? "", platformContext);
            return packageRoot;
        },
        "claudecode_app_package_inventory_failed",
        "Claude AppX package inventory could not be inspected safely",
    );
}

function findEngines(
    root: string,
    platformContext: PlatformContext,
    readDirectoryEntries: typeof readDirectoryEntriesBounded,
): SearchRootResult {
    return inspectSearchRoot(
        root,
        MAX_ENGINE_BUILD_ENTRIES,
        readDirectoryEntries,
        (entryName) => {
            if (!/^\d+\.\d+\.\d+$/u.test(entryName)) return null;
            const paths = hostPathApiFor(root);
            if (paths === null) throw new TypeError("Claude App engine root path grammar is invalid");
            const buildRoot = canonicalProviderHostPathWithinAccessRoot(paths.join(root, entryName), platformContext);
            const executable =
                buildRoot === null
                    ? null
                    : canonicalProviderHostPathWithinAccessRoot(paths.join(buildRoot, "claude.exe"), platformContext);
            if (buildRoot === null || executable === null) throw new Error("Claude App engine candidate escapes access root");
            inspectProviderRegularFileNoFollow(executable);
            return `${buildRoot}\0${executable}`;
        },
        "claudecode_app_engine_inventory_failed",
        "Claude App Code-engine inventory could not be inspected safely",
    );
}

function inspectSearchRoot(
    root: string,
    maximumEntries: number,
    readDirectoryEntries: typeof readDirectoryEntriesBounded,
    inspect: (entryName: string) => string | null,
    diagnosticCode: string,
    message: string,
): SearchRootResult {
    try {
        const values: string[] = [];
        for (const entry of readDirectoryEntries(root, maximumEntries)) {
            if (entry.entryKind !== "directory") continue;
            const value = inspect(entry.name);
            if (value !== null) values.push(value);
        }
        return { paths: [...new Set(values)].sort(compareText), failure: null, diagnostic: null };
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        if (failure.failureKind === "not_found") return { paths: [], failure: null, diagnostic: null };
        const status = failure.failureKind === "permission_denied" ? "needs_permission" : "unknown";
        return {
            paths: [],
            failure: status,
            diagnostic: diagnostic(
                diagnosticCode,
                message,
                failure.failureKind === "permission_denied" ? "permission_denied" : "partial",
                "warning",
                root,
            ),
        };
    }
}

async function queryRegisteredPackages(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
    windowsAppsRoot: string,
    dependencies: AppInstallationDependencies,
): Promise<SearchRootResult> {
    const paths = hostPathApiFor(homeDir);
    const systemRoot =
        paths === null
            ? null
            : canonicalProviderHostPathWithinAccessRoot(
                  environment.SystemRoot?.trim() ||
                      environment.WINDIR?.trim() ||
                      paths.join(platformContext.accessRootPath, "Windows"),
                  platformContext,
              );
    const executablePath =
        paths === null || systemRoot === null
            ? null
            : canonicalProviderHostPathWithinAccessRoot(
                  paths.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
                  platformContext,
              );
    if (paths === null || systemRoot === null || executablePath === null) {
        return packageQueryFailure(
            "claudecode_app_package_registration_query_invalid",
            "Claude AppX registration query could not bind the selected Windows system executable",
            "invalid_schema",
            executablePath ?? windowsAppsRoot,
        );
    }
    const processEnvironment = dependencies.resolvePackageQueryEnvironment(environment, systemRoot, platformContext);
    if (processEnvironment === null) {
        return packageQueryFailure(
            "claudecode_app_package_registration_environment_invalid",
            "Claude AppX registration query could not bind a trusted Windows process environment",
            "invalid_schema",
            executablePath,
        );
    }
    try {
        const invocation = await dependencies.invokeExecutableTree({
            executablePath,
            expectedExecutableIdentity: dependencies.inspectExecutable(executablePath),
            arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", APPX_QUERY_SCRIPT],
            workingDirectory: paths.dirname(executablePath),
            environment: processEnvironment,
            environmentVariableNames: [
                "APPDATA",
                "LOCALAPPDATA",
                "ProgramData",
                "PSModulePath",
                "SystemDrive",
                "SystemRoot",
                "TEMP",
                "TMP",
                "USERPROFILE",
                "WINDIR",
            ],
            platformContext,
            timeoutMilliseconds: APPX_QUERY_TIMEOUT_MILLISECONDS,
            maximumOutputBytes: MAX_APPX_QUERY_OUTPUT_BYTES,
        });
        if (
            invocation.status !== "complete" ||
            invocation.exitCode !== 0 ||
            invocation.signal !== null ||
            !invocation.cleanupComplete ||
            !invocation.invocationTokenAbsent
        ) {
            return packageQueryFailure(
                "claudecode_app_package_registration_query_failed",
                "Windows could not return a complete bounded Claude AppX registration query",
                "partial",
                executablePath,
            );
        }
        const text = new TextDecoder("utf-8", { fatal: true })
            .decode(invocation.stdout)
            .replace(/^\uFEFF/u, "")
            .trim();
        return {
            paths: parseRegisteredPackageInventory(text, windowsAppsRoot, platformContext),
            failure: null,
            diagnostic: null,
        };
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        return packageQueryFailure(
            "claudecode_app_package_registration_query_failed",
            "Claude AppX registration could not be inspected through the bounded Windows query",
            failure.failureKind === "permission_denied" ? "permission_denied" : "partial",
            executablePath,
            failure.failureKind === "permission_denied" ? "needs_permission" : "unknown",
        );
    }
}

/** @internal Pure fail-closed projection for the Provider-owned Windows AppX query. */
export function resolveClaudeCodeAppxProcessEnvironmentForTest(
    environment: NodeJS.ProcessEnv,
    trustedSystemRoot: string,
    platformContext: PlatformContext,
): NodeJS.ProcessEnv | null {
    if (platformContext.platform !== "win32") return null;
    const paths = hostPathApiFor(trustedSystemRoot);
    const canonicalSystemRoot = canonicalProviderHostPathWithinAccessRoot(trustedSystemRoot, platformContext);
    if (paths === null || paths.sep !== "\\" || canonicalSystemRoot !== trustedSystemRoot) return null;
    const driveRoot = paths.parse(trustedSystemRoot).root;
    if (!/^[A-Za-z]:\\$/u.test(driveRoot)) return null;
    const systemDrive = driveRoot.slice(0, 2);
    if (!matchesOptionalWindowsValue(environment.SystemDrive, environment.SYSTEMDRIVE, systemDrive, false)) return null;
    if (!matchesOptionalWindowsValue(environment.SystemRoot, environment.SYSTEMROOT, trustedSystemRoot, true)) return null;
    if (!matchesOptionalWindowsValue(environment.WINDIR, undefined, trustedSystemRoot, true)) return null;

    const programDataValue = uniqueEnvironmentValue(environment.ProgramData, environment.PROGRAMDATA);
    if (programDataValue === null || programDataValue === "") return null;
    const programData = canonicalProviderHostPathWithinAccessRoot(programDataValue, platformContext);
    if (
        programData === null ||
        programData !== programDataValue ||
        hostPathApiFor(programData)?.sep !== "\\" ||
        paths.parse(programData).root.toLowerCase() !== driveRoot.toLowerCase()
    ) {
        return null;
    }
    return {
        ...environment,
        ProgramData: programData,
        SystemDrive: systemDrive,
        SystemRoot: trustedSystemRoot,
        WINDIR: trustedSystemRoot,
    };
}

function matchesOptionalWindowsValue(
    first: string | undefined,
    second: string | undefined,
    expected: string,
    absolutePath: boolean,
): boolean {
    const value = uniqueEnvironmentValue(first, second);
    if (value === null) return false;
    if (value === "") return true;
    if (value.toLowerCase() !== expected.toLowerCase()) return false;
    return !absolutePath || hostPathApiFor(value)?.sep === "\\";
}

function uniqueEnvironmentValue(first: string | undefined, second: string | undefined): string | null {
    const firstValue = first?.trim() ?? "";
    const secondValue = second?.trim() ?? "";
    if (firstValue.includes("\0") || secondValue.includes("\0")) return null;
    if (firstValue !== "" && secondValue !== "" && firstValue.toLowerCase() !== secondValue.toLowerCase()) return null;
    return firstValue || secondValue;
}

export function parseRegisteredPackageInventory(
    text: string,
    windowsAppsRoot: string,
    platformContext: PlatformContext,
): string[] {
    const parsed: unknown = text === "" ? [] : JSON.parse(text);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    if (values.length > MAX_REGISTERED_PACKAGES) throw new Error("Claude AppX registration inventory exceeds its bound");
    const paths = hostPathApiFor(windowsAppsRoot);
    if (paths === null) throw new TypeError("Claude AppX registration root path grammar is invalid");
    const candidates: string[] = [];
    for (const value of values) {
        if (!isPlainRecord(value)) throw new Error("Claude AppX registration inventory contains a non-record entry");
        requireExactKeys(value, [
            "Architecture",
            "InstallLocation",
            "Name",
            "PackageFullName",
            "PublisherId",
            "Status",
            "Version",
        ]);
        const packageFullName = requireString(value, "PackageFullName");
        const installLocation = requireString(value, "InstallLocation");
        const versionText = requireString(value, "Version");
        const match = /^Claude_(\d+\.\d+\.\d+\.\d+)_x64__pzs8sxrjxfjjc$/u.exec(packageFullName);
        if (
            requireString(value, "Name") !== PACKAGE_NAME ||
            match === null ||
            match[1] !== versionText ||
            requireString(value, "PublisherId") !== PACKAGE_PUBLISHER_ID ||
            !isExpectedArchitecture(value.Architecture) ||
            !isHealthyPackageStatus(value.Status)
        ) {
            throw new Error("Claude AppX registration identity is not the expected healthy x64 package");
        }
        const packageRoot = canonicalProviderHostPathWithinAccessRoot(installLocation, platformContext);
        if (
            packageRoot === null ||
            comparePath(paths.dirname(packageRoot), windowsAppsRoot, platformContext.platform) !== 0 ||
            comparePath(paths.basename(packageRoot), packageFullName, platformContext.platform) !== 0
        ) {
            throw new Error("Claude AppX registration location is outside the exact WindowsApps package root");
        }
        candidates.push(packageRoot);
    }
    return [...new Set(candidates)].sort(compareText);
}

function packageQueryFailure(
    code: string,
    message: string,
    failureKind: OperationDiagnostic["causeKind"],
    targetPath: string,
    status: SearchRootResult["failure"] = "unknown",
): SearchRootResult {
    return {
        paths: [],
        failure: status,
        diagnostic: diagnostic(code, message, failureKind, "warning", targetPath),
    };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string): string {
    const result = value[key];
    if (typeof result !== "string" || result.trim() === "" || result !== result.trim()) {
        throw new Error(`Claude AppX registration ${key} must be one non-blank string`);
    }
    return result;
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
    const actual = Object.keys(value).sort(compareText);
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new Error("Claude AppX registration inventory has an unexpected schema");
    }
}

function isExpectedArchitecture(value: unknown): boolean {
    return value === 9 || value === "X64" || value === "x64";
}

function isHealthyPackageStatus(value: unknown): boolean {
    return value === 0 || value === "Ok" || value === "OK";
}

function comparePath(left: string, right: string, platform: PlatformContext["platform"]): number {
    const normalizedLeft = platform === "win32" ? left.toLowerCase() : left;
    const normalizedRight = platform === "win32" ? right.toLowerCase() : right;
    return compareText(normalizedLeft, normalizedRight);
}

function validatePackage(packageRoot: string, expectedVersion: string, platformContext: PlatformContext): void {
    const paths = hostPathApiFor(packageRoot);
    if (paths === null) throw new TypeError("Claude AppX package path grammar is invalid");
    const manifestPath = canonicalProviderHostPathWithinAccessRoot(paths.join(packageRoot, "AppxManifest.xml"), platformContext);
    const executablePath = canonicalProviderHostPathWithinAccessRoot(
        paths.join(packageRoot, "app", "Claude.exe"),
        platformContext,
    );
    if (manifestPath === null || executablePath === null) throw new Error("Claude AppX package content escapes access root");
    const manifest = new TextDecoder("utf-8", { fatal: true }).decode(
        readRegularFileBounded(manifestPath, MAX_APPX_MANIFEST_BYTES),
    );
    const identity = parseAppxIdentity(manifest);
    if (
        identity.Name !== PACKAGE_NAME ||
        identity.ProcessorArchitecture !== PACKAGE_ARCHITECTURE ||
        identity.Publisher !== EXPECTED_PUBLISHER ||
        identity.Version !== expectedVersion
    ) {
        throw new Error("Claude AppX identity does not match the expected official package");
    }
    inspectProviderRegularFileNoFollow(executablePath);
}

export function parseAppxIdentity(manifest: string): Readonly<Record<string, string>> {
    const matches = [...manifest.matchAll(/<Identity\b([^>]*)\/>/gu)];
    if (matches.length !== 1) throw new Error("Claude AppX manifest must contain one self-closing Identity element");
    const source = matches[0]?.[1] ?? "";
    const attributes: Record<string, string> = {};
    const expression = /([A-Za-z][A-Za-z0-9]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
    let covered = source;
    for (const match of source.matchAll(expression)) {
        const name = match[1] ?? "";
        const value = match[2] ?? match[3] ?? "";
        if (name in attributes) throw new Error(`duplicate Claude AppX Identity attribute: ${name}`);
        attributes[name] = value;
        covered = covered.replace(match[0], "");
    }
    if (covered.trim() !== "") throw new Error("Claude AppX Identity contains malformed attributes");
    return attributes;
}

function decodePackageCandidate(value: string): PackageCandidate {
    const name = hostPathApiFor(value)?.basename(value) ?? "";
    const versionText = /^Claude_(\d+\.\d+\.\d+\.\d+)_x64__pzs8sxrjxfjjc$/u.exec(name)?.[1] ?? "";
    return { path: value, versionText };
}

function decodeEngineCandidate(value: string): EngineCandidate {
    const separator = value.indexOf("\0");
    const rootPath = separator === -1 ? "" : value.slice(0, separator);
    const executablePath = separator === -1 ? "" : value.slice(separator + 1);
    return {
        rootPath,
        executablePath,
        versionText: hostPathApiFor(rootPath)?.basename(rootPath) ?? "",
    };
}

function selectHighest<T extends { versionText: string }>(candidates: readonly T[]): T | null {
    const valid = candidates.filter((candidate) => parseVersion(candidate.versionText) !== null);
    valid.sort(
        (left, right) => compareVersions(left.versionText, right.versionText) || compareText(stablePath(left), stablePath(right)),
    );
    return valid.at(-1) ?? null;
}

function stablePath(value: object): string {
    return "path" in value ? String(value.path) : "executablePath" in value ? String(value.executablePath) : "";
}

function compareVersions(left: string, right: string): number {
    const leftParts = parseVersion(left) ?? [];
    const rightParts = parseVersion(right) ?? [];
    const maximum = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < maximum; index += 1) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

function parseVersion(value: string): number[] | null {
    if (!/^\d+(?:\.\d+){2,3}$/u.test(value)) return null;
    const parts = value.split(".").map(Number);
    return parts.every((part) => Number.isSafeInteger(part) && part >= 0) ? parts : null;
}

function firstFailure(...results: SearchRootResult[]): ClaudeCodeAppInstallationSearch | null {
    const failed = results.find((result) => result.failure !== null);
    if (failed === undefined || failed.failure === null || failed.diagnostic === null) return null;
    return {
        status: failed.failure,
        evidence: [],
        diagnostics: [failed.diagnostic],
        versionText: "",
        appVersionText: "",
    };
}

function unavailable(
    status: "unknown" | "needs_permission",
    code: string,
    message: string,
    failureKind: OperationDiagnostic["causeKind"],
): ClaudeCodeAppInstallationSearch {
    return {
        status,
        evidence: [],
        diagnostics: [diagnostic(code, message, failureKind, "warning")],
        versionText: "",
        appVersionText: "",
    };
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
