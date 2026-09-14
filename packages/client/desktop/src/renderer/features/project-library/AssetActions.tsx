import { projectDisplayName } from "../../presentation/project-label";
import type { ProtocolDiagnosticV1, ProtocolOperationResult, ProtocolOperationTerminal } from "@oaam/app-server-protocol";
import { useEffect, useRef, useState } from "react";
import type { DesktopApplicationClientApi } from "../../client";
import {
    type DesktopMessageId,
    localizedText,
    mergeNonInformationalProtocolDiagnostics,
    nonInformationalProtocolDiagnostics,
    ProtocolDiagnostics,
    type ProtocolFeedback,
    protocolFeedback,
    useDesktopPresentation,
} from "../../presentation";
import {
    WorkbenchConfirmation,
    WorkbenchDisclosure,
    WorkbenchNotice,
    WorkbenchRadioButton,
    WorkbenchSelect,
    WorkbenchSwitch,
} from "../../ui";
import type { AssetVersionSummaryView, AssetView, ProjectView } from "./project-library-model";

type AssetPurgePreparation = Extract<
    ProtocolOperationResult<"asset.purge.inspect">,
    { readonly status: "complete" | "partial" }
>["value"];
type BackupPolicy = Extract<
    ProtocolOperationResult<"state_backup_prompt_policy.get">,
    { readonly status: "complete" | "partial" }
>["value"];
type BackupEntry = Extract<
    ProtocolOperationResult<"state_backup.list">,
    { readonly status: "complete" | "partial" }
>["value"]["entries"][number];
export type AssetCopyResult = Extract<
    ProtocolOperationResult<"asset.copy">,
    { readonly status: "complete" | "partial" }
>["value"];

export interface AssetActionsProps {
    readonly client: DesktopApplicationClientApi;
    readonly asset: AssetView;
    readonly selectedVersion: AssetVersionSummaryView;
    readonly projects: readonly ProjectView[];
    readonly initialMode?: "metadata" | "copy";
    readonly onInitialModeConsumed?: () => void;
    readonly onAddToTool?: () => void;
    readonly onAssetChanged: (asset: AssetView) => void;
    readonly onCopyCreated: (copy: AssetCopyResult) => void;
    readonly onOpenCopy?: (copy: AssetCopyResult) => void;
    readonly onPurged: (feedback: AssetLifecycleFeedback) => void;
}

type ActionMode = "none" | "metadata" | "copy" | "delete" | "purge";

export interface AssetLifecycleFeedback extends ProtocolFeedback {
    readonly tone: "note" | "danger";
}

function assetLifecycleFeedback(
    message: DesktopMessageId,
    tone: AssetLifecycleFeedback["tone"],
    diagnostics: readonly ProtocolDiagnosticV1[] = [],
): AssetLifecycleFeedback {
    return Object.freeze({
        ...protocolFeedback(localizedText(message), nonInformationalProtocolDiagnostics(diagnostics)),
        tone,
    });
}

function newestAvailableBackup(entries: readonly BackupEntry[]): BackupEntry | undefined {
    return [...entries]
        .filter((entry) => entry.observation === "available")
        .sort((left, right) => right.createdAt - left.createdAt)[0];
}

function preferredCopyProjectId(asset: AssetView, projects: readonly ProjectView[]): string {
    return projects.find((project) => project.projectId !== asset.projectId)?.projectId ?? projects[0]?.projectId ?? "";
}

