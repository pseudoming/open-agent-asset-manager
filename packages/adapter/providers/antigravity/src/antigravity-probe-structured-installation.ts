/** Structured Antigravity App and IDE installation observation. */

import { canonicalProviderHostPathWithinAccessRoot, hostPathApiFor } from "@oaam/adapter-framework";
import type { PlatformContext } from "@oaam/core";
import { inspectFilesystemFailure, readRegularFileBounded } from "@oaam/shared/filesystem";
import { diagnostic, isPermission, isRecord, MAX_PROBE_JSON_BYTES, stringValue } from "./antigravity-probe-foundation";
import type { InstallationSearch, StructuredInstallationObservationDependencies } from "./antigravity-probe-installation";

const APP_ASAR_MAXIMUM_BYTES = 8 * 1_024 * 1_024;
const APP_ASAR_MAXIMUM_HEADER_BYTES = 1 * 1_024 * 1_024;
const APP_PACKAGE_JSON_MAXIMUM_BYTES = 64 * 1_024;

export async function findAntigravityStructuredInstallation(
    roots: string[],
    initialDiscoveryIncomplete: boolean,
    kind: "app" | "ide",
    platformContext: PlatformContext,
    dependencies: StructuredInstallationObservationDependencies,
): Promise<InstallationSearch> {
    const platform = platformContext.platform;
    if (platform !== "linux" && platform !== "wsl" && platform !== "win32") {
        return {
            status: "unknown",
            evidence: [],
            diagnostics: [
                diagnostic(
                    `antigravity_${kind}_system_discovery_deferred`,
                    `Antigravity ${kind} system installation discovery is not implemented for ${platform}`,
                    "partial",
                    "warning",
                ),
            ],
            versionText: "",
        };
    }
    let permissionDenied = false;
    let discoveryIncomplete = initialDiscoveryIncomplete;
    const checkedRoots = roots.flatMap((root) => {
        const canonical = canonicalProviderHostPathWithinAccessRoot(root, platformContext);
        if (canonical === null) {
            discoveryIncomplete = true;
            return [];
        }
        return [canonical];
    });
    for (const root of checkedRoots) {
        try {
            const paths = hostPathApiFor(root);
            if (paths === null) continue;
            const executable = paths.join(
                root,
                platform === "win32"
                    ? kind === "app"
                        ? "Antigravity.exe"
                        : "Antigravity IDE.exe"
                    : kind === "app"
                      ? "antigravity"
                      : "antigravity-ide",
            );

            const rootStat = dependencies.lstat(root);
            if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) continue;
            if (!dependencies.isExecutableNativeBinary(executable, platform)) continue;
            if (kind === "app") {
                const appAsar = paths.join(root, "resources", "app.asar");
                if (!dependencies.regularFile(appAsar)) continue;
                const versionText = readAntigravityAppVersion(appAsar, dependencies.readRegularFile);
                const appUpdate = paths.join(root, "resources", "app-update.yml");
                const languageServer = paths.join(
                    root,
                    "resources",
                    "bin",
                    platform === "win32" ? "language_server.exe" : "language_server",
                );
                if (!dependencies.regularFile(appUpdate) || !dependencies.regularFile(languageServer)) {
                    continue;
                }
                const installed = installedRoot(root, executable, versionText ?? "");
                return versionText === null
                    ? {
                          ...installed,
                          diagnostics: [
                              diagnostic(
                                  "antigravity_app_version_metadata_unavailable",
                                  "The Antigravity App installation is readable, but its exact package version could not be validated",
                                  "partial",
                                  "warning",
                                  appAsar,
                              ),
                          ],
                      }
                    : installed;
            }
            const productPath = paths.join(root, "resources", "app", "product.json");
            const product = readJsonRecord(productPath, dependencies.readRegularFile);
            const optional = [
                { path: paths.join(root, "resources", "app", "out", "cli.js"), kind: "file" as const },
                { path: paths.join(root, "resources", "app", "package.json"), kind: "file" as const },
                { path: paths.join(root, "resources", "app", "extensions"), kind: "entry" as const },
            ];
            if (
                product?.applicationName !== "antigravity-ide" ||
                optional.filter((candidate) =>
                    candidate.kind === "file"
                        ? dependencies.regularFile(candidate.path)
                        : dependencies.pathExists(candidate.path),
                ).length < 2
            ) {
                continue;
            }
            return installedRoot(root, executable, stringValue(product.version));
        } catch (error) {
            if (isPermission(error)) permissionDenied = true;
            else if (inspectFilesystemFailure(error).failureKind !== "not_found") {
                discoveryIncomplete = true;
            }
        }
    }
    if (permissionDenied) {
        return {
            status: "needs_permission",
            evidence: [],
            diagnostics: [
                diagnostic(
                    `antigravity_${kind}_install_permission`,
                    `An Antigravity ${kind} install candidate could not be inspected`,
                    "permission_denied",
                    "warning",
                ),
            ],
            versionText: "",
        };
    }
    if (discoveryIncomplete) {
        return incompleteInstallation(
            `antigravity_${kind}_install`,
            `Antigravity ${kind} installation discovery was incomplete inside the selected access root`,
        );
    }
    return {
        status: "not_found",
        evidence: checkedRoots.map((root) => ({
            kind: "install_root" as const,
            path: root,
            evidenceLevel: "local_artifact" as const,
            diagnostics: [],
        })),
        diagnostics: [
            diagnostic(
                `antigravity_${kind}_install_not_found`,
                `No verified Antigravity ${kind} install root was found`,
                "not_found",
                "warning",
            ),
        ],
        versionText: "",
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

function installedRoot(root: string, executable: string, versionText: string): InstallationSearch {
    return {
        status: "available",
        evidence: [
            {
                kind: "install_root",
                path: root,
                evidenceLevel: "local_artifact",
                diagnostics: [],
            },
            {
                kind: "executable",
                path: executable,
                evidenceLevel: "local_artifact",
                diagnostics: [],
            },
        ],
        diagnostics: [],
        versionText,
    };
}

function parseAntigravityAppVersion(bytes: Uint8Array): string | null {
    const archive = Buffer.from(bytes);
    if (archive.length < 16 || archive.readUInt32LE(0) !== 4) return null;
    const headerSize = archive.readUInt32LE(4);
    if (
        headerSize < 8 ||
        headerSize > APP_ASAR_MAXIMUM_HEADER_BYTES ||
        8 + headerSize > archive.length ||
        archive.readUInt32LE(8) !== headerSize - 4
    ) {
        return null;
    }
    const headerStringBytes = archive.readUInt32LE(12);
    if (headerStringBytes === 0 || headerStringBytes > headerSize - 8) return null;
    const headerPadding = archive.subarray(16 + headerStringBytes, 8 + headerSize);
    if (headerPadding.length > 3 || headerPadding.some((byte) => byte !== 0)) return null;

    const header = parseUtf8JsonRecord(archive.subarray(16, 16 + headerStringBytes));
    const packageEntry = isRecord(header?.files) ? header.files["package.json"] : null;
    if (!isRecord(packageEntry) || "files" in packageEntry || "link" in packageEntry || packageEntry.unpacked === true) {
        return null;
    }
    const size = packageEntry.size;
    const offsetText = packageEntry.offset;
    if (
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size > APP_PACKAGE_JSON_MAXIMUM_BYTES ||
        typeof offsetText !== "string" ||
        !/^(?:0|[1-9][0-9]{0,15})$/u.test(offsetText)
    ) {
        return null;
    }
    const offset = Number(offsetText);
    const packageStart = 8 + headerSize + offset;
    if (!Number.isSafeInteger(offset) || packageStart < 8 + headerSize || packageStart + size > archive.length) return null;
    const manifest = parseUtf8JsonRecord(archive.subarray(packageStart, packageStart + size));
    const versionText = stringValue(manifest?.version);
    return manifest?.name === "antigravity" && manifest.productName === "Antigravity" && isVersionText(versionText)
        ? versionText
        : null;
}

function readAntigravityAppVersion(
    archivePath: string,
    readFile: typeof readRegularFileBounded = readRegularFileBounded,
): string | null {
    try {
        return parseAntigravityAppVersion(readFile(archivePath, APP_ASAR_MAXIMUM_BYTES));
    } catch {
        return null;
    }
}

function parseUtf8JsonRecord(bytes: Uint8Array): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
}

function isVersionText(value: string): boolean {
    return /^[0-9]+(?:\.[0-9]+){1,15}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]{0,127})?$/u.test(value);
}

function readJsonRecord(
    path: string,
    readFile: typeof readRegularFileBounded = readRegularFileBounded,
): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(Buffer.from(readFile(path, MAX_PROBE_JSON_BYTES)).toString("utf8"));
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
}
