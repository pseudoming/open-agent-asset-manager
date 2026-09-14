/** Codex probe facts for roots and resources. This module never mutates disk. */

import { probeDiagnostic as diagnostic } from "@oaam/adapter-framework";
import type {
    AdapterProbeResult,
    OperationDiagnostic,
    PathLocatorEvidence,
    ResourceAccessStatus,
    RootLocatorKind,
    SourceRoot,
} from "@oaam/core";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";
import * as crypto from "node:crypto";
import { lstatSync } from "node:fs";

export interface ResolvedCodexPath {
    path: string;
    locatorKind: Extract<
        RootLocatorKind,
        "runtime_known_rule" | "runtime_declared_path" | "project_registry_entry" | "user_provided_path"
    >;
    locatorKey: string;
}

export interface PathInspection {
    accessStatus: ResourceAccessStatus;
    diagnostics: OperationDiagnostic[];
}

export { diagnostic };

export function stableCodexId(namespace: string, value: string): string {
    return `${namespace}:${crypto.createHash("sha256").update(`${namespace}\0${value}`, "utf8").digest("hex")}`;
}

export function inspectCodexPath(targetPath: string, expectedKind: "file" | "directory"): PathInspection {
    try {
        const stat = lstatSync(targetPath);
        if (stat.isSymbolicLink()) {
            return {
                accessStatus: "unknown",
                diagnostics: [
                    diagnostic(
                        "codex_probe_symlink_untrusted",
                        "Codex probe found a symlink/reparse source root; Core read authority must resolve it fail-closed",
                        "partial",
                        "warning",
                        targetPath,
                    ),
                ],
            };
        }
        const matches = expectedKind === "file" ? stat.isFile() : stat.isDirectory();
        return matches
            ? { accessStatus: "available", diagnostics: [] }
            : {
                  accessStatus: "unknown",
                  diagnostics: [
                      diagnostic(
                          "codex_probe_resource_kind_mismatch",
                          `Expected a ${expectedKind} at the Codex path`,
                          "invalid_schema",
                          "warning",
                          targetPath,
                      ),
                  ],
              };
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        if (failure.source === "node_errno_error" && (failure.systemCode === "ENOENT" || failure.systemCode === "ENOTDIR")) {
            return { accessStatus: "not_found", diagnostics: [] };
        }
        if (failure.source === "node_errno_error" && failure.failureKind === "permission_denied") {
            return {
                accessStatus: "needs_permission",
                diagnostics: [
                    diagnostic(
                        "codex_probe_permission_denied",
                        "The Codex path could not be inspected because access was denied",
                        "permission_denied",
                        "warning",
                        targetPath,
                    ),
                ],
            };
        }
        return {
            accessStatus: "unknown",
            diagnostics: [
                diagnostic("codex_probe_io_error", "Could not inspect the Codex path", "partial", "warning", targetPath),
            ],
        };
    }
}

export function makeCodexSourceRoot(
    resolved: ResolvedCodexPath,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    evidenceLevel: PathLocatorEvidence["evidenceLevel"],
): SourceRoot {
    const inspection = inspectCodexPath(resolved.path, "directory");
    return {
        sourceRootId: stableCodexId("source-root", `${rootRole}\0${sourceDomain}\0${resolved.path}`),
        rootRole,
        sourceDomain,
        path: resolved.path,
        accessStatus: inspection.accessStatus,
        locatorEvidence: [
            {
                locatorKind: resolved.locatorKind,
                locatorKey: resolved.locatorKey,
                evidenceLevel,
            },
        ],
        diagnostics: inspection.diagnostics,
    };
}

export function makeCodexUserRoot(
    targetPath: string,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    locatorKey: string,
): SourceRoot {
    return makeCodexSourceRoot(
        { path: targetPath, locatorKind: "user_provided_path", locatorKey },
        rootRole,
        sourceDomain,
        "user_provided",
    );
}

export function makeCodexResource(
    resolved: ResolvedCodexPath,
    roles: AdapterProbeResult["observation"]["agentRuntimeResources"][number]["roles"],
): AdapterProbeResult["observation"]["agentRuntimeResources"][number] {
    const inspection = inspectCodexPath(resolved.path, "file");
    return {
        agentRuntimeResourceId: stableCodexId("resource", `${roles.join(",")}\0${resolved.path}`),
        roles,
        path: resolved.path,
        accessStatus: inspection.accessStatus,
        locatorEvidence: [
            {
                locatorKind: resolved.locatorKind,
                locatorKey: resolved.locatorKey,
                evidenceLevel: resolved.locatorKind === "runtime_declared_path" ? "user_provided" : "docs_declared",
            },
        ],
        diagnostics: inspection.diagnostics,
    };
}

export function addCodexSourceRoot(roots: Map<string, SourceRoot>, root: SourceRoot): string {
    roots.set(root.sourceRootId, root);
    return root.sourceRootId;
}

export function uniqueSortedStrings(values: readonly string[]): string[] {
    return [...new Set(values)].sort();
}
