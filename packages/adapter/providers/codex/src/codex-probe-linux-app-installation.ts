/** Exact Linux ChatGPT/Codex App bundle observation; CLI installations are independent. */
import { lstatSync } from "node:fs";
import {
    canonicalProviderHostPathWithinAccessRoot,
    hostPathApiFor,
    readProviderRegularFileRangeNoFollow,
    runtimeAbsolutePathToHost,
    sameProviderRegularFileIdentity,
} from "@oaam/adapter-framework";
import type { PlatformContext } from "@oaam/core";
import { inspectFilesystemFailure, readRegularFileBounded } from "@oaam/shared/filesystem";
import type { CodexInstallationSearch } from "./codex-probe-installation";
import { diagnostic } from "./codex-probe-foundation";

const MAXIMUM_METADATA_BYTES = 64 * 1_024;

interface LinuxAppObservationDependencies {
    readonly readFile: typeof readRegularFileBounded;
    readonly readRange: typeof readProviderRegularFileRangeNoFollow;
}

export function findCodexLinuxAppInstallation(
    context: PlatformContext,
    installationRootPath?: string,
    overrides: Partial<LinuxAppObservationDependencies> = {},
): CodexInstallationSearch {
    const candidate =
        installationRootPath ?? runtimeAbsolutePathToHost(context.platform, context.accessRootPath, "/usr/lib/chatgpt");
    const root = candidate === null ? null : canonicalProviderHostPathWithinAccessRoot(candidate, context);
    const paths = root === null ? null : hostPathApiFor(root);
    if (root === null || paths === null) {
        return unavailable(
            "codex_app_linux_root_outside_selection",
            "The Linux App installation root is outside this selected environment",
        );
    }
    const dependencies = { readFile: readRegularFileBounded, readRange: readProviderRegularFileRangeNoFollow, ...overrides };
    let observedRoot = false;
    try {
        const before = lstatSync(root);
        observedRoot = true;
        if (!before.isDirectory() || before.isSymbolicLink()) {
            return unavailable("codex_app_linux_bundle_untrusted", "The Linux App bundle must be a physical directory", root);
        }
        const metadataPath = paths.join(root, "resources", "linux-package-metadata.json");
        const metadata = dependencies.readFile(metadataPath, MAXIMUM_METADATA_BYTES);
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata));
        if (!validPackageMetadata(value)) {
            return unavailable(
                "codex_app_linux_metadata_unverified",
                "The selected folder is not a verified ChatGPT/Codex Linux package",
                root,
            );
        }
        const appPath = paths.join(root, "ChatGPT");
        const enginePath = paths.join(root, "resources", "codex");
        const binaries = [appPath, enginePath].map((filePath) => ({ filePath, before: dependencies.readRange(filePath, 0, 4) }));
        for (const binary of binaries) {
            const after = dependencies.readRange(binary.filePath, 0, 4);
            if (
                !elfPrefix(binary.before.bytes) ||
                !elfPrefix(after.bytes) ||
                !binary.before.executable ||
                !after.executable ||
                !sameProviderRegularFileIdentity(binary.before.identity, after.identity) ||
                binary.before.totalBytes !== after.totalBytes ||
                binary.before.executable !== after.executable
            ) {
                return unavailable(
                    "codex_app_linux_binary_unverified",
                    "The Linux App or its bundled Codex engine could not be verified",
                    binary.filePath,
                );
            }
        }
        const after = lstatSync(root);
        if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            !Buffer.from(metadata).equals(Buffer.from(dependencies.readFile(metadataPath, MAXIMUM_METADATA_BYTES)))
        ) {
            return unavailable("codex_app_linux_bundle_changed", "The Linux App installation changed during observation", root);
        }
        return {
            status: "available",
            evidence: [
                { kind: "app_bundle", path: root, evidenceLevel: "local_artifact", diagnostics: [] },
                { kind: "executable", path: enginePath, evidenceLevel: "local_artifact", diagnostics: [] },
            ],
            diagnostics: [],
            // Package and shell versions do not identify the embedded agent engine or authorize its loaders.
            versionText: "",
        };
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        if (!observedRoot && failure.failureKind === "not_found") {
            return {
                status: "not_found",
                evidence: [{ kind: "install_root", path: root, evidenceLevel: "local_artifact", diagnostics: [] }],
                diagnostics: [
                    diagnostic(
                        "codex_app_linux_not_found",
                        "No ChatGPT/Codex Linux App was found in the checked installation folder",
                        "not_found",
                        "warning",
                        root,
                    ),
                ],
                versionText: "",
            };
        }
        if (failure.failureKind === "permission_denied") {
            return {
                status: "needs_permission",
                evidence: [],
                versionText: "",
                diagnostics: [
                    diagnostic(
                        "codex_app_linux_permission_denied",
                        "The Linux App installation could not be inspected",
                        "permission_denied",
                        "warning",
                        root,
                    ),
                ],
            };
        }
        return unavailable("codex_app_linux_bundle_incomplete", "The Linux App bundle could not be completely verified", root);
    }
}

function validPackageMetadata(value: unknown): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const metadata = value as Record<string, unknown>;
    return metadata.codexAppBrand === "chatgpt" && typeof metadata.version === "string" && metadata.version.trim().length > 0;
}

function elfPrefix(bytes: Uint8Array): boolean {
    return bytes.byteLength === 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
}

function unavailable(code: string, message: string, targetPath = ""): CodexInstallationSearch {
    return {
        status: "unknown",
        evidence: [],
        versionText: "",
        diagnostics: [diagnostic(code, message, "partial", "warning", targetPath)],
    };
}
