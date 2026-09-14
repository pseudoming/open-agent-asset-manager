/** Shared read-only mechanics for Antigravity probe modules. */

import {
    compareCodeUnitText as compareText,
    probeDiagnostic as diagnostic,
    isPlainRecord as isRecord,
    uniqueSortedStrings as uniqueSorted,
} from "@oaam/adapter-framework";
import type {
    AdapterProbeResult,
    AgentRuntimeId,
    OperationDiagnostic,
    PathLocatorEvidence,
    ResourceAccessStatus,
    SourceRoot,
} from "@oaam/core";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";
import * as crypto from "node:crypto";
import { accessSync, constants, lstatSync } from "node:fs";

export { compareText, diagnostic, isRecord, uniqueSorted };

export const MAX_PROBE_JSON_BYTES = 2 * 1024 * 1024;

interface Inspection {
    accessStatus: ResourceAccessStatus;
    diagnostics: OperationDiagnostic[];
}

export function makeSourceRoot(
    path: string,
    rootRole: SourceRoot["rootRole"],
    sourceDomain: SourceRoot["sourceDomain"],
    expectedKind: "file" | "directory",
    locatorEvidence: PathLocatorEvidence[],
): SourceRoot {
    const inspection = inspectPath(path, expectedKind);
    return {
        sourceRootId: stableId("source-root", `${rootRole}\0${sourceDomain}\0${path}`),
        rootRole,
        sourceDomain,
        path,
        accessStatus: inspection.accessStatus,
        locatorEvidence,
        diagnostics: inspection.diagnostics,
    };
}

export function addSourceRoot(roots: Map<string, SourceRoot>, root: SourceRoot): string {
    const existing = roots.get(root.sourceRootId);
    if (existing === undefined) roots.set(root.sourceRootId, root);
    else {
        existing.locatorEvidence = uniqueLocatorEvidence([...existing.locatorEvidence, ...root.locatorEvidence]);
        existing.diagnostics = [...existing.diagnostics, ...root.diagnostics];
    }
    return root.sourceRootId;
}

export function makeResource(
    path: string,
    roles: AdapterProbeResult["observation"]["agentRuntimeResources"][number]["roles"],
    expectedKind: "file" | "directory",
    locatorEvidence: PathLocatorEvidence[],
): AdapterProbeResult["observation"]["agentRuntimeResources"][number] {
    const inspection = inspectPath(path, expectedKind);
    return {
        agentRuntimeResourceId: stableId("resource", `${roles.join(",")}\0${path}`),
        roles,
        path,
        accessStatus: inspection.accessStatus,
        locatorEvidence,
        diagnostics: inspection.diagnostics,
    };
}

export function unknownRuntime(
    agentRuntimeId: AgentRuntimeId,
    item: OperationDiagnostic,
): AdapterProbeResult["observation"]["observedAgentRuntimes"][number] {
    return {
        agentRuntimeId,
        versionText: "",
        installationEvidence: [],
        sourceRootIds: [],
        agentRuntimeResourceIds: [],
        observedProjectIds: [],
        installationStatus: "unknown",
        projectDiscoveryStatus: "unknown",
        diagnostics: [item],
    };
}

export function knownEvidence(locatorKey: string, evidenceLevel: PathLocatorEvidence["evidenceLevel"]): PathLocatorEvidence[] {
    return [{ locatorKind: "runtime_known_rule", locatorKey, evidenceLevel }];
}

export function runtimeValues(valuesByRuntime: Map<AgentRuntimeId, string[]>, agentRuntimeId: AgentRuntimeId): string[] {
    const values = valuesByRuntime.get(agentRuntimeId);
    if (values === undefined) {
        throw new Error(`Antigravity project evidence references unknown runtime ${agentRuntimeId}`);
    }
    return values;
}

export function ioDiagnostic(code: string, path: string, error: unknown): OperationDiagnostic {
    return diagnostic(
        code,
        error instanceof Error ? error.message : "Antigravity source could not be inspected",
        isPermission(error) ? "permission_denied" : "invalid_schema",
        "warning",
        path,
    );
}

export function stableId(kind: string, value: string): string {
    const digest = crypto.createHash("sha256").update(`${kind}\0${value}`, "utf8").digest("hex");
    return `antigravity-${kind}-${digest}`;
}

export function stringValue(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function isPermission(error: unknown): boolean {
    return inspectFilesystemFailure(error).failureKind === "permission_denied";
}

function inspectPath(path: string, expectedKind: "file" | "directory"): Inspection {
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
            return {
                accessStatus: "unknown",
                diagnostics: [
                    diagnostic(
                        "antigravity_probe_symlink_rejected",
                        "Antigravity discovery roots and resources do not follow symlinks",
                        "unsupported",
                        "warning",
                        path,
                    ),
                ],
            };
        }
        const correctKind = expectedKind === "file" ? stat.isFile() : stat.isDirectory();
        if (!correctKind) {
            return {
                accessStatus: "unknown",
                diagnostics: [
                    diagnostic(
                        "antigravity_probe_path_kind_invalid",
                        `Antigravity discovery expected a ${expectedKind}`,
                        "invalid_schema",
                        "warning",
                        path,
                    ),
                ],
            };
        }
        accessSync(path, constants.R_OK);
        return { accessStatus: "available", diagnostics: [] };
    } catch (error) {
        if (isNotFound(error)) return { accessStatus: "not_found", diagnostics: [] };
        return {
            accessStatus: isPermission(error) ? "needs_permission" : "unknown",
            diagnostics: [ioDiagnostic("antigravity_probe_path_unreadable", path, error)],
        };
    }
}

function uniqueLocatorEvidence(values: PathLocatorEvidence[]): PathLocatorEvidence[] {
    return [...new Map(values.map((item) => [JSON.stringify(item), item])).values()].sort((left, right) =>
        compareText(JSON.stringify(left), JSON.stringify(right)),
    );
}

function isNotFound(error: unknown): boolean {
    const inspection = inspectFilesystemFailure(error);
    return (
        inspection.source === "node_errno_error" && (inspection.systemCode === "ENOENT" || inspection.systemCode === "ENOTDIR")
    );
}
