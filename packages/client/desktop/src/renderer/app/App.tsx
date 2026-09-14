import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { PROTOCOL_PORT_SIGNAL } from "../../bridge/desktop-bridge";
import type { BrowserProtocolPort, DesktopSession, DesktopSessionState } from "../client";
import { supportsCatalogSearch } from "../features/catalog-search/model";
import { assetLibraryRoute, supportsProjectRegistration } from "../features/project-library/model";
import { type DesktopMessageId, useDesktopPresentation } from "../presentation";
import { DesktopWindowFrame, type DesktopWindowFrameProps } from "../shell/DesktopWindowFrame";
import { StatusPanel, WorkbenchTechnicalFact } from "../ui";
import {
    canMoveWorkbenchHistory,
    createWorkbenchNavigation,
    currentWorkbenchRoute,
    leaveWorkbenchSettings,
    moveWorkbenchHistory,
    pushWorkbenchRoute,
    replaceWorkbenchRoute,
    type WorkbenchLibraryRoute,
    type WorkbenchRoute,
    type WorkbenchSourcesRoute,
} from "./workbench-navigation";

const OnboardingPage = lazy(async () => {
    const page = await import("../pages/OnboardingPage");
    return { default: page.OnboardingPage };
});
const GuidedImportPage = lazy(async () => {
    const page = await import("../pages/GuidedImportPage");
    return { default: page.GuidedImportPage };
});
const SettingsPage = lazy(async () => {
    const page = await import("../pages/SettingsPage");
    return { default: page.SettingsPage };
});
const WorkspacePage = lazy(async () => {
    const page = await import("../pages/WorkspacePage");
    return { default: page.WorkspacePage };
});
const CatalogSearchOverlay = lazy(async () => {
    const search = await import("../features/catalog-search/overlay");
    return { default: search.CatalogSearchOverlay };
});

export interface AppProps {
    readonly session: DesktopSession;
    readonly browserWindow?: Window;
}

