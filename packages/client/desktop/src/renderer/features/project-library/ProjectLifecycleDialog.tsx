import { projectDisplayName } from "../../presentation/project-label";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectRootPickerResult } from "../../../bridge/desktop-bridge";
import type { DesktopApplicationClientApi } from "../../client";
import { type DesktopMessageId, ProtocolDiagnostics, ProtocolFeedbackNotice, useDesktopPresentation } from "../../presentation";
import { WorkbenchDialog, WorkbenchNotice, WorkbenchSwitch } from "../../ui";
import type { ProjectView } from "./project-library-model";
import { ProjectLifecycleController } from "./project-lifecycle-controller";
import type {
    ProjectLifecycleFlowState,
    ProjectLifecycleProject,
    ProjectLifecycleReviewContext,
} from "./project-lifecycle-model";

export interface ProjectLifecycleDialogProps {
    readonly client: DesktopApplicationClientApi;
    readonly project: ProjectView;
    readonly initialAction: "manage" | "restore";
    readonly pickProjectRoot: () => Promise<ProjectRootPickerResult>;
    readonly onClose: () => void;
    readonly onCommitted: (project: ProjectLifecycleProject, context: ProjectLifecycleReviewContext) => void;
}

export function ProjectLifecycleDialog({
    client,
    project,
    initialAction,
    pickProjectRoot,
    onClose,
    onCommitted,
}: ProjectLifecycleDialogProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const controller = useMemo(() => new ProjectLifecycleController(client), [client]);
    const [state, setState] = useState<ProjectLifecycleFlowState>(controller.state);
    const [nextDisplayName, setNextDisplayName] = useState(project.displayName);
    const [rememberChoice, setRememberChoice] = useState(true);
    const [selectionMessage, setSelectionMessage] = useState<string>();
    const handledSuccess = useRef<ProjectLifecycleProject | undefined>(undefined);

    useEffect(() => {
        const unsubscribe = controller.subscribe(setState);
        return () => {
            unsubscribe();
            controller.dispose();
        };
    }, [controller]);

    useEffect(() => {
        if (state.status !== "succeeded" || handledSuccess.current === state.project) return;
        handledSuccess.current = state.project;
        onCommitted(state.project, state.context);
    }, [onCommitted, state]);

    async function inspectRebind(): Promise<void> {
        setSelectionMessage(undefined);
        try {
            const selection = await pickProjectRoot();
            if (selection.status !== "selected") {
                return;
            }
            await controller.inspect({
                action: "rebind",
                projectId: project.projectId,
                localPathSelectionToken: selection.localPathSelectionToken,
            });
        } catch {
            setSelectionMessage(text("project_lifecycle.rebind_selection_interrupted"));
        }
    }

    const busy = state.status === "inspecting" || (state.status === "review" && state.busyStage !== undefined);
    const title = initialAction === "restore" ? text("project_lifecycle.restore.title") : text("project_lifecycle.manage.title");

    return (
        <WorkbenchDialog
            data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.001"
            className="project-lifecycle-dialog"
            closeLabel={text("project_lifecycle.close")}
            dialogId="project_lifecycle"
            dismissible={!busy}
            title={title}
            onClose={onClose}
        >
            <div className="project-lifecycle-content" data-oaam-project-lifecycle-state={state.status}>
                {state.status === "review" && state.context.review.action === "rename" ? null : (
                    <dl className="project-lifecycle-subject">
                        <dt>{text("project_lifecycle.project")}</dt>
                        <dd>{projectDisplayName(project)}</dd>
                        {state.status === "review" ? null : (
                            <>
                                <dt>{text("project_lifecycle.root")}</dt>
                                <dd>{project.rootPath}</dd>
                            </>
                        )}
                    </dl>
                )}

                {state.status === "idle" || state.status === "failed" ? (
                    project.deleted ? (
                        <section className="project-lifecycle-action">
                            <p>{text("project_lifecycle.restore.copy")}</p>
                            <button
                                data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.002"
                                type="button"
                                data-oaam-project-action="restore"
                                onClick={() => void controller.inspect({ action: "restore", projectId: project.projectId })}
                            >
                                {text("project_lifecycle.restore.review")}
                            </button>
                        </section>
                    ) : (
                        <div className="project-lifecycle-actions">
                            <section className="project-lifecycle-action">
                                <h3>{text("project_lifecycle.rename.title")}</h3>
                                <p>{text("project_lifecycle.rename.copy")}</p>
                                <label>
                                    <span>{text("project_lifecycle.rename.label")}</span>
                                    <input
                                        data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.003"
                                        type="text"
                                        value={nextDisplayName}
                                        onChange={(event) => setNextDisplayName(event.currentTarget.value)}
                                    />
                                </label>
                                <button
                                    data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.004"
                                    type="button"
                                    data-oaam-project-action="rename"
                                    disabled={nextDisplayName === project.displayName}
                                    onClick={() =>
                                        void controller.inspect({
                                            action: "rename",
                                            projectId: project.projectId,
                                            nextDisplayName,
                                        })
                                    }
                                >
                                    {text("project_lifecycle.rename.review")}
                                </button>
                            </section>
                            <section className="project-lifecycle-action">
                                <h3>{text("project_lifecycle.rebind.title")}</h3>
                                <p>{text("project_lifecycle.rebind.copy")}</p>
                                <button
                                    data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.005"
                                    type="button"
                                    data-oaam-project-action="rebind"
                                    onClick={() => void inspectRebind()}
                                >
                                    {text("project_lifecycle.rebind.choose")}
                                </button>
                            </section>
                            <section className="project-lifecycle-action project-lifecycle-danger">
                                <h3>{text("project_lifecycle.stop.title")}</h3>
                                <p>{text("project_lifecycle.stop.copy")}</p>
                                <button
                                    data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.006"
                                    type="button"
                                    data-oaam-project-action="stop_managing"
                                    onClick={() =>
                                        void controller.inspect({
                                            action: "stop_managing",
                                            projectId: project.projectId,
                                        })
                                    }
                                >
                                    {text("project_lifecycle.stop.review")}
                                </button>
                            </section>
                        </div>
                    )
                ) : null}

                {selectionMessage === undefined ? null : <WorkbenchNotice tone="warning">{selectionMessage}</WorkbenchNotice>}
                {state.status === "inspecting" ? (
                    <WorkbenchNotice role="status">{text("project_lifecycle.inspecting")}</WorkbenchNotice>
                ) : null}
                {state.status === "failed" ? (
                    <ProtocolFeedbackNotice message={state.message} diagnostics={state.diagnostics} tone="danger" />
                ) : null}
                {state.status === "succeeded" && state.context.review.action === "restore" ? (
                    <WorkbenchNotice role="status">
                        <p>{text("project_lifecycle.restore.completed", { name: projectDisplayName(state.project) })}</p>
                        {state.context.review.rootAccessState === "unavailable" ? (
                            <p>{text("project_lifecycle.restore.root_attention", { path: state.project.rootPath })}</p>
                        ) : null}
                    </WorkbenchNotice>
                ) : null}
                {state.status === "review" ? (
                    <ProjectLifecycleReview
                        state={state}
                        rememberChoice={rememberChoice}
                        onRememberChoice={setRememberChoice}
                        onCommit={(choice) => void controller.commit(choice, rememberChoice)}
                    />
                ) : null}
            </div>
        </WorkbenchDialog>
    );
}

