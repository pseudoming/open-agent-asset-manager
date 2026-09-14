import { projectDisplayName } from "../../presentation/project-label";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
    AssetVersionExportKind,
    AssetVersionExportPickerResult,
    ProjectRootPickerResult,
} from "../../../bridge/desktop-bridge";
import { DESKTOP_PANE_WIDTHS } from "../../../presentation/presentation-preferences";
import type { WorkbenchLibraryRoute, WorkbenchRoute } from "../../app/workbench-navigation";
import type { DesktopApplicationClientApi } from "../../client";
import { ProtocolDiagnostics, useDesktopPaneWidths, useDesktopPresentation } from "../../presentation";
import { TransientWorkbenchSidebar } from "../../shell/TransientWorkbenchSidebar";
import { StatusPanel, WorkbenchIconButton, WorkbenchNotice, WorkbenchResizeSeparator } from "../../ui";
import type { DeploymentWorkspaceSubject } from "../catalog-deployment";
import type { AssetLifecycleFeedback } from "./AssetActions";
import { AssetCollection, type AssetRowAction, type AssetTargetSupportState } from "./AssetCollection";
import { AssetInspector } from "./AssetInspector";
import { AssetLibraryTree } from "./AssetLibraryTree";
import { AssetBrowserController, type AssetBrowserState } from "./asset-browser-controller";
import { ProjectLifecycleDialog } from "./ProjectLifecycleDialog";
import { ProjectLibraryController, type ProjectLibraryState } from "./project-library-controller";
import { assetLibraryRoute, buildAssetTargetSupport, supportsProjectRegistration } from "./project-library-model";
import type { ProjectLifecycleProject, ProjectLifecycleReviewContext } from "./project-lifecycle-model";
import { useProjectAssetCounts } from "./use-project-asset-counts";

export interface ProjectLibraryWorkspaceProps {
    readonly client: DesktopApplicationClientApi;
    readonly pickProjectRoot: () => Promise<ProjectRootPickerResult>;
    readonly pickAssetVersionExport: (
        exportKind: AssetVersionExportKind,
        suggestedFileName: string,
    ) => Promise<AssetVersionExportPickerResult>;
    readonly assetCount: number;
    readonly catalogWarningCount: number;
    readonly route: WorkbenchLibraryRoute;
    readonly sidebarVisible: boolean;
    readonly inspectorVisible: boolean;
    readonly onNavigate: (route: WorkbenchRoute) => void;
    readonly onReplaceRoute: (route: WorkbenchRoute) => void;
    readonly onInspectorVisibleChange: (visible: boolean) => void;
    readonly onOpenGuidedImport: (targetProjectId?: string) => void;
    readonly onOpenSources: () => void;
    readonly onOpenSettings: () => void;
    readonly onOpenSearch: () => void;
    readonly onOpenDeployments: (subject: DeploymentWorkspaceSubject, assetId?: string) => void;
    readonly projectRegistrationRequest?: ProjectRegistrationRequest;
}

export interface ProjectRegistrationRequest {
    readonly requestId: number;
    readonly onHandled: () => void;
}

interface ProjectLifecycleDialogRequest {
    readonly project: ProjectLifecycleProject;
    readonly initialAction: "manage" | "restore";
}

interface ProjectLifecycleAttention {
    readonly unavailableRootPath: string | undefined;
    readonly retainedDeploymentCount: number;
}

interface DeploymentWorkspaceAvailability {
    readonly subjectKey: string;
    readonly existingDeploymentCount: number;
}

interface AssetActionRequest {
    readonly assetId: string;
    readonly action: AssetRowAction;
    readonly requestId: number;
}

function deploymentSubjectKey(subject: DeploymentWorkspaceSubject): string {
    return subject.subjectKind === "global" ? "global" : `project:${subject.projectId}`;
}

