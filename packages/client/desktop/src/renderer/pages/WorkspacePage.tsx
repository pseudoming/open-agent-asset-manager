import type {
    AssetVersionExportKind,
    AssetVersionExportPickerResult,
    InstallationRootPickerResult,
    ProjectRootPickerResult,
    RegisteredProjectRootAuthorizationResult,
    RegisteredProjectRootRevealResult,
} from "../../bridge/desktop-bridge";
import type { WorkbenchLibraryRoute, WorkbenchRoute, WorkbenchSourcesRoute, WorkbenchSubject } from "../app/workbench-navigation";
import type { DesktopApplicationClientApi } from "../client";
import { ProjectLibraryWorkspace, type ProjectRegistrationRequest } from "../features/project-library";
import { SourceLibraryWorkspace } from "../features/source-library";
import { DeploymentPage } from "./DeploymentPage";

export interface WorkspacePageProps {
    readonly client: DesktopApplicationClientApi;
    readonly pickProjectRoot: () => Promise<ProjectRootPickerResult>;
    readonly pickInstallationRoot: () => Promise<InstallationRootPickerResult>;
    readonly authorizeRegisteredProjectRoot: (projectId: string) => Promise<RegisteredProjectRootAuthorizationResult>;
    readonly revealRegisteredProjectRoot: (projectId: string) => Promise<RegisteredProjectRootRevealResult>;
    readonly pickAssetVersionExport: (
        exportKind: AssetVersionExportKind,
        suggestedFileName: string,
    ) => Promise<AssetVersionExportPickerResult>;
    readonly assetCount: number;
    readonly catalogWarningCount: number;
    readonly route:
        | WorkbenchLibraryRoute
        | WorkbenchSourcesRoute
        | { readonly surface: "deployment"; readonly subject: WorkbenchSubject; readonly assetId?: string };
    readonly sidebarVisible: boolean;
    readonly inspectorVisible: boolean;
    readonly onNavigate: (route: WorkbenchRoute) => void;
    readonly onReplaceRoute: (route: WorkbenchRoute) => void;
    readonly projectRegistrationRequest?: ProjectRegistrationRequest;
    readonly onInspectorVisibleChange: (visible: boolean) => void;
    readonly onOpenGuidedImport: (targetProjectId?: string) => void;
    readonly onOpenLibrary: () => void;
    readonly onOpenSources: () => void;
    readonly onOpenSettings: () => void;
    readonly onOpenSearch: () => void;
}

export function WorkspacePage({
    client,
    pickProjectRoot,
    pickInstallationRoot,
    authorizeRegisteredProjectRoot,
    revealRegisteredProjectRoot,
    pickAssetVersionExport,
    assetCount,
    catalogWarningCount,
    route,
    sidebarVisible,
    inspectorVisible,
    onNavigate,
    onReplaceRoute,
    projectRegistrationRequest,
    onInspectorVisibleChange,
    onOpenGuidedImport,
    onOpenLibrary,
    onOpenSources,
    onOpenSettings,
    onOpenSearch,
}: WorkspacePageProps): React.JSX.Element {
    if (route.surface === "deployment") {
        return (
            <DeploymentPage
                client={client}
                subject={route.subject}
                assetId={route.assetId}
                sidebarVisible={sidebarVisible}
                pickInstallationRoot={pickInstallationRoot}
                authorizeRegisteredProjectRoot={authorizeRegisteredProjectRoot}
                revealRegisteredProjectRoot={revealRegisteredProjectRoot}
                onOpenAssetUsage={(assetId) => onNavigate({ surface: "deployment", subject: route.subject, assetId })}
                onClose={() =>
                    onNavigate(
                        route.subject.subjectKind === "project"
                            ? {
                                  surface: "library",
                                  subject: "projects",
                                  projectId: route.subject.projectId,
                                  ...(route.assetId === undefined ? {} : { assetId: route.assetId }),
                              }
                            : {
                                  surface: "library",
                                  subject: "global",
                                  ...(route.assetId === undefined ? {} : { assetId: route.assetId }),
                              },
                    )
                }
                onDeploymentCreated={
                    route.assetId === undefined
                        ? () => onReplaceRoute({ surface: "deployment", subject: route.subject })
                        : undefined
                }
            />
        );
    }
    if (route.surface === "sources") {
        return (
            <SourceLibraryWorkspace
                client={client}
                catalogWarningCount={catalogWarningCount}
                route={route}
                sidebarVisible={sidebarVisible}
                onNavigate={onNavigate}
                onReplaceRoute={onReplaceRoute}
                onOpenGuidedImport={onOpenGuidedImport}
                onOpenLibrary={onOpenLibrary}
                onOpenSettings={onOpenSettings}
            />
        );
    }
    return (
        <ProjectLibraryWorkspace
            client={client}
            pickProjectRoot={pickProjectRoot}
            pickAssetVersionExport={pickAssetVersionExport}
            assetCount={assetCount}
            catalogWarningCount={catalogWarningCount}
            route={route}
            sidebarVisible={sidebarVisible}
            inspectorVisible={inspectorVisible}
            onNavigate={onNavigate}
            onReplaceRoute={onReplaceRoute}
            projectRegistrationRequest={projectRegistrationRequest}
            onInspectorVisibleChange={onInspectorVisibleChange}
            onOpenGuidedImport={onOpenGuidedImport}
            onOpenSources={onOpenSources}
            onOpenSettings={onOpenSettings}
            onOpenSearch={onOpenSearch}
            onOpenDeployments={(subject, assetId) => onNavigate({ surface: "deployment", subject, assetId })}
        />
    );
}
