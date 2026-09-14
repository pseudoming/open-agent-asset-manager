/** Official Linux App installation; App-managed engine selection is a separate observation. No App/engine is launched. */
import { lstatSync } from "node:fs";
import {
    canonicalProviderHostPathWithinAccessRoot,
    hostPathApiFor,
    readProviderRegularFileRangeNoFollow,
    runtimeAbsolutePathToHost,
    sameProviderRegularFileIdentity,
    probeDiagnostic,
} from "@oaam/adapter-framework";
import type { PlatformContext } from "@oaam/core";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";
import type { ClaudeCodeAppInstallationSearch } from "./claudecode-probe-app-installation";
import { readClaudeLinuxAppVersion } from "./claudecode-probe-linux-app-version";

interface LinuxAppDependencies {
    readonly readVersion: typeof readClaudeLinuxAppVersion;
    readonly readRange: typeof readProviderRegularFileRangeNoFollow;
}

export function findClaudeLinuxAppInstallation(
    context: PlatformContext,
    installationRootPath?: string,
    overrides: Partial<LinuxAppDependencies> = {},
): ClaudeCodeAppInstallationSearch {
    const candidate =
        installationRootPath ?? runtimeAbsolutePathToHost(context.platform, context.accessRootPath, "/usr/lib/claude-desktop");
    const root = candidate === null ? null : canonicalProviderHostPathWithinAccessRoot(candidate, context);
    const paths = root === null ? null : hostPathApiFor(root);
    if (root === null || paths === null)
        return unavailable(
            "unknown",
            "root_outside_selection",
            "The Linux Claude App installation root is outside the selected access root",
        );
    const dependencies = {
        readVersion: readClaudeLinuxAppVersion,
        readRange: readProviderRegularFileRangeNoFollow,
        ...overrides,
    };
    let observed = false;
    try {
        const before = lstatSync(root);
        observed = true;
        if (!before.isDirectory() || before.isSymbolicLink())
            return unavailable("unknown", "bundle_untrusted", "The Claude Linux App bundle must be a physical directory", root);
        const appPath = paths.join(root, "claude-desktop");
        if (!validElf(appPath, dependencies))
            return unavailable("unknown", "binary_unverified", "The Claude Linux App executable could not be verified", appPath);
        const asarPath = paths.join(root, "resources", "app.asar");
        const appVersion = dependencies.readVersion(asarPath);
        if (appVersion === null)
            return unavailable(
                "unknown",
                "metadata_unverified",
                "The selected folder is not a verified Claude Linux App package",
                root,
            );
        const after = lstatSync(root);
        if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            dependencies.readVersion(asarPath) !== appVersion ||
            !validElf(appPath, dependencies)
        )
            return unavailable("unknown", "bundle_changed", "The Claude Linux App installation changed during observation", root);
        // Code's currentTarget is selected by the App's build pin / update state. An installed cache directory
        // or the standalone CLI does not identify that selection; no engine version/path is inferred here.
        return {
            status: "available",
            evidence: [
                { kind: "app_bundle", path: root, evidenceLevel: "local_artifact", diagnostics: [] },
                { kind: "launcher", path: appPath, evidenceLevel: "local_artifact", diagnostics: [] },
            ],
            diagnostics: [],
            appVersionText: appVersion,
            versionText: "",
        };
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        if (!observed && failure.failureKind === "not_found")
            return {
                ...unavailable(
                    "not_found",
                    "not_found",
                    "No Claude Linux App was found in the checked installation folder",
                    root,
                ),
                evidence: [{ kind: "install_root", path: root, evidenceLevel: "local_artifact", diagnostics: [] }],
            };
        return failure.failureKind === "permission_denied"
            ? unavailable(
                  "needs_permission",
                  "permission_denied",
                  "The Claude Linux App installation could not be inspected",
                  root,
              )
            : unavailable("unknown", "bundle_incomplete", "The Claude Linux App bundle could not be completely verified", root);
    }
}

function validElf(filePath: string, dependencies: LinuxAppDependencies): boolean {
    const before = dependencies.readRange(filePath, 0, 4),
        after = dependencies.readRange(filePath, 0, 4);
    const magic = (bytes: Uint8Array) => Buffer.from(bytes).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    return (
        magic(before.bytes) &&
        magic(after.bytes) &&
        before.executable &&
        after.executable &&
        before.totalBytes === after.totalBytes &&
        sameProviderRegularFileIdentity(before.identity, after.identity)
    );
}

function unavailable(
    status: "unknown" | "not_found" | "needs_permission",
    code: string,
    message: string,
    path = "",
): ClaudeCodeAppInstallationSearch {
    return {
        status,
        versionText: "",
        appVersionText: "",
        evidence: [],
        diagnostics: [
            probeDiagnostic(
                `claudecode_app_linux_${code}`,
                message,
                status === "not_found" ? "not_found" : status === "needs_permission" ? "permission_denied" : "partial",
                "warning",
                path,
            ),
        ],
    };
}
