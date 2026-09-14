import { projectDisplayName } from "../presentation/project-label";
import {
    type CSSProperties,
    type KeyboardEvent,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import type {
    InstallationRootPickerResult,
    RegisteredProjectRootAuthorizationResult,
    RegisteredProjectRootRevealResult,
} from "../../bridge/desktop-bridge";
import { desktopEnvironmentKey } from "../../desktop-environment-key";
import { DESKTOP_PANE_WIDTHS } from "../../presentation/presentation-preferences";
import type { DesktopApplicationClientApi } from "../client";
import {
    type AssetVersionView,
    CatalogAssetVersionInspector,
    CatalogDeploymentController,
    type CatalogDeploymentState,
    CatalogDeploymentWorkspace,
    type DeploymentWorkspaceSubject,
} from "../features/catalog-deployment";
import {
    type AdapterProviderView,
    DiscoveryController,
    DiscoveryProbeIssues,
    type DiscoveryState,
    presentDiscoveryEnvironment,
    presentDiscoveryPath,
} from "../features/discovery";
import { deriveDiscoveryEnvironmentProbeOutcomes } from "../features/discovery/presentation";
import { ProtocolDiagnostics, useDesktopPaneWidths, useDesktopPresentation } from "../presentation";
import { TransientWorkbenchSidebar } from "../shell/TransientWorkbenchSidebar";
import {
    DesktopIcon,
    StatusPanel,
    WorkbenchCheckButton,
    WorkbenchNotice,
    WorkbenchPanel,
    WorkbenchRadioButton,
    WorkbenchResizeSeparator,
} from "../ui";

export interface DeploymentPageProps {
    readonly client: DesktopApplicationClientApi;
    readonly subject: DeploymentWorkspaceSubject;
    readonly assetId?: string;
    readonly sidebarVisible: boolean;
    readonly pickInstallationRoot: () => Promise<InstallationRootPickerResult>;
    readonly authorizeRegisteredProjectRoot: (projectId: string) => Promise<RegisteredProjectRootAuthorizationResult>;
    readonly revealRegisteredProjectRoot: (projectId: string) => Promise<RegisteredProjectRootRevealResult>;
    readonly onClose: () => void;
    readonly onDeploymentCreated?: (deploymentId: string) => void;
    readonly onOpenAssetUsage?: (assetId: string) => void;
}

type ProjectLocationState =
    | { readonly status: "not_applicable" }
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly displayName: string; readonly displayPath: string }
    | { readonly status: "failed"; readonly failureKind: "request_failed" | "unavailable" };

function ordinaryProjectName(displayName: string, displayPath: string): string {
    if (displayName.trim() === "") return projectDisplayName({ displayName, rootPath: displayPath });
    if (!/^(?:[a-z]:[\\/]|\\\\|\/)/iu.test(displayName)) return displayName;
    return displayPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? displayName;
}

