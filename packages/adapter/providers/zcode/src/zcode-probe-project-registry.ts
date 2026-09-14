/** Bounded, read-only projection of ZCode project locations. Task content is never selected. */

import Database from "better-sqlite3";
import { canonicalProviderHostPathWithinAccessRoot, runtimeAbsolutePathToHost } from "@oaam/adapter-framework";
import type { OperationDiagnostic, PlatformContext } from "@oaam/core";
import { inspectFilesystemFailure } from "@oaam/shared/filesystem";
import { diagnostic, stableZcodeId } from "./zcode-probe-foundation";
import { readZcodeProjectRegistrySnapshot, ZcodeRegistrySnapshotError } from "./zcode-probe-project-registry-snapshot";

const MAX_PROJECT_ROWS = 1024;
const MAX_FIELD_BYTES = 4096;
const REQUIRED_COLUMNS = ["workspace_key", "workspace_path", "workspace_identity", "deleted"] as const;

interface ProjectRow {
    workspace_key: unknown;
    workspace_path: unknown;
    workspace_identity: unknown;
}

interface TableColumn {
    name: unknown;
}

export interface ZcodeRegistryProject {
    runtimeProjectKey: string;
    runtimePath: string;
    hostPath: string;
    locatorKey: string;
}

export interface ZcodeProjectRegistryResult {
    status: "complete" | "partial";
    projects: ZcodeRegistryProject[];
    diagnostics: OperationDiagnostic[];
}

export function readZcodeProjectRegistry(registryPath: string, context: PlatformContext): ZcodeProjectRegistryResult {
    let database: Database.Database | null = null;
    try {
        const snapshot = readZcodeProjectRegistrySnapshot(registryPath);
        database = new Database(snapshot);
        database.pragma("query_only = ON");
        const columns = new Set(
            (database.pragma("table_info(tasks)") as TableColumn[]).flatMap((column) =>
                typeof column.name === "string" ? [column.name] : [],
            ),
        );
        if (REQUIRED_COLUMNS.some((column) => !columns.has(column))) {
            return failed(registryPath, "zcode_project_registry_schema_invalid", "ZCode project registry schema is unsupported");
        }
        const rows = database
            .prepare(
                "SELECT DISTINCT workspace_key, workspace_path, workspace_identity " +
                    "FROM tasks WHERE deleted = 0 ORDER BY workspace_key, workspace_path LIMIT ?",
            )
            .all(MAX_PROJECT_ROWS + 1) as ProjectRow[];
        if (rows.length > MAX_PROJECT_ROWS) {
            return failed(
                registryPath,
                "zcode_project_registry_too_large",
                "ZCode project registry exceeds the bounded project limit",
            );
        }
        return materializeRows(rows, registryPath, context);
    } catch (error) {
        if (error instanceof ZcodeRegistrySnapshotError) {
            return failed(registryPath, error.code, error.message, "partial");
        }
        const permissionDenied = inspectFilesystemFailure(error).failureKind === "permission_denied";
        return failed(
            registryPath,
            permissionDenied ? "zcode_project_registry_permission_denied" : "zcode_project_registry_invalid",
            permissionDenied
                ? "ZCode project registry could not be read because access was denied"
                : "ZCode project registry could not be read as a bounded SQLite snapshot",
            permissionDenied ? "permission_denied" : "invalid_schema",
        );
    } finally {
        database?.close();
    }
}

function materializeRows(rows: ProjectRow[], registryPath: string, context: PlatformContext): ZcodeProjectRegistryResult {
    const diagnostics: OperationDiagnostic[] = [];
    const candidates: ZcodeRegistryProject[] = [];
    let partial = false;
    for (const row of rows) {
        if (!validField(row.workspace_key) || !validField(row.workspace_path) || !validOptionalField(row.workspace_identity)) {
            partial = true;
            diagnostics.push(
                diagnostic(
                    "zcode_project_registry_entry_invalid",
                    "A ZCode project registry row has an invalid workspace identity or path",
                    "invalid_schema",
                    "warning",
                    registryPath,
                ),
            );
            continue;
        }
        const hostPath = runtimeAbsolutePathToHost(context.platform, context.accessRootPath, row.workspace_path);
        const canonical = hostPath === null ? null : canonicalProviderHostPathWithinAccessRoot(hostPath, context);
        if (canonical === null) {
            partial = true;
            diagnostics.push(
                diagnostic(
                    "zcode_project_registry_path_unreachable",
                    "A ZCode project path is not canonical inside the selected access root",
                    "partial",
                    "warning",
                    registryPath,
                ),
            );
            continue;
        }
        candidates.push({
            runtimeProjectKey: row.workspace_key,
            runtimePath: row.workspace_path,
            hostPath: canonical,
            locatorKey: stableZcodeId("registry-entry", `${row.workspace_key}\0${row.workspace_identity ?? ""}`),
        });
    }

    const ambiguousKeys = duplicateValues(candidates, (entry) => entry.runtimeProjectKey);
    const ambiguousPaths = duplicateValues(candidates, (entry) => physicalPathKey(entry.hostPath, context.platform));
    if (ambiguousKeys.size > 0 || ambiguousPaths.size > 0) {
        partial = true;
        diagnostics.push(
            diagnostic(
                "zcode_project_registry_identity_ambiguous",
                "ZCode project registry contains conflicting workspace identities or paths",
                "conflict",
                "warning",
                registryPath,
            ),
        );
    }
    const projects = candidates
        .filter(
            (entry) =>
                !ambiguousKeys.has(entry.runtimeProjectKey) &&
                !ambiguousPaths.has(physicalPathKey(entry.hostPath, context.platform)),
        )
        .sort((left, right) => left.hostPath.localeCompare(right.hostPath));
    return { status: partial ? "partial" : "complete", projects, diagnostics };
}

function duplicateValues<T>(items: readonly T[], keyOf: (item: T) => string): Set<string> {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const item of items) {
        const key = keyOf(item);
        if (seen.has(key)) duplicates.add(key);
        else seen.add(key);
    }
    return duplicates;
}

function validField(value: unknown): value is string {
    return (
        typeof value === "string" && value.trim() !== "" && !value.includes("\0") && Buffer.byteLength(value) <= MAX_FIELD_BYTES
    );
}

function validOptionalField(value: unknown): value is string | null {
    return value === null || (typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value) <= MAX_FIELD_BYTES);
}

function physicalPathKey(value: string, platform: PlatformContext["platform"]): string {
    return platform === "win32" ? value.toLowerCase() : value;
}

function failed(
    path: string,
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"] = "invalid_schema",
): ZcodeProjectRegistryResult {
    return { status: "partial", projects: [], diagnostics: [diagnostic(code, message, causeKind, "warning", path)] };
}