export function App({ session, browserWindow = window }: AppProps): React.JSX.Element {
    const { snapshot, text } = useDesktopPresentation();
    const [state, setState] = useState<DesktopSessionState>(session.state);
    const [searchOpen, setSearchOpen] = useState(false);
    const [navigation, setNavigation] = useState(() => createWorkbenchNavigation({ surface: "library", subject: "projects" }));
    const [sidebarVisible, setSidebarVisible] = useState(true);
    const [inspectorVisible, setInspectorVisible] = useState(false);
    const [projectRegistrationRequestId, setProjectRegistrationRequestId] = useState<number>();
    const [diagnosticsOpening, setDiagnosticsOpening] = useState(false);
    const [diagnosticsOpenFailed, setDiagnosticsOpenFailed] = useState(false);
    const nextProjectRegistrationRequestId = useRef(0);
    const guidedImportLeaveGuard = useRef<(() => Promise<boolean>) | undefined>(undefined);
    const route = currentWorkbenchRoute(navigation);
    const lastLibraryRoute = useRef<WorkbenchLibraryRoute>({ surface: "library", subject: "projects" });
    const lastSourcesRoute = useRef<WorkbenchSourcesRoute>({ surface: "sources", selection: "all" });
    if (route.surface === "library") lastLibraryRoute.current = route;
    if (route.surface === "sources") lastSourcesRoute.current = route;

    function navigate(nextRoute: WorkbenchRoute): void {
        if (nextRoute.surface === "library" && nextRoute.assetId !== undefined) setInspectorVisible(true);
        setNavigation((current) => pushWorkbenchRoute(current, nextRoute));
    }

    function replaceRoute(nextRoute: WorkbenchRoute): void {
        setNavigation((current) =>
            currentWorkbenchRoute(current) === route ? replaceWorkbenchRoute(current, nextRoute) : current,
        );
    }

    const moveHistory = useCallback((direction: "back" | "forward"): void => {
        setNavigation((current) => moveWorkbenchHistory(current, direction));
    }, []);

    const moveHistoryAfterLeaveGuard = useCallback(
        async (direction: "back" | "forward"): Promise<void> => {
            if (route.surface === "guided_import") {
                const leaveGuard = guidedImportLeaveGuard.current;
                if (leaveGuard !== undefined && !(await leaveGuard())) return;
            }
            moveHistory(direction);
        },
        [moveHistory, route.surface],
    );

    const registerGuidedImportLeaveGuard = useCallback((leaveGuard: (() => Promise<boolean>) | undefined): void => {
        guidedImportLeaveGuard.current = leaveGuard;
    }, []);

    function closeSettings(): void {
        setNavigation((current) => leaveWorkbenchSettings(current, lastLibraryRoute.current));
    }

    const ordinaryWorkbench = snapshot.preferences.onboardingCompleted;
    const applicationClient = session.applicationClient;
    const searchAvailable =
        ordinaryWorkbench &&
        route.surface !== "guided_import" &&
        route.surface !== "sources" &&
        applicationClient !== undefined &&
        supportsCatalogSearch(applicationClient);
    const searchOverlay =
        searchOpen && searchAvailable && applicationClient !== undefined ? (
            <Suspense fallback={null}>
                <CatalogSearchOverlay
                    client={applicationClient}
                    currentLibraryRoute={route.surface === "library" ? route : undefined}
                    onClose={() => setSearchOpen(false)}
                    onNavigate={(nextRoute) => {
                        setSearchOpen(false);
                        navigate(nextRoute);
                    }}
                />
            </Suspense>
        ) : undefined;
    const frame = (
        content: React.JSX.Element,
        canOpenSettings = false,
        projectRegistration?: DesktopWindowFrameProps["projectRegistration"],
    ): React.JSX.Element => {
        const libraryRoute = ordinaryWorkbench && route.surface === "library" ? route : undefined;
        const sourcesRoute = ordinaryWorkbench && route.surface === "sources" ? route : undefined;
        const settingsRoute = ordinaryWorkbench && route.surface === "settings" ? route : undefined;
        const deploymentRoute = ordinaryWorkbench && route.surface === "deployment" ? route : undefined;
        return (
            <DesktopWindowFrame
                canOpenSettings={canOpenSettings}
                overlay={searchOverlay}
                onOpenSettings={() => navigate({ surface: "settings", category: "general" })}
                projectRegistration={projectRegistration}
                navigation={
                    ordinaryWorkbench
                        ? {
                              canGoBack: canMoveWorkbenchHistory(navigation, "back"),
                              canGoForward: canMoveWorkbenchHistory(navigation, "forward"),
                              onBack: () => void moveHistoryAfterLeaveGuard("back"),
                              onForward: () => void moveHistoryAfterLeaveGuard("forward"),
                          }
                        : undefined
                }
                sidebar={
                    libraryRoute === undefined &&
                    sourcesRoute === undefined &&
                    settingsRoute === undefined &&
                    deploymentRoute === undefined
                        ? undefined
                        : {
                              visible: sidebarVisible,
                              onToggle: () => setSidebarVisible((current) => !current),
                          }
                }
                inspector={
                    libraryRoute === undefined
                        ? undefined
                        : {
                              available: libraryRoute.assetId !== undefined,
                              visible: libraryRoute.assetId !== undefined && inspectorVisible,
                              onToggle: () => setInspectorVisible((current) => !current),
                          }
                }
            >
                {content}
            </DesktopWindowFrame>
        );
    };
    useEffect(() => {
        const unsubscribe = session.subscribe(setState);
        const receivePort = (event: MessageEvent<unknown>): void => {
            if (event.source !== browserWindow || event.data !== PROTOCOL_PORT_SIGNAL || event.ports.length !== 1) {
                return;
            }
            session.attach(event.ports[0] as BrowserProtocolPort);
        };
        browserWindow.addEventListener("message", receivePort);
        return () => {
            browserWindow.removeEventListener("message", receivePort);
            unsubscribe();
            session.close();
        };
    }, [browserWindow, session]);
    useEffect(() => {
        const openSearch = (event: KeyboardEvent): void => {
            if (!searchAvailable || (!event.ctrlKey && !event.metaKey) || event.key.toLocaleLowerCase("en-US") !== "k") {
                return;
            }
            event.preventDefault();
            setSearchOpen(true);
        };
        browserWindow.addEventListener("keydown", openSearch);
        return () => browserWindow.removeEventListener("keydown", openSearch);
    }, [browserWindow, searchAvailable]);
    useEffect(() => {
        const moveWithAuxiliaryMouseButton = (event: MouseEvent): void => {
            const direction = event.button === 3 ? "back" : event.button === 4 ? "forward" : undefined;
            if (direction === undefined) return;
            event.preventDefault();
            if (!ordinaryWorkbench || !canMoveWorkbenchHistory(navigation, direction)) return;
            void moveHistoryAfterLeaveGuard(direction);
        };
        browserWindow.addEventListener("mouseup", moveWithAuxiliaryMouseButton);
        return () => browserWindow.removeEventListener("mouseup", moveWithAuxiliaryMouseButton);
    }, [browserWindow, moveHistoryAfterLeaveGuard, navigation, ordinaryWorkbench]);
    useEffect(() => {
        if (!searchAvailable) setSearchOpen(false);
    }, [searchAvailable]);

    async function openHostDiagnostics(): Promise<void> {
        setDiagnosticsOpening(true);
        setDiagnosticsOpenFailed(false);
        try {
            const outcome = await session.openDiagnostics();
            setDiagnosticsOpenFailed(outcome.status === "failed");
        } catch {
            setDiagnosticsOpenFailed(true);
        } finally {
            setDiagnosticsOpening(false);
        }
    }

    function failedSurface(
        message: DesktopMessageId,
        reasonCode: string,
        stateName: string,
        title: DesktopMessageId = "app.failed.title",
        eyebrow: DesktopMessageId = "app.failed.eyebrow",
    ): React.JSX.Element {
        return frame(
            <main className="centered-shell" data-oaam-route="startup" data-oaam-state={stateName}>
                <StatusPanel eyebrow={text(eyebrow)} title={text(title)} message={text(message)} tone="danger">
                    {reasonCode.trim() === "" ? null : (
                        <WorkbenchTechnicalFact
                            data-oaam-interaction-entry="app.app.001"
                            fact={<span>{text("app.failed.reason")}</span>}
                            summary={text("import.ui.technical_details")}
                        >
                            <p className="host-failure-reason">
                                {text("app.failed.reason")} <code>{reasonCode}</code>
                            </p>
                        </WorkbenchTechnicalFact>
                    )}
                    {diagnosticsOpenFailed ? (
                        <p className="host-diagnostics-failure" role="alert">
                            {text("settings.maintenance.location.action_failed")}
                        </p>
                    ) : null}
                    <div className="status-card-actions">
                        <button
                            data-oaam-interaction-entry="app.app.002"
                            type="button"
                            onClick={() => {
                                setDiagnosticsOpenFailed(false);
                                void session.retry();
                            }}
                        >
                            {text("common.retry")}
                        </button>
                        <button
                            data-oaam-interaction-entry="app.app.003"
                            type="button"
                            disabled={diagnosticsOpening}
                            onClick={() => void openHostDiagnostics()}
                        >
                            {text("settings.maintenance.location.ordinary_logs")}
                        </button>
                    </div>
                </StatusPanel>
            </main>,
        );
    }

    if (state.status === "starting") {
        const reconnecting = state.phase === "reconnecting";
        return frame(
            <main
                className="centered-shell"
                aria-busy="true"
                data-oaam-route="startup"
                data-oaam-state={reconnecting ? "reconnecting" : "starting"}
            >
                <StatusPanel
                    eyebrow={text("app.starting.eyebrow")}
                    title={text(reconnecting ? "app.reconnecting.title" : "app.starting.title")}
                    message={text(state.message)}
                    busy
                >
                    {reconnecting && state.reasonCode.trim() !== "" ? (
                        <WorkbenchTechnicalFact
                            data-oaam-interaction-entry="app.app.004"
                            fact={<span>{text("app.failed.reason")}</span>}
                            summary={text("import.ui.technical_details")}
                        >
                            <p className="host-failure-reason">
                                {text("app.failed.reason")} <code>{state.reasonCode}</code>
                            </p>
                        </WorkbenchTechnicalFact>
                    ) : null}
                </StatusPanel>
            </main>,
        );
    }
    if (state.status === "failed") {
        return failedSurface(state.message, state.reasonCode, "failed");
    }
    if (applicationClient === undefined) {
        return failedSurface(
            "app.client_unavailable.message",
            "session.client_unavailable",
            "client_unavailable",
            "app.client_unavailable.title",
            "app.client_unavailable.eyebrow",
        );
    }
    const loadingSurface = (
        <main className="centered-shell" aria-busy="true" data-oaam-route="startup" data-oaam-state="surface_loading">
            <StatusPanel
                eyebrow={text("app.starting.eyebrow")}
                title={text("app.starting.title")}
                message={text("session.connecting")}
                busy
            />
        </main>
    );
    if (state.mode === "state_recovery") {
        return frame(
            <Suspense fallback={loadingSurface}>
                <SettingsPage
                    category="backup_recovery"
                    client={applicationClient}
                    desktopBridge={session.desktopBridge}
                    sidebarVisible={false}
                    onCategoryChange={() => undefined}
                    onClose={() => undefined}
                    onOpenGuidedImport={() => undefined}
                    onInterfaceDefaultsRestored={() => {
                        setSidebarVisible(true);
                        setInspectorVisible(false);
                    }}
                    recoveryReason={state.recoveryReason}
                />
            </Suspense>,
        );
    }
    const projectRegistration =
        ordinaryWorkbench && supportsProjectRegistration(applicationClient)
            ? {
                  available: projectRegistrationRequestId === undefined,
                  request: () => {
                      const requestId = nextProjectRegistrationRequestId.current + 1;
                      nextProjectRegistrationRequestId.current = requestId;
                      setProjectRegistrationRequestId(requestId);
                      navigate({ surface: "library", subject: "projects" });
                  },
              }
            : undefined;
    const openImportedAsset = async (assetId: string, versionId: string): Promise<void> => {
        const result = await applicationClient.getAsset({ assetId });
        if (result.status === "failed" || !result.value.found) throw new Error("Imported Asset is unavailable");
        const asset = result.value.value;
        navigate({ ...assetLibraryRoute(asset), versionId });
    };
    if (!snapshot.preferences.onboardingCompleted) {
        return frame(
            <Suspense fallback={loadingSurface}>
                <OnboardingPage
                    client={applicationClient}
                    assetCount={state.assetCount}
                    preferredProjectId={snapshot.preferences.lastSelectedProjectId}
                    authorizeObservedProjectRoot={(reference) => session.authorizeObservedProjectRoot(reference)}
                    revealObservedProjectRoot={(reference) => session.revealObservedProjectRoot(reference)}
                    authorizeRegisteredProjectRoot={(projectId) => session.authorizeRegisteredProjectRoot(projectId)}
                    revealImportPreviewFile={(reference) => session.revealImportPreviewFile(reference)}
                    onCatalogChanged={() => session.refreshCatalogSummary()}
                    onOpenImportedAsset={openImportedAsset}
                />
            </Suspense>,
            false,
        );
    }
    if (route.surface === "guided_import") {
        return frame(
            <Suspense fallback={loadingSurface}>
                <GuidedImportPage
                    client={applicationClient}
                    assetCount={state.assetCount}
                    targetProjectId={route.targetProjectId}
                    authorizeObservedProjectRoot={(reference) => session.authorizeObservedProjectRoot(reference)}
                    revealObservedProjectRoot={(reference) => session.revealObservedProjectRoot(reference)}
                    authorizeRegisteredProjectRoot={(projectId) => session.authorizeRegisteredProjectRoot(projectId)}
                    revealImportPreviewFile={(reference) => session.revealImportPreviewFile(reference)}
                    onCatalogChanged={() => session.refreshCatalogSummary()}
                    onOpenImportedAsset={openImportedAsset}
                    onLeaveGuardChange={registerGuidedImportLeaveGuard}
                    onClose={() => {
                        if (canMoveWorkbenchHistory(navigation, "back")) moveHistory("back");
                        else replaceRoute({ surface: "library", subject: "projects" });
                    }}
                />
            </Suspense>,
            false,
        );
    }
    if (route.surface === "settings") {
        return frame(
            <Suspense fallback={loadingSurface}>
                <SettingsPage
                    category={route.category}
                    client={applicationClient}
                    desktopBridge={session.desktopBridge}
                    sidebarVisible={sidebarVisible}
                    onCategoryChange={(category) => navigate({ surface: "settings", category })}
                    onClose={closeSettings}
                    onOpenGuidedImport={() => navigate({ surface: "guided_import" })}
                    onInterfaceDefaultsRestored={() => {
                        setSidebarVisible(true);
                        setInspectorVisible(false);
                    }}
                />
            </Suspense>,
        );
    }
    return frame(
        <Suspense fallback={loadingSurface}>
            <WorkspacePage
                client={applicationClient}
                pickProjectRoot={() => session.pickProjectRoot()}
                pickInstallationRoot={() => session.pickInstallationRoot()}
                authorizeRegisteredProjectRoot={(projectId) => session.authorizeRegisteredProjectRoot(projectId)}
                revealRegisteredProjectRoot={(projectId) => session.revealRegisteredProjectRoot(projectId)}
                pickAssetVersionExport={(exportKind, suggestedFileName) =>
                    session.pickAssetVersionExport(exportKind, suggestedFileName)
                }
                assetCount={state.assetCount}
                catalogWarningCount={state.catalogWarningCount}
                route={route}
                sidebarVisible={sidebarVisible}
                inspectorVisible={inspectorVisible}
                onNavigate={navigate}
                onReplaceRoute={replaceRoute}
                projectRegistrationRequest={
                    projectRegistrationRequestId === undefined
                        ? undefined
                        : {
                              requestId: projectRegistrationRequestId,
                              onHandled: () =>
                                  setProjectRegistrationRequestId((current) =>
                                      current === projectRegistrationRequestId ? undefined : current,
                                  ),
                          }
                }
                onInspectorVisibleChange={setInspectorVisible}
                onOpenGuidedImport={(targetProjectId) =>
                    navigate({ surface: "guided_import", ...(targetProjectId === undefined ? {} : { targetProjectId }) })
                }
                onOpenLibrary={() => navigate(lastLibraryRoute.current)}
                onOpenSources={() => navigate(lastSourcesRoute.current)}
                onOpenSettings={() => navigate({ surface: "settings", category: "general" })}
                onOpenSearch={() => setSearchOpen(true)}
            />
        </Suspense>,
        true,
        projectRegistration,
    );
}
