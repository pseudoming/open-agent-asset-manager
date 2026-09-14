import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DesktopStateBackupFileAction, OaamDesktopBridge } from "../../../bridge/desktop-bridge";
import type { DesktopApplicationClientApi, DesktopLongOperationUpdate } from "../../client";
import {
    type DesktopMessageId,
    localizedText,
    mergeNonInformationalProtocolDiagnostics,
    nonInformationalProtocolDiagnostics,
    type ProtocolFeedback,
    ProtocolFeedbackNotice,
    protocolFeedback,
    useDesktopPresentation,
} from "../../presentation";
import { formatBytes, WorkbenchBadge, WorkbenchConfirmation, WorkbenchNotice, WorkbenchSelect } from "../../ui";
import {
    type BackupArtifact,
    type BackupDestinationSelection,
    type BackupEncryptionMode,
    type BackupInventory,
    type BackupPolicy,
    type BackupPromptMode,
    type BackupReview,
    ENCRYPTION_SHORT_MESSAGES,
    latestAvailableBackup,
    OBSERVATION_MESSAGES,
    type OperationProgress,
    PROGRESS_STAGE_MESSAGES,
    type RestoreActivation,
    type RestoreReview,
    type RestoreSource,
} from "./state-resilience-model";

export interface StateResilienceWorkspaceProps {
    readonly client: DesktopApplicationClientApi;
    readonly desktopBridge: OaamDesktopBridge;
    readonly recoveryOnly?: boolean;
    readonly recoveryMessage?: string;
}

interface StateResilienceFeedback extends ProtocolFeedback {
    readonly tone: "note" | "danger";
}

function stateResilienceFeedback(
    message: DesktopMessageId,
    tone: StateResilienceFeedback["tone"],
    diagnostics: readonly ProtocolDiagnosticV1[] = [],
): StateResilienceFeedback {
    return Object.freeze({
        ...protocolFeedback(localizedText(message), nonInformationalProtocolDiagnostics(diagnostics)),
        tone,
    });
}

function retainStateResilienceDiagnostics(
    current: StateResilienceFeedback | undefined,
    diagnostics: readonly ProtocolDiagnosticV1[],
): StateResilienceFeedback | undefined {
    const retained = nonInformationalProtocolDiagnostics(diagnostics);
    if (retained.length === 0) return current;
    if (current === undefined) return stateResilienceFeedback("state_resilience.load_attention", "note", retained);
    return Object.freeze({
        ...current,
        diagnostics: mergeNonInformationalProtocolDiagnostics(current.diagnostics, retained),
    });
}

