/** Native ZCode App installation discovery. Source data alone is never installation evidence. */

import {
    canonicalProviderHostPathWithinAccessRoot,
    hostPathApiFor,
    readProviderRegularFileRangeNoFollow,
    runtimeAbsolutePathToHost,
    sameProviderRegularFileIdentity,
} from "@oaam/adapter-framework";
import type { InstallationEvidence, OperationDiagnostic, PlatformContext } from "@oaam/core";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";
import { closeSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { readZcodeAppVersion } from "./zcode-probe-app-asar-version";
import { diagnostic, uniqueSortedStrings } from "./zcode-probe-foundation";

export interface ZcodeInstallationSearch {
    status: "available" | "not_found" | "needs_permission" | "unknown";
    evidence: InstallationEvidence[];
    diagnostics: OperationDiagnostic[];
    versionText: string;
}

type CandidateInspection =
    | { state: "available"; installRoot: string }
    | { state: "absent" | "needs_permission" | "structure_mismatch" | "unknown" };

interface InstallationCandidates {
    paths: string[];
    discoveryIncomplete: boolean;
}

type ElectronAwareProcess = NodeJS.Process & { noAsar?: boolean };
const MAX_DESKTOP_ENTRY_BYTES = 64 * 1024;

export function findZcodeAppInstallation(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
    installationRootPath?: string,
): ZcodeInstallationSearch {
    const candidates = appCandidates(environment, homeDir, platformContext, installationRootPath);
    if (candidates.paths.length === 0) {
        return unavailable(
            "unknown",
            "zcode_app_install_rules_unverified",
            "ZCode App installation paths are not verified for this platform",
            "partial",
        );
    }

    let incomplete = candidates.discoveryIncomplete;
    let permissionDenied = false;
    let structureMismatch = false;
    for (const executable of candidates.paths) {
        const inspection = inspectZcodeAppCandidate(executable, platformContext.platform === "win32");
        if (inspection.state === "available") {
            const consumerBundlePath = findConsumerBundlePath(inspection.installRoot);
            const paths = hostPathApiFor(inspection.installRoot);
            const appAsarPath = paths?.join(inspection.installRoot, "resources", "app.asar") ?? "";
            const versionText = appAsarPath === "" ? null : readZcodeAppVersion(appAsarPath);
            return {
                status: "available",
                evidence: [
                    { kind: "install_root", path: inspection.installRoot, evidenceLevel: "local_artifact", diagnostics: [] },
                    ...(consumerBundlePath === null
                        ? []
                        : [
                              {
                                  kind: "app_bundle" as const,
                                  path: consumerBundlePath,
                                  evidenceLevel: "local_artifact" as const,
                                  diagnostics: [],
                              },
                          ]),
                ],
                diagnostics:
                    versionText === null
                        ? [
                              diagnostic(
                                  "zcode_app_version_metadata_unavailable",
                                  "The ZCode App installation is readable, but its exact package version could not be validated",
                                  "partial",
                                  "warning",
                                  appAsarPath,
                              ),
                          ]
                        : [],
                versionText: versionText ?? "",
            };
        }
        if (inspection.state === "needs_permission") permissionDenied = true;
        else if (inspection.state === "structure_mismatch") structureMismatch = true;
        else if (inspection.state === "unknown") incomplete = true;
    }

    if (permissionDenied) {
        return unavailable(
            "needs_permission",
            "zcode_app_install_permission_denied",
            "A ZCode App installation candidate could not be inspected",
            "permission_denied",
        );
    }
    if (structureMismatch) {
        return unavailable(
            "unknown",
            "zcode_app_install_structure_unverified",
            "A ZCode-named App candidate lacked verified native binary and app bundle structure",
            "version_incompatible",
        );
    }
    if (incomplete) {
        return unavailable(
            "unknown",
            "zcode_app_install_discovery_incomplete",
            "ZCode App installation discovery was incomplete inside the selected environment",
            "partial",
        );
    }
    return {
        status: "not_found",
        evidence: candidates.paths.map((candidate) => ({
            kind: "executable",
            path: candidate,
            evidenceLevel: "local_artifact",
            diagnostics: [],
        })),
        diagnostics: [],
        versionText: "",
    };
}

function findConsumerBundlePath(installRoot: string): string | null {
    const paths = hostPathApiFor(installRoot);
    if (paths === null) return null;
    const consumerBundlePath = paths.join(installRoot, "resources", "glm", "zcode.cjs");
    try {
        const stat = lstatSync(consumerBundlePath);
        return !stat.isSymbolicLink() && stat.isFile() ? consumerBundlePath : null;
    } catch {
        return null;
    }
}

export function inspectZcodeAppCandidate(executable: string, windows: boolean): CandidateInspection {
    let executableObserved = false;
    try {
        const executableStat = lstatSync(executable);
        executableObserved = true;
        if (executableStat.isSymbolicLink() || !executableStat.isFile()) return { state: "structure_mismatch" };
        if (!windows && (executableStat.mode & 0o111) === 0) return { state: "structure_mismatch" };
        if (!hasNativeMagic(executable, windows)) return { state: "structure_mismatch" };
        const paths = hostPathApiFor(executable);
        if (paths === null) return { state: "unknown" };
        const installRoot = paths.dirname(executable);
        const archiveStat = lstatPhysicalArchive(paths.join(installRoot, "resources", "app.asar"));
        if (archiveStat.isSymbolicLink() || !archiveStat.isFile()) return { state: "structure_mismatch" };
        return { state: "available", installRoot };
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        if (failure.source === "node_errno_error" && (failure.systemCode === "ENOENT" || failure.systemCode === "ENOTDIR")) {
            return { state: executableObserved ? "structure_mismatch" : "absent" };
        }
        if (failure.source === "node_errno_error" && failure.failureKind === "permission_denied") {
            return { state: "needs_permission" };
        }
        return { state: "unknown" };
    }
}

/** Electron virtualizes every readable `.asar` as a directory; installation evidence needs the physical archive. */
function lstatPhysicalArchive(targetPath: string): Stats {
    const currentProcess = process as ElectronAwareProcess;
    if (currentProcess.versions.electron === undefined) return lstatSync(targetPath);
    const previousNoAsar = currentProcess.noAsar;
    currentProcess.noAsar = true;
    try {
        return lstatSync(targetPath);
    } finally {
        currentProcess.noAsar = previousNoAsar;
    }
}

function appCandidates(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    context: PlatformContext,
    installationRootPath?: string,
): InstallationCandidates {
    const paths = hostPathApiFor(homeDir);
    if (paths === null) return { paths: [], discoveryIncomplete: true };
    const raw: string[] = [];
    let discoveryIncomplete = false;
    if (installationRootPath !== undefined) {
        const selected = canonicalProviderHostPathWithinAccessRoot(
            paths.join(installationRootPath, context.platform === "win32" ? "ZCode.exe" : "zcode"),
            context,
        );
        return selected === null ? { paths: [], discoveryIncomplete: true } : { paths: [selected], discoveryIncomplete: false };
    }
    if (context.platform === "win32") {
        const declaredRoot = environment.ZCODE_WINDOWS_APP_INSTALL_DIR?.trim();
        if (declaredRoot) raw.push(paths.join(declaredRoot, "ZCode.exe"));
        const localAppData = environment.LOCALAPPDATA?.trim() || paths.join(homeDir, "AppData", "Local");
        raw.push(paths.join(localAppData, "Programs", "ZCode", "ZCode.exe"));
        for (const key of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] as const) {
            const root = environment[key]?.trim();
            if (root) raw.push(paths.join(root, "ZCode", "ZCode.exe"));
        }
    } else if (context.platform === "linux" || context.platform === "wsl") {
        const mapped = runtimeAbsolutePathToHost(context.platform, context.accessRootPath, "/opt/ZCode/zcode");
        if (mapped === null) discoveryIncomplete = true;
        else raw.push(mapped);
        const registrations = [
            paths.join(homeDir, ".local", "share", "applications", "zcode.desktop"),
            runtimeAbsolutePathToHost(context.platform, context.accessRootPath, "/usr/share/applications/zcode.desktop"),
        ];
        for (const registration of registrations) {
            if (registration === null) {
                discoveryIncomplete = true;
                continue;
            }
            const registered = readRegisteredZcodeExecutable(registration, context);
            if (registered.status === "invalid") discoveryIncomplete = true;
            else if (registered.status === "available") raw.push(registered.path);
        }
    } else {
        return { paths: [], discoveryIncomplete: true };
    }
    return {
        paths: uniqueSortedStrings(
            raw.flatMap((candidate) => {
                const canonical = canonicalProviderHostPathWithinAccessRoot(candidate, context);
                if (canonical !== null) return [canonical];
                discoveryIncomplete = true;
                return [];
            }),
        ),
        discoveryIncomplete,
    };
}