export function ProjectLibraryWorkspace({
    client,
    pickProjectRoot,
    pickAssetVersionExport,
    assetCount,
    catalogWarningCount,
    route,
    sidebarVisible,
    inspectorVisible,
    onNavigate,
    onReplaceRoute,
    onInspectorVisibleChange,
    onOpenGuidedImport,
    onOpenSources,
    onOpenSettings,
    onOpenSearch,
    onOpenDeployments,
    projectRegistrationRequest,
}: ProjectLibraryWorkspaceProps): React.JSX.Element {
    const { snapshot, text, displayText, rememberLastProject, replaceAssetLayout } = useDesktopPresentation();
    const paneWidths = useDesktopPaneWidths();
    const [, setViewportRevision] = useState(0);
    useLayoutEffect(() => {
        const observeViewport = (): void => setViewportRevision((current) => current + 1);
        observeViewport();
        const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => observeViewport());
        resizeObserver?.observe(document.documentElement);
        globalThis.addEventListener("resize", observeViewport);
        globalThis.visualViewport?.addEventListener("resize", observeViewport);
        return () => {
            resizeObserver?.disconnect();
            globalThis.removeEventListener("resize", observeViewport);
            globalThis.visualViewport?.removeEventListener("resize", observeViewport);
        };
    }, []);
    const viewportWidth = document.documentElement.clientWidth || globalThis.innerWidth;
    const maximumRightPaneWidth = Math.max(
        DESKTOP_PANE_WIDTHS.right.minimum,
        Math.min(DESKTOP_PANE_WIDTHS.right.maximum, viewportWidth - (sidebarVisible ? paneWidths.widths.left : 0) - 360),
    );
    const rightPaneWidth = Math.min(paneWidths.widths.right, maximumRightPaneWidth);
    const initialPreferredProjectId = useRef(
        route.subject === "projects" ? (route.projectId ?? snapshot.preferences.lastSelectedProjectId) : undefined,
    ).current;
    const controller = useMemo(
        () => new ProjectLibraryController(client, initialPreferredProjectId),
        [client, initialPreferredProjectId],
    );
    const browserController = useMemo(() => new AssetBrowserController(client), [client]);
    const [state, setState] = useState<ProjectLibraryState>(controller.state);
    const [browserState, setBrowserState] = useState<AssetBrowserState>(browserController.state);
    const [includeDeletedAssets, setIncludeDeletedAssets] = useState(false);
    const { counts: projectTotalCounts, refreshProject } = useProjectAssetCounts(
        client,
        state.status === "ready" ? state.projects : undefined,
        includeDeletedAssets,
    );
    const [preferenceWarning, setPreferenceWarning] = useState(false);
    const [assetLifecycleFeedback, setAssetLifecycleFeedback] = useState<AssetLifecycleFeedback>();
    const [lifecycleRequest, setLifecycleRequest] = useState<ProjectLifecycleDialogRequest>();
    const [lifecycleAttention, setLifecycleAttention] = useState<ReadonlyMap<string, ProjectLifecycleAttention>>(() => new Map());
    const [deploymentWorkspaceAvailability, setDeploymentWorkspaceAvailability] = useState<DeploymentWorkspaceAvailability>();
    const [assetActionRequest, setAssetActionRequest] = useState<AssetActionRequest>();
    const nextAssetActionRequestId = useRef(0);
    const [targetSupport, setTargetSupport] = useState<AssetTargetSupportState>(
        client.supportsOperation("adapter_provider.list") ? { status: "loading" } : { status: "unavailable" },
    );
    const handledProjectRegistrationRequestId = useRef(0);
    const implicitFallbackProjectId = useRef<string | undefined>(undefined);
    const lastProjectPublication = useRef<string | undefined>(undefined);

    useEffect(() => {
        const unsubscribe = controller.subscribe(setState);
        void controller.load();
        return () => {
            unsubscribe();
            controller.dispose();
        };
    }, [controller]);

    useEffect(() => {
        const unsubscribe = browserController.subscribe(setBrowserState);
        return () => {
            unsubscribe();
            browserController.dispose();
        };
    }, [browserController]);

    useEffect(() => {
        if (!client.supportsOperation("adapter_provider.list")) {
            setTargetSupport({ status: "unavailable" });
            return;
        }
        let active = true;
        setTargetSupport({ status: "loading" });
        void client
            .listAdapterProviders()
            .then((outcome) => {
                if (!active) return;
                setTargetSupport(
                    outcome.status === "complete"
                        ? { status: "ready", byKind: buildAssetTargetSupport(outcome.value.providers) }
                        : { status: "unavailable" },
                );
            })
            .catch(() => {
                if (active) setTargetSupport({ status: "unavailable" });
            });
        return () => {
            active = false;
        };
    }, [client]);

    useEffect(() => {
        if (state.status !== "ready") return;
        if (route.subject !== "projects") {
            implicitFallbackProjectId.current = undefined;
            return;
        }
        if (route.projectId === undefined) {
            if (state.selectedProjectId !== undefined) {
                implicitFallbackProjectId.current = state.selectedProjectId;
                onReplaceRoute({ ...route, projectId: state.selectedProjectId });
            }
            return;
        }
        if (implicitFallbackProjectId.current !== undefined && implicitFallbackProjectId.current !== route.projectId) {
            implicitFallbackProjectId.current = undefined;
        }
        const retainedProject = state.retainedProjects.find((project) => project.projectId === route.projectId);
        if (retainedProject !== undefined) {
            setLifecycleRequest((current) =>
                current?.initialAction === "restore" && current.project.projectId === retainedProject.projectId
                    ? current
                    : { project: retainedProject, initialAction: "restore" },
            );
            return;
        }
        if (state.selectedProjectId !== route.projectId) {
            controller.selectProject(route.projectId);
        }
    }, [controller, onReplaceRoute, route, state]);

    const selectedProject =
        state.status === "ready" ? state.projects.find((project) => project.projectId === state.selectedProjectId) : undefined;
    const deploymentSubject = useMemo<DeploymentWorkspaceSubject | undefined>(
        () =>
            route.subject === "global"
                ? { subjectKind: "global" }
                : selectedProject === undefined
                  ? undefined
                  : { subjectKind: "project", projectId: selectedProject.projectId },
        [route.subject, selectedProject],
    );
    const currentDeploymentSubjectKey = deploymentSubject === undefined ? undefined : deploymentSubjectKey(deploymentSubject);
    const selectedProjectId = state.status === "ready" ? state.selectedProjectId : undefined;
    const refreshLibrary = (projectId: string | undefined): void => {
        if (projectId !== undefined) refreshProject(projectId);
        void browserController.refresh();
    };
    const publishLastProject = useCallback(
        (projectId: string): void => {
            if (snapshot.preferences.lastSelectedProjectId === projectId) {
                if (lastProjectPublication.current === projectId) lastProjectPublication.current = undefined;
                setPreferenceWarning(false);
                return;
            }
            if (lastProjectPublication.current === projectId) return;
            lastProjectPublication.current = projectId;
            setPreferenceWarning(false);
            void rememberLastProject(projectId).catch(() => {
                if (lastProjectPublication.current === projectId) setPreferenceWarning(true);
            });
        },
        [rememberLastProject, snapshot.preferences.lastSelectedProjectId],
    );
    const routedActiveProjectId =
        route.subject === "projects" &&
        route.projectId !== undefined &&
        selectedProject?.projectId === route.projectId &&
        implicitFallbackProjectId.current !== route.projectId
            ? route.projectId
            : undefined;
    useEffect(() => {
        const current = lastProjectPublication.current;
        if (current !== undefined && current !== routedActiveProjectId) lastProjectPublication.current = undefined;
        if (routedActiveProjectId !== undefined) publishLastProject(routedActiveProjectId);
    }, [publishLastProject, routedActiveProjectId]);
    useEffect(() => {
        if (state.status !== "ready") return;
        const timeout = setTimeout(() => {
            void browserController.load(route.subject, selectedProjectId, "", includeDeletedAssets);
        }, 180);
        return () => clearTimeout(timeout);
    }, [browserController, includeDeletedAssets, route.subject, selectedProjectId, state.status]);
    function chooseProject(projectId: string): void {
        const activeProject = state.status === "ready" && state.projects.some((project) => project.projectId === projectId);
        if (!controller.selectProject(projectId) && !activeProject) return;
        implicitFallbackProjectId.current = undefined;
        onNavigate({ surface: "library", subject: "projects", projectId });
        publishLastProject(projectId);
    }

    function switchSubject(subject: "projects" | "global"): void {
        setAssetLifecycleFeedback(undefined);
        setAssetActionRequest(undefined);
        onInspectorVisibleChange(false);
        onNavigate(
            subject === "global"
                ? { surface: "library", subject: "global" }
                : selectedProjectId === undefined
                  ? { surface: "library", subject: "projects" }
                  : { surface: "library", subject: "projects", projectId: selectedProjectId },
        );
    }

    const addProject = useCallback(async (): Promise<void> => {
        const selection = await pickProjectRoot();
        if (selection.status !== "selected") return;
        const projectId = await controller.registerProject(selection.localPathSelectionToken);
        if (projectId === undefined) return;
        implicitFallbackProjectId.current = undefined;
        onNavigate({ surface: "library", subject: "projects", projectId });
        publishLastProject(projectId);
    }, [controller, onNavigate, pickProjectRoot, publishLastProject]);

    useEffect(() => {
        const request = projectRegistrationRequest;
        if (
            request === undefined ||
            request.requestId <= handledProjectRegistrationRequestId.current ||
            state.status !== "ready" ||
            state.registeringProject
        ) {
            return;
        }
        handledProjectRegistrationRequestId.current = request.requestId;
        void addProject().finally(request.onHandled);
    }, [addProject, projectRegistrationRequest, state]);

    function chooseLibraryRoute(nextRoute: WorkbenchLibraryRoute): void {
        setAssetLifecycleFeedback(undefined);
        setAssetActionRequest(undefined);
        onInspectorVisibleChange(false);
        onNavigate(nextRoute);
    }

    function chooseAsset(assetId: string): void {
        setAssetLifecycleFeedback(undefined);
        setAssetActionRequest(undefined);
        onInspectorVisibleChange(true);
        onNavigate({ ...route, assetId, versionId: undefined });
    }

    function openAssetAction(assetId: string, action: AssetRowAction): void {
        nextAssetActionRequestId.current += 1;
        setAssetLifecycleFeedback(undefined);
        setAssetActionRequest({ assetId, action, requestId: nextAssetActionRequestId.current });
        onInspectorVisibleChange(true);
        onNavigate({ ...route, assetId, versionId: assetId === route.assetId ? route.versionId : undefined });
    }

    function chooseAssetLayout(layout: "list" | "cards"): void {
        setPreferenceWarning(false);
        void replaceAssetLayout(layout).catch(() => setPreferenceWarning(true));
    }

    function completeProjectLifecycle(project: ProjectLifecycleProject, context: ProjectLifecycleReviewContext): void {
        const nextSelectedProjectId = controller.applyLifecycleProject(project);
        setLifecycleAttention((current) => {
            const next = new Map(current);
            if (context.review.action === "stop_managing") {
                next.delete(project.projectId);
            } else {
                const previous = next.get(project.projectId);
                next.set(project.projectId, {
                    unavailableRootPath:
                        context.review.action === "restore"
                            ? context.review.rootAccessState === "unavailable"
                                ? context.review.rootPath
                                : undefined
                            : context.review.action === "rebind"
                              ? undefined
                              : previous?.unavailableRootPath,
                    retainedDeploymentCount:
                        context.review.action === "rebind"
                            ? context.deployments.length
                            : (previous?.retainedDeploymentCount ?? 0),
                });
            }
            return next;
        });
        setLifecycleRequest(undefined);
        const routeProjectId = project.deleted ? nextSelectedProjectId : project.projectId;
        onNavigate({
            surface: "library",
            subject: "projects",
            ...(routeProjectId === undefined ? {} : { projectId: routeProjectId }),
        });
        if (routeProjectId !== undefined) {
            implicitFallbackProjectId.current = undefined;
            publishLastProject(routeProjectId);
        }
    }

    function closeProjectLifecycle(): void {
        const request = lifecycleRequest;
        setLifecycleRequest(undefined);
        if (request?.project.deleted !== true || route.subject !== "projects" || route.projectId !== request.project.projectId) {
            return;
        }
        const projectId = state.status === "ready" ? state.selectedProjectId : undefined;
        onReplaceRoute({
            surface: "library",
            subject: "projects",
            ...(projectId === undefined ? {} : { projectId }),
        });
    }

    const projectCollection =
        browserState.status === "ready"
            ? browserState.collections.find(
                  (collection) =>
                      collection.collectionId === "project" &&
                      collection.subject.scope === "project" &&
                      collection.subject.projectId === selectedProjectId,
              )
            : undefined;
    const globalCollection =
        browserState.status === "ready"
            ? browserState.collections.find((collection) => collection.collectionId === "global")
            : undefined;
    const selectedCollection =
        route.collection === "project" ? projectCollection : route.collection === "global" ? globalCollection : undefined;
    useEffect(() => {
        if (
            browserState.status !== "ready" ||
            browserState.keywords !== "" ||
            browserState.includeDeleted !== includeDeletedAssets ||
            route.collection !== undefined
        ) {
            return;
        }
        if (route.subject === "global" && globalCollection !== undefined) {
            onReplaceRoute({
                surface: "library",
                subject: "global",
                collection: "global",
                kind: route.kind,
                assetId: route.assetId,
            });
            return;
        }
        if (
            route.subject === "projects" &&
            projectCollection?.subject.scope === "project" &&
            projectCollection.subject.projectId === route.projectId
        ) {
            onReplaceRoute({
                surface: "library",
                subject: "projects",
                projectId: route.projectId,
                collection: "project",
                kind: route.kind,
                assetId: route.assetId,
            });
        }
    }, [browserState, globalCollection, includeDeletedAssets, onReplaceRoute, projectCollection, route]);
    useEffect(() => {
        setDeploymentWorkspaceAvailability(undefined);
        if (deploymentSubject === undefined || !client.supportsOperation("deployment.list")) {
            return;
        }
        let active = true;
        const subjectKey = deploymentSubjectKey(deploymentSubject);
        void (async () => {
            const deploymentOutcome = await client.listDeployments({ subject: deploymentSubject });
            if (!active || deploymentOutcome.status === "failed") return;
            const existingDeploymentCount = deploymentOutcome.value.deployments.filter(
                (deployment) => !deployment.deleted,
            ).length;
            setDeploymentWorkspaceAvailability({
                subjectKey,
                existingDeploymentCount,
            });
        })().catch(() => undefined);
        return () => {
            active = false;
        };
    }, [client, deploymentSubject]);
    const selectedAssetId = route.assetId;
    const selectedProjectAttention =
        selectedProject === undefined ? undefined : lifecycleAttention.get(selectedProject.projectId);
    const unavailableRootPath =
        selectedProjectAttention !== undefined &&
        selectedProject !== undefined &&
        selectedProjectAttention.unavailableRootPath === selectedProject.rootPath
            ? selectedProjectAttention.unavailableRootPath
            : undefined;
    const existingDeploymentCount =
        currentDeploymentSubjectKey !== undefined && deploymentWorkspaceAvailability?.subjectKey === currentDeploymentSubjectKey
            ? deploymentWorkspaceAvailability.existingDeploymentCount
            : undefined;
    const canManageDeploymentWorkspace =
        deploymentSubject !== undefined && existingDeploymentCount !== undefined && existingDeploymentCount > 0;
    const canAddAssetToTool = deploymentSubject !== undefined && client.supportsOperation("adapter.probe");
    const canManageProjects =
        client.supportsOperation("project_lifecycle.inspect") && client.supportsOperation("project_lifecycle.commit");
    return (
        <main
            className="project-library-shell"
            data-oaam-route="library"
            data-oaam-state="ready"
            data-oaam-subject={route.subject}
            data-oaam-project-id={route.subject === "projects" ? selectedProjectId : undefined}
            data-sidebar-open={sidebarVisible}
            data-inspector-open={state.status === "ready" && route.assetId !== undefined && inspectorVisible}
            data-oaam-asset-count={assetCount}
            style={
                {
                    "--oaam-left-pane-width": `${paneWidths.widths.left}px`,
                    "--oaam-right-pane-width": `${rightPaneWidth}px`,
                } as CSSProperties
            }
        >
            <TransientWorkbenchSidebar
                data-oaam-interaction-entry="features.project-library.project_library_workspace.001"
                className="library-sidebar"
                persistentVisible={sidebarVisible}
                restoreFocusElementId="oaam-workbench-sidebar-toggle"
            >
                <div className="app-brand library-brand">
                    <span className="app-brand-mark" aria-hidden="true">
                        OA
                    </span>
                    <span className="library-brand-copy">
                        <strong>OAAM</strong>
                        <small>{text("app.brand.subtitle")}</small>
                    </span>
                    <WorkbenchIconButton
                        className="library-brand-search"
                        icon="search"
                        label={text("search.open")}
                        data-oaam-semantic-action="library.open_search"
                        data-oaam-semantic-entry="library.search.toolbar"
                        onClick={() => onOpenSearch()}
                    />
                </div>
                <div className="library-sidebar-scroll asset-library-sidebar-content">
                    <div className="subject-switch" role="tablist" aria-label={text("library.subject.label")}>
                        <button
                            data-oaam-interaction-entry="features.project-library.project_library_workspace.003"
                            type="button"
                            data-oaam-subject-choice="projects"
                            role="tab"
                            aria-selected={route.subject === "projects"}
                            onClick={() => switchSubject("projects")}
                        >
                            {text("library.subject.projects")}
                        </button>
                        <button
                            data-oaam-interaction-entry="features.project-library.project_library_workspace.004"
                            type="button"
                            data-oaam-subject-choice="global"
                            role="tab"
                            aria-selected={route.subject === "global"}
                            onClick={() => switchSubject("global")}
                        >
                            {text("library.subject.global")}
                        </button>
                    </div>
                    <div className="asset-library-tree-region">
                        {state.status === "ready" ? (
                            <AssetLibraryTree
                                projects={state.projects}
                                projectTotalCounts={projectTotalCounts}
                                selectedProjectId={selectedProjectId}
                                route={route}
                                projectCollection={projectCollection}
                                globalCollection={globalCollection}
                                canAddProject={route.subject === "projects" && supportsProjectRegistration(client)}
                                addingProject={state.registeringProject}
                                canManageProjects={canManageProjects}
                                onAddProject={() => void addProject()}
                                onManageProject={(project) => setLifecycleRequest({ project, initialAction: "manage" })}
                                onSelectProject={chooseProject}
                                onSelectRoute={chooseLibraryRoute}
                            />
                        ) : null}
                    </div>
                </div>
                <div className="library-sidebar-footer">
                    <div className="library-host-status" role="status">
                        <span className="status-dot" aria-hidden="true" />
                        <strong>{text("app.host.running")}</strong>
                    </div>
                    <div className="library-footer-actions">
                        {catalogWarningCount > 0 ? (
                            <WorkbenchIconButton
                                className="library-footer-button library-catalog-warning"
                                icon="warning"
                                label={text("library.catalog.warnings", { count: catalogWarningCount })}
                                data-oaam-semantic-action="library.open_settings"
                                data-oaam-semantic-entry="library.settings.warning"
                                onClick={() => onOpenSettings()}
                            />
                        ) : null}
                        <WorkbenchIconButton
                            className="library-settings-button library-footer-button"
                            icon="settings"
                            label={text("settings.open")}
                            data-oaam-semantic-action="library.open_settings"
                            data-oaam-semantic-entry="library.settings.footer"
                            onClick={() => onOpenSettings()}
                        />
                    </div>
                </div>
            </TransientWorkbenchSidebar>
            {sidebarVisible ? (
                <WorkbenchResizeSeparator
                    data-oaam-interaction-entry="features.project-library.project_library_workspace.007"
                    label={text("preferences.left_pane.label")}
                    value={paneWidths.widths.left}
                    minimum={DESKTOP_PANE_WIDTHS.left.minimum}
                    maximum={DESKTOP_PANE_WIDTHS.left.maximum}
                    onPreview={paneWidths.previewLeft}
                    onCommit={paneWidths.commitLeft}
                />
            ) : null}

            <section
                className="library-workbench"
                data-inspector-open={state.status === "ready" && route.assetId !== undefined && inspectorVisible}
            >
                <section className="library-main" aria-label={text("library.workspace.label")}>
                    <header className="library-toolbar">
                        <div className="library-toolbar-copy">
                            <h1>
                                {route.subject === "global"
                                    ? text("library.tree.global_assets")
                                    : (projectDisplayName(selectedProject) ?? text("library.tree.projects"))}
                            </h1>
                        </div>
                        {state.status === "ready" ? (
                            <div className="library-toolbar-actions">
                                {route.subject === "projects" && selectedProject === undefined ? null : selectedCollection ===
                                      undefined || selectedCollection.totalCount === 0 ? null : (
                                    <>
                                        <WorkbenchIconButton
                                            className="library-icon-button library-source-locations-button"
                                            icon="folder_open"
                                            label={text("sources.title")}
                                            data-oaam-action="open-source-locations"
                                            data-oaam-semantic-action="library.open_source_locations"
                                            data-oaam-semantic-entry="library.source_locations.toolbar"
                                            onClick={() => onOpenSources()}
                                        />
                                        <WorkbenchIconButton
                                            className="library-icon-button library-import-sources-button"
                                            icon="import"
                                            label={text("library.import_sources")}
                                            data-oaam-action="start-guided-import"
                                            data-oaam-semantic-action="library.start_guided_import"
                                            data-oaam-semantic-entry="library.guided_import.toolbar"
                                            onClick={() =>
                                                route.subject === "projects" && selectedProject !== undefined
                                                    ? onOpenGuidedImport(selectedProject.projectId)
                                                    : onOpenGuidedImport()
                                            }
                                        />
                                    </>
                                )}
                                {canManageDeploymentWorkspace ? (
                                    <button
                                        type="button"
                                        className="library-secondary-button library-context-action"
                                        data-oaam-action="open-deployments"
                                        data-oaam-semantic-action="library.open_deployments"
                                        data-oaam-semantic-entry="library.deployments.toolbar"
                                        onClick={() => onOpenDeployments(deploymentSubject)}
                                    >
                                        {text("library.deployments.manage")}
                                    </button>
                                ) : null}
                                {route.subject === "global" || selectedProject !== undefined ? (
                                    <WorkbenchIconButton
                                        data-oaam-interaction-entry="features.project-library.project_library_workspace.011"
                                        className="library-icon-button library-show-deleted"
                                        icon="filter"
                                        label={text("library.assets.include_deleted")}
                                        aria-pressed={includeDeletedAssets}
                                        onClick={() => setIncludeDeletedAssets((current) => !current)}
                                    />
                                ) : null}
                                {selectedCollection !== undefined && selectedCollection.totalCount > 0 ? (
                                    <>
                                        <span className="library-toolbar-separator" aria-hidden="true" />
                                        <fieldset className="layout-switch" aria-label={text("library.layout.label")}>
                                            <WorkbenchIconButton
                                                data-oaam-interaction-entry="features.project-library.project_library_workspace.012"
                                                className="library-icon-button"
                                                icon="list"
                                                label={text("library.layout.list")}
                                                aria-pressed={snapshot.preferences.assetLayout === "list"}
                                                onClick={() => chooseAssetLayout("list")}
                                            />
                                            <WorkbenchIconButton
                                                data-oaam-interaction-entry="features.project-library.project_library_workspace.013"
                                                className="library-icon-button"
                                                icon="cards"
                                                label={text("library.layout.cards")}
                                                aria-pressed={snapshot.preferences.assetLayout === "cards"}
                                                onClick={() => chooseAssetLayout("cards")}
                                            />
                                        </fieldset>
                                    </>
                                ) : null}
                                <WorkbenchIconButton
                                    data-oaam-interaction-entry="features.project-library.project_library_workspace.014"
                                    className="library-icon-button"
                                    icon="refresh"
                                    label={state.stale ? text("library.refresh_required") : text("library.refresh")}
                                    onClick={() => void controller.load()}
                                />
                                <WorkbenchIconButton
                                    data-oaam-interaction-entry="features.project-library.project_library_workspace.015"
                                    className="library-icon-button"
                                    icon="inspector"
                                    label={text("window.inspector.toggle")}
                                    aria-pressed={route.assetId !== undefined && inspectorVisible}
                                    disabled={route.assetId === undefined}
                                    onClick={() => onInspectorVisibleChange(!inspectorVisible)}
                                />
                            </div>
                        ) : null}
                    </header>
                    <div className="library-main-scroll">
                        {state.status === "loading" ? (
                            <StatusPanel
                                className="library-state-panel"
                                compact
                                eyebrow={text("library.assets.eyebrow")}
                                title={text("library.loading_title")}
                                message={displayText(state.message)}
                                busy
                            />
                        ) : state.status === "failed" ? (
                            <StatusPanel
                                className="library-state-panel"
                                compact
                                eyebrow={text("library.assets.eyebrow")}
                                title={text("library.failed_title")}
                                message={displayText(state.message)}
                                tone="danger"
                            >
                                <ProtocolDiagnostics
                                    diagnostics={state.diagnostics}
                                    technicalSummary={text("import.ui.technical_details")}
                                />
                                <button
                                    data-oaam-interaction-entry="features.project-library.project_library_workspace.016"
                                    type="button"
                                    onClick={() => void controller.load()}
                                >
                                    {text("common.retry")}
                                </button>
                            </StatusPanel>
                        ) : route.subject === "projects" && selectedProject === undefined ? (
                            <StatusPanel
                                className="library-empty-state"
                                compact
                                title={text("library.projects.empty_title")}
                                message={text("library.projects.empty_copy")}
                            >
                                <div className="library-empty-actions">
                                    {supportsProjectRegistration(client) ? (
                                        <button
                                            data-oaam-interaction-entry="features.project-library.project_library_workspace.017"
                                            type="button"
                                            data-oaam-action="add-project"
                                            onClick={() => void addProject()}
                                        >
                                            {text("library.projects.add")}
                                        </button>
                                    ) : null}
                                    <button
                                        className="library-secondary-button"
                                        type="button"
                                        data-oaam-action="start-guided-import"
                                        data-oaam-semantic-action="library.start_guided_import"
                                        data-oaam-semantic-entry="library.guided_import.no_projects"
                                        onClick={() => onOpenGuidedImport()}
                                    >
                                        {text("library.import_sources")}
                                    </button>
                                </div>
                            </StatusPanel>
                        ) : browserState.status === "ready" &&
                          selectedCollection !== undefined &&
                          selectedCollection.totalCount === 0 ? (
                            <StatusPanel
                                className="library-empty-state"
                                compact
                                title={text(
                                    route.subject === "global"
                                        ? "library.assets.empty_global_title"
                                        : "library.assets.empty_project_title",
                                    route.subject === "global"
                                        ? {}
                                        : { project: projectDisplayName(selectedProject) ?? text("library.tree.projects") },
                                )}
                                message={text(
                                    route.subject === "global"
                                        ? "library.assets.empty_global_copy"
                                        : "library.assets.empty_project_copy",
                                )}
                            >
                                <div className="library-empty-actions">
                                    <button
                                        type="button"
                                        data-oaam-action="start-guided-import"
                                        data-oaam-semantic-action="library.start_guided_import"
                                        data-oaam-semantic-entry="library.guided_import.empty_collection"
                                        onClick={() =>
                                            route.subject === "projects" && selectedProject !== undefined
                                                ? onOpenGuidedImport(selectedProject.projectId)
                                                : onOpenGuidedImport()
                                        }
                                    >
                                        {text(
                                            route.subject === "projects"
                                                ? "library.import_project_sources"
                                                : "library.import_sources",
                                        )}
                                    </button>
                                </div>
                            </StatusPanel>
                        ) : (
                            <>
                                {state.stale ? (
                                    <WorkbenchNotice tone="warning" role="status">
                                        {text("library.authority_changed")}
                                    </WorkbenchNotice>
                                ) : null}
                                {preferenceWarning || paneWidths.saveFailed ? (
                                    <WorkbenchNotice tone="warning" role="status">
                                        {text("library.preference_not_saved")}
                                    </WorkbenchNotice>
                                ) : null}
                                {state.message === undefined ? null : state.message.kind === "localized" &&
                                  state.message.id === "library.project_registered" ? (
                                    <p className="workbench-status-copy" role="status">
                                        {displayText(state.message)}
                                    </p>
                                ) : (
                                    <WorkbenchNotice role="status">{displayText(state.message)}</WorkbenchNotice>
                                )}
                                {assetLifecycleFeedback === undefined ? null : (
                                    <>
                                        {assetLifecycleFeedback.tone === "note" ? (
                                            <p className="workbench-status-copy" role="status">
                                                {displayText(assetLifecycleFeedback.message)}
                                            </p>
                                        ) : (
                                            <WorkbenchNotice
                                                tone={assetLifecycleFeedback.tone}
                                                role={assetLifecycleFeedback.tone === "danger" ? "alert" : "status"}
                                            >
                                                {displayText(assetLifecycleFeedback.message)}
                                            </WorkbenchNotice>
                                        )}
                                        <ProtocolDiagnostics
                                            diagnostics={assetLifecycleFeedback.diagnostics}
                                            technicalSummary={text("import.ui.technical_details")}
                                        />
                                    </>
                                )}
                                {unavailableRootPath === undefined ? null : (
                                    <WorkbenchNotice tone="warning" role="status">
                                        {text("project_lifecycle.restore.root_attention", {
                                            path: unavailableRootPath,
                                        })}
                                    </WorkbenchNotice>
                                )}
                                {(selectedProjectAttention?.retainedDeploymentCount ?? 0) > 0 ? (
                                    <WorkbenchNotice tone="warning" role="status">
                                        {text("project_lifecycle.deployments.attention", {
                                            count: selectedProjectAttention?.retainedDeploymentCount ?? 0,
                                        })}
                                        {deploymentSubject === undefined ? null : (
                                            <button
                                                type="button"
                                                data-oaam-action="open-deployments"
                                                data-oaam-semantic-action="library.open_deployments"
                                                data-oaam-semantic-entry="library.deployments.retained_notice"
                                                onClick={() => onOpenDeployments(deploymentSubject)}
                                            >
                                                {text("library.deployments.manage")}
                                            </button>
                                        )}
                                    </WorkbenchNotice>
                                ) : null}
                                <ProtocolDiagnostics
                                    diagnostics={state.diagnostics}
                                    technicalSummary={text("import.ui.technical_details")}
                                />
                                {browserState.status === "ready" ? (
                                    <ProtocolDiagnostics
                                        diagnostics={browserState.diagnostics}
                                        technicalSummary={text("import.ui.technical_details")}
                                    />
                                ) : null}
                                <section className="asset-browser" aria-label={text("library.assets.title")}>
                                    {browserState.status === "loading" || browserState.status === "idle" ? (
                                        <div className="library-empty-inline" role="status" aria-busy="true">
                                            {text("library.assets.loading")}
                                        </div>
                                    ) : browserState.status === "failed" ? (
                                        <>
                                            <WorkbenchNotice tone="danger" role="alert">
                                                {displayText(browserState.message)}
                                            </WorkbenchNotice>
                                            <ProtocolDiagnostics
                                                diagnostics={browserState.diagnostics}
                                                technicalSummary={text("import.ui.technical_details")}
                                            />
                                        </>
                                    ) : route.collection === undefined ? (
                                        <div className="library-empty-inline" role="status" aria-busy="true">
                                            {text("library.assets.loading")}
                                        </div>
                                    ) : selectedCollection !== undefined ? (
                                        <AssetCollection
                                            collection={selectedCollection}
                                            refreshing={browserState.status === "ready" && browserState.refreshing}
                                            selectedKind={route.kind}
                                            layout={snapshot.preferences.assetLayout}
                                            selectedAssetId={selectedAssetId}
                                            showTargetSupport={route.subject === "global"}
                                            targetSupport={targetSupport}
                                            onOpenGuidedImport={() =>
                                                route.subject === "projects" && route.projectId !== undefined
                                                    ? onOpenGuidedImport(route.projectId)
                                                    : onOpenGuidedImport()
                                            }
                                            onLoadKind={(collectionId, kind) =>
                                                void browserController.loadKind(collectionId, kind)
                                            }
                                            onSelectAsset={chooseAsset}
                                            onOpenAssetAction={openAssetAction}
                                            onAddAssetToTool={
                                                canAddAssetToTool && deploymentSubject !== undefined
                                                    ? (assetId) => onOpenDeployments(deploymentSubject, assetId)
                                                    : undefined
                                            }
                                        />
                                    ) : null}
                                </section>
                            </>
                        )}
                    </div>
                </section>
                {state.status === "ready" && route.assetId !== undefined && inspectorVisible ? (
                    <>
                        <WorkbenchResizeSeparator
                            data-oaam-interaction-entry="features.project-library.project_library_workspace.021"
                            label={text("preferences.right_pane.label")}
                            value={rightPaneWidth}
                            minimum={DESKTOP_PANE_WIDTHS.right.minimum}
                            maximum={maximumRightPaneWidth}
                            direction={-1}
                            onPreview={paneWidths.previewRight}
                            onCommit={paneWidths.commitRight}
                        />
                        <AssetInspector
                            key={`${route.assetId}:${
                                assetActionRequest?.assetId === route.assetId ? assetActionRequest.requestId : 0
                            }`}
                            client={client}
                            assetId={route.assetId}
                            initialVersionId={route.versionId}
                            projects={state.projects}
                            pickAssetVersionExport={pickAssetVersionExport}
                            onLibraryChanged={() => refreshLibrary(selectedProjectId)}
                            onCopyCreated={({ asset }) => refreshLibrary(asset.projectId)}
                            onOpenCopy={({ asset }) => onNavigate(assetLibraryRoute(asset))}
                            onPurged={(feedback) => {
                                setAssetLifecycleFeedback(feedback);
                                const { assetId: _assetId, versionId: _versionId, ...libraryRoute } = route;
                                onNavigate(libraryRoute);
                                onInspectorVisibleChange(false);
                                refreshLibrary(selectedProjectId);
                            }}
                            onAddToTool={
                                canAddAssetToTool && deploymentSubject !== undefined
                                    ? () => onOpenDeployments(deploymentSubject, route.assetId)
                                    : undefined
                            }
                            initialAction={assetActionRequest?.assetId === route.assetId ? assetActionRequest.action : undefined}
                            onClose={() => onInspectorVisibleChange(false)}
                        />
                    </>
                ) : null}
            </section>
            {lifecycleRequest === undefined ? null : (
                <ProjectLifecycleDialog
                    client={client}
                    project={lifecycleRequest.project}
                    initialAction={lifecycleRequest.initialAction}
                    pickProjectRoot={pickProjectRoot}
                    onClose={closeProjectLifecycle}
                    onCommitted={completeProjectLifecycle}
                />
            )}
        </main>
    );
}
