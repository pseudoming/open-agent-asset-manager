/** Native OpenCode Desktop installation discovery. Source data alone is never installation evidence. */

import {
    canonicalProviderHostPathWithinAccessRoot,
    hostPathApiFor,
    runtimeAbsolutePathToHost,
    uniqueSortedStrings,
} from "@oaam/adapter-framework";
import type { InstallationEvidence, OperationDiagnostic, PlatformContext } from "@oaam/core";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";
import { closeSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { readOpencodeAppVersion } from "./opencode-probe-app-asar-version";

export interface OpencodeAppInstallationSearch {
    status: "available" | "not_found" | "needs_permission" | "unknown";
    evidence: InstallationEvidence[];
    diagnostics: OperationDiagnostic[];
    versionText: string;
}

interface InstallationCandidates {
    paths: string[];
    discoveryIncomplete: boolean;
}

type CandidateInspection =
    | { state: "available"; installRoot: string; appArchive: string }
    | { state: "absent" | "needs_permission" | "structure_mismatch" | "unknown" };

type ElectronAwareProcess = NodeJS.Process & { noAsar?: boolean };

export function findOpencodeAppInstallation(
    environment: NodeJS.ProcessEnv,
    homeDir: string,
    platformContext: PlatformContext,
    requireExecutableMode: boolean,
    installationRootPath?: string,
): OpencodeAppInstallationSearch {
    const candidates = appCandidates(environment, homeDir, platformContext, installationRootPath);
    if (candidates.paths.length === 0) {
        return unavailable(
            "unknown",
            "opencode_app_install_rules_unverified",
            "OpenCode Desktop installation paths are not verified for this platform",
            "partial",
        );
    }

    let incomplete = candidates.discoveryIncomplete;
    let permissionDenied = false;
    let structureMismatch = false;
    for (const executable of candidates.paths) {
        const inspection = inspectOpencodeAppCandidate(executable, platformContext.platform === "win32", requireExecutableMode);
        if (inspection.state === "available") {
            const versionText = readOpencodeAppVersion(inspection.appArchive);
            const evidence: InstallationEvidence[] = [
                { kind: "install_root", path: inspection.installRoot, evidenceLevel: "local_artifact", diagnostics: [] },
                { kind: "app_bundle", path: inspection.appArchive, evidenceLevel: "local_artifact", diagnostics: [] },
            ];
            if (versionText === null) {
                return {
                    status: "unknown",
                    evidence,
                    diagnostics: [
                        diagnostic(
                            "opencode_app_version_metadata_unavailable",
                            "The OpenCode Desktop installation is readable, but its exact package version could not be validated",
                            "version_incompatible",
                            "warning",
                            inspection.appArchive,
                        ),
                    ],
                    versionText: "",
                };
            }
            return {
                status: "available",
                evidence,
                diagnostics: [],
                versionText,
            };
        }
        if (inspection.state === "needs_permission") permissionDenied = true;
        else if (inspection.state === "structure_mismatch") structureMismatch = true;
        else if (inspection.state === "unknown") incomplete = true;
    }

    if (permissionDenied) {
        return unavailable(
            "needs_permission",
            "opencode_app_install_permission_denied",
            "An OpenCode Desktop installation candidate could not be inspected",
            "permission_denied",
        );
    }
    if (structureMismatch) {
        return unavailable(
            "unknown",
            "opencode_app_install_structure_unverified",
            "An OpenCode Desktop candidate lacked a verified native executable and physical app archive",
            "version_incompatible",
        );
    }
    if (incomplete) {
        return unavailable(
            "unknown",
            "opencode_app_install_discovery_incomplete",
            "OpenCode Desktop discovery was incomplete inside the selected environment",
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

export function inspectOpencodeAppCandidate(
    executable: string,
    windows: boolean,
    requireExecutableMode: boolean,
): CandidateInspection {
    let executableObserved = false;
    try {
        const executableStat = lstatSync(executable);
        executableObserved = true;
        if (executableStat.isSymbolicLink() || !executableStat.isFile()) return { state: "structure_mismatch" };
        if (requireExecutableMode && (executableStat.mode & 0o111) === 0) return { state: "structure_mismatch" };
        if (!hasNativeMagic(executable, windows)) return { state: "structure_mismatch" };
        const paths = hostPathApiFor(executable);
        if (paths === null) return { state: "unknown" };
        const installRoot = paths.dirname(executable);
        const appArchive = paths.join(installRoot, "resources", "app.asar");
        const archiveStat = lstatPhysicalArchive(appArchive);
        if (archiveStat.isSymbolicLink() || !archiveStat.isFile()) return { state: "structure_mismatch" };
        return { state: "available", installRoot, appArchive };
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
        const executableName = context.platform === "win32" ? "OpenCode.exe" : "ai.opencode.desktop";
        const selected = canonicalProviderHostPathWithinAccessRoot(paths.join(installationRootPath, executableName), context);
        return selected === null ? { paths: [], discoveryIncomplete: true } : { paths: [selected], discoveryIncomplete: false };
    }
    const declaredRoot = environment.OPENCODE_APP_INSTALL_DIR?.trim();
    if (context.platform === "win32") {
        if (declaredRoot) raw.push(paths.join(declaredRoot, "OpenCode.exe"));
        const localAppData = environment.LOCALAPPDATA?.trim() || paths.join(homeDir, "AppData", "Local");
        raw.push(paths.join(localAppData, "Programs", "OpenCode", "OpenCode.exe"));
        for (const key of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] as const) {
            const root = environment[key]?.trim();
            if (root) raw.push(paths.join(root, "OpenCode", "OpenCode.exe"));
        }
    } else if (context.platform === "linux" || context.platform === "wsl") {
        if (declaredRoot) raw.push(paths.join(declaredRoot, "ai.opencode.desktop"));
        const mapped = runtimeAbsolutePathToHost(context.platform, context.accessRootPath, "/opt/OpenCode/ai.opencode.desktop");
        if (mapped === null) discoveryIncomplete = true;
        else raw.push(mapped);
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

/** Electron virtualizes readable `.asar` files as directories; installation evidence needs the physical archive. */
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

function unavailable(
    status: "needs_permission" | "unknown",
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"],
): OpencodeAppInstallationSearch {
    return { status, evidence: [], diagnostics: [diagnostic(code, message, causeKind, "warning", "")], versionText: "" };
}

function diagnostic(
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"],
    severity: OperationDiagnostic["severity"],
    path = "",
): OperationDiagnostic {
    return {
        severity,
        code,
        message,
        path,
        traceId: "",
        operation: "probe",
        causeKind,
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}
