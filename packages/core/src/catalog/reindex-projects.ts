import { SafeFilesystemError, inventoryDirectoryNoFollow } from "@oaam/shared/filesystem";
import type { Database } from "better-sqlite3";
import type { OperationDiagnostic } from "../types";
import { readProjectManifest } from "./project-authority";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isUuidV4 } from "../foundation/validators";
import { clearProjectIndex, upsertProjectIndex } from "../persistence/state-db";

export interface ProjectReindexReport {
    scannedProjects: number;
    indexedProjects: number;
    skippedProjects: number;
    diagnostics: OperationDiagnostic[];
}

/** Rebuild only the derived project_index from strict project.json authorities. */
export function reindexProjects(projectsRoot: string, db: Database): ProjectReindexReport {
    clearProjectIndex(db);
    let scannedProjects = 0;
    let indexedProjects = 0;
    let skippedProjects = 0;
    const diagnostics: OperationDiagnostic[] = [];
    for (const projectId of inventoryProjectDirectoryNames(projectsRoot)) {
        scannedProjects += 1;
        if (!isUuidV4(projectId)) {
            diagnostics.push(
                projectDiagnostic("reindex.project_id_invalid", "Project authority directory is not a UUID v4", projectId),
            );
            skippedProjects += 1;
            continue;
        }
        try {
            const manifest = readProjectManifest(projectsRoot, projectId);
            if (manifest === null) {
                diagnostics.push(
                    projectDiagnostic("reindex.project_missing", "Project authority does not contain project.json", projectId),
                );
                skippedProjects += 1;
                continue;
            }
            upsertProjectIndex(db, {
                projectId: manifest.projectId,
                rootPath: manifest.rootPath,
                displayName: manifest.displayName,
                deleted: manifest.deleted ? 1 : 0,
                createdAt: manifest.createdAt,
                updatedAt: manifest.updatedAt,
            });
            indexedProjects += 1;
        } catch (error) {
            diagnostics.push(
                projectDiagnostic(
                    "reindex.project_error",
                    `Project authority could not be projected: ${String(error)}`,
                    projectId,
                ),
            );
            skippedProjects += 1;
        }
    }
    return {
        scannedProjects,
        indexedProjects,
        skippedProjects,
        diagnostics,
    };
}

function inventoryProjectDirectoryNames(projectsRoot: string): string[] {
    try {
        return inventoryDirectoryNoFollow(projectsRoot)
            .entries.filter((entry) => entry.identity.entryKind === "directory")
            .map((entry) => entry.relativeName)
            .sort(compareUtf8Bytes);
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "not_found") return [];
        throw error;
    }
}

function projectDiagnostic(code: string, message: string, path: string): OperationDiagnostic {
    return {
        severity: "warning",
        code,
        message,
        path,
        traceId: "",
        operation: "reindex",
        causeKind: "partial",
        retryable: false,
        suggestedActions: [],
        rawSummary: message,
    };
}

/** @internal Exact projection inventory mechanics exposed only to fault tests. */
export const reindexProjectsInternalsForTest = Object.freeze({
    inventoryProjectDirectoryNames,
});
