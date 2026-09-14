import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopApplicationClientApi } from "../../client";
import type { ProjectView } from "./project-library-model";

/** Sidebar totals follow catalog changes, never ordinary Project selection. */
export function useProjectAssetCounts(
    client: DesktopApplicationClientApi,
    projects: readonly ProjectView[] | undefined,
    includeDeleted: boolean,
): { readonly counts: ReadonlyMap<string, number>; readonly refreshProject: (projectId: string) => void } {
    const [counts, setCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
    const refreshRef = useRef<(projectId?: string) => void>(() => undefined);
    const refreshProject = useCallback((projectId: string) => refreshRef.current(projectId), []);
    useEffect(() => {
        if (projects === undefined || projects.length === 0 || !client.supportsOperation("asset_library.kind_counts")) {
            setCounts(new Map());
            return;
        }
        let active = true;
        const generations = new Map<string, number>();
        const refresh = (projectId?: string): void => {
            if (!active) return;
            void Promise.all(
                projects
                    .filter((project) => projectId === undefined || project.projectId === projectId)
                    .map(async (project) => {
                        const generation = (generations.get(project.projectId) ?? 0) + 1;
                        generations.set(project.projectId, generation);
                        let count: number | undefined;
                        try {
                            const outcome = await client.listAssetKindCounts({
                                subject: { scope: "project", projectId: project.projectId },
                                keywords: "",
                                includeDeleted,
                            });
                            if (outcome.status !== "failed")
                                count = outcome.value.counts.reduce((total, entry) => total + entry.count, 0);
                        } catch {
                            // A failed observation removes this count; it must not claim zero.
                        }
                        return { projectId: project.projectId, generation, count };
                    }),
            ).then((entries) => {
                if (!active) return;
                setCounts((current) => {
                    const next = new Map(current);
                    for (const entry of entries) {
                        if (entry.generation !== generations.get(entry.projectId)) continue;
                        if (entry.count === undefined) next.delete(entry.projectId);
                        else next.set(entry.projectId, entry.count);
                    }
                    return next;
                });
            });
        };
        setCounts(new Map());
        refreshRef.current = refresh;
        refresh();
        const unsubscribe = client.subscribeInvalidation((invalidation) => {
            if (
                invalidation.resourceKind === "project" ||
                invalidation.resourceKind === "asset" ||
                (invalidation.resourceKind === "collection" &&
                    (invalidation.collection === "projects" || invalidation.collection === "assets"))
            ) {
                refresh();
            }
        });
        return () => {
            active = false;
            refreshRef.current = () => undefined;
            unsubscribe();
        };
    }, [client, includeDeleted, projects]);
    return { counts, refreshProject };
}
