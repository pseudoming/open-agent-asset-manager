import type { ProbeResult } from "@oaam/core";
import { physicalAccessPathContains } from "@oaam/shared/paths";
import { projectDiagnostic } from "./core-outcome";

/** Project identity stays on exact workspace rows; containment only scopes projected source review. */
export function projectProbeProjectRows(result: ProbeResult, sourceRowIds: readonly string[], projectRowIds: readonly string[]) {
    return result.observation.observedProjects.map((project, projectIndex) => {
        const workspaceRoots = project.workspaces.map((workspace) => {
            const sourceIndex = result.observation.sourceRoots.findIndex(
                (source) => source.sourceRootId === workspace.sourceRootId,
            );
            const source = result.observation.sourceRoots[sourceIndex];
            const rowId = sourceRowIds[sourceIndex];
            if (source === undefined || rowId === undefined) {
                throw new TypeError("Observed project references an unknown source root");
            }
            return { source, rowId };
        });
        return {
            rowId: projectRowIds[projectIndex] as string,
            observedProjectId: project.observedProjectId,
            displayName: project.displayName,
            workspaceSourceRowIds: workspaceRoots.map((workspace) => workspace.rowId),
            containedSourceRootRowIds: result.observation.sourceRoots.flatMap((source, sourceIndex) =>
                workspaceRoots.some(
                    (workspace) =>
                        workspace.source.sourceRootId === source.sourceRootId ||
                        physicalAccessPathContains(workspace.source.path, source.path),
                )
                    ? [sourceRowIds[sourceIndex] as string]
                    : [],
            ),
            diagnostics: project.diagnostics.map(projectDiagnostic),
        };
    });
}
