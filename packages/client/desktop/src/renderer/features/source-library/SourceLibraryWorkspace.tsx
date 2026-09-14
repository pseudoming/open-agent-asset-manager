import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { DESKTOP_PANE_WIDTHS } from "../../../presentation/presentation-preferences";
import type { WorkbenchRoute, WorkbenchSourcesRoute } from "../../app/workbench-navigation";
import type { DesktopApplicationClientApi } from "../../client";
import { ProtocolDiagnostics, useDesktopPaneWidths, useDesktopPresentation } from "../../presentation";
import { TransientWorkbenchSidebar } from "../../shell/TransientWorkbenchSidebar";
import {
    DesktopIcon,
    StatusPanel,
    WorkbenchIconButton,
    WorkbenchNotice,
    WorkbenchResizeSeparator,
    WorkbenchTechnicalFact,
} from "../../ui";
import { SourceLibraryController, type SourceLibraryState } from "./source-library-controller";
import {
    filterSourceLibrary,
    findSourceEnvironment,
    findSourceLocation,
    type SourceLibraryDestination,
    type SourceLibraryEnvironment,
    type SourceLibraryLocation,
} from "./source-library-model";

export interface SourceLibraryWorkspaceProps {
    readonly client: DesktopApplicationClientApi;
    readonly catalogWarningCount: number;
    readonly route: WorkbenchSourcesRoute;
    readonly sidebarVisible: boolean;
    readonly onNavigate: (route: WorkbenchRoute) => void;
    readonly onReplaceRoute: (route: WorkbenchRoute) => void;
    readonly onOpenGuidedImport: () => void;
    readonly onOpenLibrary: () => void;
    readonly onOpenSettings: () => void;
}

function sourceLeafLabel(source: SourceLibraryLocation): string {
    const trimmed = source.canonicalPath.replace(/[\\/]+$/u, "");
    const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return trimmed.slice(separator + 1) || source.canonicalPath;
}

function sourceToolLabel(source: SourceLibraryLocation, unknownTool: string): string {
    return source.tools.map((tool) => tool.displayName ?? unknownTool).join(" · ") || unknownTool;
}

function sourceEnvironmentLabel(
    environment: SourceLibraryEnvironment["environment"],
    text: ReturnType<typeof useDesktopPresentation>["text"],
): string {
    switch (environment.platform) {
        case "win32":
        case "darwin":
        case "linux":
            return text("sources.environment.local");
        case "wsl":
            return text("sources.environment.wsl", { distribution: environment.platformInstanceId });
    }
}

