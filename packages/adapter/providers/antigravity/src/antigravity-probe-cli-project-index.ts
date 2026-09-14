/** Only project anchors are queried; the live SQLite database and sidecars are never opened by SQLite. */
import { canonicalProviderHostPathWithinAccessRoot } from "@oaam/adapter-framework";
import type { OperationDiagnostic, PlatformContext } from "@oaam/core";
import { CommittedSqliteSnapshotError, inspectFilesystemFailure, readCommittedSqliteSnapshot } from "@oaam/shared/filesystem";
import Database from "better-sqlite3";
import { diagnostic, stableId } from "./antigravity-probe-foundation";
import type { ProjectRecord } from "./antigravity-probe-projects";
import { canonicalWorkspacePath } from "./antigravity-project-paths";

const MAX_ROWS = 1024;
const MAX_FIELD_BYTES = 64 * 1024;
const MAX_WORKSPACES = 64;

export interface AntigravityCliProjectIndexResult {
    readonly status: "complete" | "partial";
    readonly records: ProjectRecord[];
    readonly diagnostics: OperationDiagnostic[];
}

interface IndexDependencies {
    readonly readSnapshot: typeof readCommittedSqliteSnapshot;
}

export async function readAntigravityCliProjectIndex(
    registryPath: string,
    resourceId: string,
    context: PlatformContext,
    overrides: Partial<IndexDependencies> = {},
): Promise<AntigravityCliProjectIndexResult> {
    const dependencies = {
        readSnapshot: readCommittedSqliteSnapshot,
        ...overrides,
    };
    let database: Database.Database | undefined;
    let snapshot: Buffer | undefined;
    try {
        if (canonicalProviderHostPathWithinAccessRoot(registryPath, context) !== registryPath) {
            return failed(
                registryPath,
                "path_outside_selection",
                "Antigravity CLI project index is outside the selected access root",
                "partial",
            );
        }
        snapshot = dependencies.readSnapshot(registryPath);
        database = new Database(snapshot);
        database.pragma("query_only = ON");
        const columns = new Set(
            (database.pragma("table_info(conversation_summaries)") as Array<{ name: unknown }>).map((column) => column.name),
        );
        if (!columns.has("project_id") || !columns.has("workspace_uris")) {
            return failed(registryPath, "schema_invalid", "Antigravity CLI project index lacks its project-anchor columns");
        }
        const rows = database
            .prepare("SELECT DISTINCT project_id, workspace_uris FROM conversation_summaries LIMIT ?")
            .all(MAX_ROWS + 1) as Array<{ project_id: unknown; workspace_uris: unknown }>;
        if (rows.length > MAX_ROWS)
            return failed(registryPath, "too_large", "Antigravity CLI project index exceeds the bounded anchor limit", "partial");
        const records: ProjectRecord[] = [];
        let invalidRows = 0;
        for (const row of rows) {
            if (!validString(row.project_id) || row.project_id.trim() === "" || !validString(row.workspace_uris)) {
                invalidRows += 1;
                continue;
            }
            // Current local-artifact evidence includes an explicit empty string for runtime-only Project entries.
            if (row.workspace_uris === "") continue;
            let value: unknown;
            try {
                value = JSON.parse(row.workspace_uris);
            } catch {
                invalidRows += 1;
                continue;
            }
            if (!Array.isArray(value) || value.length > MAX_WORKSPACES) {
                invalidRows += 1;
                continue;
            }
            if (value.length === 0) continue;
            const workspaces = value.map((raw) =>
                typeof raw === "string" ? canonicalWorkspacePath(raw, context.platform) : null,
            );
            if (workspaces.some((workspace) => workspace === null)) {
                invalidRows += 1;
                continue;
            }
            const paths = [...new Set(workspaces as string[])];
            const first = paths[0];
            if (first === undefined) continue;
            records.push({
                runtimeProjectKey: row.project_id,
                displayName: "",
                agentRuntimeIds: ["ANTIGRAVITY_CLI"],
                workspaces: paths.map((workspace, index) => ({ path: workspace, role: index === 0 ? "primary" : "additional" })),
                evidence: [
                    {
                        evidenceKind: "agent_runtime_resource",
                        agentRuntimeResourceId: resourceId,
                        locatorKey: stableId("cli-project-anchor", `${row.project_id}\0${JSON.stringify(paths)}`),
                        evidenceLevel: "local_artifact",
                    },
                ],
                diagnostics: [],
            });
        }
        return {
            status: invalidRows === 0 ? "complete" : "partial",
            records,
            diagnostics:
                invalidRows === 0
                    ? []
                    : failed(registryPath, "entry_invalid", "Antigravity CLI project index contains malformed project anchors")
                          .diagnostics,
        };
    } catch (error) {
        const failure = inspectFilesystemFailure(error);
        if (error instanceof CommittedSqliteSnapshotError || failure.systemCode?.startsWith("SQLITE_SNAPSHOT_")) {
            return failed(
                registryPath,
                error instanceof CommittedSqliteSnapshotError ? error.code : (failure.systemCode as string).toLowerCase(),
                "Antigravity CLI committed project snapshot could not be established",
                "partial",
            );
        }
        const permission = failure.failureKind === "permission_denied";
        return failed(
            registryPath,
            permission ? "permission_denied" : "unreadable",
            permission
                ? "Antigravity CLI project index access was denied"
                : "Antigravity CLI project index could not be read as a bounded committed snapshot",
            permission ? "permission_denied" : "invalid_schema",
        );
    } finally {
        database?.close();
        snapshot?.fill(0);
    }
}

function validString(value: unknown): value is string {
    return typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value) <= MAX_FIELD_BYTES;
}

function failed(
    path: string,
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"] = "invalid_schema",
): AntigravityCliProjectIndexResult {
    return {
        status: "partial",
        records: [],
        diagnostics: [diagnostic(`antigravity_cli_project_index_${code}`, message, causeKind, "warning", path)],
    };
}