export function AssetActions({
    client,
    asset,
    selectedVersion,
    projects,
    initialMode,
    onInitialModeConsumed,
    onAddToTool,
    onAssetChanged,
    onCopyCreated,
    onOpenCopy,
    onPurged,
}: AssetActionsProps): React.JSX.Element {
    const { displayText, snapshot, text } = useDesktopPresentation();
    const actionFormRef = useRef<HTMLDivElement>(null);
    const copyFormRef = useRef<HTMLFieldSetElement>(null);
    const copyTriggerRef = useRef<HTMLButtonElement>(null);
    const openCopyRef = useRef<HTMLButtonElement>(null);
    const [mode, setMode] = useState<ActionMode>(initialMode ?? "none");
    const [actionAttention, setActionAttention] = useState(initialMode !== undefined);
    const [metadataCloseRequest, setMetadataCloseRequest] = useState<ActionMode | null>(null);
    const [metadataBaseline, setMetadataBaseline] = useState({
        displayName: asset.displayName,
        displayDescription: asset.displayDescription,
    });
    const [displayName, setDisplayName] = useState(asset.displayName);
    const [displayDescription, setDisplayDescription] = useState(asset.displayDescription);
    const [copyScope, setCopyScope] = useState<"global" | "project">(projects.length > 0 ? "project" : "global");
    const [copyProjectId, setCopyProjectId] = useState(preferredCopyProjectId(asset, projects));
    const [copyScopePath, setCopyScopePath] = useState(asset.scopePath);
    const [copyName, setCopyName] = useState(asset.displayName);
    const [copyDescription, setCopyDescription] = useState(asset.displayDescription);
    const [deleteConfirmed, setDeleteConfirmed] = useState(false);
    const [purgeTypedName, setPurgeTypedName] = useState("");
    const [purgePreparation, setPurgePreparation] = useState<AssetPurgePreparation>();
    const [backupPolicy, setBackupPolicy] = useState<BackupPolicy>();
    const [latestBackup, setLatestBackup] = useState<BackupEntry>();
    const [rememberBackupChoice, setRememberBackupChoice] = useState(true);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<AssetLifecycleFeedback>();
    const [copied, setCopied] = useState<AssetCopyResult>();
    const previousMode = useRef(mode);
    const date = (value: number) =>
        new Intl.DateTimeFormat(snapshot.resolvedLocale, { dateStyle: "medium", timeStyle: "short" }).format(value);
    const metadataDirty =
        displayName !== metadataBaseline.displayName || displayDescription !== metadataBaseline.displayDescription;

    useEffect(() => {
        if (previousMode.current === "copy" && mode === "none") {
            (openCopyRef.current ?? copyTriggerRef.current)?.focus();
        }
        previousMode.current = mode;
    }, [mode]);

    useEffect(() => {
        if (initialMode === undefined) return;
        const form = initialMode === "copy" ? copyFormRef.current : actionFormRef.current;
        if (form === null) return;
        form.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        onInitialModeConsumed?.();
        setActionAttention(true);
        const timeout = globalThis.setTimeout(() => setActionAttention(false), 1_200);
        return () => globalThis.clearTimeout(timeout);
    }, [initialMode, onInitialModeConsumed]);

    function requestMode(nextMode: ActionMode): void {
        if (mode === "metadata" && metadataDirty) {
            setMetadataCloseRequest(nextMode);
            return;
        }
        setMetadataCloseRequest(null);
        if (nextMode === "metadata" && mode !== "metadata") {
            setDisplayName(asset.displayName);
            setDisplayDescription(asset.displayDescription);
            setMetadataBaseline({
                displayName: asset.displayName,
                displayDescription: asset.displayDescription,
            });
        }
        if (nextMode === "copy" && mode !== "copy" && projects.length > 0) {
            setCopyScope("project");
            setCopyProjectId(preferredCopyProjectId(asset, projects));
        }
        if (mode === "purge" && nextMode !== "purge") {
            setPurgePreparation(undefined);
            setPurgeTypedName("");
            setFeedback(undefined);
        }
        setCopied(undefined);
        if (nextMode !== mode) setFeedback(undefined);
        setMode(nextMode);
    }

    function discardMetadata(): void {
        const nextMode = metadataCloseRequest ?? "none";
        setDisplayName(metadataBaseline.displayName);
        setDisplayDescription(metadataBaseline.displayDescription);
        setMetadataCloseRequest(null);
        setMode(nextMode);
    }

    async function updateMetadata(nextMode: ActionMode = "none"): Promise<void> {
        setBusy(true);
        setFeedback(undefined);
        try {
            const outcome = await client.updateAssetDisplay({
                assetId: asset.assetId,
                displayName,
                displayDescription,
            });
            if (outcome.status === "failed") {
                setFeedback(assetLifecycleFeedback("library.metadata.failed", "danger", outcome.diagnostics));
                return;
            }
            onAssetChanged(outcome.value);
            setMetadataBaseline({
                displayName: outcome.value.displayName,
                displayDescription: outcome.value.displayDescription,
            });
            setMetadataCloseRequest(null);
            setMode(nextMode);
            setFeedback(assetLifecycleFeedback("library.metadata.complete", "note", outcome.diagnostics));
        } catch {
            setMetadataCloseRequest(null);
            setFeedback(assetLifecycleFeedback("library.metadata.failed", "danger"));
        } finally {
            setBusy(false);
        }
    }

    async function copyAsset(): Promise<void> {
        setBusy(true);
        setFeedback(undefined);
        setCopied(undefined);
        try {
            const destination =
                copyScope === "global"
                    ? { scope: "global" as const, scopePath: "" }
                    : { scope: "project" as const, projectId: copyProjectId, scopePath: copyScopePath };
            const outcome = await client.copyAsset({
                source: {
                    assetId: asset.assetId,
                    versionId: selectedVersion.versionId,
                    versionFingerprint: selectedVersion.fingerprint,
                    originAuthorityFingerprint: selectedVersion.originAuthorityFingerprint,
                },
                destination,
                displayName: copyName,
                displayDescription: copyDescription,
                userActionId: globalThis.crypto.randomUUID(),
            });
            if (outcome.status === "failed") {
                setFeedback(assetLifecycleFeedback("library.copy.failed", "danger", outcome.diagnostics));
                return;
            }
            onCopyCreated(outcome.value);
            setCopied(outcome.value);
            setFeedback(assetLifecycleFeedback("library.copy.complete", "note", outcome.diagnostics));
            setMode("none");
        } catch {
            setFeedback(assetLifecycleFeedback("library.copy.failed", "danger"));
        } finally {
            setBusy(false);
        }
    }

    async function softDelete(): Promise<void> {
        if (!deleteConfirmed) return;
        setBusy(true);
        setFeedback(undefined);
        try {
            const outcome = await client.softDeleteAsset({ assetId: asset.assetId });
            if (outcome.status === "failed") {
                setFeedback(assetLifecycleFeedback("library.delete.failed", "danger", outcome.diagnostics));
                return;
            }
            onAssetChanged(outcome.value);
            setMode("none");
            setFeedback(assetLifecycleFeedback("library.delete.complete", "note", outcome.diagnostics));
        } catch {
            setFeedback(assetLifecycleFeedback("library.delete.failed", "danger"));
        } finally {
            setBusy(false);
        }
    }

    async function restore(): Promise<void> {
        setBusy(true);
        setFeedback(undefined);
        try {
            const outcome = await client.restoreAsset({ assetId: asset.assetId });
            if (outcome.status === "failed") {
                setFeedback(assetLifecycleFeedback("library.restore.failed", "danger", outcome.diagnostics));
                return;
            }
            onAssetChanged(outcome.value);
            setFeedback(assetLifecycleFeedback("library.restore.complete", "note", outcome.diagnostics));
        } catch {
            setFeedback(assetLifecycleFeedback("library.restore.failed", "danger"));
        } finally {
            setBusy(false);
        }
    }

    async function inspectPurge(): Promise<void> {
        setMode("purge");
        setPurgePreparation(undefined);
        setPurgeTypedName("");
        setBusy(true);
        setFeedback(undefined);
        try {
            const [purge, policy, backups] = await Promise.all([
                client.inspectAssetPurge({ assetId: asset.assetId }),
                client.getStateBackupPromptPolicy(),
                client.listStateBackups(),
            ]);
            const diagnostics = mergeNonInformationalProtocolDiagnostics(
                purge.diagnostics,
                policy.diagnostics,
                backups.diagnostics,
            );
            if (purge.status === "failed" || policy.status === "failed" || backups.status === "failed") {
                setFeedback(assetLifecycleFeedback("library.purge.inspect_failed", "danger", diagnostics));
                return;
            }
            setPurgePreparation(purge.value);
            setBackupPolicy(policy.value);
            setLatestBackup(newestAvailableBackup(backups.value.entries));
            setFeedback(assetLifecycleFeedback("library.purge.review_ready", "note", diagnostics));
        } catch {
            setFeedback(assetLifecycleFeedback("library.purge.inspect_failed", "danger"));
        } finally {
            setBusy(false);
        }
    }

    async function purge(choice?: "back_up_then_continue" | "continue_without_backup"): Promise<void> {
        if (purgePreparation === undefined || backupPolicy === undefined || purgeTypedName !== asset.displayName) return;
        const effectiveChoice =
            backupPolicy.mode === "back_up_first"
                ? "back_up_then_continue"
                : backupPolicy.mode === "continue_without_prompt"
                  ? "continue_without_backup"
                  : choice;
        if (effectiveChoice === undefined) return;
        setBusy(true);
        setPurgePreparation(undefined);
        setPurgeTypedName("");
        let diagnostics = feedback?.diagnostics ?? [];
        setFeedback(undefined);
        try {
            if (effectiveChoice === "back_up_then_continue") {
                const inspected = await client.inspectStateBackup({
                    destination: { destinationKind: "oaam_default" },
                    encryptionMode: "none",
                });
                diagnostics = mergeNonInformationalProtocolDiagnostics(diagnostics, inspected.diagnostics);
                if (inspected.status === "failed") {
                    setFeedback(assetLifecycleFeedback("library.purge.backup_failed", "danger", diagnostics));
                    return;
                }
                const created = await client.createStateBackup({
                    backupReviewToken: inspected.value.backupReviewToken,
                    userActionId: globalThis.crypto.randomUUID(),
                });
                diagnostics = mergeNonInformationalProtocolDiagnostics(diagnostics, created.diagnostics);
                if (created.status === "failed") {
                    setFeedback(assetLifecycleFeedback("library.purge.backup_failed", "danger", diagnostics));
                    return;
                }
            }
            if (backupPolicy.mode === "ask_every_time" && rememberBackupChoice) {
                const replaced = await client.replaceStateBackupPromptPolicy({
                    expectedRevision: backupPolicy.revision,
                    expectedSettingFingerprint: backupPolicy.settingFingerprint,
                    mode: effectiveChoice === "back_up_then_continue" ? "back_up_first" : "continue_without_prompt",
                    userActionId: globalThis.crypto.randomUUID(),
                });
                diagnostics = mergeNonInformationalProtocolDiagnostics(diagnostics, replaced.diagnostics);
                if (replaced.status === "failed") {
                    setFeedback(assetLifecycleFeedback("library.purge.policy_failed", "danger", diagnostics));
                    return;
                }
            }
            const committed: ProtocolOperationTerminal<"asset.purge.commit"> = await client.commitAssetPurge({
                preparation: purgePreparation,
                userActionId: globalThis.crypto.randomUUID(),
            });
            diagnostics = mergeNonInformationalProtocolDiagnostics(diagnostics, committed.diagnostics);
            if (committed.status === "failed") {
                setFeedback(assetLifecycleFeedback("library.purge.failed", "danger", diagnostics));
                return;
            }
            onPurged(assetLifecycleFeedback("library.purge.complete", "note", diagnostics));
        } catch {
            setFeedback(assetLifecycleFeedback("library.purge.failed", "danger", diagnostics));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="inspector-section asset-action-section" data-oaam-action-mode={mode}>
            <h3>{text(mode === "copy" ? "library.copy.open" : "library.actions.title")}</h3>
            <div className="detail-actions" hidden={mode === "copy"}>
                {!asset.deleted && onAddToTool !== undefined ? (
                    <button
                        type="button"
                        data-oaam-action="open-deployments"
                        data-oaam-semantic-action="library.open_asset_deployment"
                        data-oaam-semantic-entry="library.asset_deployment.inspector"
                        onClick={() => onAddToTool()}
                    >
                        {text("library.deployments.start")}
                    </button>
                ) : null}
                <button
                    data-oaam-interaction-entry="features.project-library.asset_actions.002"
                    type="button"
                    aria-expanded={mode === "metadata"}
                    onClick={() => requestMode(mode === "metadata" ? "none" : "metadata")}
                >
                    {text(mode === "metadata" ? "library.metadata.close" : "library.metadata.open")}
                </button>
                {asset.scope === "project" || projects.length > 0 ? (
                    <button
                        ref={copyTriggerRef}
                        data-oaam-interaction-entry="features.project-library.asset_actions.003"
                        type="button"
                        className="library-secondary-button"
                        onClick={() => requestMode("copy")}
                    >
                        {text("library.copy.open")}
                    </button>
                ) : null}
                {asset.deleted ? (
                    <>
                        <button
                            data-oaam-interaction-entry="features.project-library.asset_actions.004"
                            type="button"
                            data-oaam-journey-action="asset.restore"
                            className="library-secondary-button"
                            disabled={busy || mode === "metadata"}
                            onClick={() => void restore()}
                        >
                            {text("library.restore.action")}
                        </button>
                        <button
                            data-oaam-interaction-entry="features.project-library.asset_actions.005"
                            type="button"
                            data-oaam-journey-action="asset.purge_review"
                            className="danger-button"
                            disabled={busy || mode === "metadata"}
                            onClick={() => void inspectPurge()}
                        >
                            {text("library.purge.open")}
                        </button>
                    </>
                ) : (
                    <button
                        data-oaam-interaction-entry="features.project-library.asset_actions.006"
                        type="button"
                        data-oaam-journey-action="asset.delete_open"
                        className="danger-button"
                        onClick={() => requestMode("delete")}
                    >
                        {text("library.delete.open")}
                    </button>
                )}
            </div>

            {mode === "metadata" ? (
                <div
                    ref={actionFormRef}
                    className="asset-action-form"
                    data-oaam-action-attention={actionAttention ? "true" : undefined}
                >
                    <label>
                        <span>{text("library.metadata.name")}</span>
                        <input
                            data-oaam-interaction-entry="features.project-library.asset_actions.010"
                            value={displayName}
                            onChange={(event) => setDisplayName(event.currentTarget.value)}
                        />
                    </label>
                    <label>
                        <span>{text("library.metadata.description")}</span>
                        <textarea
                            data-oaam-interaction-entry="features.project-library.asset_actions.011"
                            value={displayDescription}
                            onChange={(event) => setDisplayDescription(event.currentTarget.value)}
                        />
                    </label>
                    {metadataCloseRequest === null ? null : (
                        <WorkbenchNotice className="asset-metadata-close-review" tone="warning" role="alert">
                            <p>{text("library.metadata.unsaved")}</p>
                            <div className="detail-actions">
                                <button
                                    data-oaam-interaction-entry="features.project-library.asset_actions.007"
                                    type="button"
                                    disabled={busy || displayName.trim() === ""}
                                    onClick={() => void updateMetadata(metadataCloseRequest)}
                                >
                                    {text("library.metadata.save_changes")}
                                </button>
                                <button
                                    data-oaam-interaction-entry="features.project-library.asset_actions.008"
                                    type="button"
                                    className="library-secondary-button"
                                    onClick={discardMetadata}
                                >
                                    {text("library.metadata.discard_changes")}
                                </button>
                                <button
                                    data-oaam-interaction-entry="features.project-library.asset_actions.009"
                                    type="button"
                                    className="library-secondary-button"
                                    onClick={() => setMetadataCloseRequest(null)}
                                >
                                    {text("library.metadata.keep_editing")}
                                </button>
                            </div>
                        </WorkbenchNotice>
                    )}
                    {metadataCloseRequest === null ? (
                        <div className="detail-actions">
                            <button
                                data-oaam-interaction-entry="features.project-library.asset_actions.012"
                                type="button"
                                disabled={busy || displayName.trim() === ""}
                                onClick={() => void updateMetadata()}
                            >
                                {text("common.save")}
                            </button>
                            <button
                                data-oaam-interaction-entry="features.project-library.asset_actions.013"
                                type="button"
                                className="library-secondary-button"
                                disabled={busy}
                                onClick={() => requestMode("none")}
                            >
                                {text("common.cancel")}
                            </button>
                        </div>
                    ) : null}
                </div>
            ) : null}

            {mode === "copy" ? (
                <fieldset
                    ref={copyFormRef}
                    className="asset-action-form"
                    aria-label={text("library.copy.open")}
                    data-oaam-action-attention={actionAttention ? "true" : undefined}
                    onKeyDown={(event) => {
                        if (event.key === "Escape" && !event.defaultPrevented && !busy) {
                            event.preventDefault();
                            event.stopPropagation();
                            requestMode("none");
                        }
                    }}
                >
                    <p className="asset-copy-source" data-oaam-copy-source-version={selectedVersion.versionId}>
                        {text("library.copy.source", { name: asset.displayName, revision: selectedVersion.revision })}
                    </p>
                    {asset.scope === "project" ? (
                        <fieldset className="asset-copy-destination">
                            <legend>{text("library.copy.destination")}</legend>
                            <WorkbenchRadioButton
                                data-oaam-interaction-entry="features.project-library.asset_actions.014"
                                name={`asset-copy-destination-${asset.assetId}`}
                                value="project"
                                checked={copyScope === "project"}
                                disabled={projects.length === 0}
                                onCheckedChange={() => setCopyScope("project")}
                            >
                                {text("library.subject.projects")}
                            </WorkbenchRadioButton>
                            <WorkbenchRadioButton
                                data-oaam-interaction-entry="features.project-library.asset_actions.015"
                                name={`asset-copy-destination-${asset.assetId}`}
                                value="global"
                                checked={copyScope === "global"}
                                onCheckedChange={() => setCopyScope("global")}
                            >
                                {text("library.subject.global")}
                            </WorkbenchRadioButton>
                        </fieldset>
                    ) : null}
                    {copyScope === "project" ? (
                        <div className="asset-action-field">
                            <span>{text("library.copy.project")}</span>
                            <WorkbenchSelect
                                data-oaam-interaction-entry="features.project-library.asset_actions.016"
                                label={text("library.copy.project")}
                                value={copyProjectId}
                                options={[
                                    ...(projects.length === 0
                                        ? [{ value: "", label: text("library.copy.project"), disabled: true }]
                                        : []),
                                    ...projects.map((project) => ({
                                        value: project.projectId,
                                        label: projectDisplayName(project),
                                    })),
                                ]}
                                onChange={setCopyProjectId}
                            />
                        </div>
                    ) : null}
                    {copyScope === "project" ? (
                        <WorkbenchDisclosure
                            data-oaam-interaction-entry="features.project-library.asset_actions.017"
                            summary={text("library.copy.advanced")}
                        >
                            <div className="asset-copy-scope-path">
                                <label>
                                    <span>{text("library.copy.scope_path")}</span>
                                    <input
                                        data-oaam-interaction-entry="features.project-library.asset_actions.018"
                                        value={copyScopePath}
                                        onChange={(event) => setCopyScopePath(event.currentTarget.value)}
                                    />
                                </label>
                                <small>{text("library.copy.scope_path_help")}</small>
                            </div>
                        </WorkbenchDisclosure>
                    ) : null}
                    <label>
                        <span>{text("library.metadata.name")}</span>
                        <input
                            data-oaam-interaction-entry="features.project-library.asset_actions.019"
                            value={copyName}
                            onChange={(event) => setCopyName(event.currentTarget.value)}
                        />
                    </label>
                    <label>
                        <span>{text("library.metadata.description")}</span>
                        <textarea
                            data-oaam-interaction-entry="features.project-library.asset_actions.020"
                            value={copyDescription}
                            onChange={(event) => setCopyDescription(event.currentTarget.value)}
                        />
                    </label>
                    <p className="asset-copy-consequence">{text("library.copy.no_authority")}</p>
                    <div className="detail-actions">
                        <button
                            data-oaam-interaction-entry="features.project-library.asset_actions.021"
                            data-oaam-journey-action="asset.copy_commit"
                            type="button"
                            className="asset-copy-primary"
                            disabled={busy || copyName.trim() === "" || (copyScope === "project" && copyProjectId === "")}
                            onClick={() => void copyAsset()}
                        >
                            {text("library.copy.confirm")}
                        </button>
                        <button
                            data-oaam-interaction-entry="features.project-library.asset_actions.022"
                            type="button"
                            className="library-secondary-button"
                            disabled={busy}
                            onClick={() => requestMode("none")}
                        >
                            {text("common.cancel")}
                        </button>
                    </div>
                </fieldset>
            ) : null}

            {mode === "delete" ? (
                <div className="asset-action-form asset-delete-form">
                    <WorkbenchNotice tone="warning">{text("library.delete.copy")}</WorkbenchNotice>
                    <WorkbenchConfirmation
                        data-oaam-interaction-entry="features.project-library.asset_actions.023"
                        checked={deleteConfirmed}
                        onCheckedChange={setDeleteConfirmed}
                    >
                        {text("library.delete.confirm")}
                    </WorkbenchConfirmation>
                    <div className="detail-actions">
                        <button
                            data-oaam-interaction-entry="features.project-library.asset_actions.024"
                            type="button"
                            data-oaam-journey-action="asset.delete_commit"
                            className="danger-button"
                            disabled={busy || !deleteConfirmed}
                            onClick={() => void softDelete()}
                        >
                            {text("library.delete.action")}
                        </button>
                        <button
                            data-oaam-interaction-entry="features.project-library.asset_actions.025"
                            type="button"
                            className="library-secondary-button"
                            disabled={busy}
                            onClick={() => setMode("none")}
                        >
                            {text("common.cancel")}
                        </button>
                    </div>
                </div>
            ) : null}

            {mode === "purge" ? (
                <div className="asset-action-form">
                    <WorkbenchNotice tone="danger">{text("library.purge.copy")}</WorkbenchNotice>
                    {purgePreparation === undefined ? null : (
                        <p>
                            {text("library.purge.inventory", {
                                versions: text(
                                    purgePreparation.versionCount === 1
                                        ? "library.purge.versions.one"
                                        : "library.purge.versions.many",
                                    { count: purgePreparation.versionCount },
                                ),
                                grants: text(
                                    purgePreparation.promotionGrantCount === 1
                                        ? "library.purge.grants.one"
                                        : "library.purge.grants.many",
                                    { count: purgePreparation.promotionGrantCount },
                                ),
                            })}
                        </p>
                    )}
                    {latestBackup === undefined ? (
                        <p>{text("project_lifecycle.backup.none")}</p>
                    ) : (
                        <p>
                            {text("project_lifecycle.backup.latest", {
                                time: date(latestBackup.createdAt),
                                path: latestBackup.archiveDisplayPath,
                            })}
                        </p>
                    )}
                    <label>
                        <span>{text("library.purge.type_name", { name: asset.displayName })}</span>
                        <input
                            data-oaam-interaction-entry="features.project-library.asset_actions.026"
                            value={purgeTypedName}
                            onChange={(event) => setPurgeTypedName(event.currentTarget.value)}
                        />
                    </label>
                    {backupPolicy?.mode === "ask_every_time" ? (
                        <WorkbenchSwitch
                            data-oaam-interaction-entry="features.project-library.asset_actions.027"
                            checked={rememberBackupChoice}
                            label={text("library.purge.backup_remember")}
                            onCheckedChange={setRememberBackupChoice}
                        />
                    ) : null}
                    <div className="detail-actions">
                        {backupPolicy?.mode === "ask_every_time" ? (
                            <>
                                <button
                                    data-oaam-interaction-entry="features.project-library.asset_actions.028"
                                    type="button"
                                    data-oaam-journey-action="asset.purge_commit"
                                    className="danger-button"
                                    disabled={busy || purgePreparation === undefined || purgeTypedName !== asset.displayName}
                                    onClick={() => void purge("back_up_then_continue")}
                                >
                                    {text("library.purge.backup_then_action")}
                                </button>
                                <button
                                    data-oaam-interaction-entry="features.project-library.asset_actions.029"
                                    type="button"
                                    className="library-secondary-button"
                                    disabled={busy || purgePreparation === undefined || purgeTypedName !== asset.displayName}
                                    onClick={() => void purge("continue_without_backup")}
                                >
                                    {text("library.purge.without_backup")}
                                </button>
                            </>
                        ) : (
                            <button
                                data-oaam-interaction-entry="features.project-library.asset_actions.030"
                                type="button"
                                data-oaam-journey-action="asset.purge_commit"
                                className="danger-button"
                                disabled={busy || purgePreparation === undefined || purgeTypedName !== asset.displayName}
                                onClick={() => void purge()}
                            >
                                {backupPolicy?.mode === "back_up_first"
                                    ? text("library.purge.backup_then_action")
                                    : text("library.purge.action")}
                            </button>
                        )}
                        <button
                            data-oaam-interaction-entry="features.project-library.asset_actions.031"
                            type="button"
                            className="library-secondary-button"
                            disabled={busy}
                            onClick={() => requestMode("none")}
                        >
                            {text("common.cancel")}
                        </button>
                    </div>
                </div>
            ) : null}

            {busy ? <WorkbenchNotice role="status">{text("library.action.running")}</WorkbenchNotice> : null}
            {mode === "purge" && feedback?.tone === "danger" ? (
                <div
                    data-oaam-visible-state="asset_purge_review_required"
                    data-oaam-state-presentation="action_required"
                    data-oaam-state-blocking-scope="current_panel"
                    data-oaam-state-persistence="transient"
                >
                    <WorkbenchNotice tone="danger" role="alert">
                        <ProtocolDiagnostics
                            embedded
                            diagnostics={feedback.diagnostics}
                            operationMessage={feedback.message}
                            technicalSummary={text("import.ui.technical_details")}
                        />
                    </WorkbenchNotice>
                    <div className="status-card-actions">
                        <button
                            data-oaam-interaction-entry="features.project-library.asset_actions.032"
                            data-oaam-visible-state-action="refresh_asset_purge_review"
                            type="button"
                            disabled={busy}
                            onClick={() => void inspectPurge()}
                        >
                            {text("library.purge.refresh_review")}
                        </button>
                    </div>
                </div>
            ) : feedback === undefined ? null : (
                <>
                    <WorkbenchNotice tone={feedback.tone} role={feedback.tone === "danger" ? "alert" : "status"}>
                        {displayText(feedback.message)}
                        {copied === undefined ? null : (
                            <div className="asset-copy-result" data-oaam-copy-asset-id={copied.asset.assetId}>
                                <strong>{copied.asset.displayName}</strong>
                                <span>
                                    {text("library.copy.saved_at", {
                                        location:
                                            copied.asset.scope === "global"
                                                ? text("library.subject.global")
                                                : (projectDisplayName(
                                                      projects.find((project) => project.projectId === copied.asset.projectId),
                                                  ) ?? text("library.inspector.project_unavailable")),
                                        revision: copied.version.revision,
                                    })}
                                </span>
                                {copied.asset.scopePath ? <code>{copied.asset.scopePath}</code> : null}
                                {onOpenCopy === undefined ? null : (
                                    <button
                                        ref={openCopyRef}
                                        type="button"
                                        data-oaam-journey-action="asset.open_copy"
                                        className="asset-copy-primary"
                                        onClick={() => onOpenCopy(copied)}
                                    >
                                        {text("library.copy.open_result")}
                                    </button>
                                )}
                            </div>
                        )}
                    </WorkbenchNotice>
                    <ProtocolDiagnostics
                        diagnostics={feedback.diagnostics}
                        technicalSummary={text("import.ui.technical_details")}
                    />
                </>
            )}
        </section>
    );
}