function readRegisteredZcodeExecutable(
    desktopEntryPath: string,
    context: PlatformContext,
): { readonly status: "absent" | "invalid" } | { readonly status: "available"; readonly path: string } {
    try {
        const first = readProviderRegularFileRangeNoFollow(desktopEntryPath, 0, MAX_DESKTOP_ENTRY_BYTES + 1);
        if (first.totalBytes > MAX_DESKTOP_ENTRY_BYTES) return { status: "invalid" };
        const second = readProviderRegularFileRangeNoFollow(desktopEntryPath, 0, first.totalBytes);
        if (!sameProviderRegularFileIdentity(first.identity, second.identity)) return { status: "invalid" };
        const text = Buffer.from(second.bytes).toString("utf8");
        const lines = text.split(/\r?\n/u);
        const sectionStart = lines.findIndex((line) => line.trim() === "[Desktop Entry]");
        if (sectionStart < 0) return { status: "invalid" };
        const sectionEnd = lines.findIndex((line, index) => index > sectionStart && /^\s*\[/u.test(line));
        const desktopSection = lines.slice(sectionStart + 1, sectionEnd < 0 ? undefined : sectionEnd);
        if (!desktopSection.some((line) => line.trim() === "Type=Application")) return { status: "invalid" };
        if (!desktopSection.some((line) => line.trim() === "Name=ZCode")) return { status: "invalid" };
        const rawExec = desktopSection
            .find((line) => line.startsWith("Exec="))
            ?.slice("Exec=".length)
            .trim();
        if (rawExec === undefined) return { status: "invalid" };
        const executable = desktopExecutableToken(rawExec);
        if (executable === null || !executable.startsWith("/")) return { status: "invalid" };
        const mapped = runtimeAbsolutePathToHost(context.platform, context.accessRootPath, executable);
        const canonical = mapped === null ? null : canonicalProviderHostPathWithinAccessRoot(mapped, context);
        return canonical === null ? { status: "invalid" } : { status: "available", path: canonical };
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        return failure.failureKind === "not_found" || (failure.source === "node_errno_error" && failure.systemCode === "ENOTDIR")
            ? { status: "absent" }
            : { status: "invalid" };
    }
}

function desktopExecutableToken(rawExec: string): string | null {
    if (rawExec.startsWith('"')) {
        const closingQuote = rawExec.indexOf('"', 1);
        if (closingQuote <= 1 || rawExec.slice(1, closingQuote).includes("\\")) return null;
        return rawExec.slice(1, closingQuote);
    }
    const token = rawExec.split(/\s/u, 1)[0];
    return token === undefined || token.includes("\\") ? null : token;
}

function unavailable(
    status: "needs_permission" | "unknown",
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"],
): ZcodeInstallationSearch {
    return {
        status,
        evidence: [],
        diagnostics: [diagnostic(code, message, causeKind, "warning", "")],
        versionText: "",
    };
}

function hasNativeMagic(targetPath: string, windows: boolean): boolean {
    const descriptor = openSync(targetPath, "r");
    try {
        const bytes = Buffer.alloc(4);
        const count = readSync(descriptor, bytes, 0, bytes.length, 0);
        if (windows) return count >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a;
        return count === 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
    } finally {
        closeSync(descriptor);
    }
}