interface ProjectLifecycleReviewProps {
    readonly state: Extract<ProjectLifecycleFlowState, { readonly status: "review" }>;
    readonly rememberChoice: boolean;
    readonly onRememberChoice: (value: boolean) => void;
    readonly onCommit: (choice?: "back_up_then_continue" | "continue_without_backup") => void;
}

function ProjectLifecycleReview({
    state,
    rememberChoice,
    onRememberChoice,
    onCommit,
}: ProjectLifecycleReviewProps): React.JSX.Element {
    const { snapshot, text } = useDesktopPresentation();
    const { review, deployments, backupPolicy, latestBackup } = state.context;
    const busy = state.busyStage !== undefined;
    const date = (value: number) =>
        new Intl.DateTimeFormat(snapshot.resolvedLocale, { dateStyle: "medium", timeStyle: "short" }).format(value);
    const actionLabel = text(PROJECT_LIFECYCLE_ACTION_MESSAGES[review.action]);

    return (
        <section className="project-lifecycle-review" data-oaam-project-lifecycle-action={review.action}>
            <h3>{text("project_lifecycle.review.title", { action: actionLabel })}</h3>
            <dl>
                {review.action === "rename" ? (
                    <>
                        <dt>{text("project_lifecycle.review.current_name")}</dt>
                        <dd>{review.currentDisplayName}</dd>
                        <dt>{text("project_lifecycle.review.next_name")}</dt>
                        <dd>{review.nextDisplayName}</dd>
                    </>
                ) : review.action === "rebind" ? (
                    <>
                        <dt>{text("project_lifecycle.review.current_root")}</dt>
                        <dd>{review.currentRootPath}</dd>
                        <dt>{text("project_lifecycle.review.next_root")}</dt>
                        <dd>{review.nextRootPath}</dd>
                    </>
                ) : (
                    <>
                        <dt>{text("project_lifecycle.root")}</dt>
                        <dd>{review.rootPath}</dd>
                    </>
                )}
            </dl>

            {review.action === "restore" && review.rootAccessState === "unavailable" ? (
                <WorkbenchNotice tone="warning">{text("project_lifecycle.restore.unavailable")}</WorkbenchNotice>
            ) : null}
            {review.action === "stop_managing" ? (
                <WorkbenchNotice tone="warning">{text("project_lifecycle.stop.no_external_delete")}</WorkbenchNotice>
            ) : null}
            {review.action === "rebind" ? (
                <section className="project-lifecycle-deployments">
                    <h4>{text("project_lifecycle.deployments.title", { count: deployments.length })}</h4>
                    <p>{text("project_lifecycle.deployments.copy")}</p>
                    {deployments.length === 0 ? null : (
                        <ul>
                            {deployments.map((deployment) => (
                                <li key={deployment.deploymentId}>
                                    <code>{deployment.targetRootPath}</code>
                                    <span>{text(PROJECT_LIFECYCLE_DEPLOYMENT_STAGE_MESSAGES[deployment.stage])}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            ) : null}

            {backupPolicy === undefined ? null : (
                <section className="project-lifecycle-backup-gate">
                    <h4>{text("project_lifecycle.backup.title")}</h4>
                    <p>
                        {latestBackup === undefined
                            ? text("project_lifecycle.backup.none")
                            : text("project_lifecycle.backup.latest", {
                                  time: date(latestBackup.createdAt),
                                  path: latestBackup.archiveDisplayPath,
                              })}
                    </p>
                    {backupPolicy.mode === "ask_every_time" ? (
                        <WorkbenchSwitch
                            data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.007"
                            checked={rememberChoice}
                            disabled={busy}
                            label={text("project_lifecycle.backup.remember")}
                            onCheckedChange={onRememberChoice}
                        />
                    ) : (
                        <small>
                            {backupPolicy.mode === "back_up_first"
                                ? text("project_lifecycle.backup.policy_first")
                                : text("project_lifecycle.backup.policy_continue")}
                        </small>
                    )}
                </section>
            )}

            {state.message === undefined ? (
                <ProtocolDiagnostics diagnostics={state.diagnostics} technicalSummary={text("import.ui.technical_details")} />
            ) : (
                <ProtocolFeedbackNotice message={state.message} diagnostics={state.diagnostics} tone="danger" />
            )}
            {busy ? (
                <WorkbenchNotice role="status">
                    {text(PROJECT_LIFECYCLE_BUSY_MESSAGES[state.busyStage as NonNullable<typeof state.busyStage>])}
                </WorkbenchNotice>
            ) : null}
            <div className="detail-actions">
                {backupPolicy?.mode === "ask_every_time" ? (
                    <>
                        <button
                            data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.008"
                            type="button"
                            disabled={busy}
                            onClick={() => onCommit("back_up_then_continue")}
                        >
                            {text("project_lifecycle.backup_then_continue")}
                        </button>
                        <button
                            data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.009"
                            type="button"
                            className="library-secondary-button"
                            disabled={busy}
                            onClick={() => onCommit("continue_without_backup")}
                        >
                            {text("project_lifecycle.continue_without_backup")}
                        </button>
                    </>
                ) : (
                    <button
                        data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.010"
                        type="button"
                        disabled={busy}
                        onClick={() => onCommit()}
                    >
                        {backupPolicy?.mode === "back_up_first"
                            ? text("project_lifecycle.backup_then_continue")
                            : text("project_lifecycle.confirm")}
                    </button>
                )}
            </div>
        </section>
    );
}

const PROJECT_LIFECYCLE_ACTION_MESSAGES = {
    rename: "project_lifecycle.action.rename",
    rebind: "project_lifecycle.action.rebind",
    restore: "project_lifecycle.action.restore",
    stop_managing: "project_lifecycle.action.stop_managing",
} as const;

const PROJECT_LIFECYCLE_BUSY_MESSAGES = {
    backup: "project_lifecycle.busy.backup",
    policy: "project_lifecycle.busy.policy",
    commit: "project_lifecycle.busy.commit",
} as const;

const PROJECT_LIFECYCLE_DEPLOYMENT_STAGE_MESSAGES = {
    blocked: "catalog.ui.status.review_required",
    conflict: "catalog.ui.status.external_changes",
    deleted: "library.assets.deleted",
    in_sync: "catalog.ui.status.up_to_date",
    needs_repair: "catalog.ui.status.repair_available",
} as const satisfies Record<ProjectLifecycleReviewContext["deployments"][number]["stage"], DesktopMessageId>;
