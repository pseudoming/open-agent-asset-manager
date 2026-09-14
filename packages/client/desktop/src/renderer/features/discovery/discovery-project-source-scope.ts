import type { DiscoverySourceClaimGroup, ProbeReviewView, ProjectListView } from "./discovery-model";

function isProjectSourceGroup(group: DiscoverySourceClaimGroup): boolean {
    return group.claims.some(
        ({ source }) =>
            source.rootRole === "project_actual" ||
            source.sourceDomain === "project_root" ||
            source.sourceDomain === "project_keyed",
    );
}

/**
 * Join a presentation source group to one registered Project without interpreting paths in the browser.
 *
 * The Host uses Shared's canonical path mechanics to produce `containedSourceRootRowIds`.
 * Exact workspace rows still establish Project identity; contained rows only scope this probe review.
 */
export function discoverySourceGroupBelongsToRegisteredProject(
    group: DiscoverySourceClaimGroup,
    probe: ProbeReviewView,
    project: ProjectListView["projects"][number],
): boolean {
    if (project.deleted || !isProjectSourceGroup(group)) return false;
    return group.claims.some(({ source }) => {
        const selection = source.readSelection;
        if (selection.status !== "selectable") return false;
        const result = probe.results.find((candidate) => candidate.rowId === selection.probeResultRowId);
        if (result === undefined) return false;
        const matchingProjectRows = result.projects.filter((projectRow) =>
            projectRow.workspaceSourceRowIds.some((sourceRootRowId) =>
                result.sources.some(
                    (sourceRow) => sourceRow.rowId === sourceRootRowId && sourceRow.displayPath === project.rootPath,
                ),
            ),
        );
        return (
            matchingProjectRows.length === 1 &&
            matchingProjectRows[0]?.containedSourceRootRowIds.includes(selection.sourceRootRowId) === true
        );
    });
}