export function DeploymentPage({
    client,
    subject,
    assetId,
    sidebarVisible,
    pickInstallationRoot,
    authorizeRegisteredProjectRoot,
    revealRegisteredProjectRoot,
    onClose,
    onDeploymentCreated,
    onOpenAssetUsage,
}: DeploymentPageProps): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const paneWidths = useDesktopPaneWidths();
    const projectId = subject.subjectKind === "project" ? subject.projectId : undefined;
    const discovery = useMemo(
        () =>
            new DiscoveryController(client, {
                createUserActionId: () => globalThis.crypto.randomUUID(),
                autoProbeWatched: false,
                targetProjectId: projectId,
                purpose: "target_discovery",
            }),
        [client, projectId],
    );
    const catalog = useMemo(
        () => new CatalogDeploymentController(client, { createUserActionId: () => globalThis.crypto.randomUUID() }),
        [client],
    );
    const [discoveryState, setDiscoveryState] = useState<DiscoveryState>(discovery.state);
    const [managementProviders, setManagementProviders] = useState<readonly AdapterProviderView[]>([]);
    const [catalogState, setCatalogState] = useState<CatalogDeploymentState>(catalog.state);
    const [, setViewportRevision] = useState(0);
    const [projectLocation, setProjectLocation] = useState<ProjectLocationState>({
        status: subject.subjectKind === "global" ? "not_applicable" : "loading",
    });
    const [projectLocationRetryRevision, setProjectLocationRetryRevision] = useState(0);
    const [projectAccessFailed, setProjectAccessFailed] = useState(false);
    const [installationRootFailureKey, setInstallationRootFailureKey] = useState("");
    const [assetVersion, setAssetVersion] = useState<AssetVersionView>();
    const targetOperationLock = useRef(false);
    const [targetOperationPending, setTargetOperationPending] = useState(false);
    const beginTargetOperation = useCallback((): boolean => {
        if (targetOperationLock.current) return false;
        targetOperationLock.current = true;
        setTargetOperationPending(true);
        return true;
    }, []);
    const releaseTargetOperation = useCallback((): void => {
        targetOperationLock.current = false;
        setTargetOperationPending(false);
    }, []);
    useLayoutEffect(() => {
        const observeViewport = (): void => setViewportRevision((current) => current + 1);
        observeViewport();
        const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(observeViewport);
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
    const assetDetail =
        catalogState.status === "ready" && catalogState.assetDetail.status !== "none" ? catalogState.assetDetail : undefined;
    const currentVersionId =
        assetId === undefined || catalogState.status !== "ready"
            ? undefined
            : catalogState.assets.find((asset) => asset.assetId === assetId)?.currentVersionId;

    useEffect(() => {
        let current = true;
        setAssetVersion(undefined);
        if (assetId === undefined || currentVersionId === undefined) {
            return () => {
                current = false;
            };
        }
        void client.getAssetVersion({ assetId, versionId: currentVersionId }).then((result) => {
            if (!current || result.status === "failed" || !result.value.found) return;
            if (result.value.value.assetId !== assetId || result.value.value.versionId !== currentVersionId) return;
            setAssetVersion(result.value.value);
        });
        return () => {
            current = false;
        };
    }, [assetId, client, currentVersionId]);

    useEffect(() => {
        if (assetId === undefined) return;
        const unsubscribe = discovery.subscribe(setDiscoveryState);
        void discovery.load();
        return () => {
            unsubscribe();
            discovery.dispose();
        };
    }, [assetId, discovery]);

    useEffect(() => {
        setManagementProviders([]);
        if (assetId !== undefined) return;
        let current = true;
        void client
            .listAdapterProviders()
            .then((result) => {
                if (current && result.status === "complete") setManagementProviders(result.value.providers);
            })
            .catch(() => undefined);
        return () => {
            current = false;
        };
    }, [assetId, client]);

    useEffect(() => catalog.subscribe(setCatalogState), [catalog]);

    useEffect(() => {
        setProjectAccessFailed(false);
        if (projectId === undefined) {
            setProjectLocation({ status: "not_applicable" });
            return;
        }
        if (projectLocationRetryRevision > 0) {
            setProjectLocation({ status: "loading" });
        }
        let current = true;
        setProjectLocation({ status: "loading" });
        void client
            .getProject({ projectId })
            .then((result) => {
                if (!current) return;
                if (result.status !== "complete") {
                    setProjectLocation({ status: "failed", failureKind: "request_failed" });
                    return;
                }
                if (!result.value.found || result.value.value.deleted) {
                    setProjectLocation({ status: "failed", failureKind: "unavailable" });
                    return;
                }
                setProjectLocation({
                    status: "ready",
                    displayName: result.value.value.displayName,
                    displayPath: result.value.value.rootPath,
                });
            })
            .catch(() => {
                if (current) setProjectLocation({ status: "failed", failureKind: "request_failed" });
            });
        return () => {
            current = false;
        };
    }, [client, projectId, projectLocationRetryRevision]);

    function loadProjectLocationAgain(): void {
        setProjectLocationRetryRevision((current) => current + 1);
    }

    useEffect(() => {
        if (targetOperationPending && catalogState.status === "failed") releaseTargetOperation();
    }, [catalogState.status, releaseTargetOperation, targetOperationPending]);

    async function discoverProjectTarget(): Promise<boolean> {
        if (projectId === undefined || projectLocation.status !== "ready") return false;
        setProjectAccessFailed(false);
        try {
            const authorization = await authorizeRegisteredProjectRoot(projectId);
            if (authorization.status !== "authorized") {
                setProjectAccessFailed(true);
                return false;
            }
            setProjectLocation({ ...projectLocation, displayPath: authorization.displayPath });
            return discovery.probeProject(authorization.localPathSelectionToken);
        } catch {
            setProjectAccessFailed(true);
            return false;
        }
    }

    async function probeSelectedTargets(): Promise<void> {
        if (!beginTargetOperation()) return;
        const completed = projectId === undefined ? await discovery.probe() : await discoverProjectTarget();
        if (!completed) releaseTargetOperation();
    }

    async function revealProjectTarget(): Promise<void> {
        if (projectId === undefined || projectLocation.status !== "ready") return;
        setProjectAccessFailed(false);
        try {
            const result = await revealRegisteredProjectRoot(projectId);
            if (result.status !== "complete") setProjectAccessFailed(true);
        } catch {
            setProjectAccessFailed(true);
        }
    }

    const revealableAssetSourceRootIds =
        projectId === undefined || projectLocation.status !== "ready"
            ? []
            : (assetVersion?.importSource?.roots
                  .filter(
                      (root) =>
                          root.rootRole === "project_actual" &&
                          root.sourceDomain === "project_root" &&
                          root.canonicalPath === projectLocation.displayPath,
                  )
                  .map((root) => root.sourceRootId) ?? []);

    async function revealAssetSourceRoot(sourceRootId: string): Promise<{ readonly status: "complete" | "failed" }> {
        const root = assetVersion?.importSource?.roots.find((candidate) => candidate.sourceRootId === sourceRootId);
        if (
            projectId === undefined ||
            projectLocation.status !== "ready" ||
            root?.rootRole !== "project_actual" ||
            root.sourceDomain !== "project_root" ||
            root.canonicalPath !== projectLocation.displayPath
        ) {
            return { status: "failed" };
        }
        return revealRegisteredProjectRoot(projectId);
    }

    async function discoverInstallationRoot(
        adapterId: string,
        environment: { readonly platform: "darwin" | "linux" | "win32" | "wsl"; readonly platformInstanceId: string },
    ): Promise<void> {
        if (!beginTargetOperation()) return;
        const failureKey = `${desktopEnvironmentKey(environment)}\0${adapterId}`;
        setInstallationRootFailureKey("");
        let completed = false;
        try {
            let projectRootSelectionToken: string | undefined;
            if (projectId !== undefined) {
                if (projectLocation.status !== "ready") {
                    setInstallationRootFailureKey(failureKey);
                    return;
                }
                const authorization = await authorizeRegisteredProjectRoot(projectId);
                if (authorization.status !== "authorized") {
                    setInstallationRootFailureKey(failureKey);
                    return;
                }
                projectRootSelectionToken = authorization.localPathSelectionToken;
                setProjectLocation({ ...projectLocation, displayPath: authorization.displayPath });
            }
            const selected = await pickInstallationRoot();
            if (selected.status !== "selected") return;
            const found = await discovery.probeInstallationRoot(
                adapterId,
                environment,
                selected.localPathSelectionToken,
                projectRootSelectionToken,
            );
            if (!found) setInstallationRootFailureKey(failureKey);
            completed = found;
        } catch {
            setInstallationRootFailureKey(failureKey);
        } finally {
            if (!completed) releaseTargetOperation();
        }
    }

    let targetDiscovery: React.JSX.Element;
    if (discoveryState.status === "loading") {
        targetDiscovery = (
            <div className="deployment-target-discovery" data-oaam-state="loading">
                <StatusPanel
                    compact
                    eyebrow={text("catalog.ui.target.eyebrow")}
                    title={text("catalog.ui.target.loading")}
                    message={displayText(discoveryState.message)}
                    busy
                />
            </div>
        );
    } else if (discoveryState.status === "failed") {
        targetDiscovery = (
            <div className="deployment-target-discovery" data-oaam-state="failed">
                <StatusPanel
                    compact
                    eyebrow={text("catalog.ui.target.eyebrow")}
                    title={text("catalog.ui.target.unavailable")}
                    message={displayText(discoveryState.message)}
                    tone="danger"
                >
                    <ProtocolDiagnostics
                        embedded
                        diagnostics={discoveryState.diagnostics}
                        technicalSummary={text("import.ui.technical_details")}
                    />
                    <button
                        data-oaam-interaction-entry="pages.deployment_page.001"
                        type="button"
                        onClick={() => void discovery.load()}
                    >
                        {text("common.retry")}
                    </button>
                </StatusPanel>
            </div>
        );
    } else {
        const probing = discoveryState.activity === "probing";
        const relationshipBusy =
            catalogState.status === "ready" &&
            (catalogState.assetUsage.status === "loading" || catalogState.activity.status !== "idle");
        const targetBusy = targetOperationPending || probing || discoveryState.activity === "saving" || relationshipBusy;
        const guardTargetActionKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
            if ((targetBusy || event.repeat) && (event.key === " " || event.key === "Enter")) event.preventDefault();
        };
        const providerAuthorizationRequired = discovery.targetProbeAuthorizationRequired();
        const selectedProviderIds = new Set(discoveryState.selectedAdapterIds);
        const probeOutcomes =
            discoveryState.probeReview === undefined ? [] : deriveDiscoveryEnvironmentProbeOutcomes(discoveryState.probeReview);
        const hasProbeIssues = probeOutcomes.some((outcome) => outcome.tools.some((tool) => tool.diagnostics.length > 0));
        const selectedEnvironment = discoveryState.environments.find((entry) =>
            discoveryState.selectedEnvironmentKeys.includes(desktopEnvironmentKey(entry.environment)),
        );
        const displayedProjectPath =
            projectLocation.status === "ready" && selectedEnvironment !== undefined
                ? presentDiscoveryPath(projectLocation.displayPath, selectedEnvironment.environment)
                : projectLocation.status === "ready"
                  ? projectLocation.displayPath
                  : undefined;
        const projectLocationCopy =
            projectLocation.status === "ready"
                ? text("catalog.ui.target.path", {
                      name: ordinaryProjectName(projectLocation.displayName, displayedProjectPath ?? ""),
                      path: displayedProjectPath ?? "",
                  })
                : undefined;
        targetDiscovery = (
            <WorkbenchPanel
                surface="section"
                className="deployment-target-discovery"
                aria-labelledby="deployment-target-title"
                data-oaam-target-probe-activity={discoveryState.activity}
            >
                <div className="section-heading">
                    <div>
                        <p className="eyebrow">{text("catalog.ui.target.eyebrow")}</p>
                        <h2 id="deployment-target-title">{text("catalog.ui.target.title")}</h2>
                    </div>
                </div>
                <p className="section-copy deployment-target-copy">
                    {text(projectId === undefined ? "catalog.ui.target.copy_global" : "catalog.ui.target.copy")}
                </p>
                <div className="deployment-target-context">
                    <fieldset className="deployment-target-providers" aria-labelledby="deployment-target-provider-label">
                        <div className="deployment-target-selection-heading">
                            <span id="deployment-target-provider-label">{text("catalog.ui.target.providers")}</span>
                            {discoveryState.providers.length === 0 ? null : (
                                <span className="deployment-target-selection-actions">
                                    {[
                                        { selected: true, label: text("catalog.ui.target.select_all") },
                                        { selected: false, label: text("catalog.ui.target.clear_all") },
                                    ].map((action) => (
                                        <button
                                            data-oaam-interaction-entry="pages.deployment_page.012"
                                            key={String(action.selected)}
                                            type="button"
                                            className="library-secondary-button"
                                            disabled={
                                                targetBusy ||
                                                (action.selected
                                                    ? discoveryState.selectedAdapterIds.length === discoveryState.providers.length
                                                    : discoveryState.selectedAdapterIds.length === 0)
                                            }
                                            onClick={() => discovery.setAllProvidersSelected(action.selected)}
                                        >
                                            {action.label}
                                        </button>
                                    ))}
                                </span>
                            )}
                        </div>
                        {discoveryState.providers.length === 0 ? (
                            <span>{text("catalog.ui.target.no_provider")}</span>
                        ) : (
                            discoveryState.providers.map((provider) => (
                                <WorkbenchCheckButton
                                    data-oaam-interaction-entry="pages.deployment_page.002"
                                    data-oaam-provider-id={provider.adapterId}
                                    key={provider.adapterId}
                                    checked={selectedProviderIds.has(provider.adapterId)}
                                    disabled={targetBusy}
                                    onCheckedChange={() => discovery.toggleProvider(provider.adapterId)}
                                >
                                    {provider.displayName}
                                </WorkbenchCheckButton>
                            ))
                        )}
                    </fieldset>
                    <fieldset className="deployment-target-environments" aria-labelledby="deployment-target-environment-label">
                        <div className="deployment-target-selection-heading" id="deployment-target-environment-label">
                            {text("catalog.ui.target.environments")}
                        </div>
                        {discoveryState.environments.map((entry) => {
                            const key = desktopEnvironmentKey(entry.environment);
                            const checked = discoveryState.selectedEnvironmentKeys.includes(key);
                            const selectable = discovery.isEnvironmentSelectable(key);
                            return discovery.projectEnvironmentConstrained ? (
                                <WorkbenchRadioButton
                                    data-oaam-interaction-entry="pages.deployment_page.003"
                                    key={key}
                                    checked={checked}
                                    disabled={targetBusy || !selectable}
                                    name="deployment-project-environment"
                                    value={key}
                                    onCheckedChange={() => discovery.toggleEnvironment(key)}
                                >
                                    {displayText(presentDiscoveryEnvironment(entry.environment))}
                                </WorkbenchRadioButton>
                            ) : (
                                <WorkbenchCheckButton
                                    data-oaam-interaction-entry="pages.deployment_page.004"
                                    key={key}
                                    checked={checked}
                                    disabled={targetBusy || !selectable}
                                    onCheckedChange={() => discovery.toggleEnvironment(key)}
                                >
                                    {displayText(presentDiscoveryEnvironment(entry.environment))}
                                </WorkbenchCheckButton>
                            );
                        })}
                    </fieldset>
                </div>
                <div className="deployment-target-status">
                    <div className="deployment-target-project-context">
                        {projectLocation.status === "loading" ? (
                            <p role="status">{text("catalog.ui.target.project_loading")}</p>
                        ) : projectLocation.status === "ready" ? (
                            <p className="deployment-target-project-identity" title={projectLocationCopy}>
                                {projectLocationCopy}
                            </p>
                        ) : projectLocation.status === "failed" && projectLocation.failureKind === "request_failed" ? (
                            <div
                                data-oaam-visible-state="deployment_project_location_unavailable"
                                data-oaam-state-presentation="action_required"
                                data-oaam-state-blocking-scope="current_panel"
                                data-oaam-state-persistence="transient"
                            >
                                <WorkbenchNotice tone="danger" role="alert">
                                    {text("catalog.ui.target.project_load_failed")}
                                </WorkbenchNotice>
                                <div className="status-card-actions">
                                    <button
                                        data-oaam-interaction-entry="pages.deployment_page.011"
                                        data-oaam-visible-state-action="retry_project_location"
                                        type="button"
                                        onClick={loadProjectLocationAgain}
                                    >
                                        {text("common.retry")}
                                    </button>
                                </div>
                            </div>
                        ) : projectLocation.status === "failed" ? (
                            <WorkbenchNotice tone="danger" role="alert">
                                {text("catalog.ui.target.project_unavailable")}
                            </WorkbenchNotice>
                        ) : null}
                        {projectAccessFailed ? (
                            <WorkbenchNotice tone="danger" role="alert">
                                {text("catalog.ui.target.picker_failed")}
                            </WorkbenchNotice>
                        ) : null}
                    </div>
                    <div className="deployment-target-result">
                        {discoveryState.message === undefined ||
                        (discoveryState.probeProgress !== undefined &&
                            discoveryState.message.kind === "localized" &&
                            (discoveryState.message.id === "discovery.snapshot_refreshed" ||
                                (discoveryState.message.id === "discovery.complete_with_warnings" &&
                                    hasProbeIssues))) ? null : discoveryState.activity === "probe_failed" ? (
                            <WorkbenchNotice tone="danger" role="alert">
                                {displayText(discoveryState.message)}
                            </WorkbenchNotice>
                        ) : (
                            <p role="status">
                                {discoveryState.message.kind === "localized" &&
                                discoveryState.message.id === "discovery.complete_with_warnings"
                                    ? text("catalog.ui.target.partial")
                                    : displayText(discoveryState.message)}
                            </p>
                        )}
                        {discoveryState.probeProgress === undefined ? null : (
                            <div
                                className="deployment-target-probe-progress"
                                role="status"
                                aria-busy={probing}
                                data-oaam-completed-units={discoveryState.probeProgress.completedUnits}
                                data-oaam-total-units={discoveryState.probeProgress.totalUnits}
                            >
                                {probing ? (
                                    <span className="status-card-spinner" data-oaam-loading-indicator>
                                        <DesktopIcon name="loading" size={17} />
                                    </span>
                                ) : null}
                                <strong>
                                    {text("catalog.ui.target.progress", {
                                        completed: discoveryState.probeProgress.completedUnits,
                                        total: discoveryState.probeProgress.totalUnits,
                                    })}
                                </strong>
                            </div>
                        )}
                        <DiscoveryProbeIssues
                            outcomes={probeOutcomes}
                            providers={discoveryState.providers}
                            summaryCopy={text("catalog.ui.target.notes_copy")}
                        />
                    </div>
                    {providerAuthorizationRequired ? (
                        <p className="deployment-target-enablement-copy">{text("catalog.ui.target.enablement_persists")}</p>
                    ) : null}
                    <div className="deployment-target-actions">
                        {projectId === undefined ? null : (
                            <button
                                data-oaam-interaction-entry="pages.deployment_page.005"
                                type="button"
                                className="library-secondary-button"
                                disabled={targetBusy || projectLocation.status !== "ready"}
                                onClick={() => void revealProjectTarget()}
                            >
                                {text("catalog.ui.target.open_project")}
                            </button>
                        )}
                        {providerAuthorizationRequired ? (
                            <button
                                data-oaam-interaction-entry="pages.deployment_page.013"
                                type="button"
                                data-oaam-target-action="authorize_local_check"
                                aria-disabled={targetBusy || undefined}
                                onKeyDown={guardTargetActionKey}
                                onClick={() => {
                                    if (!targetBusy) void discovery.authorizeSelectedProvidersForTargetProbe();
                                }}
                            >
                                {text("catalog.ui.target.enable_selected")}
                            </button>
                        ) : (
                            <button
                                data-oaam-interaction-entry="pages.deployment_page.006"
                                type="button"
                                data-oaam-target-action="probe"
                                aria-disabled={targetBusy || undefined}
                                onKeyDown={guardTargetActionKey}
                                disabled={
                                    discoveryState.selectedAdapterIds.length === 0 ||
                                    discoveryState.selectedEnvironmentKeys.length === 0 ||
                                    (projectId !== undefined && projectLocation.status !== "ready")
                                }
                                onClick={() => {
                                    if (!targetBusy) void probeSelectedTargets();
                                }}
                            >
                                {text(
                                    probing
                                        ? "catalog.ui.target.probing"
                                        : projectId === undefined
                                          ? "catalog.ui.target.discover_global"
                                          : "catalog.ui.target.choose_project",
                                )}
                            </button>
                        )}
                    </div>
                </div>
            </WorkbenchPanel>
        );
    }

    const displayedProviders =
        assetId === undefined ? managementProviders : discoveryState.status === "ready" ? discoveryState.providers : [];

    return (
        <main
            className="project-library-shell deployment-workbench-shell"
            data-oaam-route="deployment"
            data-oaam-state={assetId === undefined ? catalogState.status : discoveryState.status}
            data-oaam-deployment-mode={assetId === undefined ? "manage" : "create"}
            data-oaam-asset-id={assetId}
            data-oaam-subject={subject.subjectKind}
            data-oaam-project-id={subject.subjectKind === "project" ? subject.projectId : undefined}
            data-sidebar-open={sidebarVisible}
            style={{ "--oaam-left-pane-width": `${paneWidths.widths.left}px` } as CSSProperties}
        >
            <TransientWorkbenchSidebar
                data-oaam-interaction-entry="pages.deployment_page.007"
                className="library-sidebar deployment-sidebar"
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
                <div className="deployment-sidebar-content">
                    <button
                        type="button"
                        className="workbench-sidebar-return deployment-library-back"
                        data-oaam-semantic-action="deployment.open_library"
                        data-oaam-semantic-entry="deployment.library.sidebar"
                        onClick={() => onClose()}
                    >
                        <DesktopIcon name="back" size={15} />
                        {text("catalog.ui.workspace.back")}
                    </button>
                    <div className="deployment-sidebar-summary">
                        <span>{text("catalog.ui.workspace.eyebrow")}</span>
                        <strong>
                            {text(assetId === undefined ? "catalog.ui.workspace.manage" : "catalog.ui.workspace.create")}
                        </strong>
                    </div>
                </div>
                <div className="library-sidebar-footer">
                    <div className="library-host-status" role="status">
                        <span className="status-dot" aria-hidden="true" />
                        <strong>{text("app.host.running")}</strong>
                    </div>
                </div>
            </TransientWorkbenchSidebar>
            {sidebarVisible ? (
                <WorkbenchResizeSeparator
                    data-oaam-interaction-entry="pages.deployment_page.009"
                    label={text("preferences.left_pane.label")}
                    value={paneWidths.widths.left}
                    minimum={DESKTOP_PANE_WIDTHS.left.minimum}
                    maximum={DESKTOP_PANE_WIDTHS.left.maximum}
                    onPreview={paneWidths.previewLeft}
                    onCommit={paneWidths.commitLeft}
                />
            ) : null}
            <section
                className="library-workbench deployment-workbench"
                data-inspector-open={assetDetail !== undefined}
                style={{ "--oaam-right-pane-width": `${rightPaneWidth}px` } as CSSProperties}
            >
                <div className="workspace-shell deployment-page">
                    <CatalogDeploymentWorkspace
                        controller={catalog}
                        subject={subject}
                        initialAssetId={assetId}
                        targetDiscovery={assetId === undefined ? undefined : targetDiscovery}
                        probeReview={discoveryState.status === "ready" ? discoveryState.probeReview : undefined}
                        providers={displayedProviders}
                        assetImportSource={assetVersion?.importSource}
                        installationLocationBusy={
                            targetOperationPending ||
                            (discoveryState.status === "ready" &&
                                (discoveryState.activity === "saving" || discoveryState.activity === "probing"))
                        }
                        installationRootFailureKey={installationRootFailureKey}
                        onChooseInstallationRoot={(adapterId, environment) =>
                            void discoverInstallationRoot(adapterId, environment)
                        }
                        onRelationshipAnalysisSettled={releaseTargetOperation}
                        onDeploymentCreated={onDeploymentCreated}
                        onOpenAssetUsage={onOpenAssetUsage}
                        onOpenLibrary={onClose}
                    />
                </div>
                {assetDetail === undefined ? null : (
                    <>
                        <WorkbenchResizeSeparator
                            data-oaam-interaction-entry="pages.deployment_page.010"
                            label={text("preferences.right_pane.label")}
                            value={rightPaneWidth}
                            minimum={DESKTOP_PANE_WIDTHS.right.minimum}
                            maximum={maximumRightPaneWidth}
                            direction={-1}
                            onPreview={paneWidths.previewRight}
                            onCommit={paneWidths.commitRight}
                        />
                        <CatalogAssetVersionInspector
                            controller={catalog}
                            detail={assetDetail}
                            importSource={assetVersion?.importSource}
                            providers={displayedProviders}
                            revealableSourceRootIds={revealableAssetSourceRootIds}
                            onRevealSourceRoot={revealableAssetSourceRootIds.length === 0 ? undefined : revealAssetSourceRoot}
                        />
                    </>
                )}
            </section>
        </main>
    );
}
