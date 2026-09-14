import { projectDisplayName } from "../../presentation/project-label";
import { useEffect, useMemo, useState } from "react";
import type { OaamDesktopBridge } from "../../../bridge/desktop-bridge";
import type { DesktopApplicationClientApi } from "../../client";
import { ProtocolDiagnostics, useDesktopPresentation } from "../../presentation";
import { WorkbenchDisclosure, WorkbenchNotice, WorkbenchPanel } from "../../ui";
import { ProjectLifecycleDialog } from "./ProjectLifecycleDialog";
import { ProjectLibraryController, type ProjectLibraryState } from "./project-library-controller";
import type { ProjectView } from "./project-library-model";

export interface RetainedProjectSettingsProps {
    readonly client: DesktopApplicationClientApi;
    readonly desktopBridge: OaamDesktopBridge;
}

export function RetainedProjectSettings({ client, desktopBridge }: RetainedProjectSettingsProps): React.JSX.Element | null {
    const { displayText, text } = useDesktopPresentation();
    const controller = useMemo(() => new ProjectLibraryController(client), [client]);
    const [state, setState] = useState<ProjectLibraryState>(controller.state);
    const [restoreProject, setRestoreProject] = useState<ProjectView>();
    const canRestore =
        client.supportsOperation("project_lifecycle.inspect") && client.supportsOperation("project_lifecycle.commit");

    useEffect(() => {
        const unsubscribe = controller.subscribe(setState);
        void controller.load();
        return () => {
            unsubscribe();
            controller.dispose();
        };
    }, [controller]);

    useEffect(() => {
        if (state.status === "ready" && state.stale) void controller.load();
    }, [controller, state]);

    if (state.status === "ready" && state.retainedProjects.length === 0 && restoreProject === undefined) return null;

    return (
        <>
            <WorkbenchPanel
                className="settings-section retained-project-settings"
                aria-labelledby="settings-project-management-title"
            >
                <div className="settings-section-heading">
                    <h2 id="settings-project-management-title">{text("settings.project_management.title")}</h2>
                    <p>{text("settings.project_management.copy")}</p>
                </div>
                {state.status === "loading" ? (
                    <WorkbenchNotice role="status" aria-busy="true">
                        {text("library.loading")}
                    </WorkbenchNotice>
                ) : state.status === "failed" ? (
                    <div
                        data-oaam-visible-state="retained_projects_unavailable"
                        data-oaam-state-presentation="action_required"
                        data-oaam-state-blocking-scope="current_panel"
                        data-oaam-state-persistence="transient"
                    >
                        <WorkbenchNotice tone="danger" role="alert">
                            <p>{displayText(state.message)}</p>
                            <ProtocolDiagnostics
                                embedded
                                diagnostics={state.diagnostics}
                                technicalSummary={text("import.ui.technical_details")}
                            />
                        </WorkbenchNotice>
                        <div className="status-card-actions">
                            <button
                                data-oaam-interaction-entry="features.project-library.retained_project_settings.003"
                                data-oaam-visible-state-action="retry_retained_projects"
                                type="button"
                                onClick={() => void controller.load()}
                            >
                                {text("common.retry")}
                            </button>
                        </div>
                    </div>
                ) : state.retainedProjects.length === 0 ? null : (
                    <WorkbenchDisclosure
                        data-oaam-interaction-entry="features.project-library.retained_project_settings.001"
                        className="retained-projects"
                        summary={`${text("project_lifecycle.retained.title")} (${state.retainedProjects.length})`}
                    >
                        <ul>
                            {state.retainedProjects.map((project) => (
                                <li key={project.projectId} data-oaam-project-id={project.projectId}>
                                    <span>
                                        <strong>{projectDisplayName(project)}</strong>
                                        <small>{project.rootPath}</small>
                                    </span>
                                    <button
                                        data-oaam-interaction-entry="features.project-library.retained_project_settings.002"
                                        type="button"
                                        disabled={!canRestore}
                                        onClick={() => setRestoreProject(project)}
                                    >
                                        {text("project_lifecycle.restore.open")}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </WorkbenchDisclosure>
                )}
            </WorkbenchPanel>
            {restoreProject === undefined ? null : (
                <ProjectLifecycleDialog
                    client={client}
                    project={restoreProject}
                    initialAction="restore"
                    pickProjectRoot={() => desktopBridge.pickProjectRoot()}
                    onClose={() => setRestoreProject(undefined)}
                    onCommitted={(project) => {
                        controller.applyLifecycleProject(project);
                    }}
                />
            )}
        </>
    );
}