export function StateResilienceWorkspace({
    client,
    desktopBridge,
    recoveryOnly = false,
    recoveryMessage,
}: StateResilienceWorkspaceProps): React.JSX.Element {
    const { snapshot, text } = useDesktopPresentation();
    const [inventory, setInventory] = useState<BackupInventory>();
    const [policy, setPolicy] = useState<BackupPolicy>();
    const [policyMode, setPolicyMode] = useState<BackupPromptMode>("ask_every_time");
    const [rememberedDestination, setRememberedDestination] = useState<string>();
    const [customDestination, setCustomDestination] = useState<BackupDestinationSelection>();
    const [encryptionMode, setEncryptionMode] = useState<BackupEncryptionMode>("none");
    const [backupPassword, setBackupPassword] = useState("");
    const [backupPasswordConfirmation, setBackupPasswordConfirmation] = useState("");
    const [backupReview, setBackupReview] = useState<BackupReview>();
    const [createdBackup, setCreatedBackup] = useState<BackupArtifact>();
    const [restoreSource, setRestoreSource] = useState<RestoreSource>();
    const [restorePassword, setRestorePassword] = useState("");
    const [restoreReview, setRestoreReview] = useState<RestoreReview>();
    const [restoreConfirmed, setRestoreConfirmed] = useState(false);
    const [restoreActivation, setRestoreActivation] = useState<{
        readonly status: "complete" | "partial";
        readonly value: RestoreActivation;
        readonly diagnostics: readonly ProtocolDiagnosticV1[];
    }>();
    const [progress, setProgress] = useState<OperationProgress>();
    const [progressOwner, setProgressOwner] = useState<"backup" | "restore">("backup");
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<StateResilienceFeedback>();
    const [trashConfirmation, setTrashConfirmation] = useState("");
    const backupAvailable = [
        "state_backup.list",
        "state_backup_prompt_policy.get",
        "state_backup_prompt_policy.replace",
        "state_backup.inspect",
        "state_backup.create",
    ].every((operation) => client.supportsOperation(operation as Parameters<typeof client.supportsOperation>[0]));
    const restoreAvailable = ["state_restore.inspect", "state_restore.activate"].every((operation) =>
        client.supportsOperation(operation as Parameters<typeof client.supportsOperation>[0]),
    );
    const latest = useMemo(() => latestAvailableBackup(inventory), [inventory]);

    const load = useCallback(
        async (clearFeedback = true): Promise<void> => {
            setBusy(true);
            if (clearFeedback) setFeedback(undefined);
            try {
                const [inventoryResult, policyResult, preferences] = await Promise.all([
                    client.listStateBackups(),
                    client.getStateBackupPromptPolicy(),
                    desktopBridge.getStateResiliencePreferences(),
                ]);
                if (inventoryResult.status === "failed" || policyResult.status === "failed") {
                    setFeedback(
                        stateResilienceFeedback(
                            "state_resilience.load_failed",
                            "danger",
                            mergeNonInformationalProtocolDiagnostics(inventoryResult.diagnostics, policyResult.diagnostics),
                        ),
                    );
                    return;
                }
                setInventory(inventoryResult.value);
                setPolicy(policyResult.value);
                setPolicyMode(policyResult.value.mode);
                setRememberedDestination(preferences.lastCustomBackupDirectory);
                setFeedback((current) =>
                    retainStateResilienceDiagnostics(
                        clearFeedback ? undefined : current,
                        mergeNonInformationalProtocolDiagnostics(inventoryResult.diagnostics, policyResult.diagnostics),
                    ),
                );
            } catch {
                setFeedback(stateResilienceFeedback("state_resilience.load_failed", "danger"));
            } finally {
                setBusy(false);
            }
        },
        [client, desktopBridge],
    );

    useEffect(() => {
        if (backupAvailable) void load();
    }, [backupAvailable, load]);

    function trackProgress(
        update:
            | DesktopLongOperationUpdate<"state_backup.inspect">
            | DesktopLongOperationUpdate<"state_backup.create">
            | DesktopLongOperationUpdate<"state_restore.inspect">
            | DesktopLongOperationUpdate<"state_restore.activate">,
    ): void {
        if (update.status === "progress") setProgress(update.progress);
    }

    async function chooseCustomDestination(useRemembered: boolean): Promise<void> {
        setFeedback(undefined);
        try {
            const result = useRemembered
                ? await desktopBridge.selectRememberedStateBackupDestination()
                : await desktopBridge.pickStateBackupDestination();
            if (result.status === "selected") {
                setCustomDestination(result);
                setBackupReview(undefined);
                return;
            }
            if (result.status === "unavailable") {
                setFeedback(stateResilienceFeedback("state_resilience.destination.remembered_unavailable", "danger"));
            }
        } catch {
            setFeedback(stateResilienceFeedback("state_resilience.destination.choose_failed", "danger"));
        }
    }

    async function inspectBackup(): Promise<void> {
        setProgressOwner("backup");
        setBusy(true);
        setProgress(undefined);
        setFeedback(undefined);
        setCreatedBackup(undefined);
        try {
            const result = await client.inspectStateBackup(
                {
                    destination:
                        customDestination === undefined
                            ? { destinationKind: "oaam_default" }
                            : {
                                  destinationKind: "custom_directory",
                                  localPathSelectionToken: customDestination.localPathSelectionToken,
                              },
                    encryptionMode,
                },
                trackProgress,
            );
            if (result.status === "failed") {
                setFeedback(stateResilienceFeedback("state_resilience.backup.inspect_failed", "danger", result.diagnostics));
                if (customDestination !== undefined) setCustomDestination(undefined);
                return;
            }
            setBackupReview(result.value);
            setFeedback(stateResilienceFeedback("state_resilience.backup.review_ready", "note", result.diagnostics));
        } catch {
            setFeedback(stateResilienceFeedback("state_resilience.backup.inspect_interrupted", "danger"));
            if (customDestination !== undefined) setCustomDestination(undefined);
        } finally {
            setProgress(undefined);
            setBusy(false);
        }
    }

    async function createBackup(): Promise<void> {
        setProgressOwner("backup");
        if (backupReview === undefined) return;
        if (encryptionMode !== "none" && (backupPassword.length === 0 || backupPassword !== backupPasswordConfirmation)) {
            setFeedback(stateResilienceFeedback("state_resilience.password_invalid", "danger"));
            return;
        }
        setBusy(true);
        setProgress(undefined);
        setFeedback(undefined);
        try {
            const result = await client.createStateBackup(
                {
                    backupReviewToken: backupReview.backupReviewToken,
                    ...(encryptionMode === "none" ? {} : { password: backupPassword }),
                    userActionId: globalThis.crypto.randomUUID(),
                },
                trackProgress,
            );
            if (result.status === "failed") {
                setFeedback(stateResilienceFeedback("state_resilience.backup.create_failed", "danger", result.diagnostics));
                return;
            }
            setCreatedBackup(result.value);
            if (backupReview.destinationKind === "custom_directory") {
                const preferences = await desktopBridge.rememberStateBackupDestination(result.value.backupId);
                setRememberedDestination(preferences.lastCustomBackupDirectory);
            }
            setBackupPassword("");
            setBackupPasswordConfirmation("");
            setFeedback(stateResilienceFeedback("state_resilience.backup.created", "note", result.diagnostics));
            await load(false);
        } catch {
            setFeedback(stateResilienceFeedback("state_resilience.backup.create_interrupted", "danger"));
        } finally {
            // Retire this UI review after an attempt; retries must inspect current state again.
            setBackupReview(undefined);
            setCustomDestination(undefined);
            setBackupPassword("");
            setBackupPasswordConfirmation("");
            setProgress(undefined);
            setBusy(false);
        }
    }

    async function savePolicy(): Promise<void> {
        if (policy === undefined) return;
        setBusy(true);
        setFeedback(undefined);
        try {
            const result = await client.replaceStateBackupPromptPolicy({
                expectedRevision: policy.revision,
                expectedSettingFingerprint: policy.settingFingerprint,
                mode: policyMode,
                userActionId: globalThis.crypto.randomUUID(),
            });
            if (result.status === "failed") {
                setFeedback(stateResilienceFeedback("state_resilience.policy.save_failed", "danger", result.diagnostics));
                return;
            }
            setPolicy(result.value);
            setPolicyMode(result.value.mode);
            setFeedback(stateResilienceFeedback("state_resilience.policy.saved", "note", result.diagnostics));
        } catch {
            setFeedback(stateResilienceFeedback("state_resilience.policy.save_failed", "danger"));
        } finally {
            setBusy(false);
        }
    }

    async function chooseRestoreArchive(): Promise<void> {
        setFeedback(undefined);
        try {
            const result = await desktopBridge.pickStateRestoreArchive();
            if (result.status === "selected") {
                setRestoreSource({
                    sourceKind: "selected_archive",
                    localPathSelectionToken: result.localPathSelectionToken,
                    displayPath: result.displayPath,
                });
                invalidateRestoreAuthority(false);
            }
        } catch {
            setFeedback(stateResilienceFeedback("state_resilience.restore.choose_failed", "danger"));
        }
    }

    function invalidateRestoreAuthority(clearSource: boolean): void {
        if (clearSource) setRestoreSource(undefined);
        setRestorePassword("");
        setRestoreReview(undefined);
        setRestoreConfirmed(false);
    }

    async function inspectRestore(): Promise<void> {
        setProgressOwner("restore");
        if (restoreSource === undefined) return;
        setBusy(true);
        setProgress(undefined);
        setFeedback(undefined);
        try {
            const source =
                restoreSource.sourceKind === "inventory_backup"
                    ? { sourceKind: "inventory_backup" as const, backupId: restoreSource.backupId }
                    : {
                          sourceKind: "selected_archive" as const,
                          localPathSelectionToken: restoreSource.localPathSelectionToken,
                      };
            const result = await client.inspectStateRestore(
                {
                    source,
                    ...(restorePassword.length === 0 ? {} : { password: restorePassword }),
                },
                trackProgress,
            );
            if (result.status === "failed") {
                setFeedback(stateResilienceFeedback("state_resilience.restore.inspect_failed", "danger", result.diagnostics));
                invalidateRestoreAuthority(restoreSource.sourceKind === "selected_archive");
                return;
            }
            setRestoreReview(result.value);
            setRestoreConfirmed(false);
            setFeedback(stateResilienceFeedback("state_resilience.restore.review_ready", "note", result.diagnostics));
        } catch {
            setFeedback(stateResilienceFeedback("state_resilience.restore.inspect_interrupted", "danger"));
            invalidateRestoreAuthority(restoreSource.sourceKind === "selected_archive");
        } finally {
            setProgress(undefined);
            setBusy(false);
        }
    }

    async function activateRestore(): Promise<void> {
        setProgressOwner("restore");
        if (restoreReview === undefined || !restoreConfirmed) return;
        setBusy(true);
        setProgress(undefined);
        setFeedback(undefined);
        try {
            const result = await client.activateStateRestore(
                {
                    restoreReviewToken: restoreReview.restoreReviewToken,
                    ...(restorePassword.length === 0 ? {} : { password: restorePassword }),
                    userActionId: globalThis.crypto.randomUUID(),
                },
                trackProgress,
            );
            if (result.status === "failed") {
                setFeedback(stateResilienceFeedback("state_resilience.restore.activate_failed", "danger", result.diagnostics));
                invalidateRestoreAuthority(restoreSource?.sourceKind === "selected_archive");
                return;
            }
            setRestoreActivation({
                status: result.status,
                value: result.value,
                diagnostics: nonInformationalProtocolDiagnostics(result.diagnostics),
            });
            setRestoreReview(undefined);
            setRestoreConfirmed(false);
        } catch {
            setFeedback(stateResilienceFeedback("state_resilience.restore.activate_interrupted", "danger"));
            invalidateRestoreAuthority(restoreSource?.sourceKind === "selected_archive");
        } finally {
            setRestorePassword("");
            setProgress(undefined);
            setBusy(false);
        }
    }

    async function performFileAction(backupId: string, action: DesktopStateBackupFileAction): Promise<void> {
        setFeedback(undefined);
        try {
            const result = await desktopBridge.performStateBackupFileAction(backupId, action);
            if (result.status === "failed") {
                setFeedback(
                    stateResilienceFeedback(
                        action === "reveal"
                            ? "state_resilience.file.reveal_failed"
                            : action === "trash"
                              ? "state_resilience.file.trash_failed"
                              : "state_resilience.file.copy_failed",
                        "danger",
                    ),
                );
                return;
            }
            setTrashConfirmation("");
            setFeedback(
                stateResilienceFeedback(
                    action === "reveal"
                        ? "state_resilience.file.revealed"
                        : action === "trash"
                          ? "state_resilience.file.trashed"
                          : "state_resilience.file.copied",
                    "note",
                ),
            );
            if (action === "trash") await load(false);
        } catch {
            setFeedback(stateResilienceFeedback("state_resilience.file.action_failed", "danger"));
        }
    }

    const date = (value: number): string =>
        new Intl.DateTimeFormat(snapshot.resolvedLocale, { dateStyle: "medium", timeStyle: "short" }).format(value);
    const progressPercent =
        progress === undefined || progress.totalUnits === 0
            ? 0
            : Math.min(100, Math.round((progress.completedUnits / progress.totalUnits) * 100));
    const feedbackId = feedback?.message.kind === "localized" ? feedback.message.id : "";
    const backupPasswordInvalid =
        encryptionMode !== "none" && (backupPassword.length === 0 || backupPassword !== backupPasswordConfirmation);
    const feedbackSection = feedbackId.startsWith("state_resilience.restore.")
        ? "restore"
        : feedbackId.startsWith("state_resilience.file.")
          ? "inventory"
          : feedbackId.startsWith("state_resilience.policy.")
            ? "policy"
            : feedbackId.startsWith("state_resilience.backup.") ||
                feedbackId.startsWith("state_resilience.destination.") ||
                feedbackId === "state_resilience.password_invalid"
              ? "backup"
              : "load";
    const feedbackFor = (section: typeof feedbackSection): React.JSX.Element | null =>
        feedback === undefined || feedbackSection !== section ? null : <ProtocolFeedbackNotice {...feedback} />;
    const progressFor = (section: "backup" | "restore"): React.JSX.Element => (
        <div className="state-resilience-progress-slot">
            {progress === undefined || progressOwner !== section ? null : (
                <div className="state-resilience-progress" role="status">
                    <label htmlFor="state-resilience-progress">
                        {text(section === "backup" ? "state_resilience.backup.title" : "state_resilience.restore.title")} ·{" "}
                        {text("state_resilience.progress", {
                            stage: text(PROGRESS_STAGE_MESSAGES[progress.stage]),
                            completed: progress.completedUnits,
                            total: progress.totalUnits,
                        })}
                    </label>
                    <progress id="state-resilience-progress" max={100} value={progressPercent} />
                </div>
            )}
        </div>
    );

    if (restoreActivation !== undefined) {
        return (
            <div
                className="state-resilience-workspace"
                aria-busy={false}
                data-oaam-state-resilience-state="restored"
                data-oaam-restore-result={restoreActivation.status}
            >
                <section className="state-resilience-block" aria-labelledby="state-restore-title">
                    <h3 id="state-restore-title">{text("state_resilience.restore.title")}</h3>
                    <ProtocolFeedbackNotice
                        message={localizedText("state_resilience.restore.restarting", {
                            path:
                                restoreActivation.value.displacedState.state === "preserved"
                                    ? restoreActivation.value.displacedState.displayPath
                                    : text("state_resilience.restore.no_displaced"),
                        })}
                        diagnostics={restoreActivation.diagnostics}
                        tone={restoreActivation.status === "partial" ? "warning" : "note"}
                    />
                </section>
            </div>
        );
    }

    if (!backupAvailable && !restoreAvailable) {
        return (
            <div className="state-resilience-workspace">
                <div className="settings-section-heading">
                    <h2>{text("state_resilience.title")}</h2>
                    <p>{text("state_resilience.unavailable")}</p>
                </div>
            </div>
        );
    }

    return (
        <div
            className="state-resilience-workspace"
            aria-busy={busy}
            data-oaam-state-resilience-state={busy ? "busy" : inventory === undefined && backupAvailable ? "loading" : "ready"}
            data-oaam-backup-count={inventory?.entries.length ?? 0}
            data-oaam-backup-review={backupReview === undefined ? "none" : "ready"}
            data-oaam-backup-created={createdBackup === undefined ? "false" : "true"}
            data-oaam-restore-source={restoreSource === undefined ? "none" : restoreSource.sourceKind}
            data-oaam-restore-review={restoreReview === undefined ? "none" : "ready"}
        >
            <div className="settings-section-heading state-resilience-heading">
                <div>
                    {recoveryOnly ? <h2>{text("state_resilience.title")}</h2> : null}
                    <p>{text("state_resilience.copy")}</p>
                    {recoveryMessage === undefined ? null : <p className="workbench-status-copy">{recoveryMessage}</p>}
                </div>
                {backupAvailable ? (
                    <button
                        data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.001"
                        type="button"
                        className="library-secondary-button"
                        disabled={busy}
                        onClick={() => void load()}
                    >
                        {text("state_resilience.refresh")}
                    </button>
                ) : null}
            </div>
            {!backupAvailable && restoreAvailable && recoveryMessage === undefined ? (
                <WorkbenchNotice tone="warning">{text("state_resilience.recovery_only")}</WorkbenchNotice>
            ) : null}
            {feedbackFor("load")}

            {backupAvailable && !recoveryOnly ? (
                <>
                    <section className="state-resilience-block" aria-labelledby="state-backup-create-title">
                        <div className="section-heading">
                            <div>
                                <h3 id="state-backup-create-title">{text("state_resilience.backup.title")}</h3>
                                <p>{text("state_resilience.backup.copy")}</p>
                            </div>
                        </div>
                        <div className="state-resilience-form-grid">
                            <div className="state-resilience-form-field">
                                <span>{text("state_resilience.destination.label")}</span>
                                <WorkbenchSelect
                                    data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.002"
                                    label={text("state_resilience.destination.label")}
                                    value={customDestination === undefined ? "default" : "custom"}
                                    disabled={busy}
                                    options={[
                                        { value: "default", label: text("state_resilience.destination.default") },
                                        {
                                            value: "custom",
                                            label: customDestination?.displayPath ?? text("state_resilience.destination.custom"),
                                            disabled: customDestination === undefined,
                                        },
                                    ]}
                                    onChange={(value) => {
                                        if (value === "default") {
                                            setCustomDestination(undefined);
                                            setBackupReview(undefined);
                                        }
                                    }}
                                />
                            </div>
                            <div className="state-resilience-form-field">
                                <span>{text("state_resilience.encryption.label")}</span>
                                <WorkbenchSelect
                                    data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.003"
                                    label={text("state_resilience.encryption.label")}
                                    value={encryptionMode}
                                    disabled={busy}
                                    options={[
                                        { value: "none", label: text("state_resilience.encryption.none") },
                                        {
                                            value: "compatible_password",
                                            label: text("state_resilience.encryption.compatible"),
                                        },
                                        { value: "strong_password", label: text("state_resilience.encryption.strong") },
                                    ]}
                                    onChange={(value) => {
                                        if (backupReview !== undefined && customDestination !== undefined) {
                                            setCustomDestination(undefined);
                                        }
                                        setEncryptionMode(value as BackupEncryptionMode);
                                        setBackupReview(undefined);
                                    }}
                                />
                            </div>
                        </div>
                        <div className="detail-actions">
                            <button
                                data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.004"
                                type="button"
                                className="library-secondary-button"
                                disabled={busy}
                                onClick={() => void chooseCustomDestination(false)}
                            >
                                {text("state_resilience.destination.choose")}
                            </button>
                            {rememberedDestination === undefined ? null : (
                                <button
                                    data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.005"
                                    type="button"
                                    className="library-secondary-button"
                                    disabled={busy}
                                    onClick={() => void chooseCustomDestination(true)}
                                >
                                    {text("state_resilience.destination.use_remembered")}
                                </button>
                            )}
                        </div>
                        {rememberedDestination === undefined ? null : (
                            <small>{text("state_resilience.destination.remembered", { path: rememberedDestination })}</small>
                        )}
                        {encryptionMode === "none" ? (
                            <WorkbenchNotice tone="warning">{text("state_resilience.encryption.none_warning")}</WorkbenchNotice>
                        ) : (
                            <div className="state-resilience-form-grid">
                                <label>
                                    <span>{text("state_resilience.password.label")}</span>
                                    <input
                                        data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.006"
                                        type="password"
                                        value={backupPassword}
                                        autoComplete="new-password"
                                        disabled={busy}
                                        onChange={(event) => setBackupPassword(event.currentTarget.value)}
                                    />
                                </label>
                                <label>
                                    <span>{text("state_resilience.password.confirm")}</span>
                                    <input
                                        data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.007"
                                        type="password"
                                        value={backupPasswordConfirmation}
                                        autoComplete="new-password"
                                        disabled={busy}
                                        onChange={(event) => setBackupPasswordConfirmation(event.currentTarget.value)}
                                    />
                                </label>
                                {encryptionMode === "compatible_password" ? (
                                    <WorkbenchNotice tone="warning">
                                        {text("state_resilience.encryption.compatible_warning")}
                                    </WorkbenchNotice>
                                ) : null}
                                {backupReview !== undefined && backupPasswordInvalid ? (
                                    <small role="status">{text("state_resilience.password_invalid")}</small>
                                ) : null}
                            </div>
                        )}
                        {progressFor("backup")}
                        {backupReview === undefined ? (
                            <div className="detail-actions">
                                <button
                                    data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.008"
                                    type="button"
                                    data-oaam-state-action="backup.inspect"
                                    disabled={busy || backupReview !== undefined}
                                    onClick={() => void inspectBackup()}
                                >
                                    {text("state_resilience.backup.inspect")}
                                </button>
                            </div>
                        ) : null}
                        {backupReview === undefined ? null : (
                            <div className="state-resilience-review">
                                <h4>{text("state_resilience.backup.review_title")}</h4>
                                {feedbackId === "state_resilience.backup.review_ready" ? feedbackFor("backup") : null}
                                <dl>
                                    <dt>{text("state_resilience.review.destination")}</dt>
                                    <dd>
                                        {text(
                                            backupReview.destinationState === "ready"
                                                ? "state_resilience.review.destination_existing"
                                                : "state_resilience.review.destination_planned",
                                            { path: backupReview.destinationDisplayPath },
                                        )}
                                    </dd>
                                    <dt>{text("state_resilience.review.files")}</dt>
                                    <dd>{backupReview.sourceFileCount}</dd>
                                    <dt>{text("state_resilience.review.logical_size")}</dt>
                                    <dd>{formatBytes(backupReview.sourceLogicalBytes, snapshot.resolvedLocale)}</dd>
                                    <dt>{text("state_resilience.review.available")}</dt>
                                    <dd>{formatBytes(backupReview.availableBytes, snapshot.resolvedLocale)}</dd>
                                </dl>
                                <div className="detail-actions">
                                    <button
                                        data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.009"
                                        type="button"
                                        data-oaam-state-action="backup.create"
                                        disabled={busy || backupPasswordInvalid}
                                        onClick={() => void createBackup()}
                                    >
                                        {text("state_resilience.backup.create")}
                                    </button>
                                </div>
                            </div>
                        )}
                        {createdBackup === undefined ? null : (
                            <div data-oaam-created-backup-output>
                                <ProtocolFeedbackNotice
                                    message={localizedText("state_resilience.backup.output", {
                                        path: createdBackup.archiveDisplayPath,
                                    })}
                                    diagnostics={
                                        feedbackId === "state_resilience.backup.created" ? (feedback?.diagnostics ?? []) : []
                                    }
                                    tone="note"
                                />
                            </div>
                        )}
                        {feedbackId === "state_resilience.backup.created" ||
                        (backupReview !== undefined && feedbackId === "state_resilience.backup.review_ready")
                            ? null
                            : feedbackFor("backup")}
                    </section>

                    <section className="state-resilience-block" aria-labelledby="state-backup-inventory-title">
                        <div className="section-heading">
                            <div>
                                <h3 id="state-backup-inventory-title">{text("state_resilience.inventory.title")}</h3>
                                <p>
                                    {text("state_resilience.inventory.summary", {
                                        count: inventory?.entries.length ?? 0,
                                        bytes: formatBytes(inventory?.totalAvailableArchiveBytes ?? 0, snapshot.resolvedLocale),
                                    })}
                                </p>
                            </div>
                        </div>
                        {inventory === undefined || inventory.entries.length === 0 ? (
                            <p className="workbench-status-copy">{text("state_resilience.inventory.empty")}</p>
                        ) : (
                            <ul className="state-resilience-list">
                                {[...inventory.entries]
                                    .sort((left, right) => right.createdAt - left.createdAt)
                                    .map((entry) => (
                                        <li
                                            key={entry.backupId}
                                            data-oaam-backup-entry
                                            data-oaam-backup-observation={entry.observation}
                                        >
                                            <div className="source-row-heading">
                                                <span>
                                                    <strong>{date(entry.createdAt)}</strong>
                                                    <small>{entry.archiveDisplayPath}</small>
                                                </span>
                                                <WorkbenchBadge
                                                    tone={
                                                        entry.observation === "available"
                                                            ? "success"
                                                            : entry.observation === "missing"
                                                              ? "warning"
                                                              : "danger"
                                                    }
                                                >
                                                    {text(OBSERVATION_MESSAGES[entry.observation])}
                                                </WorkbenchBadge>
                                            </div>
                                            <small>
                                                {formatBytes(entry.archiveByteSize, snapshot.resolvedLocale)} ·{" "}
                                                {text(ENCRYPTION_SHORT_MESSAGES[entry.encryptionMode])}
                                            </small>
                                            {entry.observation !== "available" ? null : (
                                                <div className="detail-actions">
                                                    <button
                                                        data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.010"
                                                        type="button"
                                                        data-oaam-state-action="restore.use"
                                                        className="library-secondary-button"
                                                        disabled={busy}
                                                        onClick={() => {
                                                            setRestoreSource({
                                                                sourceKind: "inventory_backup",
                                                                backupId: entry.backupId,
                                                                displayPath: entry.archiveDisplayPath,
                                                            });
                                                            invalidateRestoreAuthority(false);
                                                        }}
                                                    >
                                                        {text("state_resilience.restore.use")}
                                                    </button>
                                                    <button
                                                        data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.011"
                                                        type="button"
                                                        className="library-secondary-button"
                                                        disabled={busy}
                                                        onClick={() => void performFileAction(entry.backupId, "reveal")}
                                                    >
                                                        {text("state_resilience.file.reveal")}
                                                    </button>
                                                    <button
                                                        data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.012"
                                                        type="button"
                                                        className="library-secondary-button"
                                                        disabled={busy}
                                                        onClick={() => void performFileAction(entry.backupId, "copy_path")}
                                                    >
                                                        {text("state_resilience.file.copy")}
                                                    </button>
                                                    {trashConfirmation === entry.backupId ? (
                                                        <button
                                                            data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.013"
                                                            type="button"
                                                            disabled={busy}
                                                            onClick={() => void performFileAction(entry.backupId, "trash")}
                                                        >
                                                            {text("state_resilience.file.confirm_trash")}
                                                        </button>
                                                    ) : (
                                                        <button
                                                            data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.014"
                                                            type="button"
                                                            className="library-secondary-button"
                                                            disabled={busy}
                                                            onClick={() => setTrashConfirmation(entry.backupId)}
                                                        >
                                                            {text("state_resilience.file.trash")}
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </li>
                                    ))}
                            </ul>
                        )}
                        {feedbackFor("inventory")}
                    </section>
                </>
            ) : null}

            {restoreAvailable ? (
                <section className="state-resilience-block" aria-labelledby="state-restore-title">
                    {progressFor("restore")}
                    <div className="section-heading">
                        <div>
                            <h3 id="state-restore-title">{text("state_resilience.restore.title")}</h3>
                            <p>{text("state_resilience.restore.copy")}</p>
                        </div>
                        <button
                            data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.015"
                            type="button"
                            className="library-secondary-button"
                            disabled={busy}
                            onClick={() => void chooseRestoreArchive()}
                        >
                            {text("state_resilience.restore.choose")}
                        </button>
                    </div>
                    {restoreSource === undefined ? (
                        <p className="workbench-status-copy">{text("state_resilience.restore.no_source")}</p>
                    ) : (
                        <>
                            <code>{restoreSource.displayPath}</code>
                            {restoreSource.sourceKind === "inventory_backup" &&
                            inventory?.entries.find((entry) => entry.backupId === restoreSource.backupId)?.encryptionMode ===
                                "none" ? null : (
                                <label className="state-resilience-password">
                                    <span>{text("state_resilience.restore.password")}</span>
                                    <input
                                        data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.016"
                                        type="password"
                                        value={restorePassword}
                                        autoComplete="off"
                                        disabled={busy || restoreReview !== undefined}
                                        onChange={(event) => setRestorePassword(event.currentTarget.value)}
                                    />
                                </label>
                            )}
                            <button
                                data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.017"
                                type="button"
                                data-oaam-state-action="restore.inspect"
                                disabled={busy || restoreReview !== undefined}
                                onClick={() => void inspectRestore()}
                            >
                                {text("state_resilience.restore.inspect")}
                            </button>
                        </>
                    )}
                    {restoreReview === undefined ? null : (
                        <div className="state-resilience-review">
                            <h4>{text("state_resilience.restore.review_title")}</h4>
                            <dl>
                                <dt>{text("state_resilience.review.created")}</dt>
                                <dd>{date(restoreReview.backupCreatedAt)}</dd>
                                <dt>{text("state_resilience.review.files")}</dt>
                                <dd>{restoreReview.sourceFileCount}</dd>
                                <dt>{text("state_resilience.review.logical_size")}</dt>
                                <dd>{formatBytes(restoreReview.sourceLogicalBytes, snapshot.resolvedLocale)}</dd>
                                <dt>{text("state_resilience.review.desktop_preferences")}</dt>
                                <dd>
                                    {text(
                                        restoreReview.includesDesktopPreferences
                                            ? "state_resilience.review.included"
                                            : "state_resilience.review.not_included",
                                    )}
                                </dd>
                            </dl>
                            <WorkbenchNotice tone="warning">{text("state_resilience.restore.warning")}</WorkbenchNotice>
                            <WorkbenchConfirmation
                                data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.018"
                                checked={restoreConfirmed}
                                disabled={busy}
                                onCheckedChange={setRestoreConfirmed}
                            >
                                {text("state_resilience.restore.confirm")}
                            </WorkbenchConfirmation>
                            <button
                                data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.019"
                                type="button"
                                disabled={busy || !restoreConfirmed}
                                onClick={() => void activateRestore()}
                            >
                                {text("state_resilience.restore.activate")}
                            </button>
                        </div>
                    )}
                    {feedbackFor("restore")}
                </section>
            ) : null}

            {backupAvailable && !recoveryOnly ? (
                <section className="state-resilience-block" aria-labelledby="state-backup-policy-title">
                    <div className="section-heading">
                        <div>
                            <h3 id="state-backup-policy-title">{text("state_resilience.policy.title")}</h3>
                            <p>{text("state_resilience.policy.copy")}</p>
                        </div>
                    </div>
                    <p>
                        {latest === undefined
                            ? text("state_resilience.policy.no_backup")
                            : text("state_resilience.policy.latest", {
                                  time: date(latest.createdAt),
                                  path: latest.archiveDisplayPath,
                              })}
                    </p>
                    <div className="state-resilience-form-field">
                        <span>{text("state_resilience.policy.label")}</span>
                        <WorkbenchSelect
                            data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.020"
                            label={text("state_resilience.policy.label")}
                            value={policyMode}
                            disabled={busy || policy === undefined}
                            options={[
                                { value: "ask_every_time", label: text("state_resilience.policy.ask") },
                                { value: "back_up_first", label: text("state_resilience.policy.back_up_first") },
                                { value: "continue_without_prompt", label: text("state_resilience.policy.continue") },
                            ]}
                            onChange={(value) => setPolicyMode(value as BackupPromptMode)}
                        />
                    </div>
                    <button
                        data-oaam-interaction-entry="features.state-resilience.state_resilience_workspace.021"
                        type="button"
                        className="library-secondary-button"
                        disabled={busy || policy === undefined || policyMode === policy.mode}
                        onClick={() => void savePolicy()}
                    >
                        {text("state_resilience.policy.save")}
                    </button>
                    <small>{text("state_resilience.policy.future_scope")}</small>
                    {feedbackFor("policy")}
                </section>
            ) : null}
        </div>
    );
}
