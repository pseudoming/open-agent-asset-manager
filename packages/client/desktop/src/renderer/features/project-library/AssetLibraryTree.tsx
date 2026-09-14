import { projectDisplayName } from "../../presentation/project-label";
import type { WorkbenchLibraryCollectionRoute, WorkbenchLibraryRoute } from "../../app/workbench-navigation";
import { useDesktopPresentation } from "../../presentation";
import { DesktopIcon, WorkbenchIconButton, WorkbenchTooltipButton } from "../../ui";
import type { AssetBrowserCollectionState } from "./asset-browser-controller";
import { ASSET_KIND_HELP_MESSAGE_IDS, ASSET_KIND_MESSAGE_IDS, type ProjectView } from "./project-library-model";

export interface AssetLibraryTreeProps {
    readonly projects: readonly ProjectView[];
    readonly projectTotalCounts: ReadonlyMap<string, number>;
    readonly selectedProjectId: string | undefined;
    readonly route: WorkbenchLibraryRoute;
    readonly projectCollection: AssetBrowserCollectionState | undefined;
    readonly globalCollection: AssetBrowserCollectionState | undefined;
    readonly canAddProject: boolean;
    readonly addingProject: boolean;
    readonly canManageProjects: boolean;
    readonly onAddProject: () => void;
    readonly onManageProject: (project: ProjectView) => void;
    readonly onSelectProject: (projectId: string) => void;
    readonly onSelectRoute: (route: WorkbenchLibraryRoute) => void;
}

function collectionRoute(route: WorkbenchLibraryRoute): WorkbenchLibraryCollectionRoute | undefined {
    if (route.subject === "global") return { surface: "library", subject: "global", collection: "global" };
    if (route.projectId === undefined) return undefined;
    return {
        surface: "library",
        subject: "projects",
        projectId: route.projectId,
        collection: "project",
    };
}

function KindBranches({
    route,
    collection,
    onSelectRoute,
}: {
    readonly route: WorkbenchLibraryRoute;
    readonly collection: AssetBrowserCollectionState;
    readonly onSelectRoute: (route: WorkbenchLibraryRoute) => void;
}): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const baseRoute = collectionRoute(route);
    return (
        <ul className="asset-tree-kinds">
            {baseRoute === undefined
                ? null
                : collection.kinds
                      .filter((kind) => kind.totalCount > 0)
                      .map((kind) => (
                          <li key={kind.kind}>
                              <WorkbenchTooltipButton
                                  data-oaam-interaction-entry="features.project-library.asset_library_tree.001"
                                  className="asset-tree-kind"
                                  tooltip={text(ASSET_KIND_HELP_MESSAGE_IDS[kind.kind])}
                                  aria-current={route.kind === kind.kind ? "page" : undefined}
                                  onClick={() => onSelectRoute({ ...baseRoute, kind: kind.kind })}
                              >
                                  <span>{text(ASSET_KIND_MESSAGE_IDS[kind.kind])}</span>
                                  <small>{kind.totalCount}</small>
                              </WorkbenchTooltipButton>
                          </li>
                      ))}
        </ul>
    );
}

export function AssetLibraryTree({
    projects,
    projectTotalCounts,
    selectedProjectId,
    route,
    projectCollection,
    globalCollection,
    canAddProject,
    addingProject,
    canManageProjects,
    onAddProject,
    onManageProject,
    onSelectProject,
    onSelectRoute,
}: AssetLibraryTreeProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    if (route.subject === "global") {
        const globalRoute = globalCollection === undefined ? undefined : collectionRoute(route);
        return (
            <nav className="asset-tree" aria-label={text("library.tree.label")}>
                <div className="asset-tree-section-header asset-tree-global-row">
                    <WorkbenchTooltipButton
                        data-oaam-interaction-entry="features.project-library.asset_library_tree.002"
                        className="asset-tree-global"
                        tooltip={text("library.global.help")}
                        aria-current={route.kind === undefined ? "page" : undefined}
                        disabled={globalRoute === undefined}
                        onClick={() => {
                            if (globalRoute !== undefined) onSelectRoute(globalRoute);
                        }}
                    >
                        <span className="asset-tree-global-label">
                            <span>{text("library.tree.global_assets")}</span>
                            <small>{globalCollection?.totalCount ?? 0}</small>
                        </span>
                    </WorkbenchTooltipButton>
                </div>
                {globalCollection === undefined ? null : (
                    <KindBranches route={route} collection={globalCollection} onSelectRoute={onSelectRoute} />
                )}
            </nav>
        );
    }
    return (
        <nav className="asset-tree" aria-label={text("library.tree.label")}>
            <div className="asset-tree-section-header">
                <span>{text("library.tree.projects")}</span>
                {canAddProject ? (
                    <WorkbenchIconButton
                        data-oaam-interaction-entry="features.project-library.asset_library_tree.003"
                        className="library-icon-button"
                        icon="add"
                        label={text("library.projects.add")}
                        data-oaam-action="add-project"
                        disabled={addingProject}
                        onClick={onAddProject}
                    />
                ) : null}
            </div>
            <ul>
                {projects.map((project) => {
                    const selected = project.projectId === selectedProjectId;
                    const totalCount = projectTotalCounts.get(project.projectId);
                    return (
                        <li key={project.projectId} className="asset-tree-project-item" data-selected={selected}>
                            <div className="asset-tree-project-row">
                                <button
                                    data-oaam-interaction-entry="features.project-library.asset_library_tree.004"
                                    type="button"
                                    className="asset-tree-project"
                                    data-oaam-project-id={project.projectId}
                                    aria-current={selected && route.kind === undefined ? "page" : undefined}
                                    onClick={() => onSelectProject(project.projectId)}
                                >
                                    <DesktopIcon name={selected ? "folder_open" : "folder"} />
                                    <span className="asset-tree-project-label">
                                        <span>{projectDisplayName(project)}</span>
                                        {totalCount === undefined ? null : <small>{totalCount}</small>}
                                    </span>
                                </button>
                                {canManageProjects ? (
                                    <WorkbenchIconButton
                                        data-oaam-interaction-entry="features.project-library.asset_library_tree.005"
                                        className="asset-tree-project-menu"
                                        icon="more"
                                        label={text("library.projects.manage", { project: projectDisplayName(project) })}
                                        tooltip={text("library.projects.more_actions")}
                                        aria-haspopup="dialog"
                                        data-oaam-action="manage-project"
                                        data-oaam-project-id={project.projectId}
                                        onClick={() => onManageProject(project)}
                                    />
                                ) : null}
                            </div>
                            {!selected || projectCollection === undefined ? null : (
                                <KindBranches route={route} collection={projectCollection} onSelectRoute={onSelectRoute} />
                            )}
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