function SourceTree({
    environments,
    route,
    onNavigate,
}: {
    readonly environments: readonly SourceLibraryEnvironment[];
    readonly route: WorkbenchSourcesRoute;
    readonly onNavigate: (route: WorkbenchSourcesRoute) => void;
}): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const [collapsedEnvironmentKeys, setCollapsedEnvironmentKeys] = useState<ReadonlySet<string>>(() => new Set());
    return (
        <nav className="source-tree" aria-label={text("sources.tree.label")}>
            <button
                data-oaam-interaction-entry="features.source-library.source_library_workspace.001"
                type="button"
                className="source-tree-root"
                aria-current={route.selection === "all" ? "page" : undefined}
                onClick={() => onNavigate({ surface: "sources", selection: "all" })}
            >
                <DesktopIcon name="reveal" />
                <strong>{text("sources.tree.all")}</strong>
                <span>{environments.reduce((total, environment) => total + environment.sources.length, 0)}</span>
            </button>
            <ul>
                {environments.map((environment) => {
                    const selectedEnvironment =
                        route.selection !== "all" &&
                        route.environment.platform === environment.environment.platform &&
                        route.environment.platformInstanceId === environment.environment.platformInstanceId;
                    const collapsed = collapsedEnvironmentKeys.has(environment.key);
                    return (
                        <li key={environment.key}>
                            <div className="source-tree-environment-row">
                                <WorkbenchIconButton
                                    data-oaam-interaction-entry="features.source-library.source_library_workspace.002"
                                    className="source-tree-disclosure"
                                    icon={collapsed ? "chevron_right" : "chevron_down"}
                                    label={text(collapsed ? "sources.tree.expand" : "sources.tree.collapse", {
                                        environment: sourceEnvironmentLabel(environment.environment, text),
                                    })}
                                    aria-expanded={!collapsed}
                                    onClick={() =>
                                        setCollapsedEnvironmentKeys((current) => {
                                            const next = new Set(current);
                                            if (next.has(environment.key)) next.delete(environment.key);
                                            else next.add(environment.key);
                                            return next;
                                        })
                                    }
                                />
                                <button
                                    data-oaam-interaction-entry="features.source-library.source_library_workspace.003"
                                    type="button"
                                    className="source-tree-environment"
                                    aria-current={route.selection === "environment" && selectedEnvironment ? "page" : undefined}
                                    onClick={() =>
                                        onNavigate({
                                            surface: "sources",
                                            selection: "environment",
                                            environment: environment.environment,
                                        })
                                    }
                                >
                                    <strong>{sourceEnvironmentLabel(environment.environment, text)}</strong>
                                    <span>{environment.sources.length}</span>
                                </button>
                            </div>
                            <ul hidden={collapsed}>
                                {environment.sources.map((source) => (
                                    <li key={source.key}>
                                        <button
                                            data-oaam-interaction-entry="features.source-library.source_library_workspace.004"
                                            type="button"
                                            className="source-tree-location"
                                            aria-current={
                                                route.selection === "source" &&
                                                selectedEnvironment &&
                                                route.canonicalPath === source.canonicalPath
                                                    ? "page"
                                                    : undefined
                                            }
                                            title={source.canonicalPath}
                                            onClick={() =>
                                                onNavigate({
                                                    surface: "sources",
                                                    selection: "source",
                                                    environment: environment.environment,
                                                    canonicalPath: source.canonicalPath,
                                                })
                                            }
                                        >
                                            <DesktopIcon name="reveal" />
                                            <span className="source-tree-location-copy">
                                                <strong>{sourceLeafLabel(source)}</strong>
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}

function DestinationLabel({ destination }: { readonly destination: SourceLibraryDestination }): React.JSX.Element {
    const { text } = useDesktopPresentation();
    return (
        <span>
            {destination.scope === "global"
                ? text("sources.destination.global")
                : text("sources.destination.project", {
                      project: destination.projectName ?? text("sources.destination.unknown_project"),
                  })}
        </span>
    );
}

function SourceRow({
    source,
    unknownTool,
    onOpen,
}: {
    readonly source: SourceLibraryLocation;
    readonly unknownTool: string;
    readonly onOpen: () => void;
}): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const tools = sourceToolLabel(source, unknownTool);
    const destinationLabel = source.destinations
        .map((destination) =>
            destination.scope === "global"
                ? text("sources.destination.global")
                : text("sources.destination.project", {
                      project: destination.projectName ?? text("sources.destination.unknown_project"),
                  }),
        )
        .join(" · ");
    return (
        <button
            data-oaam-interaction-entry="features.source-library.source_library_workspace.005"
            type="button"
            className="source-library-row"
            aria-label={text("sources.open_location", {
                location: sourceLeafLabel(source),
                tools,
                destination: destinationLabel,
            })}
            onClick={onOpen}
        >
            <span className="source-library-row-main">
                <strong>{sourceLeafLabel(source)}</strong>
                <span>{source.canonicalPath}</span>
            </span>
            <span className="source-library-row-tools">{tools}</span>
            <span className="source-library-row-meta">
                {source.destinations.map((destination) => (
                    <DestinationLabel
                        key={destination.scope === "global" ? "global" : `project:${destination.projectId}`}
                        destination={destination}
                    />
                ))}
            </span>
        </button>
    );
}

function SourceGroup({
    environment,
    unknownTool,
    onNavigate,
}: {
    readonly environment: SourceLibraryEnvironment;
    readonly unknownTool: string;
    readonly onNavigate: (route: WorkbenchSourcesRoute) => void;
}): React.JSX.Element {
    const { text } = useDesktopPresentation();
    return (
        <section className="source-library-group">
            <header>
                <div>
                    <h2>{sourceEnvironmentLabel(environment.environment, text)}</h2>
                    <p>{text("sources.environment.count", { count: environment.sources.length })}</p>
                </div>
            </header>
            <div className="source-library-column-headings" aria-hidden="true">
                <span>{text("sources.columns.location")}</span>
                <span>{text("sources.tools")}</span>
                <span>{text("sources.destination_column")}</span>
            </div>
            <div className="source-library-rows">
                {environment.sources.map((source) => (
                    <SourceRow
                        key={source.key}
                        source={source}
                        unknownTool={unknownTool}
                        onOpen={() =>
                            onNavigate({
                                surface: "sources",
                                selection: "source",
                                environment: environment.environment,
                                canonicalPath: source.canonicalPath,
                            })
                        }
                    />
                ))}
            </div>
        </section>
    );
}

export function SourceLibraryWorkspace({
    client,
    catalogWarningCount,
    route,
    sidebarVisible,
    onNavigate,
    onReplaceRoute,
    onOpenGuidedImport,
    onOpenLibrary,
    onOpenSettings,
}: SourceLibraryWorkspaceProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const paneWidths = useDesktopPaneWidths();
    const controller = useMemo(() => new SourceLibraryController(client), [client]);
    const [state, setState] = useState<SourceLibraryState>(controller.state);
    const [search, setSearch] = useState("");

    useEffect(() => {
        const unsubscribe = controller.subscribe(setState);
        void controller.load();
        return () => {
            unsubscribe();
            controller.dispose();
        };
    }, [controller]);

    const filteredEnvironments = useMemo(
        () => (state.status === "ready" ? filterSourceLibrary(state.environments, search) : Object.freeze([])),
        [search, state],
    );
    const selectedEnvironment =
        state.status === "ready" && route.selection !== "all"
            ? findSourceEnvironment(state.environments, route.environment)
            : undefined;
    const selectedSource =
        state.status === "ready" && route.selection === "source"
            ? findSourceLocation(state.environments, route.environment, route.canonicalPath)
            : undefined;

    useEffect(() => {
        if (state.status !== "ready" || route.selection === "all") return;
        if (
            findSourceEnvironment(state.environments, route.environment) === undefined ||
            (route.selection === "source" &&
                findSourceLocation(state.environments, route.environment, route.canonicalPath) === undefined)
        ) {
            onReplaceRoute({ surface: "sources", selection: "all" });
        }
    }, [onReplaceRoute, route, state]);

    const unknownTool = text("sources.tool.unknown");
    const pageTitle =
        route.selection === "all"
            ? text("sources.title")
            : route.selection === "environment"
              ? selectedEnvironment === undefined
                  ? text("sources.title")
                  : sourceEnvironmentLabel(selectedEnvironment.environment, text)
              : selectedSource === undefined
                ? text("sources.title")
                : sourceLeafLabel(selectedSource);

    return (
        <main
            className="project-library-shell source-library-shell"
            data-oaam-route="sources"
            data-oaam-state={state.status}
            data-sidebar-open={sidebarVisible}
            style={{ "--oaam-left-pane-width": `${paneWidths.widths.left}px` } as CSSProperties}
        >
            <TransientWorkbenchSidebar
                data-oaam-interaction-entry="features.source-library.source_library_workspace.006"
                className="library-sidebar source-library-sidebar"
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
                </div>
                <div className="source-sidebar-content">
                    <button
                        type="button"
                        className="workbench-sidebar-return source-library-back"
                        data-oaam-semantic-action="sources.open_library"
                        data-oaam-semantic-entry="sources.library.sidebar"
                        onClick={() => onOpenLibrary()}
                    >
                        <DesktopIcon name="back" size={15} />
                        {text("sources.back_to_library")}
                    </button>
                    <label className="source-sidebar-search">
                        <span>{text("sources.search")}</span>
                        <input
                            data-oaam-interaction-entry="features.source-library.source_library_workspace.008"
                            type="search"
                            value={search}
                            placeholder={text("sources.search_placeholder")}
                            onChange={(event) => setSearch(event.currentTarget.value)}
                        />
                    </label>
                    {state.status === "ready" ? (
                        <SourceTree environments={filteredEnvironments} route={route} onNavigate={onNavigate} />
                    ) : null}
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
                                data-oaam-semantic-action="sources.open_settings"
                                data-oaam-semantic-entry="sources.settings.warning"
                                onClick={() => onOpenSettings()}
                            />
                        ) : null}
                        <WorkbenchIconButton
                            className="library-settings-button library-footer-button"
                            icon="settings"
                            label={text("settings.open")}
                            data-oaam-semantic-action="sources.open_settings"
                            data-oaam-semantic-entry="sources.settings.footer"
                            onClick={() => onOpenSettings()}
                        />
                    </div>
                </div>
            </TransientWorkbenchSidebar>
            {sidebarVisible ? (
                <WorkbenchResizeSeparator
                    data-oaam-interaction-entry="features.source-library.source_library_workspace.011"
                    label={text("preferences.left_pane.label")}
                    value={paneWidths.widths.left}
                    minimum={DESKTOP_PANE_WIDTHS.left.minimum}
                    maximum={DESKTOP_PANE_WIDTHS.left.maximum}
                    onPreview={paneWidths.previewLeft}
                    onCommit={paneWidths.commitLeft}
                />
            ) : null}
            <section className="library-workbench">
                <section className="library-main" aria-label={text("sources.workspace.label")}>
                    <header className="library-toolbar">
                        <div className="library-toolbar-copy source-task-title">
                            <h1>{pageTitle}</h1>
                        </div>
                        <div className="library-toolbar-actions">
                            {state.status === "ready" && state.environments.length === 0 ? null : (
                                <button
                                    type="button"
                                    data-oaam-action="start-guided-import"
                                    data-oaam-semantic-action="sources.start_guided_import"
                                    data-oaam-semantic-entry="sources.guided_import.toolbar"
                                    onClick={() => onOpenGuidedImport()}
                                >
                                    {text("sources.find_assets")}
                                </button>
                            )}
                            <WorkbenchIconButton
                                data-oaam-interaction-entry="features.source-library.source_library_workspace.013"
                                className="library-icon-button"
                                icon="refresh"
                                label={
                                    state.status === "ready" && state.stale
                                        ? text("sources.refresh_required")
                                        : text("sources.refresh")
                                }
                                onClick={() => void controller.load()}
                            />
                        </div>
                    </header>
                    <div className="library-main-scroll source-library-main">
                        {state.status === "loading" ? (
                            <StatusPanel compact title={text("sources.loading_title")} busy />
                        ) : state.status === "failed" ? (
                            <StatusPanel compact title={text("sources.failed_title")} tone="danger">
                                <ProtocolDiagnostics
                                    embedded
                                    operationMessage={state.message}
                                    diagnostics={state.diagnostics}
                                    technicalSummary={text("import.ui.technical_details")}
                                />
                                <button
                                    data-oaam-interaction-entry="features.source-library.source_library_workspace.014"
                                    type="button"
                                    onClick={() => void controller.load()}
                                >
                                    {text("common.retry")}
                                </button>
                            </StatusPanel>
                        ) : (
                            <>
                                {state.stale ? (
                                    <WorkbenchNotice tone="warning" role="status">
                                        {text("sources.changed")}
                                    </WorkbenchNotice>
                                ) : null}
                                <ProtocolDiagnostics
                                    diagnostics={state.diagnostics}
                                    technicalSummary={text("import.ui.technical_details")}
                                />
                                {state.environments.length === 0 ? (
                                    <StatusPanel
                                        className="source-library-empty"
                                        compact
                                        title={text("sources.empty_title")}
                                        message={text("sources.empty_copy")}
                                    >
                                        <button
                                            type="button"
                                            data-oaam-action="start-guided-import"
                                            data-oaam-semantic-action="sources.start_guided_import"
                                            data-oaam-semantic-entry="sources.guided_import.empty"
                                            onClick={() => onOpenGuidedImport()}
                                        >
                                            {text("sources.find_assets")}
                                        </button>
                                    </StatusPanel>
                                ) : filteredEnvironments.length === 0 ? (
                                    <StatusPanel
                                        compact
                                        eyebrow={text("sources.eyebrow")}
                                        title={text("sources.no_match_title")}
                                        message={text("sources.no_match_copy")}
                                    >
                                        <button
                                            data-oaam-interaction-entry="features.source-library.source_library_workspace.016"
                                            type="button"
                                            onClick={() => setSearch("")}
                                        >
                                            {text("sources.clear_search")}
                                        </button>
                                    </StatusPanel>
                                ) : route.selection === "source" && selectedSource !== undefined ? (
                                    <section className="source-library-detail">
                                        <header>
                                            <div>
                                                <p className="eyebrow">{text("sources.folder")}</p>
                                                <h2>{sourceLeafLabel(selectedSource)}</h2>
                                            </div>
                                        </header>
                                        <dl>
                                            <div>
                                                <dt>{text("sources.path")}</dt>
                                                <dd>
                                                    <code>{selectedSource.canonicalPath}</code>
                                                </dd>
                                            </div>
                                            <div>
                                                <dt>{text("sources.tools")}</dt>
                                                <dd>
                                                    <WorkbenchTechnicalFact
                                                        data-oaam-interaction-entry="features.source-library.source_library_workspace.017"
                                                        fact={
                                                            <span>
                                                                {selectedSource.tools
                                                                    .map((tool) => tool.displayName ?? unknownTool)
                                                                    .join(" · ")}
                                                            </span>
                                                        }
                                                        summary={text("import.ui.technical_details")}
                                                    >
                                                        {selectedSource.claims.map((claim) => (
                                                            <div
                                                                className="source-library-technical-record"
                                                                key={claim.selectorFingerprint}
                                                            >
                                                                <code>{claim.adapterId}</code>
                                                                <span>
                                                                    {claim.rootRole} · {claim.sourceDomain}
                                                                </span>
                                                            </div>
                                                        ))}
                                                    </WorkbenchTechnicalFact>
                                                </dd>
                                            </div>
                                            <div>
                                                <dt>{text("sources.destination")}</dt>
                                                <dd>
                                                    {selectedSource.destinations.map((destination) => (
                                                        <DestinationLabel
                                                            key={
                                                                destination.scope === "global"
                                                                    ? "global"
                                                                    : `project:${destination.projectId}`
                                                            }
                                                            destination={destination}
                                                        />
                                                    ))}
                                                </dd>
                                            </div>
                                        </dl>
                                    </section>
                                ) : route.selection === "environment" && selectedEnvironment !== undefined ? (
                                    <div className="source-library-groups" data-oaam-source-group-count="1">
                                        <SourceGroup
                                            environment={selectedEnvironment}
                                            unknownTool={unknownTool}
                                            onNavigate={onNavigate}
                                        />
                                    </div>
                                ) : (
                                    <div
                                        className="source-library-groups"
                                        data-oaam-source-group-count={filteredEnvironments.length}
                                    >
                                        {filteredEnvironments.map((environment) => (
                                            <SourceGroup
                                                key={environment.key}
                                                environment={environment}
                                                unknownTool={unknownTool}
                                                onNavigate={onNavigate}
                                            />
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </section>
            </section>
        </main>
    );
}
